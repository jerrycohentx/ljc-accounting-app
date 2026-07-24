/**
 * Reclass Opening Balance Equity (3900) into permanent equity (3100 Retained Earnings,
 * falling back to 3000 Owner's Equity).
 *
 * This is a real equity reclass — not a plug. It moves conversion/cutover equity out of
 * the temporary 3900 holding account into permanent equity so taxReturnReady can pass.
 */
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { postJournalEntryToGl } from './post-journal.js';
import { reopenPeriod, closePeriod } from './period-lock.js';
import { getPeriodIntegrityStatus } from './period-integrity.js';
import { POSTED_GL_SUBQUERY, calculateAccountBalance } from './posted-gl.js';

async function getAccountBalance(db, entityId, accountNumber, asOfDate) {
  const acc = await db.get(
    'SELECT id, account_number, account_name, account_type, normal_balance FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, accountNumber]
  );
  if (!acc) return null;
  const row = await db.get(
    `SELECT COALESCE(SUM(gl.debit),0) AS td, COALESCE(SUM(gl.credit),0) AS tc
     FROM (${POSTED_GL_SUBQUERY}) gl
     WHERE gl.account_id = ? AND gl.entity_id = ? AND gl.posting_date <= ?`,
    [acc.id, entityId, asOfDate]
  );
  const bal = calculateAccountBalance({ ...acc, total_debit: row?.td, total_credit: row?.tc });
  return { ...acc, balance: bal };
}

/**
 * @param {object} db
 * @param {{ entityId: string, asOfDate?: string, userId?: string, targetAccountNumber?: string, reclose?: boolean }} opts
 */
export async function reclassOpeningBalanceEquity(
  db,
  {
    entityId,
    asOfDate = '2025-12-31',
    userId = 'usr-admin',
    targetAccountNumber = '3100',
    reclose = true,
  } = {}
) {
  const obe = await getAccountBalance(db, entityId, '3900', asOfDate);
  if (!obe) throw new Error('Account 3900 Opening Balance Equity not found');

  const amount = new Decimal(obe.balance);
  if (amount.abs().lt(0.005)) {
    return {
      skipped: true,
      reason: '3900 already zero as of asOfDate',
      asOfDate,
      balance: 0,
    };
  }

  let target = await db.get(
    'SELECT id, account_number, account_name, normal_balance FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, targetAccountNumber]
  );
  if (!target && targetAccountNumber === '3100') {
    target = await db.get(
      'SELECT id, account_number, account_name, normal_balance FROM accounts WHERE entity_id = ? AND account_number = ?',
      [entityId, '3000']
    );
  }
  if (!target) {
    throw new Error(`Permanent equity account ${targetAccountNumber} (or 3000 fallback) not found`);
  }

  // 3900 credit-normal: positive balance = credit balance → clear with debit to 3900, credit to RE
  // negative balance = debit balance → clear with credit to 3900, debit to RE
  const amt = amount.abs().toFixed(2);
  const clearCreditBalance = amount.gt(0);
  const lines = clearCreditBalance
    ? [
        { accountId: obe.id, debit: amt, credit: 0, description: 'Reclass Opening Balance Equity out' },
        {
          accountId: target.id,
          debit: 0,
          credit: amt,
          description: `Reclass from 3900 → ${target.account_number} ${target.account_name}`,
        },
      ]
    : [
        {
          accountId: target.id,
          debit: amt,
          credit: 0,
          description: `Reclass from 3900 → ${target.account_number} ${target.account_name}`,
        },
        { accountId: obe.id, debit: 0, credit: amt, description: 'Reclass Opening Balance Equity out' },
      ];

  const periodStart = `${asOfDate.slice(0, 4)}-01-01`;
  const periodEnd = asOfDate;

  const report = {
    entityId,
    asOfDate,
    priorBalance3900: Number(amount.toFixed(2)),
    targetAccount: { number: target.account_number, name: target.account_name, id: target.id },
    amount: Number(amt),
  };

  // Reopen year so the reclass can post on asOfDate
  try {
    report.reopened = await reopenPeriod(db, { entityId, periodStart, periodEnd });
  } catch (e) {
    report.reopened = { error: e.message };
  }

  const jeId = `je-${uuidv4()}`;
  const jeNumber = `RECLASS-OBE-${asOfDate.replace(/-/g, '')}-${Date.now().toString().slice(-6)}`;
  await db.run(
    `INSERT INTO journal_entries
     (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [
      jeId,
      entityId,
      jeNumber,
      `Reclass Opening Balance Equity → ${target.account_number} ${target.account_name} (conversion to permanent equity)`,
      asOfDate,
      userId,
      amt,
      amt,
      'Real equity reclass — not a plug; clears temporary 3900 conversion holding account',
    ]
  );
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
  report.journal = { id: jeId, jeNumber, postingDate: asOfDate };

  const after = await getAccountBalance(db, entityId, '3900', asOfDate);
  report.balance3900After = after ? Number(after.balance.toFixed(2)) : null;

  if (reclose) {
    const integrity = await getPeriodIntegrityStatus(db, { entityId, periodStart, periodEnd });
    report.integrityBeforeClose = {
      isClosed: integrity.isClosed,
      canClose: integrity.canClose,
      blockers: (integrity.blockers || []).slice(0, 8),
    };
    if (integrity.canClose || integrity.isClosed) {
      try {
        // closePeriod may no-op if already closed after reopen left it open
        report.closed = await closePeriod(db, {
          entityId,
          periodStart,
          periodEnd,
          userId,
          notes: 'Re-close after OBE → Retained Earnings reclass',
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

  return report;
}

export async function previewReclassOpeningBalanceEquity(db, entityId, asOfDate = '2025-12-31') {
  const obe = await getAccountBalance(db, entityId, '3900', asOfDate);
  const re = await getAccountBalance(db, entityId, '3100', asOfDate);
  const oe = await getAccountBalance(db, entityId, '3000', asOfDate);
  return {
    asOfDate,
    account3900: obe
      ? { id: obe.id, balance: Number(obe.balance.toFixed(2)), name: obe.account_name }
      : null,
    account3100: re
      ? { id: re.id, balance: Number(re.balance.toFixed(2)), name: re.account_name }
      : null,
    account3000: oe
      ? { id: oe.id, balance: Number(oe.balance.toFixed(2)), name: oe.account_name }
      : null,
    proposed:
      obe && obe.balance.abs().gte(0.005)
        ? {
            debit: obe.balance.gt(0) ? '3900' : '3100',
            credit: obe.balance.gt(0) ? '3100' : '3900',
            amount: Number(obe.balance.abs().toFixed(2)),
          }
        : null,
  };
}
