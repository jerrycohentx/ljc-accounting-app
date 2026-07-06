import express from 'express';
import { getDatabase } from '../config/database.js';
import { LJC_ENTITY_ID } from '../lib/ach-je-import.js';
import { runAchJeInboxScan, getAchJeInboxScanStatus } from '../lib/ach-je-inbox-worker.js';
import { listLoanTrackerEvents } from '../lib/loan-event-ingest.js';
import { buildPlatformHealthPayload } from '../lib/platform-health.js';
import { loadAutomationManifest } from '../lib/automation-manifest.js';
import { requireRole } from '../middleware/auth.js';

const router = express.Router();

router.get('/manifest', (_req, res) => {
  res.json(loadAutomationManifest());
});

router.get('/status', async (req, res) => {
  try {
    const db = await getDatabase();
    res.json({
      achJeInboxScan: getAchJeInboxScanStatus(),
      loanEventsPending: (await listLoanTrackerEvents(db, { limit: 5 })).length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/loan-events', requireRole('ADMIN', 'ACCOUNTANT'), async (req, res) => {
  try {
    const db = await getDatabase();
    const events = await listLoanTrackerEvents(db, {
      entityId: req.query.entityId || LJC_ENTITY_ID,
      status: req.query.status || 'PENDING',
      limit: Number(req.query.limit || 50),
    });
    res.json({ events });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/ach-je/scan', requireRole('ADMIN'), async (req, res) => {
  try {
    const summary = await runAchJeInboxScan(getDatabase, { reason: 'manual' });
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

export { buildPlatformHealthPayload, runAchJeInboxScan, getAchJeInboxScanStatus };
