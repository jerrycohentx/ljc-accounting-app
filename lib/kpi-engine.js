import Decimal from 'decimal.js';
import { POSTED_GL_SUBQUERY, calculateAccountBalance } from './posted-gl.js';
import { accountMatchesSegment } from './report-segments.js';
import { computeVariance, round2 } from './report-comparison.js';
import { getKpiPack, INDUSTRY_BENCHMARKS, kpiPacksForEntity } from './kpi-packs.js';
import { getBenchmarkTarget } from './benchmark-targets.js';

function sumAccounts(accounts, numbers) {
  const set = new Set(numbers.map(String));
  return accounts
    .filter((a) => set.has(String(a.account_number)))
    .reduce((s, a) => s.plus(calculateAccountBalance(a)), new Decimal(0))
    .toNumber();
}

function avgBalance(begin, end) {
  return round2((Number(begin || 0) + Number(end || 0)) / 2);
}

async function loadAccounts(db, entityId, asOfDate, segmentKey) {
  const rows = await db.all(
    `SELECT a.id, a.account_number, a.account_name, a.account_type, a.normal_balance,
            COALESCE(SUM(gl.debit), 0) AS total_debit,
            COALESCE(SUM(gl.credit), 0) AS total_credit
     FROM accounts a
     LEFT JOIN (${POSTED_GL_SUBQUERY}) gl ON a.id = gl.account_id AND gl.entity_id = ?
       AND (gl.posting_date IS NULL OR gl.posting_date <= ?)
     WHERE a.entity_id = ? AND a.is_active = 1
     GROUP BY a.id
     ORDER BY a.account_number`,
    [entityId, asOfDate, entityId]
  );
  return (rows || []).filter((a) => accountMatchesSegment(entityId, a.account_number, segmentKey));
}

async function plTotals(db, entityId, startDate, endDate, segmentKey) {
  const rows = await db.all(
    `SELECT a.account_number, a.account_name, a.account_type, a.normal_balance,
            COALESCE(SUM(gl.debit), 0) AS total_debit,
            COALESCE(SUM(gl.credit), 0) AS total_credit
     FROM accounts a
     LEFT JOIN (${POSTED_GL_SUBQUERY}) gl ON a.id = gl.account_id AND gl.entity_id = ?
       AND gl.posting_date >= ? AND gl.posting_date <= ?
     WHERE a.entity_id = ? AND a.is_active = 1
       AND a.account_type IN ('REVENUE', 'EXPENSE')
     GROUP BY a.id`,
    [entityId, startDate, endDate, entityId]
  );
  const filtered = (rows || []).filter((a) => accountMatchesSegment(entityId, a.account_number, segmentKey));
  let revenue = new Decimal(0);
  let expense = new Decimal(0);
  for (const a of filtered) {
    const bal = calculateAccountBalance(a);
    if (a.account_type === 'REVENUE') revenue = revenue.plus(bal);
    else expense = expense.plus(bal);
  }
  return {
    revenue: revenue.toNumber(),
    expense: expense.toNumber(),
    netIncome: revenue.minus(expense).toNumber(),
    interestIncome: sumAccounts(filtered, ['4000', '4010', '4200']),
    interestExpense: sumAccounts(filtered, ['5000', '5800']),
    rentalRevenue: sumAccounts(filtered, ['4100', '4150']),
    operatingExpense: sumAccounts(filtered, ['6100', '5200', '5300', '5500', '5600', '5700']),
  };
}

async function bsTotals(db, entityId, asOfDate, segmentKey) {
  const accounts = await loadAccounts(db, entityId, asOfDate, segmentKey);
  let assets = new Decimal(0);
  let liabilities = new Decimal(0);
  let equity = new Decimal(0);
  let loanAssets = new Decimal(0);
  for (const a of accounts) {
    const bal = calculateAccountBalance(a);
    if (a.account_type === 'ASSET') {
      assets = assets.plus(bal);
      if (/Notes Receivable|Loan Receivable|^13|^14/.test(a.account_name)) loanAssets = loanAssets.plus(bal);
    } else if (a.account_type === 'LIABILITY') liabilities = liabilities.plus(bal);
    else if (a.account_type === 'EQUITY') equity = equity.plus(bal);
  }
  return {
    totalAssets: assets.toNumber(),
    totalLiabilities: liabilities.toNumber(),
    totalEquity: equity.toNumber(),
    avgLoanBalance: loanAssets.toNumber(),
    avgEarningAssets: loanAssets.toNumber(),
  };
}

function safePct(num, den) {
  if (!den || Math.abs(den) < 0.005) return null;
  return round2((num / den) * 100);
}

