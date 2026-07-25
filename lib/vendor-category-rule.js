/**
 * Explicit vendor → expense account rules for Review & Approve.
 * Stored in bank_categorization_rules (contains match, high priority).
 */
import { v4 as uuidv4 } from 'uuid';
import { deriveRulePattern } from './import-commit.js';

/**
 * Build a user-editable "contains" pattern from a merchant description line.
 * Uppercases keywords, strips phones / long store numbers, keeps short tokens.
 */
export function deriveVendorPattern(description) {
  let text = String(description || '')
    .replace(/^Amex(?:\s+stmt\s+\d{4}-\d{2}-\d{2})?:\s*/i, '')
    .replace(/^Categorize\s+\d{4}→\d{4}:\s*/i, '')
    .replace(/\s+-\s+FITID:.*$/i, '')
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;

  // Prefer first merchant line when multi-line / double-spaced OFX text.
  const first = text.split(/\s{2,}/)[0].trim() || text;
  let cleaned = first
    .replace(/(?:[\s#]+[\d-]{3,})+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

  if (cleaned.length < 3) {
    const fromLearn = deriveRulePattern(description);
    cleaned = fromLearn ? String(fromLearn).toUpperCase() : cleaned;
  }

  if (cleaned.length > 40) {
    const cut = cleaned.slice(0, 40);
    const lastSpace = cut.lastIndexOf(' ');
    cleaned = (lastSpace > 8 ? cut.slice(0, lastSpace) : cut).trim();
  }

  return cleaned.length >= 3 ? cleaned : null;
}

function normalizePattern(pattern) {
  const p = String(pattern || '').replace(/\s+/g, ' ').trim().toUpperCase();
  return p.length >= 3 ? p : null;
}

/**
 * Create or update an active contains-rule for a vendor pattern → account.
 * Priority 4 so explicit vendor rules beat learned (5) and most defaults.
 */
export async function upsertVendorCategoryRule(db, {
  entityId,
  pattern,
  accountId,
  label = null,
  description = null,
  priority = 4,
} = {}) {
  if (!entityId || !accountId) {
    throw new Error('entityId and accountId are required');
  }

  let resolved = normalizePattern(pattern);
  if (!resolved && description) {
    resolved = deriveVendorPattern(description);
  }
  if (!resolved) {
    throw new Error('pattern required (min 3 characters), or provide description to derive one');
  }

  const account = await db.get(
    `SELECT id, account_number, account_name FROM accounts
     WHERE id = ? AND entity_id = ? AND is_active = 1`,
    [accountId, entityId]
  );
  if (!account) throw new Error('Account not found for this entity');

  const ruleLabel = String(label || `Vendor: ${resolved.slice(0, 28)}`).slice(0, 80);
  const existing = await db.get(
    'SELECT id FROM bank_categorization_rules WHERE entity_id = ? AND pattern = ?',
    [entityId, resolved]
  );

  if (existing) {
    await db.run(
      `UPDATE bank_categorization_rules
       SET offset_account_number = ?, transfer_account_number = NULL, is_transfer = false,
           is_chargeback = false, is_active = TRUE, label = ?, priority = ?
       WHERE id = ?`,
      [account.account_number, ruleLabel, priority, existing.id]
    );
    return {
      id: existing.id,
      entityId,
      pattern: resolved,
      matchType: 'contains',
      accountId: account.id,
      accountNumber: account.account_number,
      accountName: account.account_name,
      label: ruleLabel,
      priority,
      active: true,
      updated: true,
    };
  }

  const id = `rule-${uuidv4()}`;
  await db.run(
    `INSERT INTO bank_categorization_rules
     (id, entity_id, pattern, match_type, offset_account_number, transfer_account_number,
      is_transfer, is_chargeback, priority, label, is_active)
     VALUES (?, ?, ?, 'contains', ?, NULL, false, false, ?, ?, TRUE)`,
    [id, entityId, resolved, account.account_number, priority, ruleLabel]
  );

  return {
    id,
    entityId,
    pattern: resolved,
    matchType: 'contains',
    accountId: account.id,
    accountNumber: account.account_number,
    accountName: account.account_name,
    label: ruleLabel,
    priority,
    active: true,
    updated: false,
  };
}

export async function listVendorCategoryRules(db, { entityId } = {}) {
  if (!entityId) throw new Error('entityId required');
  const rows = await db.all(
    `SELECT r.id, r.entity_id, r.pattern, r.match_type, r.offset_account_number,
            r.priority, r.label, r.is_active, r.created_at,
            a.id AS account_id, a.account_name
     FROM bank_categorization_rules r
     LEFT JOIN accounts a
       ON a.entity_id = r.entity_id AND a.account_number = r.offset_account_number
     WHERE r.entity_id = ?
       AND r.is_active = 1
       AND COALESCE(r.is_transfer, false) = false
       AND COALESCE(r.is_chargeback, false) = false
       AND r.offset_account_number IS NOT NULL
     ORDER BY r.priority ASC, r.pattern ASC`,
    [entityId]
  );
  return rows.map((r) => ({
    id: r.id,
    entityId: r.entity_id,
    pattern: r.pattern,
    matchType: r.match_type || 'contains',
    accountId: r.account_id || null,
    accountNumber: r.offset_account_number,
    accountName: r.account_name || null,
    label: r.label,
    priority: r.priority,
    active: true,
    createdAt: r.created_at,
  }));
}

/**
 * Point open CAT-APPR DRAFT category lines at the rule's account when the
 * source description contains the pattern. Never touches posted journals.
 */
export async function applyVendorRuleToOpenDrafts(db, {
  entityId,
  pattern,
  accountId,
  limit = 500,
} = {}) {
  const needle = normalizePattern(pattern);
  if (!needle || !entityId || !accountId) return { updated: 0 };

  const account = await db.get(
    'SELECT id, account_number FROM accounts WHERE id = ? AND entity_id = ?',
    [accountId, entityId]
  );
  if (!account) return { updated: 0 };

  const drafts = await db.all(
    `SELECT id, memo, description FROM journal_entries
     WHERE entity_id = ?
       AND status = 'DRAFT'
       AND je_number LIKE 'CAT-APPR-%'
     ORDER BY created_at ASC
     LIMIT ?`,
    [entityId, limit]
  );

  const dumpNums = new Set(['5700', '4091']);
  let updated = 0;
  for (const draft of drafts) {
    const srcMatch = String(draft.memo || '').match(/cat-approve:(je-[a-f0-9-]+)/i);
    let text = String(draft.description || '');
    if (srcMatch) {
      const src = await db.get(
        'SELECT description, memo FROM journal_entries WHERE id = ? AND entity_id = ?',
        [srcMatch[1], entityId]
      );
      if (src) text = [src.description, src.memo].filter(Boolean).join(' ');
    }
    if (!String(text).toUpperCase().includes(needle)) continue;

    const lines = await db.all(
      `SELECT jel.id, a.account_number
       FROM journal_entry_lines jel
       JOIN accounts a ON a.id = jel.account_id
       WHERE jel.journal_entry_id = ?
       ORDER BY jel.line_number`,
      [draft.id]
    );
    const categoryLine = lines.find((l) => !dumpNums.has(String(l.account_number)));
    if (!categoryLine || categoryLine.account_number === account.account_number) continue;
    await db.run('UPDATE journal_entry_lines SET account_id = ? WHERE id = ?', [
      account.id,
      categoryLine.id,
    ]);
    updated += 1;
  }
  return { updated, pattern: needle, accountNumber: account.account_number };
}
