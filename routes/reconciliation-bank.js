/**
 * Bank Reconciliation Routes for LJC Accounting App
 * ==================================================
 *
 * API endpoints for bank reconciliation workflow.
 *
 * Endpoints:
 * - GET /api/reconciliation/bank/unreconciled - List unreconciled transactions
 * - GET /api/reconciliation/bank/candidates/:glId - Get matching candidates from bank
 * - POST /api/reconciliation/bank/match - Match GL transaction to bank
 * - POST /api/reconciliation/bank/auto-match - Auto-match all by amount/date
 * - POST /api/reconciliation/bank/clear - Mark transaction as reconciled
 * - GET /api/reconciliation/bank/summary - Monthly reconciliation summary
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { getDatabase } from '../config/database.js';

const router = express.Router();

/**
 * GET /api/reconciliation/bank/unreconciled
 * Get unreconciled transactions for an account
 */
router.get('/unreconciled', async (req, res) => {
  try {
    const { entityId, accountId, asOfDate } = req.query;

    if (!entityId || !accountId) {
      return res.status(400).json({ error: 'Entity ID and Account ID required' });
    }

    const db = await getDatabase();

    // Get GL entries that are not reconciled
    const glEntries = await db.all(
      `SELECT gl.*, a.account_number, a.account_name, je.description
       FROM general_ledger gl
       JOIN accounts a ON gl.account_id = a.id
       JOIN journal_entries je ON gl.journal_entry_id = je.id
       WHERE gl.entity_id = ? AND gl.account_id = ?
       AND gl.reconciliation_status IS NULL
       AND je.status = 'POSTED'
       ${asOfDate ? 'AND gl.posting_date <= ?' : ''}
       ORDER BY gl.posting_date DESC`,
      asOfDate ? [entityId, accountId, asOfDate] : [entityId, accountId]
    );

    // Get import transactions that are not matched
    const importTxns = await db.all(
      `SELECT * FROM import_transactions
       WHERE entity_id = ? AND account_id = ?
       AND matched_to_gl_id IS NULL
       ${asOfDate ? 'AND date <= ?' : ''}
       ORDER BY date DESC`,
      asOfDate ? [entityId, accountId, asOfDate] : [entityId, accountId]
    );

    return res.json({
      glEntries: glEntries || [],
      bankTransactions: importTxns || [],
      unreconciled: {
        glCount: glEntries ? glEntries.length : 0,
        bankCount: importTxns ? importTxns.length : 0
      }
    });
  } catch (error) {
    console.error('Unreconciled fetch error:', error);
    return res.status(500).json({
      error: 'Failed to fetch unreconciled transactions',
      details: error.message
    });
  }
});

/**
 * GET /api/reconciliation/bank/candidates/:glId
 * Get matching candidates from bank for a GL entry
 * Uses fuzzy matching on amount and date
 */
router.get('/candidates/:glId', async (req, res) => {
  try {
    const { glId } = req.params;
    const { accountId, entityId } = req.query;

    if (!accountId || !entityId) {
      return res.status(400).json({ error: 'Entity ID and Account ID required' });
    }

    const db = await getDatabase();

    // Get the GL entry
    const glEntry = await db.get(
      `SELECT * FROM general_ledger WHERE id = ?`,
      glId
    );

    if (!glEntry) {
      return res.status(404).json({ error: 'GL entry not found' });
    }

    // Calculate the amount (debit or credit)
    const amount = glEntry.debit > 0 ? glEntry.debit : -glEntry.credit;

    // Get candidates: matching amount within 2 days
    const candidates = await db.all(
      `SELECT * FROM import_transactions
       WHERE entity_id = ? AND account_id = ?
       AND matched_to_gl_id IS NULL
       AND ABS(amount - ?) < 0.01
       AND ABS(JULIANDAY(date) - JULIANDAY(?)) <= 2
       ORDER BY ABS(JULIANDAY(date) - JULIANDAY(?))`,
      [entityId, accountId, amount, glEntry.posting_date, glEntry.posting_date]
    );

    return res.json({
      glEntry: {
        id: glEntry.id,
        amount,
        date: glEntry.posting_date,
        description: glEntry.description
      },
      candidates: candidates || []
    });
  } catch (error) {
    console.error('Candidates fetch error:', error);
    return res.status(500).json({
      error: 'Failed to fetch matching candidates',
      details: error.message
    });
  }
});

/**
 * POST /api/reconciliation/bank/match
 * Match a GL entry to a bank transaction
 */
