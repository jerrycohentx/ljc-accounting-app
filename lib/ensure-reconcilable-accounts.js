import { v4 as uuidv4 } from 'uuid';
import { BANK_ACCOUNTS } from '../config/bank-import-targets.js';
import { FULL_CHART_OF_ACCOUNTS } from '../config/coa-full.js';

/**
 * Ensure every configured bank/card account for reconciliation exists in the
 * chart of accounts and is active. Production Postgres may have been seeded
 * before Lone Star / Amex were added, or accounts were deactivated by mistake.
 */
export async function ensureReconcilableBankAccounts(db, entityId = 'ent-ljc') {
  const specs = BANK_ACCOUNTS[entityId] || [];
  const results = [];

  for (const spec of specs) {
    const coa = FULL_CHART_OF_ACCOUNTS.find(
      (a) => a.entity === entityId && a.number === spec.accountNumber
    );
    if (!coa) {
      results.push({ accountNumber: spec.accountNumber, action: 'missing-coa' });
      continue;
    }

    const normalBalance = ['ASSET', 'EXPENSE'].includes(coa.type) ? 'DEBIT' : 'CREDIT';
    let parentId = null;
    if (coa.parent) {
      const parent = await db.get(
        'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
        [entityId, coa.parent]
      );
      parentId = parent?.id || null;
    }

    const row = await db.get(
      'SELECT id, is_active FROM accounts WHERE entity_id = ? AND account_number = ?',
      [entityId, spec.accountNumber]
    );

    if (!row) {
      const id = `acc-${uuidv4()}`;
      await db.run(
        `INSERT INTO accounts
           (id, entity_id, account_number, account_name, account_type, normal_balance, parent_account_id, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [id, entityId, coa.number, coa.name, coa.type, normalBalance, parentId]
      );
      results.push({ accountNumber: spec.accountNumber, action: 'created', id });
      continue;
    }

    await db.run(
      `UPDATE accounts
       SET account_name = ?, account_type = ?, normal_balance = ?,
           parent_account_id = COALESCE(?, parent_account_id),
           is_active = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [coa.name, coa.type, normalBalance, parentId, row.id]
    );
    results.push({
      accountNumber: spec.accountNumber,
      action: row.is_active ? 'ok' : 'reactivated',
      id: row.id,
    });
  }

  return results;
}

/** Active bank/card accounts configured for statement reconciliation. */
export async function listReconcilableAccounts(db, entityId) {
  await ensureReconcilableBankAccounts(db, entityId);
  const specs = BANK_ACCOUNTS[entityId] || [];
  const numbers = specs.map((s) => s.accountNumber);
  if (!numbers.length) return [];

  const placeholders = numbers.map(() => '?').join(',');
  return db.all(
    `SELECT id, account_number, account_name, account_type, parent_account_id, is_active, normal_balance
     FROM accounts
     WHERE entity_id = ? AND is_active = 1 AND account_number IN (${placeholders})
     ORDER BY account_number`,
    [entityId, ...numbers]
  );
}
