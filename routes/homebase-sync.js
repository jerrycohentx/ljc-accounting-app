import express from 'express';
import { getDatabase } from '../config/database.js';
import { entityAccessMiddleware, requireRole } from '../middleware/auth.js';
import { runHomebaseSync, isHomebaseConfigured } from '../lib/homebase-sync.js';

const router = express.Router({ mergeParams: true });

function defaultDateRange() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 14);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

router.get('/status', entityAccessMiddleware, async (req, res) => {
  res.json({ configured: isHomebaseConfigured() });
});

router.post('/run', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    if (!isHomebaseConfigured()) {
      return res.status(400).json({ error: 'HOMEBASE_API_KEY is not configured on the server.' });
    }
    const defaults = defaultDateRange();
    const startDate = req.body?.startDate || defaults.startDate;
    const endDate = req.body?.endDate || defaults.endDate;

    const db = await getDatabase();
    const result = await runHomebaseSync(db, {
      startDate,
      endDate,
      userId: req.user.id,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
