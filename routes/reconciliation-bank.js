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
import { tryVerifyDrawFromBankTxn } from '../lib/holdback-disbursement.js';
import { getDatabase } from '../config/database.js';
import {
  buildWorksheet,
  closeBankReconciliation,
  reopenBankReconciliation,
} from '../lib/bank-reconcile-session.js';
import { buildReconciliationReport, saveReconciliationReport } from '../lib/reconciliation-report.js';
import { importStatementForReconcile } from '../lib/reconcile-statement-import.js';
import { ensureStatementFileSchema, saveStatementFile, getStatementFile } from '../lib/statement-file-schema.js';
import { prepareReconciliation } from '../lib/reconcile-prepare.js';
import { postReconcileAdjustment } from '../lib/reconcile-adjustment.js';
import { getStatementAutoLoadStatus, runStatementAutoLoad } from '../lib/statement-auto-load.js';

const router = express.Router();

async function ensureReconColumn(db) {
  // SQLite does not support "ADD COLUMN IF NOT EXISTS"; attempt the plain ALTER
  // and ignore the error when the column already exists (works on SQLite + Postgres).
  try {
    await db.run('ALTER TABLE general_ledger ADD COLUMN reconciliation_status TEXT');
  } catch (error) {
    if (!/duplicate column|already exists/i.test(error.message)) {
      throw error;
    }
  }
}

