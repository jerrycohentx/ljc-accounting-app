/**
 * Bank Import Routes for LJC Accounting App
 * ==========================================
 *
 * API endpoints for importing OFX files and managing bank transactions.
 *
 * Endpoints:
 * - POST /api/import/ofx - Upload and parse OFX file
 * - POST /api/import/transactions - Save parsed transactions to GL
 * - GET /api/import/status/:importId - Get import status
 * - GET /api/import/list - List recent imports
 * - DELETE /api/import/:importId - Delete import session
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../config/database.js';
import { parseOFX, validateTransactions, deduplicateTransactions } from '../lib/ofx-parser.js';
import { commitBankImportTransactions, updateImportOffsetAccount, reapplyRulesToPending } from '../lib/import-commit.js';
import { postJournalEntryToGl } from '../lib/post-journal.js';

const router = express.Router();

// In-memory store for import sessions (in production, use database)
const importSessions = new Map();

/**
 * POST /api/import/ofx
 * Upload OFX file and parse transactions
 * Returns import session with preview of transactions
 */
router.post('/ofx', async (req, res) => {
  try {
    const { ofxContent, fileName, entityId } = req.body;

    if (!ofxContent) {
      return res.status(400).json({ error: 'OFX content required' });
    }

    if (!entityId) {
      return res.status(400).json({ error: 'Entity ID required' });
    }

    // Parse OFX file
    let parseResult;
    try {
      parseResult = parseOFX(ofxContent, { strict: false });
    } catch (error) {
      return res.status(400).json({
        error: 'Failed to parse OFX file',
        details: error.message
      });
    }

    if (!parseResult.success) {
      return res.status(400).json({
        error: 'OFX parsing failed',
        errors: parseResult.errors
      });
    }

    // Validate transactions
    const validation = validateTransactions(parseResult.transactions);

    // Check for duplicates in database
    const db = await getDatabase();
    const existingFitids = await db.all(
      'SELECT DISTINCT fitid FROM import_transactions WHERE entity_id = ? AND status != ?',
      [entityId, 'REJECTED']
    );
    const existingFitidSet = new Set(existingFitids.map(r => r.fitid));

    const dedup = deduplicateTransactions(parseResult.transactions, existingFitidSet);

    // Create import session
    const importId = `imp-${uuidv4()}`;
    const session = {
      importId,
      entityId,
      fileName: fileName || parseResult.fileName,
      accountId: parseResult.accountId,
      statementType: parseResult.statementType,
      dateRange: parseResult.dateRange,
      totalTransactions: parseResult.transactions.length,
      newTransactions: dedup.newCount,
      duplicateTransactions: dedup.duplicateCount,
      transactions: dedup.newTransactions,
      validation,
      createdAt: new Date().toISOString(),
      status: 'PREVIEW'
    };

    importSessions.set(importId, session);

    return res.json({
      importId,
      fileName: session.fileName,
      accountId: session.accountId,
      statementType: session.statementType,
      dateRange: session.dateRange,
      summary: {
        totalTransactions: session.totalTransactions,
        newTransactions: session.newTransactions,
        duplicateTransactions: session.duplicateTransactions
      },
      validation,
      preview: session.transactions.slice(0, 10), // First 10 transactions
      totalForImport: session.newTransactions
    });
  } catch (error) {
    console.error('OFX import error:', error);
    return res.status(500).json({
      error: 'Failed to process OFX file',
      details: error.message
    });
  }
});

/**
 * GET /api/import/status/:importId
 * Get status and details of import session
 */
router.get('/status/:importId', async (req, res) => {
  try {
    const { importId } = req.params;

    const session = importSessions.get(importId);
    if (!session) {
      return res.status(404).json({ error: 'Import session not found' });
    }

    return res.json({
      importId,
      status: session.status,
      fileName: session.fileName,
      dateRange: session.dateRange,
      summary: {
        totalTransactions: session.totalTransactions,
        newTransactions: session.newTransactions,
        duplicateTransactions: session.duplicateTransactions,
        imported: session.importedCount || 0,
        matched: session.matchedCount || 0
      },
      createdAt: session.createdAt,
      completedAt: session.completedAt
    });
  } catch (error) {
    console.error('Status check error:', error);
    return res.status(500).json({ error: 'Failed to get import status' });
  }
});

/**
 * POST /api/import/transactions
 * Confirm import and save transactions to journal entries and GL
 */
