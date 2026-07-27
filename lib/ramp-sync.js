/**
 * Ramp card feed sync — pulls settled Ramp card transactions and commits them
 * as DRAFT import_transactions (the Check Categories review queue). Never
 * auto-posts to the general ledger; nothing hits the books without review.
 *
 * Booking model: Ramp charges DR expense / CR "Ramp Card" liability (2015).
 * The Ramp statement payment that leaves Simmons should later be booked
 * DR 2015 / CR Simmons so the card liability nets to zero — see the note in
 * integration/RAMP.md.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { ensureRampSchema } from '../config/ramp-schema.js';
import { decryptSecret } from './token-crypto.js';
import { listRampTransactions } from './ramp-client.js';
import { mapRampTransactions } from './ramp-transactions.js';
import { commitBankImportTransactions, getExistingFitidsForEntity } from './import-commit.js';
import { resolveAutomationUserId } from './system-user.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LOG_DIR = process.env.RAMP_AUTO_SYNC_LOG_DIR || path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'ramp-auto-sync.json');

const RAMP_CARD_ACCOUNT_NUMBER = process.env.RAMP_CARD_ACCOUNT_NUMBER || '2015';
const RAMP_CARD_ACCOUNT_NAME = 'Ramp Card';

const INTERVAL_MS = Math.max(1, Number(process.env.RAMP_AUTO_SYNC_INTERVAL_HOURS || 6)) * 60 * 60 * 1000;
const STARTUP_DELAY_MS = Math.max(0, Number(process.env.RAMP_AUTO_SYNC_STARTUP_DELAY_MS || 30_000));
// How far back to look on the first sync for a connection.
const INITIAL_LOOKBACK_DAYS = Math.max(1, Number(process.env.RAMP_INITIAL_LOOKBACK_DAYS || 120));

let timer = null;
let startedAt = null;
let lastRunAt = null;
let lastRunError = null;
let lastRunSummary = null;
let running = false;

export function isRampGloballyEnabled() {
  return process.env.RAMP_AUTO_SYNC_ENABLED !== '0';
}

function readLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function appendLog(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const rows = readLog();
    rows.unshift(entry);
    fs.writeFileSync(LOG_FILE, JSON.stringify(rows.slice(0, 50), null, 2));
  } catch {
    /* logging is best-effort */
  }
}

export function readRampAutoSyncLog() {
  return readLog();
}

/** Ensure the Ramp Card liability GL account exists; return its account number. */
export async function ensureRampCardAccount(db, entityId) {
  const existing = await db.get(
    'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, RAMP_CARD_ACCOUNT_NUMBER]
  );
  if (existing) return RAMP_CARD_ACCOUNT_NUMBER;
  await db.run(
    `INSERT INTO accounts (id, entity_id, account_number, account_name, account_type, normal_balance, is_active)
     VALUES (?, ?, ?, ?, 'LIABILITY', 'CREDIT', true)`,
    [`acc-${uuidv4()}`, entityId, RAMP_CARD_ACCOUNT_NUMBER, RAMP_CARD_ACCOUNT_NAME]
  );
  return RAMP_CARD_ACCOUNT_NUMBER;
}

/** Load a connection row and decrypt its credentials into client-ready shape. */
export function connectionCreds(row) {
  return {
    environment: row.environment || 'production',
    clientId: decryptSecret(row.client_id_encrypted),
    clientSecret: decryptSecret(row.client_secret_encrypted),
  };
}

async function getActiveConnection(db, entityId) {
  return db.get(
    'SELECT * FROM ramp_connections WHERE entity_id = ? AND is_active = 1',
    [entityId]
  );
}

/**
 * Sync one entity's Ramp connection into the review queue.
 * Returns a per-entity result summary.
 */
