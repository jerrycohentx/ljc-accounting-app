/**
 * CRE / rental property utility categorization — loads integration/cre-categorization-rules.json,
 * ensures per-property utility GL sub-accounts, and seeds bank_categorization_rules for ent-ljc.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.join(__dirname, '..', 'integration', 'cre-categorization-rules.json');

const UTILITY_LABELS = { gas: 'Gas', electric: 'Electric', water: 'Water', internet: 'Internet' };

/** Intermediate P&L parents under 6100 Rental Property Expenses (Summary view). */
export const RENTAL_UTILITY_TYPE_PARENTS = {
  water: { number: '6140', name: 'Water' },
  electric: { number: '6150', name: 'Electric' },
  gas: { number: '6160', name: 'Gas' },
};

export function loadCreCategorizationRules() {
  try {
    const raw = fs.readFileSync(RULES_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.warn('cre-categorization-rules.json missing or invalid:', error.message);
    return null;
  }
}

function propertyById(config, propertyId) {
  return (config?.properties || []).find((p) => p.id === propertyId) || null;
}

/** Ensure Water / Electric / Gas nest under Rental Property Expenses (6100). */
export async function ensureRentalUtilityTypeParents(db, entityId) {
  const rental = await db.get(
    `SELECT id FROM accounts WHERE entity_id = ? AND account_number = '6100' LIMIT 1`,
    [entityId]
  );
  const rentalId = rental?.id || null;
  if (!rentalId) return { created: 0, parents: {} };

  let created = 0;
  const parents = {};

  for (const [utility, spec] of Object.entries(RENTAL_UTILITY_TYPE_PARENTS)) {
    let row = await db.get(
      `SELECT id, account_number, account_name, parent_account_id FROM accounts
       WHERE entity_id = ? AND account_number = ? LIMIT 1`,
      [entityId, spec.number]
    );
    if (!row) {
      const id = `acc-${uuidv4()}`;
      await db.run(
        `INSERT INTO accounts
         (id, entity_id, account_number, account_name, account_type, normal_balance, parent_account_id, is_active)
         VALUES (?, ?, ?, ?, 'EXPENSE', 'DEBIT', ?, TRUE)`,
        [id, entityId, spec.number, spec.name, rentalId]
      );
      row = { id, account_number: spec.number, account_name: spec.name, parent_account_id: rentalId };
      created += 1;
    } else {
      const needsName = row.account_name !== spec.name;
      const needsParent = row.parent_account_id !== rentalId;
      if (needsName || needsParent) {
        await db.run(
          `UPDATE accounts
           SET account_name = ?, parent_account_id = ?, account_type = 'EXPENSE', normal_balance = 'DEBIT'
           WHERE id = ?`,
          [spec.name, rentalId, row.id]
        );
        row = { ...row, account_name: spec.name, parent_account_id: rentalId };
      }
    }
    parents[utility] = row;
  }

  return { created, parents };
}

export async function ensurePropertyUtilityAccounts(db, entityId, config = loadCreCategorizationRules()) {
  if (!config || config.entityId !== entityId) return { created: 0, accounts: {} };

  const { parents: typeParents } = await ensureRentalUtilityTypeParents(db, entityId);

  let created = 0;
  const accounts = {};

  const arParent = await db.get(
    `SELECT id FROM accounts WHERE entity_id = ? AND account_number = '1200' LIMIT 1`,
    [entityId]
  );

  for (const prop of config.properties || []) {
    accounts[prop.id] = {};
    const reimbursable = !!prop.tenantReimbursedUtilities;
    const accountType = reimbursable ? 'ASSET' : 'EXPENSE';
    for (const [utility, number] of Object.entries(prop.utilityAccounts || {})) {
      const label = UTILITY_LABELS[utility] || utility;
      const name = reimbursable
        ? `Due from Tenant — ${label} — ${prop.shortName || prop.name}`
        : `${label} — ${prop.shortName || prop.name}`;
      const typeParentId = reimbursable
        ? (arParent?.id || null)
        : (typeParents[utility]?.id || null);
      let row = await db.get(
        `SELECT id, account_number, account_name, account_type, parent_account_id FROM accounts
         WHERE entity_id = ? AND account_number = ? LIMIT 1`,
        [entityId, number]
      );
      if (!row) {
        const id = `acc-${uuidv4()}`;
        await db.run(
          `INSERT INTO accounts
           (id, entity_id, account_number, account_name, account_type, normal_balance, parent_account_id, is_active)
           VALUES (?, ?, ?, ?, ?, 'DEBIT', ?, TRUE)`,
          [id, entityId, number, name, accountType, typeParentId]
        );
        row = { id, account_number: number, account_name: name };
        created += 1;
      } else {
        const needsType = reimbursable && row.account_type !== 'ASSET';
        const needsName = row.account_name !== name;
        const needsParent = typeParentId && row.parent_account_id !== typeParentId;
        if (needsType || needsName || needsParent) {
          await db.run(
            `UPDATE accounts
             SET account_name = ?,
                 account_type = ?,
                 normal_balance = 'DEBIT',
                 parent_account_id = COALESCE(?, parent_account_id)
             WHERE id = ?`,
            [name, accountType, typeParentId, row.id]
          );
        }
      }
      accounts[prop.id][utility] = row;
    }
  }

  return { created, accounts };
}

async function upsertBankRule(db, entityId, spec) {
  const matchType = spec.matchType || 'contains';
  const existing = await db.get(
    `SELECT id FROM bank_categorization_rules
     WHERE entity_id = ? AND pattern = ? AND COALESCE(match_type, 'contains') = ?`,
    [entityId, spec.pattern, matchType]
  );

  if (existing) {
    await db.run(
      `UPDATE bank_categorization_rules
       SET offset_account_number = ?, transfer_account_number = NULL, is_transfer = false,
           is_chargeback = false, priority = ?, label = ?, is_active = TRUE
       WHERE id = ?`,
      [spec.offset, spec.priority, spec.label, existing.id]
    );
    return existing.id;
  }

  const id = `rule-${uuidv4()}`;
  await db.run(
    `INSERT INTO bank_categorization_rules
     (id, entity_id, pattern, match_type, offset_account_number, transfer_account_number,
      is_transfer, is_chargeback, priority, label, is_active)
     VALUES (?, ?, ?, ?, ?, NULL, false, false, ?, ?, TRUE)`,
    [id, entityId, spec.pattern, matchType, spec.offset, spec.priority, spec.label]
  );
  return id;
}

export async function seedCreCategorizationRules(db, entityId = 'ent-ljc') {
  const config = loadCreCategorizationRules();
  if (!config || config.entityId !== entityId) return { seeded: 0, accountsCreated: 0 };

  const { created: accountsCreated } = await ensurePropertyUtilityAccounts(db, entityId, config);
  let seeded = 0;

  for (const vp of config.vendorPatterns || []) {
    const prop = vp.propertyId ? propertyById(config, vp.propertyId) : null;
    const utility = vp.utility;
    const offset = prop?.utilityAccounts?.[utility];
    if (!offset) continue;

    for (const pattern of vp.patterns || []) {
      await upsertBankRule(db, entityId, {
        pattern,
        offset,
        priority: vp.priority ?? 110,
        label: vp.label || `${utility} — ${prop?.shortName || prop?.name || 'property'}`,
        matchType: 'contains',
      });
      seeded += 1;
    }
  }

  for (const group of [
    config.holdbackWirePatterns || [],
    config.ownerDrawPatterns || [],
    config.wireFeePatterns || [],
  ]) {
    for (const spec of group) {
      await upsertBankRule(db, entityId, spec);
      seeded += 1;
    }
  }

  return { seeded, accountsCreated };
}

/**
 * Match a bank description against CRE vendor patterns for UI property hints.
 * @returns {{ propertyName, utilityType, label } | null}
 */
export function matchCreVendorHint(description, config = loadCreCategorizationRules()) {
  if (!config) return null;
  const hay = String(description || '').toUpperCase();

  for (const vp of config.vendorPatterns || []) {
    for (const pattern of vp.patterns || []) {
      if (!hay.includes(String(pattern).toUpperCase())) continue;
      const prop = vp.propertyId ? propertyById(config, vp.propertyId) : null;
      return {
        propertyName: prop?.shortName || prop?.name || null,
        utilityType: vp.utility || null,
        label: vp.label || null,
      };
    }
  }
  return null;
}
