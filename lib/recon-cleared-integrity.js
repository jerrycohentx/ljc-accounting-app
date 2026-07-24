/**
 * Hard recon integrity: Cleared Balance must equal statement ending balance.
 * Uses only GL lines locked to the closed session (not orphan RECONCILED rows).
 */

import { toCents, fromCents } from './reconcile-calc.js';
import { normalizeIsoDate } from './bank-statement-view.js';

function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return NaN;
  return Math.round(v * 100) / 100;
}

function signedCents(debit, credit, normalBalance) {
  const d = toCents(debit || 0);
  const c = toCents(credit || 0);
  return normalBalance === 'CREDIT' ? c - d : d - c;
}

function sessionStatementIso(session) {
  return normalizeIsoDate(session?.statement_date) || null;
}

/**
 * Recompute cleared balance from session_lines + beginning_balance.
 * @returns {{ ok: boolean, clearedBalance: number, statementEnding: number, difference: number, lineCount: number, issue?: object }}
 */
export async function verifySessionClearedMatchesStatement(db, session, account) {
  if (!session || session.status !== 'CLOSED') {
    return {
      ok: false,
      clearedBalance: null,
      statementEnding: null,
      difference: null,
      lineCount: 0,
      issue: {
        code: 'RECON_OPEN',
        message: `Account ${account.account_number} reconciliation is not CLOSED.`,
      },
    };
  }

  const statementIso = sessionStatementIso(session);
  const beginning = round2(session.beginning_balance);
  const statementEnding = round2(session.ending_balance);
  const storedDiffCents = toCents(session.difference);

  if (!Number.isFinite(beginning) || !Number.isFinite(statementEnding)) {
    return {
      ok: false,
      clearedBalance: null,
      statementEnding: Number.isFinite(statementEnding) ? statementEnding : null,
      difference: null,
      lineCount: 0,
      issue: {
        code: 'RECON_BALANCES_MISSING',
        message:
          `Account ${account.account_number} closed recon ${statementIso || '?'} is missing beginning/ending balance ` +
          `(beginning=${session.beginning_balance}, ending=${session.ending_balance}).`,
      },
    };
  }

  const lines = await db.all(
    `SELECT gl.id, gl.debit, gl.credit
     FROM bank_reconciliation_session_lines sl
     JOIN general_ledger gl ON gl.id = sl.gl_id
     WHERE sl.session_id = ?`,
    [session.id]
  );

  let clearedNetCents = 0;
  for (const row of lines || []) {
    clearedNetCents += signedCents(row.debit, row.credit, account.normal_balance);
  }
  const clearedBalance = fromCents(toCents(beginning) + clearedNetCents);
  const liveDiffCents = toCents(statementEnding) - toCents(clearedBalance);

  if (storedDiffCents !== 0) {
    return {
      ok: false,
      clearedBalance,
      statementEnding,
      difference: fromCents(storedDiffCents),
      lineCount: (lines || []).length,
      issue: {
        code: 'RECON_OFF_PENNY',
        message: `Account ${account.account_number} reconciliation for ${statementIso} is CLOSED but stored difference is ${fromCents(storedDiffCents).toFixed(2)} (must be $0.00).`,
      },
    };
  }

  if (liveDiffCents !== 0) {
    return {
      ok: false,
      clearedBalance,
      statementEnding,
      difference: fromCents(liveDiffCents),
      lineCount: (lines || []).length,
      issue: {
        code: 'CLEARED_NE_STATEMENT',
        message:
          `Account ${account.account_number} (${account.account_name}) statement ${statementIso}: ` +
          `Cleared Balance ${clearedBalance.toFixed(2)} ≠ statement ending ${statementEnding.toFixed(2)} ` +
          `(difference ${fromCents(liveDiffCents).toFixed(2)}). Hard rule: cleared must equal bank.`,
      },
    };
  }

  return {
    ok: true,
    clearedBalance,
    statementEnding,
    difference: 0,
    lineCount: (lines || []).length,
    issue: null,
  };
}

/**
 * Orphan RECONCILED rows (no session_id) inside a closed statement period inflate
 * recon reports and break Cleared≠Statement. Unmark them so only session-locked
 * lines count as cleared for that period.
 */
export async function repairOrphanReconciledInClosedPeriods(db, { entityId, accountId = null } = {}) {
  const sessions = await db.all(
    `SELECT id, account_id, statement_date, beginning_balance, ending_balance
     FROM bank_reconciliation_sessions
     WHERE entity_id = ? AND status = 'CLOSED' AND ABS(COALESCE(difference, 0)) < 0.005
     ${accountId ? 'AND account_id = ?' : ''}
     ORDER BY statement_date`,
    accountId ? [entityId, accountId] : [entityId]
  );

  const repairs = [];
  for (const session of sessions || []) {
    const statementDate = normalizeIsoDate(session.statement_date);
    if (!statementDate) continue;
    const periodStart = `${statementDate.slice(0, 7)}-01`;
    const result = await db.run(
      `UPDATE general_ledger
       SET reconciliation_status = NULL, reconciliation_session_id = NULL
       WHERE entity_id = ?
         AND account_id = ?
         AND reconciliation_status = 'RECONCILED'
         AND reconciliation_session_id IS NULL
         AND posting_date >= ?
         AND posting_date <= ?`,
      [entityId, session.account_id, periodStart, statementDate]
    );
    const changes = result?.changes ?? result?.rowCount ?? 0;
    if (changes > 0) {
      repairs.push({
        sessionId: session.id,
        accountId: session.account_id,
        statementDate,
        unmarked: changes,
      });
    }
  }
  return { entityId, repairs, unmarkedTotal: repairs.reduce((s, r) => s + r.unmarked, 0) };
}
