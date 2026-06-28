/**
 * Gmail OAuth for bank statement email ingest.
 * Public callback (no JWT). Protected connect/status routes.
 */

import express from 'express';
import jwt from 'jsonwebtoken';
import {
  getGmailOAuthAccounts,
} from '../lib/statement-email-config.js';
import {
  upsertGmailMailbox,
  disconnectMailbox,
  listStatementMailboxes,
  ensureStatementMailboxTable,
} from '../lib/statement-mailbox-store.js';
import { getDatabase } from '../config/database.js';

const router = express.Router();

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

function redirectUri() {
  return process.env.GMAIL_OAUTH_REDIRECT_URI
    || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/api/email/gmail/callback`;
}

function oauthConfigured() {
  return !!(process.env.GMAIL_OAUTH_CLIENT_ID && process.env.GMAIL_OAUTH_CLIENT_SECRET);
}

router.get('/status', async (req, res) => {
  try {
    const db = await getDatabase();
    await ensureStatementMailboxTable(db);
    const dbMailboxes = await listStatementMailboxes(db);
    const envAccounts = getGmailOAuthAccounts();
    const configured = oauthConfigured();

    const targets = [
      { label: 'documents', user: 'documents.ljcfinancial@gmail.com' },
      { label: 'jerrycohentx', user: 'jerrycohentx@gmail.com' },
    ];

    const accounts = targets.map((t) => {
      const dbRow = dbMailboxes.find((m) => m.email_user === t.user && m.transport === 'gmail-oauth');
      const envRow = envAccounts.find((a) => a.user === t.user);
      return {
        ...t,
        connected: !!(dbRow || envRow?.refresh_token),
        source: dbRow ? 'database' : envRow?.refresh_token ? 'environment' : null,
        lastSyncAt: dbRow?.last_sync_at || null,
        lastError: dbRow?.last_error || null,
      };
    });

    return res.json({
      configured,
      redirectUri: redirectUri(),
      accounts,
      graphConfigured: !!(
        process.env.GRAPH_TENANT_ID
        && process.env.GRAPH_CLIENT_ID
        && process.env.GRAPH_CLIENT_SECRET
        && process.env.GRAPH_MAILBOX_USER
      ),
      graphMailbox: process.env.GRAPH_MAILBOX_USER || null,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/auth-url', async (req, res) => {
  try {
    if (!oauthConfigured()) {
      return res.status(503).json({
        error: 'Gmail OAuth not configured on server',
        hint: 'Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET on Render',
      });
    }

    const user = req.query.user || process.env.GMAIL_OAUTH_USER || 'documents.ljcfinancial@gmail.com';
    const label = req.query.label || user.split('@')[0];

    const state = jwt.sign(
      { user, label, purpose: 'gmail-statement-ingest' },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    const params = new URLSearchParams({
      client_id: process.env.GMAIL_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: GMAIL_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      login_hint: user,
      state,
    });

    return res.json({
      authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      user,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/** OAuth callback — no auth middleware */
export async function gmailOAuthCallbackHandler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(htmlPage('Connection failed', String(error), false));
  }
  if (!code || !state) {
    return res.status(400).send(htmlPage('Connection failed', 'Missing authorization code', false));
  }

  try {
    let payload;
    try {
      payload = jwt.verify(state, process.env.JWT_SECRET);
    } catch {
      return res.status(400).send(htmlPage('Connection failed', 'Session expired — try Connect again', false));
    }

    if (payload.purpose !== 'gmail-statement-ingest') {
      return res.status(400).send(htmlPage('Connection failed', 'Invalid state', false));
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GMAIL_OAUTH_CLIENT_ID,
        client_secret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) {
      return res.status(400).send(htmlPage(
        'Connection incomplete',
        'Google did not return a refresh token. Revoke app access at myaccount.google.com/permissions and try Connect again.',
        false
      ));
    }

    const db = await getDatabase();
    await upsertGmailMailbox(db, {
      user: payload.user,
      label: payload.label,
      refreshToken: tokens.refresh_token,
    });

    return res.send(htmlPage(
      'Email connected',
      `${payload.user} is now linked. Bank statements will import automatically. Close this tab and return to LJC Accounting.`,
      true
    ));
  } catch (err) {
    console.error('Gmail OAuth callback error:', err);
    return res.status(500).send(htmlPage('Connection failed', err.message, false));
  }
}

router.post('/disconnect', async (req, res) => {
  try {
    const { user } = req.body;
    if (!user) return res.status(400).json({ error: 'user required' });
    const db = await getDatabase();
    await disconnectMailbox(db, user);
    return res.json({ ok: true, user });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

function htmlPage(title, message, success) {
  const color = success ? '#2f6b3a' : '#b3261e';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:Arial,sans-serif;max-width:520px;margin:60px auto;padding:24px;text-align:center}
h1{color:${color}}p{color:#333;line-height:1.5}</style></head>
<body><h1>${title}</h1><p>${message}</p></body></html>`;
}

export default router;
