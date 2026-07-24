/**
 * Cutover-year close for entities that migrated from QBO with opening balances
 * on 1/1 of the next year (no in-app bank activity in the prior calendar year).
 *
 * Steps:
 * 1. Post CLOSED $0.00 reconciliations for each monitored account × each month
 *    when the books are already at $0 for that month (nothing to clear).
 * 2. Post year-end close (P&L → retained earnings).
 * 3. Close the annual accounting period (integrity hard bar).
 */
import { v4 as uuidv4 } from 'uuid';
import { ensureBankReconSessionTables, getSessionForPeriod } from './bank-reconcile-session.js';
import { eachMonthInRange, resolveMonitoredAccounts, getPeriodIntegrityStatus } from './period-integrity.js';
import { postYearEndClose, previewYearEndClose } from './year-end-close.js';
import { closePeriod } from './period-lock.js';
import { checkSuspenseAccounts } from './suspense-check.js';
import { toCents } from './reconcile-calc.js';

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

async function bookBalanceAsOf(db, entityId, accountId, asOfDate, normalBalance) {
  const expr = normalBalance === 'CREDIT' ? '(gl.credit - gl.debit)' : '(gl.debit - gl.credit)';
  const row = await db.get(
    `SELECT COALESCE(SUM(${expr}), 0) AS bal
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id AND je.status = 'POSTED'
     WHERE gl.entity_id = ? AND gl.account_id = ?
       AND gl.posting_date <= ?`,
    [entityId, accountId, asOfDate]
  );
  return round2(row?.bal || 0);
}

/**
 * Document a dormant cutover month: books at $0, no register activity to clear.
 * Inserts a CLOSED session directly (avoids bundled-statement beginning-balance
 * contamination from later-year statement JSON).
 */
async function closeDormantZeroMonth(db, {
  entityId,
  account,
  statementDate,
  userId,
  notes,
}) {
  const normal =
    account.normal_balance || (account.account_type === 'LIABILITY' ? 'CREDIT' : 'DEBIT');
  const bookBal = await bookBalanceAsOf(db, entityId, account.id, statementDate, normal);

  if (toCents(bookBal) !== 0) {
    return {
      accountNumber: account.account_number,
      statementDate,
      reconciled: false,
      reason: `book balance as of ${statementDate} is ${bookBal} (expected $0.00 for dormant cutover month)`,
    };
  }

  const existing = await getSessionForPeriod(db, entityId, account.id, statementDate);
  if (existing?.status === 'CLOSED' && toCents(existing.difference) === 0) {
    return {
      accountNumber: account.account_number,
      statementDate,
      reconciled: true,
      skipped: true,
      sessionId: existing.id,
      endingBalance: 0,
    };
  }

  const sessionId = existing?.id || `brs-${uuidv4()}`;
  const noteText =
    notes ||
    `Cutover ${statementDate.slice(0, 7)}: dormant month — books $0.00, no register activity`;

  if (existing) {
    await db.run(
      `UPDATE bank_reconciliation_sessions
       SET beginning_balance = 0, ending_balance = 0, cleared_net = 0, difference = 0,
           status = 'CLOSED', notes = ?, closed_at = CURRENT_TIMESTAMP, created_by = COALESCE(created_by, ?)
       WHERE id = ?`,
      [noteText, userId, sessionId]
    );
  } else {
    await db.run(
      `INSERT INTO bank_reconciliation_sessions
       (id, entity_id, account_id, statement_date, beginning_balance, ending_balance,
        cleared_net, difference, status, notes, created_by, closed_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0, 'CLOSED', ?, ?, CURRENT_TIMESTAMP)`,
      [sessionId, entityId, account.id, statementDate, noteText, userId]
    );
  }

  return {
    accountNumber: account.account_number,
    statementDate,
    reconciled: true,
    skipped: false,
    sessionId,
    endingBalance: 0,
  };
}

/**
 * @param {object} db
 * @param {{ entityId: string, year: number, userId: string, memo?: string }} opts
 */
export async function runCutoverYearClose(db, { entityId, year, userId, memo }) {
  const y = Number(year);
  if (!y || y < 2000 || y > 2100) throw new Error('Valid year required');

  const periodStart = `${y}-01-01`;
  const periodEnd = `${y}-12-31`;
  const asOfDate = periodEnd;

  await ensureBankReconSessionTables(db);

  const suspense = await checkSuspenseAccounts(db, entityId, asOfDate);
  if (!suspense.clean) {
    const err = new Error(
      `Cannot close ${y}: $${suspense.totalAbs} stranded in suspense/clearing. Resolve before close.`
    );
    err.code = 'SUSPENSE_BLOCKED';
    err.suspense = suspense;
    throw err;
  }

  const accounts = await resolveMonitoredAccounts(db, entityId);
  if (!accounts.length) {
    throw new Error('No monitored bank/card accounts configured for this entity');
  }

  const enriched = [];
  for (const a of accounts) {
    const full = await db.get(
      `SELECT id, account_number, account_name, account_type, normal_balance, is_active
       FROM accounts WHERE id = ?`,
      [a.id]
    );
    enriched.push(full || a);
  }

  const months = eachMonthInRange(periodStart, periodEnd);
  const reconciliations = [];
  for (const month of months) {
    for (const account of enriched) {
      const r = await closeDormantZeroMonth(db, {
        entityId,
        account,
        statementDate: month.periodEnd,
        userId,
        notes: `Cutover year-close ${y} — ${account.account_number} ${month.periodStart.slice(0, 7)}`,
      });
      reconciliations.push(r);
      if (!r.reconciled) {
        const err = new Error(
          `Cannot auto-reconcile ${r.accountNumber} ${r.statementDate}: ${r.reason}. Fix the real variance — no plugs.`
        );
        err.code = 'RECON_BLOCKED';
        err.detail = r;
        throw err;
      }
    }
  }

  const yePreview = await previewYearEndClose(db, entityId, asOfDate);
  let yearEnd = { posted: false, message: 'No income/expense to close' };
  try {
    yearEnd = await postYearEndClose(db, {
      entityId,
      asOfDate,
      userId,
      memo: memo || `Year-end close ${y} (cutover)`,
    });
  } catch (e) {
    // Only treat a prior YEC as idempotent success; rethrow everything else.
    if (/already posted/i.test(e.message || '')) {
      yearEnd = { posted: false, message: e.message, alreadyPosted: true, ...yePreview };
    } else {
      throw e;
    }
  }

  const period = await closePeriod(db, {
    entityId,
    periodStart,
    periodEnd,
    userId,
    notes: memo || `${y} closed — cutover year; monitored recons $0.00; YEC posted`,
  });

  const integrity = await getPeriodIntegrityStatus(db, {
    entityId,
    periodStart,
    periodEnd,
  });

  return {
    entityId,
    year: y,
    periodStart,
    periodEnd,
    suspense,
    reconciliations,
    yearEnd,
    period,
    integrity,
    isClosed: integrity.isClosed === true,
  };
}
