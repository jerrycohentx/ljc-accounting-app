import express from 'express';
import { getDatabase } from '../config/database.js';
import { entityAccessMiddleware, requireRole } from '../middleware/auth.js';
import { previewAccrual, postAccrualBatch } from '../lib/interest-accrual.js';

const router = express.Router({ mergeParams: true });

router.get('/preview', entityAccessMiddleware, async (req, res) => {
  try {
    const { asOfDate } = req.query;
    if (!asOfDate) return res.status(400).json({ error: 'asOfDate required' });
    const db = await getDatabase();
    const preview = await previewAccrual(db, req.entityId, asOfDate);
    res.json(preview);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/post', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const { asOfDate } = req.body;
    if (!asOfDate) return res.status(400).json({ error: 'asOfDate required' });
    const db = await getDatabase();
    const result = await postAccrualBatch(db, {
      entityId: req.entityId,
      asOfDate,
      userId: req.user.id,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
