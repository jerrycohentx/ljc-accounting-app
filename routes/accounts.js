import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../config/database.js';
import { entityAccessMiddleware, requireRole } from '../middleware/auth.js';

const router = express.Router({ mergeParams: true });

// GET /api/entities/:entityId/accounts - List accounts for entity
router.get('/', entityAccessMiddleware, async (req, res) => {
  try {
    const db = await getDatabase();
    const accounts = await db.all(
      `SELECT id, account_number, account_name, account_type, parent_account_id, 
              description, is_active, normal_balance, created_at
       FROM accounts 
       WHERE entity_id = ? AND is_active = 1
       ORDER BY account_number`,
      req.entityId
    );

    // Build hierarchy
    const buildTree = (accounts, parentId = null) => {
      return accounts
        .filter(a => a.parent_account_id === parentId)
        .map(a => ({
          ...a,
          children: buildTree(accounts, a.id)
        }));
    };

    const tree = buildTree(accounts);
    res.json(tree);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/entities/:entityId/accounts/:id - Get single account
router.get('/:id', entityAccessMiddleware, async (req, res) => {
  try {
    const db = await getDatabase();
    const account = await db.get(
      'SELECT * FROM accounts WHERE id = ? AND entity_id = ?',
      [req.params.id, req.entityId]
    );

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Get balance
    const balance = await db.get(
      `SELECT 
        COALESCE(SUM(debit), 0) as total_debit,
        COALESCE(SUM(credit), 0) as total_credit
       FROM general_ledger 
       WHERE account_id = ? AND entity_id = ?`,
      [req.params.id, req.entityId]
    );

    res.json({
      ...account,
      balance: {
        debit: balance.total_debit,
        credit: balance.total_credit,
        computed: account.normal_balance === 'DEBIT' 
          ? balance.total_debit - balance.total_credit
          : balance.total_credit - balance.total_debit
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/accounts - Create account
router.post('/', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const { accountNumber, accountName, accountType, parentAccountId, description } = req.body;

    if (!accountNumber || !accountName || !accountType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const db = await getDatabase();

    // Check for duplicate account number in entity
    const existing = await db.get(
      'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
      [req.entityId, accountNumber]
    );

    if (existing) {
      return res.status(409).json({ error: 'Account number already exists' });
    }

    const normalBalance = ['ASSET', 'EXPENSE'].includes(accountType) ? 'DEBIT' : 'CREDIT';
    const accountId = `acc-${uuidv4()}`;

    await db.run(
      `INSERT INTO accounts 
       (id, entity_id, account_number, account_name, account_type, parent_account_id, 
        description, normal_balance) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountId, req.entityId, accountNumber, accountName, accountType, 
       parentAccountId || null, description, normalBalance]
    );

    res.status(201).json({
      id: accountId,
      accountNumber,
      accountName,
      accountType,
      parentAccountId,
      description,
      normalBalance
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/entities/:entityId/accounts/:id - Update account
router.put('/:id', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const { accountName, description, isActive, parentAccountId } = req.body;
    const db = await getDatabase();

    const account = await db.get(
      'SELECT * FROM accounts WHERE id = ? AND entity_id = ?',
      [req.params.id, req.entityId]
    );

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    await db.run(
      `UPDATE accounts 
       SET account_name = ?, description = ?, is_active = ?, parent_account_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND entity_id = ?`,
      [accountName || account.account_name, description || account.description, 
       isActive !== undefined ? isActive : account.is_active, 
       parentAccountId !== undefined ? parentAccountId : account.parent_account_id,
       req.params.id, req.entityId]
    );

    res.json({ message: 'Account updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/entities/:entityId/accounts/:id - Soft delete (deactivate)
router.delete('/:id', [entityAccessMiddleware, requireRole('ADMIN')], async (req, res) => {
  try {
    const db = await getDatabase();

    const account = await db.get(
      'SELECT * FROM accounts WHERE id = ? AND entity_id = ?',
      [req.params.id, req.entityId]
    );

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Check if account has GL entries
    const hasEntries = await db.get(
      'SELECT COUNT(*) as count FROM general_ledger WHERE account_id = ?',
      req.params.id
    );

    if (hasEntries.count > 0) {
      return res.status(409).json({ error: 'Cannot delete account with GL entries. Deactivate instead.' });
    }

    // Soft delete by deactivating
    await db.run(
      'UPDATE accounts SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      req.params.id
    );

    res.json({ message: 'Account deactivated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
