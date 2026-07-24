import express from 'express';
import Decimal from 'decimal.js';
import { getDatabase } from '../config/database.js';
import { entityAccessMiddleware } from '../middleware/auth.js';

import { POSTED_GL_SUBQUERY, calculateAccountBalance } from '../lib/posted-gl.js';
import reportAnalyticsRoutes from './report-analytics.js';
import { buildBalanceSheet, buildProfitLoss, mergeStatements } from '../lib/financial-statement.js';
import { buildProfitLossFromQboTb, isEmptyAppProfitLoss } from '../lib/qbo-profit-loss.js';
import { deriveComparePeriod } from '../lib/report-comparison.js';
import { renderFinancialStatementPdf } from '../lib/financial-statement-pdf.js';

const router = express.Router({ mergeParams: true });
router.use(reportAnalyticsRoutes);

const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function isoOnly(d) { const m = String(d || '').match(/^\d{4}-\d{2}-\d{2}/); return m ? m[0] : ''; }
function shortLabel(d) { const s = isoOnly(d); if (!s) return ''; const [y, mo, da] = s.split('-'); return `${MONTHS_ABBR[Number(mo) - 1]} ${Number(da)}, ${y.slice(2)}`; }

async function resolveCompanyName(db, entityId) {
  try { const e = await db.get('SELECT name FROM entities WHERE id = ?', entityId); return e?.name || null; } catch { return null; }
}

/**
 * Build a QuickBooks-style Balance Sheet or P&L (nested, with roll-up subtotals
 * and per-number drill metadata), optionally with a comparison period.
 * Returns the structured statement used by both the on-screen report and the PDF.
 */
async function buildStatement(db, entityId, { reportType, asOfDate, startDate, endDate, compareMode, compareStart, compareEnd }) {
  const companyName = await resolveCompanyName(db, entityId);
  const isBS = reportType === 'balance_sheet';
  let primary = isBS
    ? await buildBalanceSheet(db, { entityId, asOfDate, companyName })
    : await buildProfitLoss(db, { entityId, startDate, endDate, companyName });

  // When app GL has no P&L activity for a full tax year (common for 2025 —
  // loaded as 1/1/2026 openings), show the QBO YE trial-balance P&L instead.
  if (!isBS && isEmptyAppProfitLoss(primary)) {
    const qboPl = buildProfitLossFromQboTb(process.cwd(), entityId, { startDate, endDate, companyName });
    if (qboPl) primary = qboPl;
  }

  if (!compareMode || compareMode === 'none') return primary;

  const primaryPeriod = isBS ? { start: asOfDate, end: asOfDate } : { start: startDate, end: endDate };
  const cmpPeriod = deriveComparePeriod(primaryPeriod, compareMode, (compareStart && compareEnd) ? { start: compareStart, end: compareEnd } : null);
  if (!cmpPeriod) return primary;

  const comparison = isBS
    ? await buildBalanceSheet(db, { entityId, asOfDate: cmpPeriod.end, companyName })
    : await buildProfitLoss(db, { entityId, startDate: cmpPeriod.start, endDate: cmpPeriod.end, companyName });

  const cmpLabel = isBS ? shortLabel(cmpPeriod.end) : `${shortLabel(cmpPeriod.start)} - ${shortLabel(cmpPeriod.end)}`;
  const merged = mergeStatements(primary, comparison, cmpLabel);
  // Dates the comparison column drills into (as-of for BS, range for P&L).
  merged.comparePeriodDates = isBS
    ? { mode: 'asof', asOfDate: cmpPeriod.end }
    : { mode: 'range', startDate: cmpPeriod.start, endDate: cmpPeriod.end };
  return merged;
}

