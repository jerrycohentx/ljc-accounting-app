/**
 * Net income tie-out — Balance Sheet "Current Year Earnings" must equal
 * P&L for the same calendar YTD window. Prior-year P&L must be closed to RE.
 *
 * This exists because agents previously reported "clean books" while BS Net
 * Income still included unclosed prior-year P&L ($215k Ivymount case).
 */
import Decimal from 'decimal.js';
import { POSTED_GL_SUBQUERY, calculateAccountBalance } from './posted-gl.js';
import { normalizeIsoDate } from './bank-statement-view.js';

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Calendar year start for an as-of / period-end date. */
export function calendarYearStart(asOfDate) {
  const iso = normalizeIsoDate(asOfDate) || String(asOfDate).slice(0, 10);
  return `${iso.slice(0, 4)}-01-01`;
}

/**
 * Net income for posted REVENUE/EXPENSE activity in [startDate, endDate].
 * Same definition as GET .../reports/income-statement.
 */
export async function computePeriodNetIncome(db, entityId, startDate, endDate) {
  const start = normalizeIsoDate(startDate) || String(startDate).slice(0, 10);
  const end = normalizeIsoDate(endDate) || String(endDate).slice(0, 10);
  const rows = await db.all(
    `SELECT a.id, a.account_number, a.account_name, a.account_type, a.normal_balance,
            COALESCE(SUM(gl.debit), 0) AS total_debit,
            COALESCE(SUM(gl.credit), 0) AS total_credit
     FROM accounts a
     LEFT JOIN (${POSTED_GL_SUBQUERY}) gl
       ON a.id = gl.account_id AND gl.entity_id = ?
      AND gl.posting_date >= ? AND gl.posting_date <= ?
     WHERE a.entity_id = ? AND a.is_active = 1
       AND a.account_type IN ('REVENUE', 'EXPENSE')
     GROUP BY a.id, a.account_number, a.account_name, a.account_type, a.normal_balance`,
    [entityId, start, end, entityId]
  );

  let totalRevenue = new Decimal(0);
  let totalExpense = new Decimal(0);
  for (const acc of rows || []) {
    const bal = calculateAccountBalance(acc);
    if (acc.account_type === 'REVENUE') totalRevenue = totalRevenue.plus(bal);
    else totalExpense = totalExpense.plus(bal);
  }
  return {
    startDate: start,
    endDate: end,
    totalRevenue: round2(totalRevenue.toNumber()),
    totalExpense: round2(totalExpense.toNumber()),
    netIncome: round2(totalRevenue.minus(totalExpense).toNumber()),
  };
}

/**
 * Hard check used by period integrity and agents:
 * - CYE (YTD P&L through periodEnd) is the BS Net Income figure
 * - Prior-year P&L (activity before Jan 1 of periodEnd's year) must be ~$0
 */
export async function getNetIncomeTieoutStatus(db, entityId, periodEnd) {
  const end = normalizeIsoDate(periodEnd) || String(periodEnd).slice(0, 10);
  const yearStart = calendarYearStart(end);
  const ytd = await computePeriodNetIncome(db, entityId, yearStart, end);

  // Any P&L still open before this calendar year (should have been closed to RE)
  const priorEnd = (() => {
    const y = Number(end.slice(0, 4)) - 1;
    return `${y}-12-31`;
  })();
  const prior = await computePeriodNetIncome(db, entityId, '2000-01-01', priorEnd);

  const priorYearPlOpen = Math.abs(prior.netIncome) >= 0.005;
  const blockers = [];
  if (priorYearPlOpen) {
    blockers.push(
      `Prior-year P&L not closed to Retained Earnings: $${prior.netIncome.toFixed(2)} still open through ${priorEnd}. ` +
        `Balance Sheet Net Income will not match ${end.slice(0, 4)} P&L until that residual is closed.`
    );
  }

  return {
    periodEnd: end,
    yearStart,
    currentYearEarnings: ytd.netIncome,
    ytdPnl: ytd,
    priorYearPnl: prior,
    priorYearPlClosed: !priorYearPlOpen,
    /** BS "Net Income" / CYE must equal this when prior year is closed. */
    expectedBalanceSheetNetIncome: ytd.netIncome,
    blockers,
    ok: !priorYearPlOpen,
  };
}
