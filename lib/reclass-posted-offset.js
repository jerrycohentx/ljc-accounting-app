/**
 * Append-only reclass for a posted journal entry offset line (non-bank side).
 * Creates a balancing reclass JE; never UPDATEs general_ledger in place.
 *
 * Idempotent via memo `reclass-offset:<origJeId>:<lineId>:<toAccountId>`.
 */
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { postJournalEntryToGl } from './post-journal.js';
import { reopenPeriod, closePeriod, monthBounds } from './period-lock.js';
import { getPeriodIntegrityStatus } from './period-integrity.js';
import { learnFromUserCategory } from './category-learn.js';
import { normalizeIsoDate } from './bank-statement-view.js';

function toIsoDate(value) {
  return normalizeIsoDate(value) || String(value || '').slice(0, 10);
}

/**
 * @returns {Promise<object>}
 */
export async function reclassPostedOffsetLine(db, {
  journalId,
  entityId,
  lineId,
  toAccountId,
  userId = 'usr-admin',
  learnRule = true,
  bankAccountIds = [],
} = {}) {
  if (!journalId || !entityId || !lineId || !toAccountId) {
    throw new Error('journalId, entityId, lineId, and toAccountId are required');
  }

  const original = await db.get(
    'SELECT * FROM journal_entries WHERE id = ? AND entity_id = ?',
    [journalId, entityId]
  );
  if (!original) throw new Error('Journal entry not found');
  if (original.status !== 'POSTED') {
    throw new Error('Only posted journal entries can be reclassified here');
  }
  if (original.reversed_by_je_id) {
    throw new Error('Cannot reclass a reversed journal entry');
  }
  if (original.reverses_je_id) {
    throw new Error('Cannot reclass a reversing entry');
  }

  const line = await db.get(
    `SELECT jel.*, a.account_number, a.account_name
     FROM journal_entry_lines jel
     JOIN accounts a ON a.id = jel.account_id
     WHERE jel.id = ? AND jel.journal_entry_id = ?`,
    [lineId, journalId]
  );
  if (!line) throw new Error('Journal line not found on this entry');

  const bankIds = new Set((bankAccountIds || []).filter(Boolean));
  if (bankIds.has(line.account_id)) {
    throw new Error('Cannot reclass the bank or reconciling account line — pick the offset line');
  }

  const target = await db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE id = ? AND entity_id = ?',
    [toAccountId, entityId]
  );
  if (!target) throw new Error('Target account not found');
  if (String(target.id) === String(line.account_id)) {
    throw new Error('Entry is already classified to that account');
  }

  const memo = `reclass-offset:${journalId}:${lineId}:${toAccountId}`;
  const existing = await db.get(
    `SELECT id, je_number FROM journal_entries
     WHERE entity_id = ? AND status = 'POSTED' AND memo = ? AND reversed_by_je_id IS NULL`,
    [entityId, memo]
  );
  if (existing) {
    return {
      alreadyApplied: true,
      reclassJeId: existing.id,
      reclassJeNumber: existing.je_number,
      fromAccountId: line.account_id,
      fromAccountNumber: line.account_number,
      toAccountId: target.id,
      toAccountNumber: target.account_number,
    };
  }

  const debit = new Decimal(line.debit || 0);
  const credit = new Decimal(line.credit || 0);
  if (debit.isZero() && credit.isZero()) {
    throw new Error('Selected line has zero amount');
  }

  const amount = Decimal.max(debit, credit);
  const postingDate = toIsoDate(original.posting_date);
  const { periodStart, periodEnd } = monthBounds(postingDate);
  const integrity = await getPeriodIntegrityStatus(db, { entityId, periodStart, periodEnd });
  const wasClosed = integrity.isClosed || integrity.databasePeriodStatus === 'CLOSED';
  if (wasClosed) {
    await reopenPeriod(db, { entityId, periodStart, periodEnd });
  }

  const fromAcct = await db.get('SELECT id, account_number FROM accounts WHERE id = ?', [line.account_id]);
  const jeId = `je-${uuidv4()}`;
  const jeNumber = `RCLS-${Date.now()}-${uuidv4().substring(0, 6)}`;
  const description = `Reclass ${fromAcct.account_number}→${target.account_number}: ${original.je_number}`;

  await db.run(
    `INSERT INTO journal_entries
     (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [
      jeId,
      entityId,
      jeNumber,
      description,
      postingDate,
      userId,
      amount.toFixed(2),
      amount.toFixed(2),
      memo,
    ]
  );

  // Move balance from old offset account to new offset account.
  if (debit.gt(0)) {
    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, 0, ?, 1)`,
      [`jel-${uuidv4()}`, jeId, target.id, debit.toFixed(2), `Reclass to ${target.account_number}`]
    );
    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, 0, ?, ?, 2)`,
      [`jel-${uuidv4()}`, jeId, fromAcct.id, debit.toFixed(2), `Clear ${fromAcct.account_number}`]
    );
  } else {
    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, 0, ?, 1)`,
      [`jel-${uuidv4()}`, jeId, fromAcct.id, credit.toFixed(2), `Clear ${fromAcct.account_number}`]
    );
    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, 0, ?, ?, 2)`,
      [`jel-${uuidv4()}`, jeId, target.id, credit.toFixed(2), `Reclass to ${target.account_number}`]
    );
  }

  await postJournalEntryToGl(db, { journalId: jeId, entityId, userId });

  if (learnRule && original.description) {
    await learnFromUserCategory(db, {
      entityId,
      description: original.description,
      offsetAccountId: target.id,
    });
  }

  // Keep import_transactions in sync when this JE came from bank import.
  await db.run(
    `UPDATE import_transactions SET offset_account_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE journal_entry_id = ? AND entity_id = ?`,
    [target.id, journalId, entityId]
  );

  if (wasClosed) {
    const after = await getPeriodIntegrityStatus(db, { entityId, periodStart, periodEnd });
    if (after.canClose) {
      await closePeriod(db, { entityId, periodStart, periodEnd, userId });
    }
  }

  return {
    reclassJeId: jeId,
    reclassJeNumber: jeNumber,
    fromAccountId: fromAcct.id,
    fromAccountNumber: fromAcct.account_number,
    toAccountId: target.id,
    toAccountNumber: target.account_number,
    toAccountName: target.account_name,
    amount: Number(amount.toFixed(2)),
    learnedRule: Boolean(learnRule),
  };
}
