/**
 * Receipt & Invoice Collector Routes (WellyBox-style automated bookkeeping)
 * ========================================================================
 *
 * Endpoints (mounted at /api/receipts, behind JWT auth):
 *  Connections
 *   - GET    /providers                 supported providers + configured flag
 *   - GET    /connections               list connected inboxes/clouds/accounting
 *   - POST   /connections               connect an inbox/cloud/accounting account
 *   - DELETE /connections/:id           disconnect
 *  Ingestion
 *   - POST   /scan                      scan connected inboxes -> ingest receipts
 *   - POST   /upload                    manual / mobile upload of a receipt
 *  Receipts
 *   - GET    /                          list receipts (filter by entity/status)
 *   - GET    /stats                     dashboard counts
 *   - GET    /export                    CSV export (Excel-compatible)
 *   - GET    /:id                       get one
 *   - PATCH  /:id                       human-in-the-loop review/correction
 *   - POST   /:id/approve               mark reviewed
 *   - POST   /:id/post                  post as balanced DRAFT journal entry
 *   - POST   /:id/sync                  push to QuickBooks/Xero
 *   - DELETE /:id                       reject
 *
 * The WhatsApp webhook handler is exported separately and mounted without JWT.
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../config/database.js';
import { ingestDocument } from '../lib/receipt-ingest.js';
import { CONFIDENCE_THRESHOLD } from '../lib/receipt-parser.js';
import { encryptSecret } from '../lib/token-crypto.js';
import {
  SUPPORTED_PROVIDERS,
  ACCOUNTING_PROVIDERS,
  providerLabel,
  providerConfigured,
  isSupportedProvider,
  fetchDocuments,
  pushToAccounting,
} from '../lib/inbox-providers.js';

const router = express.Router();

function dollars(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

async function logSync(db, fields) {
  try {
    await db.run(
      `INSERT INTO receipt_sync_logs (
        id, entity_id, connection_id, provider, action,
        discovered, imported, duplicates, status, message, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `rsl-${uuidv4()}`,
        fields.entityId,
        fields.connectionId ?? null,
        fields.provider ?? null,
        fields.action,
        fields.discovered ?? 0,
        fields.imported ?? 0,
        fields.duplicates ?? 0,
        fields.status ?? 'OK',
        fields.message ?? null,
        fields.createdBy ?? null,
      ]
    );
  } catch (err) {
    console.error('Failed to write receipt_sync_log:', err.message);
  }
}

async function getOrCreateAccount(db, entityId, { number, name, type, normal }) {
  let account = await db.get(
    'SELECT * FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, number]
  );
  if (!account) {
    const accId = `acc-${uuidv4()}`;
    await db.run(
      `INSERT INTO accounts (id, entity_id, account_number, account_name, account_type, normal_balance, is_active)
       VALUES (?, ?, ?, ?, ?, ?, true)`,
      [accId, entityId, number, name, type, normal]
    );
    account = await db.get('SELECT * FROM accounts WHERE id = ?', accId);
  }
  return account;
}

/* ---------------------------------------------------------------- Providers */

router.get('/providers', (req, res) => {
  res.json(
    SUPPORTED_PROVIDERS.map((p) => ({
      provider: p,
      label: providerLabel(p),
      configured: providerConfigured(p),
      isAccounting: ACCOUNTING_PROVIDERS.includes(p),
    }))
  );
});

/* -------------------------------------------------------------- Connections */

