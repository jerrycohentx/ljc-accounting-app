#!/usr/bin/env node
/**
 * Post rolled-up opening balances for all Cohen entities.
 * Usage: node scripts/import-all-qbo-opening-balances.js [asOfDate] [--dry-run] [--force]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDatabase, closeDatabase } from '../config/database.js';
import { seedDatabaseContent } from '../config/bootstrap-seed.js';
import { parseOpeningBalanceCsv, previewOpeningBalances, postOpeningBalances } from '../lib/opening-balances.js';
import { reverseJournalEntry } from '../lib/reverse-journal.js';
import { ENTITY_TB_FILES } from '../config/opening-balance-mappings.js';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const asOfDate = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || '2025-12-31';
const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');
const obDir = path.join(root, 'data/opening-balances', asOfDate);
const jeNumber = `OB-${asOfDate.replace(/-/g, '')}`;

execSync('node scripts/rollup-qbo-trial-balances.js', { stdio: 'inherit', cwd: root });

const db = await getDatabase();
await seedDatabaseContent(db);

if (force && !dryRun) {
  for (const entityId of Object.keys(ENTITY_TB_FILES)) {
    const actives = await db.all(
      `SELECT id, reversed_by_je_id FROM journal_entries
       WHERE entity_id = ? AND je_number LIKE ? AND status = 'POSTED' AND reversed_by_je_id IS NULL`,
      [entityId, `${jeNumber}%`]
    );
    for (const existing of actives) {
      await reverseJournalEntry(db, {
        journalId: existing.id,
        entityId,
        userId: 'usr-admin',
        reversalDate: asOfDate,
        memo: `Reverse opening balance before refresh`,
      });
    }
  }
}

const results = [];

for (const entityId of Object.keys(ENTITY_TB_FILES)) {
  const filePath = path.join(obDir, `${entityId}-opening-balances.csv`);
  if (!fs.existsSync(filePath)) {
    results.push({ entityId, error: 'opening balance file missing — run rollup-qbo-trial-balances.js first' });
    continue;
  }

  const balances = parseOpeningBalanceCsv(fs.readFileSync(filePath, 'utf8'));
  const preview = await previewOpeningBalances(db, entityId, { asOfDate, balances });

  if (!preview.balanced) {
    results.push({ entityId, error: 'preview not balanced', preview });
    continue;
  }

  if (dryRun) {
    results.push({ entityId, dryRun: true, lines: preview.lines.length, totalDebit: preview.totalDebit });
    continue;
  }

  try {
    const posted = await postOpeningBalances(db, {
      entityId,
      asOfDate,
      balances,
      userId: 'usr-admin',
      memo: `QBO trial balance migration ${asOfDate}`,
    });
    results.push({ entityId, jeNumber: posted.jeNumber, lines: preview.lines.length });
  } catch (error) {
    results.push({ entityId, error: error.message });
  }
}

console.log(JSON.stringify({ asOfDate, dryRun, results }, null, 2));

if (!dryRun) {
  try {
    execSync(`node scripts/verify-intercompany-tieout.js ${asOfDate} --gl`, { stdio: 'inherit', cwd: root });
  } catch {
    console.error('Intercompany verification failed after import');
    process.exitCode = 1;
  }
}

await closeDatabase();
