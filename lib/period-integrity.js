/**
 * Hard period integrity — single source of truth for "is this month closed / closable?"
 *
 * Agents and UI must use getPeriodIntegrityStatus() (or the matching API) before
 * claiming a period is closed. Never invent close status from chat memory.
 */

import { BANK_ACCOUNTS, RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';
import { ensureBankReconSessionTables } from './bank-reconcile-session.js';
import { toCents } from './reconcile-calc.js';

/** JE sources that are force-balance plugs — permanently blocked. */
export const PLUG_JOURNAL_SOURCES = Object.freeze([
  'reconcile-adjustment',
]);

const PLUG_DESCRIPTION_RE = /recon(ciliation)?\s+adjustment/i;

function monthBoundsLocal(dateStr) {
  const [y, m] = String(dateStr).slice(0, 10).split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return {
    periodStart: `${y}-${String(m).padStart(2, '0')}-01`,
    periodEnd: `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  };
}

/** Expand an inclusive date range into calendar-month bounds. */
export function eachMonthInRange(periodStart, periodEnd) {
  const start = String(periodStart).slice(0, 10);
  const end = String(periodEnd).slice(0, 10);
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
  const [y, m, d] = String(statementDate).slice(0, 10).split('-').map(Number);
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
  return coverStart === periodStart && coverEnd === periodEnd;
}

/** Account numbers that must be reconciled before a period can close. */
export function monitoredAccountNumbers(entityId) {
  const nums = new Set();
  for (const row of BANK_ACCOUNTS[entityId] || []) {
    if (row.accountNumber) nums.add(String(row.accountNumber));
  }
  const targets = RECONCILIATION_TARGETS[entityId] || {};
  for (const accountNumber of Object.keys(targets)) {
    nums.add(String(accountNumber));
  }
  return [...nums].sort();
}

export async function resolveMonitoredAccounts(db, entityId) {
  const numbers = monitoredAccountNumbers(entityId);
  if (!numbers.length) return [];

  const placeholders = numbers.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT id, account_number, account_name, account_type, is_active
     FROM accounts
     WHERE entity_id = ? AND account_number IN (${placeholders})
     ORDER BY account_number`,
    [entityId, ...numbers]
  );
  return (rows || []).filter((r) => r.is_active == null || Number(r.is_active) === 1);
}

async function findCoveringSession(db, entityId, accountId, periodStart, periodEnd) {
  const sessions = await db.all(
    `SELECT id, statement_date, status, difference, ending_balance, cleared_net, closed_at
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

function accountIssue(account, session) {
  if (!session) {
    return {
      code: 'MISSING_RECONCILIATION',
      message: `Account ${account.account_number} (${account.account_name}) has no bank reconciliation covering this month.`,
    };
  }
  const diffCents = toCents(session.difference);
  if (session.status !== 'CLOSED') {
    return {
      code: 'RECON_OPEN',
      message: `Account ${account.account_number} reconciliation for ${session.statement_date} is still OPEN (difference ${Number(session.difference).toFixed(2)}).`,
    };
  }
  if (diffCents !== 0) {
    return {
      code: 'RECON_OFF_PENNY',
      message: `Account ${account.account_number} reconciliation for ${session.statement_date} is CLOSED but off by ${Number(session.difference).toFixed(2)} (must be $0.00).`,
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
  const accounts = await resolveMonitoredAccounts(db, entityId);
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
      const issue = accountIssue(account, session);
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
              balanced: session.status === 'CLOSED' && toCents(session.difference) === 0,
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
            balanced:
              primarySession.status === 'CLOSED' && toCents(primarySession.difference) === 0,
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

  const reconciliationsOk = accountResults.every((a) => a.ok);
  const canClose = reconciliationsOk && !plugsBlocked;
  // Authoritative "closed" for humans/agents: DB says CLOSED AND integrity still holds.
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
    /** Only true when DB is CLOSED and every hard gate still passes. */
    isClosed: reliablyClosed,
    /** True only when close would be allowed right now. */
    canClose,
    closedButCompromised,
    reconciliationsOk,
    plugsBlocked,
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
      'Do not tell Jerry a period is closed unless isClosed===true from this payload. Do not invent status.',
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
