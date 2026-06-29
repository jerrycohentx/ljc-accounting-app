import express from 'express';
import Decimal from 'decimal.js';
import { getDatabase } from '../config/database.js';
import { entityAccessMiddleware } from '../middleware/auth.js';
import { POSTED_GL_SUBQUERY, calculateAccountBalance } from '../lib/posted-gl.js';
import {
  deriveComparePeriod,
  mergeComparisonLines,
  linePolarity,
  computeVariance,
} from '../lib/report-comparison.js';
import { segmentsForEntity, resolveSegment } from '../lib/report-segments.js';
import { computeKpiDashboard } from '../lib/kpi-engine.js';
import { listBenchmarkTargets, upsertBenchmarkTarget } from '../lib/benchmark-targets.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router({ mergeParams: true });

async function incomeStatementForPeriod(db, entityId, startDate, endDate, segmentKey) {
  const { accountMatchesSegment } = await import('../lib/report-segments.js');
  const rows = await db.all(
    `SELECT a.account_number, a.account_name, a.account_type, a.normal_balance,
            COALESCE(SUM(gl.debit), 0) AS total_debit,
            COALESCE(SUM(gl.credit), 0) AS total_credit
     FROM accounts a
     LEFT JOIN (${POSTED_GL_SUBQUERY}) gl ON a.id = gl.account_id AND gl.entity_id = ?
       AND gl.posting_date >= ? AND gl.posting_date <= ?
     WHERE a.entity_id = ? AND a.is_active = 1
       AND a.account_type IN ('REVENUE', 'EXPENSE')
     GROUP BY a.id
     ORDER BY a.account_type, a.account_number`,
    [entityId, startDate, endDate, entityId]
  );

  const filtered = (rows || []).filter((a) => accountMatchesSegment(entityId, a.account_number, segmentKey));
  const revenues = [];
  const expenses = [];
  let totalRevenue = new Decimal(0);
  let totalExpense = new Decimal(0);

  for (const acc of filtered) {
    const balance = calculateAccountBalance(acc);
    const line = {
      accountNumber: acc.account_number,
      accountName: acc.account_name,
      accountType: acc.account_type,
      amount: balance.toNumber(),
      polarity: linePolarity(acc.account_type, acc.account_name),
    };
    if (acc.account_type === 'REVENUE') {
      revenues.push(line);
      totalRevenue = totalRevenue.plus(balance);
    } else {
      expenses.push(line);
      totalExpense = totalExpense.plus(balance);
    }
  }

  const netIncome = totalRevenue.minus(totalExpense);
  return {
    period: { startDate, endDate },
    revenues,
    expenses,
    totalRevenue: totalRevenue.toNumber(),
    totalExpense: totalExpense.toNumber(),
    netIncome: netIncome.toNumber(),
  };
}

