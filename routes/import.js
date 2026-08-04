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
import { AIAccountingCopilotService, suggestedOffsetAccountId } from '../lib/ai-copilot-service.js';

const router = express.Router();

// In-memory store for import sessions (in production, use database)
const importSessions = new Map();

function inClause(values) {
  return values.map(() => '?').join(',');
}

function toUiCopilot(suggestion) {
  if (!suggestion) return null;
  const offset = suggestion.lines?.find((line) => line.role === 'offset') || null;
  return {
    confidenceScore: Number(suggestion.confidence_score ?? 0),
    needsReview: !!suggestion.needs_review,
    suggestedOffsetAccountId: offset?.account_id || null,
    suggestedOffsetAccountNumber: offset?.account_number || null,
    suggestedOffsetAccountName: offset?.account_name || null,
    explanation: Array.isArray(suggestion.explanation) ? suggestion.explanation : [],
    lines: (suggestion.lines || []).map((line) => ({
      role: line.role,
      account_id: line.account_id,
      account_number: line.account_number,
      account_name: line.account_name,
      debit: Number(((Number(line.debit_cents || 0)) / 100).toFixed(2)),
      credit: Number(((Number(line.credit_cents || 0)) / 100).toFixed(2)),
      rationale: line.rationale,
    })),
  };
}

async function deriveCurrentOffsetAccountId(db, txn) {
  if (!txn?.journal_entry_id) return null;
  const rows = await db.all(
    `SELECT id, account_id, debit, credit
     FROM general_ledger
     WHERE entity_id = ? AND journal_entry_id = ?
     ORDER BY created_at ASC, id ASC`,
    [txn.entity_id, txn.journal_entry_id]
  );
  if (!rows?.length) return null;
  const direct = rows.find((row) => row.account_id !== txn.account_id);
  if (direct) return direct.account_id;
  const biggest = rows
    .map((row) => ({ ...row, absAmount: Math.max(Math.abs(Number(row.debit || 0)), Math.abs(Number(row.credit || 0)) || 0) }))
    .sort((a, b) => b.absAmount - a.absAmount)[0];
  return biggest?.account_id || null;
}

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
 * GET /api/import/pending
 * Return draft imported transactions for review, including AI copilot suggestions.
 */
router.get('/pending', async (req, res) => {
  try {
    const { entityId } = req.query;
    if (!entityId) {
      return res.status(400).json({ error: 'entityId query parameter required' });
    }

    const db = await getDatabase();
    const rows = await db.all(
      `SELECT it.id, it.fitid, it.entity_id, it.account_id, it.journal_entry_id, it.date, it.amount, it.description, it.status,
              je.status AS journal_status
       FROM import_transactions it
       LEFT JOIN journal_entries je ON je.id = it.journal_entry_id
       WHERE it.entity_id = ? AND it.status = 'DRAFT'
       ORDER BY it.date ASC, it.id ASC`,
      [entityId]
    );

    if (!rows?.length) {
      return res.json({ pending: [] });
    }

    const copilot = new AIAccountingCopilotService(db, {
      entityId,
      userId: req.user?.id,
    });
    await copilot.init();

    const pending = await Promise.all((rows || []).map(async (row) => {
      const amount = Number(row.amount || 0);
      let suggestion = null;
      try {
        suggestion = await copilot.suggestForImportTransaction(row, { persist: true });
      } catch (err) {
        console.warn(`[import/pending] Copilot suggestion failed for ${row.fitid}: ${err.message}`);
      }
      const currentOffsetAccountId = await deriveCurrentOffsetAccountId(db, row);
      return {
        id: row.id,
        fitid: row.fitid,
        jeId: row.journal_entry_id,
        date: row.date,
        description: row.description || '',
        payment: amount < 0 ? Math.abs(amount) : 0,
        deposit: amount > 0 ? amount : 0,
        offsetAccountId: currentOffsetAccountId || '',
        status: row.status,
        copilot: toUiCopilot(suggestion),
      };
    }));

    return res.json({ pending });
  } catch (error) {
    console.error('Pending import fetch error:', error);
    return res.status(500).json({
      error: 'Failed to load pending imported transactions',
      details: error.message,
    });
  }
});

/**
 * PATCH /api/import/pending/:fitid
 * Update the draft offset account for a pending imported transaction.
 */
