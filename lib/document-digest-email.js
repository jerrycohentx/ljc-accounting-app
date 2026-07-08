/**
 * Daily document review digest — count + categories + link to /feed-review.
 */

import { sendAppEmail } from './outbound-mail.js';

function dollars(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

export async function sendDocumentDigestEmail({
  db,
  to,
  appUrl,
  newDrafts = [],
  pendingDocumentCount = 0,
  runSummary = {},
}) {
  const reviewUrl = `${String(appUrl || '').replace(/\/$/, '')}/feed-review`;
  const count = newDrafts.length;
  const subject = `LJC Accounting — ${count} emailed document${count === 1 ? '' : 's'} ready for review`;

  const lines = newDrafts.map((d) => {
    const amt = dollars(d.totalCents);
    const cat = d.categoryLabel || 'Uncategorized';
    return `• ${d.vendor || 'Unknown'} — $${amt} → ${cat}`;
  });

  const text = [
    'New emailed documents were parsed and added to Activity Review as DRAFT entries.',
    'Nothing has been posted to the ledger — approve each item in the app when ready.',
    '',
    `New in this run: ${count}`,
    `Total emailed-document drafts pending: ${pendingDocumentCount}`,
    '',
    ...lines,
    '',
    `Review & approve: ${reviewUrl}`,
    '',
    `Run: ${runSummary.reason || 'scheduled'} at ${runSummary.finishedAt || new Date().toISOString()}`,
  ].join('\n');

  const listHtml = lines.map((l) => `<li>${l.replace(/^•\s*/, '')}</li>`).join('');
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;line-height:1.5;color:#222">
      <h2 style="color:#1565c0;margin:0 0 12px">Document review digest</h2>
      <p>Emailed receipts, invoices, and breakdowns were parsed and added to <strong>Activity Review</strong> as <strong>DRAFT</strong> entries. Nothing posts until you approve.</p>
      <p><strong>${count}</strong> new in this run · <strong>${pendingDocumentCount}</strong> emailed-document draft(s) pending total</p>
      <ul style="padding-left:20px">${listHtml}</ul>
      <p style="margin:24px 0">
        <a href="${reviewUrl}" style="background:#1565c0;color:#fff;padding:10px 18px;text-decoration:none;border-radius:4px;font-weight:bold">
          Open Activity Review
        </a>
      </p>
      <p style="color:#666;font-size:12px">LJC Accounting · automated document pipeline</p>
    </div>`;

  return sendAppEmail({ db, to, subject, text, html });
}
