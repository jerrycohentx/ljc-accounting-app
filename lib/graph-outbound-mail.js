/**
 * Send mail via Microsoft Graph (application permissions — Mail.Send).
 * Used for password reset to jerry@ljcfinancial.com when GRAPH_* env is set.
 */

import { isGraphConfigured } from './statement-email-config.js';

let graphTokenCache = null;

async function getGraphToken() {
  if (graphTokenCache && graphTokenCache.expiresAt > Date.now() + 60_000) {
    return graphTokenCache.token;
  }
  const tenant = process.env.GRAPH_TENANT_ID;
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GRAPH_CLIENT_ID,
      client_secret: process.env.GRAPH_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(data.error_description || data.error || 'Graph token request failed');
  }
  graphTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) * 1000),
  };
  return data.access_token;
}

export function isGraphMailConfigured() {
  return isGraphConfigured();
}

export async function sendGraphMail({ to, subject, text, html }) {
  if (!isGraphMailConfigured()) {
    throw new Error('Microsoft Graph mail not configured');
  }
  const from = process.env.GRAPH_MAILBOX_USER;
  const token = await getGraphToken();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'HTML', content: html || text?.replace(/\n/g, '<br>') || '' },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: false,
      }),
    }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error?.message || `Graph sendMail failed (${res.status})`);
  }
  return { from, to, transport: 'graph' };
}