router.use(async (req, res, next) => {
  try {
    const db = await getDatabase();
    await ensureReconColumn(db);
    next();
  } catch (error) {
    console.error('Bank recon schema error:', error);
    res.status(500).json({ error: 'Bank reconciliation schema unavailable', details: error.message });
  }
});

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
    const amountCandidates = await db.all(
      `SELECT * FROM import_transactions
       WHERE entity_id = ? AND account_id = ?
       AND matched_to_gl_id IS NULL
       AND ABS(amount - ?) < 0.01`,
      [entityId, accountId, amount]
    );
    const glDate = new Date(glEntry.posting_date);
    const candidates = (amountCandidates || [])
      .filter((row) => {
        const dayDiff = Math.abs(new Date(row.date) - glDate) / (1000 * 60 * 60 * 24);
        return dayDiff <= 2;
      })
      .sort((a, b) => {
        const diffA = Math.abs(new Date(a.date) - glDate);
        const diffB = Math.abs(new Date(b.date) - glDate);
        return diffA - diffB;
      });

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

    const verifiedDraw = await tryVerifyDrawFromBankTxn(db, {
      importTransaction: bankTxn,
      userId: req.user.id,
      entityId: glEntry.entity_id,
    });

    return res.json({
      matchId,
      glId,
      bankTransactionId,
      status: 'MATCHED',
      holdbackVerified: verifiedDraw ? verifiedDraw.draw_id : null,
      message: verifiedDraw
        ? 'Transaction matched and holdback draw wire verified'
        : 'Transaction matched successfully'
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

// GET /api/reconciliation/bank/auto-load/status
router.get('/auto-load/status', async (req, res) => {
  try {
    return res.json(getStatementAutoLoadStatus());
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/auto-load/run', async (req, res) => {
  try {
    const db = await getDatabase();
    const result = await runStatementAutoLoad(db, { reason: 'manual' });
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Manual statement auto-load error:', error);
    return res.status(500).json({ error: error.message || 'Auto-load failed' });
  }
});

// GET /api/reconciliation/bank/prepare — load statement from folder/JSON and suggest fields
router.get('/prepare', async (req, res) => {
  try {
    const { entityId, accountId, statementDate, importFromFolder } = req.query;
    if (!entityId || !accountId) {
      return res.status(400).json({ error: 'entityId and accountId required' });
    }
    const db = await getDatabase();
    const result = await prepareReconciliation(db, {
      entityId,
      accountId,
      statementDate: statementDate || null,
      userId: req.user?.id || 'usr-admin',
      importFromFolder: importFromFolder !== '0',
    });
    return res.json(result);
  } catch (error) {
    console.error('Reconcile prepare error:', error);
    return res.status(500).json({ error: error.message || 'Failed to prepare reconciliation' });
  }
});

// GET /api/reconciliation/bank/worksheet — QuickBooks-style statement reconcile worksheet
router.get('/worksheet', async (req, res) => {
  try {
    const { entityId, accountId, statementDate, autoMatch } = req.query;
    if (!entityId || !accountId) return res.status(400).json({ error: 'Entity ID and Account ID required' });
    const db = await getDatabase();
    const date = statementDate || new Date().toISOString().split('T')[0];
    const worksheet = await buildWorksheet(db, {
      entityId,
      accountId,
      statementDate: date,
      autoMatch: autoMatch === '1' || autoMatch === 'true',
      userId: req.user?.id || 'usr-admin',
    });
    return res.json(worksheet);
  } catch (error) {
    console.error('Reconcile worksheet error:', error);
    return res.status(500).json({ error: 'Failed to load reconcile worksheet', details: error.message });
  }
});

// POST /api/reconciliation/bank/reconcile — close only when difference is zero
router.post('/reconcile', async (req, res) => {
  try {
    const {
      entityId, accountId, glIds, statementDate, statementEndingBalance, notes,
      serviceCharge = 0, interestEarned = 0,
      serviceChargeAccountId = null, interestAccountId = null,
      serviceChargeDate = null, interestDate = null,
    } = req.body;
    if (!entityId || !accountId || !Array.isArray(glIds)) {
      return res.status(400).json({ error: 'entityId, accountId and glIds[] required' });
    }
    const db = await getDatabase();
    const recDate = statementDate || new Date().toISOString().split('T')[0];

    let result;
    try {
      result = await closeBankReconciliation(db, {
        entityId,
        accountId,
        glIds,
        statementDate: recDate,
        statementEndingBalance,
        userId: req.user?.id || 'usr-admin',
        notes,
        serviceCharge: Number(serviceCharge) || 0,
        interestEarned: Number(interestEarned) || 0,
        serviceChargeAccountId: serviceChargeAccountId || null,
        interestAccountId: interestAccountId || null,
        serviceChargeDate: serviceChargeDate || null,
        interestDate: interestDate || null,
      });
    } catch (err) {
      if (err.code === 'RECON_OUT_OF_BALANCE') {
        return res.status(422).json({
          error: err.message,
          code: err.code,
          ...err.details,
        });
      }
      throw err;
    }

    let verifiedDraws = [];
    if (statementDate) {
      const bankTxns = await db.all(
        `SELECT * FROM import_transactions
         WHERE entity_id = ? AND account_id = ? AND date <= ? AND status != 'RECONCILED'`,
        [entityId, accountId, recDate]
      );
      for (const txn of bankTxns || []) {
        const verified = await tryVerifyDrawFromBankTxn(db, {
          importTransaction: txn,
          userId: req.user?.id,
          entityId,
        });
        if (verified) {
          verifiedDraws.push(verified.draw_id);
          await db.run(`UPDATE import_transactions SET status = 'RECONCILED' WHERE id = ?`, txn.id);
        }
      }
    }

    // Archive a QuickBooks-style Summary + Detail snapshot of this closed
    // reconciliation so it can be pulled up later for reference even after
    // the ledger changes further. Non-fatal: the reconciliation itself is
    // already closed above; a report-generation hiccup shouldn't undo that.
    let reportId = null;
    try {
      const report = await buildReconciliationReport(db, {
        entityId,
        accountId,
        statementDate: recDate,
      });
      reportId = await saveReconciliationReport(db, report, { userId: req.user?.id || null });
    } catch (reportErr) {
      console.error('Reconciliation report archive failed (non-fatal):', reportErr.message);
    }

    return res.json({
      ...result,
      statementDate: recDate,
      holdbackVerified: verifiedDraws,
      reportId,
      message: verifiedDraws.length
        ? `${result.reconciledCount} transactions reconciled; ${verifiedDraws.length} holdback draw(s) verified`
        : `${result.reconciledCount} transactions reconciled — session closed`,
    });
  } catch (error) {
    console.error('Reconcile error:', error);
    return res.status(500).json({ error: error.message || 'Failed to reconcile' });
  }
});

// POST /api/reconciliation/bank/adjustment — QBD "Enter Adjustment" (last resort)
router.post('/adjustment', async (req, res) => {
  try {
    const {
      entityId,
      accountId,
      statementDate,
      difference,
      glIds = [],
      serviceCharge = 0,
      interestEarned = 0,
      statementEndingBalance,
    } = req.body;
    if (!entityId || !accountId) {
      return res.status(400).json({ error: 'entityId and accountId required' });
    }
    if (difference == null || Number.isNaN(Number(difference))) {
      return res.status(400).json({ error: 'difference required' });
    }
    const db = await getDatabase();
    const result = await postReconcileAdjustment(db, {
      entityId,
      accountId,
      statementDate: statementDate || new Date().toISOString().split('T')[0],
      difference: Number(difference),
      glIds: Array.isArray(glIds) ? glIds : [],
      serviceCharge: Number(serviceCharge) || 0,
      interestEarned: Number(interestEarned) || 0,
      statementEndingBalance: statementEndingBalance != null ? Number(statementEndingBalance) : undefined,
      userId: req.user?.id || 'usr-admin',
    });
    return res.json(result);
  } catch (error) {
    console.error('Reconcile adjustment error:', error);
    return res.status(500).json({ error: error.message || 'Adjustment failed' });
  }
});

// POST /api/reconciliation/bank/import-statement — OFX or PDF while reconciling
router.post('/import-statement', async (req, res) => {
  try {
    const {
      entityId,
      accountId,
      ofxContent,
      pdfBase64,
      fileName,
      autoPost = true,
    } = req.body;
    if (!entityId || !accountId) {
      return res.status(400).json({ error: 'entityId and accountId required' });
    }
    if (!ofxContent && !pdfBase64) {
      return res.status(400).json({ error: 'ofxContent or pdfBase64 required' });
    }

    const db = await getDatabase();
    const result = await importStatementForReconcile(db, {
      entityId,
      accountId,
      userId: req.user?.id || 'usr-admin',
      ofxContent,
      pdfBase64,
      fileName,
      autoPost,
    });

    // Keep the statement PDF so it can be shown automatically next to the
    // register the next time this period is reconciled.
    let statementFileSaved = false;
    if (pdfBase64 && result.statementDate) {
      try {
        await ensureStatementFileSchema(db);
        statementFileSaved = await saveStatementFile(db, {
          entityId,
          accountId,
          statementDate: result.statementDate,
          fileName: fileName || 'statement.pdf',
          fileMime: 'application/pdf',
          fileDataBase64: pdfBase64,
          userId: req.user?.id || 'usr-admin',
        });
      } catch (e) {
        console.error('Statement file save failed (non-fatal):', e.message);
      }
    }

    return res.json({
      ok: true,
      statementFileSaved,
      message: result.imported
        ? `Imported ${result.imported} line(s), posted ${result.posted} to register`
        : result.skippedDuplicates
          ? `All ${result.skippedDuplicates} line(s) already imported`
          : 'No transactions found on statement',
      ...result,
    });
  } catch (error) {
    console.error('Import statement error:', error);
    return res.status(500).json({ error: error.message || 'Failed to import statement' });
  }
});

// GET /api/reconciliation/bank/statement-file — the stored statement PDF for a
// period, so the frontend can show it automatically next to the register.
router.get('/statement-file', async (req, res) => {
  try {
    const { entityId, accountId, statementDate } = req.query;
    if (!entityId || !accountId || !statementDate) {
      return res.status(400).json({ error: 'entityId, accountId and statementDate required' });
    }
    const db = await getDatabase();
    await ensureStatementFileSchema(db);
    const row = await getStatementFile(db, { entityId, accountId, statementDate });
    if (!row || !row.file_data) return res.json({ found: false });
    return res.json({
      found: true,
      fileName: row.file_name || 'statement.pdf',
      mime: row.file_mime || 'application/pdf',
      dataBase64: row.file_data,
    });
  } catch (error) {
    console.error('Statement file fetch error:', error);
    return res.status(500).json({ error: error.message || 'Failed to load statement file' });
  }
});

// POST /api/reconciliation/bank/reopen — reopen an out-of-balance or incorrect period
router.post('/reopen', async (req, res) => {
  try {
    const { entityId, accountId, statementDate } = req.body;
    if (!entityId || !accountId || !statementDate) {
      return res.status(400).json({ error: 'entityId, accountId and statementDate required' });
    }
    const db = await getDatabase();
    const result = await reopenBankReconciliation(db, { entityId, accountId, statementDate });
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Reopen recon error:', error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
