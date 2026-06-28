import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/**
 * Fetch recent unread emails with attachments from an IMAP mailbox.
 */
export async function fetchImapMessages({
  user,
  password,
  host,
  port = 993,
  folder = 'INBOX',
  sinceDays = 45,
}) {
  const messages = [];
  const client = new ImapFlow({
    host,
    port,
    secure: port === 993,
    auth: { user, pass: password },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const since = new Date(Date.now() - sinceDays * 86400000);
      const uids = await client.search({ since });
      if (!uids || !uids.length) return messages;

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

        if (!attachments.length) continue;

        messages.push({
          messageId: parsed.messageId || `imap:${user}:${msg.uid}`,
          imapUid: msg.uid,
          subject: parsed.subject || msg.envelope?.subject || '',
          from: parsed.from?.text || msg.envelope?.from?.[0]?.address || '',
          receivedAt: (parsed.date || new Date()).toISOString(),
          attachments,
          mailbox: user,
          transport: 'imap',
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return messages;
}
