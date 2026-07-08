import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import {
  getEmailIngestSettings,
  isGmailOAuthConfigured,
} from './statement-email-config.js';
import { resolveAllMailboxes, markMailboxSync, ensureStatementMailboxTable, listStatementMailboxes } from './statement-mailbox-store.js';
import { fetchGmailMessages } from './gmail-oauth-mail.js';
import { fetchGraphMessages } from './graph-mail.js';
import { fetchImapMessages } from './statement-email-imap.js';
import { mergeStatementJson } from './statement-json-merge.js';
import { importStatementForReconcile } from './reconcile-statement-import.js';
import { BANK_ACCOUNTS } from '../config/bank-import-targets.js';
import {
  fetchLonestarStatementForNotification,
  isLonestarEStatementNotification,
} from './lonestar-estatement-fetch.js';
import { getLonestarPortalConfig } from './lonestar-estatement-notify.js';
import { downloadLonestarStatementFromPortal } from './lonestar-portal-download.js';
import { extractPdfStatementFromFile } from './extract-pdf-statement.js';

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

export function readEmailIngestLog() {
  return readLog();
}

export async function ensureEmailImportLogTable(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS email_import_log (
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

export function detectBankTarget({ subject, from, fileName, text = '' }) {
  const hay = `${subject} ${from} ${fileName} ${text}`.toLowerCase();
  for (const det of BANK_DETECTORS) {
    if (det.patterns.some((p) => p.test(hay))) {
      return { entityId: det.entityId, accountNumber: det.accountNumber };
    }
  }
  return null;
}

export function isStatementAttachment(name) {
  return /\.(pdf|ofx|qfx)$/i.test(name || '');
}

export function isDocumentAttachment(name) {
  return /\.(pdf|jpe?g|png|gif|webp|tiff?|bmp|heic|txt|csv|docx?|xlsx?)$/i.test(name || '');
}

async function extractPdfStatement(pdfPath) {
  try {
    return await extractPdfStatementFromFile(pdfPath);
  } catch (nodeErr) {
    const script = path.join(ROOT, 'scripts/extract-simmons-pdf.py');
    try {
      const { stdout } = await execFileAsync('python3', [script, pdfPath], {
        maxBuffer: 25 * 1024 * 1024,
      });
      const data = JSON.parse(stdout);
      if (data.error) throw new Error(data.error);
      return data;
    } catch {
      throw new Error(`PDF extract failed: ${nodeErr.message}`);
    }
  }
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

async function importLonestarPdf(db, {
  buffer,
  fileName,
  source,
  settings,
  userId,
  email,
}) {
  const account = await resolveAccountId(db, 'ent-ljc', '1001');
  if (!account) {
    return { skipped: true, reason: 'Lone Star account 1001 not found' };
  }

  const savedPath = saveInboxFile(
    settings,
    email.mailbox,
    email.messageId,
    fileName,
    buffer
  );

  const fullPath = path.join(ROOT, savedPath);
  const parsed = await extractPdfStatement(fullPath);
  parsed.file = fileName;
  const mergeResult = mergeStatementJson('1001', parsed);
  const importResult = await importStatementForReconcile(db, {
    entityId: 'ent-ljc',
    accountId: account.id,
    userId,
    pdfBase64: buffer.toString('base64'),
    fileName,
    autoPost: true,
  });

  return {
    savedPath,
    accountNumber: '1001',
    entityId: 'ent-ljc',
    mergeResult,
    importResult,
    downloadSource: source,
  };
}

async function processLonestarNotification(db, { email, settings, userId }) {
  if (!isLonestarEStatementNotification(email)) {
    return { skipped: true, reason: 'not a Lone Star eStatement notification' };
  }

  const fetchResult = await fetchLonestarStatementForNotification(email);
  if (fetchResult.skipped) {
    return { skipped: true, reason: fetchResult.reason, meta: fetchResult.meta };
  }

  return importLonestarPdf(db, {
    buffer: fetchResult.buffer,
    fileName: fetchResult.fileName || 'lonestar-estatement.pdf',
    source: fetchResult.source,
    settings,
    userId,
    email,
  });
}

async function processLonestarPortalDirect(db, { settings, userId, reason = 'manual' }) {
  const messageId = `portal:lonestar:${new Date().toISOString().slice(0, 10)}:${reason}`;
  const skipCheck = await shouldSkipProcessedEmail(db, {
    messageId,
    subject: 'Lone Star portal direct download',
    from: 'my.lsbtexas.com',
    attachments: [],
  }, []);
  if (skipCheck.skip) {
    return { skipped: true, reason: skipCheck.reason || 'already downloaded today' };
  }

  const fetchResult = await downloadLonestarStatementFromPortal({});
  const email = {
    messageId,
    subject: 'Lone Star portal direct download',
    from: 'my.lsbtexas.com',
    receivedAt: new Date().toISOString(),
    mailbox: 'lonestar-portal',
  };

  const result = await importLonestarPdf(db, {
    buffer: fetchResult.buffer,
    fileName: fetchResult.fileName || 'lonestar-estatement.pdf',
    source: fetchResult.source,
    settings,
    userId,
    email,
  });

  await logEmailImport(db, {
    messageId,
    entityId: 'ent-ljc',
    from: email.from,
    subject: email.subject,
    receivedAt: email.receivedAt,
    attachmentCount: 1,
    status: 'PROCESSED',
    resultSummary: `Downloaded Lone Star eStatement from portal (${fetchResult.source})`,
    errorMessage: null,
    userId,
  });

  return { ...result, portalDirect: true };
}

async function getEmailImportRow(db, messageId) {
  return db.get(
    `SELECT id, status, result_summary, error_message FROM email_import_log WHERE message_id = ?`,
    [messageId]
  );
}

/** Skip only successful imports; retry PARTIAL/failed Lone Star portal downloads. */
async function shouldSkipProcessedEmail(db, email, stmtAttachments) {
  const row = await getEmailImportRow(db, email.messageId);
  if (!row) return { skip: false, retried: false };

  const isLonestarNotify = !stmtAttachments.length && isLonestarEStatementNotification(email);
  const isPortalDirect = String(email.messageId || '').startsWith('portal:lonestar:');
  const summary = row.result_summary || '';
  const succeeded = /Downloaded Lone Star|Imported \d+ attachment/i.test(summary)
    && !row.error_message
    && row.status !== 'PARTIAL';

  if ((isLonestarNotify || isPortalDirect) && !succeeded) {
    return { skip: false, retried: true };
  }

  return { skip: true, retried: false, reason: 'already processed' };
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

export async function collectMailboxMessages(db, settings) {
  const messages = [];
  const seenIds = new Set();
  const sinceDays = settings.sinceDays;
  const searchQuery = settings.searchQuery;
  const lonestarQuery = 'in:anywhere (from:lsbtexas.com OR from:info@lsbtexas.com OR subject:estatement)';
  const lonestarBroadQuery = 'in:anywhere from:info@lsbtexas.com';
  const mailboxes = await resolveAllMailboxes(db);
  const mailboxStats = [];

  const pushMsg = (msg) => {
    if (!msg?.messageId || seenIds.has(msg.messageId)) return;
    seenIds.add(msg.messageId);
    messages.push(msg);
  };

  for (const mb of mailboxes) {
    let fetched = 0;
    try {
      if (mb.transport === 'gmail-oauth') {
        for await (const msg of fetchGmailMessages({
          user: mb.user,
          refresh_token: mb.refresh_token,
          sinceDays,
          searchQuery,
        })) {
          pushMsg(msg);
          fetched += 1;
        }
        for await (const msg of fetchGmailMessages({
          user: mb.user,
          refresh_token: mb.refresh_token,
          sinceDays,
          searchQuery: lonestarQuery,
        })) {
          pushMsg(msg);
          fetched += 1;
        }
        for await (const msg of fetchGmailMessages({
          user: mb.user,
          refresh_token: mb.refresh_token,
          sinceDays: Math.max(sinceDays, 90),
          searchQuery: lonestarBroadQuery,
        })) {
          pushMsg(msg);
          fetched += 1;
        }
        await markMailboxSync(db, mb.user);
        mailboxStats.push({ user: mb.user, transport: mb.transport, fetched, error: null });
      } else if (mb.transport === 'graph') {
        for await (const msg of fetchGraphMessages({ user: mb.user, sinceDays })) {
          pushMsg(msg);
          fetched += 1;
        }
        await markMailboxSync(db, mb.user);
        mailboxStats.push({ user: mb.user, transport: mb.transport, fetched, error: null });
      } else if (mb.transport === 'imap') {
        const imapMsgs = await fetchImapMessages({
          user: mb.user,
          password: mb.password,
          host: mb.host,
          port: mb.port,
          folder: mb.folder,
          sinceDays,
        });
        for (const msg of imapMsgs) {
          pushMsg(msg);
          fetched += 1;
        }
        await markMailboxSync(db, mb.user);
        mailboxStats.push({ user: mb.user, transport: mb.transport, fetched, error: null });
      }
    } catch (err) {
      const imapText = err.responseText ? `${err.message}: ${err.responseText}` : err.message;
      const detail = err.stderr?.toString()?.trim() || imapText || String(err);
      await markMailboxSync(db, mb.user, { error: detail.slice(0, 500) });
      messages.push({ error: detail.slice(0, 500), mailbox: mb.user, transport: mb.transport });
      mailboxStats.push({ user: mb.user, transport: mb.transport, fetched, error: detail.slice(0, 500) });
    }
  }

  return { messages, mailboxes, mailboxStats };
}

export async function runStatementEmailIngest(db, { reason = 'scheduled', userId = 'usr-admin' } = {}) {
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
    await ensureStatementMailboxTable(db);
    const { messages, mailboxes: configuredMailboxes, mailboxStats } = await collectMailboxMessages(db, settings);

    for (const email of messages) {
      if (email.error) {
        results.push({ mailbox: email.mailbox, transport: email.transport, error: email.error });
        continue;
      }

      const stmtAttachments = (email.attachments || []).filter((a) => isStatementAttachment(a.filename));
      const isLonestarNotify = !stmtAttachments.length && isLonestarEStatementNotification(email);

      const skipCheck = await shouldSkipProcessedEmail(db, email, stmtAttachments);
      if (skipCheck.skip) {
        results.push({
          messageId: email.messageId,
          skipped: true,
          reason: skipCheck.reason || 'already processed',
        });
        continue;
      }

      if (!stmtAttachments.length && !isLonestarNotify) {
        continue;
      }

      const attachmentResults = [];
      let entityId = settings.defaultEntityId;
      let hadError = false;

      if (isLonestarNotify) {
        try {
          const r = await processLonestarNotification(db, { email, settings, userId });
          attachmentResults.push(r);
          if (r.entityId) entityId = r.entityId;
        } catch (err) {
          hadError = true;
          attachmentResults.push({ error: err.message, lonestarNotification: true });
        }
      }

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
      const downloaded = attachmentResults.filter((r) => r.downloadSource && !r.skipped).length;
      const summary = imported
        ? `Imported ${imported} attachment(s) from "${email.subject}"`
        : downloaded
          ? `Downloaded Lone Star eStatement from "${email.subject}" (${attachmentResults.find((r) => r.downloadSource)?.downloadSource})`
          : attachmentResults.every((r) => r.skipped)
            ? attachmentResults[0]?.reason || 'No actionable attachments'
            : `Processed ${attachmentResults.length} attachment(s)`;

      await logEmailImport(db, {
        messageId: email.messageId,
        entityId,
        from: email.from,
        subject: email.subject,
        receivedAt: email.receivedAt,
        attachmentCount: stmtAttachments.length + (isLonestarNotify ? 1 : 0),
        status: hadError ? 'PARTIAL' : 'PROCESSED',
        resultSummary: hadError
          ? (attachmentResults.find((r) => r.error)?.error || summary)
          : summary,
        errorMessage: hadError ? attachmentResults.filter((r) => r.error).map((r) => r.error).join('; ') : null,
        userId,
      });

      results.push({
        messageId: email.messageId,
        subject: email.subject,
        mailbox: email.mailbox,
        attachmentResults,
        summary,
        retried: skipCheck.retried,
        lonestarNotification: isLonestarNotify,
      });
    }

    const hadLonestarDownload = results.some((r) =>
      r.attachmentResults?.some((a) =>
        (a.downloadSource && !a.skipped && !a.error)
        || (a.importResult?.imported > 0)
      )
    );

    if (getLonestarPortalConfig().enabled && !hadLonestarDownload) {
      try {
        const r = await processLonestarPortalDirect(db, { settings, userId, reason });
        results.push({
          messageId: 'portal:lonestar:manual',
          subject: 'Lone Star portal direct download',
          portalDirect: true,
          attachmentResults: [r],
          summary: r.skipped ? r.reason : `Downloaded Lone Star eStatement (${r.downloadSource})`,
        });
      } catch (err) {
        results.push({
          error: err.message,
          portalDirect: true,
          mailbox: 'lonestar-portal',
          transport: 'portal',
        });
      }
    }

    const lonestarNoticesFound = messages.filter(
      (m) => !m.error && isLonestarEStatementNotification(m)
    ).length;

    const summary = {
      reason,
      startedAt,
      finishedAt: new Date().toISOString(),
      mailboxesConfigured: configuredMailboxes.map((m) => ({ user: m.user, transport: m.transport })),
      bankAccounts: BANK_ACCOUNTS[settings.defaultEntityId] || [],
      messagesFetched: messages.filter((m) => !m.error).length,
      mailboxStats: mailboxStats || [],
      gmailOAuthConfigured: !!(
        process.env.GMAIL_OAUTH_CLIENT_ID && process.env.GMAIL_OAUTH_CLIENT_SECRET
      ),
      lonestarNoticesFound,
      lonestarPortalConfigured: getLonestarPortalConfig().enabled,
      processedEmails: results.filter((r) => !r.skipped && !r.error).length,
      skippedEmails: results.filter((r) => r.skipped).length,
      errors: results.filter((r) => r.error),
      results: results.slice(0, 30),
    };

    lastRunAt = summary.finishedAt;
    lastRunError = summary.errors.length ? summary.errors.map((e) => e.error).join('; ') : null;
    lastRunSummary = summary;
    appendLog(summary);

    try {
      const { runStatementAutoLoad } = await import('./statement-auto-load.js');
      await runStatementAutoLoad(db, { reason: 'after-email-ingest' });
    } catch {
      /* non-fatal */
    }

    return summary;
  } catch (err) {
    lastRunError = err.message;
    throw err;
  } finally {
    running = false;
  }
}

export async function getStatementEmailIngestStatus(db = null) {
  const settings = getEmailIngestSettings();
  let mailboxes = [];
  let recentImports = [];

  if (db) {
    try {
      await ensureStatementMailboxTable(db);
      mailboxes = await listStatementMailboxes(db);
      recentImports = await db.all(
        `SELECT message_id, subject, from_address, received_at, status, result_summary, error_message, processed_at
         FROM email_import_log ORDER BY processed_at DESC LIMIT 10`
      ).catch(() => []);
    } catch {
      /* ignore */
    }
  }

  const resolved = db ? await resolveAllMailboxes(db).catch(() => []) : [];

  return {
    enabled: settings.enabled,
    intervalHours: settings.intervalHours,
    sinceDays: settings.sinceDays,
    mailboxes: resolved.map((m) => ({
      user: m.user,
      transport: m.transport,
      configured: m.transport === 'imap' ? !!m.password : true,
    })),
    storedMailboxes: mailboxes,
    gmailOAuth: isGmailOAuthConfigured(),
    graphConfigured: !!(
      process.env.GRAPH_TENANT_ID
      && process.env.GRAPH_CLIENT_ID
      && process.env.GRAPH_CLIENT_SECRET
      && process.env.GRAPH_MAILBOX_USER
    ),
    graphMailbox: process.env.GRAPH_MAILBOX_USER || null,
    lonestarPortal: {
      configured: getLonestarPortalConfig().enabled,
      accountLast4: getLonestarPortalConfig().accountLast4,
    },
    gmailOAuthConfigured: !!(
      process.env.GMAIL_OAUTH_CLIENT_ID && process.env.GMAIL_OAUTH_CLIENT_SECRET
    ),
    lastRunAt,
    lastRunError,
    lastRunSummary,
    recentImports,
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

  const intervalMs = settings.intervalHours * 60 * 60 * 1000;

  const tick = async (reason) => {
    try {
      const db = await getDb();
      const mailboxes = await resolveAllMailboxes(db);
      if (!mailboxes.length) {
        if (reason === 'startup') {
          console.log('Statement email ingest: waiting for mailbox connection (Banking → Connect bank email…)');
        }
        return;
      }
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
  console.log(`✓ Statement email ingest scheduled every ${settings.intervalHours}h`);
}

export function stopStatementEmailIngest() {
  if (timer) clearInterval(timer);
  timer = null;
}