function computeKpiValue(key, ctx) {
  const { pl, bs, bsBegin } = ctx;
  switch (key) {
    case 'net_interest_margin': {
      const avg = avgBalance(bsBegin?.avgEarningAssets, bs.avgEarningAssets);
      return safePct(pl.interestIncome - pl.interestExpense, avg);
    }
    case 'yield_on_loans':
      return safePct(pl.interestIncome, avgBalance(bsBegin?.avgLoanBalance, bs.avgLoanBalance));
    case 'cost_of_funds':
      return safePct(pl.interestExpense, avgBalance(bsBegin?.totalLiabilities, bs.totalLiabilities));
    case 'spread': {
      const y = computeKpiValue('yield_on_loans', ctx);
      const c = computeKpiValue('cost_of_funds', ctx);
      return y != null && c != null ? round2(y - c) : null;
    }
    case 'delinquency_rate':
    case 'default_ratio':
      return null; // needs loan tracker operational data
    case 'roa':
      return safePct(pl.netIncome, avgBalance(bsBegin?.totalAssets, bs.totalAssets));
    case 'roe':
      return safePct(pl.netIncome, avgBalance(bsBegin?.totalEquity, bs.totalEquity));
    case 'debt_to_equity':
      return bs.totalEquity ? round2(bs.totalLiabilities / bs.totalEquity) : null;
    case 'efficiency_ratio':
      return safePct(pl.operatingExpense, pl.interestIncome);
    case 'noi':
      return round2(pl.rentalRevenue - pl.operatingExpense);
    case 'cap_rate':
    case 'cash_on_cash':
    case 'dscr':
    case 'occupancy_rate':
    case 'vacancy_loss':
    case 'operating_expense_ratio':
    case 'grm':
    case 'rent_psf':
    case 'tenant_turnover':
    case 'census_rate':
    case 'revpor':
    case 'revpar':
    case 'rev_per_resident_day':
    case 'labor_cost_ratio':
    case 'cost_per_resident_day':
    case 'moveout_rate':
      return null;
    case 'gross_margin':
      return safePct(pl.revenue - pl.operatingExpense, pl.revenue);
    case 'operating_margin':
      return safePct(pl.netIncome, pl.revenue);
    case 'net_margin':
      return safePct(pl.netIncome, pl.revenue);
    case 'current_ratio':
    case 'quick_ratio':
    case 'expense_ratio':
      return safePct(pl.expense, pl.revenue);
    default:
      return null;
  }
}

export async function computeKpiDashboard(db, {
  entityId,
  segmentKey = 'all',
  startDate,
  endDate,
  compareStart = null,
  compareEnd = null,
  naics = null,
  benchmarkMode = 'both',
}) {
  const periodStart = `${startDate.slice(0, 7)}-01`;
  const comparePeriodStart = compareStart ? `${compareStart.slice(0, 7)}-01` : null;

  const pl = await plTotals(db, entityId, startDate, endDate, segmentKey);
  const bs = await bsTotals(db, entityId, endDate, segmentKey);
  const bsBegin = await bsTotals(db, entityId, periodStart, segmentKey);

  let comparePl = null;
  let compareBs = null;
  let compareBsBegin = null;
  if (compareStart && compareEnd) {
    comparePl = await plTotals(db, entityId, compareStart, compareEnd, segmentKey);
    compareBs = await bsTotals(db, entityId, compareEnd, segmentKey);
    compareBsBegin = await bsTotals(db, entityId, comparePeriodStart, segmentKey);
  }

  const packs = kpiPacksForEntity(entityId, segmentKey);
  const groups = [];

  for (const pack of packs) {
    const rows = [];
    for (const def of pack.kpis) {
      const ctx = { pl, bs, bsBegin };
      const current = computeKpiValue(def.key, ctx);
      let comparison = null;
      if (comparePl && compareBs) {
        comparison = computeKpiValue(def.key, {
          pl: comparePl,
          bs: compareBs,
          bsBegin: compareBsBegin,
        });
      }

      const isPct = def.format === 'percent' || def.format === 'pp';
      const v = computeVariance(current, comparison, { isPercent: isPct });

      let benchmarkValue = null;
      let benchmarkSource = null;
      if (benchmarkMode !== 'none') {
        const custom = await getBenchmarkTarget(db, entityId, def.key, segmentKey);
        if (custom) {
          benchmarkValue = custom.value;
          benchmarkSource = 'custom';
        } else if (naics && INDUSTRY_BENCHMARKS[naics]?.[def.key] != null) {
          benchmarkValue = INDUSTRY_BENCHMARKS[naics][def.key];
          benchmarkSource = 'qbo_industry';
        }
      }

      const benchmarkGap = benchmarkValue != null && current != null
        ? (isPct ? round2(current - benchmarkValue) : round2(current - benchmarkValue))
        : null;

      rows.push({
        ...def,
        current,
        comparison: v.comparison,
        variance: v.variance,
        variancePct: v.variancePct,
        variancePp: v.variancePp,
        needsData: current == null,
        benchmarkValue,
        benchmarkSource,
        benchmarkGap,
      });
    }
    groups.push({ packKey: pack.key, packLabel: pack.label, naics: pack.naics, rows });
  }

  return {
    entityId,
    segment: segmentKey,
    period: { start: startDate, end: endDate },
    comparePeriod: compareStart ? { start: compareStart, end: compareEnd } : null,
    groups,
  };
}

export { getKpiPack };
