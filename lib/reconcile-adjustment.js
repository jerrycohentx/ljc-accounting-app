/**
 * QBD "Enter Adjustment" — posts balancing JE when user cannot resolve difference.
 * Use sparingly; accountant should review (per Intuit guidance).
 */

import { v4 as uuidv4 } from 'uuid';
import { postJournalEntryToGl } from './post-journal.js';
import { getBeginningBalance } from './bank-reconcile-session.js';
import { computeReconcileTotals, sumClearedBySide } from './reconcile-calc.js';

async function findOffsetAccount(db, entityId) {
  const prefer = await db.get(
    `SELECT id FROM accounts WHERE entity_id = ? AND (
      account_name LIKE '%Reconciliation%' OR account_number IN ('5999', '6999')
    ) AND is_active = 1 LIMIT 1`,
    [entityId]
  );
  if (prefer) return prefer.id;

  const expense = await db.get(
    `SELECT id FROM accounts WHERE entity_id = ? AND account_type = 'EXPENSE' AND is_active = 1
     ORDER BY account_number LIMIT 1`,
    [entityId]
  );
  if (expense) return expense.id;

  const equity = await db.get(
    `SELECT id FROM accounts WHERE entity_id = ? AND account_type = 'EQUITY' AND is_active = 1
     ORDER BY account_number LIMIT 1`,
    [entityId]
  );
  if (!equity) throw new Error('No offset account found for reconciliation adjustment');
  return equity.id;
}

/**
 * @param {number} difference — endingBalance − clearedBalance (same sign as reconcile UI)
 */
export async function postReconcileAdjustment(db, {
  entityId,
  accountId,
  statementDate,
  difference,
  glIds = [],
  serviceCharge = 0,
  interestEarned = 0,
  statementEndingBalance,
  userId = 'usr-admin',
}) {
  const diff = Number(difference);
  if (!Number.isFinite(diff) || Math.abs(diff) < 0.005) {
    throw new Error('Difference is already zero — no adjustment needed');
  }

  const account = await db.get(
    'SELECT id, normal_balance FROM accounts WHERE id = ? AND entity_id = ? AND is_active = 1',
    [accountId, entityId]
  );
  if (!account) throw new Error('Account not found');

  const offsetId = await findOffsetAccount(db, entityId);
  const amount = Math.abs(diff);
  const postingDate = statementDate || new Date().toISOString().slice(0, 10);

  // Positive difference: statement ending > cleared → increase bank asset (debit bank for DEBIT-normal)
  const increaseBank = diff > 0;
  const bankDebit = account.normal_balance === 'DEBIT' ? increaseBank : !increaseBank;

  const jeId = `je-${uuidv4()}`;
  const jeNumber = `RECON-ADJ-${postingDate.replace(/-/g, '')}`;
  const description = `Reconciliation adjustment ${postingDate} (${diff >= 0 ? '+' : ''}${diff.toFixed(2)})`;

  await db.run(
    `INSERT INTO journal_entries
     (id, entity_id, je_number, posting_date, description, status, created_by, source)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, 'reconcile-adjustment')`,
    [jeId, entityId, jeNumber, postingDate, description, userId]
  );

  const bankLine = bankDebit
    ? { debit: amount, credit: 0 }
    : { debit: 0, credit: amount };
  const offLine = bankDebit
    ? { debit: 0, credit: amount }
    : { debit: amount, credit: 0 };

  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, description)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
    [`jel-${uuidv4()}`, jeId, accountId, bankLine.debit, bankLine.credit, description]
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, description)
     VALUES (?, ?, 2, ?, ?, ?, ?)`,
    [`jel-${uuidv4()}`, jeId, offsetId, offLine.debit, offLine.credit, description]
  );

  await postJournalEntryToGl(db, { journalId: jeId, entityId, userId });

  const beginningBalance = await getBeginningBalance(
    db,
    entityId,
    accountId,
    statementDate,
    account.normal_balance
  );

  const clearedRows = glIds.length
    ? await db.all(
      `SELECT gl.id, gl.debit, gl.credit FROM general_ledger gl
       JOIN journal_entries je ON je.id = gl.journal_entry_id
       WHERE gl.id IN (${glIds.map(() => '?').join(',')}) AND gl.entity_id = ? AND je.status = 'POSTED'`,
      [...glIds, entityId]
    )
    : [];

  const sideTotals = sumClearedBySide(clearedRows, account, glIds, account.normal_balance);
  const calc = computeReconcileTotals({
    beginningBalance,
    serviceCharge,
    interestEarned,
    markedDeposits: sideTotals.markedDeposits,
    markedPayments: sideTotals.markedPayments,
    endingBalance: statementEndingBalance,
  });

  return {
    journalEntryId: jeId,
    jeNumber,
    adjustmentAmount: amount,
    signedDifference: diff,
    projectedDifference: calc.difference,
    message: `Adjustment journal ${jeNumber} posted for ${amount.toFixed(2)}`,
  };
}
