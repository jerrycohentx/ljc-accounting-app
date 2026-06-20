import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../config/database.js';

/**
 * Commit bank transactions as draft journal entries + import_transactions rows.
 * Shared by OFX import and Plaid sync.
 */
export async function commitBankImportTransactions(db, {
  entityId,
  transactions,
  importId,
  userId,
  sourceLabel = 'Bank Import',
}) {
  const entity = await db.get('SELECT * FROM entities WHERE id = ?', entityId);
  if (!entity) {
    throw new Error('Entity not found');
  }

  const bankAccount = await db.get(
    'SELECT * FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, '1000']
  );
  if (!bankAccount) {
    throw new Error('Bank account (1000) not found for entity');
  }

  let undepositedAccount = await db.get(
    'SELECT * FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, '1100']
  );
  if (!undepositedAccount) {
    const accId = `acc-${uuidv4()}`;
    await db.run(
      `INSERT INTO accounts (
        id, entity_id, account_number, account_name, account_type, normal_balance, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [accId, entityId, '1100', 'Undeposited Funds', 'ASSET', 'DEBIT']
    );
    undepositedAccount = { id: accId };
  }

  let createdJECount = 0;
  const importedTransactions = [];

  for (const txn of transactions) {
    const jeId = `je-${uuidv4()}`;
    const jeNumber = `IMP-${Date.now()}-${uuidv4().substring(0, 8)}`;
    const glId1 = `gl-${uuidv4()}`;
    const glId2 = `gl-${uuidv4()}`;

    const isDeposit = txn.isCredit;
    const amount = Math.abs(txn.amount);
    const debitAmount = isDeposit ? amount : 0;
    const creditAmount = !isDeposit ? amount : 0;

    await db.run(
      `INSERT INTO journal_entries (
        id, entity_id, je_number, description, posting_date, status,
        created_by, total_debit, total_credit, memo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jeId,
        entityId,
        jeNumber,
        `${sourceLabel}: ${txn.description}`,
        txn.date,
        'DRAFT',
        userId,
        debitAmount,
        creditAmount,
        `${sourceLabel} - FITID: ${txn.fitid}`,
      ]
    );

    await db.run(
      `INSERT INTO general_ledger (
        id, entity_id, account_id, journal_entry_id, debit, credit,
        posting_date, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        glId1,
        entityId,
        bankAccount.id,
        jeId,
        debitAmount,
        creditAmount,
        txn.date,
        `Bank: ${txn.description}`,
      ]
    );

    await db.run(
      `INSERT INTO general_ledger (
        id, entity_id, account_id, journal_entry_id, debit, credit,
        posting_date, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        glId2,
        entityId,
        undepositedAccount.id,
        jeId,
        creditAmount,
        debitAmount,
        txn.date,
        `Pending: ${txn.description}`,
      ]
    );

    const importTxnId = `imp-txn-${uuidv4()}`;
    await db.run(
      `INSERT INTO import_transactions (
        id, fitid, import_id, entity_id, account_id, journal_entry_id,
        date, amount, description, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        'DRAFT',
        new Date().toISOString(),
      ]
    );

    importedTransactions.push({ fitid: txn.fitid, jeNumber, status: 'DRAFT' });
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