router.get('/connections', async (req, res) => {
  try {
    const { entityId } = req.query;
    const db = await getDatabase();
    const rows = entityId
      ? await db.all(
          "SELECT id, entity_id, provider, account_label, status, last_sync_at, created_at FROM inbox_connections WHERE entity_id = ? AND status != 'DISCONNECTED' ORDER BY created_at DESC",
          entityId
        )
      : await db.all(
          "SELECT id, entity_id, provider, account_label, status, last_sync_at, created_at FROM inbox_connections WHERE status != 'DISCONNECTED' ORDER BY created_at DESC"
        );
    res.json(rows.map((r) => ({ ...r, providerLabel: providerLabel(r.provider) })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/connections', async (req, res) => {
  try {
    const { entityId, provider, accountLabel, accessToken, refreshToken } = req.body;
    if (!entityId || !provider) {
      return res.status(400).json({ error: 'entityId and provider are required' });
    }
    if (!isSupportedProvider(provider)) {
      return res.status(400).json({ error: `Unsupported provider: ${provider}` });
    }

    const db = await getDatabase();
    const id = `inbox-${uuidv4()}`;
    await db.run(
      `INSERT INTO inbox_connections (
        id, entity_id, provider, account_label, access_token_encrypted, refresh_token_encrypted, status, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        entityId,
        provider,
        accountLabel || `${providerLabel(provider)} account`,
        accessToken ? encryptSecret(accessToken) : null,
        refreshToken ? encryptSecret(refreshToken) : null,
        'CONNECTED',
        req.user.id,
      ]
    );
    const connection = await db.get(
      'SELECT id, entity_id, provider, account_label, status, created_at FROM inbox_connections WHERE id = ?',
      id
    );
    res.status(201).json({
      ...connection,
      providerLabel: providerLabel(provider),
      sandbox: !providerConfigured(provider),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/connections/:id', async (req, res) => {
  try {
    const db = await getDatabase();
    const result = await db.run(
      "UPDATE inbox_connections SET status = 'DISCONNECTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      req.params.id
    );
    if (!result.changes) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    res.json({ message: 'Connection disconnected' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ---------------------------------------------------------------- Ingestion */

router.post('/scan', async (req, res) => {
  try {
    const { entityId, connectionId } = req.body;
    if (!entityId) return res.status(400).json({ error: 'entityId is required' });

    const db = await getDatabase();
    const connections = connectionId
      ? await db.all(
          "SELECT * FROM inbox_connections WHERE id = ? AND status = 'CONNECTED'",
          connectionId
        )
      : await db.all(
          "SELECT * FROM inbox_connections WHERE entity_id = ? AND status = 'CONNECTED' AND provider NOT IN ('QUICKBOOKS','XERO')",
          entityId
        );

    if (!connections.length) {
      return res.status(400).json({ error: 'No connected inboxes to scan. Connect an inbox first.' });
    }

    let discovered = 0;
    let imported = 0;
    let duplicates = 0;
    const newReceipts = [];

    for (const connection of connections) {
      let docs = [];
      try {
        docs = await fetchDocuments(connection);
      } catch (err) {
        await logSync(db, {
          entityId,
          connectionId: connection.id,
          provider: connection.provider,
          action: 'SCAN',
          status: 'ERROR',
          message: err.message,
          createdBy: req.user.id,
        });
        continue;
      }

      for (const doc of docs) {
        discovered += 1;
        const result = await ingestDocument(db, {
          entityId,
          userId: req.user.id,
          source: connection.provider,
          connectionId: connection.id,
          externalRef: doc.externalRef,
          fileName: doc.fileName,
          fileMime: doc.fileMime,
          rawText: doc.rawText,
        });
        if (result.status === 'created') {
          imported += 1;
          newReceipts.push(result.receipt);
        } else {
          duplicates += 1;
        }
      }

      await db.run(
        'UPDATE inbox_connections SET last_sync_at = CURRENT_TIMESTAMP WHERE id = ?',
        connection.id
      );
      await logSync(db, {
        entityId,
        connectionId: connection.id,
        provider: connection.provider,
        action: 'SCAN',
        discovered: docs.length,
        imported,
        duplicates,
        status: 'OK',
        createdBy: req.user.id,
      });
    }

    res.json({
      message: `Scan complete: ${imported} new, ${duplicates} duplicate(s) of ${discovered} discovered`,
      discovered,
      imported,
      duplicates,
      newReceipts,
    });
  } catch (error) {
    console.error('Scan error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/upload', async (req, res) => {
  try {
    const { entityId, rawText, fileName, fileMime, fileData, source } = req.body;
    if (!entityId) return res.status(400).json({ error: 'entityId is required' });
    if (!rawText && !fileData) {
      return res.status(400).json({ error: 'rawText (OCR/extracted text) or fileData is required' });
    }

    const db = await getDatabase();
    const result = await ingestDocument(db, {
      entityId,
      userId: req.user.id,
      source: source === 'MOBILE' ? 'MOBILE' : 'UPLOAD',
      fileName: fileName || 'upload',
      fileMime: fileMime || 'text/plain',
      rawText: rawText || '',
      fileData: fileData || null,
    });

    res.status(result.status === 'created' ? 201 : 200).json(result);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/* ----------------------------------------------------------------- Receipts */

router.get('/stats', async (req, res) => {
  try {
    const { entityId } = req.query;
    const db = await getDatabase();
    const where = entityId ? 'WHERE entity_id = ?' : '';
    const params = entityId ? [entityId] : [];
    const rows = await db.all(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS total_cents
       FROM receipts ${where} GROUP BY status`,
      ...params
    );
    const stats = {
      total: 0,
      totalCents: 0,
      pendingReview: 0,
      reviewed: 0,
      posted: 0,
      exported: 0,
      rejected: 0,
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      byStatus: {},
    };
    for (const r of rows) {
      const count = Number(r.count);
      const cents = Number(r.total_cents);
      stats.byStatus[r.status] = { count, totalCents: cents };
      stats.total += count;
      stats.totalCents += cents;
      if (r.status === 'PENDING_REVIEW') stats.pendingReview = count;
      if (r.status === 'REVIEWED') stats.reviewed = count;
      if (r.status === 'POSTED') stats.posted = count;
      if (r.status === 'EXPORTED') stats.exported = count;
      if (r.status === 'REJECTED') stats.rejected = count;
    }
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/export', async (req, res) => {
  try {
    const { entityId, status } = req.query;
    const db = await getDatabase();
    const clauses = [];
    const params = [];
    if (entityId) { clauses.push('entity_id = ?'); params.push(entityId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await db.all(
      `SELECT * FROM receipts ${where} ORDER BY receipt_date DESC, created_at DESC`,
      ...params
    );

    const header = [
      'Receipt ID', 'Vendor', 'Date', 'Currency', 'Subtotal', 'Tax', 'Total',
      'Category', 'Source', 'Status', 'Confidence', 'Journal Entry',
    ];
    const escape = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.id,
        r.vendor,
        r.receipt_date,
        r.currency,
        dollars(r.subtotal_cents),
        dollars(r.tax_cents),
        dollars(r.total_cents),
        r.category,
        r.source,
        r.status,
        r.confidence_score,
        r.journal_entry_id || '',
      ].map(escape).join(','));
    }
    const csv = lines.join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="receipts-${entityId || 'all'}.csv"`);
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { entityId, status, limit } = req.query;
    const db = await getDatabase();
    const clauses = [];
    const params = [];
    if (entityId) { clauses.push('entity_id = ?'); params.push(entityId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const max = Math.min(Number(limit) || 200, 1000);
    const rows = await db.all(
      `SELECT id, entity_id, source, source_connection_id, vendor, receipt_date, currency,
              subtotal_cents, tax_cents, total_cents, category, confidence_score, status,
              needs_review, file_name, file_mime, external_ref, journal_entry_id, created_at
       FROM receipts ${where} ORDER BY receipt_date DESC, created_at DESC LIMIT ${max}`,
      ...params
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const db = await getDatabase();
    const receipt = await db.get('SELECT * FROM receipts WHERE id = ?', req.params.id);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    res.json(receipt);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const db = await getDatabase();
    const receipt = await db.get('SELECT * FROM receipts WHERE id = ?', req.params.id);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    if (receipt.status === 'POSTED') {
      return res.status(409).json({ error: 'Posted receipts are immutable; reverse the journal entry instead' });
    }

    const { vendor, receiptDate, currency, subtotalCents, taxCents, totalCents, category } = req.body;
    const updates = [];
    const params = [];
    const set = (col, val) => { updates.push(`${col} = ?`); params.push(val); };
    if (vendor !== undefined) set('vendor', vendor);
    if (receiptDate !== undefined) set('receipt_date', receiptDate);
    if (currency !== undefined) set('currency', currency);
    if (subtotalCents !== undefined) set('subtotal_cents', Math.round(Number(subtotalCents)));
    if (taxCents !== undefined) set('tax_cents', Math.round(Number(taxCents)));
    if (totalCents !== undefined) set('total_cents', Math.round(Number(totalCents)));
    if (category !== undefined) set('category', category);

    // A human correction resolves the review flag.
    set('needs_review', 0);
    set('status', 'REVIEWED');
    set('confidence_score', 1);
    updates.push('updated_at = CURRENT_TIMESTAMP');

    params.push(req.params.id);
    await db.run(`UPDATE receipts SET ${updates.join(', ')} WHERE id = ?`, ...params);
    const updated = await db.get('SELECT * FROM receipts WHERE id = ?', req.params.id);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const db = await getDatabase();
    const receipt = await db.get('SELECT * FROM receipts WHERE id = ?', req.params.id);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    await db.run(
      "UPDATE receipts SET status = 'REVIEWED', needs_review = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      req.params.id
    );
    res.json({ message: 'Receipt approved', id: req.params.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const db = await getDatabase();
    const receipt = await db.get('SELECT * FROM receipts WHERE id = ?', req.params.id);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    if (receipt.status === 'POSTED') {
      return res.status(409).json({ error: 'Cannot reject a posted receipt; reverse the journal entry' });
    }
    await db.run(
      "UPDATE receipts SET status = 'REJECTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      req.params.id
    );
    res.json({ message: 'Receipt rejected', id: req.params.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ---------------------------------------------- Post to ledger (double-entry) */

router.post('/:id/post', async (req, res) => {
  try {
    const db = await getDatabase();
    const receipt = await db.get('SELECT * FROM receipts WHERE id = ?', req.params.id);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    if (receipt.status === 'POSTED' || receipt.journal_entry_id) {
      return res.status(409).json({ error: 'Receipt already posted to the ledger' });
    }
    const totalCents = Number(receipt.total_cents || 0);
    if (totalCents <= 0) {
      return res.status(400).json({ error: 'Receipt total must be greater than zero to post' });
    }

    const entity = await db.get('SELECT * FROM entities WHERE id = ?', receipt.entity_id);
    if (!entity) return res.status(404).json({ error: 'Entity not found' });

    const expenseAccount = await getOrCreateAccount(db, receipt.entity_id, {
      number: '6000', name: 'Automated Expenses', type: 'EXPENSE', normal: 'DEBIT',
    });
    const apAccount = await getOrCreateAccount(db, receipt.entity_id, {
      number: '2000', name: 'Accounts Payable', type: 'LIABILITY', normal: 'CREDIT',
    });

    const amount = dollars(totalCents);
    const postingDate = receipt.receipt_date || new Date().toISOString().slice(0, 10);

    // Double-entry balance guard (rule): debits (+) and credits (-) must net to 0.
    const balanceLines = [
      { amount_cents: totalCents },   // debit expense
      { amount_cents: -totalCents },  // credit AP
    ];
    const sum = balanceLines.reduce((s, l) => s + l.amount_cents, 0);
    if (sum !== 0) {
      return res.status(500).json({ error: 'Unbalanced Transaction: Total Debits must equal Total Credits.' });
    }

    const jeId = `je-${uuidv4()}`;
    const jeNumber = `RCPT-${Date.now()}-${uuidv4().substring(0, 6)}`;
    const description = `Receipt: ${receipt.vendor || 'Unknown vendor'}`;

    await db.run(
      `INSERT INTO journal_entries (
        id, entity_id, je_number, description, posting_date, status,
        created_by, total_debit, total_credit, memo
      ) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
      [
        jeId, receipt.entity_id, jeNumber, description, postingDate,
        req.user.id, amount, amount, `Auto-collected ${receipt.source} receipt ${receipt.id}`,
      ]
    );

    // Journal entry lines
    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`jel-${uuidv4()}`, jeId, expenseAccount.id, amount, '0.00', `${receipt.category || 'Expense'} - ${receipt.vendor || ''}`, 1]
    );
    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`jel-${uuidv4()}`, jeId, apAccount.id, '0.00', amount, `Payable - ${receipt.vendor || ''}`, 2]
    );

    // General ledger
    await db.run(
      `INSERT INTO general_ledger (id, entity_id, account_id, journal_entry_id, debit, credit, posting_date, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [`gl-${uuidv4()}`, receipt.entity_id, expenseAccount.id, jeId, amount, '0.00', postingDate, description]
    );
    await db.run(
      `INSERT INTO general_ledger (id, entity_id, account_id, journal_entry_id, debit, credit, posting_date, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [`gl-${uuidv4()}`, receipt.entity_id, apAccount.id, jeId, '0.00', amount, postingDate, description]
    );

    await db.run(
      "UPDATE receipts SET status = 'POSTED', journal_entry_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [jeId, receipt.id]
    );

    await logSync(db, {
      entityId: receipt.entity_id,
      provider: 'LEDGER',
      action: 'POST',
      imported: 1,
      status: 'OK',
      message: `Posted ${jeNumber}`,
      createdBy: req.user.id,
    });

    res.json({
      message: 'Receipt posted as DRAFT journal entry',
      receiptId: receipt.id,
      journalEntryId: jeId,
      jeNumber,
      amount,
      nextSteps: 'Review and post the draft journal entry in Journals to finalize the ledger.',
    });
  } catch (error) {
    console.error('Post receipt error:', error);
    res.status(500).json({ error: error.message });
  }
});

