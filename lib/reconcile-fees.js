/**
 * QuickBooks-style reconcile fees.
 *
 * When the user enters a Service Charge or Interest Earned in the Begin
 * Reconciliation dialog (because it is not already in the books), QuickBooks
 * posts those as real transactions to an expense / income account and clears
 * them as part of the reconciliation. This mirrors that behaviour.
 *
 * Posting is idempotent: each fee uses a deterministic journal number so a
 * re-run of the same statement period reuses the existing entry instead of
 * double-posting.
 */

import { v4 as uuidv4 } from 'uuid';
import { postJournalEntryToGl } from './post-journal.js';

async function findAccountId(db, entityId, { type, like }) {
  for (const pattern of like) {
    // eslint-disable-next-line no-await-in-loop
    const row = await db.get(
      `SELECT id FROM accounts WHERE entity_id = ? AND account_type = ? AND is_active = 1
         AND account_name LIKE ? ORDER BY account_number LIMIT 1`,
      [entityId, type, pattern]
    );
    if (row) return row.id;
  }
  const any = await db.get(
    `SELECT id FROM accounts WHERE entity_id = ? AND account_type = ? AND is_active = 1
       ORDER BY account_number LIMIT 1`,
    [entityId, type]
  );
  return any?.id || null;
}

async function ensureFeeJournal(db, {
  entityId, jeNumber, postingDate, description, accountId, accountLine, offsetId, offsetLine, userId,
}) {
  const existing = await db.get(
    'SELECT id FROM journal_entries WHERE entity_id = ? AND je_number = ?',
    [entityId, jeNumber]
  );
  let jeId = existing?.id;
  if (!existing) {
    jeId = `je-${uuidv4()}`;
    await db.run(
      `INSERT INTO journal_entries
       (id, entity_id, je_number, posting_date, description, status, created_by, source)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, 'reconcile-fee')`,
      [jeId, entityId, jeNumber, postingDate, description, userId]
    );
    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, description)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
      [`jel-${uuidv4()}`, jeId, accountId, accountLine.debit, accountLine.credit, description]
    );
    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, description)
       VALUES (?, ?, 2, ?, ?, ?, ?)`,
      [`jel-${uuidv4()}`, jeId, offsetId, offsetLine.debit, offsetLine.credit, description]
    );
    await postJournalEntryToGl(db, { journalId: jeId, entityId, userId });
  }
  const glRow = await db.get(
    'SELECT id FROM general_ledger WHERE journal_entry_id = ? AND account_id = ? LIMIT 1',
    [jeId, accountId]
  );
  return { jeId, accountGlId: glRow?.id || null };
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/**
 * Post service charge / interest transactions for a reconciliation.
 * Returns the bank/account-side GL line ids so the caller can mark them cleared.
 */
export async function postReconcileFees(db, {
  entityId,
  accountId,
  accountNumber,
  statementDate,
  serviceCharge = 0,
  interestEarned = 0,
  // QuickBooks lets the user pick which account the charge / interest posts to
  // and on what date. When omitted we fall back to auto-detection + statement date.
  serviceChargeAccountId = null,
  interestAccountId = null,
  serviceChargeDate = null,
  interestDate = null,
  userId = 'usr-admin',
}) {
  const stmtDay = String(statementDate).slice(0, 10);
  const svc = round2(serviceCharge);
  const intr = round2(interestEarned);
  const result = { feeGlIds: [], serviceChargeJe: null, interestJe: null };

  if (svc > 0.005) {
    const expenseId = serviceChargeAccountId || await findAccountId(db, entityId, {
      type: 'EXPENSE',
      like: ['%Bank Service Charge%', '%Service Charge%', '%Bank Charge%', '%Bank Fee%', '%Bank-Charge%'],
    });
    if (!expenseId) throw new Error('No expense account found for bank service charge');
    const postingDate = String(serviceChargeDate || statementDate).slice(0, 10);
    // Service charge reduces the account (credit asset / credit liability) and debits the expense.
    const jeNumber = `SVC-CHG-${accountNumber}-${stmtDay.replace(/-/g, '')}`;
    const { jeId, accountGlId } = await ensureFeeJournal(db, {
      entityId,
      jeNumber,
      postingDate,
      description: `Bank service charge ${postingDate}`,
      accountId,
      accountLine: { debit: 0, credit: svc },
      offsetId: expenseId,
      offsetLine: { debit: svc, credit: 0 },
      userId,
    });
    result.serviceChargeJe = jeId;
    if (accountGlId) result.feeGlIds.push(accountGlId);
  }

  if (intr > 0.005) {
    const incomeId = interestAccountId || await findAccountId(db, entityId, {
      type: 'REVENUE',
      like: ['%Interest Income%', '%Interest Earned%', '%Interest%'],
    });
    if (!incomeId) throw new Error('No income account found for interest earned');
    const postingDate = String(interestDate || statementDate).slice(0, 10);
    // Interest increases the account (debit asset / reduce liability) and credits income.
    const jeNumber = `INT-ERND-${accountNumber}-${stmtDay.replace(/-/g, '')}`;
    const { jeId, accountGlId } = await ensureFeeJournal(db, {
      entityId,
      jeNumber,
      postingDate,
      description: `Interest earned ${postingDate}`,
      accountId,
      accountLine: { debit: intr, credit: 0 },
      offsetId: incomeId,
      offsetLine: { debit: 0, credit: intr },
      userId,
    });
    result.interestJe = jeId;
    if (accountGlId) result.feeGlIds.push(accountGlId);
  }

  return result;
}
