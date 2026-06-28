/**
 * Correct Lone Star Bank (1001) opening balance on the balance sheet.
 * QBO migration CSV had -193.15; Jan 2026 bank statement shows $598.88 prior balance.
 */

import { v4 as uuidv4 } from 'uuid';
import { postJournalEntryToGl } from './post-journal.js';
import { reverseJournalEntry } from './reverse-journal.js';
import { getPostedBankBalance } from './bank-catchup.js';
import { closePeriod, reopenPeriod } from './period-lock.js';

const ENTITY_ID = 'ent-ljc';
const BANK_ACCT = '1001';
const TARGET_OB_DATE = '2025-12-31';
const TARGET_BALANCE = 598.88;
const FIX_JE_NUMBER = 'FIX-LS-OB-20251231';
const TRUEUP_JE_NUMBER = 'TRUEUP-20260101-LONESTAR';

async function withClosedPeriodReopened(db, entityId, postingDate, userId, fn) {
  const closed = await db.get(
    `SELECT id, period_start, period_end FROM accounting_periods
     WHERE entity_id = ? AND status = 'CLOSED'
       AND period_start <= ? AND period_end >= ?`,
    [entityId, postingDate, postingDate]
  );
  if (!closed) return fn();

  await reopenPeriod(db, {
    entityId,
    periodStart: closed.period_start,
    periodEnd: closed.period_end,
  });
  try {
    return await fn();
  } finally {
    await closePeriod(db, {
      entityId,
      periodStart: closed.period_start,
      periodEnd: closed.period_end,
      userId,
      notes: 'Re-closed after Lone Star opening balance correction',
    });
  }
}

export async function fixLonestarOpeningBalance2025(db, { userId = 'usr-admin' } = {}) {
  const bank = await db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE entity_id = ? AND account_number = ?',
    [ENTITY_ID, BANK_ACCT]
  );
  if (!bank) throw new Error('Lone Star account 1001 not found');

  const equity = await db.get(
    'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
    [ENTITY_ID, '3900']
  );
  if (!equity) throw new Error('Opening Balance Equity 3900 not found');

  const existingFix = await db.get(
    `SELECT id FROM journal_entries WHERE entity_id = ? AND je_number = ? AND status = 'POSTED' AND reversed_by_je_id IS NULL`,
    [ENTITY_ID, FIX_JE_NUMBER]
  );
  if (existingFix) {
    return { skipped: true, reason: 'already corrected', jeNumber: FIX_JE_NUMBER };
  }

  const asOfBal = await getPostedBankBalance(db, ENTITY_ID, BANK_ACCT, TARGET_OB_DATE);
  const current = asOfBal?.balance ?? 0;
  const diff = Math.round((TARGET_BALANCE - current) * 100) / 100;

  if (Math.abs(diff) < 0.01) {
    return { skipped: true, reason: 'balance already correct', balance: current };
  }

  const amount = Math.abs(diff);
  const debitBank = diff > 0;
  const jeId = `je-${uuidv4()}`;

  await db.run(
    `INSERT INTO journal_entries (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [
      jeId,
      ENTITY_ID,
      FIX_JE_NUMBER,
      'Correct Lone Star Bank opening balance per Jan 2026 statement',
      TARGET_OB_DATE,
      userId,
      amount,
      amount,
      `Adjust 1001 from ${current} to ${TARGET_BALANCE} as of ${TARGET_OB_DATE}`,
    ]
  );

  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [
      `jel-${uuidv4()}`,
      jeId,
      bank.id,
      debitBank ? amount : 0,
      debitBank ? 0 : amount,
      'Lone Star ckg-7367 opening balance correction',
    ]
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 2)`,
    [
      `jel-${uuidv4()}`,
      jeId,
      equity.id,
      debitBank ? 0 : amount,
      debitBank ? amount : 0,
      'Opening balance equity offset',
    ]
  );

  await withClosedPeriodReopened(db, ENTITY_ID, TARGET_OB_DATE, userId, async () => {
    await postJournalEntryToGl(db, { journalId: jeId, entityId: ENTITY_ID, userId });
  });

  const after = await getPostedBankBalance(db, ENTITY_ID, BANK_ACCT, TARGET_OB_DATE);
  return {
    corrected: true,
    jeNumber: FIX_JE_NUMBER,
    priorBalance: current,
    targetBalance: TARGET_BALANCE,
    adjustment: diff,
    balanceAfter: after?.balance,
  };
}

export async function reverseErrantLonestarTrueup(db, { userId = 'usr-admin' } = {}) {
  const row = await db.get(
    `SELECT id, entity_id FROM journal_entries
     WHERE entity_id = ? AND je_number = ? AND status = 'POSTED' AND reversed_by_je_id IS NULL`,
    [ENTITY_ID, TRUEUP_JE_NUMBER]
  );
  if (!row) {
    return { skipped: true, reason: 'no errant true-up found' };
  }

  const result = await withClosedPeriodReopened(db, ENTITY_ID, '2026-01-01', userId, async () =>
    reverseJournalEntry(db, {
      journalId: row.id,
      entityId: row.entity_id,
      userId,
      reversalDate: '2026-01-01',
      memo: 'Reverse erroneous Lone Star true-up (wrong opening balance baseline)',
    })
  );

  return { reversed: true, jeNumber: TRUEUP_JE_NUMBER, reversal: result };
}

export async function runLonestarBalanceFixes(db, { userId = 'usr-admin' } = {}) {
  const trueup = await reverseErrantLonestarTrueup(db, { userId });
  const opening = await fixLonestarOpeningBalance2025(db, { userId });
  return { trueup, opening };
}
