/**
 * Plaid bank feed routes
 * ======================
 * - POST /api/plaid/create-link-token
 * - POST /api/plaid/exchange-public-token
 * - GET  /api/plaid/items
 * - POST /api/plaid/sync
 * - POST /api/plaid/import
 * Webhook (unauthenticated): POST /api/plaid/webhook
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { CountryCode, Products } from 'plaid';
import { getDatabase } from '../config/database.js';
import { ensurePlaidSchema } from '../config/plaid-schema.js';
import { getPlaidClient, isPlaidConfigured } from '../lib/plaid-client.js';
import { encryptSecret } from '../lib/token-crypto.js';
import {
  syncPlaidItem,
  commitPlaidImport,
} from '../lib/plaid-auto-sync.js';
import {
  assertSimmonsInstitution,
  getSimmonsInstitutionConfig,
  isSimmonsInstitution,
  simmonsRejectMessage,
} from '../lib/plaid-simmons.js';

const router = express.Router();
const plaidSyncSessions = new Map();

async function ensurePlaidReady(db) {
  await ensurePlaidSchema(db);
}

router.get('/status', async (req, res) => {
  const simmons = getSimmonsInstitutionConfig();
  return res.json({
    configured: isPlaidConfigured(),
    environment: process.env.PLAID_ENV || 'sandbox',
    allowedBank: simmons.allowedBankName,
    allowedInstitutionIds: simmons.allowedInstitutionIds,
  });
});

router.post('/create-link-token', async (req, res) => {
  try {
    if (!isPlaidConfigured()) {
      return res.status(503).json({ error: 'Plaid is not configured on this server' });
    }

    const { entityId } = req.body;
    if (!entityId) {
      return res.status(400).json({ error: 'Entity ID required' });
    }

    const db = await getDatabase();
    await ensurePlaidReady(db);

    const entity = await db.get('SELECT id FROM entities WHERE id = ?', entityId);
    if (!entity) {
      return res.status(404).json({ error: 'Entity not found' });
    }

    const client = getPlaidClient();
    const response = await client.linkTokenCreate({
      user: { client_user_id: `${req.user.id}-${entityId}` },
      client_name: 'LJC Accounting',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
      webhook: process.env.PLAID_WEBHOOK_URL || undefined,
    });

    return res.json({ linkToken: response.data.link_token });
  } catch (error) {
    console.error('Plaid link token error:', error.response?.data || error.message);
    return res.status(500).json({
      error: 'Failed to create Plaid link token',
      details: error.response?.data?.error_message || error.message,
    });
  }
});

router.post('/exchange-public-token', async (req, res) => {
  try {
    if (!isPlaidConfigured()) {
      return res.status(503).json({ error: 'Plaid is not configured on this server' });
    }

    const { entityId, publicToken, institution } = req.body;
    if (!entityId || !publicToken) {
      return res.status(400).json({ error: 'entityId and publicToken required' });
    }

    try {
      assertSimmonsInstitution(institution);
    } catch (err) {
      return res.status(err.statusCode || 403).json({ error: err.message });
    }

    const db = await getDatabase();
    await ensurePlaidReady(db);

    const client = getPlaidClient();
    const exchange = await client.itemPublicTokenExchange({ public_token: publicToken });
    const { access_token: accessToken, item_id: itemId } = exchange.data;

    const itemInfo = await client.itemGet({ access_token: accessToken });
    const resolvedInstitutionId = itemInfo.data.item.institution_id;
    let resolvedName = institution?.name || null;
    if (resolvedInstitutionId) {
      try {
        const inst = await client.institutionsGetById({
          institution_id: resolvedInstitutionId,
          country_codes: [CountryCode.Us],
        });
        resolvedName = inst.data.institution.name;
      } catch {
        // Fall back to Link metadata name
      }
    }

    try {
      assertSimmonsInstitution({
        institution_id: resolvedInstitutionId,
        name: resolvedName,
      });
    } catch (err) {
      return res.status(err.statusCode || 403).json({ error: err.message });
    }

    const encrypted = encryptSecret(accessToken);
    const rowId = `plaid-item-${uuidv4()}`;

    const existing = await db.get('SELECT id FROM plaid_items WHERE item_id = ?', itemId);
    if (existing) {
      await db.run(
        `UPDATE plaid_items SET
          entity_id = ?, access_token_encrypted = ?, institution_id = ?, institution_name = ?,
          sync_cursor = NULL, is_active = true, updated_at = CURRENT_TIMESTAMP
         WHERE item_id = ?`,
        [
          entityId,
          encrypted,
          resolvedInstitutionId || institution?.institution_id || null,
          resolvedName || institution?.name || null,
          itemId,
        ]
      );
    } else {
      await db.run(
        `INSERT INTO plaid_items (
          id, entity_id, item_id, access_token_encrypted, institution_id, institution_name,
          created_by, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, true)`,
        [
          rowId,
          entityId,
          itemId,
          encrypted,
          resolvedInstitutionId || institution?.institution_id || null,
          resolvedName || institution?.name || null,
          req.user.id,
        ]
      );
    }

    return res.json({
      itemId,
      institutionName: resolvedName || institution?.name || 'Financial institution',
      message: `${resolvedName || institution?.name || 'Bank'} linked successfully`,
    });
  } catch (error) {
    console.error('Plaid token exchange error:', error.response?.data || error.message);
    return res.status(500).json({
      error: 'Failed to link bank account',
      details: error.response?.data?.error_message || error.message,
    });
  }
});

router.get('/items', async (req, res) => {
  try {
    const { entityId } = req.query;
    if (!entityId) {
      return res.status(400).json({ error: 'entityId query parameter required' });
    }

    const db = await getDatabase();
    await ensurePlaidReady(db);

    const items = await db.all(
      `SELECT id, entity_id, item_id, institution_id, institution_name, created_at, updated_at
       FROM plaid_items WHERE entity_id = ? AND is_active = 1 ORDER BY created_at DESC`,
      [entityId]
    );

    const simmonsItems = items.filter((item) =>
      isSimmonsInstitution({
        institution_id: item.institution_id,
        name: item.institution_name,
      })
    );

    return res.json(simmonsItems);
  } catch (error) {
    console.error('Plaid list items error:', error);
    return res.status(500).json({ error: 'Failed to list linked accounts' });
  }
});

router.post('/sync', async (req, res) => {
  try {
    if (!isPlaidConfigured()) {
      return res.status(503).json({ error: 'Plaid is not configured on this server' });
    }

    const { entityId, itemId } = req.body;
    if (!entityId || !itemId) {
      return res.status(400).json({ error: 'entityId and itemId required' });
    }

    const db = await getDatabase();
    await ensurePlaidReady(db);

    const item = await db.get(
      'SELECT * FROM plaid_items WHERE entity_id = ? AND item_id = ? AND is_active = 1',
      [entityId, itemId]
    );
    if (!item) {
      return res.status(404).json({ error: 'Linked bank account not found for this entity' });
    }

    if (!isSimmonsInstitution({ institution_id: item.institution_id, name: item.institution_name })) {
      return res.status(403).json({
        error: simmonsRejectMessage({ name: item.institution_name, institution_id: item.institution_id }),
      });
    }

    const session = await syncPlaidItem(db, { entityId, itemId });
    plaidSyncSessions.set(session.importId, session);

    return res.json({
      importId: session.importId,
      fileName: session.fileName,
      institutionName: session.institutionName,
      dateRange: session.dateRange,
      summary: {
        totalTransactions: session.totalTransactions,
        newTransactions: session.newTransactions,
        duplicateTransactions: session.duplicateTransactions,
      },
      preview: session.transactions.slice(0, 10),
      totalForImport: session.newTransactions,
    });
  } catch (error) {
    console.error('Plaid sync error:', error.response?.data || error.message);
    return res.status(500).json({
      error: 'Failed to sync Plaid transactions',
      details: error.response?.data?.error_message || error.message,
    });
  }
});

router.post('/import', async (req, res) => {
  try {
    const { importId } = req.body;
    if (!importId) {
      return res.status(400).json({ error: 'importId required' });
    }

    const session = plaidSyncSessions.get(importId);
    if (!session) {
      return res.status(404).json({ error: 'Plaid import session not found or expired' });
    }

    const db = await getDatabase();
    const result = await commitPlaidImport(db, session, req.user.id);
    const { journalEntriesCreated: createdJECount, reapply } = result;

    session.status = 'COMPLETED';
    session.importedCount = createdJECount;
    session.completedAt = new Date().toISOString();

    const sweepNote = reapply?.updated
      ? ` ${reapply.updated} older pending transaction${reapply.updated === 1 ? '' : 's'} also auto-categorized from recently learned rules.`
      : '';
    return res.json({
      importId,
      status: 'COMPLETED',
      transactionsProcessed: createdJECount,
      journalEntriesCreated: createdJECount,
      reapply,
      message: `Successfully imported ${createdJECount} Plaid transactions as draft journal entries.${sweepNote}`,
    });
  } catch (error) {
    console.error('Plaid import error:', error);
    return res.status(500).json({
      error: 'Failed to import Plaid transactions',
      details: error.message,
    });
  }
});

export { plaidWebhookHandler } from '../lib/plaid-auto-sync.js';

export default router;
