/**
 * Hard period integrity — single source of truth for "is this month closed / closable?"
 *
 * Agents and UI must use getPeriodIntegrityStatus() (or the matching API) before
 * claiming a period is closed. Never invent close status from chat memory.
 */

import { BANK_ACCOUNTS, RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';
import { ensureBankReconSessionTables } from './bank-reconcile-session.js';
import { toCents } from './reconcile-calc.js';
import { normalizeIsoDate } from './bank-statement-view.js';
import { verifySessionClearedMatchesStatement } from './recon-cleared-integrity.js';
import { getNetIncomeTieoutStatus } from './net-income-tieout.js';

/** JE sources that are force-balance plugs — permanently blocked. */
export const PLUG_JOURNAL_SOURCES = Object.freeze([
  'reconcile-adjustment',
  'ledger-trueup',
  'opening-balance-trueup',
  'force-balance',
]);

/**
 * Descriptions that indicate a plug / force-balance / equity dump.
 * Includes bank “true-up to statement via 3900” patterns — forbidden under
 * TEN_COMMANDMENTS (no plugs; resolve real variance).
 */
const PLUG_DESCRIPTION_RE =
  /recon(ciliation)?\s+adjustment|force[- ]?balance|ledger tie-?out|statement tie-?out|opening balance (equity )?true-?up|true-?up.*opening balance|ofx ledger tie|statement true-?up|recon adjustment/i;

/** Accounts that must be ~$0 for taxReturnReady / clean close (plugs & rollups). */
export const PLUG_OR_ROLLUP_ACCOUNTS = Object.freeze([
  '1999', // Other Assets (Opening Rollup)
  '2999', // Other Liabilities (Opening Rollup) — Commandment 5: never post
  '3020', // QBO Conversion Difference
  '3900', // Opening Balance Equity (conversion plug)
  '3995', // Migration clearing
  '1100', // Undeposited Funds / conversion clearing
  '1020', // Clearing
  '1021', // Conversion clearing
]);

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
       AND gl.posting_date <= ?
       AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL`,
    [entityId, accountId, asOfDate]
  );
  return round2(row?.bal || 0);
}

/** Plug/rollup/clearing balances as of period end — all must be $0 to close. */
export async function getPlugRollupStatus(db, entityId, asOfDate) {
  const placeholders = PLUG_OR_ROLLUP_ACCOUNTS.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT a.account_number, a.account_name, a.normal_balance, a.id
     FROM accounts a
     WHERE a.entity_id = ? AND a.account_number IN (${placeholders})`,
    [entityId, ...PLUG_OR_ROLLUP_ACCOUNTS]
  );
  const accounts = [];
  const blockers = [];
  for (const a of rows || []) {
    const bal = await bookBalanceAsOf(db, entityId, a.id, asOfDate, a.normal_balance);
    const ok = Math.abs(bal) < 0.005;
    accounts.push({
      accountNumber: a.account_number,
      accountName: a.account_name,
      balance: bal,
      ok,
    });
    if (!ok) {
      blockers.push(
        `Account ${a.account_number} (${a.account_name}) balance ${bal.toFixed(2)} as of ${asOfDate} — must be $0.00 before the month is closed.`
      );
    }
  }
  // Missing plug accounts are fine (never created).
  const present = new Set((rows || []).map((r) => String(r.account_number)));
  for (const n of PLUG_OR_ROLLUP_ACCOUNTS) {
    if (!present.has(n)) {
      accounts.push({ accountNumber: n, accountName: null, balance: 0, ok: true, missing: true });
    }
  }
  return { ok: blockers.length === 0, accounts, blockers };
}

