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
import Decimal from 'decimal.js';
import { getDatabase } from '../config/database.js';
import { parseOFX, validateTransactions, deduplicateTransactions } from '../lib/ofx-parser.js';

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
    const { importId, accountMappings = {} } = req.body;

    if (!importId) {
      return res.status(400).json({ error: 'Import ID required' });
    }

    const session = importSessions.get(importId);
    if (!session) {
      return res.status(404).json({ error: 'Import session not found' });
    }

    const db = await getDatabase();
    const userId = req.user.id; // From auth middleware

    // Get entity and account info
    const entity = await db.get('SELECT * FROM entities WHERE id = ?', session.entityId);
    if (!entity) {
      return res.status(404).json({ error: 'Entity not found' });
    }

    // Get bank account for this entity
    const bankAccount = await db.get(
      'SELECT * FROM accounts WHERE entity_id = ? AND account_number = ?',
      [session.entityId, '1000']
    );
    if (!bankAccount) {
      return res.status(404).json({ error: 'Bank account not found for entity' });
    }

    // Get or create Undeposited Funds account
    let undepositedAccount = await db.get(
      'SELECT * FROM accounts WHERE entity_id = ? AND account_number = ?',
      [session.entityId, '1100']
    );
    if (!undepositedAccount) {
      const accId = `acc-${uuidv4()}`;
      await db.run(
        `INSERT INTO accounts (
          id, entity_id, account_number, account_name, account_type, normal_balance, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [accId, session.entityId, '1100', 'Undeposited Funds', 'ASSET', 'DEBIT']
      );
      undepositedAccount = { id: accId };
    }

    // Process each transaction
    const importedTransactions = [];
    let createdJECount = 0;

    for (const txn of session.transactions) {
      try {
        const jeId = `je-${uuidv4()}`;
        const jeNumber = `IMP-${Date.now()}-${uuidv4().substring(0, 8)}`;
        const glId1 = `gl-${uuidv4()}`;
        const glId2 = `gl-${uuidv4()}`;

        // Determine if this is a deposit or withdrawal
        const isDeposit = txn.isCredit;
        const amount = Math.abs(txn.amount);

        // For deposits: debit bank, credit undeposited funds
        // For withdrawals: credit bank, debit undeposited funds (or expense account)
        const debitAmount = isDeposit ? amount : 0;
        const creditAmount = !isDeposit ? amount : 0;

        // Create journal entry (DRAFT status)
        await db.run(
          `INSERT INTO journal_entries (
            id, entity_id, je_number, description, posting_date, status,
            created_by, total_debit, total_credit, memo
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            jeId,
            session.entityId,
            jeNumber,
            `Bank Import: ${txn.description}`,
            txn.date,
            'DRAFT',
            userId,
            debitAmount,
            creditAmount,
            `OFX Import - FITID: ${txn.fitid}`
          ]
        );

        // Create GL entries
        // Line 1: Bank account
        await db.run(
          `INSERT INTO general_ledger (
            id, entity_id, account_id, journal_entry_id, debit, credit,
            posting_date, description
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            glId1,
            session.entityId,
            bankAccount.id,
            jeId,
            debitAmount,
            creditAmount,
            txn.date,
            `Bank: ${txn.description}`
          ]
        );

        // Line 2: Undeposited Funds (offset)
        await db.run(
          `INSERT INTO general_ledger (
            id, entity_id, account_id, journal_entry_id, debit, credit,
            posting_date, description
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            glId2,
            session.entityId,
            undepositedAccount.id,
            jeId,
            creditAmount,
            debitAmount,
            txn.date,
            `Pending: ${txn.description}`
          ]
        );

        // Store transaction metadata for reconciliation
        await db.run(
          `INSERT OR REPLACE INTO import_transactions (
            fitid, import_id, entity_id, account_id, journal_entry_id,
            date, amount, description, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            txn.fitid,
            importId,
            session.entityId,
            bankAccount.id,
            jeId,
            txn.date,
            txn.amount,
            txn.description,
            'DRAFT',
            new Date().toISOString()
          ]
        );

        importedTransactions.push({
          fitid: txn.fitid,
          jeNumber,
          status: 'DRAFT'
        });
        createdJECount++;
      } catch (error) {
        console.error(`Error importing transaction ${txn.fitid}:`, error);
      }
    }

    // Update import session
    session.status = 'COMPLETED';
    session.importedCount = createdJECount;
    session.completedAt = new Date().toISOString();

    return res.json({
      importId,
      status: 'COMPLETED',
      transactionsProcessed: createdJECount,
      journalEntriesCreated: createdJECount,
      message: `Successfully imported ${createdJECount} transactions as draft journal entries`,
      nextSteps: 'Review and reconcile transactions, then post to general ledger'
    });
  } catch (error) {
    console.error('Transaction import error:', error);
    return res.status(500).json({
      error: 'Failed to import transactions',
      details: error.message
    });
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

export default router;
