import express from 'express';
import { getDatabase } from '../config/database.js';
import {
  getDocumentEmailIngestStatus,
  runDocumentEmailIngest,
  runScheduledDocumentDigest,
} from '../lib/document-email-ingest.js';

const router = express.Router();

router.get('/status', async (req, res) => {
  try {
    const db = await getDatabase();
    return res.json(await getDocumentEmailIngestStatus(db));
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
       FROM document_import_log ORDER BY processed_at DESC LIMIT ?`,
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
    const result = await runDocumentEmailIngest(db, {
      reason: 'manual',
      userId: req.user?.id || 'usr-admin',
    });
    const message = result.skipped
      ? `Skipped: ${result.reason}`
      : `Document ingest complete — ${result.draftsCreated || 0} new draft(s)`;
    return res.json({ ok: true, message, ...result });
  } catch (error) {
    console.error('Manual document ingest error:', error);
    return res.status(500).json({ error: error.message || 'Document ingest failed' });
  }
});

router.post('/digest', async (req, res) => {
  try {
    const db = await getDatabase();
    const result = await runScheduledDocumentDigest(db);
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
