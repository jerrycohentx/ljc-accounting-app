/**
 * Explicit vendor → expense account rules for Review & Approve.
 * Stored in bank_categorization_rules (contains / starts_with / exact).
 */
import { v4 as uuidv4 } from 'uuid';
import { deriveRulePattern } from './import-commit.js';

const MATCH_TYPES = new Set(['contains', 'starts_with', 'exact']);

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

/**
 * Build a user-editable vendor pattern that generalizes across order #s / zips.
 * Prefer domain-like tokens (BLUEHOST.COM) so "contains" catches all variants.
 */
export function deriveVendorPattern(description) {
  let text = String(description || '')
    .replace(/^Amex(?:\s+stmt\s+\d{4}-\d{2}-\d{2})?:\s*/i, '')
    .replace(/^Categorize\s+\d{4}→\d{4}:\s*/i, '')
    .replace(/\s+-\s+FITID:.*$/i, '')
    // Phone numbers
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, ' ')
    // Pure digit / reference tokens anywhere (order ids, zips, store #s)
    .replace(/\b\d{3,}(?:-\d+)*\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;

  const first = text.split(/\s{2,}/)[0].trim() || text;
  const tokens = first
    .toUpperCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^A-Z0-9*]+|[^A-Z0-9*.]+$/g, ''))
    .filter(Boolean)
    .filter((t) => !US_STATE_CODES.has(t))
    .filter((t) => !/^\d+$/.test(t));

  if (!tokens.length) {
    const fromLearn = deriveRulePattern(description);
    return fromLearn ? String(fromLearn).toUpperCase() : null;
  }

  // Prefer a domain / web merchant token — most stable across Amex variants.
  const domain = tokens.find((t) => /\.[A-Z]{2,}/.test(t) || /^WEB\*[A-Z0-9*.]+$/i.test(t));
  if (domain) {
    // WEB*BLUEHOST.COM → BLUEHOST.COM when possible (broader contains match)
    const bare = domain.replace(/^WEB\*/i, '');
    const pick = bare.length >= 4 ? bare : domain;
    return pick.length >= 3 ? pick : null;
  }

  // Otherwise keep the first 1–3 alpha merchant words (skip tiny noise).
  const words = tokens.filter((t) => /[A-Z]/.test(t) && t.length >= 3).slice(0, 3);
  let cleaned = (words.length ? words : tokens.slice(0, 3)).join(' ').trim();

  if (cleaned.length > 36) {
    const cut = cleaned.slice(0, 36);
    const lastSpace = cut.lastIndexOf(' ');
    cleaned = (lastSpace > 8 ? cut.slice(0, lastSpace) : cut).trim();
  }

  return cleaned.length >= 3 ? cleaned : null;
}

export function normalizePattern(pattern) {
  const p = String(pattern || '').replace(/\s+/g, ' ').trim().toUpperCase();
  return p.length >= 3 ? p : null;
}

export function normalizeMatchType(matchType) {
  const m = String(matchType || 'contains').toLowerCase().trim();
  return MATCH_TYPES.has(m) ? m : 'contains';
}

/** Does haystack match pattern under matchType? */
export function vendorPatternMatches(text, pattern, matchType = 'contains') {
  const hay = String(text || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const pat = normalizePattern(pattern);
  if (!hay || !pat) return false;
  switch (normalizeMatchType(matchType)) {
    case 'exact':
      return hay === pat;
    case 'starts_with':
      return hay.startsWith(pat);
    default:
      return hay.includes(pat);
  }
}

/**
 * Create or update an active vendor rule → account.
 * Priority 4 so explicit vendor rules beat learned (5) and most defaults.
 */
export async function upsertVendorCategoryRule(db, {
  entityId,
  pattern,
  accountId,
  label = null,
  description = null,
  matchType = 'contains',
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
  const resolvedMatch = normalizeMatchType(matchType);

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
           is_chargeback = false, is_active = TRUE, label = ?, priority = ?, match_type = ?
       WHERE id = ?`,
      [account.account_number, ruleLabel, priority, resolvedMatch, existing.id]
    );
    return {
      id: existing.id,
      entityId,
      pattern: resolved,
      matchType: resolvedMatch,
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
     VALUES (?, ?, ?, ?, ?, NULL, false, false, ?, ?, TRUE)`,
    [id, entityId, resolved, resolvedMatch, account.account_number, priority, ruleLabel]
  );

  return {
    id,
    entityId,
    pattern: resolved,
    matchType: resolvedMatch,
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
 * source description matches the pattern. Never touches posted journals.
 * CAT-APPR shape: debit = category (expense/dump), credit = clear dump/source.
 */
export async function applyVendorRuleToOpenDrafts(db, {
  entityId,
  pattern,
  accountId,
  matchType = 'contains',
  limit = 2000,
} = {}) {
  const needle = normalizePattern(pattern);
  const resolvedMatch = normalizeMatchType(matchType);
  if (!needle || !entityId || !accountId) return { updated: 0, matched: 0 };

  const account = await db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE id = ? AND entity_id = ?',
    [accountId, entityId]
  );
  if (!account) return { updated: 0, matched: 0 };

  const drafts = await db.all(
    `SELECT id, memo, description FROM journal_entries
     WHERE entity_id = ?
       AND status = 'DRAFT'
       AND je_number LIKE 'CAT-APPR-%'
     ORDER BY created_at ASC
     LIMIT ?`,
    [entityId, limit]
  );

  let matched = 0;
  let updated = 0;
  const updatedIds = [];
  for (const draft of drafts) {
    const srcMatch = String(draft.memo || '').match(/cat-approve:(je-[a-f0-9-]+)/i);
    let text = String(draft.description || '');
    if (srcMatch) {
      const src = await db.get(
        'SELECT description, memo FROM journal_entries WHERE id = ? AND entity_id = ?',
        [srcMatch[1], entityId]
      );
      if (src) text = [src.description, src.memo, text].filter(Boolean).join(' ');
    }
    if (!vendorPatternMatches(text, needle, resolvedMatch)) continue;
    matched += 1;

    const lines = await db.all(
      `SELECT jel.id, jel.debit, jel.credit, a.account_number
       FROM journal_entry_lines jel
       JOIN accounts a ON a.id = jel.account_id
       WHERE jel.journal_entry_id = ?
       ORDER BY jel.line_number`,
      [draft.id]
    );
    // Always retarget the debit (category) line — never the credit/clear line.
    const categoryLine = lines.find((l) => Number(l.debit) > 0) || lines[0];
    if (!categoryLine) continue;
    if (String(categoryLine.account_number) === String(account.account_number)) continue;

    await db.run('UPDATE journal_entry_lines SET account_id = ? WHERE id = ?', [
      account.id,
      categoryLine.id,
    ]);
    updated += 1;
    updatedIds.push(draft.id);
  }
  return {
    updated,
    matched,
    pattern: needle,
    matchType: resolvedMatch,
    accountId: account.id,
    accountNumber: account.account_number,
    accountName: account.account_name,
    updatedIds,
  };
}
