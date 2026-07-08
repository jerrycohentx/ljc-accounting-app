/**
 * Document email ingest — receipts, invoices, and breakdowns from connected mailboxes.
 *
 * Flow: scan inbox → extract text → parse vendor/amount/date → auto-categorize with
 * bank rules → DRAFT journal entry in Activity Review (/feed-review). Never posts.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import {
  collectMailboxMessages,
  detectBankTarget,
  isStatementAttachment,
  isDocumentAttachment,
} from './statement-email-ingest.js';
import { getEmailIngestSettings } from './statement-email-config.js';
import { ensureStatementMailboxTable } from './statement-mailbox-store.js';
import { ensureReceiptsSchema } from '../config/receipts-schema.js';
import { isLonestarEStatementNotification } from './lonestar-estatement-notify.js';
import {
  extractTextFromAttachment,
  extractEmailBodyText,
  emailBodyLooksLikeDocument,
  looksLikeBankStatementText,
} from './extract-document-text.js';
import { createDocumentDraftEntry } from './document-draft-entry.js';
import { sendDocumentDigestEmail } from './document-digest-email.js';
import { isPostgres } from '../config/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const LOG_DIR = process.env.DOCUMENT_EMAIL_LOG_DIR || path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'document-email-ingest.json');
const DIGEST_STATE_FILE = path.join(LOG_DIR, 'document-digest-last-sent.json');

let timer = null;
let digestTimer = null;
let lastRunAt = null;
let lastRunError = null;
let lastRunSummary = null;
let running = false;

export function getDocumentEmailSettings() {
  const base = getEmailIngestSettings();
  return {
    enabled: process.env.DOCUMENT_EMAIL_ENABLED !== '0',
    sinceDays: Math.max(1, Number(process.env.DOCUMENT_EMAIL_SINCE_DAYS || base.sinceDays || 45)),
    intervalHours: Math.max(1, Number(process.env.DOCUMENT_EMAIL_INTERVAL_HOURS || 6)),
    scanOnStartup: process.env.DOCUMENT_EMAIL_SCAN_ON_STARTUP !== '0',
    searchQuery: process.env.DOCUMENT_EMAIL_SEARCH_QUERY
      || 'has:attachment -filename:ofx -filename:qfx',
    defaultEntityId: process.env.DOCUMENT_EMAIL_ENTITY_ID || base.defaultEntityId || 'ent-ljc',
    inboxSaveDir: process.env.DOCUMENT_EMAIL_INBOX_DIR || 'data/document-imports/inbox',
    digestEnabled: process.env.DOCUMENT_DIGEST_ENABLED !== '0',
    digestHour: Math.min(23, Math.max(0, Number(process.env.DOCUMENT_DIGEST_HOUR || 7))),
    digestTo: process.env.DOCUMENT_DIGEST_TO || 'jerry@ljcfinancial.com',
    appUrl: process.env.FRONTEND_URL || process.env.APP_URL || 'https://ljc-accounting.onrender.com',
  };
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
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const rows = readLog();
  rows.unshift(entry);
  fs.writeFileSync(LOG_FILE, JSON.stringify(rows.slice(0, 50), null, 2));
}

export function readDocumentEmailIngestLog() {
  return readLog();
}

export async function ensureDocumentImportLogTable(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS document_import_log (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      entity_id TEXT NOT NULL,
      from_address TEXT,
      subject TEXT,
      received_at TIMESTAMP,
      attachment_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'PROCESSED',
      result_summary TEXT,
      error_message TEXT,
      processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      processed_by TEXT
    )
  `);
}

function saveInboxFile(settings, mailbox, messageId, fileName, content) {
  const safeMsg = messageId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = path.join(ROOT, settings.inboxSaveDir, mailbox.replace('@', '_at_'), safeMsg);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, safeName);
  fs.writeFileSync(dest, content);
  return path.relative(ROOT, dest).replace(/\\/g, '/');
}

function shouldSkipAttachment({ attachment, email }) {
  const fileName = attachment.filename || '';
  if (!isDocumentAttachment(fileName) && !isStatementAttachment(fileName)) {
    return 'not a supported document type';
  }
  if (/\.(ofx|qfx)$/i.test(fileName)) {
    return 'bank OFX — handled by statement ingest';
  }
  const target = detectBankTarget({
    subject: email.subject,
    from: email.from,
    fileName,
    text: email.text || '',
  });
  if (target && isStatementAttachment(fileName)) {
    return 'bank statement — handled by statement ingest';
  }
  return null;
}

async function getDocumentImportRow(db, messageId) {
  return db.get(
    'SELECT id, status, result_summary, error_message FROM document_import_log WHERE message_id = ?',
    [messageId]
  );
}

function shouldSkipDocumentEmail(row) {
  if (!row) return false;
  if (row.error_message) return false;
  if (row.status === 'PARTIAL') return false;
  return /Created \d+ draft document/i.test(row.result_summary || '');
}

async function logDocumentImport(db, fields) {
  const existing = await db.get(
    'SELECT id FROM document_import_log WHERE message_id = ?',
    [fields.messageId]
  );
  const id = existing?.id || `dil-${uuidv4()}`;
  if (existing) {
    await db.run(
      `UPDATE document_import_log SET
        entity_id = ?, from_address = ?, subject = ?, received_at = ?,
        attachment_count = ?, status = ?, result_summary = ?, error_message = ?,
        processed_at = CURRENT_TIMESTAMP, processed_by = ?
       WHERE message_id = ?`,
      [
        fields.entityId, fields.from, fields.subject, fields.receivedAt,
        fields.attachmentCount, fields.status, fields.resultSummary,
        fields.errorMessage || null, fields.userId, fields.messageId,
      ]
    );
  } else {
    await db.run(
      `INSERT INTO document_import_log (
        id, message_id, entity_id, from_address, subject, received_at,
        attachment_count, status, result_summary, error_message, processed_at, processed_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
      [
        id, fields.messageId, fields.entityId, fields.from, fields.subject,
        fields.receivedAt, fields.attachmentCount, fields.status,
        fields.resultSummary, fields.errorMessage || null, fields.userId,
      ]
    );
  }
}

async function processDocumentAttachment(db, {
  attachment,
  email,
  settings,
  userId,
  entityId,
}) {
  const skipReason = shouldSkipAttachment({ attachment, email });
  if (skipReason) return { skipped: true, reason: skipReason };

  const fileName = attachment.filename;
  let rawText = '';
  try {
    rawText = await extractTextFromAttachment({
      filename: fileName,
      content: attachment.content,
      mimeType: attachment.mimeType,
    });
  } catch (err) {
    const bodyFallback = extractEmailBodyText(email);
    if (emailBodyLooksLikeDocument(bodyFallback)) {
      rawText = bodyFallback;
    } else {
      return { skipped: true, reason: err.message, fileName };
    }
  }

  if (looksLikeBankStatementText(rawText)) {
    return { skipped: true, reason: 'bank statement PDF', fileName };
  }

  const externalRef = `${email.messageId}:${fileName}`;
  const savedPath = saveInboxFile(settings, email.mailbox, email.messageId, fileName, attachment.content);

  const result = await createDocumentDraftEntry(db, {
    entityId,
    userId,
    externalRef,
    fileName,
    fileMime: attachment.mimeType || null,
    fileData: attachment.content.toString('base64'),
    rawText,
    vendorHint: email.from,
    subject: email.subject,
    messageId: email.messageId,
  });

  return {
    ...result,
    fileName,
    savedPath,
    skipped: result.status === 'duplicate',
    reason: result.status === 'duplicate' ? 'duplicate' : undefined,
  };
}

async function processEmailBodyDocument(db, { email, settings, userId, entityId }) {
  const rawText = extractEmailBodyText(email);
  if (!emailBodyLooksLikeDocument(rawText)) {
    return { skipped: true, reason: 'email body has no document amounts' };
  }

  const externalRef = `${email.messageId}:body`;
  const result = await createDocumentDraftEntry(db, {
    entityId,
    userId,
    externalRef,
    fileName: 'email-body.txt',
    fileMime: 'text/plain',
    rawText,
    vendorHint: email.from,
    subject: email.subject,
    messageId: email.messageId,
  });

  return {
    ...result,
    skipped: result.status === 'duplicate',
    reason: result.status === 'duplicate' ? 'duplicate' : undefined,
  };
}

export async function runDocumentEmailIngest(db, { reason = 'scheduled', userId = 'usr-admin' } = {}) {
  if (running) return { skipped: true, reason: 'already running' };

  const settings = getDocumentEmailSettings();
  if (!settings.enabled) return { skipped: true, reason: 'disabled' };

  running = true;
  const startedAt = new Date().toISOString();
  const results = [];
  const newDrafts = [];

  try {
    await ensureDocumentImportLogTable(db);
    await ensureStatementMailboxTable(db);
    await ensureReceiptsSchema(db);

    const collectSettings = {
      ...getEmailIngestSettings(),
      sinceDays: settings.sinceDays,
      searchQuery: settings.searchQuery,
      ingestKind: 'documents',
      imapMode: 'documents',
    };
    const { messages, mailboxes: configuredMailboxes, mailboxStats } = await collectMailboxMessages(db, collectSettings);

    for (const email of messages) {
      if (email.error) {
        results.push({ mailbox: email.mailbox, transport: email.transport, error: email.error });
        continue;
      }

      if (isLonestarEStatementNotification(email)) continue;

      const existing = await getDocumentImportRow(db, email.messageId);
      if (shouldSkipDocumentEmail(existing)) {
        results.push({ messageId: email.messageId, skipped: true, reason: 'already processed' });
        continue;
      }

      const docAttachments = (email.attachments || []).filter((a) => {
        const name = a.filename || '';
        if (!name) return false;
        if (/\.(ofx|qfx)$/i.test(name)) return false;
        const skip = shouldSkipAttachment({ attachment: a, email });
        return !skip;
      });

      const attachmentResults = [];
      let entityId = settings.defaultEntityId;
      let hadError = false;

      for (const att of docAttachments) {
        try {
          const r = await processDocumentAttachment(db, {
            attachment: att,
            email,
            settings,
            userId,
            entityId,
          });
          attachmentResults.push(r);
          if (r.status === 'created') {
            newDrafts.push({
              vendor: r.vendor,
              categoryLabel: r.categoryLabel,
              totalCents: r.totalCents,
              fitid: r.fitid,
            });
          }
        } catch (err) {
          hadError = true;
          attachmentResults.push({ fileName: att.filename, error: err.message });
        }
      }

      if (!docAttachments.length || !attachmentResults.some((r) => r.status === 'created')) {
        const alreadyTriedBody = attachmentResults.some((r) => r.emailBody);
        if (!alreadyTriedBody) {
          try {
            const r = await processEmailBodyDocument(db, { email, settings, userId, entityId });
            attachmentResults.push({ ...r, emailBody: true });
            if (r.status === 'created') {
              newDrafts.push({
                vendor: r.vendor,
                categoryLabel: r.categoryLabel,
                totalCents: r.totalCents,
                fitid: r.fitid,
              });
            }
          } catch (err) {
            hadError = true;
            attachmentResults.push({ error: err.message, emailBody: true });
          }
        }
      }

      const created = attachmentResults.filter((r) => r.status === 'created').length;
      const actionable = attachmentResults.some((r) => r.status === 'created' || r.skipped);
      if (!actionable && !hadError) continue;

      const summary = created
        ? `Created ${created} draft document(s) from "${email.subject}"`
        : hadError
          ? attachmentResults.find((r) => r.error)?.error || 'Processing failed'
          : attachmentResults.map((r) => r.reason).filter(Boolean).join('; ') || 'No documents';

      await logDocumentImport(db, {
        messageId: email.messageId,
        entityId,
        from: email.from,
        subject: email.subject,
        receivedAt: email.receivedAt,
        attachmentCount: docAttachments.length,
        status: hadError ? 'PARTIAL' : 'PROCESSED',
        resultSummary: summary,
        errorMessage: hadError ? attachmentResults.filter((r) => r.error).map((r) => r.error).join('; ') : null,
        userId,
      });

      results.push({
        messageId: email.messageId,
        subject: email.subject,
        mailbox: email.mailbox,
        attachmentResults,
        summary,
      });
    }

    const summary = {
      reason,
      startedAt,
      finishedAt: new Date().toISOString(),
      mailboxesConfigured: configuredMailboxes.map((m) => ({ user: m.user, transport: m.transport })),
      messagesFetched: messages.filter((m) => !m.error).length,
      mailboxStats: mailboxStats || [],
      processedEmails: results.filter((r) => !r.skipped && !r.error).length,
      skippedEmails: results.filter((r) => r.skipped).length,
      draftsCreated: newDrafts.length,
      newDrafts,
      errors: results.filter((r) => r.error),
      results: results.slice(0, 30),
    };

    lastRunAt = summary.finishedAt;
    lastRunError = summary.errors.length ? summary.errors.map((e) => e.error).join('; ') : null;
    lastRunSummary = summary;
    appendLog(summary);

    if (settings.digestEnabled && newDrafts.length > 0) {
      try {
        await maybeSendDigest(db, { settings, newDrafts, runSummary: summary });
      } catch (err) {
        console.warn('Document digest email (non-fatal):', err.message);
      }
    }

    return summary;
  } catch (err) {
    lastRunError = err.message;
    throw err;
  } finally {
    running = false;
  }
}

function readDigestState() {
  try {
    if (!fs.existsSync(DIGEST_STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(DIGEST_STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeDigestState(state) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(DIGEST_STATE_FILE, JSON.stringify(state, null, 2));
}

async function maybeSendDigest(db, { settings, newDrafts, runSummary }) {
  const today = new Date().toISOString().slice(0, 10);
  const state = readDigestState();
  if (state.date === today && state.sent) return { skipped: true, reason: 'digest already sent today' };

  const pendingCount = await db.get(
    `SELECT COUNT(*) AS count FROM import_transactions it
     JOIN journal_entries je ON je.id = it.journal_entry_id
     WHERE it.status = 'DRAFT' AND je.status = 'DRAFT' AND je.description LIKE 'Email doc:%'`
  );

  await sendDocumentDigestEmail({
    db,
    to: settings.digestTo,
    appUrl: settings.appUrl,
    newDrafts,
    pendingDocumentCount: Number(pendingCount?.count || 0),
    runSummary,
  });

  writeDigestState({ date: today, sent: true, at: new Date().toISOString(), count: newDrafts.length });
  return { sent: true };
}

export async function runScheduledDocumentDigest(db) {
  const settings = getDocumentEmailSettings();
  if (!settings.digestEnabled) return { skipped: true, reason: 'digest disabled' };

  const today = new Date().toISOString().slice(0, 10);
  const state = readDigestState();
  if (state.date === today && state.sent) return { skipped: true, reason: 'already sent today' };

  const sinceClause = isPostgres()
    ? "it.created_at >= NOW() - INTERVAL '1 day'"
    : "it.created_at >= datetime('now', '-1 day')";

  const rows = await db.all(
    `SELECT it.description AS vendor, it.amount, it.fitid, oa.account_name AS category_label, it.created_at
     FROM import_transactions it
     JOIN journal_entries je ON je.id = it.journal_entry_id
     LEFT JOIN accounts oa ON oa.id = it.offset_account_id
     WHERE it.status = 'DRAFT' AND je.status = 'DRAFT' AND je.description LIKE 'Email doc:%'
       AND ${sinceClause}
     ORDER BY it.created_at DESC
     LIMIT 50`
  ).catch(() => []);

  if (!rows.length) return { skipped: true, reason: 'no new document drafts in last 24h' };

  const newDrafts = rows.map((r) => ({
    vendor: r.vendor,
    categoryLabel: r.category_label,
    totalCents: Math.round(Math.abs(Number(r.amount || 0)) * 100),
    fitid: r.fitid,
  }));

  const pendingCount = await db.get(
    `SELECT COUNT(*) AS count FROM import_transactions it
     JOIN journal_entries je ON je.id = it.journal_entry_id
     WHERE it.status = 'DRAFT' AND je.status = 'DRAFT' AND je.description LIKE 'Email doc:%'`
  );

  await sendDocumentDigestEmail({
    db,
    to: settings.digestTo,
    appUrl: settings.appUrl,
    newDrafts,
    pendingDocumentCount: Number(pendingCount?.count || 0),
    runSummary: { reason: 'daily-digest' },
  });

  writeDigestState({ date: today, sent: true, at: new Date().toISOString(), count: newDrafts.length });
  return { sent: true, count: newDrafts.length };
}

export async function getDocumentEmailIngestStatus(db = null) {
  const settings = getDocumentEmailSettings();
  let recentImports = [];

  if (db) {
    try {
      await ensureDocumentImportLogTable(db);
      recentImports = await db.all(
        `SELECT message_id, subject, from_address, received_at, status, result_summary, error_message, processed_at
         FROM document_import_log ORDER BY processed_at DESC LIMIT 10`
      ).catch(() => []);
    } catch {
      /* ignore */
    }
  }

  return {
    enabled: settings.enabled,
    intervalHours: settings.intervalHours,
    sinceDays: settings.sinceDays,
    searchQuery: settings.searchQuery,
    digestEnabled: settings.digestEnabled,
    digestHour: settings.digestHour,
    digestTo: settings.digestTo,
    lastRunAt,
    lastRunError,
    lastRunSummary,
    recentImports,
    logFile: path.relative(ROOT, LOG_FILE),
    inboxDir: settings.inboxSaveDir,
  };
}

