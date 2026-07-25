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

/** POST /api/backup/run — manual "Back Up Company" / Save & Exit (auth required) */
router.post('/run', authMiddleware, async (req, res) => {
  try {
    const reason = String(req.body?.reason || 'manual').slice(0, 40) || 'manual';
    const result = await runBackup({ reason, userId: req.user?.id });
    if (result.skipped) {
      return res.status(409).json(result);
    }
    const mb = ((result.backup.sizeBytes || 0) / (1024 * 1024)).toFixed(1);
    res.json({
      ok: true,
      message: `Backup saved: ${result.backup.filename} (${mb} MB)`,
      backup: result.backup,
    });
  } catch (err) {
    console.error('Backup /run failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
