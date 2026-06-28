import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../config/database.js';
import { categorizeTransaction } from './categorization-rules.js';
import { detectAndQueueChargeback } from './chargeback.js';

async function ensureUndepositedFunds(db, entityId) {
  let row = await db.get(
    'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, '1100']
  );
  if (row) return row.id;
  const id = `acc-${uuidv4()}`;
  await db.run(
    `INSERT INTO accounts (id, entity_id, account_number, account_name, account_type, normal_balance, is_active)
     VALUES (?, ?, '1100', 'Undeposited Funds', 'ASSET', 'DEBIT', 1)`,
    [id, entityId]
  );
  return id;
}

/**
 * Commit bank transactions as DRAFT journal entries with journal_entry_lines ONLY.
 * Nothing hits general_ledger until the user posts from Bank Feeds (QBO-style).
 * Auto-categorization rules assign the offset account; chargebacks are flagged.
 */
export async function commitBankImportTransactions(db, {
  entityId,
  transactions,
  importId,
  userId,
  sourceLabel = 'Bank Import',
  bankAccountNumber = '1000',
}) {
  const entity = await db.get('SELECT * FROM entities WHERE id = ?', entityId);
  if (!entity) throw new Error('Entity not found');

  const bankAccount = await db.get(
    'SELECT * FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, bankAccountNumber]
  );
  if (!bankAccount) {
    throw new Error(`Bank account (${bankAccountNumber}) not found for entity`);
  }

  const defaultOffsetId = await ensureUndepositedFunds(db, entityId);
  let createdJECount = 0;
  const importedTransactions = [];

  for (const txn of transactions) {
    const cat = await categorizeTransaction(db, entityId, txn.description);

    if (cat.isChargeback) {
      await detectAndQueueChargeback(db, {
        entityId,
        fitid: txn.fitid,
        amount: txn.amount,
        description: txn.description,
        date: txn.date,
        userId,
      });
    }

    const offsetAccountId = cat.offsetAccountId || defaultOffsetId;
    const jeId = `je-${uuidv4()}`;
    const jeNumber = `IMP-${Date.now()}-${uuidv4().substring(0, 8)}`;
    const isDeposit = txn.isCredit;
    const amount = Math.abs(Number(txn.amount));
    const debitAmount = isDeposit ? amount : 0;
    const creditAmount = !isDeposit ? amount : 0;

    await db.run(
      `INSERT INTO journal_entries (
        id, entity_id, je_number, description, posting_date, status,
        created_by, total_debit, total_credit, memo
      ) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
      [
        jeId,
        entityId,
        jeNumber,
        `${sourceLabel}: ${txn.description}`,
        txn.date,
        userId,
        amount,
        amount,
        `${sourceLabel} - FITID: ${txn.fitid}${cat.label ? ` | rule: ${cat.label}` : ''}`,
      ]
    );

    // Line 1: bank account
    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [`jel-${uuidv4()}`, jeId, bankAccount.id, debitAmount, creditAmount, `Bank: ${txn.description}`]
    );

    // Line 2: offset (categorized or undeposited funds)
    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, ?, ?, 2)`,
      [`jel-${uuidv4()}`, jeId, offsetAccountId, creditAmount, debitAmount, cat.label || 'Pending categorization']
    );

    const importTxnId = `imp-txn-${uuidv4()}`;
    await db.run(
      `INSERT INTO import_transactions (
        id, fitid, import_id, entity_id, account_id, journal_entry_id,
        date, amount, description, status, offset_account_id, suggested_rule_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)`,
      [
        importTxnId,
        txn.fitid,
        importId,
        entityId,
        bankAccount.id,
        jeId,
        txn.date,
        txn.amount,
        txn.description,
        offsetAccountId,
        cat.ruleId || null,
        new Date().toISOString(),
      ]
    );

    importedTransactions.push({ fitid: txn.fitid, jeNumber, jeId, status: 'DRAFT', rule: cat.label });
    createdJECount += 1;
  }

  return { createdJECount, importedTransactions };
}

export async function getExistingFitidsForEntity(entityId) {
  const db = await getDatabase();
  const rows = await db.all(
    'SELECT DISTINCT fitid FROM import_transactions WHERE entity_id = ? AND status != ?',
    [entityId, 'REJECTED']
  );
  return new Set(rows.map((r) => r.fitid));
}

/** Update offset account on a pending import (user changed category in Bank Feeds). */
export async function updateImportOffsetAccount(db, { entityId, fitid, offsetAccountId }) {
  const row = await db.get(
    `SELECT it.*, je.status AS je_status FROM import_transactions it
     JOIN journal_entries je ON je.id = it.journal_entry_id
     WHERE it.fitid = ? AND it.entity_id = ?`,
    [fitid, entityId]
  );
  if (!row) throw new Error('Import transaction not found');
  if (row.je_status === 'POSTED') throw new Error('Cannot recategorize a posted transaction');

  await db.run(
    'UPDATE import_transactions SET offset_account_id = ?, updated_at = CURRENT_TIMESTAMP WHERE fitid = ? AND entity_id = ?',
    [offsetAccountId, fitid, entityId]
  );

  const lines = await db.all(
    'SELECT jel.*, a.account_number FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id WHERE jel.journal_entry_id = ? ORDER BY jel.line_number',
    [row.journal_entry_id]
  );
  const bankLine = lines.find((l) => l.account_number === '1000' || l.account_number === '1001');
  const offsetLine = lines.find((l) => l.id !== bankLine?.id);
  if (offsetLine) {
    await db.run('UPDATE journal_entry_lines SET account_id = ? WHERE id = ?', [offsetAccountId, offsetLine.id]);
  }
  return { fitid, offsetAccountId };
}
