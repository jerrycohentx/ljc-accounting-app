#!/usr/bin/env node
import { detectBankTarget } from '../lib/statement-email-ingest.js';
import { getAllMailboxes, getEmailIngestSettings } from '../lib/statement-email-config.js';
import { mergeStatementJson } from '../lib/statement-json-merge.js';
import {
  isLonestarEStatementNotification,
  parseLonestarNotificationMeta,
  extractCandidateUrls,
  pickStatementDownloadUrl,
} from '../lib/lonestar-estatement-notify.js';
import { periodAlreadyImported } from '../lib/lonestar-estatement-fetch.js';
import { buildEmailIngestMessage } from '../lib/email-ingest-message.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const loneStar = detectBankTarget({
  subject: 'Your Lone Star Bank statement is ready',
  from: 'alerts@lonestarbank.com',
  fileName: 'LJCckg7367_statement.pdf',
});
assert(loneStar?.accountNumber === '1001', 'Lone Star detection');

const loneStarNotify = isLonestarEStatementNotification({
  subject: 'eStatement for account ending in 7367 is ready to view',
  from: 'info@lsbtexas.com',
  attachments: [],
});
assert(loneStarNotify, 'Lone Star eStatement notification detection');

const withPdf = isLonestarEStatementNotification({
  subject: 'eStatement ready',
  from: 'info@lsbtexas.com',
  attachments: [{ filename: 'statement.pdf' }],
});
assert(!withPdf, 'Lone Star notification skips when PDF attached');

const notifyMeta = parseLonestarNotificationMeta({
  subject: 'Your January 2026 eStatement for account ending in 7367 is ready',
});
assert(notifyMeta.accountLast4 === '7367', 'notification account last4');
assert(notifyMeta.periodEnd === '2026-01-31', 'notification period end');

const urls = extractCandidateUrls({
  html: '<a href="https://my.lsbtexas.com/documents/statement.pdf">View</a>',
});
assert(pickStatementDownloadUrl(urls)?.includes('statement.pdf'), 'pick statement URL');

assert(periodAlreadyImported('1001', '2026-01-31'), 'Jan 2026 Lone Star already in JSON');

const msg = buildEmailIngestMessage({
  messagesFetched: 0,
  gmailOAuthConfigured: false,
  mailboxStats: [{ user: 'jerrycohentx@gmail.com', transport: 'gmail-oauth', fetched: 0 }],
  errors: [{ mailbox: 'jerrycohentx@gmail.com', error: 'Gmail OAuth not configured on server' }],
  lonestarPortalConfigured: true,
  results: [],
});
assert(msg.includes('GMAIL_OAUTH'), 'ingest message hints Gmail OAuth');

const simmons = detectBankTarget({
  subject: 'Simmons Bank statement',
  from: 'noreply@simmonsbank.com',
  fileName: '0260-Jan2026.pdf',
});
assert(simmons?.accountNumber === '1000', 'Simmons detection');

const settings = getEmailIngestSettings();
assert(settings.sinceDays >= 1, 'settings parse');

const tmpJson = path.join(ROOT, 'data/bank-imports/LJC/lonestar-2026-statements.json.bak-test');
const orig = path.join(ROOT, 'data/bank-imports/LJC/lonestar-2026-statements.json');
if (fs.existsSync(orig)) fs.copyFileSync(orig, tmpJson);

try {
  const merged = mergeStatementJson('1001', {
    file: 'test.pdf',
    meta: { periodStart: '2026-02-01', periodEnd: '2026-02-28', currentBalance: 100, previousBalance: 726.07 },
    transactions: [{ date: '2026-02-01', amount: 10, description: 'test', fitid: 'test-fitid' }],
    transactionCount: 1,
  });
  assert(merged.periodEnd === '2026-02-28', 'merge json');
} finally {
  if (fs.existsSync(tmpJson)) {
    fs.copyFileSync(tmpJson, orig);
    fs.unlinkSync(tmpJson);
  }
}

console.log('✓ statement email ingest unit tests passed');
console.log('  Mailboxes configured:', getAllMailboxes().length, '(0 expected in CI without env)');
