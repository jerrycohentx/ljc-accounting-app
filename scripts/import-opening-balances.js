#!/usr/bin/env node
/**
 * Import opening balances from CSV when leaving QBO.
 * Usage: node scripts/import-opening-balances.js ent-ljc 2026-01-01 balances.csv
 */
import fs from 'fs';
import { getDatabase, closeDatabase } from '../config/database.js';
import { parseOpeningBalanceCsv, previewOpeningBalances, postOpeningBalances } from '../lib/opening-balances.js';

const [entityId, asOfDate, csvPath, ...rest] = process.argv.slice(2);
const dryRun = rest.includes('--dry-run');

if (!entityId || !asOfDate || !csvPath) {
  console.error('Usage: node scripts/import-opening-balances.js <entityId> <asOfDate> <csv> [--dry-run]');
  process.exit(1);
}

const csv = fs.readFileSync(csvPath, 'utf8');
const balances = parseOpeningBalanceCsv(csv);

const db = await getDatabase();
const preview = await previewOpeningBalances(db, entityId, { asOfDate, balances });

console.log(JSON.stringify(preview, null, 2));

if (!preview.balanced) {
  console.error('Preview not balanced');
  process.exit(1);
}

if (dryRun) {
  console.log('Dry run — not posting');
  await closeDatabase();
  process.exit(0);
}

const result = await postOpeningBalances(db, {
  entityId,
  asOfDate,
  balances,
  userId: 'usr-admin',
  memo: 'CLI opening balance import',
});

console.log('Posted:', result.jeNumber);
await closeDatabase();
