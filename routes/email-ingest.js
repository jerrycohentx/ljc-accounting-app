import express from 'express';
import { getDatabase } from '../config/database.js';
import {
  getStatementEmailIngestStatus,
  runStatementEmailIngest,
} from '../lib/statement-email-ingest.js';

const router = express.Router();

router.get('/status', async (req, res) => {
  try {
    return res.json(getStatementEmailIngestStatus());
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/run', async (req, res) => {
  try {
    const db = await getDatabase();
    const result = await runStatementEmailIngest(db, {
      reason: 'manual',
      userId: req.user?.id || 'usr-admin',
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Manual email ingest error:', error);
    return res.status(500).json({ error: error.message || 'Email ingest failed' });
  }
});

export default router;
