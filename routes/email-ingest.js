import express from 'express';
import { getDatabase } from '../config/database.js';
import {
  getStatementEmailIngestStatus,
  runStatementEmailIngest,
} from '../lib/statement-email-ingest.js';
import { buildEmailIngestMessage } from '../lib/email-ingest-message.js';

const router = express.Router();

router.get('/status', async (req, res) => {
  try {
    const db = await getDatabase();
    return res.json(await getStatementEmailIngestStatus(db));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    const db = await getDatabase();
    const limit = Math.min(50, Number(req.query.limit) || 20);
    const rows = await db.all(
      `SELECT message_id, subject, from_address, received_at, attachment_count, status, result_summary, error_message, processed_at
       FROM email_import_log ORDER BY processed_at DESC LIMIT ?`,
      [limit]
    ).catch(() => []);
    return res.json({ imports: rows || [] });
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
    const message = buildEmailIngestMessage(result);
    return res.json({ ok: true, message, ...result });
  } catch (error) {
    console.error('Manual email ingest error:', error);
    return res.status(500).json({ error: error.message || 'Email ingest failed' });
  }
});

export default router;
