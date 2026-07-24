import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { getDatabase } from '../config/database.js';
import { entityAccessMiddleware, requireRole } from '../middleware/auth.js';

const router = express.Router({ mergeParams: true });

// Helper: Get account balance
async function getAccountBalance(db, accountId, entityId, asOfDate = null) {
  let query = `
    SELECT 
      COALESCE(SUM(debit), 0) as total_debit,
      COALESCE(SUM(credit), 0) as total_credit
    FROM general_ledger
    WHERE account_id = ? AND entity_id = ?
  `;
  const params = [accountId, entityId];

  if (asOfDate) {
    query += ' AND posting_date <= ?';
    params.push(asOfDate);
  }

  const result = await db.get(query, params);
  const debit = new Decimal(result.total_debit || 0);
  const credit = new Decimal(result.total_credit || 0);

  return {
    debit: debit.toNumber(),
    credit: credit.toNumber(),
    balance: debit.minus(credit).toNumber()
  };
}

// GET /api/entities/:entityId/reconciliations - List reconciliations
router.get('/', entityAccessMiddleware, async (req, res) => {
  try {
    const { status, type, page = 1, limit = 50 } = req.query;
    const db = await getDatabase();

    let query = 'SELECT * FROM reconciliations WHERE entity_id = ?';
    const params = [req.entityId];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    if (type) {
      query += ' AND reconciliation_type = ?';
      params.push(type);
    }

    query += ' ORDER BY as_of_date DESC, created_at DESC LIMIT ? OFFSET ?';
    const offset = (parseInt(page) - 1) * parseInt(limit);
    params.push(parseInt(limit), offset);

    const reconciliations = await db.all(query, params);

    res.json({
      data: reconciliations,
      pagination: { page: parseInt(page), limit: parseInt(limit) }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/entities/:entityId/reconciliations/:id - Get single reconciliation
router.get('/:id', entityAccessMiddleware, async (req, res) => {
  try {
    const db = await getDatabase();
    const recon = await db.get(
      'SELECT * FROM reconciliations WHERE id = ? AND entity_id = ?',
      [req.params.id, req.entityId]
    );

    if (!recon) {
      return res.status(404).json({ error: 'Reconciliation not found' });
    }

    res.json(recon);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/reconciliations - Create reconciliation
router.post('/', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const { accountId, reconciliationType, counterpartyEntityId, ourBalance, theirBalance, asOfDate, notes } = req.body;

    if (!accountId || !reconciliationType || !asOfDate) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const db = await getDatabase();

    // Verify account exists
    const account = await db.get(
      'SELECT * FROM accounts WHERE id = ? AND entity_id = ?',
      [accountId, req.entityId]
    );

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const reconId = `recon-${uuidv4()}`;
    const variance = ourBalance && theirBalance 
      ? new Decimal(ourBalance).minus(theirBalance).toNumber()
      : null;

    const status = ourBalance === theirBalance ? 'MATCHED' : (variance ? 'VARIANCE' : 'PENDING');

    await db.run(
      `INSERT INTO reconciliations 
       (id, entity_id, counterparty_entity_id, account_id, reconciliation_type, status, 
        our_balance, their_balance, variance, as_of_date, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [reconId, req.entityId, counterpartyEntityId || null, accountId, reconciliationType,
       status, ourBalance || 0, theirBalance || null, variance, asOfDate, notes, req.user.id]
    );

    res.status(201).json({
      id: reconId,
      status,
      variance
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/entities/:entityId/reconciliations/:id - Update reconciliation
router.put('/:id', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const { theirBalance, status, notes } = req.body;
    const db = await getDatabase();

    const recon = await db.get(
      'SELECT * FROM reconciliations WHERE id = ? AND entity_id = ?',
      [req.params.id, req.entityId]
    );

    if (!recon) {
      return res.status(404).json({ error: 'Reconciliation not found' });
    }

    // Calculate new variance
    let newStatus = status || recon.status;
    let newVariance = recon.variance;

    if (theirBalance !== undefined) {
      newVariance = new Decimal(recon.our_balance).minus(theirBalance).toNumber();
      newStatus = newVariance === 0 ? 'MATCHED' : 'VARIANCE';
    }

    await db.run(
      `UPDATE reconciliations 
       SET their_balance = ?, status = ?, variance = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [theirBalance !== undefined ? theirBalance : recon.their_balance,
       newStatus, newVariance, notes || recon.notes, req.params.id]
    );

    res.json({ message: 'Reconciliation updated', status: newStatus, variance: newVariance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/reconciliations/:id/resolve - Resolve reconciliation
router.post('/:id/resolve', [entityAccessMiddleware, requireRole('ADMIN')], async (req, res) => {
  try {
    const { notes, journalEntryId } = req.body;
    const db = await getDatabase();

    const recon = await db.get(
      'SELECT * FROM reconciliations WHERE id = ? AND entity_id = ?',
      [req.params.id, req.entityId]
    );

    if (!recon) {
      return res.status(404).json({ error: 'Reconciliation not found' });
    }

    if (recon.status === 'RESOLVED') {
      return res.status(409).json({ error: 'Already resolved' });
    }

    // Hard rule: never resolve with an open variance or plug JE.
    if (Math.abs(recon.variance) > 0.01) {
      return res.status(409).json({
        error: 'Variance must be $0.00 to resolve. Plug / force-balance journal entries are prohibited.',
        code: 'RECON_VARIANCE_BLOCKED',
        variance: recon.variance,
      });
    }

    await db.run(
      `UPDATE reconciliations 
       SET status = 'RESOLVED', resolved_date = CURRENT_TIMESTAMP, notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [notes || recon.notes, req.params.id]
    );

    res.json({ message: 'Reconciliation resolved' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/entities/:entityId/reconciliations/intercompany/analysis - Intercompany analysis
router.get('/intercompany/analysis', entityAccessMiddleware, async (req, res) => {
  try {
    const { asOfDate } = req.query;
    const db = await getDatabase();

    // Get all Due-From/Due-To accounts
    const accounts = await db.all(
      `SELECT id, account_number, account_name, account_type
       FROM accounts
       WHERE entity_id = ? AND account_name LIKE '%Due%'`,
      req.entityId
    );

    const analysis = [];

    for (const acc of accounts) {
      const balance = await getAccountBalance(db, acc.id, req.entityId, asOfDate);
      
      // Get related reconciliations
      const recons = await db.all(
        `SELECT * FROM reconciliations
         WHERE account_id = ? AND entity_id = ? 
         ORDER BY as_of_date DESC LIMIT 1`,
        [acc.id, req.entityId]
      );

      analysis.push({
        accountNumber: acc.account_number,
        accountName: acc.account_name,
        balance: balance.balance,
        lastReconciliation: recons[0] || null,
        status: recons[0]?.status || 'UNRECONCILED'
      });
    }

    res.json({
      asOfDate: asOfDate || new Date().toISOString().split('T')[0],
      intercompanyAccounts: analysis
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/reconciliations/intercompany/match - Match intercompany accounts
router.post('/intercompany/match', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const { accountId, counterpartyEntityId, counterpartyAccountId, asOfDate } = req.body;
    const db = await getDatabase();

    // Get both account balances
    const ourBalance = await getAccountBalance(db, accountId, req.entityId, asOfDate);
    const theirBalance = await getAccountBalance(db, counterpartyAccountId, counterpartyEntityId, asOfDate);

    // Mirror accounts should have opposite balances
    const variance = new Decimal(ourBalance.balance).plus(theirBalance.balance).abs().toNumber();
    const matched = variance < 0.01;

    const reconId = `recon-${uuidv4()}`;

    await db.run(
      `INSERT INTO reconciliations 
       (id, entity_id, counterparty_entity_id, account_id, reconciliation_type, 
        status, our_balance, their_balance, variance, as_of_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [reconId, req.entityId, counterpartyEntityId, accountId, 'INTERCOMPANY',
       matched ? 'MATCHED' : 'VARIANCE', ourBalance.balance, 
       new Decimal(theirBalance.balance).negated().toNumber(), 
       variance, asOfDate, req.user.id]
    );

    res.status(201).json({
      id: reconId,
      ourBalance: ourBalance.balance,
      theirBalance: theirBalance.balance,
      variance,
      matched
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
