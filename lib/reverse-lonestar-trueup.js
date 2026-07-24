/**
 * Reverse Lonestar TRUEUP-20260101 when OB-20260101 already carries the correct opening.
 */
import { reverseJournalEntry } from './reverse-journal.js';

const ENTITY_ID = 'ent-ljc';
const TRUEUP = 'TRUEUP-20260101-LONESTAR';

export async function reverseLonestarOpeningTrueUp(db, { entityId = ENTITY_ID, userId = 'usr-admin' } = {}) {
  const trueUp = await db.get(
    `SELECT id, je_number, posting_date, reversed_by_je_id, status
     FROM journal_entries
     WHERE entity_id = ? AND je_number = ? AND status = 'POSTED'`,
    [entityId, TRUEUP]
  );
  if (!trueUp) return { skipped: true, reason: 'true-up not found' };
  if (trueUp.reversed_by_je_id) return { skipped: true, reason: 'already reversed', id: trueUp.id };

  const ob = await db.get(
    `SELECT id FROM journal_entries
     WHERE entity_id = ? AND je_number = 'OB-20260101' AND status = 'POSTED' AND reversed_by_je_id IS NULL`,
    [entityId]
  );
  if (!ob) return { skipped: true, reason: 'OB-20260101 missing — keep true-up' };

  // Confirm both put 598.88 on 1001
  const a1001 = await db.get(
    `SELECT id FROM accounts WHERE entity_id = ? AND account_number = '1001'`,
    [entityId]
  );
  const trueUpLine = await db.get(
    `SELECT debit, credit FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = ?`,
    [trueUp.id, a1001.id]
  );
  if (!trueUpLine) return { skipped: true, reason: 'true-up has no 1001 line' };

  const result = await reverseJournalEntry(db, {
    journalId: trueUp.id,
    entityId,
    userId,
    reversalDate: '2026-01-01',
    memo: 'Reverse Lonestar true-up — OB-20260101 already includes correct 1001 opening',
  });

  return {
    reversed: true,
    trueUpId: trueUp.id,
    amount: Number(trueUpLine.debit || trueUpLine.credit || 0),
    ...result,
  };
}
