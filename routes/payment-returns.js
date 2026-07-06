/**
 * Payment returns — NSF / wire return / bank NSF fee detection from bank feeds.
 * Loan Servicing polls pending-sync; accounting stores suggestions only until proof + rules match.
 */
import express from 'express';
import { getDatabase } from '../config/database.js';
import {
  ackPaymentReturnSync,
  draftOrPostPaymentReturnJe,
  listPendingPaymentReturnSync,
} from '../lib/bank-return-match.js';
import { ensurePaymentReturnSchema } from '../lib/payment-return-schema.js';

const router = express.Router();

router.use(async (req, res, next) => {
  try {
    const db = await getDatabase();
    await ensurePaymentReturnSchema(db);
    req.db = db;
    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/payment-returns/pending-sync?entityId=ent-ljc — loan app poll */
router.get('/pending-sync', async (req, res) => {
  try {
    const entityId = req.query.entityId || 'ent-ljc';
    const returns = await listPendingPaymentReturnSync(req.db, entityId);
    res.json({ returns, count: returns.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/payment-returns/:id/ack-sync — loan app acknowledges sync */
router.post('/:id/ack-sync', async (req, res) => {
  try {
    const result = await ackPaymentReturnSync(req.db, req.params.id);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/** GET /api/payment-returns/pending?entityId=ent-ljc — accounting review queue */
router.get('/pending', async (req, res) => {
  try {
    const entityId = req.query.entityId || 'ent-ljc';
    const rows = await req.db.all(
      `SELECT pr.*, it.date AS bank_date, it.amount AS bank_amount
       FROM payment_returns pr
       LEFT JOIN import_transactions it ON it.id = pr.import_transaction_id
       WHERE pr.entity_id = ? AND pr.status IN ('pending', 'matched')
       ORDER BY pr.created_at DESC LIMIT 100`,
      [entityId]
    );
    res.json({ returns: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/payment-returns/:id/draft-je — create DRAFT JE from matched return */
router.post('/:id/draft-je', async (req, res) => {
  try {
    const entityId = req.body?.entityId || 'ent-ljc';
    const result = await draftOrPostPaymentReturnJe(req.db, {
      returnId: req.params.id,
      entityId,
      userId: req.user?.id || 'accountant',
      autoPost: false,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/** POST /api/payment-returns/:id/post — post JE when matched + bank proof on file */
router.post('/:id/post', async (req, res) => {
  try {
    const entityId = req.body?.entityId || 'ent-ljc';
    const row = await req.db.get('SELECT * FROM payment_returns WHERE id = ?', [req.params.id]);
    if (!row?.import_transaction_id) {
      return res.status(400).json({ error: 'Bank import line required before post' });
    }
    if (!row.loan_id && !row.holdback_draw_id) {
      return res.status(400).json({ error: 'Loan or holdback draw match required before post' });
    }
    const result = await draftOrPostPaymentReturnJe(req.db, {
      returnId: req.params.id,
      entityId,
      userId: req.user?.id || 'accountant',
      autoPost: true,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

export default router;
