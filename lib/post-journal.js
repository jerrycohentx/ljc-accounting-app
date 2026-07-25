import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { assertPeriodOpen, reopenPeriod, closePeriod, monthBounds } from './period-lock.js';
import { assertNotPlugJournal, getPeriodIntegrityStatus } from './period-integrity.js';

/** CAT-APPR drafts reclass dump → expense; safe to reopen briefly to post into a closed month. */
function isCategorizationApprovalJournal(journal) {
  const num = String(journal?.je_number || '');
  const memo = String(journal?.memo || '');
  return num.startsWith('CAT-APPR-') || /cat-approve:/i.test(memo);
}

/**
 * Write journal_entry_lines to general_ledger and mark JE POSTED.
 * Idempotent: skips if GL rows already exist for this JE.
 *
 * Categorization drafts (CAT-APPR): if the posting month is closed, reopen → post →
 * re-close when integrity still allows. Bank/card recons are unchanged by dump→expense reclass.
 */
export async function postJournalEntryToGl(db, { journalId, entityId, userId = null }) {
  const journal = await db.get(
    'SELECT * FROM journal_entries WHERE id = ? AND entity_id = ?',
    [journalId, entityId]
  );
  if (!journal) throw new Error('Journal entry not found');
  if (journal.status === 'POSTED') return { journalId, alreadyPosted: true };

  assertNotPlugJournal({ source: journal.source, description: journal.description });

  const postingDate = String(journal.posting_date || '').slice(0, 10);
  const { periodStart, periodEnd } = monthBounds(postingDate);
  let periodReopened = false;
  let periodReclosed = false;
  let result;

  try {
    await assertPeriodOpen(db, entityId, journal.posting_date);
  } catch (err) {
    if (!isCategorizationApprovalJournal(journal) || !/closed period/i.test(err.message)) {
      throw err;
    }
    await reopenPeriod(db, { entityId, periodStart, periodEnd });
    periodReopened = true;
  }

  try {
    const existingGl = await db.get(
      'SELECT id FROM general_ledger WHERE journal_entry_id = ? LIMIT 1',
      [journalId]
    );
    if (existingGl) {
      await db.run(
        "UPDATE journal_entries SET status = 'POSTED', posted_date = COALESCE(posted_date, CURRENT_TIMESTAMP) WHERE id = ?",
        [journalId]
      );
      result = { journalId, alreadyPosted: true };
    } else {
      const lines = await db.all(
        'SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? ORDER BY line_number',
        [journalId]
      );
      if (lines.length < 2) throw new Error('Journal requires at least two lines');

      let totalDebit = new Decimal(0);
      let totalCredit = new Decimal(0);
      for (const line of lines) {
        totalDebit = totalDebit.plus(line.debit || 0);
        totalCredit = totalCredit.plus(line.credit || 0);
      }
      if (!totalDebit.equals(totalCredit)) {
        throw new Error('Unbalanced Transaction: Total Debits must equal Total Credits.');
      }

      if (journal.status === 'DRAFT') {
        await db.run(
          "UPDATE journal_entries SET status = 'APPROVED', approved_by = ?, approved_date = CURRENT_TIMESTAMP WHERE id = ?",
          [userId || journal.created_by, journalId]
        );
      }

      for (const line of lines) {
        await db.run(
          `INSERT INTO general_ledger
           (id, entity_id, account_id, journal_entry_id, debit, credit, posting_date, description, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            `gl-${uuidv4()}`,
            entityId,
            line.account_id,
            journalId,
            line.debit || 0,
            line.credit || 0,
            journal.posting_date,
            line.description || `${journal.description} (${journal.je_number})`,
          ]
        );
      }

      await db.run(
        "UPDATE journal_entries SET status = 'POSTED', posted_date = CURRENT_TIMESTAMP, total_debit = ?, total_credit = ? WHERE id = ?",
        [totalDebit.toFixed(2), totalCredit.toFixed(2), journalId]
      );
      result = { journalId, posted: true };
    }
  } finally {
    if (periodReopened) {
      try {
        const integrity = await getPeriodIntegrityStatus(db, { entityId, periodStart, periodEnd });
        if (integrity.canClose) {
          await closePeriod(db, {
            entityId,
            periodStart,
            periodEnd,
            userId: userId || journal.created_by || 'system',
            notes: 'Reclosed after categorization approval (CAT-APPR dump→expense)',
          });
          periodReclosed = true;
        }
      } catch {
        // Leave open if re-close fails — safer than masking the post error.
      }
    }
  }

  return { ...result, periodReopened, periodReclosed };
}
