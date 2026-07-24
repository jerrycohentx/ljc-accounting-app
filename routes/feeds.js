/**
 * Feed automation status — Plaid, email ingest, folder auto-load.
 */

import express from 'express';
import { getDatabase } from '../config/database.js';
import { getPlaidAutoSyncStatus } from '../lib/plaid-auto-sync.js';
import { getStatementAutoLoadStatus } from '../lib/statement-auto-load.js';
import { getStatementEmailIngestStatus } from '../lib/statement-email-ingest.js';
import { getPendingFeedCount } from '../lib/dashboard-entities.js';
import { isRebuildFreezeActive } from '../lib/rebuild-freeze.js';

const router = express.Router();

function computeNextRun(lastRunAt, intervalHours, workersRunning) {
  if (!workersRunning || !intervalHours) return null;
  if (lastRunAt) {
    return new Date(new Date(lastRunAt).getTime() + intervalHours * 60 * 60 * 1000).toISOString();
  }
  // Workers just started — next tick is within one interval from now.
  return new Date(Date.now() + intervalHours * 60 * 60 * 1000).toISOString();
}

router.get('/status', async (req, res) => {
  try {
    const db = await getDatabase();
    const freeze = isRebuildFreezeActive();
    const workersRunning = !freeze;
    const plaid = getPlaidAutoSyncStatus();
    const email = await getStatementEmailIngestStatus(db);
    const autoLoad = getStatementAutoLoadStatus();
    const pendingReviewCount = await getPendingFeedCount(db);

    res.json({
      lastUpdated: new Date().toISOString(),
      rebuildFreeze: freeze,
      autoImportersRunning: workersRunning,
      pendingReviewCount,
      plaid: {
        ...plaid,
        runningScheduled: workersRunning && plaid.enabled,
        nextScheduledRun: workersRunning
          ? (plaid.nextScheduledRun || computeNextRun(plaid.lastRunAt, plaid.intervalHours, true))
          : null,
      },
      email: {
        enabled: email.enabled,
        runningScheduled: workersRunning && email.enabled,
        intervalHours: email.intervalHours,
        lastRunAt: email.lastRunAt,
        lastRunError: email.lastRunError,
        lastRunSummary: email.lastRunSummary,
        nextScheduledRun: workersRunning && email.enabled
          ? computeNextRun(email.lastRunAt, email.intervalHours, true)
          : null,
      },
      autoLoad: {
        ...autoLoad,
        runningScheduled: workersRunning && autoLoad.enabled,
        nextScheduledRun: workersRunning && autoLoad.enabled
          ? computeNextRun(autoLoad.lastRunAt, autoLoad.intervalHours, true)
          : null,
      },
      dailyFeedRunHour: process.env.DAILY_FEED_RUN_HOUR || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