router.patch('/pending/:fitid', async (req, res) => {
  try {
    const { fitid } = req.params;
    const { entityId, offsetAccountId } = req.body || {};
    if (!entityId || !fitid) {
      return res.status(400).json({ error: 'entityId and fitid are required' });
    }
    if (!offsetAccountId) {
      return res.status(400).json({ error: 'offsetAccountId is required' });
    }

    const db = await getDatabase();
    const txn = await db.get(
      `SELECT id, fitid, entity_id, account_id, journal_entry_id, amount, description, status
       FROM import_transactions
       WHERE entity_id = ? AND fitid = ?`,
      [entityId, fitid]
    );
    if (!txn) {
      return res.status(404).json({ error: 'Imported transaction not found' });
    }
    if (txn.status !== 'DRAFT') {
      return res.status(409).json({ error: 'Only draft imported transactions can be changed' });
    }

    const offsetAccount = await db.get(
      `SELECT id, account_number, account_name
       FROM accounts
       WHERE entity_id = ? AND id = ?`,
      [entityId, offsetAccountId]
    );
    if (!offsetAccount) {
      return res.status(404).json({ error: 'Offset account not found for this entity' });
    }

    const glRows = await db.all(
      `SELECT id, account_id
       FROM general_ledger
       WHERE entity_id = ? AND journal_entry_id = ?
       ORDER BY created_at ASC, id ASC`,
      [entityId, txn.journal_entry_id]
    );
    const offsetLine = (glRows || []).find((line) => line.account_id !== txn.account_id);
    if (!offsetLine) {
      return res.status(409).json({ error: 'No offset ledger line found for this draft transaction' });
    }

    await db.run(
      `UPDATE general_ledger
       SET account_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [offsetAccount.id, offsetLine.id]
    );
    await db.run(
      `UPDATE import_transactions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [txn.id]
    );
    await db.run(
      `UPDATE journal_entries SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [txn.journal_entry_id]
    );

    const copilot = new AIAccountingCopilotService(db, {
      entityId,
      userId: req.user?.id,
    });
    await copilot.init();
    const suggestion = await copilot.suggestForImportTransaction(txn, { persist: true });
    const suggestedOffsetId = suggestedOffsetAccountId(suggestion);
    if (suggestedOffsetId && suggestedOffsetId !== offsetAccount.id) {
      await copilot.learnCorrection({
        fitid,
        offsetAccountRef: offsetAccount.id,
        reason: 'Bank Feeds reviewer changed suggested offset account.',
      });
      await copilot.setSuggestionStatus(txn.id, 'corrected');
    } else {
      await copilot.setSuggestionStatus(txn.id, 'accepted');
    }

    return res.json({
      fitid,
      offsetAccountId: offsetAccount.id,
      offsetAccountNumber: offsetAccount.account_number,
      offsetAccountName: offsetAccount.account_name,
      message: 'Draft account category updated',
    });
  } catch (error) {
    console.error('Pending account update error:', error);
    return res.status(500).json({
      error: 'Failed to update pending transaction account',
      details: error.message,
    });
  }
});

/**
 * POST /api/import/post-selected
 * Finalize selected draft imports as posted entries.
 */
router.post('/post-selected', async (req, res) => {
  try {
    const { entityId, jeIds } = req.body || {};
    if (!entityId || !Array.isArray(jeIds) || jeIds.length === 0) {
      return res.status(400).json({ error: 'entityId and jeIds[] are required' });
    }
    const uniqueJeIds = [...new Set(jeIds.map((id) => String(id || '').trim()).filter(Boolean))];
    if (!uniqueJeIds.length) {
      return res.status(400).json({ error: 'No valid journal entry ids were provided' });
    }

    const db = await getDatabase();
    const txnRows = await db.all(
      `SELECT id, fitid, journal_entry_id
       FROM import_transactions
       WHERE entity_id = ? AND status = 'DRAFT'
         AND journal_entry_id IN (${inClause(uniqueJeIds)})`,
      [entityId, ...uniqueJeIds]
    );
    if (!txnRows?.length) {
      return res.status(404).json({ error: 'No draft import transactions found for the selected journal entries' });
    }

    const jeIdsToPost = [...new Set(txnRows.map((row) => row.journal_entry_id).filter(Boolean))];
    const balancedJeIds = [];
    for (const jeId of jeIdsToPost) {
      const totals = await db.get(
        `SELECT COALESCE(SUM(debit), 0) AS total_debit, COALESCE(SUM(credit), 0) AS total_credit
         FROM general_ledger
         WHERE entity_id = ? AND journal_entry_id = ?`,
        [entityId, jeId]
      );
      const totalDebit = Number(totals?.total_debit || 0);
      const totalCredit = Number(totals?.total_credit || 0);
      if (totalDebit === 0 && totalCredit === 0) {
        return res.status(409).json({
          error: 'Cannot post entries without ledger lines',
          details: `Journal ${jeId} has no ledger lines to post.`,
        });
      }
      if (!new Decimal(totalDebit).equals(totalCredit)) {
        return res.status(409).json({
          error: 'Cannot post unbalanced entries',
          details: `Journal ${jeId} is unbalanced (debit ${totalDebit} vs credit ${totalCredit}).`,
        });
      }
      balancedJeIds.push(jeId);
    }

    await db.run(
      `UPDATE journal_entries
       SET status = 'POSTED', posted_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE entity_id = ? AND id IN (${inClause(balancedJeIds)})`,
      [entityId, ...balancedJeIds]
    );
    await db.run(
      `UPDATE import_transactions
       SET status = 'MATCHED', updated_at = CURRENT_TIMESTAMP
       WHERE entity_id = ? AND journal_entry_id IN (${inClause(balancedJeIds)})`,
      [entityId, ...balancedJeIds]
    );

    const copilot = new AIAccountingCopilotService(db, {
      entityId,
      userId: req.user?.id,
    });
    await copilot.init();
    for (const txn of txnRows) {
      const suggestion = await copilot.getLatestSuggestionForImportTransaction(txn.id);
      await copilot.setSuggestionStatus(txn.id, suggestion?.needs_review ? 'flagged' : 'posted');
    }

    return res.json({
      posted: balancedJeIds.length,
      message: `${balancedJeIds.length} transaction(s) posted and moved to register.`,
    });
  } catch (error) {
    console.error('Post selected import rows error:', error);
    return res.status(500).json({
      error: 'Failed to post selected imported transactions',
      details: error.message,
    });
  }
});

/**
 * POST /api/import/reject
 * Mark selected draft imports as rejected without deleting history.
 */
router.post('/reject', async (req, res) => {
  try {
    const { entityId, fitids } = req.body || {};
    if (!entityId || !Array.isArray(fitids) || fitids.length === 0) {
      return res.status(400).json({ error: 'entityId and fitids[] are required' });
    }
    const uniqueFitids = [...new Set(fitids.map((id) => String(id || '').trim()).filter(Boolean))];
    if (!uniqueFitids.length) {
      return res.status(400).json({ error: 'No valid fitids were provided' });
    }

    const db = await getDatabase();
    const rows = await db.all(
      `SELECT id, fitid, journal_entry_id
       FROM import_transactions
       WHERE entity_id = ? AND status = 'DRAFT'
         AND fitid IN (${inClause(uniqueFitids)})`,
      [entityId, ...uniqueFitids]
    );
    if (!rows?.length) {
      return res.status(404).json({ error: 'No draft import rows found for the provided fitids' });
    }

    await db.run(
      `UPDATE import_transactions
       SET status = 'REJECTED', updated_at = CURRENT_TIMESTAMP
       WHERE entity_id = ? AND fitid IN (${inClause(uniqueFitids)})`,
      [entityId, ...uniqueFitids]
    );

    const jeIds = [...new Set(rows.map((row) => row.journal_entry_id).filter(Boolean))];
    if (jeIds.length) {
      await db.run(
        `UPDATE journal_entries
         SET status = 'REJECTED', updated_at = CURRENT_TIMESTAMP
         WHERE entity_id = ? AND status != 'POSTED' AND id IN (${inClause(jeIds)})`,
        [entityId, ...jeIds]
      );
    }

    const copilot = new AIAccountingCopilotService(db, {
      entityId,
      userId: req.user?.id,
    });
    await copilot.init();
    for (const row of rows) {
      await copilot.setSuggestionStatus(row.id, 'rejected');
    }

    return res.json({
      rejected: rows.length,
      message: `${rows.length} transaction(s) discarded from review queue.`,
    });
  } catch (error) {
    console.error('Reject import rows error:', error);
    return res.status(500).json({
      error: 'Failed to reject imported transactions',
      details: error.message,
    });
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
