/** Parse statement email mailbox configuration from environment. */

function parseJsonEnv(name, fallback = null) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function labelKey(label) {
  return String(label || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_');
}

export function resolveMailboxPassword(account) {
  if (account.password) return account.password;
  const label = labelKey(account.label);
  if (label && process.env[`STATEMENT_EMAIL_PASSWORD_${label}`]) {
    return process.env[`STATEMENT_EMAIL_PASSWORD_${label}`];
  }
  if (process.env.STATEMENT_EMAIL_USER === account.user && process.env.STATEMENT_EMAIL_PASSWORD) {
    return process.env.STATEMENT_EMAIL_PASSWORD;
  }
  return null;
}

export function inferImapHost(user, explicitHost) {
  if (explicitHost) return explicitHost;
  const domain = String(user || '').split('@')[1]?.toLowerCase() || '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'imap.gmail.com';
  if (domain === 'ljcfinancial.com' || domain.endsWith('.onmicrosoft.com')) {
    return 'outlook.office365.com';
  }
  return process.env.STATEMENT_EMAIL_HOST || 'imap.gmail.com';
}

export function getStatementEmailAccounts() {
  const multi = parseJsonEnv('STATEMENT_EMAIL_ACCOUNTS');
  if (Array.isArray(multi) && multi.length) {
    return multi.map((a) => ({
      label: a.label || a.user,
      user: a.user,
      password: resolveMailboxPassword(a),
      host: inferImapHost(a.user, a.host),
      port: a.port || Number(process.env.STATEMENT_EMAIL_PORT || 993),
      folder: a.folder || process.env.STATEMENT_EMAIL_FOLDER || 'INBOX',
      processedFolder: a.processedFolder || process.env.STATEMENT_EMAIL_PROCESSED_FOLDER || 'Processed',
      refresh_token: a.refresh_token || null,
    }));
  }

  const user = process.env.STATEMENT_EMAIL_USER;
  if (!user) return [];

  return [{
    label: 'default',
    user,
    password: process.env.STATEMENT_EMAIL_PASSWORD || null,
    host: process.env.STATEMENT_EMAIL_HOST || inferImapHost(user),
    port: Number(process.env.STATEMENT_EMAIL_PORT || 993),
    folder: process.env.STATEMENT_EMAIL_FOLDER || 'INBOX',
    processedFolder: process.env.STATEMENT_EMAIL_PROCESSED_FOLDER || 'Processed',
    refresh_token: null,
  }];
}

export function getGmailOAuthAccounts() {
  const multi = parseJsonEnv('GMAIL_OAUTH_ACCOUNTS');
  if (Array.isArray(multi) && multi.length) {
    return multi.filter((a) => a.user && (a.refresh_token || process.env.GMAIL_OAUTH_REFRESH_TOKEN));
  }
  if (process.env.GMAIL_OAUTH_REFRESH_TOKEN && process.env.GMAIL_OAUTH_USER) {
    return [{
      label: 'documents',
      user: process.env.GMAIL_OAUTH_USER,
      refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
    }];
  }
  return [];
}

export function isGmailOAuthConfigured() {
  return !!(process.env.GMAIL_OAUTH_CLIENT_ID && process.env.GMAIL_OAUTH_CLIENT_SECRET);
}

export function isGraphConfigured() {
  return !!(
    process.env.GRAPH_TENANT_ID
    && process.env.GRAPH_CLIENT_ID
    && process.env.GRAPH_CLIENT_SECRET
    && process.env.GRAPH_MAILBOX_USER
  );
}

export function getEmailIngestSettings() {
  return {
    enabled: process.env.STATEMENT_EMAIL_ENABLED !== '0',
    sinceDays: Math.max(1, Number(process.env.STATEMENT_EMAIL_SINCE_DAYS || 45)),
    intervalHours: Math.max(1, Number(process.env.STATEMENT_EMAIL_INTERVAL_HOURS || 6)),
    scanOnStartup: process.env.STATEMENT_EMAIL_SCAN_ON_STARTUP !== '0',
    searchQuery: process.env.STATEMENT_EMAIL_SEARCH_QUERY
      || 'has:attachment (statement OR bank OR simmons OR "lone star" OR amex OR shellpoint)',
    defaultEntityId: process.env.STATEMENT_EMAIL_ENTITY_ID || 'ent-ljc',
    inboxSaveDir: process.env.STATEMENT_EMAIL_INBOX_DIR || 'data/bank-imports/inbox',
  };
}

/** Unified mailboxes: OAuth Gmail, Graph, and IMAP (deduped by user). */
export function getAllMailboxes() {
  const seen = new Set();
  const out = [];

  const gmailOAuth = isGmailOAuthConfigured() ? getGmailOAuthAccounts() : [];

  for (const g of gmailOAuth) {
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

  if (isGraphConfigured()) {
    const user = process.env.GRAPH_MAILBOX_USER;
    if (user && !seen.has(user)) {
      seen.add(user);
      out.push({ label: 'graph', user, transport: 'graph' });
    }
  }

  for (const imap of getStatementEmailAccounts()) {
    if (seen.has(imap.user)) continue;
    const oauth = gmailOAuth.find((g) => g.user === imap.user);
    if (oauth?.refresh_token) {
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
