import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import {
  getAllMailboxes,
  getEmailIngestSettings,
  isGmailOAuthConfigured,
} from './statement-email-config.js';
import { fetchGmailMessages } from './gmail-oauth-mail.js';
import { fetchGraphMessages } from './graph-mail.js';
import { fetchImapMessages } from './statement-email-imap.js';
import { mergeStatementJson } from './statement-json-merge.js';
import { importStatementForReconcile } from './reconcile-statement-import.js';
import { BANK_ACCOUNTS } from '../config/bank-import-targets.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const LOG_DIR = process.env.STATEMENT_EMAIL_LOG_DIR || path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'statement-email-ingest.json');

let timer = null;
let lastRunAt = null;
let lastRunError = null;
let lastRunSummary = null;
let running = false;

const BANK_DETECTORS = [
  { entityId: 'ent-ljc', accountNumber: '1001', patterns: [/lone\s*star/i, /7367/i, /lonestar/i] },
  { entityId: 'ent-ljc', accountNumber: '1000', patterns: [/simmons/i, /0260/i] },
  { entityId: 'ent-ljc', accountNumber: '2010', patterns: [/amex/i, /american express/i, /88007/i] },
];

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

export async function ensureEmailImportLogTable(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS email_import_log (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      entity_id TEXT NOT NULL,
      from_address TEXT,
      subject TEXT,
      received_at DATETIME,
      attachment_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'PROCESSED',
      result_summary TEXT,
      error_message TEXT,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_by TEXT
    )
  `);
}

export function detectBankTarget({ subject, from, fileName, text = '' }) {
  const hay = `${subject} ${from} ${fileName} ${text}`.toLowerCase();
  for (const det of BANK_DETECTORS) {
    if (det.patterns.some((p) => p.test(hay))) {
      return { entityId: det.entityId, accountNumber: det.accountNumber };
    }
  }
  return null;
}

function isStatementAttachment(name) {
  return /\.(pdf|ofx|qfx)$/i.test(name || '');
}

async function extractPdfStatement(pdfPath) {
  const script = path.join(ROOT, 'scripts/extract-simmons-pdf.py');
  const { stdout } = await execFileAsync('python3', [script, pdfPath], {
    maxBuffer: 25 * 1024 * 1024,
  });
  const data = JSON.parse(stdout);
  if (data.error) throw new Error(data.error);
  return data;
}

async function resolveAccountId(db, entityId, accountNumber) {
  return db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, accountNumber]
  );
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

async function processAttachment(db, {
  attachment,
  email,
  settings,
  userId,
}) {
  const fileName = attachment.filename;
  if (!isStatementAttachment(fileName)) {
    return { skipped: true, reason: 'not a statement file type' };
  }

  const target = detectBankTarget({
    subject: email.subject,
    from: email.from,
    fileName,
    text: email.text || '',
  });
  if (!target) {
    return { skipped: true, reason: 'could not detect bank account from email' };
  }

  const account = await resolveAccountId(db, target.entityId, target.accountNumber);
  if (!account) {
    return { skipped: true, reason: `account ${target.accountNumber} not found` };
  }

  const savedPath = saveInboxFile(
    settings,
    email.mailbox,
    email.messageId,
    fileName,
    attachment.content
  );

  const ext = path.extname(fileName).toLowerCase();
  let importResult = null;
  let mergeResult = null;

  if (ext === '.pdf') {
    const fullPath = path.join(ROOT, savedPath);
    const parsed = await extractPdfStatement(fullPath);
    parsed.file = fileName;
    mergeResult = mergeStatementJson(target.accountNumber, parsed);
    importResult = await importStatementForReconcile(db, {
      entityId: target.entityId,
      accountId: account.id,
      userId,
      pdfBase64: attachment.content.toString('base64'),
      fileName,
      autoPost: true,
    });
  } else {
    const ofxContent = attachment.content.toString('utf8');
    importResult = await importStatementForReconcile(db, {
      entityId: target.entityId,
      accountId: account.id,
      userId,
      ofxContent,
      fileName,
      autoPost: true,
    });
  }

  return {
    savedPath,
    accountNumber: target.accountNumber,
    entityId: target.entityId,
    mergeResult,
    importResult,
  };
}

async function alreadyProcessed(db, messageId) {
  const row = await db.get(
    'SELECT id, status FROM email_import_log WHERE message_id = ?',
    [messageId]
  );
  return !!row;
}

async function logEmailImport(db, {
  messageId,
  entityId,
  from,
  subject,
  receivedAt,
  attachmentCount,
  status,
  resultSummary,
  errorMessage,
  userId,
}) {
  const existing = await db.get(
    'SELECT id FROM email_import_log WHERE message_id = ?',
    [messageId]
  );
  const id = existing?.id || `eil-${uuidv4()}`;
  if (existing) {
    await db.run(
      `UPDATE email_import_log SET
        entity_id = ?, from_address = ?, subject = ?, received_at = ?,
        attachment_count = ?, status = ?, result_summary = ?, error_message = ?,
        processed_at = CURRENT_TIMESTAMP, processed_by = ?
       WHERE message_id = ?`,
      [
        entityId, from, subject, receivedAt, attachmentCount,
        status, resultSummary, errorMessage || null, userId, messageId,
      ]
    );
  } else {
    await db.run(
      `INSERT INTO email_import_log (
        id, message_id, entity_id, from_address, subject, received_at,
        attachment_count, status, result_summary, error_message, processed_at, processed_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
      [
        id, messageId, entityId, from, subject, receivedAt,
        attachmentCount, status, resultSummary, errorMessage || null, userId,
      ]
    );
  }
}

