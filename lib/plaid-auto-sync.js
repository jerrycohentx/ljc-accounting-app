/**
 * Scheduled Plaid auto-sync — downloads transactions for all linked items,
 * commits as DRAFT import_transactions (review queue), never auto-posts.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { ensurePlaidSchema } from '../config/plaid-schema.js';
import { getPlaidClient, isPlaidConfigured } from './plaid-client.js';
import { decryptSecret } from './token-crypto.js';
import { mapPlaidTransactions } from './plaid-transactions.js';
import { commitBankImportTransactions, getExistingFitidsForEntity } from './import-commit.js';
import {
  getInstitutionKey,
  isSimmonsInstitution,
} from './plaid-simmons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LOG_DIR = process.env.PLAID_AUTO_SYNC_LOG_DIR || path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'plaid-auto-sync.json');

const INTERVAL_MS = Math.max(
  1,
  Number(process.env.PLAID_AUTO_SYNC_INTERVAL_HOURS || 24)
) * 60 * 60 * 1000;

const STARTUP_DELAY_MS = Math.max(
  0,
  Number(process.env.PLAID_AUTO_SYNC_STARTUP_DELAY_MS || 20_000)
);

/** GL account (by account number) that each institution's transactions book against. */
export const PLAID_BANK_ACCOUNT_BY_INSTITUTION_KEY = {
  simmons: '1000',
  amex: '2010',
};

let timer = null;
let startedAt = null;
let lastRunAt = null;
let lastRunError = null;
let lastRunSummary = null;
let running = false;
const webhookQueue = new Set();

function readLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function appendLog(entry) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const rows = readLog();
  rows.unshift(entry);
  fs.writeFileSync(LOG_FILE, JSON.stringify(rows.slice(0, 50), null, 2));
}

export function readPlaidAutoSyncLog() {
  return readLog();
}

/**
 * Pull new Plaid transactions for one linked item. Returns session payload
 * suitable for commitPlaidImport (does not persist to review queue yet).
 */
export async function syncPlaidItem(db, { entityId, itemId }) {
  if (!isPlaidConfigured()) {
    throw new Error('Plaid is not configured on this server');
  }

  await ensurePlaidSchema(db);

  const item = await db.get(
    'SELECT * FROM plaid_items WHERE entity_id = ? AND item_id = ? AND is_active = 1',
    [entityId, itemId]
  );
  if (!item) {
    throw new Error('Linked bank account not found for this entity');
  }

  if (!isSimmonsInstitution({ institution_id: item.institution_id, name: item.institution_name })) {
    throw new Error(`Institution not allowed: ${item.institution_name || itemId}`);
  }

  const accessToken = decryptSecret(item.access_token_encrypted);
  const client = getPlaidClient();

  let cursor = item.sync_cursor || undefined;
  let added = [];
  let hasMore = true;

  while (hasMore) {
    const response = await client.transactionsSync({
      access_token: accessToken,
      cursor,
      count: 500,
    });
    added = added.concat(response.data.added);
    cursor = response.data.next_cursor;
    hasMore = response.data.has_more;
  }

  await db.run(
    'UPDATE plaid_items SET sync_cursor = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [cursor, item.id]
  );

  const mapped = mapPlaidTransactions(added.filter((t) => !t.pending));
  const existingFitids = await getExistingFitidsForEntity(entityId);
  const newTransactions = mapped.filter((t) => !existingFitids.has(t.fitid));
  const duplicateCount = mapped.length - newTransactions.length;

  const importId = `plaid-${uuidv4()}`;
  const dates = newTransactions.map((t) => t.date).filter(Boolean).sort();
  const institutionKey = getInstitutionKey({
    institution_id: item.institution_id,
    name: item.institution_name,
  });

  return {
    importId,
    entityId,
    itemId,
    fileName: `${item.institution_name || 'Bank'} (Plaid): ${item.institution_name || itemId}`,
    institutionName: item.institution_name,
    bankAccountNumber: PLAID_BANK_ACCOUNT_BY_INSTITUTION_KEY[institutionKey] || null,
    dateRange: {
      start: dates[0] || null,
      end: dates[dates.length - 1] || null,
    },
    totalTransactions: mapped.length,
    newTransactions: newTransactions.length,
    duplicateTransactions: duplicateCount,
    transactions: newTransactions,
    createdAt: new Date().toISOString(),
    status: 'PREVIEW',
  };
}

/** Commit a Plaid sync session as DRAFT journal entries (review queue). */
export async function commitPlaidImport(db, session, userId = 'plaid-auto-sync') {
  const { createdJECount, reapply, duplicatesSkipped } = await commitBankImportTransactions(db, {
    entityId: session.entityId,
    transactions: session.transactions,
    importId: session.importId,
    userId,
    sourceLabel: `${session.institutionName || 'Bank'} (Plaid)`,
    bankAccountNumber: session.bankAccountNumber || undefined,
  });

  return {
    importId: session.importId,
    entityId: session.entityId,
    institutionName: session.institutionName,
    newTransactions: session.newTransactions,
    journalEntriesCreated: createdJECount,
    duplicatesSkipped: duplicatesSkipped || 0,
    reapply,
  };
}

/**
 * Sync one item and commit new transactions to the review queue.
 * Skips commit when there are zero new transactions.
 */
