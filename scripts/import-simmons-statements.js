#!/usr/bin/env node
/**
 * Import Simmons ckg-0260 PDF statements → GL, reconcile through May 2026.
 * Usage: node scripts/import-simmons-statements.js [pdf-dir-or-files...]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase, closeDatabase } from '../config/database.js';
import { seedDatabaseContent } from '../config/bootstrap-seed.js';
import { commitBankImportTransactions } from '../lib/import-commit.js';
import { postJournalEntryToGl } from '../lib/post-journal.js';
import { seedDefaultRules } from '../lib/categorization-rules.js';
import {
  getPostedBankBalance,
  postAllPendingImports,
  reconcileToTarget,
  build2026StatusReport,
} from '../lib/bank-catchup.js';
import { RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const DEMO_USER = 'usr-demo';
const ENTITY_ID = 'ent-ljc';
const BANK_ACCT = '1000';

function extractPdf(pdfPath) {
  const raw = execFileSync('python3', [path.join(root, 'scripts/extract-simmons-pdf.py'), pdfPath], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function collectPdfs(args) {
  if (args.length) {
    return args.flatMap((a) => {
      const p = path.resolve(a);
      if (fs.statSync(p).isDirectory()) {
        return fs.readdirSync(p).filter((f) => f.toLowerCase().endsWith('.pdf')).map((f) => path.join(p, f));
      }
      return [p];
    });
  }
  const uploadDir = '/home/ubuntu/.cursor/projects/workspace/uploads';
  const dirs = [uploadDir, path.join(root, 'data/bank-imports/LJC')];
  const files = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase().includes('ckg_260') && f.toLowerCase().endsWith('.pdf') && !f.includes('06-04')) {
        files.push(path.join(dir, f));
      }
    }
  }
  return files;
}

function dedupeStatements(parsedList) {
  const byPeriod = new Map();
  for (const p of parsedList) {
    const key = p.meta?.periodEnd || p.file;
    const existing = byPeriod.get(key);
    if (!existing || p.transactionCount > existing.transactionCount) {
      byPeriod.set(key, p);
    }
  }
  return [...byPeriod.values()].sort((a, b) => (a.meta?.periodStart || '').localeCompare(b.meta?.periodStart || ''));
}

async function ensureSubAccountTrueUp(db, bankOpeningBalance) {
  const bal = await getPostedBankBalance(db, ENTITY_ID, BANK_ACCT);
  if (!bal) throw new Error('Account 1000 not found');

  const target = bankOpeningBalance;
  const diff = Math.round((bal.balance - target) * 100) / 100;
  if (Math.abs(diff) < 0.02) {
    console.log(`Account 1000 already at bank opening $${target.toFixed(2)}`);
    return null;
  }

  const existing = await db.get(
    "SELECT id FROM journal_entries WHERE entity_id = ? AND je_number = 'TRUEUP-20260101-SUBACCT' AND status = 'POSTED'",
    [ENTITY_ID]
  );
  if (existing) {
    console.log('Sub-account true-up already posted');
    return null;
  }

  const acct1010 = await db.get(
    'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
    [ENTITY_ID, '1010']
  );
  if (!acct1010) throw new Error('Account 1010 not found');

  const jeId = `je-${uuidv4()}`;
  const amount = Math.abs(diff);
  const jeNumber = 'TRUEUP-20260101-SUBACCT';
  const desc = 'Simmons sub-account allocation per bank stmt (0260 operating balance 1/1/26)';

  // GL 1000 higher than bank → credit 1000, debit 1010
  const credit1000 = diff > 0;
  await db.run(
    `INSERT INTO journal_entries (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, ?, ?, '2026-01-01', 'DRAFT', ?, ?, ?, ?)`,
    [jeId, ENTITY_ID, jeNumber, desc, DEMO_USER, amount, amount, desc]
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [`jel-${uuidv4()}`, jeId, bal.accountId, credit1000 ? 0 : amount, credit1000 ? amount : 0, desc]
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 2)`,
    [`jel-${uuidv4()}`, jeId, acct1010.id, credit1000 ? amount : 0, credit1000 ? 0 : amount, desc]
  );
  await postJournalEntryToGl(db, { journalId: jeId, entityId: ENTITY_ID, userId: DEMO_USER });
  console.log(`Posted true-up JE: moved $${amount.toFixed(2)} from 1000 → 1010 (bank opening $${target.toFixed(2)})`);
  return { amount, jeNumber };
}

async function main() {
  const pdfs = collectPdfs(process.argv.slice(2));
  if (!pdfs.length) {
    console.error('No Simmons PDF statements found.');
    process.exit(1);
  }

  const db = await getDatabase();
  await seedDatabaseContent(db);
  await seedDefaultRules(db, ENTITY_ID);

  const parsed = [];
  for (const pdf of pdfs) {
    try {
      const data = extractPdf(pdf);
      if (data.error) throw new Error(data.error);
      parsed.push(data);
      console.log(`Parsed ${path.basename(pdf)}: ${data.transactionCount} txns, var ${data.netVariance ?? 'n/a'}`);
    } catch (e) {
      console.error(`Skip ${pdf}: ${e.message}`);
    }
  }

  const statements = dedupeStatements(parsed);
  if (!statements.length) {
    console.error('No valid statements parsed.');
    process.exit(1);
  }

  const firstOpening = statements[0].meta?.previousBalance;
  if (firstOpening != null) {
    await ensureSubAccountTrueUp(db, firstOpening);
  }

  let totalImported = 0;
  for (const stmt of statements) {
    const importId = `pdf-${stmt.meta?.periodEnd || stmt.file}`;
    const { createdJECount } = await commitBankImportTransactions(db, {
      entityId: ENTITY_ID,
      transactions: stmt.transactions,
      importId,
      userId: DEMO_USER,
      sourceLabel: `Simmons PDF ${stmt.meta?.periodStart || ''}`,
      bankAccountNumber: BANK_ACCT,
    });
    totalImported += createdJECount;
    console.log(`Committed ${createdJECount} draft JEs for period ending ${stmt.meta?.periodEnd}`);
  }

  const { posted } = await postAllPendingImports(db, ENTITY_ID);
  console.log(`Posted ${posted} journal entries to GL`);

  const bal = await getPostedBankBalance(db, ENTITY_ID, BANK_ACCT);
  const mayTarget = RECONCILIATION_TARGETS[ENTITY_ID]?.[BANK_ACCT]?.slice(-1)[0]?.endingBalance;
  console.log(`Account 1000 balance: $${bal?.balance?.toFixed(2)} (May stmt target: $${mayTarget})`);

  for (const target of RECONCILIATION_TARGETS[ENTITY_ID]?.[BANK_ACCT] || []) {
    const r = await reconcileToTarget(db, {
      entityId: ENTITY_ID,
      accountNumber: BANK_ACCT,
      statementDate: target.statementDate,
      endingBalance: target.endingBalance,
    });
    console.log(
      r.reconciled
        ? `✓ Reconciled through ${target.statementDate} → $${target.endingBalance}`
        : `✗ Reconcile ${target.statementDate} failed (computed $${r.computedBalance}, variance $${r.variance})`
    );
  }

  const report = await build2026StatusReport(db, root);
  const outPath = path.join(root, 'data/reports/2026-status.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({
    statementsProcessed: statements.length,
    transactionsImported: totalImported,
    posted,
    account1000Balance: bal?.balance,
    mayStatementTarget: mayTarget,
    balanceMatchesMay: mayTarget != null && Math.abs(bal.balance - mayTarget) < 0.02,
    postedTransactions2026: report.entities.find((e) => e.entityId === ENTITY_ID)?.postedTransactions2026,
  }, null, 2));

  await closeDatabase();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
