/**
 * Correct Ivymount $215k mis-posted to rental income → Justin Financial intercompany.
 *
 * Dr 4100 Rental Income $215,000
 * Cr 1901 Due From Justin Financial $215,000
 *
 * Idempotent via je_number CORR-IVYMOUNT-RENTAL-215K-20251015.
 */
import { v4 as uuidv4 } from 'uuid';
import { postJournalEntryToGl } from './post-journal.js';
import { reopenPeriod, closePeriod } from './period-lock.js';
import { getPeriodIntegrityStatus } from './period-integrity.js';

export const IVYMOUNT_CORR_JE = 'CORR-IVYMOUNT-RENTAL-215K-20251015';
export const IVYMOUNT_CORR_AMOUNT = 215000;
export const IVYMOUNT_CORR_DATE = '2025-10-15';
export const IVYMOUNT_CORR_CONFIRM = (entityId) => `CORR-IVYMOUNT-215K-${entityId}`;

/**
 * @param {object} db
 * @param {{ entityId: string, userId?: string, reclose?: boolean }} opts
 */
export async function correctIvymountRentalMispost(
  db,
  { entityId = 'ent-ljc', userId = 'usr-admin', reclose = true } = {}
) {
  if (entityId !== 'ent-ljc') {
    throw new Error('Ivymount rental correction applies only to ent-ljc');
  }

  const existing = await db.get(
    'SELECT id, je_number, posting_date, status FROM journal_entries WHERE entity_id = ? AND je_number = ?',
    [entityId, IVYMOUNT_CORR_JE]
  );
  if (existing) {
    return {
      skipped: true,
      reason: 'Correction already posted',
      journalEntryId: existing.id,
      jeNumber: existing.je_number,
      postingDate: existing.posting_date,
    };
  }

  const rental = await db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, '4100']
  );
  const dueFromJustin = await db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, '1901']
  );
  if (!rental) throw new Error('Account 4100 Rental Income not found');
  if (!dueFromJustin) throw new Error('Account 1901 Due From Justin Financial not found');

  const periodStart = '2025-01-01';
  const periodEnd = '2025-12-31';
  const integrityBefore = await getPeriodIntegrityStatus(db, { entityId, periodStart, periodEnd });
  const wasClosed = !!integrityBefore.isClosed || integrityBefore.databasePeriodStatus === 'CLOSED';

  const report = {
    entityId,
    amount: IVYMOUNT_CORR_AMOUNT,
    postingDate: IVYMOUNT_CORR_DATE,
  };

  if (wasClosed) {
    try {
      report.reopened = await reopenPeriod(db, { entityId, periodStart, periodEnd, userId });
    } catch (e) {
      report.reopened = { error: e.message };
    }
  }

  const amt = IVYMOUNT_CORR_AMOUNT.toFixed(2);
  const jeId = `je-${uuidv4()}`;
  const description =
    'CORRECTION: Ivymount $215k REO conveyance mis-posted to rental income → Due from Justin Financial';

  await db.run(
    `INSERT INTO journal_entries
     (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [
      jeId,
      entityId,
      IVYMOUNT_CORR_JE,
      description,
      IVYMOUNT_CORR_DATE,
      userId,
      amt,
      amt,
      'Real reclass — not a plug. Removes phantom rental income; reduces Due from Justin Financial.',
    ]
  );

  const lines = [
    {
      accountId: rental.id,
      debit: amt,
      credit: 0,
      description: 'Reverse phantom Ivymount rental income (REO conveyance to Justin)',
    },
    {
      accountId: dueFromJustin.id,
      debit: 0,
      credit: amt,
      description: 'Route $215k to Justin Financial intercompany (reduce Due from Justin)',
    },
  ];

  const signed = lines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
  if (Math.round(signed * 100) !== 0) {
    throw new Error('Unbalanced Transaction: Total Debits must equal Total Credits.');
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    await db.run(
      `INSERT INTO journal_entry_lines
       (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`jel-${uuidv4()}`, jeId, line.accountId, line.debit, line.credit, line.description, i + 1]
    );
  }

  await postJournalEntryToGl(db, { journalId: jeId, entityId, userId });
  report.journal = { id: jeId, jeNumber: IVYMOUNT_CORR_JE, postingDate: IVYMOUNT_CORR_DATE };
  report.lines = [
    { accountNumber: '4100', accountName: rental.account_name, debit: IVYMOUNT_CORR_AMOUNT, credit: 0 },
    {
      accountNumber: '1901',
      accountName: dueFromJustin.account_name,
      debit: 0,
      credit: IVYMOUNT_CORR_AMOUNT,
    },
  ];

  if (wasClosed && reclose) {
    const integrity = await getPeriodIntegrityStatus(db, { entityId, periodStart, periodEnd });
    report.integrityBeforeClose = {
      isClosed: integrity.isClosed,
      canClose: integrity.canClose,
      blockers: (integrity.blockers || []).slice(0, 8),
    };
    if (integrity.canClose || integrity.isClosed) {
      try {
        report.closed = await closePeriod(db, {
          entityId,
          periodStart,
          periodEnd,
          userId,
          notes: 'Re-close after Ivymount rental→IC correction',
        });
      } catch (e) {
        report.closed = { error: e.message, code: e.code };
      }
    } else {
      report.closed = {
        skipped: true,
        reason: 'Period cannot close yet — see integrityBeforeClose.blockers',
      };
    }
  }

  const integrityAfter = await getPeriodIntegrityStatus(db, { entityId, periodStart, periodEnd });
  report.integrityAfter = {
    isClosed: integrityAfter?.isClosed,
    canClose: integrityAfter?.canClose,
    blockers: (integrityAfter?.blockers || []).slice(0, 8),
  };

  return report;
}
