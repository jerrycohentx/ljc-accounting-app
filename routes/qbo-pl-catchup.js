import express from 'express';
import { getDatabase } from '../config/database.js';
import { runQboPlCatchUp, previewQboPlCatchUp } from '../lib/qbo-pl-catchup.js';

const router = express.Router();

function integrationKeyOk(req) {
  const key = req.headers['x-loan-tracker-key'];
  const expected = process.env.LOAN_TRACKER_INTEGRATION_KEY;
  return expected && key && key === expected;
}

/** GET /api/qbo-pl-catchup/preview — preview Jan 2026 QBO P&L deltas */
router.get('/preview', async (req, res) => {
  if (!integrationKeyOk(req)) {
    return res.status(401).json({ error: 'Invalid integration key' });
  }
  try {
    const db = await getDatabase();
    const preview = await previewQboPlCatchUp(db);
    res.json({ ok: true, ...preview });
  } catch (error) {
    console.error('QBO P&L preview failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/qbo-pl-catchup — idempotent QBO Jan 2026 P&L catch-up for ent-ljc */
router.post('/', async (req, res) => {
  if (!integrationKeyOk(req)) {
    return res.status(401).json({ error: 'Invalid integration key' });
  }
  try {
    const db = await getDatabase();
    const userId = process.env.LOAN_TRACKER_USER_EMAIL
      ? (await db.get('SELECT id FROM users WHERE email = ?', process.env.LOAN_TRACKER_USER_EMAIL))?.id
      : null;
    const result = await runQboPlCatchUp(db, { userId: userId || 'usr-admin' });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('QBO P&L catch-up failed:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
