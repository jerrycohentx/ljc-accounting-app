import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { commitBankImportTransactions, getExistingFitidsForEntity } from './import-commit.js';
import { postJournalEntryToGl } from './post-journal.js';
import { seedDefaultRules } from './categorization-rules.js';
import {
  getPostedBankBalance,
  postAllPendingImports,
  reconcileToTarget,
} from './bank-catchup.js';
import { RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';

const ENTITY_ID = 'ent-ljc';
const BANK_ACCT = '1001';

export function loadLonestarStatements(rootDir) {
  const jsonPath = path.join(rootDir, 'data/bank-imports/LJC/lonestar-2026-statements.json');
  if (!fs.existsSync(jsonPath)) {
    throw new Error('lonestar-2026-statements.json missing — run import-lonestar-statements.js locally first');
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  return (data.statements || []).sort((a, b) =>
    (a.meta?.periodStart || '').localeCompare(b.meta?.periodStart || '')
  );
}

async function ensureOpeningTrueUp(db, bankOpeningBalance, userId) {
  const existingTrueup = await db.get(
    "SELECT id FROM journal_entries WHERE entity_id = ? AND je_number = 'TRUEUP-20260101-LONESTAR' AND status = 'POSTED' AND reversed_by_je_id IS NULL",
    [ENTITY_ID]
  );
  if (existingTrueup) return { skipped: true, reason: 'true-up already posted' };

  const fixOb = await db.get(
    "SELECT id FROM journal_entries WHERE entity_id = ? AND je_number = 'FIX-LS-OB-20251231' AND status = 'POSTED' AND reversed_by_je_id IS NULL",
    [ENTITY_ID]
  );
  if (fixOb) return { skipped: true, reason: 'opening balance already corrected' };

  const bal = await getPostedBankBalance(db, ENTITY_ID, BANK_ACCT, '2025-12-31');
  if (!bal) throw new Error('Account 1001 not found');

  const diff = Math.round((bal.balance - bankOpeningBalance) * 100) / 100;
  if (Math.abs(diff) < 0.02) return { skipped: true, balance: bal.balance };

  const existing = await db.get(
    "SELECT id FROM journal_entries WHERE entity_id = ? AND je_number = 'TRUEUP-20260101-LONESTAR' AND status = 'POSTED' AND reversed_by_je_id IS NULL",
    [ENTITY_ID]
  );
  if (existing) return { skipped: true, reason: 'already posted' };

  const equity = await db.get(
    'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
    [ENTITY_ID, '3900']
  );
  if (!equity) throw new Error('Account 3900 not found');

  const amount = Math.abs(diff);
  const credit1001 = diff > 0;
  const jeId = `je-${uuidv4()}`;
  await db.run(
    `INSERT INTO journal_entries (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, 'TRUEUP-20260101-LONESTAR', ?, '2026-01-01', 'DRAFT', ?, ?, ?, ?)`,
    [jeId, ENTITY_ID, 'Lone Star opening balance true-up 1/1/26', userId, amount, amount, 'Lone Star catch-up']
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [`jel-${uuidv4()}`, jeId, bal.accountId, credit1001 ? 0 : amount, credit1001 ? amount : 0, 'True-up 1001']
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 2)`,
    [`jel-${uuidv4()}`, jeId, equity.id, credit1001 ? amount : 0, credit1001 ? 0 : amount, 'Opening balance equity']
  );
  await postJournalEntryToGl(db, { journalId: jeId, entityId: ENTITY_ID, userId });
  return { amount, jeNumber: 'TRUEUP-20260101-LONESTAR', bankOpeningBalance };
}

async function importStatements(db, rootDir, userId) {
  const statements = loadLonestarStatements(rootDir);
  const existingFitids = await getExistingFitidsForEntity(ENTITY_ID);
  let imported = 0;
  let skipped = 0;

  for (const stmt of statements) {
    const txns = stmt.transactions.filter((t) => !existingFitids.has(t.fitid));
    skipped += stmt.transactions.length - txns.length;
    if (!txns.length) continue;

    const importId = `lonestar-${stmt.meta?.periodEnd || stmt.file}`;
    const { createdJECount } = await commitBankImportTransactions(db, {
      entityId: ENTITY_ID,
      transactions: txns,
      importId,
      userId,
      sourceLabel: `Lone Star stmt ${stmt.meta?.periodStart || ''}`,
      bankAccountNumber: BANK_ACCT,
    });
    imported += createdJECount;
    for (const t of txns) existingFitids.add(t.fitid);
  }

  const { posted } = await postAllPendingImports(db, ENTITY_ID, userId);
  return { statements: statements.length, imported, skippedDuplicates: skipped, posted };
}

/**
 * Import Lone Star ckg-7367 Jan–May 2026, reconcile through May. Idempotent on fitid.
 */
export async function runLonestarCatchUp(db, { userId = 'usr-admin', rootDir = process.cwd() } = {}) {
  await seedDefaultRules(db, ENTITY_ID);

  const statements = loadLonestarStatements(rootDir);
  const firstOpening = statements[0]?.meta?.previousBalance;
  const trueUp = firstOpening != null
    ? await ensureOpeningTrueUp(db, firstOpening, userId)
    : null;

  const lonestar = await importStatements(db, rootDir, userId);

  const reconciliations = [];
  for (const target of RECONCILIATION_TARGETS[ENTITY_ID]?.[BANK_ACCT] || []) {
    const r = await reconcileToTarget(db, {
      entityId: ENTITY_ID,
      accountNumber: BANK_ACCT,
      statementDate: target.statementDate,
      endingBalance: target.endingBalance,
      userId,
    });
    reconciliations.push({ ...target, ...r });
  }

  const bal = await getPostedBankBalance(db, ENTITY_ID, BANK_ACCT);
  const mayTarget = RECONCILIATION_TARGETS[ENTITY_ID]?.[BANK_ACCT]?.slice(-1)[0]?.endingBalance;

  return {
    trueUp,
    lonestar,
    reconciliations,
    account1001Balance: bal?.balance,
    mayTarget,
    balanceMatchesMay: mayTarget != null && Math.abs((bal?.balance || 0) - mayTarget) < 0.07,
  };
}
