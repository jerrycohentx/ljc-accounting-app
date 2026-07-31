/**
 * Plain-English monthly books workflow status for Jerry's 4-step process:
 * 1. Downloads (automatic)
 * 2. Check categories (occasional review)
 * 3. Reconcile accounts (when statements arrive)
 * 4. Month verified (all recons closed + period integrity)
 */
import { BANK_ACCOUNTS, RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';
import { monthBounds } from './period-lock.js';
import { buildCategorizationReview } from './categorization-review.js';
import {
  getPeriodIntegrityStatus,
  resolveMonitoredAccounts,
} from './period-integrity.js';
import { ensureBankReconSessionTables, getSessionForPeriod } from './bank-reconcile-session.js';
import { verifySessionClearedMatchesStatement } from './recon-cleared-integrity.js';
import { toCents } from './reconcile-calc.js';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function monthLabel(year, month) {
  const m = Number(month);
  const y = Number(year);
  if (!Number.isFinite(m) || m < 1 || m > 12) return 'Unknown month';
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function friendlyAccountName(entityId, accountNumber, fallbackName) {
  const rows = BANK_ACCOUNTS[entityId] || [];
  const hit = rows.find((r) => String(r.accountNumber) === String(accountNumber));
  return hit?.name || fallbackName || `Account ${accountNumber}`;
}

/** Find the statement target row for a calendar month (e.g. 2026-01 → "January 2026"). */
function findStatementTarget(entityId, accountNumber, year, month) {
  const label = monthLabel(year, month);
  const list = (RECONCILIATION_TARGETS[entityId] || {})[String(accountNumber)] || [];
  return list.find((t) => {
    const l = String(t.label || '').trim();
    return l === label || l.startsWith(`${label} `) || l.startsWith(`${label}—`);
  }) || null;
}

async function reconAccountStatus(db, entityId, account, year, month, periodStart, periodEnd) {
  const target = findStatementTarget(entityId, account.account_number, year, month);
  const displayName = friendlyAccountName(entityId, account.account_number, account.account_name);

  if (!target) {
    return {
      accountId: account.id,
      accountNumber: account.account_number,
      name: displayName,
      status: 'no_statement',
      statusLabel: 'No statement on file yet',
      statementDate: null,
      difference: null,
    };
  }

  await ensureBankReconSessionTables(db);
  const session = await getSessionForPeriod(db, entityId, account.id, target.statementDate);

  if (!session) {
    return {
      accountId: account.id,
      accountNumber: account.account_number,
      name: displayName,
      status: 'not_started',
      statusLabel: 'Ready to reconcile',
      statementDate: target.statementDate,
      statementLabel: target.label,
      endingBalance: target.endingBalance,
      difference: null,
    };
  }

  let balanced = session.status === 'CLOSED' && toCents(session.difference) === 0;
  if (session.status === 'CLOSED') {
    try {
      // Signature is (db, sessionRow, accountRow) — must pass full rows with
      // beginning/ending balances and normal_balance for the live clear check.
      const live = await verifySessionClearedMatchesStatement(db, session, account);
      balanced = !!live?.ok;
    } catch {
      balanced = false;
    }
  }

  if (balanced) {
    return {
      accountId: account.id,
      accountNumber: account.account_number,
      name: displayName,
      status: 'closed',
      statusLabel: 'Reconciled',
      statementDate: session.statement_date || target.statementDate,
      statementLabel: target.label,
      difference: 0,
    };
  }

  const diff = Number(session.difference) || 0;
  return {
    accountId: account.id,
    accountNumber: account.account_number,
    name: displayName,
    status: session.status === 'CLOSED' ? 'needs_fix' : 'in_progress',
    statusLabel: session.status === 'CLOSED'
      ? 'Marked closed but out of balance — reopen'
      : (Math.abs(diff) < 0.005 ? 'In progress' : `Difference ${diff.toFixed(2)}`),
    statementDate: session.statement_date || target.statementDate,
    statementLabel: target.label,
    difference: diff,
  };
}

/**
 * @param {object} db
 * @param {{ entityId: string, year: number|string, month: number|string }} opts
 */
export async function getMonthlyBooksStatus(db, { entityId, year, month }) {
  const y = Number(year);
  const m = Number(month);
  if (!entityId) throw new Error('entityId required');
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    throw new Error('Valid year and month (1–12) required');
  }

  const monthKey = `${y}-${String(m).padStart(2, '0')}`;
  const { periodStart, periodEnd } = monthBounds(`${monthKey}-15`);
  const label = monthLabel(y, m);

  const downloadRow = await db.get(
    `SELECT COUNT(*) AS n FROM import_transactions
     WHERE entity_id = ? AND date >= ? AND date <= ?`,
    [entityId, periodStart, periodEnd]
  );

  const review = await buildCategorizationReview(db, { entityId, limit: 5000 });
  let monthCategoryCount = 0;
  for (const feed of review.feeds || []) {
    for (const mo of feed.months || []) {
      if (mo.key === monthKey) monthCategoryCount += mo.count || 0;
    }
  }

  const monitored = await resolveMonitoredAccounts(db, entityId, { periodStart });
  const reconAccounts = [];
  for (const acct of monitored) {
    reconAccounts.push(await reconAccountStatus(db, entityId, acct, y, m, periodStart, periodEnd));
  }

  const allReconClosed = reconAccounts.length > 0
    && reconAccounts.every((a) => a.status === 'closed' || a.status === 'no_statement');
  const anyReconStarted = reconAccounts.some((a) =>
    a.status === 'closed' || a.status === 'in_progress' || a.status === 'needs_fix'
  );

  const integrity = await getPeriodIntegrityStatus(db, { entityId, periodStart, periodEnd });

  return {
    entityId,
    year: y,
    month: m,
    monthKey,
    monthLabel: label,
    periodStart,
    periodEnd,
    steps: {
      downloads: {
        key: 'downloads',
        title: 'Bank & card activity downloaded',
        status: 'automatic',
        statusLabel: 'Automatic throughout the month',
        detail: downloadRow?.n
          ? `${downloadRow.n} transaction${downloadRow.n === 1 ? '' : 's'} downloaded for ${label}.`
          : `Downloads run automatically. Nothing new recorded for ${label} yet.`,
        transactionCount: Number(downloadRow?.n) || 0,
      },
      categories: {
        key: 'categories',
        title: 'Check categories',
        status: monthCategoryCount === 0 && (review.total || 0) === 0
          ? 'done'
          : monthCategoryCount === 0
            ? 'optional'
            : 'needs_review',
        statusLabel: monthCategoryCount === 0
          ? ((review.total || 0) > 0 ? 'Nothing for this month — other months waiting' : 'Nothing waiting')
          : `${monthCategoryCount} need${monthCategoryCount === 1 ? 's' : ''} review`,
        waitingThisMonth: monthCategoryCount,
        waitingTotal: review.total || 0,
      },
      reconcile: {
        key: 'reconcile',
        title: 'Reconcile accounts',
        status: allReconClosed && anyReconStarted
          ? 'done'
          : reconAccounts.some((a) => a.status === 'in_progress' || a.status === 'needs_fix')
            ? 'in_progress'
            : reconAccounts.some((a) => a.status === 'not_started')
              ? 'ready'
              : 'waiting',
        statusLabel: allReconClosed && anyReconStarted
          ? 'All accounts reconciled'
          : reconAccounts.filter((a) => a.status === 'not_started').length
            ? 'Statements ready — start reconciling'
            : 'Waiting for statements',
        accounts: reconAccounts,
      },
      verified: {
        key: 'verified',
        title: 'Month verified',
        status: integrity.isClosed ? 'done' : 'not_ready',
        statusLabel: integrity.isClosed ? 'Closed' : 'Not closed yet',
        isClosed: !!integrity.isClosed,
        blockers: (integrity.blockers || []).slice(0, 5).map((b) =>
          typeof b === 'string' ? b : (b.message || b.code || String(b))
        ),
      },
    },
  };
}
