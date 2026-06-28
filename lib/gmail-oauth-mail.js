/** Gmail API mail fetch using OAuth refresh tokens (no googleapis package). */

let cachedTokens = new Map();

async function refreshAccessToken(refreshToken) {
  const cacheKey = refreshToken.slice(0, 12);
  const cached = cachedTokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_OAUTH_CLIENT_ID,
      client_secret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(data.error_description || data.error || 'Gmail OAuth token refresh failed');
  }
  cachedTokens.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) * 1000),
  });
  return data.access_token;
}

function decodeBase64Url(data) {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}

function walkParts(part, attachments = [], body = { text: '', html: '' }) {
  if (!part) return { attachments, body };
  if (part.filename && part.body?.attachmentId) {
    attachments.push({
      filename: part.filename,
      mimeType: part.mimeType,
      attachmentId: part.body.attachmentId,
      size: part.body.size,
    });
  } else if (part.filename && part.body?.data) {
    attachments.push({
      filename: part.filename,
      mimeType: part.mimeType,
      content: decodeBase64Url(part.body.data),
      size: part.body.size,
    });
  }
  if (part.mimeType === 'text/plain' && part.body?.data) {
    body.text += decodeBase64Url(part.body.data).toString('utf8');
  }
  if (part.mimeType === 'text/html' && part.body?.data) {
    body.html += decodeBase64Url(part.body.data).toString('utf8');
  }
  for (const p of part.parts || []) {
    walkParts(p, attachments, body);
  }
  return { attachments, body };
}

async function gmailFetch(token, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Gmail API ${res.status}`);
  }
  return data;
}

/**
 * @returns {AsyncGenerator<{ messageId, subject, from, receivedAt, attachments, mailbox }>}
 */
export async function* fetchGmailMessages({ user, refresh_token, sinceDays, searchQuery }) {
  const token = await refreshAccessToken(refresh_token);
  const q = `${searchQuery} newer_than:${sinceDays}d`;
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=40`;
  const list = await gmailFetch(token, listUrl);

  for (const item of list.messages || []) {
    const msg = await gmailFetch(
      token,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=full`
    );
    const headers = msg.payload?.headers || [];
    const subject = headers.find((h) => h.name === 'Subject')?.value || '';
    const from = headers.find((h) => h.name === 'From')?.value || '';
    const dateHdr = headers.find((h) => h.name === 'Date')?.value || '';
    const { attachments, body } = walkParts(msg.payload, [], { text: '', html: '' });

    const resolvedAttachments = [];
    for (const att of attachments) {
      if (att.content) {
        resolvedAttachments.push(att);
        continue;
      }
      const attData = await gmailFetch(
        token,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}/attachments/${att.attachmentId}`
      );
      resolvedAttachments.push({
        ...att,
        content: decodeBase64Url(attData.data),
      });
    }

    yield {
      messageId: `gmail:${user}:${msg.id}`,
      gmailId: msg.id,
      subject,
      from,
      receivedAt: dateHdr ? new Date(dateHdr).toISOString() : new Date().toISOString(),
      text: body.text,
      attachments: resolvedAttachments,
      mailbox: user,
      transport: 'gmail-oauth',
    };
  }
}
