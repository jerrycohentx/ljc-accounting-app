/**
 * Ensure nested P&L category trees (Legal & Professional, etc.) and vendor rules.
 * Summary view rolls up to group accounts; Detail shows firm / vendor leaves.
 */
import { v4 as uuidv4 } from 'uuid';
import { PNL_DETAIL_CATEGORIES } from '../config/pnl-detail-categories.js';

async function upsertAccount(db, entityId, { number, name, type = 'EXPENSE', parentId = null }) {
  const normalBalance = ['ASSET', 'EXPENSE'].includes(type) ? 'DEBIT' : 'CREDIT';
  let row = await db.get(
    `SELECT id, account_number, account_name, parent_account_id, account_type
     FROM accounts WHERE entity_id = ? AND account_number = ? LIMIT 1`,
    [entityId, number]
  );
  if (!row) {
    const id = `acc-${uuidv4()}`;
    await db.run(
      `INSERT INTO accounts
       (id, entity_id, account_number, account_name, account_type, normal_balance, parent_account_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
      [id, entityId, number, name, type, normalBalance, parentId]
    );
    return { id, account_number: number, account_name: name, created: true };
  }

  const needsName = row.account_name !== name;
  const needsParent = parentId && row.parent_account_id !== parentId;
  const needsType = row.account_type !== type;
  if (needsName || needsParent || needsType) {
    await db.run(
      `UPDATE accounts
       SET account_name = ?,
           account_type = ?,
           normal_balance = ?,
           parent_account_id = COALESCE(?, parent_account_id)
       WHERE id = ?`,
      [name, type, normalBalance, parentId, row.id]
    );
  }
  return { id: row.id, account_number: number, account_name: name, created: false };
}

async function upsertBankRule(db, entityId, { pattern, offset, priority = 10, label }) {
  const matchType = 'contains';
  const existing = await db.get(
    `SELECT id FROM bank_categorization_rules
     WHERE entity_id = ? AND pattern = ? AND COALESCE(match_type, 'contains') = ?`,
    [entityId, pattern, matchType]
  );
  if (existing) {
    await db.run(
      `UPDATE bank_categorization_rules
       SET offset_account_number = ?, transfer_account_number = NULL, is_transfer = false,
           is_chargeback = false, priority = ?, label = ?, is_active = TRUE
       WHERE id = ?`,
      [offset, priority, label, existing.id]
    );
    return existing.id;
  }
  const id = `rule-${uuidv4()}`;
  await db.run(
    `INSERT INTO bank_categorization_rules
     (id, entity_id, pattern, match_type, offset_account_number, transfer_account_number,
      is_transfer, is_chargeback, priority, label, is_active)
     VALUES (?, ?, ?, ?, ?, NULL, false, false, ?, ?, TRUE)`,
    [id, entityId, pattern, matchType, offset, priority, label]
  );
  return id;
}

function collectPatternSpecs(node, accountNumber, labelPrefix) {
  const out = [];
  for (const p of node.patterns || []) {
    out.push({
      pattern: p.pattern,
      priority: p.priority ?? 10,
      offset: accountNumber,
      label: p.label || `${labelPrefix}${node.name}`,
    });
  }
  return out;
}

/**
 * Create/link nested category accounts and seed vendor rules for one entity.
 */
export async function ensurePnlDetailCategories(db, entityId = 'ent-ljc') {
  let accountsCreated = 0;
  let rulesSeeded = 0;

  for (const cat of PNL_DETAIL_CATEGORIES) {
    if (cat.entityId && cat.entityId !== entityId) continue;

    const parent = await upsertAccount(db, entityId, {
      number: cat.parent.number,
      name: cat.parent.name,
      type: cat.parent.type || 'EXPENSE',
      parentId: null,
    });
    if (parent.created) accountsCreated += 1;

    for (const group of cat.groups || []) {
      const groupRow = await upsertAccount(db, entityId, {
        number: group.number,
        name: group.name,
        type: group.type || 'EXPENSE',
        parentId: parent.id,
      });
      if (groupRow.created) accountsCreated += 1;

      for (const spec of collectPatternSpecs(group, group.number, '')) {
        await upsertBankRule(db, entityId, spec);
        rulesSeeded += 1;
      }

      for (const child of group.children || []) {
        const childRow = await upsertAccount(db, entityId, {
          number: child.number,
          name: child.name,
          type: child.type || 'EXPENSE',
          parentId: groupRow.id,
        });
        if (childRow.created) accountsCreated += 1;

        for (const spec of collectPatternSpecs(child, child.number, `${group.name} — `)) {
          await upsertBankRule(db, entityId, spec);
          rulesSeeded += 1;
        }
      }
    }
  }

  return { accountsCreated, rulesSeeded };
}
