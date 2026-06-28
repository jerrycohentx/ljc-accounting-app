import { encryptSecret, decryptSecret } from './token-crypto.js';
import {
  getStatementEmailAccounts,
  getGmailOAuthAccounts,
  isGmailOAuthConfigured,
  isGraphConfigured,
  inferImapHost,
} from './statement-email-config.js';

export const STATEMENT_MAILBOX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS statement_mailboxes (
  id TEXT PRIMARY KEY,
  entity_id TEXT,
  label TEXT,
  email_user TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  password_encrypted TEXT,
  imap_host TEXT,
  status TEXT DEFAULT 'CONNECTED',
  last_sync_at TIMESTAMP,
  last_error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_statement_mailboxes_user ON statement_mailboxes(email_user);
`;

export async function ensureStatementMailboxTable(db) {
  for (const stmt of STATEMENT_MAILBOX_SCHEMA_SQL.split(';').filter((s) => s.trim())) {
    await db.run(stmt);
  }
}

export async function listStatementMailboxes(db) {
  await ensureStatementMailboxTable(db);
  return db.all(
    `SELECT id, entity_id, label, email_user, transport, imap_host, status, last_sync_at, last_error, created_at
     FROM statement_mailboxes WHERE status = 'CONNECTED' ORDER BY email_user ASC`
  );
}

export async function upsertGmailMailbox(db, {
  entityId = 'ent-ljc',
  label,
  user,
  refreshToken,
}) {
  await ensureStatementMailboxTable(db);
  const existing = await db.get('SELECT id FROM statement_mailboxes WHERE email_user = ?', [user]);
  const id = existing?.id || `smb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const enc = encryptSecret(refreshToken);
  if (existing) {
    await db.run(
      `UPDATE statement_mailboxes SET refresh_token_encrypted = ?, transport = 'gmail-oauth',
       status = 'CONNECTED', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE email_user = ?`,
      [enc, user]
    );
  } else {
    await db.run(
      `INSERT INTO statement_mailboxes (id, entity_id, label, email_user, transport, refresh_token_encrypted, status)
       VALUES (?, ?, ?, ?, 'gmail-oauth', ?, 'CONNECTED')`,
      [id, entityId, label || user, user, enc]
    );
  }
  return { id, user, transport: 'gmail-oauth' };
}

export async function upsertImapMailbox(db, {
  entityId = 'ent-ljc',
  label,
  user,
  password,
  host,
}) {
  await ensureStatementMailboxTable(db);
  const existing = await db.get('SELECT id FROM statement_mailboxes WHERE email_user = ?', [user]);
  const id = existing?.id || `smb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const enc = encryptSecret(password);
  if (existing) {
    await db.run(
      `UPDATE statement_mailboxes SET password_encrypted = ?, imap_host = ?, transport = 'imap',
       status = 'CONNECTED', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE email_user = ?`,
      [enc, host, user]
    );
  } else {
    await db.run(
      `INSERT INTO statement_mailboxes (id, entity_id, label, email_user, transport, password_encrypted, imap_host, status)
       VALUES (?, ?, ?, ?, 'imap', ?, ?, 'CONNECTED')`,
      [id, entityId, label || user, user, enc, host]
    );
  }
  return { id, user, transport: 'imap' };
}

export async function disconnectMailbox(db, user) {
  await db.run(
    `UPDATE statement_mailboxes SET status = 'DISCONNECTED', updated_at = CURRENT_TIMESTAMP WHERE email_user = ?`,
    [user]
  );
}

export async function markMailboxSync(db, user, { error = null } = {}) {
  if (error) {
    await db.run(
      `UPDATE statement_mailboxes SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE email_user = ?`,
      [error, user]
    );
  } else {
    await db.run(
      `UPDATE statement_mailboxes SET last_sync_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE email_user = ?`,
      [user]
    );
  }
}

export async function resolveAllMailboxes(db) {
  const seen = new Set();
  const out = [];

  const dbRows = await listStatementMailboxes(db);
  for (const row of dbRows) {
    seen.add(row.email_user);
    if (row.transport === 'gmail-oauth') {
      const full = await db.get(
        'SELECT refresh_token_encrypted FROM statement_mailboxes WHERE email_user = ?',
        [row.email_user]
      );
      if (full?.refresh_token_encrypted) {
        out.push({
          label: row.label,
          user: row.email_user,
          refresh_token: decryptSecret(full.refresh_token_encrypted),
          transport: 'gmail-oauth',
        });
      }
    } else if (row.transport === 'imap') {
      const full = await db.get(
        'SELECT password_encrypted, imap_host FROM statement_mailboxes WHERE email_user = ?',
        [row.email_user]
      );
      if (full?.password_encrypted) {
        out.push({
          label: row.label,
          user: row.email_user,
          password: decryptSecret(full.password_encrypted),
          host: full.imap_host || inferImapHost(row.email_user),
          port: 993,
          folder: 'INBOX',
          transport: 'imap',
        });
      }
    }
  }

  if (isGmailOAuthConfigured()) {
    for (const g of getGmailOAuthAccounts()) {
      if (g.user && g.refresh_token && !seen.has(g.user)) {
        seen.add(g.user);
        out.push({
          label: g.label || g.user,
          user: g.user,
          refresh_token: g.refresh_token,
          transport: 'gmail-oauth',
        });
      }
    }
  }

  if (isGraphConfigured()) {
    const user = process.env.GRAPH_MAILBOX_USER;
    if (user && !seen.has(user)) {
      seen.add(user);
      out.push({ label: 'graph', user, transport: 'graph' });
    }
  }

  for (const imap of getStatementEmailAccounts()) {
    if (seen.has(imap.user)) continue;
    const oauth = getGmailOAuthAccounts().find((g) => g.user === imap.user);
    if (oauth?.refresh_token && isGmailOAuthConfigured()) {
      seen.add(imap.user);
      out.push({ ...oauth, transport: 'gmail-oauth' });
      continue;
    }
    if (!imap.password) continue;
    seen.add(imap.user);
    out.push({ ...imap, transport: 'imap' });
  }

  return out;
}
