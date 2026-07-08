#!/usr/bin/env node
/**
 * Smoke test for document email pipeline helpers (no live mailbox required).
 * Usage: node scripts/test-document-email-ingest.mjs
 */

import assert from 'node:assert/strict';
import {
  looksLikeBankStatementText,
  emailBodyLooksLikeDocument,
  extractEmailBodyText,
} from '../lib/extract-document-text.js';
import { parseReceipt } from '../lib/receipt-parser.js';
import { detectBankTarget, isDocumentAttachment } from '../lib/statement-email-ingest.js';

assert.equal(isDocumentAttachment('invoice.pdf'), true);
assert.equal(isDocumentAttachment('stmt.ofx'), false);

assert.equal(
  looksLikeBankStatementText('CHECKING ACCOUNTS\nCurrent Balance\nEnding Balance'),
  true
);

const body = [
  'Payment breakdown for LJC Financial',
  'Vendor: Calacta Construction',
  'Total due: $4,250.00',
].join('\n');
assert.equal(emailBodyLooksLikeDocument(body), true);

const parsed = parseReceipt(body);
assert.ok(parsed.totalCents > 0, 'parses total from body');
assert.ok(parsed.vendor, 'parses vendor');

const bankTarget = detectBankTarget({
  subject: 'Simmons Bank statement',
  from: 'alerts@simmonsbank.com',
  fileName: 'simmons-0260.pdf',
  text: 'CHECKING ACCOUNTS Current Balance',
});
assert.ok(bankTarget?.accountNumber === '1000', 'detects Simmons statement');

console.log('✓ document email ingest smoke tests passed');
