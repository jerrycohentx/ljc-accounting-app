/**
 * Ramp card-feed routes
 * ======================
 * - GET  /api/ramp/status?entityId=...     connection + last sync summary
 * - POST /api/ramp/connect                 store encrypted credentials (verifies first)
 * - POST /api/ramp/sync                     pull now → review queue
 * - POST /api/ramp/disconnect              deactivate connection
 * Webhook (unauthenticated): POST /api/ramp/webhook  (triggers a background sync)
 */
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../config/database.js';
import { ensureRampSchema } from '../config/ramp-schema.js';
import { encryptSecret } from '../lib/token-crypto.js';
import { verifyRampConnection, clearRampTokenCache } from '../lib/ramp-client.js';
import {
  runRampAutoSync,
  syncRampConnection,
  getRampAutoSyncStatus,
} from '../lib/ramp-sync.js';

const router = express.Router();

function publicConnection(row) {
  if (!row) return null;
  return {
    entityId: row.entity_id,
    environment: row.environment,
    businessName: row.business_name || null,
    isActive: !!row.is_active,
    lastSyncedAt: row.last_synced_at || null,
    createdAt: row.created_at || null,
  };
}

router.get('/status', async (req, res) => {
  try {
    const { entityId } = req.query;
    const db = await getDatabase();
    await ensureRampSchema(db);
    const auto = getRampAutoSyncStatus();

    let connection = null;
    if (entityId) {
      const row = await db.get(
        'SELECT * FROM ramp_connections WHERE entity_id = ? AND is_active = 1',
        [entityId]
      );
      connection = publicConnection(row);
    }

    return res.json({
      connected: !!connection,
      connection,
      autoSync: {
        enabled: auto.enabled,
        intervalHours: auto.intervalHours,
        lastRunAt: auto.lastRunAt,
        lastRunError: auto.lastRunError,
        nextScheduledRun: auto.nextScheduledRun,
        running: auto.running,
        cardAccountNumber: auto.cardAccountNumber,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/connect', async (req, res) => {
  try {
    const { entityId, clientId, clientSecret, environment = 'production', businessName = null } = req.body || {};
    if (!entityId || !clientId || !clientSecret) {
      return res.status(400).json({ error: 'entityId, clientId and clientSecret are required' });
    }

    const db = await getDatabase();
    await ensureRampSchema(db);

    const entity = await db.get('SELECT id FROM entities WHERE id = ?', entityId);
    if (!entity) return res.status(404).json({ error: 'Entity not found' });

    // Verify credentials before persisting so we never store a dead connection.
    try {
      await verifyRampConnection({ environment, clientId, clientSecret, scope: 'transactions:read' });
    } catch (err) {
      return res.status(400).json({ error: `Could not connect to Ramp: ${err.message}` });
    }

    const existing = await db.get('SELECT id FROM ramp_connections WHERE entity_id = ?', [entityId]);
    const clientIdEnc = encryptSecret(String(clientId));
    const clientSecretEnc = encryptSecret(String(clientSecret));

    if (existing) {
      await db.run(
        `UPDATE ramp_connections
         SET environment = ?, client_id_encrypted = ?, client_secret_encrypted = ?,
             business_name = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [environment, clientIdEnc, clientSecretEnc, businessName, existing.id]
      );
    } else {
      await db.run(
        `INSERT INTO ramp_connections
           (id, entity_id, environment, client_id_encrypted, client_secret_encrypted, business_name, created_by, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [`ramp-${uuidv4()}`, entityId, environment, clientIdEnc, clientSecretEnc, businessName, req.user?.id || null]
      );
    }

    const row = await db.get(
      'SELECT * FROM ramp_connections WHERE entity_id = ? AND is_active = 1',
      [entityId]
    );
    return res.json({ connected: true, connection: publicConnection(row) });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const { entityId } = req.body || {};
    if (!entityId) return res.status(400).json({ error: 'entityId required' });
    const db = await getDatabase();
    const result = await syncRampConnection(db, { entityId, userId: req.user?.id || null });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/disconnect', async (req, res) => {
  try {
    const { entityId } = req.body || {};
    if (!entityId) return res.status(400).json({ error: 'entityId required' });
    const db = await getDatabase();
    await ensureRampSchema(db);
    const row = await db.get('SELECT * FROM ramp_connections WHERE entity_id = ?', [entityId]);
    if (row) {
      await db.run(
        'UPDATE ramp_connections SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [row.id]
      );
      clearRampTokenCache(row.environment);
    }
    return res.json({ disconnected: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/** Ramp webhook — ack immediately, run a background sync for the entity(ies). */
let webhookGetDb = null;
export function setRampWebhookDb(getDb) {
  webhookGetDb = getDb;
}

export function rampWebhookHandler(req, res) {
  try {
    console.log('Ramp webhook received:', req.body?.event_type || req.body?.type || 'unknown');
    if (webhookGetDb) {
      setImmediate(async () => {
        try {
          const db = await webhookGetDb();
          await runRampAutoSync(db, { reason: 'webhook' });
        } catch (err) {
          console.error('Ramp webhook sync failed:', err.message);
        }
      });
    }
    return res.json({ received: true });
  } catch (error) {
    console.error('Ramp webhook error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}

export default router;
