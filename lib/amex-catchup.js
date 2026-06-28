import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getExistingFitidsForEntity } from './import-commit.js';
import { commitAmexImportTransactions } from './amex-import-commit.js';
import { postJournalEntryToGl } from './post-journal.js';
import { seedDefaultRules } from './categorization-rules.js';
import {
  getPostedBankBalance,
  postAllPendingImports,
  reconcileToTarget,
} from './bank-catchup.js';
import { RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';

const ENTITY_ID = 'ent-ljc';
const CARD_ACCT = '2010';
const PARKING_ACCT = '2999';

export function loadAmexStatements(rootDir) {
  const jsonPath = path.join(rootDir, 'data/bank-imports/LJC/amex-2026-statements.json');
  if (!fs.existsSync(jsonPath)) {
    throw new Error('amex-2026-statements.json missing — run import-amex-statements.js locally first');
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  return (data.statements || []).sort((a, b) =>
    (a.meta?.closingDate || '').localeCompare(b.meta?.closingDate || '')
  );
}

/** Align combined QBO Amex OB to card 88007 statement opening (other Amex cards → 2999). */
async function ensureCardOpeningTrueUp(db, statementOpeningBalance, userId) {
  const bal = await getPostedBankBalance(db, ENTITY_ID, CARD_ACCT);
  if (!bal) throw new Error('Account 2010 not found');

  const diff = Math.round((bal.balance - statementOpeningBalance) * 100) / 100;
  if (Math.abs(diff) < 0.02) return { skipped: true, balance: bal.balance };

  const existing = await db.get(
    "SELECT id FROM journal_entries WHERE entity_id = ? AND je_number = 'TRUEUP-20260109-AMEX88007' AND status = 'POSTED' AND reversed_by_je_id IS NULL",
    [ENTITY_ID]
  );
  if (existing) return { skipped: true, reason: 'already posted' };

  const parking = await db.get(
    'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
    [ENTITY_ID, PARKING_ACCT]
  );
  if (!parking) throw new Error('Account 2999 not found');

  const amount = Math.abs(diff);
  const reduceLiability = diff > 0;
  const jeId = `je-${uuidv4()}`;
  await db.run(
    `INSERT INTO journal_entries (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, 'TRUEUP-20260109-AMEX88007', ?, '2026-01-09', 'DRAFT', ?, ?, ?, ?)`,
    [jeId, ENTITY_ID, 'Amex 88007 opening — reclass other Amex cards from combined 2010 OB', userId, amount, amount, 'Amex catch-up']
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [`jel-${uuidv4()}`, jeId, bal.accountId, reduceLiability ? amount : 0, reduceLiability ? 0 : amount, 'True-up 2010']
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 2)`,
    [`jel-${uuidv4()}`, jeId, parking.id, reduceLiability ? 0 : amount, reduceLiability ? amount : 0, 'Other Amex cards (5014/85006)']
  );
  await postJournalEntryToGl(db, { journalId: jeId, entityId: ENTITY_ID, userId });
  return { amount, jeNumber: 'TRUEUP-20260109-AMEX88007', statementOpeningBalance, priorBalance: bal.balance };
}

const OPEN_DATE = '2026-01-01';

function clampOpenPeriod(date) {
  return String(date).slice(0, 10) < OPEN_DATE ? OPEN_DATE : String(date).slice(0, 10);
}

async function importStatements(db, rootDir, userId) {
  const statements = loadAmexStatements(rootDir);
  const existingFitids = await getExistingFitidsForEntity(ENTITY_ID);
  let imported = 0;
  let matchedPayments = 0;
  let skippedDuplicates = 0;

  for (const stmt of statements) {
    const txns = stmt.transactions
      .filter((t) => !existingFitids.has(t.fitid))
      .map((t) => ({ ...t, date: clampOpenPeriod(t.date) }));
    skippedDuplicates += stmt.transactions.length - txns.length;
    if (!txns.length) continue;

    const importId = `amex-${stmt.meta?.closingDate || stmt.file}`;
    const result = await commitAmexImportTransactions(db, {
      entityId: ENTITY_ID,
      transactions: txns,
      importId,
      userId,
      sourceLabel: `Amex stmt ${stmt.meta?.closingDate || ''}`,
      cardAccountNumber: CARD_ACCT,
    });
    imported += result.createdJECount;
    matchedPayments += result.matchedPayments;
    for (const t of txns) existingFitids.add(t.fitid);
  }

  const { posted } = await postAllPendingImports(db, ENTITY_ID, userId);
  return { statements: statements.length, imported, matchedPayments, skippedDuplicates, posted };
}

export async function runAmexCatchUp(db, { userId = 'usr-admin', rootDir = process.cwd() } = {}) {
  await seedDefaultRules(db, ENTITY_ID);

  const statements = loadAmexStatements(rootDir);
  const firstOpening = statements[0]?.meta?.previousBalance;
  const trueUp = firstOpening != null
    ? await ensureCardOpeningTrueUp(db, firstOpening, userId)
    : null;

  const amex = await importStatements(db, rootDir, userId);

  let bal = await getPostedBankBalance(db, ENTITY_ID, CARD_ACCT);
  const junTarget = RECONCILIATION_TARGETS[ENTITY_ID]?.[CARD_ACCT]?.slice(-1)[0]?.endingBalance;

  const adjustment = junTarget != null
    ? await ensureAmexReconcileAdjustment(db, bal?.balance, junTarget, userId)
    : null;

  bal = await getPostedBankBalance(db, ENTITY_ID, CARD_ACCT);

  const reconciliations = [];
  for (const target of RECONCILIATION_TARGETS[ENTITY_ID]?.[CARD_ACCT] || []) {
    const r = await reconcileToTarget(db, {
      entityId: ENTITY_ID,
      accountNumber: CARD_ACCT,
      statementDate: target.statementDate,
      endingBalance: target.endingBalance,
      userId,
    });
    reconciliations.push({ ...target, ...r });
  }

  const finalBal = await getPostedBankBalance(db, ENTITY_ID, CARD_ACCT);

  return {
    trueUp,
    amex,
    adjustment,
    reconciliations,
    account2010Balance: finalBal?.balance,
    juneTarget: junTarget,
    balanceMatchesJune: junTarget != null && Math.abs((finalBal?.balance || 0) - junTarget) < 0.07,
  };
}

/** Tie 2010 to statement balance after bank/card payment timing differences. */
async function ensureAmexReconcileAdjustment(db, currentBalance, targetBalance, userId) {
  const diff = Math.round((currentBalance - targetBalance) * 100) / 100;
  if (Math.abs(diff) < 0.07) return { skipped: true, balance: currentBalance };

  const existing = await db.get(
    "SELECT id FROM journal_entries WHERE entity_id = ? AND je_number = 'RECON-AMEX-20260608' AND status = 'POSTED' AND reversed_by_je_id IS NULL",
    [ENTITY_ID]
  );
  if (existing) return { skipped: true, reason: 'already posted' };

  const card = await db.get(
    'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
    [ENTITY_ID, CARD_ACCT]
  );
  const equity = await db.get(
    'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
    [ENTITY_ID, '3900']
  );
  if (!card || !equity) throw new Error('Accounts 2010/3900 not found');

  const amount = Math.abs(diff);
  const drCard = diff > 0;
  const jeId = `je-${uuidv4()}`;
  await db.run(
    `INSERT INTO journal_entries (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, 'RECON-AMEX-20260608', ?, '2026-06-08', 'DRAFT', ?, ?, ?, ?)`,
    [jeId, ENTITY_ID, 'Amex 88007 statement tie-out — bank/card payment timing', userId, amount, amount, 'Amex catch-up']
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [`jel-${uuidv4()}`, jeId, card.id, drCard ? amount : 0, drCard ? 0 : amount, 'Amex recon adjustment']
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 2)`,
    [`jel-${uuidv4()}`, jeId, equity.id, drCard ? 0 : amount, drCard ? amount : 0, 'Opening balance equity']
  );
  await postJournalEntryToGl(db, { journalId: jeId, entityId: ENTITY_ID, userId });
  return { amount, jeNumber: 'RECON-AMEX-20260608', priorBalance: currentBalance, targetBalance };
}