router.post('/transactions', async (req, res) => {
  try {
    const { importId } = req.body;
    if (!importId) return res.status(400).json({ error: 'Import ID required' });

    const session = importSessions.get(importId);
    if (!session) return res.status(404).json({ error: 'Import session not found' });

    const db = await getDatabase();
    const { createdJECount, reapply } = await commitBankImportTransactions(db, {
      entityId: session.entityId,
      transactions: session.transactions,
      importId,
      userId: req.user.id,
      sourceLabel: 'OFX Import',
    });

    session.status = 'COMPLETED';
    session.importedCount = createdJECount;
    session.completedAt = new Date().toISOString();

    const sweepNote = reapply?.updated
      ? ` ${reapply.updated} older pending transaction${reapply.updated === 1 ? '' : 's'} also auto-categorized from recently learned rules.`
      : '';
    return res.json({
      importId,
      status: 'COMPLETED',
      transactionsProcessed: createdJECount,
      journalEntriesCreated: createdJECount,
      reapply,
      message: `Imported ${createdJECount} transactions — review in Bank Feeds before posting.${sweepNote}`,
    });
  } catch (error) {
    console.error('Transaction import error:', error);
    return res.status(500).json({ error: 'Failed to import transactions', details: error.message });
  }
});

/** Manually re-sweep the pending review queue with current categorization rules. */
router.post('/reapply-rules', async (req, res) => {
  try {
    const { entityId } = req.body;
    if (!entityId) return res.status(400).json({ error: 'entityId required' });

    const db = await getDatabase();
    const result = await reapplyRulesToPending(db, entityId);
    res.json(result);
  } catch (error) {
    console.error('Reapply rules error:', error);
    res.status(500).json({ error: 'Failed to re-apply rules', details: error.message });
  }
});

/**
 * One-time data repair: correct the bank/card-side GL account on already-
 * imported pending transactions that were booked to the wrong account
 * (e.g. before per-institution account mapping existed for Plaid feeds).
 * Only touches DRAFT import_transactions / DRAFT journal_entries whose
 * journal entry description starts with the given prefix. Never touches
 * posted entries. Safe to leave in place for future one-off corrections.
 */
router.post('/fix-bank-account', async (req, res) => {
  try {
    const { entityId, descriptionPrefix, correctAccountNumber } = req.body;
    if (!entityId || !descriptionPrefix || !correctAccountNumber) {
      return res.status(400).json({ error: 'entityId, descriptionPrefix, correctAccountNumber required' });
    }

    const db = await getDatabase();
    const correctAccount = await db.get(
      'SELECT id, account_name FROM accounts WHERE entity_id = ? AND account_number = ?',
      [entityId, correctAccountNumber]
    );
    if (!correctAccount) {
      return res.status(404).json({ error: `Account ${correctAccountNumber} not found for entity` });
    }

    const rows = await db.all(
      `SELECT it.id, it.journal_entry_id AS journalEntryId
       FROM import_transactions it
       JOIN journal_entries je ON je.id = it.journal_entry_id
       WHERE it.entity_id = ? AND it.status = 'DRAFT' AND je.status = 'DRAFT'
         AND je.description LIKE ?`,
      [entityId, `${descriptionPrefix}%`]
    );

    let fixed = 0;
    for (const row of rows) {
      const bankLine = await db.get(
        'SELECT id FROM journal_entry_lines WHERE journal_entry_id = ? AND line_number = 1',
        [row.journalEntryId]
      );
      if (!bankLine) continue;
      await db.run('UPDATE journal_entry_lines SET account_id = ? WHERE id = ?', [correctAccount.id, bankLine.id]);
      await db.run('UPDATE import_transactions SET account_id = ? WHERE id = ?', [correctAccount.id, row.id]);
      fixed += 1;
    }

    res.json({ scanned: rows.length, fixed, correctAccount: { number: correctAccountNumber, name: correctAccount.account_name } });
  } catch (error) {
    console.error('Fix bank account error:', error);
    res.status(500).json({ error: error.message });
  }
});

