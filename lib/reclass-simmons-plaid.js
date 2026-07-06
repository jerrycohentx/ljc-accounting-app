/**
 * One-time repair: move posted Simmons Plaid bank-side activity from GL 1000 → 1030.
 * Append-only — creates offsetting reclass JEs; never UPDATEs general_ledger.
 */

import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { postJournalEntryToGl } from './post-journal.js';

const ENTITY_ID = 'ent-ljc';
const FROM_ACCOUNT = '1000';
const TO_ACCOUNT = '1030';
const PLAID_DESC_PREFIX = 'Simmons Bank (Plaid):';
const REVERSAL_PLAID_PATTERN = 'Reversal of IMP-%: Simmons Bank (Plaid)%';

/**
 * @returns {Promise<{ scanned: number, reclassed: number, skipped: number, errors: string[] }>}
 */
export async function reclassPostedSimmonsPlaidBankAccount(db, {
  entityId = ENTITY_ID,
  userId,
  dryRun = false,
} = {}) {
  const fromAcct = await db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, FROM_ACCOUNT]
  );
  const toAcct = await db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, TO_ACCOUNT]
  );
  if (!fromAcct) throw new Error(`Account ${FROM_ACCOUNT} not found for ${entityId}`);
  if (!toAcct) throw new Error(`Account ${TO_ACCOUNT} not found for ${entityId} — run COA seed first`);

  const rows = await db.all(
    `SELECT je.id AS journal_id, je.je_number, je.description, je.posting_date,
            jel.debit, jel.credit
     FROM journal_entries je
     JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id AND jel.line_number = 1
     JOIN general_ledger gl ON gl.journal_entry_id = je.id AND gl.account_id = jel.account_id
     WHERE je.entity_id = ? AND je.status = 'POSTED' AND jel.account_id = ?
       AND (je.description LIKE ? OR je.description LIKE ?)
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries r
         WHERE r.entity_id = je.entity_id AND r.memo LIKE ('reclass-plaid-1030:' || je.id || '%')
       )
     ORDER BY je.posting_date, je.je_number`,
    [entityId, fromAcct.id, `${PLAID_DESC_PREFIX}%`, REVERSAL_PLAID_PATTERN]
  );

  let reclassed = 0;
  let skipped = 0;
  const errors = [];

  for (const row of rows) {
    const debit = new Decimal(row.debit || 0);
    const credit = new Decimal(row.credit || 0);
    if (debit.isZero() && credit.isZero()) {
      skipped += 1;
      continue;
    }

    if (dryRun) {
      reclassed += 1;
      continue;
    }

    try {
      const jeId = `je-${uuidv4()}`;
      const jeNumber = `JE-${Date.now()}-${uuidv4().substring(0, 6)}`;
      const amount = Decimal.max(debit, credit);
      const memo = `reclass-plaid-1030:${row.journal_id}`;

      await db.run(
        `INSERT INTO journal_entries (
          id, entity_id, je_number, description, posting_date, status,
          created_by, total_debit, total_credit, memo
        ) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
        [
          jeId,
          entityId,
          jeNumber,
          `Reclass Simmons Plaid bank line from ${FROM_ACCOUNT} to ${TO_ACCOUNT}: ${row.je_number}`,
          row.posting_date,
          userId,
          amount.toFixed(2),
          amount.toFixed(2),
          memo,
        ]
      );

      if (debit.gt(0)) {
        await db.run(
          `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
           VALUES (?, ?, ?, ?, 0, ?, 1)`,
          [`jel-${uuidv4()}`, jeId, toAcct.id, debit.toFixed(2), `To ${TO_ACCOUNT}: ${row.description?.slice(0, 80) || ''}`]
        );
        await db.run(
          `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
           VALUES (?, ?, ?, 0, ?, ?, 2)`,
          [`jel-${uuidv4()}`, jeId, fromAcct.id, debit.toFixed(2), `From ${FROM_ACCOUNT}: ${row.description?.slice(0, 80) || ''}`]
        );
      } else {
        await db.run(
          `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
           VALUES (?, ?, ?, ?, 0, ?, 1)`,
          [`jel-${uuidv4()}`, jeId, fromAcct.id, credit.toFixed(2), `From ${FROM_ACCOUNT}: ${row.description?.slice(0, 80) || ''}`]
        );
        await db.run(
          `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
           VALUES (?, ?, ?, 0, ?, ?, 2)`,
          [`jel-${uuidv4()}`, jeId, toAcct.id, credit.toFixed(2), `To ${TO_ACCOUNT}: ${row.description?.slice(0, 80) || ''}`]
        );
      }

      await postJournalEntryToGl(db, { journalId: jeId, entityId, userId });
      reclassed += 1;
    } catch (err) {
      errors.push(`${row.je_number}: ${err.message}`);
    }
  }

  return { scanned: rows.length, reclassed, skipped, errors };
}
