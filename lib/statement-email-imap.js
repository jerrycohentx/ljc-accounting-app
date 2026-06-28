import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { isLonestarEStatementNotification } from './lonestar-estatement-notify.js';

const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 90_000;

function isStatementEmail(parsed) {
  const attachments = (parsed.attachments || []).filter((a) => a.content && a.filename);
  if (attachments.some((a) => /\.(pdf|ofx|qfx)$/i.test(a.filename))) return true;
  return isLonestarEStatementNotification({
    subject: parsed.subject || '',
    from: parsed.from?.text || '',
    text: parsed.text || '',
    html: parsed.html || '',
    attachments: [],
  });
}

function attachImapErrorTrap(client) {
  let rejectError = null;
  let settled = false;

  const errorPromise = new Promise((_, reject) => {
    rejectError = reject;
  });

  const onError = (err) => {
    if (settled) return;
    settled = true;
    rejectError?.(err);
  };

  client.on('error', onError);

  return {
    errorPromise,
    detach() {
      settled = true;
      rejectError = null;
      client.removeListener('error', onError);
    },
  };
}

async function closeImapClient(client) {
  try {
    if (client.authenticated) {
      await client.logout();
    }
  } catch {
    /* ignore logout errors after timeout/disconnect */
  }
  try {
    client.close();
  } catch {
    /* ignore */
  }
}

/**
 * Fetch recent emails with statement attachments or Lone Star eStatement notices.
 * IMAP socket/connection errors are caught and rethrown — never emitted as unhandled.
 */
export async function fetchImapMessages({
  user,
  password,
  host,
  port = 993,
  folder = 'INBOX',
  sinceDays = 45,
  connectionTimeout = DEFAULT_CONNECTION_TIMEOUT_MS,
  socketTimeout = DEFAULT_SOCKET_TIMEOUT_MS,
}) {
  const messages = [];
  const client = new ImapFlow({
    host,
    port,
    secure: port === 993,
    auth: { user, pass: password },
    logger: false,
    connectionTimeout,
    socketTimeout,
  });

  const trap = attachImapErrorTrap(client);

  const fetchWork = async () => {
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      const since = new Date(Date.now() - sinceDays * 86400000);
      const uids = await client.search({ since });
      if (!uids || !uids.length) return;

      for await (const msg of client.fetch(uids, { envelope: true, source: true, uid: true })) {
        const parsed = await simpleParser(msg.source);
        const attachments = (parsed.attachments || [])
          .filter((a) => a.content && a.filename)
          .map((a) => ({
            filename: a.filename,
            mimeType: a.contentType,
            content: Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content),
            size: a.size,
          }));

        if (!isStatementEmail(parsed)) continue;

        messages.push({
          messageId: parsed.messageId || `imap:${user}:${msg.uid}`,
          imapUid: msg.uid,
          subject: parsed.subject || msg.envelope?.subject || '',
          from: parsed.from?.text || msg.envelope?.from?.[0]?.address || '',
          receivedAt: (parsed.date || new Date()).toISOString(),
          text: parsed.text || '',
          html: parsed.html || '',
          attachments,
          mailbox: user,
          transport: 'imap',
        });
      }
    } finally {
      lock.release();
    }
  };

  try {
    await Promise.race([fetchWork(), trap.errorPromise]);
  } finally {
    trap.detach();
    await closeImapClient(client);
  }

  return messages;
}
