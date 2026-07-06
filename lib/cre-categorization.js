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

const UTILITY_LABELS = { gas: 'Gas', electric: 'Electric', water: 'Water' };

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

export async function ensurePropertyUtilityAccounts(db, entityId, config = loadCreCategorizationRules()) {
  if (!config || config.entityId !== entityId) return { created: 0, accounts: {} };

  const parent = await db.get(
    `SELECT id FROM accounts WHERE entity_id = ? AND account_number = '6100' LIMIT 1`,
    [entityId]
  );
  const parentId = parent?.id || null;

  let created = 0;
  const accounts = {};

  for (const prop of config.properties || []) {
    accounts[prop.id] = {};
    for (const [utility, number] of Object.entries(prop.utilityAccounts || {})) {
      const label = UTILITY_LABELS[utility] || utility;
      const name = `${label} — ${prop.shortName || prop.name}`;
      let row = await db.get(
        `SELECT id, account_number, account_name FROM accounts
         WHERE entity_id = ? AND account_number = ? LIMIT 1`,
        [entityId, number]
      );
      if (!row) {
        const id = `acc-${uuidv4()}`;
        await db.run(
          `INSERT INTO accounts
           (id, entity_id, account_number, account_name, account_type, normal_balance, parent_account_id, is_active)
           VALUES (?, ?, ?, ?, 'EXPENSE', 'DEBIT', ?, TRUE)`,
          [id, entityId, number, name, parentId]
        );
        row = { id, account_number: number, account_name: name };
        created += 1;
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