export function startDocumentEmailIngest(getDb) {
  const settings = getDocumentEmailSettings();
  if (!settings.enabled) {
    console.log('Document email ingest disabled (DOCUMENT_EMAIL_ENABLED=0)');
    return;
  }

  const intervalMs = settings.intervalHours * 60 * 60 * 1000;

  const tick = async (reason) => {
    try {
      const db = await getDb();
      const { resolveAllMailboxes } = await import('./statement-mailbox-store.js');
      const mailboxes = await resolveAllMailboxes(db);
      if (!mailboxes.length) {
        if (reason === 'startup') {
          console.log('Document email ingest: waiting for mailbox connection');
        }
        return;
      }
      const result = await runDocumentEmailIngest(db, { reason });
      if (!result.skipped) {
        console.log(`✓ Document email ingest (${reason}): ${result.draftsCreated || 0} draft(s)`);
      }
    } catch (err) {
      console.error('Document email ingest failed:', err.message);
    }
  };

  if (settings.scanOnStartup) {
    setTimeout(() => tick('startup'), 18_000);
  }

  timer = setInterval(() => tick('scheduled'), intervalMs);
  console.log(`✓ Document email ingest scheduled every ${settings.intervalHours}h`);

  if (settings.digestEnabled) {
    const checkDigest = async () => {
      const now = new Date();
      if (now.getHours() !== settings.digestHour) return;
      try {
        const db = await getDb();
        const result = await runScheduledDocumentDigest(db);
        if (result.sent) {
          console.log(`✓ Document review digest sent (${result.count} item(s))`);
        }
      } catch (err) {
        console.warn('Document digest failed:', err.message);
      }
    };
    digestTimer = setInterval(checkDigest, 15 * 60 * 1000);
    setTimeout(checkDigest, 25_000);
    console.log(`✓ Document review digest scheduled around ${settings.digestHour}:00 local server time`);
  }
}

export function stopDocumentEmailIngest() {
  if (timer) clearInterval(timer);
  if (digestTimer) clearInterval(digestTimer);
  timer = null;
  digestTimer = null;
}
