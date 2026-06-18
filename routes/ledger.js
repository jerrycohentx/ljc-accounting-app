import express from 'express';
import { getDatabase } from '../config/database.js';
import { entityAccessMiddleware } from '../middleware/auth.js';

const router = express.Router({ mergeParams: true });

// GET /api/entities/:entityId/ledger - General Ledger view
router.get('/', entityAccessMiddleware, async (req, res) => {
  try {
    const { accountId, startDate, endDate, page = 1, limit = 100 } = req.query;
    const db = await getDatabase();

    let query = `
      SELECT gl.*, a.account_number, a.account_name, je.je_number
      FROM general_ledger gl
      JOIN accounts a ON gl.account_id = a.id
      JOIN journal_entries je ON gl.journal_entry_id = je.id
      WHERE gl.entity_id = ?
    `;
    const params = [req.entityId];

    if (accountId) {
      query += ' AND gl.account_id = ?';
      params.push(accountId);
    }

    if (startDate) {
      query += ' AND gl.posting_date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND gl.posting_date <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY gl.posting_date DESC, gl.created_at DESC LIMIT ? OFFSET ?';
    const offset = (parseInt(page) - 1) * parseInt(limit);
    params.push(parseInt(limit), offset);

    const entries = await db.all(query, params);

    res.json({
      data: entries,
      pagination: { page: parseInt(page), limit: parseInt(limit) }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/entities/:entityId/ledger/account/:accountId - GL for specific account
router.get('/account/:accountId', entityAccessMiddleware, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const db = await getDatabase();

    // Verify account belongs to entity
    const account = await db.get(
      'SELECT * FROM accounts WHERE id = ? AND entity_id = ?',
      [req.params.accountId, req.entityId]
    );

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    let query = `
      SELECT gl.*, je.je_number, je.description as je_description
      FROM general_ledger gl
      JOIN journal_entries je ON gl.journal_entry_id = je.id
      WHERE gl.account_id = ? AND gl.entity_id = ?
    `;
    const params = [req.params.accountId, req.entityId];

    if (startDate) {
      query += ' AND gl.posting_date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND gl.posting_date <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY gl.posting_date ASC, gl.created_at ASC';

    const entries = await db.all(query, params);

    // Calculate running balance
    let runningBalance = 0;
    const withBalance = entries.map(entry => {
      const debit = parseFloat(entry.debit) || 0;
      const credit = parseFloat(entry.credit) || 0;

      if (account.normal_balance === 'DEBIT') {
        runningBalance += debit - credit;
      } else {
        runningBalance += credit - debit;
      }

      return {
        ...entry,
        runningBalance
      };
    });

    res.json({
      account,
      entries: withBalance,
      finalBalance: runningBalance
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/entities/:entityId/ledger/trial-balance - Trial balance
router.get('/reports/trial-balance', entityAccessMiddleware, async (req, res) => {
  try {
    const { asOfDate } = req.query;
    const db = await getDatabase();

    let query = `
      SELECT 
        a.id,
        a.account_number,
        a.account_name,
        a.account_type,
        a.normal_balance,
        COALESCE(SUM(gl.debit), 0) as total_debit,
        COALESCE(SUM(gl.credit), 0) as total_credit
      FROM accounts a
      LEFT JOIN general_ledger gl ON a.id = gl.account_id AND gl.entity_id = ?
      WHERE a.entity_id = ? AND a.is_active = 1
    `;
    const params = [req.entityId, req.entityId];

    if (asOfDate) {
      query += ' AND (gl.posting_date IS NULL OR gl.posting_date <= ?)';
      params.push(asOfDate);
    }

    query += ` GROUP BY a.id, a.account_number, a.account_name, a.account_type, a.normal_balance
               ORDER BY a.account_number`;

    const accounts = await db.all(query, params);

    // Calculate balances and add debit/credit columns for TB format
    let totalDebit = 0;
    let totalCredit = 0;

    const tb = accounts.map(acc => {
      const debit = parseFloat(acc.total_debit) || 0;
      const credit = parseFloat(acc.total_credit) || 0;

      // Debit/credit for TB depends on normal balance
      let tbDebit = 0, tbCredit = 0;
      if (acc.normal_balance === 'DEBIT') {
        tbDebit = debit - credit;
        if (tbDebit < 0) tbCredit = -tbDebit;
      } else {
        tbCredit = credit - debit;
        if (tbCredit < 0) tbDebit = -tbCredit;
      }

      totalDebit += Math.max(tbDebit, 0);
      totalCredit += Math.max(tbCredit, 0);

      return {
        accountNumber: acc.account_number,
        accountName: acc.account_name,
        accountType: acc.account_type,
        debit: Math.max(tbDebit, 0),
        credit: Math.max(tbCredit, 0)
      };
    });

    res.json({
      asOfDate: asOfDate || new Date().toISOString().split('T')[0],
      entries: tb,
      totals: { debit: totalDebit, credit: totalCredit },
      isBalanced: Math.abs(totalDebit - totalCredit) < 0.01
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
