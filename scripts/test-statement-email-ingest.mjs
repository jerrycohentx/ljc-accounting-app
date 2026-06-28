#!/usr/bin/env node
import { detectBankTarget } from '../lib/statement-email-ingest.js';
import { getAllMailboxes, getEmailIngestSettings } from '../lib/statement-email-config.js';
import { mergeStatementJson } from '../lib/statement-json-merge.js';
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
