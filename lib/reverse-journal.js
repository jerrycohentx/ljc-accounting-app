import { v4 as uuidv4 } from 'uuid';
import { postJournalEntryToGl } from './post-journal.js';
import { assertPeriodOpen } from './period-lock.js';

/**
 * Create and post an offsetting journal entry for a posted JE.
 * Original JE is marked with reversed_by_je_id; reversal references reverses_je_id.
 */
export async function reverseJournalEntry(db, {
  journalId,
  entityId,
  userId,
  reversalDate = null,
  memo = null,
}) {
  const original = await db.get(
    'SELECT * FROM journal_entries WHERE id = ? AND entity_id = ?',
    [journalId, entityId]
  );
  if (!original) throw new Error('Journal entry not found');
  if (original.status !== 'POSTED') {
    throw new Error('Only posted journal entries can be reversed');
  }
  if (original.reversed_by_je_id) {
    throw new Error('Journal entry has already been reversed');
  }
  if (original.reverses_je_id) {
    throw new Error('Cannot reverse a reversing entry');
  }

  const postingDate = reversalDate || original.posting_date;
  await assertPeriodOpen(db, entityId, postingDate);

  const origLines = await db.all(
    'SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? ORDER BY line_number',
    [journalId]
  );

  const reversalId = `je-${uuidv4()}`;
  const jeNumber = `REV-${original.je_number}-${Date.now()}`;
  const description = memo || `Reversal of ${original.je_number}: ${original.description}`;

  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of origLines) {
    totalDebit += Number(line.credit || 0);
    totalCredit += Number(line.debit || 0);
  }

  await db.run(
    `INSERT INTO journal_entries
     (id, entity_id, je_number, description, posting_date, status, created_by, memo, total_debit, total_credit, reverses_je_id)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
    [
      reversalId,
      entityId,
      jeNumber,
      description,
      postingDate,
      userId,
      memo || 'AUTO-REVERSAL',
      totalDebit.toFixed(2),
      totalCredit.toFixed(2),
      journalId,
    ]
  );

  for (let i = 0; i < origLines.length; i++) {
    const line = origLines[i];
    await db.run(
      `INSERT INTO journal_entry_lines
       (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        `jel-${uuidv4()}`,
        reversalId,
        line.account_id,
        line.credit || 0,
        line.debit || 0,
        line.description ? `Reversal: ${line.description}` : 'Reversal',
        i + 1,
      ]
    );
  }

  await postJournalEntryToGl(db, { journalId: reversalId, entityId, userId });

  await db.run(
    'UPDATE journal_entries SET reversed_by_je_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [reversalId, journalId]
  );

  return {
    originalJournalId: journalId,
    reversalJournalId: reversalId,
    reversalJeNumber: jeNumber,
    postingDate,
  };
}