async function balanceSheetAsOf(db, entityId, asOfDate, segmentKey) {
  const { accountMatchesSegment } = await import('../lib/report-segments.js');
  const rows = await db.all(
    `SELECT a.account_number, a.account_name, a.account_type, a.normal_balance,
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

  const filtered = (rows || []).filter((a) => accountMatchesSegment(entityId, a.account_number, segmentKey));
  const assets = [];
  const liabilities = [];
  const equity = [];
  let totalAssets = new Decimal(0);
  let totalLiabilities = new Decimal(0);
  let totalEquity = new Decimal(0);

  for (const acc of filtered) {
    const balance = calculateAccountBalance(acc);
    const line = {
      accountNumber: acc.account_number,
      accountName: acc.account_name,
      accountType: acc.account_type,
      amount: balance.toNumber(),
      polarity: 'neutral',
    };
    if (acc.account_type === 'ASSET' || acc.account_type === 'CONTRA') {
      assets.push(line);
      totalAssets = acc.account_type === 'CONTRA' ? totalAssets.minus(balance) : totalAssets.plus(balance);
    } else if (acc.account_type === 'LIABILITY') {
      liabilities.push(line);
      totalLiabilities = totalLiabilities.plus(balance);
    } else if (acc.account_type === 'EQUITY') {
      equity.push(line);
      totalEquity = totalEquity.plus(balance);
    }
  }

  return {
    asOfDate,
    assets,
    liabilities,
    equity,
    totalAssets: totalAssets.toNumber(),
    totalLiabilities: totalLiabilities.toNumber(),
    totalEquity: totalEquity.toNumber(),
    totalLiabilitiesAndEquity: totalLiabilities.plus(totalEquity).toNumber(),
  };
}

// GET /api/entities/:entityId/reports/comparison?reportType=pnl&startDate&endDate&compareMode&segment
router.get('/comparison', entityAccessMiddleware, async (req, res) => {
  try {
    const {
      reportType = 'pnl',
      startDate,
      endDate,
      asOfDate,
      compareMode = 'none',
      compareStart,
      compareEnd,
      segment = 'all',
    } = req.query;

    const db = await getDatabase();
    const seg = resolveSegment(req.entityId, segment);

    if (reportType === 'balance_sheet') {
      const primaryDate = asOfDate || endDate || new Date().toISOString().slice(0, 10);
      const current = await balanceSheetAsOf(db, req.entityId, primaryDate, segment);
      const comparePeriod = deriveComparePeriod(
        { start: primaryDate, end: primaryDate },
        compareMode,
        compareStart && compareEnd ? { start: compareStart, end: compareEnd } : null
      );
      let comparison = null;
      if (comparePeriod) {
        comparison = await balanceSheetAsOf(db, req.entityId, comparePeriod.end, segment);
      }

      const withVariance = (lines, cmpLines) => mergeComparisonLines(lines, cmpLines, (l) => l.accountNumber);

      return res.json({
        reportType: 'balance_sheet',
        entityId: req.entityId,
        segment,
        segmentLabel: seg?.label,
        naics: seg?.naics,
        primary: current,
        comparison: comparison ? {
          asOfDate: comparison.asOfDate,
          assets: withVariance(current.assets, comparison.assets),
          liabilities: withVariance(current.liabilities, comparison.liabilities),
          equity: withVariance(current.equity, comparison.equity),
          totalAssets: computeVariance(current.totalAssets, comparison.totalAssets),
          totalLiabilities: computeVariance(current.totalLiabilities, comparison.totalLiabilities),
          totalEquity: computeVariance(current.totalEquity, comparison.totalEquity),
        } : null,
        compareMode,
      });
    }

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate required for P&L comparison' });
    }

    const current = await incomeStatementForPeriod(db, req.entityId, startDate, endDate, segment);
    const comparePeriod = deriveComparePeriod(
      { start: startDate, end: endDate },
      compareMode,
      compareStart && compareEnd ? { start: compareStart, end: compareEnd } : null
    );

    let comparison = null;
    if (comparePeriod) {
      const cmp = await incomeStatementForPeriod(
        db,
        req.entityId,
        comparePeriod.start,
        comparePeriod.end,
        segment
      );
      comparison = {
        period: cmp.period,
        revenues: mergeComparisonLines(current.revenues, cmp.revenues, (l) => l.accountNumber),
        expenses: mergeComparisonLines(current.expenses, cmp.expenses, (l) => l.accountNumber),
        totalRevenue: computeVariance(current.totalRevenue, cmp.totalRevenue),
        totalExpense: computeVariance(current.totalExpense, cmp.totalExpense),
        netIncome: computeVariance(current.netIncome, cmp.netIncome),
      };
    }

    return res.json({
      reportType: 'pnl',
      entityId: req.entityId,
      segment,
      segmentLabel: seg?.label,
      naics: seg?.naics,
      primary: current,
      comparison,
      compareMode,
      comparePeriod,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/entities/:entityId/reports/kpi-dashboard
router.get('/kpi-dashboard', entityAccessMiddleware, async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      compareMode = 'none',
      compareStart,
      compareEnd,
      segment = 'all',
      benchmarkMode = 'both',
    } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate required' });
    }

    const db = await getDatabase();
    const seg = resolveSegment(req.entityId, segment);
    const comparePeriod = deriveComparePeriod(
      { start: startDate, end: endDate },
      compareMode,
      compareStart && compareEnd ? { start: compareStart, end: compareEnd } : null
    );

    const result = await computeKpiDashboard(db, {
      entityId: req.entityId,
      segmentKey: segment,
      startDate,
      endDate,
      compareStart: comparePeriod?.start,
      compareEnd: comparePeriod?.end,
      naics: seg?.naics,
      benchmarkMode,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/entities/:entityId/reports/segments
router.get('/segments', entityAccessMiddleware, (req, res) => {
  res.json({ segments: segmentsForEntity(req.entityId) });
});

// GET/POST benchmark targets
router.get('/benchmark-targets', entityAccessMiddleware, async (req, res) => {
  try {
    const db = await getDatabase();
    const rows = await listBenchmarkTargets(db, req.entityId, req.query.segment || null);
    res.json({ targets: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/benchmark-targets', entityAccessMiddleware, async (req, res) => {
  try {
    const { segmentKey, kpiKey, value, source, effectiveDate, note } = req.body;
    if (!kpiKey || value == null) {
      return res.status(400).json({ error: 'kpiKey and value required' });
    }
    const db = await getDatabase();
    await upsertBenchmarkTarget(db, {
      id: `bt-${uuidv4()}`,
      entityId: req.entityId,
      segmentKey: segmentKey || 'all',
      kpiKey,
      value: Number(value),
      source,
      effectiveDate,
      note,
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