async function collectMessages(settings) {
  const messages = [];
  const sinceDays = settings.sinceDays;
  const searchQuery = settings.searchQuery;

  for (const mb of getAllMailboxes()) {
    try {
      if (mb.transport === 'gmail-oauth') {
        for await (const msg of fetchGmailMessages({
          user: mb.user,
          refresh_token: mb.refresh_token,
          sinceDays,
          searchQuery,
        })) {
          messages.push(msg);
        }
      } else if (mb.transport === 'graph') {
        for await (const msg of fetchGraphMessages({ user: mb.user, sinceDays })) {
          messages.push(msg);
        }
      } else if (mb.transport === 'imap') {
        const imapMsgs = await fetchImapMessages({
          user: mb.user,
          password: mb.password,
          host: mb.host,
          port: mb.port,
          folder: mb.folder,
          sinceDays,
        });
        messages.push(...imapMsgs);
      }
    } catch (err) {
      messages.push({ error: err.message, mailbox: mb.user, transport: mb.transport });
    }
  }

  return messages;
}

export async function runStatementEmailIngest(db, { reason = 'scheduled', userId = 'system-email-ingest' } = {}) {
  if (running) return { skipped: true, reason: 'already running' };

  const settings = getEmailIngestSettings();
  if (!settings.enabled) {
    return { skipped: true, reason: 'disabled' };
  }

  running = true;
  const startedAt = new Date().toISOString();
  const results = [];

  try {
    await ensureEmailImportLogTable(db);
    const messages = await collectMessages(settings);

    for (const email of messages) {
      if (email.error) {
        results.push({ mailbox: email.mailbox, transport: email.transport, error: email.error });
        continue;
      }

      if (await alreadyProcessed(db, email.messageId)) {
        results.push({ messageId: email.messageId, skipped: true, reason: 'already processed' });
        continue;
      }

      const stmtAttachments = (email.attachments || []).filter((a) => isStatementAttachment(a.filename));
      if (!stmtAttachments.length) {
        continue;
      }

      const attachmentResults = [];
      let entityId = settings.defaultEntityId;
      let hadError = false;

      for (const att of stmtAttachments) {
        try {
          const r = await processAttachment(db, { attachment: att, email, settings, userId });
          attachmentResults.push(r);
          if (r.entityId) entityId = r.entityId;
        } catch (err) {
          hadError = true;
          attachmentResults.push({ fileName: att.filename, error: err.message });
        }
      }

      const imported = attachmentResults.filter((r) => r.importResult?.imported > 0).length;
      const summary = imported
        ? `Imported ${imported} attachment(s) from "${email.subject}"`
        : attachmentResults.every((r) => r.skipped)
          ? 'No actionable attachments'
          : `Processed ${attachmentResults.length} attachment(s)`;

      await logEmailImport(db, {
        messageId: email.messageId,
        entityId,
        from: email.from,
        subject: email.subject,
        receivedAt: email.receivedAt,
        attachmentCount: stmtAttachments.length,
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
      mailboxesConfigured: getAllMailboxes().map((m) => ({ user: m.user, transport: m.transport })),
      bankAccounts: BANK_ACCOUNTS[settings.defaultEntityId] || [],
      processedEmails: results.filter((r) => !r.skipped && !r.error).length,
      skippedEmails: results.filter((r) => r.skipped).length,
      errors: results.filter((r) => r.error),
      results: results.slice(0, 30),
    };

    lastRunAt = summary.finishedAt;
    lastRunError = summary.errors.length ? summary.errors.map((e) => e.error).join('; ') : null;
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

export function getStatementEmailIngestStatus() {
  const settings = getEmailIngestSettings();
  return {
    enabled: settings.enabled,
    intervalHours: settings.intervalHours,
    sinceDays: settings.sinceDays,
    mailboxes: getAllMailboxes().map((m) => ({
      user: m.user,
      transport: m.transport,
      configured: m.transport === 'imap' ? !!m.password : true,
    })),
    gmailOAuth: isGmailOAuthConfigured(),
    lastRunAt,
    lastRunError,
    lastRunSummary,
    logFile: path.relative(ROOT, LOG_FILE),
    inboxDir: settings.inboxSaveDir,
  };
}

export function startStatementEmailIngest(getDb) {
  const settings = getEmailIngestSettings();
  if (!settings.enabled) {
    console.log('Statement email ingest disabled (STATEMENT_EMAIL_ENABLED=0)');
    return;
  }

  const mailboxes = getAllMailboxes();
  if (!mailboxes.length) {
    console.log('Statement email ingest: no mailboxes configured (set STATEMENT_EMAIL_ACCOUNTS or GMAIL_OAUTH_*)');
    return;
  }

  const intervalMs = settings.intervalHours * 60 * 60 * 1000;

  const tick = async (reason) => {
    try {
      const db = await getDb();
      const result = await runStatementEmailIngest(db, { reason });
      if (!result.skipped) {
        console.log(`✓ Statement email ingest (${reason}): ${result.processedEmails || 0} email(s)`);
      }
    } catch (err) {
      console.error('Statement email ingest failed:', err.message);
    }
  };

  if (settings.scanOnStartup) {
    setTimeout(() => tick('startup'), 12_000);
  }

  timer = setInterval(() => tick('scheduled'), intervalMs);
  console.log(`✓ Statement email ingest scheduled every ${settings.intervalHours}h (${mailboxes.length} mailbox(es))`);
}

export function stopStatementEmailIngest() {
  if (timer) clearInterval(timer);
  timer = null;
}
