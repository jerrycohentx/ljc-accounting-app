import express from 'express';
import { getDatabase } from '../config/database.js';
import { runLonestarCatchUp } from '../lib/lonestar-catchup.js';
import { runLonestarBalanceFixes } from '../lib/fix-lonestar-opening-balance.js';

const router = express.Router();

function integrationKeyOk(req) {
  const key = req.headers['x-loan-tracker-key'];
  const expected = process.env.LOAN_TRACKER_INTEGRATION_KEY;
  return expected && key && key === expected;
}

/** POST /api/lonestar-catchup — idempotent Lone Star Jan–May 2026 import on production */
router.post('/', async (req, res) => {
  if (!integrationKeyOk(req)) {
    return res.status(401).json({ error: 'Invalid integration key' });
  }

  try {
    const db = await getDatabase();
    const userId = process.env.LOAN_TRACKER_USER_EMAIL
      ? (await db.get('SELECT id FROM users WHERE email = ?', process.env.LOAN_TRACKER_USER_EMAIL))?.id
      : null;
    const result = await runLonestarCatchUp(db, { userId: userId || 'usr-admin' });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Lone Star catch-up failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/lonestar-catchup/fix-balance — correct 12/31/2025 opening balance + reverse errant true-up */
router.post('/fix-balance', async (req, res) => {
  if (!integrationKeyOk(req)) {
    return res.status(401).json({ error: 'Invalid integration key' });
  }

  try {
    const db = await getDatabase();
    const userId = process.env.LOAN_TRACKER_USER_EMAIL
      ? (await db.get('SELECT id FROM users WHERE email = ?', process.env.LOAN_TRACKER_USER_EMAIL))?.id
      : null;
    const result = await runLonestarBalanceFixes(db, { userId: userId || 'usr-admin' });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Lone Star catch-up failed:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