export async function syncAndQueuePlaidItem(db, { entityId, itemId, userId = 'plaid-auto-sync' }) {
  const session = await syncPlaidItem(db, { entityId, itemId });
  if (!session.newTransactions) {
    return {
      entityId,
      itemId,
      institutionName: session.institutionName,
      skipped: true,
      reason: 'no new transactions',
      duplicateTransactions: session.duplicateTransactions,
    };
  }

  const committed = await commitPlaidImport(db, session, userId);
  return {
    entityId,
    itemId,
    institutionName: session.institutionName,
    ...committed,
    skipped: false,
  };
}

/** Sync all active Plaid items (optionally filter to one item_id). */
export async function runPlaidAutoSync(db, { reason = 'scheduled', itemId = null, userId = 'plaid-auto-sync' } = {}) {
  if (running) {
    return { skipped: true, reason: 'already running' };
  }
  if (!isPlaidConfigured()) {
    return { skipped: true, reason: 'plaid not configured' };
  }

  running = true;
  const started = new Date().toISOString();
  const itemResults = [];

  try {
    await ensurePlaidSchema(db);

    let items = await db.all(
      'SELECT entity_id, item_id, institution_id, institution_name FROM plaid_items WHERE is_active = 1 ORDER BY entity_id, created_at'
    );
    if (itemId) {
      items = items.filter((i) => i.item_id === itemId);
    }
    items = items.filter((i) =>
      isSimmonsInstitution({ institution_id: i.institution_id, name: i.institution_name })
    );

    for (const item of items) {
      try {
        const result = await syncAndQueuePlaidItem(db, {
          entityId: item.entity_id,
          itemId: item.item_id,
          userId,
        });
        itemResults.push(result);
      } catch (err) {
        itemResults.push({
          entityId: item.entity_id,
          itemId: item.item_id,
          institutionName: item.institution_name,
          error: err.response?.data?.error_message || err.message,
        });
      }
    }

    const summary = {
      reason,
      startedAt: started,
      finishedAt: new Date().toISOString(),
      itemsScanned: items.length,
      itemsWithNew: itemResults.filter((r) => !r.skipped && !r.error && (r.journalEntriesCreated || 0) > 0).length,
      totalNewTransactions: itemResults.reduce((s, r) => s + (r.journalEntriesCreated || 0), 0),
      itemResults,
      errors: itemResults.filter((r) => r.error).map((r) => ({
        itemId: r.itemId,
        entityId: r.entityId,
        error: r.error,
      })),
    };

    lastRunAt = summary.finishedAt;
    lastRunError = summary.errors.length
      ? summary.errors.map((e) => `${e.itemId}: ${e.error}`).join('; ')
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

export function getPlaidAutoSyncStatus() {
  return {
    enabled: process.env.PLAID_AUTO_SYNC_ENABLED !== '0' && isPlaidConfigured(),
    configured: isPlaidConfigured(),
    intervalHours: INTERVAL_MS / (60 * 60 * 1000),
    lastRunAt,
    lastRunError,
    lastRunSummary,
    nextScheduledRun: computeNextRunAt(),
    running,
    logFile: path.relative(ROOT, LOG_FILE),
  };
}

async function processWebhookQueue(getDb) {
  if (!webhookQueue.size) return;
  const itemIds = [...webhookQueue];
  webhookQueue.clear();

  try {
    const db = await getDb();
    for (const itemId of itemIds) {
      await runPlaidAutoSync(db, { reason: 'webhook', itemId });
    }
  } catch (err) {
    console.error('Plaid webhook sync failed:', err.message);
  }
}

/** Plaid webhook handler — ack immediately, sync in background. */
export function plaidWebhookHandler(req, res) {
  try {
    const { webhook_type: webhookType, webhook_code: webhookCode, item_id: itemId } = req.body || {};
    console.log('Plaid webhook received:', webhookType, webhookCode, itemId);

    if (webhookType === 'TRANSACTIONS' && webhookCode === 'SYNC_UPDATES_AVAILABLE' && itemId) {
      webhookQueue.add(itemId);
      if (webhookGetDb) {
        setImmediate(() => processWebhookQueue(webhookGetDb));
      }
    }

    return res.json({ received: true });
  } catch (error) {
    console.error('Plaid webhook error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}

let webhookGetDb = null;

export function startPlaidAutoSync(getDb) {
  webhookGetDb = getDb;

  if (process.env.PLAID_AUTO_SYNC_ENABLED === '0') {
    console.log('Plaid auto-sync disabled (PLAID_AUTO_SYNC_ENABLED=0)');
    return;
  }
  if (!isPlaidConfigured()) {
    console.log('Plaid auto-sync skipped — Plaid not configured');
    return;
  }

  startedAt = Date.now();

  const tick = async (reason) => {
    try {
      const db = await getDb();
      const result = await runPlaidAutoSync(db, { reason });
      if (!result.skipped) {
        console.log(
          `✓ Plaid auto-sync (${reason}): ${result.totalNewTransactions || 0} new transaction(s) across ${result.itemsScanned || 0} item(s)`
        );
      }
    } catch (err) {
      console.error('Plaid auto-sync failed:', err.message);
    }
  };

  if (process.env.PLAID_AUTO_SYNC_ON_STARTUP !== '0') {
    setTimeout(() => tick('startup'), STARTUP_DELAY_MS);
  }

  timer = setInterval(() => tick('scheduled'), INTERVAL_MS);
  console.log(`✓ Plaid auto-sync scheduled every ${INTERVAL_MS / (60 * 60 * 1000)}h`);
}

export function stopPlaidAutoSync() {
  if (timer) clearInterval(timer);
  timer = null;
}