export async function syncRampConnection(db, { entityId, userId = null, sinceOverride = null }) {
  await ensureRampSchema(db);
  const conn = await getActiveConnection(db, entityId);
  if (!conn) {
    return { entityId, skipped: true, reason: 'no active Ramp connection' };
  }

  const creds = connectionCreds(conn);
  const actorId = userId || await resolveAutomationUserId(db);

  // Incremental window: from last watermark (minus 3-day safety overlap) or the
  // initial lookback. Dedup on fitid means overlap never double-books.
  let fromDate = sinceOverride;
  if (!fromDate) {
    if (conn.last_sync_from) {
      const base = new Date(conn.last_sync_from).getTime();
      fromDate = new Date(base - 3 * 86400000).toISOString();
    } else {
      fromDate = new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 86400000).toISOString();
    }
  }

  const raw = await listRampTransactions(creds, { fromDate });
  const mapped = mapRampTransactions(raw);

  const existingFitids = await getExistingFitidsForEntity(entityId);
  const newTransactions = mapped.filter((t) => !existingFitids.has(t.fitid));
  const duplicateCount = mapped.length - newTransactions.length;

  let journalEntriesCreated = 0;
  if (newTransactions.length) {
    await ensureRampCardAccount(db, entityId);
    const committed = await commitBankImportTransactions(db, {
      entityId,
      transactions: newTransactions,
      importId: `ramp-${uuidv4()}`,
      userId: actorId,
      sourceLabel: 'Ramp',
      bankAccountNumber: RAMP_CARD_ACCOUNT_NUMBER,
    });
    journalEntriesCreated = committed.createdJECount;
  }

  const nowIso = new Date().toISOString();
  await db.run(
    `UPDATE ramp_connections
     SET last_synced_at = ?, last_sync_from = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [nowIso, nowIso, conn.id]
  );

  return {
    entityId,
    businessName: conn.business_name || null,
    skipped: false,
    totalFetched: raw.length,
    postable: mapped.length,
    newTransactions: newTransactions.length,
    duplicateTransactions: duplicateCount,
    journalEntriesCreated,
  };
}

/** Sync all active Ramp connections (optionally one entity). */
export async function runRampAutoSync(db, { reason = 'scheduled', entityId = null, userId = null } = {}) {
  if (running) return { skipped: true, reason: 'already running' };
  if (!isRampGloballyEnabled()) return { skipped: true, reason: 'ramp sync disabled' };

  running = true;
  const started = new Date().toISOString();
  const results = [];

  try {
    await ensureRampSchema(db);
    let conns = await db.all(
      'SELECT entity_id FROM ramp_connections WHERE is_active = 1 ORDER BY entity_id'
    );
    if (entityId) conns = conns.filter((c) => c.entity_id === entityId);

    for (const c of conns) {
      try {
        results.push(await syncRampConnection(db, { entityId: c.entity_id, userId }));
      } catch (err) {
        results.push({ entityId: c.entity_id, error: err.message });
      }
    }

    const summary = {
      reason,
      startedAt: started,
      finishedAt: new Date().toISOString(),
      connectionsScanned: conns.length,
      totalNewTransactions: results.reduce((s, r) => s + (r.journalEntriesCreated || 0), 0),
      results,
      errors: results.filter((r) => r.error).map((r) => ({ entityId: r.entityId, error: r.error })),
    };

    lastRunAt = summary.finishedAt;
    lastRunError = summary.errors.length
      ? summary.errors.map((e) => `${e.entityId}: ${e.error}`).join('; ')
      : null;
    lastRunSummary = summary;
    appendLog(summary);
    return summary;
  } catch (err) {
    lastRunError = err.message;
    throw err;
  } finally {
    running = false;
  }
}

function computeNextRunAt() {
  if (!startedAt) return null;
  const base = lastRunAt ? new Date(lastRunAt).getTime() : startedAt;
  return new Date(base + INTERVAL_MS).toISOString();
}

export function getRampAutoSyncStatus() {
  return {
    enabled: isRampGloballyEnabled(),
    intervalHours: INTERVAL_MS / (60 * 60 * 1000),
    lastRunAt,
    lastRunError,
    lastRunSummary,
    nextScheduledRun: computeNextRunAt(),
    running,
    cardAccountNumber: RAMP_CARD_ACCOUNT_NUMBER,
    logFile: path.relative(ROOT, LOG_FILE),
  };
}

export function startRampAutoSync(getDb) {
  if (!isRampGloballyEnabled()) {
    console.log('Ramp auto-sync disabled (RAMP_AUTO_SYNC_ENABLED=0)');
    return;
  }
  startedAt = Date.now();

  const tick = async (reason) => {
    try {
      const db = await getDb();
      const result = await runRampAutoSync(db, { reason });
      if (!result.skipped) {
        console.log(`✓ Ramp auto-sync (${reason}): ${result.totalNewTransactions || 0} new transaction(s) across ${result.connectionsScanned || 0} connection(s)`);
      }
    } catch (err) {
      console.error('Ramp auto-sync failed:', err.message);
    }
  };

  if (process.env.RAMP_AUTO_SYNC_ON_STARTUP !== '0') {
    setTimeout(() => tick('startup'), STARTUP_DELAY_MS);
  }
  timer = setInterval(() => tick('scheduled'), INTERVAL_MS);
  console.log(`✓ Ramp auto-sync scheduled every ${INTERVAL_MS / (60 * 60 * 1000)}h`);
}

export function stopRampAutoSync() {
  if (timer) clearInterval(timer);
  timer = null;
}
