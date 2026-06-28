import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { seedDatabaseContent } from '../config/bootstrap-seed.js';
import { parseOpeningBalanceCsv, previewOpeningBalances, postOpeningBalances } from './opening-balances.js';
import { reverseJournalEntry } from './reverse-journal.js';
import { ENTITY_TB_FILES } from '../config/opening-balance-mappings.js';
import { commitBankImportTransactions } from './import-commit.js';
import { postJournalEntryToGl } from './post-journal.js';
import { seedDefaultRules } from './categorization-rules.js';
import {
  getPostedBankBalance,
  postAllPendingImports,
  reconcileToTarget,
  closeYear2025,
} from './bank-catchup.js';
import { RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';

const ENTITY_ID = 'ent-ljc';
const BANK_ACCT = '1000';
const AS_OF_DATE = '2025-12-31';
const JE_PREFIX = 'OB-20251231';

async function reverseTestHoldbackEntries(db, userId) {
  const rows = await db.all(
    `SELECT id, entity_id, je_number FROM journal_entries
     WHERE status = 'POSTED' AND reversed_by_je_id IS NULL
       AND (je_number LIKE 'HB-%TEST%' OR je_number LIKE 'HB-A-TEST%' OR je_number LIKE 'HB-ADJ-TEST%')`
  );
  for (const row of rows) {
    await reverseJournalEntry(db, {
      journalId: row.id,
      entityId: row.entity_id,
      userId,
      reversalDate: new Date().toISOString().slice(0, 10),
      memo: `Reverse test holdback before production bootstrap`,
    });
  }
  return rows.length;
}

async function reverseActiveOpeningBalances(db, userId) {
  let count = 0;
  for (const entityId of Object.keys(ENTITY_TB_FILES)) {
    const actives = await db.all(
      `SELECT id FROM journal_entries
       WHERE entity_id = ? AND je_number LIKE ? AND status = 'POSTED' AND reversed_by_je_id IS NULL`,
      [entityId, `${JE_PREFIX}%`]
    );
    for (const row of actives) {
      await reverseJournalEntry(db, {
        journalId: row.id,
        entityId,
        userId,
        reversalDate: AS_OF_DATE,
        memo: 'Reverse opening balance before production refresh',
      });
      count += 1;
    }
  }
  return count;
}

async function postAllOpeningBalances(db, rootDir, userId) {
  const obDir = path.join(rootDir, 'data/opening-balances', AS_OF_DATE);
  const results = [];
  for (const entityId of Object.keys(ENTITY_TB_FILES)) {
    const filePath = path.join(obDir, `${entityId}-opening-balances.csv`);
    if (!fs.existsSync(filePath)) {
      results.push({ entityId, error: 'missing CSV' });
      continue;
    }
    const balances = parseOpeningBalanceCsv(fs.readFileSync(filePath, 'utf8'));
    const preview = await previewOpeningBalances(db, entityId, { asOfDate: AS_OF_DATE, balances });
    if (!preview.balanced) {
      results.push({ entityId, error: 'unbalanced preview' });
      continue;
    }
    const posted = await postOpeningBalances(db, {
      entityId,
      asOfDate: AS_OF_DATE,
      balances,
      userId,
      memo: `QBO trial balance migration ${AS_OF_DATE}`,
    });
    results.push({ entityId, jeNumber: posted.jeNumber });
  }
  return results;
}

async function ensureSubAccountTrueUp(db, bankOpeningBalance, userId) {
  const bal = await getPostedBankBalance(db, ENTITY_ID, BANK_ACCT);
  if (!bal) throw new Error('Account 1000 not found');

  const diff = Math.round((bal.balance - bankOpeningBalance) * 100) / 100;
  if (Math.abs(diff) < 0.02) return { skipped: true };

  const existing = await db.get(
    "SELECT id FROM journal_entries WHERE entity_id = ? AND je_number = 'TRUEUP-20260101-SUBACCT' AND status = 'POSTED' AND reversed_by_je_id IS NULL",
    [ENTITY_ID]
  );
  if (existing) return { skipped: true, reason: 'already posted' };

  const acct1010 = await db.get(
    'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
    [ENTITY_ID, '1010']
  );
  if (!acct1010) throw new Error('Account 1010 not found');

  const amount = Math.abs(diff);
  const credit1000 = diff > 0;
  const jeId = `je-${uuidv4()}`;
  await db.run(
    `INSERT INTO journal_entries (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, 'TRUEUP-20260101-SUBACCT', ?, '2026-01-01', 'DRAFT', ?, ?, ?, ?)`,
    [jeId, ENTITY_ID, 'Simmons sub-account true-up 1/1/26', userId, amount, amount, 'Production bootstrap']
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [`jel-${uuidv4()}`, jeId, bal.accountId, credit1000 ? 0 : amount, credit1000 ? amount : 0, 'True-up 1000']
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 2)`,
    [`jel-${uuidv4()}`, jeId, acct1010.id, credit1000 ? amount : 0, credit1000 ? 0 : amount, 'True-up 1010']
  );
  await postJournalEntryToGl(db, { journalId: jeId, entityId: ENTITY_ID, userId });
  return { amount, jeNumber: 'TRUEUP-20260101-SUBACCT' };
}

function loadSimmonsStatements(rootDir) {
  const jsonPath = path.join(rootDir, 'data/bank-imports/LJC/simmons-2026-statements.json');
  if (!fs.existsSync(jsonPath)) {
    throw new Error('simmons-2026-statements.json missing — run PDF extract locally first');
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  return (data.statements || []).sort((a, b) =>
    (a.meta?.periodStart || '').localeCompare(b.meta?.periodStart || '')
  );
}

async function importSimmonsStatements(db, rootDir, userId) {
  const statements = loadSimmonsStatements(rootDir);
  let imported = 0;
  for (const stmt of statements) {
    const importId = `json-${stmt.meta?.periodEnd || stmt.file}`;
    const { createdJECount } = await commitBankImportTransactions(db, {
      entityId: ENTITY_ID,
      transactions: stmt.transactions,
      importId,
      userId,
      sourceLabel: `Simmons stmt ${stmt.meta?.periodStart || ''}`,
      bankAccountNumber: BANK_ACCT,
    });
    imported += createdJECount;
  }
  const { posted } = await postAllPendingImports(db, ENTITY_ID, userId);
  return { statements: statements.length, imported, posted };
}

/**
 * Full production bootstrap: seed COA, 2025 OB, Jan–May 2026 Simmons, reconcile through May.
 * June remains open (no June stmt import).
 */
export async function runProductionBootstrap(db, { userId = 'usr-admin', rootDir = process.cwd() } = {}) {
  await seedDatabaseContent(db);
  await seedDefaultRules(db, ENTITY_ID);

  const reversedTests = await reverseTestHoldbackEntries(db, userId);
  const reversedOb = await reverseActiveOpeningBalances(db, userId);
  const openingResults = await postAllOpeningBalances(db, rootDir, userId);
  const closed2025 = await closeYear2025(db, userId);

  const statements = loadSimmonsStatements(rootDir);
  const firstOpening = statements[0]?.meta?.previousBalance;
  const trueUp = firstOpening != null
    ? await ensureSubAccountTrueUp(db, firstOpening, userId)
    : null;

  const simmons = await importSimmonsStatements(db, rootDir, userId);

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
    reversedTestJournals: reversedTests,
    reversedOpeningBalances: reversedOb,
    openingBalances: openingResults,
    closed2025: closed2025.length,
    trueUp,
    simmons,
    reconciliations,
    account1000Balance: bal?.balance,
    mayTarget,
    balanceMatchesMay: mayTarget != null && Math.abs((bal?.balance || 0) - mayTarget) < 0.02,
    juneLeftOpen: true,
  };
}
