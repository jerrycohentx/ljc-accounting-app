import express from 'express';
import Decimal from 'decimal.js';
import { getDatabase } from '../config/database.js';
import { entityAccessMiddleware } from '../middleware/auth.js';

import { POSTED_GL_SUBQUERY, calculateAccountBalance } from '../lib/posted-gl.js';
import reportAnalyticsRoutes from './report-analytics.js';

const router = express.Router({ mergeParams: true });
router.use(reportAnalyticsRoutes);

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
      .sort((a, b) => a.account_number.localeCompare(b.account_number));

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

export default router;
