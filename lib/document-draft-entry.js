/**
 * Turn a parsed emailed document into:
 *  - a receipts row (audit + file retention)
 *  - a DRAFT journal entry (never auto-posts)
 *  - an import_transactions row (shows in /feed-review)
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { ingestDocument } from './receipt-ingest.js';
import { categorizeTransaction } from './categorization-rules.js';

function dollars(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function buildFitid(externalRef) {
  const hash = crypto.createHash('sha256').update(externalRef).digest('hex').slice(0, 24);
  return `email-doc:${hash}`;
}

async function getOrCreateAccount(db, entityId, { number, name, type, normal }) {
  let account = await db.get(
    'SELECT * FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, number]
  );
  if (!account) {
    const accId = `acc-${uuidv4()}`;
    await db.run(
      `INSERT INTO accounts (id, entity_id, account_number, account_name, account_type, normal_balance, is_active)
       VALUES (?, ?, ?, ?, ?, ?, true)`,
      [accId, entityId, number, name, type, normal]
    );
    account = await db.get('SELECT * FROM accounts WHERE id = ?', accId);
  }
  return account;
}

async function resolveExpenseAccount(db, entityId, categorizationText) {
  const cat = await categorizeTransaction(db, entityId, categorizationText);
  if (cat.offsetAccountId && !cat.isTransfer && !cat.isChargeback) {
    const account = await db.get('SELECT * FROM accounts WHERE id = ?', cat.offsetAccountId);
    return { account, cat };
  }
  const fallback = await getOrCreateAccount(db, entityId, {
    number: '5700',
    name: 'Office & Miscellaneous',
    type: 'EXPENSE',
    normal: 'DEBIT',
  });
  return { account: fallback, cat: { label: 'Uncategorized expense', ruleId: null } };
}

/**
 * @returns {{ status: 'created'|'duplicate', receipt, jeId, fitid, categoryLabel }}
 */
export async function createDocumentDraftEntry(db, {
  entityId,
  userId,
  externalRef,
  fileName = null,
  fileMime = null,
  fileData = null,
  rawText,
  vendorHint = '',
  subject = '',
  messageId,
}) {
  const fitid = buildFitid(externalRef);

  const existingImport = await db.get(
    "SELECT id FROM import_transactions WHERE fitid = ? AND entity_id = ? AND status != 'REJECTED'",
    [fitid, entityId]
  );
  if (existingImport) {
    const receipt = await db.get(
      'SELECT * FROM receipts WHERE external_ref = ? AND entity_id = ?',
      [externalRef, entityId]
    );
    return { status: 'duplicate', receipt, fitid };
  }

  const ingestResult = await ingestDocument(db, {
    entityId,
    userId,
    source: 'EMAIL',
    externalRef,
    fileName,
    fileMime,
    rawText,
    fileData,
  });

  if (ingestResult.status === 'duplicate') {
    return { status: 'duplicate', receipt: ingestResult.receipt, fitid };
  }

  const receipt = ingestResult.receipt;
  const totalCents = Number(receipt.total_cents || 0);
  if (totalCents <= 0) {
    throw new Error('Document total must be greater than zero');
  }

  const vendor = receipt.vendor || vendorHint || 'Unknown vendor';
  const categorizationText = `${vendor} ${subject} ${rawText}`.slice(0, 2000);
  const { account: expenseAccount, cat } = await resolveExpenseAccount(db, entityId, categorizationText);
  const apAccount = await getOrCreateAccount(db, entityId, {
    number: '2000',
    name: 'Accounts Payable',
    type: 'LIABILITY',
    normal: 'CREDIT',
  });

  const amount = dollars(totalCents);
  const postingDate = receipt.receipt_date || new Date().toISOString().slice(0, 10);
  const jeId = `je-${uuidv4()}`;
  const jeNumber = `DOC-${Date.now()}-${uuidv4().substring(0, 6)}`;
  const description = `Email doc: ${vendor}`;
  const categoryLabel = cat.label || receipt.category || 'Expense';

  await db.run(
    `INSERT INTO journal_entries (
      id, entity_id, je_number, description, posting_date, status,
      created_by, total_debit, total_credit, memo
    ) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [
      jeId,
      entityId,
      jeNumber,
      description,
      postingDate,
      userId,
      amount,
      amount,
      `Emailed document ${fileName || 'inline'} | ${messageId || externalRef}${cat.label ? ` | rule: ${cat.label}` : ''}`,
    ]
  );

  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [`jel-${uuidv4()}`, jeId, expenseAccount.id, amount, '0.00', `${categoryLabel} — ${vendor}`, 1]
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 2)`,
    [`jel-${uuidv4()}`, jeId, apAccount.id, '0.00', amount, `Payable — ${vendor}`, 2]
  );

  const importId = `doc-import-${uuidv4()}`;
  const importTxnId = `imp-txn-${uuidv4()}`;
  const signedAmount = -(totalCents / 100);

  await db.run(
    `INSERT INTO import_transactions (
      id, fitid, import_id, entity_id, account_id, journal_entry_id,
      date, amount, description, status, offset_account_id, suggested_rule_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)`,
    [
      importTxnId,
      fitid,
      importId,
      entityId,
      apAccount.id,
      jeId,
      postingDate,
      signedAmount,
      vendor,
      expenseAccount.id,
      cat.ruleId || null,
      new Date().toISOString(),
    ]
  );

  await db.run(
    `UPDATE receipts SET
      journal_entry_id = ?, category = ?, needs_review = ?, status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [jeId, categoryLabel, receipt.needs_review ? 1 : 0, 'PENDING_REVIEW', receipt.id]
  );

  const updatedReceipt = await db.get('SELECT * FROM receipts WHERE id = ?', receipt.id);

  return {
    status: 'created',
    receipt: updatedReceipt,
    jeId,
    jeNumber,
    fitid,
    categoryLabel,
    offsetAccountNumber: expenseAccount.account_number,
    totalCents,
    vendor,
  };
}