router.post('/match', async (req, res) => {
  try {
    const { glId, bankTransactionId } = req.body;

    if (!glId || !bankTransactionId) {
      return res.status(400).json({
        error: 'GL ID and bank transaction ID required'
      });
    }

    const db = await getDatabase();

    // Get GL entry
    const glEntry = await db.get(
      'SELECT * FROM general_ledger WHERE id = ?',
      glId
    );
    if (!glEntry) {
      return res.status(404).json({ error: 'GL entry not found' });
    }

    // Get bank transaction
    const bankTxn = await db.get(
      'SELECT * FROM import_transactions WHERE id = ?',
      bankTransactionId
    );
    if (!bankTxn) {
      return res.status(404).json({ error: 'Bank transaction not found' });
    }

    // Verify amounts match (within tolerance)
    const glAmount = glEntry.debit > 0 ? glEntry.debit : -glEntry.credit;
    if (Math.abs(glAmount - bankTxn.amount) > 0.01) {
      return res.status(400).json({
        error: 'Amounts do not match',
        details: `GL: ${glAmount}, Bank: ${bankTxn.amount}`
      });
    }

    // Create match record
    const matchId = `match-${uuidv4()}`;
    await db.run(
      `INSERT INTO reconciliation_matches (
        id, gl_entry_id, import_transaction_id, matched_amount, matched_date,
        matched_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        matchId,
        glId,
        bankTransactionId,
        glAmount,
        new Date().toISOString().split('T')[0],
        req.user.id,
        new Date().toISOString()
      ]
    );

    // Update import transaction
    await db.run(
      'UPDATE import_transactions SET matched_to_gl_id = ?, status = ? WHERE id = ?',
      [glId, 'MATCHED', bankTransactionId]
    );

    return res.json({
      matchId,
      glId,
      bankTransactionId,
      status: 'MATCHED',
      message: 'Transaction matched successfully'
    });
  } catch (error) {
    console.error('Match transaction error:', error);
    return res.status(500).json({
      error: 'Failed to match transactions',
      details: error.message
    });
  }
});

/**
 * POST /api/reconciliation/bank/auto-match
 * Auto-match GL and bank transactions
 * Uses amount matching within tolerance and date within 2 days
 */
router.post('/auto-match', async (req, res) => {
  try {
    const { entityId, accountId, asOfDate } = req.body;

    if (!entityId || !accountId) {
      return res.status(400).json({
        error: 'Entity ID and Account ID required'
      });
    }

    const db = await getDatabase();

    // Get unmatched GL entries
    const glEntries = await db.all(
      `SELECT gl.*, a.account_number, a.account_name
       FROM general_ledger gl
       JOIN accounts a ON gl.account_id = a.id
       WHERE gl.entity_id = ? AND gl.account_id = ?
       AND gl.reconciliation_status IS NULL
       AND gl.id NOT IN (
         SELECT gl_entry_id FROM reconciliation_matches WHERE gl_entry_id IS NOT NULL
       )
       ${asOfDate ? 'AND gl.posting_date <= ?' : ''}
       ORDER BY gl.posting_date DESC`,
      asOfDate ? [entityId, accountId, asOfDate] : [entityId, accountId]
    );

    // Get unmatched bank transactions
    const bankTxns = await db.all(
      `SELECT * FROM import_transactions
       WHERE entity_id = ? AND account_id = ?
       AND matched_to_gl_id IS NULL
       ${asOfDate ? 'AND date <= ?' : ''}
       ORDER BY date DESC`,
      asOfDate ? [entityId, accountId, asOfDate] : [entityId, accountId]
    );

    let matchCount = 0;
    const matched = [];
    const unmatched = [];

    // Try to match each GL entry
    for (const gl of glEntries) {
      const glAmount = gl.debit > 0 ? gl.debit : -gl.credit;

      let bestMatch = null;
      let bestScore = 0;

      // Find best matching bank transaction
      for (const bank of bankTxns) {
        // Check if amount matches (within 0.01 tolerance)
        if (Math.abs(glAmount - bank.amount) < 0.01) {
          // Check if date is within 2 days
          const glDate = new Date(gl.posting_date);
          const bankDate = new Date(bank.date);
          const dayDiff = Math.abs((glDate - bankDate) / (1000 * 60 * 60 * 24));

          if (dayDiff <= 2) {
            // This is a candidate - calculate score
            const score = 1.0 - (dayDiff / 2.0); // 1.0 = same day, 0.0 = 2 days

            if (score > bestScore && !bank.matched_to_gl_id) {
              bestMatch = bank;
              bestScore = score;
            }
          }
        }
      }

      if (bestMatch && bestScore > 0.5) {
        // Create match
        const matchId = `match-${uuidv4()}`;
        await db.run(
          `INSERT INTO reconciliation_matches (
            id, gl_entry_id, import_transaction_id, matched_amount, matched_date,
            matched_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            matchId,
            gl.id,
            bestMatch.id,
            glAmount,
            new Date().toISOString().split('T')[0],
            req.user.id,
            new Date().toISOString()
          ]
        );

        // Update import transaction
        await db.run(
          'UPDATE import_transactions SET matched_to_gl_id = ?, status = ? WHERE id = ?',
          [gl.id, 'MATCHED', bestMatch.id]
        );

        matched.push({
          gl: { id: gl.id, amount: glAmount, date: gl.posting_date },
          bank: { id: bestMatch.id, amount: bestMatch.amount, date: bestMatch.date },
          score: bestScore
        });
        matchCount++;
      } else {
        unmatched.push({
          gl: { id: gl.id, amount: glAmount, date: gl.posting_date }
        });
      }
    }

    return res.json({
      summary: {
        matched: matchCount,
        unmatched: unmatched.length,
        totalProcessed: glEntries.length
      },
      matches: matched.slice(0, 10), // Show first 10
      unmatched: unmatched.slice(0, 10)
    });
  } catch (error) {
    console.error('Auto-match error:', error);
    return res.status(500).json({
      error: 'Failed to auto-match transactions',
      details: error.message
    });
  }
});

