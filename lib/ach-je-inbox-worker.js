import { scanAchJeInbox } from './ach-je-inbox-scan.js';

const INTERVAL_MS = Math.max(5, Number(process.env.ACH_JE_INBOX_INTERVAL_MINUTES || 15)) * 60 * 1000;

let timer = null;
let lastRunAt = null;
let lastRunError = null;
let lastRunSummary = null;
let running = false;

export function getAchJeInboxScanStatus() {
  return {
    enabled: process.env.ACH_JE_INBOX_SCAN_ENABLED !== 'false',
    intervalMinutes: INTERVAL_MS / 60000,
    lastRunAt,
    lastRunError,
    lastRunSummary,
    running,
  };
}

export async function runAchJeInboxScan(getDatabase, { reason = 'scheduled' } = {}) {
  if (running) return { skipped: true, reason: 'already running' };
  if (process.env.ACH_JE_INBOX_SCAN_ENABLED === 'false') {
    return { skipped: true, reason: 'disabled' };
  }
  running = true;
  try {
    const db = await getDatabase();
    const summary = await scanAchJeInbox(db);
    lastRunAt = new Date().toISOString();
    lastRunError = null;
    lastRunSummary = { reason, ...summary };
    return lastRunSummary;
  } catch (error) {
    lastRunError = error.message;
    throw error;
  } finally {
    running = false;
  }
}

export function startAchJeInboxScan(getDatabase) {
  if (process.env.ACH_JE_INBOX_SCAN_ENABLED === 'false') {
    console.log('[ach-je-inbox] Scan disabled (ACH_JE_INBOX_SCAN_ENABLED=false)');
    return;
  }
  if (timer) return;
  console.log(`[ach-je-inbox] Scan every ${INTERVAL_MS / 60000} min`);
  const tick = () => {
    runAchJeInboxScan(getDatabase, { reason: 'interval' }).catch((err) => {
      console.warn('[ach-je-inbox] Scan failed:', err.message);
    });
  };
  setTimeout(tick, 8000);
  timer = setInterval(tick, INTERVAL_MS);
}
