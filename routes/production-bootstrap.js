import express from 'express';
import { getDatabase } from '../config/database.js';
import { runProductionBootstrap } from '../lib/production-bootstrap.js';

const router = express.Router();

function integrationKeyOk(req) {
  const key = req.headers['x-loan-tracker-key'];
  const expected = process.env.LOAN_TRACKER_INTEGRATION_KEY;
  return expected && key && key === expected;
}

/** POST /api/production-bootstrap — idempotent Cohen books setup on Render/production Postgres */
router.post('/', async (req, res) => {
  if (!integrationKeyOk(req)) {
    return res.status(401).json({ error: 'Invalid integration key' });
  }

  try {
    const db = await getDatabase();
    const userId = process.env.LOAN_TRACKER_USER_EMAIL
      ? (await db.get('SELECT id FROM users WHERE email = ?', process.env.LOAN_TRACKER_USER_EMAIL))?.id
      : null;
    const result = await runProductionBootstrap(db, {
      userId: userId || 'usr-admin',
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Production bootstrap failed:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
