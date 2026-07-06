/**
 * Feed automation status — Plaid, email ingest, folder auto-load.
 */

import express from 'express';
import { getDatabase } from '../config/database.js';
import { getPlaidAutoSyncStatus } from '../lib/plaid-auto-sync.js';
import { getStatementAutoLoadStatus } from '../lib/statement-auto-load.js';
import { getStatementEmailIngestStatus } from '../lib/statement-email-ingest.js';
import { getPendingFeedCount } from '../lib/dashboard-entities.js';

const router = express.Router();

function computeNextRun(lastRunAt, intervalHours) {
  if (!lastRunAt || !intervalHours) return null;
  return new Date(new Date(lastRunAt).getTime() + intervalHours * 60 * 60 * 1000).toISOString();
}

router.get('/status', async (req, res) => {
  try {
    const db = await getDatabase();
    const plaid = getPlaidAutoSyncStatus();
    const email = await getStatementEmailIngestStatus(db);
    const autoLoad = getStatementAutoLoadStatus();
    const pendingReviewCount = await getPendingFeedCount(db);

    res.json({
      lastUpdated: new Date().toISOString(),
      pendingReviewCount,
      plaid: {
        ...plaid,
        nextScheduledRun: plaid.nextScheduledRun
          || computeNextRun(plaid.lastRunAt, plaid.intervalHours),
      },
      email: {
        enabled: email.enabled,
        intervalHours: email.intervalHours,
        lastRunAt: email.lastRunAt,
        lastRunError: email.lastRunError,
        lastRunSummary: email.lastRunSummary,
        nextScheduledRun: computeNextRun(email.lastRunAt, email.intervalHours),
      },
      autoLoad: {
        ...autoLoad,
        nextScheduledRun: computeNextRun(autoLoad.lastRunAt, autoLoad.intervalHours),
      },
      dailyFeedRunHour: process.env.DAILY_FEED_RUN_HOUR || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
