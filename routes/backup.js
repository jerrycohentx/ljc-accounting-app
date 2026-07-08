import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { runBackup, listBackups, getBackupStatus, getBackupContent } from '../lib/app-backup.js';
import { getAppInfo } from '../lib/app-info.js';
import { getDatabase, isPostgres } from '../config/database.js';
import { getStatementEmailIngestStatus } from '../lib/statement-email-ingest.js';

const router = express.Router();

/** GET /api/backup/status — public (login screen shows version before sign-in) */
router.get('/status', async (req, res) => {
  try {
    const db = await getDatabase();
    res.json({
      app: getAppInfo(),
      backup: getBackupStatus(),
      statementEmailIngest: await getStatementEmailIngestStatus(db),
      database: {
        type: isPostgres() ? 'postgres' : 'sqlite',
        label: isPostgres() ? 'PostgreSQL (cloud)' : 'SQLite (local)',
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/backup/list — public (login screen shows backup history before sign-in) */
router.get('/list', async (req, res) => {
  try {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    res.json({ backups: listBackups(limit), ...getBackupStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/backup/download/:id — download a stored backup off-site (auth required) */
router.get('/download/:id', authMiddleware, async (req, res) => {
  try {
    const item = await getBackupContent(req.params.id);
    if (!item) return res.status(404).json({ error: 'Backup not found' });
    const isJson = String(item.filename).endsWith('.json');
    res.setHeader('Content-Type', isJson ? 'application/json' : 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${item.filename}"`);
    res.send(item.content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/backup/run — manual "Back Up Company" or Save & Exit (auth required) */
router.post('/run', authMiddleware, async (req, res) => {
  try {
    const reason = req.body?.reason === 'close' ? 'close' : 'manual';
    const wait = reason === 'close' || req.body?.wait === true;
    const result = await runBackup({ reason, userId: req.user?.id, wait });
    if (result.skipped && !result.ok) {
      return res.status(409).json(result);
    }
    if (result.skipped && result.ok) {
      return res.json({
        ok: true,
        skipped: true,
        message: result.message || 'Backup already in progress — latest snapshot is current',
        backup: result.backup,
      });
    }
    res.json({ ok: true, message: `Backup saved: ${result.backup.filename}`, backup: result.backup });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
