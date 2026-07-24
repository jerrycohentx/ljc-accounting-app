/**
 * Reverse two Lonestar 1001 postings that are not on Lonestar statements
 * (Mercury funding JE + Simmons OFX transfer twin) so Apr/May books match statements.
 */
import { reverseJournalEntry } from './reverse-journal.js';

const ENTITY_ID = 'ent-ljc';

const TARGETS = [
  {
    jeNumber: 'JE-1784861068242',
    reason: 'LSB→Mercury funding not on Lonestar April statement',
  },
  {
    jeNumberPrefix: 'IMP-1783739674473',
    reason: 'Simmons OFX Lonestar credit twin not on Lonestar May statement',
  },
];

export async function reverseLonestarStatementMismatches(db, {
  entityId = ENTITY_ID,
  userId = 'usr-admin',
} = {}) {
  const results = [];
  for (const t of TARGETS) {
    let row;
    if (t.jeNumber) {
      row = await db.get(
        `SELECT id, je_number, posting_date, reversed_by_je_id, status
         FROM journal_entries WHERE entity_id = ? AND je_number = ? AND status = 'POSTED'`,
        [entityId, t.jeNumber]
      );
    } else {
      row = await db.get(
        `SELECT id, je_number, posting_date, reversed_by_je_id, status
         FROM journal_entries
         WHERE entity_id = ? AND je_number LIKE ? AND status = 'POSTED'
         ORDER BY created_at DESC LIMIT 1`,
        [entityId, `${t.jeNumberPrefix}%`]
      );
    }
    if (!row) {
      results.push({ ...t, skipped: true, reason: 'not found' });
      continue;
    }
    if (row.reversed_by_je_id) {
      results.push({ jeNumber: row.je_number, skipped: true, reason: 'already reversed' });
      continue;
    }
    const postingDate = String(row.posting_date).slice(0, 10);
    const iso = /^\d{4}-\d{2}-\d{2}/.test(postingDate)
      ? postingDate.slice(0, 10)
      : new Date(row.posting_date).toISOString().slice(0, 10);
    const rev = await reverseJournalEntry(db, {
      journalId: row.id,
      entityId,
      userId,
      reversalDate: iso,
      memo: t.reason,
    });
    results.push({ jeNumber: row.je_number, reversed: true, reason: t.reason, ...rev });
  }
  return { results };
}
