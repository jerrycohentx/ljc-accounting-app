import express from 'express';
import { getDatabase } from '../config/database.js';
import {
  runQboPlCatchUp,
  runAllQboPlCatchUps,
  previewQboPlCatchUp,
  verifyQboPlYtd,
  getQboPlConfig,
  QBO_PL_PERIODS_2026,
} from '../lib/qbo-pl-catchup.js';
import { QBO_PL_JAN_2026 } from '../config/qbo-pl-jan2026-targets.js';

const router = express.Router();

function integrationKeyOk(req) {
  const key = req.headers['x-loan-tracker-key'];
  const expected = process.env.LOAN_TRACKER_INTEGRATION_KEY;
  return expected && key && key === expected;
}

function resolveConfig(req) {
  const period = req.query.period || req.body?.period;
  if (!period || period === 'all' || period === '2026') return null;
  return getQboPlConfig(period) || QBO_PL_JAN_2026;
}

/** GET /api/qbo-pl-catchup/preview?period=feb-jun|jan|all */
router.get('/preview', async (req, res) => {
  if (!integrationKeyOk(req)) {
    return res.status(401).json({ error: 'Invalid integration key' });
  }
  try {
    const db = await getDatabase();
    const period = req.query.period || 'jan';
    if (period === 'all' || period === '2026') {
      const previews = [];
      for (const config of QBO_PL_PERIODS_2026) {
        previews.push(await previewQboPlCatchUp(db, config));
      }
      return res.json({ ok: true, previews });
    }
    const config = resolveConfig(req) || QBO_PL_JAN_2026;
    const preview = await previewQboPlCatchUp(db, config);
    res.json({ ok: true, ...preview });
  } catch (error) {
    console.error('QBO P&L preview failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/qbo-pl-catchup — ?period=all runs Jan + Feb–Jun; default all */
router.post('/', async (req, res) => {
  if (!integrationKeyOk(req)) {
    return res.status(401).json({ error: 'Invalid integration key' });
  }
  try {
    const db = await getDatabase();
    const userId = process.env.LOAN_TRACKER_USER_EMAIL
      ? (await db.get('SELECT id FROM users WHERE email = ?', process.env.LOAN_TRACKER_USER_EMAIL))?.id
      : null;
    const period = req.query.period || req.body?.period || 'all';

    if (period === 'all' || period === '2026') {
      const result = await runAllQboPlCatchUps(db, { userId: userId || 'usr-admin' });
      return res.json({ ok: true, ...result });
    }

    const config = resolveConfig(req) || QBO_PL_JAN_2026;
    const result = await runQboPlCatchUp(db, { userId: userId || 'usr-admin', config });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('QBO P&L catch-up failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/qbo-pl-catchup/verify-ytd — combined Jan–Jun 27 vs QBO */
router.get('/verify-ytd', async (req, res) => {
  if (!integrationKeyOk(req)) {
    return res.status(401).json({ error: 'Invalid integration key' });
  }
  try {
    const db = await getDatabase();
    const ytd = await verifyQboPlYtd(db);
    res.json({ ok: true, ytd });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