/**
 * POST /api/reconciliation/bank/clear
 * Mark matched transactions as cleared/reconciled
 */
router.post('/clear', async (req, res) => {
  try {
    const { matchIds, reconciliationDate } = req.body;

    if (!Array.isArray(matchIds) || matchIds.length === 0) {
      return res.status(400).json({
        error: 'Match IDs array required'
      });
    }

    const db = await getDatabase();
    const clearedDate = reconciliationDate || new Date().toISOString().split('T')[0];

    // Update matches
    const placeholders = matchIds.map(() => '?').join(',');
    await db.run(
      `UPDATE reconciliation_matches
       SET cleared = 1, cleared_date = ?, cleared_by = ?
       WHERE id IN (${placeholders})`,
      [...matchIds, clearedDate, req.user.id]
    );

    return res.json({
      clearedCount: matchIds.length,
      clearedDate,
      message: `${matchIds.length} transactions marked as cleared`
    });
  } catch (error) {
    console.error('Clear error:', error);
    return res.status(500).json({
      error: 'Failed to clear transactions',
      details: error.message
    });
  }
});

/**
 * GET /api/reconciliation/bank/summary
 * Get reconciliation summary for an account/period
 */
router.get('/summary', async (req, res) => {
  try {
    const { entityId, accountId, asOfDate } = req.query;

    if (!entityId || !accountId) {
      return res.status(400).json({
        error: 'Entity ID and Account ID required'
      });
    }

    const db = await getDatabase();
    const date = asOfDate || new Date().toISOString().split('T')[0];

    // Get bank balance from import
    const bankBalance = await db.get(
      `SELECT SUM(amount) as balance FROM import_transactions
       WHERE entity_id = ? AND account_id = ?
       AND date <= ?`,
      [entityId, accountId, date]
    );

    // Get GL balance
    const glBalance = await db.get(
      `SELECT SUM(debit - credit) as balance FROM general_ledger
       WHERE entity_id = ? AND account_id = ?
       AND posting_date <= ?
       AND reconciliation_status IS NULL`,
      [entityId, accountId, date]
    );

    // Get cleared/matched transactions
    const cleared = await db.get(
      `SELECT SUM(rm.matched_amount) as amount, COUNT(*) as count
       FROM reconciliation_matches rm
       WHERE rm.cleared = 1 AND rm.cleared_date <= ?`,
      [date]
    );

    // Calculate uncleared
    const uncleared = await db.get(
      `SELECT SUM(gl.debit - gl.credit) as amount, COUNT(*) as count
       FROM general_ledger gl
       WHERE gl.entity_id = ? AND gl.account_id = ?
       AND gl.posting_date <= ?
       AND gl.id NOT IN (
         SELECT gl_entry_id FROM reconciliation_matches rm
         WHERE rm.cleared = 1
       )`,
      [entityId, accountId, date]
    );

    const bankBal = bankBalance?.balance || 0;
    const glBal = glBalance?.balance || 0;
    const clearedAmt = cleared?.amount || 0;
    const unclearedAmt = uncleared?.amount || 0;

    return res.json({
      asOfDate: date,
      bankBalance: bankBal,
      glBalance: glBal,
      variance: bankBal - glBal,
      transactions: {
        total: (cleared?.count || 0) + (uncleared?.count || 0),
        cleared: cleared?.count || 0,
        uncleared: uncleared?.count || 0
      },
      status: Math.abs(bankBal - glBal) < 0.01 ? 'RECONCILED' : 'VARIANCE'
    });
  } catch (error) {
    console.error('Summary error:', error);
    return res.status(500).json({
      error: 'Failed to get reconciliation summary',
      details: error.message
    });
  }
});

export default router;