/* --------------------------------------------- Push to QuickBooks / Xero etc */

router.post('/:id/sync', async (req, res) => {
  try {
    const { connectionId } = req.body;
    if (!connectionId) return res.status(400).json({ error: 'connectionId is required' });

    const db = await getDatabase();
    const receipt = await db.get('SELECT * FROM receipts WHERE id = ?', req.params.id);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });

    const connection = await db.get(
      "SELECT * FROM inbox_connections WHERE id = ? AND status = 'CONNECTED'",
      connectionId
    );
    if (!connection) return res.status(404).json({ error: 'Accounting connection not found' });
    if (!ACCOUNTING_PROVIDERS.includes(connection.provider)) {
      return res.status(400).json({ error: `${providerLabel(connection.provider)} is not an accounting destination` });
    }

    let result;
    try {
      result = await pushToAccounting(connection, receipt);
    } catch (err) {
      await logSync(db, {
        entityId: receipt.entity_id,
        connectionId,
        provider: connection.provider,
        action: 'SYNC',
        status: 'ERROR',
        message: err.message,
        createdBy: req.user.id,
      });
      return res.status(502).json({ error: err.message });
    }

    await db.run(
      "UPDATE receipts SET status = 'EXPORTED', external_ref = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [result.externalId, receipt.id]
    );
    await logSync(db, {
      entityId: receipt.entity_id,
      connectionId,
      provider: connection.provider,
      action: 'SYNC',
      imported: 1,
      status: 'OK',
      message: `Synced to ${providerLabel(connection.provider)} (${result.status})`,
      createdBy: req.user.id,
    });

    res.json({
      message: `Receipt synced to ${providerLabel(connection.provider)}`,
      externalId: result.externalId,
      status: result.status,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ----------------------------------------------------- WhatsApp bot webhook */
/**
 * WhatsApp inbound webhook. Mounted WITHOUT JWT (the bot server calls it).
 * Authenticated by a shared secret token (WHATSAPP_WEBHOOK_TOKEN).
 * Body: { entityId, from, caption, ocrText, fileName, fileMime }
 */
export async function whatsappWebhookHandler(req, res) {
  try {
    const token = req.query.token || req.headers['x-webhook-token'];
    const expected = process.env.WHATSAPP_WEBHOOK_TOKEN;
    if (expected && token !== expected) {
      return res.status(401).json({ error: 'Invalid webhook token' });
    }

    const { entityId, ocrText, caption, fileName, fileMime, from } = req.body;
    if (!entityId) return res.status(400).json({ error: 'entityId is required' });
    const rawText = ocrText || caption || '';
    if (!rawText) return res.status(400).json({ error: 'ocrText or caption is required' });

    const db = await getDatabase();
    const systemUser = await db.get("SELECT id FROM users WHERE role = 'ADMIN' ORDER BY created_at LIMIT 1");
    const userId = systemUser?.id || 'usr-admin';

    const result = await ingestDocument(db, {
      entityId,
      userId,
      source: 'WHATSAPP',
      externalRef: `WHATSAPP:${from || 'unknown'}:${fileName || Date.now()}`,
      fileName: fileName || 'whatsapp-receipt',
      fileMime: fileMime || 'image/jpeg',
      rawText,
    });

    res.status(result.status === 'created' ? 201 : 200).json({
      status: result.status,
      receiptId: result.receipt?.id,
    });
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
    res.status(500).json({ error: error.message });
  }
}

export default router;
