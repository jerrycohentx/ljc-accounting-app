/** Microsoft Graph mail fetch for M365 mailboxes (e.g. jerry@ljcfinancial.com). */

import { isLonestarEStatementNotification } from './lonestar-estatement-notify.js';

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
    throw new Error(data.error_description || 'Graph token request failed');
  }
  graphTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) * 1000),
  };
  return data.access_token;
}

async function graphFetch(path) {
  const token = await getGraphToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Graph API ${res.status}`);
  }
  return data;
}

/**
 * @returns {AsyncGenerator<{ messageId, subject, from, receivedAt, attachments, mailbox }>}
 */
export async function* fetchGraphMessages({ user, sinceDays }) {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const filter = encodeURIComponent(`receivedDateTime ge ${since}`);
  const list = await graphFetch(
    `/users/${encodeURIComponent(user)}/messages?$filter=${filter}&$top=60&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,hasAttachments,bodyPreview`
  );

  for (const msg of list.value || []) {
    const full = await graphFetch(
      `/users/${encodeURIComponent(user)}/messages/${msg.id}?$select=id,subject,from,receivedDateTime,hasAttachments,body,bodyPreview`
    );

    const attachments = [];
    if (full.hasAttachments) {
      const attList = await graphFetch(
        `/users/${encodeURIComponent(user)}/messages/${msg.id}/attachments`
      );
      for (const att of attList.value || []) {
        if (att['@odata.type'] !== '#microsoft.graph.fileAttachment') continue;
        if (!att.contentBytes) continue;
        attachments.push({
          filename: att.name,
          mimeType: att.contentType,
          content: Buffer.from(att.contentBytes, 'base64'),
          size: att.size,
        });
      }
    }

    const bodyText = full.body?.contentType === 'html'
      ? full.body.content
      : (full.bodyPreview || '');
    const bodyHtml = full.body?.contentType === 'html' ? full.body.content : '';

    const email = {
      messageId: `graph:${user}:${msg.id}`,
      graphId: msg.id,
      subject: full.subject || msg.subject || '',
      from: full.from?.emailAddress?.address || msg.from?.emailAddress?.address || '',
      receivedAt: full.receivedDateTime || msg.receivedDateTime,
      text: full.body?.contentType === 'text' ? full.body.content : (full.bodyPreview || ''),
      html: bodyHtml,
      attachments,
      mailbox: user,
      transport: 'graph',
    };

    const hasStatementFile = attachments.some((a) => /\.(pdf|ofx|qfx)$/i.test(a.filename || ''));
    if (!hasStatementFile && !isLonestarEStatementNotification(email)) continue;

    yield email;
  }
}