function monthBoundsLocal(dateStr) {
  const iso = normalizeIsoDate(dateStr) || String(dateStr).slice(0, 10);
  const [y, m] = iso.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return {
    periodStart: `${y}-${String(m).padStart(2, '0')}-01`,
    periodEnd: `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  };
}

/** Expand an inclusive date range into calendar-month bounds. */
export function eachMonthInRange(periodStart, periodEnd) {
  const start = normalizeIsoDate(periodStart) || String(periodStart).slice(0, 10);
  const end = normalizeIsoDate(periodEnd) || String(periodEnd).slice(0, 10);
  const months = [];
  let [y, m] = start.split('-').map(Number);
  const [endY, endM] = end.split('-').map(Number);
  while (y < endY || (y === endY && m <= endM)) {
    months.push(monthBoundsLocal(`${y}-${String(m).padStart(2, '0')}-15`));
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

/**
 * Statement date → which calendar month it covers.
 * First-of-month statements (e.g. 2026-02-01) cover the prior month (January).
 * All other dates cover their own calendar month.
 */
export function statementCoversMonth(statementDate, periodStart, periodEnd) {
  if (!statementDate || !periodStart || !periodEnd) return false;
  const iso = normalizeIsoDate(statementDate);
  const start = normalizeIsoDate(periodStart) || String(periodStart).slice(0, 10);
  const end = normalizeIsoDate(periodEnd) || String(periodEnd).slice(0, 10);
  if (!iso) return false;
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return false;

  let coverY = y;
  let coverM = m;
  if (d === 1) {
    coverM -= 1;
    if (coverM < 1) {
      coverM = 12;
      coverY -= 1;
    }
  }

  const coverStart = `${coverY}-${String(coverM).padStart(2, '0')}-01`;
  const lastDay = new Date(coverY, coverM, 0).getDate();
  const coverEnd = `${coverY}-${String(coverM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return coverStart === start && coverEnd === end;
}

/**
 * Account numbers that must be reconciled before a period can close.
 * @param {string} entityId
 * @param {{ periodStart?: string }} [opts] — when set, skip accounts whose
 *   `monitorThrough` (YYYY-MM) is before that period's month (closed banks).
 */
export function monitoredAccountNumbers(entityId, { periodStart } = {}) {
  const periodMonth = periodStart
    ? String(normalizeIsoDate(periodStart) || periodStart).slice(0, 7)
    : null;
  const bankRows = BANK_ACCOUNTS[entityId] || [];
  const byNumber = new Map(bankRows.map((r) => [String(r.accountNumber), r]));

  const stillMonitored = (accountNumber) => {
    const meta = byNumber.get(String(accountNumber));
    const through = meta?.monitorThrough ? String(meta.monitorThrough).slice(0, 7) : null;
    if (through && periodMonth && periodMonth > through) return false;
    return true;
  };

  const nums = new Set();
  for (const row of bankRows) {
    if (!row.accountNumber) continue;
    if (!stillMonitored(row.accountNumber)) continue;
    nums.add(String(row.accountNumber));
  }
  const targets = RECONCILIATION_TARGETS[entityId] || {};
  for (const accountNumber of Object.keys(targets)) {
    if (!stillMonitored(accountNumber)) continue;
    nums.add(String(accountNumber));
  }
  return [...nums].sort();
}

export async function resolveMonitoredAccounts(db, entityId, { periodStart } = {}) {
  const numbers = monitoredAccountNumbers(entityId, { periodStart });
  if (!numbers.length) return [];

  const placeholders = numbers.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT id, account_number, account_name, account_type, normal_balance, is_active
     FROM accounts
     WHERE entity_id = ? AND account_number IN (${placeholders})
     ORDER BY account_number`,
    [entityId, ...numbers]
  );
  return (rows || []).filter((r) => r.is_active == null || Number(r.is_active) === 1);
}

/**
 * Find a recon session whose statement date covers the calendar month.
 * Used by period integrity and Monthly Books (so OPEN sessions stay clickable
 * even when RECONCILIATION_TARGETS has no row yet).
 */
export async function findCoveringSession(db, entityId, accountId, periodStart, periodEnd) {
  const sessions = await db.all(
    `SELECT id, statement_date, status, difference, beginning_balance, ending_balance, cleared_net, closed_at
     FROM bank_reconciliation_sessions
     WHERE entity_id = ? AND account_id = ?
     ORDER BY statement_date ASC`,
    [entityId, accountId]
  );

  const covering = (sessions || []).filter((s) =>
    statementCoversMonth(s.statement_date, periodStart, periodEnd)
  );
  if (!covering.length) return null;

  // Prefer a balanced CLOSED session; otherwise return the best candidate for diagnostics.
  const balancedClosed = covering.find(
    (s) => s.status === 'CLOSED' && toCents(s.difference) === 0
  );
  return balancedClosed || covering[covering.length - 1];
}

async function ensureJournalSourceColumn(db) {
  try {
    await db.run('ALTER TABLE journal_entries ADD COLUMN source TEXT');
  } catch (e) {
    if (!/duplicate column|already exists/i.test(e.message || '')) {
      // Column may already exist or dialect differs — probe below
    }
  }
}

async function journalEntriesHaveSource(db) {
  try {
    await db.all('SELECT source FROM journal_entries LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

async function findPlugJournalsInPeriod(db, entityId, periodStart, periodEnd) {
  await ensureJournalSourceColumn(db);
  const hasSource = await journalEntriesHaveSource(db);
  const seen = new Set();
  const plugs = [];

  if (hasSource) {
    const sourcePlaceholders = PLUG_JOURNAL_SOURCES.map(() => '?').join(',');
    const bySource = await db.all(
      `SELECT id, je_number, posting_date, description, source, status
       FROM journal_entries
       WHERE entity_id = ?
         AND posting_date >= ? AND posting_date <= ?
         AND source IN (${sourcePlaceholders})
       ORDER BY posting_date, je_number`,
      [entityId, periodStart, periodEnd, ...PLUG_JOURNAL_SOURCES]
    );
    for (const row of bySource || []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      plugs.push(row);
    }
  }

  const byDesc = await db.all(
    `SELECT id, je_number, posting_date, description, status
            ${hasSource ? ', source' : ''}
     FROM journal_entries
     WHERE entity_id = ?
       AND posting_date >= ? AND posting_date <= ?
       AND (
         LOWER(COALESCE(description, '')) LIKE '%recon%adjustment%'
         OR LOWER(COALESCE(description, '')) LIKE '%reconciliation adjustment%'
       )
     ORDER BY posting_date, je_number`,
    [entityId, periodStart, periodEnd]
  );

  for (const row of byDesc || []) {
    if (seen.has(row.id)) continue;
    if (!PLUG_DESCRIPTION_RE.test(row.description || '')) continue;
    seen.add(row.id);
    plugs.push({ ...row, source: row.source || null });
  }
  return plugs;
}

async function accountIssue(db, entityId, account, session) {
  if (!session) {
    return {
      code: 'MISSING_RECONCILIATION',
      message: `Account ${account.account_number} (${account.account_name}) has no bank reconciliation covering this month.`,
    };
  }
  if (session.status !== 'CLOSED') {
    return {
      code: 'RECON_OPEN',
      message: `Account ${account.account_number} reconciliation for ${session.statement_date} is still OPEN (difference ${Number(session.difference).toFixed(2)}).`,
    };
  }
  const live = await verifySessionClearedMatchesStatement(db, session, account);
  if (live.issue) return live.issue;

  // Fake empty close: CLOSED with $0 difference but zero session lines while the
  // register still has uncleared posted activity through the statement date.
  const lineCountRow = await db.get(
    `SELECT COUNT(*) AS n FROM bank_reconciliation_session_lines WHERE session_id = ?`,
    [session.id]
  );
  const sessionLineCount = Number(lineCountRow?.n || 0);
  if (sessionLineCount === 0) {
    const stmtDate = normalizeIsoDate(session.statement_date) || String(session.statement_date).slice(0, 10);
    const prior = await db.get(
      `SELECT statement_date FROM bank_reconciliation_sessions
       WHERE entity_id = ? AND account_id = ? AND status = 'CLOSED'
         AND statement_date < ? AND ABS(COALESCE(difference, 0)) < 0.01
       ORDER BY statement_date DESC LIMIT 1`,
      [entityId, account.id, stmtDate]
    );
    const priorIso = prior ? normalizeIsoDate(prior.statement_date) : null;
    const uncParams = [entityId, account.id, stmtDate];
    let uncSql = `
      SELECT COUNT(*) AS n
      FROM general_ledger gl
      JOIN journal_entries je ON je.id = gl.journal_entry_id
      WHERE gl.entity_id = ? AND gl.account_id = ?
        AND gl.reconciliation_status IS NULL
        AND je.status = 'POSTED'
        AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
        AND je.je_number NOT LIKE 'OB-%'
        AND gl.posting_date <= ?`;
    if (priorIso) {
      uncSql += ' AND gl.posting_date > ?';
      uncParams.push(priorIso);
    }
    const unc = await db.get(uncSql, uncParams);
    if (Number(unc?.n || 0) > 0) {
      return {
        code: 'FAKE_EMPTY_RECON',
        message:
          `Account ${account.account_number} (${account.account_name}): reconciliation is CLOSED with 0 cleared lines but ${unc.n} uncleared posted line(s) remain through ${stmtDate}. That is not reconciled — reopen and clear the real register.`,
        unclearedCount: Number(unc.n),
        statementDate: stmtDate,
      };
    }
  }

  // Hard bar: books as of the statement date must equal the statement ending.
  // A session can show Cleared = statement while other register lines through that
  // date were left out — that is NOT reconciled to $0 for close purposes.
  const stmtDate = normalizeIsoDate(session.statement_date) || String(session.statement_date).slice(0, 10);
  const stmtEnd = round2(session.ending_balance);
  const bookBal = await bookBalanceAsOf(
    db,
    entityId,
    account.id,
    stmtDate,
    account.normal_balance
  );
  if (toCents(bookBal) !== toCents(stmtEnd)) {
    return {
      code: 'BOOK_NE_STATEMENT',
      message:
        `Account ${account.account_number} (${account.account_name}): books as of ${stmtDate} are ${bookBal.toFixed(2)} but statement ending is ${stmtEnd.toFixed(2)}. ` +
        `Every register line through the statement date must be cleared in the recon — difference must be $0.00 with no leftovers.`,
      bookBalance: bookBal,
      statementEnding: stmtEnd,
      statementDate: stmtDate,
    };
  }
  return null;
}

/**
 * Authoritative integrity payload for one calendar month (or explicit range).
 * Use this — not chat memory — before saying a period is closed.
 */
export async function getPeriodIntegrityStatus(db, {
  entityId,
  periodStart,
  periodEnd,
  postingDate = null,
}) {
  await ensureBankReconSessionTables(db);

  let start = periodStart;
  let end = periodEnd;
  if ((!start || !end) && postingDate) {
    const bounds = monthBoundsLocal(postingDate);
    start = bounds.periodStart;
    end = bounds.periodEnd;
  }
  if (!start || !end) {
    throw new Error('periodStart and periodEnd (or postingDate) required');
  }

  const periodRow = await db.get(
    `SELECT id, status, closed_by, closed_at, notes
     FROM accounting_periods
     WHERE entity_id = ? AND period_start = ? AND period_end = ?`,
    [entityId, start, end]
  );

  const dbStatus = periodRow?.status === 'CLOSED' ? 'CLOSED' : 'OPEN';
  // Use the first month in range so closed banks (monitorThrough) drop off after their last month.
  const accounts = await resolveMonitoredAccounts(db, entityId, { periodStart: start });
  const months = eachMonthInRange(start, end);
  const accountResults = [];
  const blockers = [];

  for (const account of accounts) {
    const monthResults = [];
    let accountOk = true;
    let primarySession = null;
    let primaryIssue = null;

    for (const month of months) {
      const session = await findCoveringSession(
        db,
        entityId,
        account.id,
        month.periodStart,
        month.periodEnd
      );
      const issue = await accountIssue(db, entityId, account, session);
      const liveBalanced = !issue && session?.status === 'CLOSED';
      monthResults.push({
        periodStart: month.periodStart,
        periodEnd: month.periodEnd,
        ok: !issue,
        session: session
          ? {
              id: session.id,
              statementDate: session.statement_date,
              status: session.status,
              difference: Number(session.difference),
              differenceCents: toCents(session.difference),
              endingBalance: Number(session.ending_balance),
              balanced: liveBalanced,
              closedAt: session.closed_at || null,
            }
          : null,
        issue: issue || null,
      });
      if (issue) {
        accountOk = false;
        if (!primaryIssue) {
          primaryIssue = {
            ...issue,
            message: months.length > 1
              ? `${month.periodStart.slice(0, 7)}: ${issue.message}`
              : issue.message,
          };
        }
        blockers.push(
          months.length > 1
            ? `${account.account_number} ${month.periodStart.slice(0, 7)}: ${issue.message}`
            : issue.message
        );
      } else if (!primarySession && session) {
        primarySession = session;
      }
    }

    const row = {
      accountId: account.id,
      accountNumber: account.account_number,
      accountName: account.account_name,
      ok: accountOk,
      session: primarySession
        ? {
            id: primarySession.id,
            statementDate: primarySession.statement_date,
            status: primarySession.status,
            difference: Number(primarySession.difference),
            differenceCents: toCents(primarySession.difference),
            endingBalance: Number(primarySession.ending_balance),
            balanced: accountOk && primarySession.status === 'CLOSED',
            closedAt: primarySession.closed_at || null,
          }
        : monthResults.length === 1
          ? null
          : null,
      months: months.length > 1 ? monthResults : undefined,
      issue: primaryIssue,
    };
    accountResults.push(row);
  }

  const plugJournals = await findPlugJournalsInPeriod(db, entityId, start, end);
  const plugsBlocked = plugJournals.length > 0;
  if (plugsBlocked) {
    blockers.push(
      `Period contains ${plugJournals.length} plug / reconcile-adjustment journal(s). Plugs are prohibited — reverse them and fix the real variance.`
    );
  }

  // Plug / rollup / clearing accounts must be $0 — leftover 3900 etc. means NOT closed.
  const plugRollups = await getPlugRollupStatus(db, entityId, end);
  const plugsOrRollupsOk = plugRollups.ok === true;
  if (!plugsOrRollupsOk) {
    for (const b of plugRollups.blockers) blockers.push(b);
  }

  // BS Net Income / Current Year Earnings must equal calendar YTD P&L.
  // Prior-year P&L left open in revenue/expense accounts fails this gate.
  const netIncomeTieout = await getNetIncomeTieoutStatus(db, entityId, end);
  const netIncomeTieoutOk = netIncomeTieout.ok === true;
  if (!netIncomeTieoutOk) {
    for (const b of netIncomeTieout.blockers) blockers.push(b);
  }

  const reconciliationsOk = accountResults.every((a) => a.ok);
  const canClose =
    reconciliationsOk && !plugsBlocked && plugsOrRollupsOk && netIncomeTieoutOk;
  // Authoritative "closed" for humans/agents: DB says CLOSED AND integrity still holds.
  // Exceptions (BOOK_NE_STATEMENT, non-zero 3900, etc.) mean isClosed is false.
  const reliablyClosed = dbStatus === 'CLOSED' && canClose;
  const closedButCompromised = dbStatus === 'CLOSED' && !canClose;

  return {
    entityId,
    periodStart: start,
    periodEnd: end,
    checkedAt: new Date().toISOString(),
    databasePeriodStatus: dbStatus,
    periodId: periodRow?.id || null,
    closedBy: periodRow?.closed_by || null,
    closedAt: periodRow?.closed_at || null,
    /** Only true when DB is CLOSED and every hard gate still passes — no exceptions. */
    isClosed: reliablyClosed,
    /** True only when close would be allowed right now. */
    canClose,
    closedButCompromised,
    reconciliationsOk,
    plugsBlocked,
    plugsOrRollupsOk,
    plugRollupAccounts: plugRollups.accounts,
    netIncomeTieoutOk,
    netIncomeTieout: {
      yearStart: netIncomeTieout.yearStart,
      currentYearEarnings: netIncomeTieout.currentYearEarnings,
      priorYearPnl: netIncomeTieout.priorYearPnl?.netIncome,
      priorYearPlClosed: netIncomeTieout.priorYearPlClosed,
      expectedBalanceSheetNetIncome: netIncomeTieout.expectedBalanceSheetNetIncome,
    },
    plugJournals: plugJournals.map((j) => ({
      id: j.id,
      jeNumber: j.je_number,
      postingDate: j.posting_date,
      description: j.description,
      source: j.source,
      status: j.status,
    })),
    accounts: accountResults,
    blockers,
    agentRule:
      'Do not tell Jerry a period is closed unless isClosed===true. Exceptions (BOOK_NE_STATEMENT, non-zero plug/rollup accounts, open recons, NI mismatch) mean NOT closed. Do not invent status.',
  };
}

export async function assertPeriodCloseable(db, { entityId, periodStart, periodEnd }) {
  const status = await getPeriodIntegrityStatus(db, { entityId, periodStart, periodEnd });
  if (status.canClose) return status;

  const detail = status.blockers.length
    ? status.blockers.join(' | ')
    : 'Period integrity checks failed.';
  const err = new Error(`Cannot close period ${periodStart}–${periodEnd}: ${detail}`);
  err.code = 'PERIOD_INTEGRITY_BLOCKED';
  err.integrity = status;
  throw err;
}

/** Reject plug journal sources at create/post time. */
export function assertNotPlugJournal({ source, description } = {}) {
  if (source && PLUG_JOURNAL_SOURCES.includes(String(source))) {
    const err = new Error(
      'Hard rule: reconcile-adjustment / plug journal entries are permanently disabled. Resolve the real variance; do not force-balance.'
    );
    err.code = 'PLUG_ENTRY_BLOCKED';
    throw err;
  }
  if (description && PLUG_DESCRIPTION_RE.test(description)) {
    const err = new Error(
      'Hard rule: journal descriptions that create reconciliation plug entries are blocked.'
    );
    err.code = 'PLUG_ENTRY_BLOCKED';
    throw err;
  }
}