// GET /api/entities/:entityId/reports/financial-statement?reportType=balance_sheet|pnl&asOfDate|startDate&endDate&compareMode
router.get('/financial-statement', entityAccessMiddleware, async (req, res) => {
  try {
    const { reportType = 'balance_sheet', asOfDate, startDate, endDate, compareMode = 'none', compareStart, compareEnd } = req.query;
    if (reportType === 'balance_sheet' && !asOfDate) return res.status(400).json({ error: 'asOfDate required' });
    if (reportType === 'pnl' && (!startDate || !endDate)) return res.status(400).json({ error: 'startDate and endDate required' });
    const db = await getDatabase();
    const statement = await buildStatement(db, req.entityId, { reportType, asOfDate, startDate, endDate, compareMode, compareStart, compareEnd });
    res.json({ statement, compareMode });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/reports/financial-statement-pdf  (streams QBO-style PDF inline)
router.post('/financial-statement-pdf', entityAccessMiddleware, async (req, res) => {
  try {
    const { reportType = 'balance_sheet', asOfDate, startDate, endDate, compareMode = 'none', compareStart, compareEnd } = req.body || {};
    if (reportType === 'balance_sheet' && !asOfDate) return res.status(400).json({ error: 'asOfDate required' });
    if (reportType === 'pnl' && (!startDate || !endDate)) return res.status(400).json({ error: 'startDate and endDate required' });
    const db = await getDatabase();
    const statement = await buildStatement(db, req.entityId, { reportType, asOfDate, startDate, endDate, compareMode, compareStart, compareEnd });
    statement.header.generatedAt = new Date();
    const compare = !!(compareMode && compareMode !== 'none' && statement.comparison);
    const pdf = await renderFinancialStatementPdf(statement, { compare });
    const namePart = reportType === 'balance_sheet' ? `BalanceSheet_${isoOnly(asOfDate)}` : `ProfitAndLoss_${isoOnly(startDate)}_${isoOnly(endDate)}`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${namePart}${compare ? '_compare' : ''}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    return res.end(pdf);
  } catch (error) {
    console.error('Financial statement PDF error:', error);
    return res.status(500).json({ error: error.message || 'Failed to render financial statement PDF' });
  }
});

/** @deprecated use POSTED_GL_SUBQUERY from lib/posted-gl.js */
const POSTED_GL = POSTED_GL_SUBQUERY;

async function getAccountsWithBalances(db, entityId, asOfDate = null) {
  let query = `
    SELECT 
      a.id, a.account_number, a.account_name, a.account_type, 
      a.parent_account_id, a.normal_balance,
      COALESCE(SUM(gl.debit), 0) as total_debit,
      COALESCE(SUM(gl.credit), 0) as total_credit
    FROM accounts a
    LEFT JOIN (${POSTED_GL}) gl ON a.id = gl.account_id AND gl.entity_id = ?
    WHERE a.entity_id = ? AND a.is_active = 1
  `;
  const params = [entityId, entityId];
  if (asOfDate) {
    query += ' AND (gl.posting_date IS NULL OR gl.posting_date <= ?)';
    params.push(asOfDate);
  }
  query += ` GROUP BY a.id ORDER BY a.account_number`;
  return db.all(query, params);
}

// Helper: Calculate account balance
function calculateBalance(account) {
  return calculateAccountBalance(account);
}

// GET /api/entities/:entityId/reports/income-statement
router.get('/income-statement', entityAccessMiddleware, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate required' });
    }

    const db = await getDatabase();
    const accounts = await getAccountsWithBalances(db, req.entityId);

    // Filter to date range
    let query = `
      SELECT 
        a.id, a.account_number, a.account_name, a.account_type, a.normal_balance,
        COALESCE(SUM(gl.debit), 0) as total_debit,
        COALESCE(SUM(gl.credit), 0) as total_credit
      FROM accounts a
      LEFT JOIN (${POSTED_GL}) gl ON a.id = gl.account_id AND gl.entity_id = ?
      WHERE a.entity_id = ? AND a.is_active = 1
      AND a.account_type IN ('REVENUE', 'EXPENSE')
      AND (gl.posting_date IS NULL OR (gl.posting_date >= ? AND gl.posting_date <= ?))
      GROUP BY a.id, a.account_number, a.account_name, a.account_type, a.normal_balance
      ORDER BY a.account_type, a.account_number
    `;

    const incomeAccounts = await db.all(query, [req.entityId, req.entityId, startDate, endDate]);

    let totalRevenue = new Decimal(0);
    let totalExpense = new Decimal(0);

    const revenues = [];
    const expenses = [];

    for (const acc of incomeAccounts) {
      const balance = calculateBalance(acc);

      if (acc.account_type === 'REVENUE') {
        revenues.push({
          accountNumber: acc.account_number,
          accountName: acc.account_name,
          amount: balance.toNumber()
        });
        totalRevenue = totalRevenue.plus(balance);
      } else if (acc.account_type === 'EXPENSE') {
        expenses.push({
          accountNumber: acc.account_number,
          accountName: acc.account_name,
          amount: balance.toNumber()
        });
        totalExpense = totalExpense.plus(balance);
      }
    }

    const netIncome = totalRevenue.minus(totalExpense);

    res.json({
      period: { startDate, endDate },
      revenues,
      totalRevenue: totalRevenue.toNumber(),
      expenses,
      totalExpense: totalExpense.toNumber(),
      netIncome: netIncome.toNumber()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/entities/:entityId/reports/balance-sheet
router.get('/balance-sheet', entityAccessMiddleware, async (req, res) => {
  try {
    const { asOfDate } = req.query;
    const reportDate = asOfDate || new Date().toISOString().split('T')[0];

    const db = await getDatabase();
    const accounts = await getAccountsWithBalances(db, req.entityId, reportDate);

    const assets = [];
    const liabilities = [];
    const equity = [];

    let totalAssets = new Decimal(0);
    let totalLiabilities = new Decimal(0);
    let totalEquity = new Decimal(0);
    let netIncome = new Decimal(0); // current-period earnings (revenue - expense) through reportDate

    for (const acc of accounts) {
      if (acc.account_type === 'REVENUE') {
        netIncome = netIncome.plus(calculateBalance(acc));
        continue;
      }
      if (acc.account_type === 'EXPENSE') {
        netIncome = netIncome.minus(calculateBalance(acc));
        continue;
      }
      if (acc.account_type === 'ASSET' || acc.account_type === 'CONTRA') {
        const balance = calculateBalance(acc);
        assets.push({
          accountNumber: acc.account_number,
          accountName: acc.account_name,
          accountType: acc.account_type,
          amount: balance.toNumber()
        });
        if (acc.account_type === 'ASSET') {
          totalAssets = totalAssets.plus(balance);
        } else {
          totalAssets = totalAssets.minus(balance);
        }
      } else if (acc.account_type === 'LIABILITY') {
        const balance = calculateBalance(acc);
        liabilities.push({
          accountNumber: acc.account_number,
          accountName: acc.account_name,
          amount: balance.toNumber()
        });
        totalLiabilities = totalLiabilities.plus(balance);
      } else if (acc.account_type === 'EQUITY') {
        const balance = calculateBalance(acc);
        equity.push({
          accountNumber: acc.account_number,
          accountName: acc.account_name,
          amount: balance.toNumber()
        });
        totalEquity = totalEquity.plus(balance);
      }
    }

    // Fold current-period net income into equity (Current Year Earnings) so the
    // balance sheet balances for an open period before year-end close.
    if (!netIncome.isZero()) {
      equity.push({ accountNumber: '', accountName: 'Current Year Earnings', amount: netIncome.toNumber() });
      totalEquity = totalEquity.plus(netIncome);
    }

    res.json({
      asOfDate: reportDate,
      assets,
      totalAssets: totalAssets.toNumber(),
      liabilities,
      totalLiabilities: totalLiabilities.toNumber(),
      equity,
      totalEquity: totalEquity.toNumber(),
      netIncome: netIncome.toNumber(),
      totalLiabilitiesAndEquity: totalLiabilities.plus(totalEquity).toNumber()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/entities/:entityId/reports/dashboard
router.get('/dashboard', entityAccessMiddleware, async (req, res) => {
  try {
    const db = await getDatabase();
    const today = new Date().toISOString().split('T')[0];
    const monthAgo = new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().split('T')[0];

    // Get balances as of today
    const accounts = await getAccountsWithBalances(db, req.entityId, today);

    let totalAssets = new Decimal(0);
    let totalLiabilities = new Decimal(0);
    let totalEquity = new Decimal(0);

    for (const acc of accounts) {
      const balance = calculateBalance(acc);
      if (acc.account_type === 'ASSET') totalAssets = totalAssets.plus(balance);
      else if (acc.account_type === 'LIABILITY') totalLiabilities = totalLiabilities.plus(balance);
      else if (acc.account_type === 'EQUITY') totalEquity = totalEquity.plus(balance);
    }

    // Get recent journal entries
    const recentJournals = await db.all(
      `SELECT id, je_number, description, posting_date, status, total_debit, total_credit
       FROM journal_entries
       WHERE entity_id = ?
       ORDER BY posting_date DESC, created_at DESC
       LIMIT 10`,
      req.entityId
    );

    // Get account balances
    const topAccounts = accounts
      .filter(a => a.account_type !== 'CONTRA')
      .map(a => ({
        accountNumber: a.account_number,
        accountName: a.account_name,
        accountType: a.account_type,
        balance: calculateBalance(a).toNumber()
      }))
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
      .slice(0, 10);

    // Count statistics
    const stats = await db.get(
      `SELECT 
        COUNT(DISTINCT je.id) as journal_count,
        COUNT(DISTINCT gl.id) as gl_entries,
        COUNT(DISTINCT a.id) as account_count
       FROM journal_entries je
       LEFT JOIN general_ledger gl ON je.id = gl.journal_entry_id
       LEFT JOIN accounts a ON a.entity_id = ?
       WHERE je.entity_id = ?`,
      [req.entityId, req.entityId]
    );

    res.json({
      asOfDate: today,
      kpis: {
        totalAssets: totalAssets.toNumber(),
        totalLiabilities: totalLiabilities.toNumber(),
        totalEquity: totalEquity.toNumber(),
        journalEntries: stats.journal_count || 0,
        generalLedgerEntries: stats.gl_entries || 0,
        accountCount: stats.account_count || 0
      },
      recentJournals,
      topAccounts
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/entities/:entityId/reports/account-balances
router.get('/account-balances', entityAccessMiddleware, async (req, res) => {
  try {
    const { asOfDate, accountType } = req.query;
    const db = await getDatabase();

    let accounts = await getAccountsWithBalances(db, req.entityId, asOfDate);

    if (accountType) {
      accounts = accounts.filter(a => a.account_type === accountType);
    }

    const balances = accounts
      .filter(a => a.is_active !== 0)
      .map(a => ({
        id: a.id,
        accountNumber: a.account_number,
        accountName: a.account_name,
        accountType: a.account_type,
        balance: calculateBalance(a).toNumber()
      }))
      .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));

    res.json(balances);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/entities/:entityId/reports/cash-flow
router.get('/cash-flow', entityAccessMiddleware, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate required' });
    }

    const db = await getDatabase();

    // Get cash account balance change
    const cashAccounts = await db.all(
      `SELECT 
        COALESCE(SUM(gl.debit), 0) - COALESCE(SUM(gl.credit), 0) as net_change
       FROM accounts a
       LEFT JOIN (${POSTED_GL}) gl ON a.id = gl.account_id AND gl.entity_id = ?
       WHERE a.entity_id = ? AND a.account_type = 'ASSET'
       AND a.account_number LIKE '100%'
       AND gl.posting_date >= ? AND gl.posting_date <= ?`,
      [req.entityId, req.entityId, startDate, endDate]
    );

    res.json({
      period: { startDate, endDate },
      operatingActivities: 0,
      investingActivities: 0,
      financingActivities: 0,
      netCashFlow: (cashAccounts[0]?.net_change || 0)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/entities/:entityId/reports/trial-balance
router.get('/trial-balance', entityAccessMiddleware, async (req, res) => {
  try {
    const { asOfDate } = req.query;
    const reportDate = asOfDate || new Date().toISOString().split('T')[0];
    const db = await getDatabase();
    const accounts = await getAccountsWithBalances(db, req.entityId, reportDate);

    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);
    const entries = accounts.map((acc) => {
      const balance = calculateBalance(acc);
      let tbDebit = new Decimal(0);
      let tbCredit = new Decimal(0);
      if (acc.normal_balance === 'DEBIT') {
        tbDebit = balance.gte(0) ? balance : new Decimal(0);
        tbCredit = balance.lt(0) ? balance.abs() : new Decimal(0);
      } else {
        tbCredit = balance.gte(0) ? balance : new Decimal(0);
        tbDebit = balance.lt(0) ? balance.abs() : new Decimal(0);
      }
      totalDebit = totalDebit.plus(tbDebit);
      totalCredit = totalCredit.plus(tbCredit);
      return {
        accountNumber: acc.account_number,
        accountName: acc.account_name,
        accountType: acc.account_type,
        debit: tbDebit.toNumber(),
        credit: tbCredit.toNumber(),
      };
    });

    res.json({
      asOfDate: reportDate,
      entries,
      totals: { debit: totalDebit.toNumber(), credit: totalCredit.toNumber() },
      isBalanced: totalDebit.minus(totalCredit).abs().lt(0.01),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/entities/:entityId/reports/transaction-detail
 * QuickBooks "Transaction Detail By Account" — the drill-down target for any
 * aggregate number on a financial statement (a section total, a subtotal, or
 * Net Income). Returns the posted transactions behind the clicked figure,
 * grouped by account with a running balance and per-account subtotal, plus a
 * grand total that foots to the number that was clicked.
 *
 * Query: accountNumbers=csv | accountTypes=csv ; net=1 (revenue+, expense- for
 * Net Income drills) ; mode=asof|range ; asOfDate | startDate&endDate ; title.
 */
router.get('/transaction-detail', entityAccessMiddleware, async (req, res) => {
  try {
    const { accountNumbers, accountTypes, net, mode = 'range', asOfDate, startDate, endDate, title } = req.query;
    const db = await getDatabase();
    const netMode = net === '1' || net === 'true';

    const acctParams = [req.entityId];
    let acctWhere = 'entity_id = ? AND is_active = true';
    if (accountNumbers) {
      const nums = String(accountNumbers).split(',').map((s) => s.trim()).filter(Boolean);
      if (nums.length) { acctWhere += ` AND account_number IN (${nums.map(() => '?').join(',')})`; acctParams.push(...nums); }
    } else if (accountTypes) {
      const types = String(accountTypes).split(',').map((s) => s.trim()).filter(Boolean);
      if (types.length) { acctWhere += ` AND account_type IN (${types.map(() => '?').join(',')})`; acctParams.push(...types); }
    }
    const accounts = await db.all(`SELECT id, account_number, account_name, account_type, normal_balance FROM accounts WHERE ${acctWhere} ORDER BY account_number`, acctParams);
    if (!accounts.length) return res.json({ title: title || 'Transaction Detail', groups: [], grandTotal: 0, count: 0 });

    const idList = accounts.map((a) => a.id);
    const glParams = [req.entityId];
    let dateWhere = '';
    if (mode === 'asof' && asOfDate) { dateWhere = 'AND gl.posting_date <= ?'; glParams.push(asOfDate); }
    else if (mode === 'range' && startDate && endDate) { dateWhere = 'AND gl.posting_date >= ? AND gl.posting_date <= ?'; glParams.push(startDate, endDate); }
    glParams.push(...idList);
    const lines = await db.all(
      `SELECT gl.account_id, gl.posting_date, gl.debit, gl.credit, je.je_number, je.description AS je_description
       FROM (${POSTED_GL_SUBQUERY}) gl
       JOIN journal_entries je ON gl.journal_entry_id = je.id
       WHERE gl.entity_id = ? ${dateWhere} AND gl.account_id IN (${idList.map(() => '?').join(',')})
       ORDER BY gl.account_id, gl.posting_date ASC, gl.created_at ASC`,
      glParams
    );

    const byAcct = new Map(accounts.map((a) => [a.id, { account: a, lines: [] }]));
    for (const l of lines) byAcct.get(l.account_id)?.lines.push(l);

    let grand = new Decimal(0);
    const groups = [];
    for (const a of accounts) {
      const g = byAcct.get(a.id);
      if (!g.lines.length) continue;
      let running = new Decimal(0);
      const outLines = g.lines.map((l) => {
        const debit = new Decimal(l.debit || 0);
        const credit = new Decimal(l.credit || 0);
        let signed = a.normal_balance === 'DEBIT' ? debit.minus(credit) : credit.minus(debit);
        if (a.account_type === 'CONTRA') signed = signed.negated();
        if (netMode && a.account_type === 'EXPENSE') signed = signed.negated();
        running = running.plus(signed);
        return { date: l.posting_date, jeNumber: l.je_number, name: l.je_description || '', debit: debit.toNumber(), credit: credit.toNumber(), amount: signed.toNumber(), balance: running.toNumber() };
      });
      grand = grand.plus(running);
      groups.push({ accountId: a.id, accountNumber: a.account_number, accountName: a.account_name, lines: outLines, total: running.toNumber() });
    }

    res.json({ title: title || 'Transaction Detail', mode, asOfDate: asOfDate || null, startDate: startDate || null, endDate: endDate || null, groups, grandTotal: grand.toNumber(), count: lines.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
