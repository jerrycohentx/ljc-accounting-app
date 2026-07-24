/**
 * Reverse RESTORE-* journals that re-posted mistaken dedupe undos (append-only).
 */
import { reverseJournalEntry } from './reverse-journal.js';
import { normalizeIsoDate } from './bank-statement-view.js';

const ENTITY_ID = 'ent-ljc';

export async function reverseRestoreImportJournals(db, {
  entityId = ENTITY_ID,
  userId = 'usr-admin',
  dryRun = false,
} = {}) {
  const rows = await db.all(
    `SELECT id, je_number, posting_date, memo, description
     FROM journal_entries
     WHERE entity_id = ?
       AND status = 'POSTED'
       AND reversed_by_je_id IS NULL
       AND reverses_je_id IS NULL
       AND (
         je_number LIKE 'RESTORE-%'
         OR COALESCE(memo, '') LIKE 'restore-import:%'
       )
     ORDER BY posting_date, je_number`,
    [entityId]
  );

  const reversed = [];
  const skipped = [];
  for (const row of rows) {
    const iso = normalizeIsoDate(row.posting_date);
    if (dryRun) {
      reversed.push({ dryRun: true, je: row.je_number, date: iso });
      continue;
    }
    try {
      const result = await reverseJournalEntry(db, {
        journalId: row.id,
        entityId,
        userId,
        reversalDate: iso,
        memo: `Undo bad restore ${row.je_number}`,
      });
      reversed.push({
        je: row.je_number,
        date: iso,
        reversalId: result.reversalJournalId,
      });
    } catch (e) {
      skipped.push({ je: row.je_number, error: e.message });
    }
  }
  return { reversedCount: reversed.length, skippedCount: skipped.length, reversed, skipped };
}
