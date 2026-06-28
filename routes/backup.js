import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { runBackup, listBackups, getBackupStatus } from '../lib/app-backup.js';
import { getAppInfo } from '../lib/app-info.js';

const router = express.Router();

router.use(authMiddleware);

/** GET /api/backup/status — version + latest backup (loan tracker sidebar pattern) */
router.get('/status', async (req, res) => {
  try {
    res.json({
      app: getAppInfo(),
      backup: getBackupStatus(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/backup/list */
router.get('/list', async (req, res) => {
  try {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    res.json({ backups: listBackups(limit), ...getBackupStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/backup/run — manual "Back Up Company" */
router.post('/run', async (req, res) => {
  try {
    const result = await runBackup({ reason: 'manual', userId: req.user?.id });
    if (result.skipped) {
      return res.status(409).json(result);
    }
    res.json({ ok: true, message: `Backup saved: ${result.backup.filename}`, backup: result.backup });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