/** Bank Feeds review queue — DRAFT imports awaiting categorization/post. */
router.get('/pending', async (req, res) => {
  try {
    const { entityId } = req.query;
    if (!entityId) return res.status(400).json({ error: 'entityId required' });

    const db = await getDatabase();
    const rows = await db.all(
      `SELECT it.fitid, it.date, it.amount, it.description, it.journal_entry_id AS jeId,
              it.offset_account_id AS offsetAccountId, je.je_number AS jeNumber,
              it.account_id AS accountId, a.account_number AS accountNumber, a.account_name AS accountName
       FROM import_transactions it
       JOIN journal_entries je ON je.id = it.journal_entry_id
       LEFT JOIN accounts a ON a.id = it.account_id
       WHERE it.entity_id = ? AND it.status = 'DRAFT' AND je.status = 'DRAFT'
       ORDER BY it.date DESC, it.created_at DESC`,
      entityId
    );

    const pending = rows.map((r) => {
      const amt = Math.abs(Number(r.amount));
      const isDeposit = Number(r.amount) > 0;
      return {
        fitid: r.fitid,
        jeId: r.jeId,
        jeNumber: r.jeNumber,
        date: r.date,
        description: r.description,
        payment: isDeposit ? null : amt.toFixed(2),
        deposit: isDeposit ? amt.toFixed(2) : null,
        offsetAccountId: r.offsetAccountId,
        accountId: r.accountId,
        accountNumber: r.accountNumber,
        accountName: r.accountName,
      };
    });

    res.json({ pending, count: pending.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/pending/:fitid', async (req, res) => {
  try {
    const { entityId, offsetAccountId } = req.body;
    if (!entityId || !offsetAccountId) {
      return res.status(400).json({ error: 'entityId and offsetAccountId required' });
    }
    const db = await getDatabase();
    const result = await updateImportOffsetAccount(db, {
      entityId,
      fitid: req.params.fitid,
      offsetAccountId,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/post-selected', async (req, res) => {
  try {
    const { entityId, jeIds } = req.body;
    if (!entityId || !jeIds?.length) {
      return res.status(400).json({ error: 'entityId and jeIds[] required' });
    }

    const db = await getDatabase();
    let posted = 0;
    for (const jeId of jeIds) {
      await postJournalEntryToGl(db, { journalId: jeId, entityId, userId: req.user.id });
      await db.run(
        "UPDATE import_transactions SET status = 'RECONCILED' WHERE journal_entry_id = ? AND entity_id = ?",
        [jeId, entityId]
      );
      posted += 1;
    }

    res.json({
      posted,
      message: `${posted} transaction(s) added to the register.`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message, details: error.message });
  }
});

router.post('/reject', async (req, res) => {
  try {
    const { entityId, fitids } = req.body;
    if (!entityId || !fitids?.length) {
      return res.status(400).json({ error: 'entityId and fitids[] required' });
    }

    const db = await getDatabase();
    let rejected = 0;
    for (const fitid of fitids) {
      const row = await db.get(
        'SELECT journal_entry_id FROM import_transactions WHERE fitid = ? AND entity_id = ?',
        [fitid, entityId]
      );
      if (!row) continue;
      await db.run('DELETE FROM journal_entry_lines WHERE journal_entry_id = ?', row.journal_entry_id);
      await db.run('DELETE FROM journal_entries WHERE id = ? AND status = ?', row.journal_entry_id, 'DRAFT');
      await db.run(
        "UPDATE import_transactions SET status = 'REJECTED' WHERE fitid = ? AND entity_id = ?",
        [fitid, entityId]
      );
      rejected += 1;
    }

    res.json({ rejected, message: `${rejected} transaction(s) discarded.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/import/list
 * List recent import sessions
 */
router.get('/list', async (req, res) => {
  try {
    const { entityId } = req.query;

    const imports = Array.from(importSessions.values())
      .filter(s => !entityId || s.entityId === entityId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 20)
      .map(s => ({
        importId: s.importId,
        fileName: s.fileName,
        status: s.status,
        dateRange: s.dateRange,
        summary: {
          totalTransactions: s.totalTransactions,
          newTransactions: s.newTransactions,
          imported: s.importedCount || 0
        },
        createdAt: s.createdAt
      }));

    return res.json(imports);
  } catch (error) {
    console.error('List imports error:', error);
    return res.status(500).json({ error: 'Failed to list imports' });
  }
});

/**
 * DELETE /api/import/:importId
 * Delete import session and optionally rollback transactions
 */
router.delete('/:importId', async (req, res) => {
  try {
    const { importId } = req.params;
    const { rollback = false } = req.query;

    const session = importSessions.get(importId);
    if (!session) {
      return res.status(404).json({ error: 'Import session not found' });
    }

    if (rollback === 'true') {
      const db = await getDatabase();

      // Delete journal entries created by this import
      const entries = await db.all(
        `SELECT je.id FROM journal_entries je
         WHERE je.created_by = ? AND je.description LIKE ?`,
        [req.user.id, '%Bank Import%']
      );

      for (const entry of entries) {
        await db.run('DELETE FROM journal_entry_lines WHERE journal_entry_id = ?', entry.id);
        await db.run('DELETE FROM general_ledger WHERE journal_entry_id = ?', entry.id);
        await db.run('DELETE FROM journal_entries WHERE id = ?', entry.id);
      }
    }

    importSessions.delete(importId);

    return res.json({
      message: 'Import session deleted',
      rolled_back: rollback === 'true'
    });
  } catch (error) {
    console.error('Delete import error:', error);
    return res.status(500).json({ error: 'Failed to delete import' });
  }
});

/**
 * POST /api/import/email-scan
 * Scan connected mailboxes for bank statement attachments (alias for email ingest run).
 */
router.post('/email-scan', async (req, res) => {
  try {
    const { runStatementEmailIngest } = await import('../lib/statement-email-ingest.js');
    const db = await getDatabase();
    const result = await runStatementEmailIngest(db, {
      reason: 'manual-scan',
      userId: req.user?.id || 'usr-admin',
    });
    return res.json({
      ok: true,
      message: result.processedEmails
        ? `Processed ${result.processedEmails} email(s) with statement attachments`
        : 'Scan complete — no new statement emails',
      ...result,
    });
  } catch (error) {
    console.error('Email scan error:', error);
    return res.status(500).json({ error: error.message || 'Email scan failed' });
  }
});

export default router;
