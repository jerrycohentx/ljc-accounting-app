/**
 * Build a Jerry-friendly categorization review queue:
 * drafts grouped by feed type (AMEX / Bank / Other) then month,
 * with Amex-statement-style display fields (no internal JE numbers).
 *
 * Performance: batch-load lines, source journals, and document flags
 * (no per-draft round trips).
 */
import { normalizeIsoDate } from './bank-statement-view.js';

const DUMP_ACCOUNTS = new Set(['5700', '4091']);

function monthKey(isoDate) {
  const d = String(isoDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 'unknown';
  return d.slice(0, 7);
}

function monthLabel(key) {
  if (!/^\d{4}-\d{2}$/.test(key)) return 'Unknown month';
  const [y, m] = key.split('-').map(Number);
  const names = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${names[m - 1] || key} ${y}`;
}

function statementDateFromText(text) {
  const m = String(text || '').match(/(?:Amex|AMEX|stmt|statement)\s+(\d{4}-\d{2}-\d{2})/i);
  if (m) return m[1];
  const m2 = String(text || '').match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return m2 ? m2[1] : null;
}

/**
 * Recover Amex multi-line merchant layout from flattened OFX text.
 * "APPLE.COM/BILL      INTERNET CHARGE     CA" → ["APPLE.COM/BILL", "INTERNET CHARGE", "CA"]
 */
export function toStatementDescLines(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const stripped = raw
    .replace(/^Amex stmt \d{4}-\d{2}-\d{2}:\s*/i, '')
    .replace(/^Amex:\s*/i, '')
    .replace(/^Categorize\s+\d{4}→\d{4}:\s*/i, '')
    .replace(/\s+-\s+FITID:.*$/i, '')
    .trim();
  const multi = stripped.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
  if (multi.length >= 2) return multi;
  return [stripped.replace(/\s+/g, ' ')];
}

function feedTypeFromSource(jeNumber, description) {
  const n = String(jeNumber || '');
  const d = String(description || '');
  if (/^AMEX-/i.test(n) || /^RESTORE-AMEX/i.test(n) || /amex/i.test(d)) return 'amex';
  if (/^IMP-/i.test(n) || /^LN-/i.test(n) || /simmons|bank feed|ofx/i.test(d)) return 'bank';
  if (/^CAT-APPR-/i.test(n)) return 'amex'; // fallback until source loaded
  return 'other';
}

const FEED_LABELS = {
  amex: 'American Express',
  bank: 'Bank',
  other: 'Other',
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function loadLinesByJournalIds(db, journalIds) {
  const map = new Map();
  for (const id of journalIds) map.set(id, []);
  for (const batch of chunk(journalIds, 200)) {
    if (!batch.length) continue;
    const placeholders = batch.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT jel.id, jel.journal_entry_id, jel.account_id, jel.debit, jel.credit,
              jel.description, jel.line_number, a.account_number, a.account_name
       FROM journal_entry_lines jel
       JOIN accounts a ON a.id = jel.account_id
       WHERE jel.journal_entry_id IN (${placeholders})
       ORDER BY jel.journal_entry_id, jel.line_number`,
      batch
    );
    for (const row of rows) {
      const list = map.get(row.journal_entry_id);
      if (list) list.push(row);
    }
  }
  return map;
}

async function loadJournalsByIds(db, entityId, journalIds) {
  const map = new Map();
  const unique = [...new Set(journalIds.filter(Boolean))];
  for (const batch of chunk(unique, 200)) {
    if (!batch.length) continue;
    const placeholders = batch.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT id, je_number, description, memo, posting_date
       FROM journal_entries
       WHERE entity_id = ? AND id IN (${placeholders})`,
      [entityId, ...batch]
    );
    for (const row of rows) map.set(row.id, row);
  }
  return map;
}

async function loadDocumentJournalIds(db, journalIds) {
  const withDoc = new Set();
  const unique = [...new Set(journalIds.filter(Boolean))];
  for (const batch of chunk(unique, 200)) {
    if (!batch.length) continue;
    const placeholders = batch.map(() => '?').join(',');
    try {
      const rows = await db.all(
        `SELECT DISTINCT journal_entry_id AS id
         FROM journal_entry_documents
         WHERE journal_entry_id IN (${placeholders})`,
        batch
      );
      for (const r of rows) if (r.id) withDoc.add(r.id);
    } catch { /* table may not exist */ }
    try {
      const rows = await db.all(
        `SELECT DISTINCT journal_entry_id AS id
         FROM mgmt_report_imports
         WHERE journal_entry_id IN (${placeholders})`,
        batch
      );
      for (const r of rows) if (r.id) withDoc.add(r.id);
    } catch { /* table may not exist */ }
  }
  return withDoc;
}

/**
 * @returns {{ feeds: Array, expenseAccounts: Array, total: number }}
 */
export async function buildCategorizationReview(db, { entityId, limit = 1000 } = {}) {
  const drafts = await db.all(
    `SELECT id, je_number, description, memo, posting_date, total_debit, total_credit, created_at, status
     FROM journal_entries
     WHERE entity_id = ?
       AND status IN ('DRAFT', 'APPROVED')
       AND (
         je_number LIKE 'CAT-APPR-%'
         OR COALESCE(memo, '') LIKE 'cat-approve:%'
       )
     ORDER BY posting_date ASC, created_at ASC
     LIMIT ?`,
    [entityId, limit]
  );

  const allAccounts = await db.all(
    `SELECT id, account_number, account_name, account_type, parent_account_id
     FROM accounts
     WHERE entity_id = ?
       AND is_active = 1
     ORDER BY
       CASE account_type
         WHEN 'EXPENSE' THEN 1
         WHEN 'REVENUE' THEN 2
         WHEN 'ASSET' THEN 3
         WHEN 'LIABILITY' THEN 4
         WHEN 'EQUITY' THEN 5
         ELSE 6
       END,
       account_number`,
    [entityId]
  );

  const [amexAcct, bankAcct] = await Promise.all([
    db.get(
      `SELECT id, account_number FROM accounts
       WHERE entity_id = ? AND account_number = '2010' LIMIT 1`,
      [entityId]
    ),
    db.get(
      `SELECT id, account_number FROM accounts
       WHERE entity_id = ? AND account_number = '1000' LIMIT 1`,
      [entityId]
    ),
  ]);

  const draftIds = drafts.map((d) => d.id);
  const sourceIds = [];
  const sourceByDraft = new Map();
  for (const draft of drafts) {
    const srcMatch = String(draft.memo || '').match(/cat-approve:(je-[a-f0-9-]+)/i);
    const sourceJournalId = srcMatch ? srcMatch[1] : null;
    sourceByDraft.set(draft.id, sourceJournalId);
    if (sourceJournalId) sourceIds.push(sourceJournalId);
  }

  const [linesByJe, sourcesById, docsWithFile] = await Promise.all([
    loadLinesByJournalIds(db, draftIds),
    loadJournalsByIds(db, entityId, sourceIds),
    loadDocumentJournalIds(db, [...draftIds, ...sourceIds]),
  ]);

  const items = [];
  for (const draft of drafts) {
    const lines = linesByJe.get(draft.id) || [];
    const sourceJournalId = sourceByDraft.get(draft.id) || null;
    const source = sourceJournalId ? (sourcesById.get(sourceJournalId) || null) : null;

    const categoryLine = lines.find((l) => !DUMP_ACCOUNTS.has(String(l.account_number)) && Number(l.debit) > 0)
      || lines.find((l) => !DUMP_ACCOUNTS.has(String(l.account_number)));
    const dumpLine = lines.find((l) => DUMP_ACCOUNTS.has(String(l.account_number)));

    const rawDesc = (source && source.description)
      || (lines.find((l) => /^Amex:/i.test(l.description || '')) || {}).description
      || draft.description
      || '';
    const descLines = toStatementDescLines(rawDesc);
    const hint = String((source && source.memo) || '')
      .split('|')
      .slice(1)
      .join('|')
      .replace(/\s*FITID:.*$/i, '')
      .trim();
    // Keep short Amex-style category hints (ELECTRICITY, RECORD STORE) — skip internal labels.
    const junkHint = /office\/supplies|clear \d{4}|uncategorized|amex expense|cat-approve|fitid/i;
    if (
      hint
      && hint.length <= 40
      && !junkHint.test(hint)
      && !descLines.some((l) => l.toLowerCase() === hint.toLowerCase())
    ) {
      descLines.push(hint);
    }

    const postingDate = normalizeIsoDate(draft.posting_date)
      || String(draft.posting_date || '').slice(0, 10);
    const stmtDate = statementDateFromText((source && source.description) || '')
      || statementDateFromText((source && source.memo) || '')
      || statementDateFromText(draft.description)
      || null;

    const feedKey = feedTypeFromSource(
      (source && source.je_number) || draft.je_number,
      (source && source.description) || draft.description
    );
    const amount = Number(draft.total_debit || 0) || Math.max(
      0,
      ...lines.map((l) => Number(l.debit) || 0)
    );

    const docOnDraft = docsWithFile.has(draft.id);
    const docOnSource = sourceJournalId ? docsWithFile.has(sourceJournalId) : false;

    items.push({
      id: draft.id,
      postingDate,
      monthKey: monthKey(postingDate),
      monthLabel: monthLabel(monthKey(postingDate)),
      feedKey,
      feedLabel: FEED_LABELS[feedKey] || 'Other',
      amount,
      descLines: descLines.length ? descLines : ['(no description)'],
      categoryAccountId: categoryLine?.account_id || null,
      categoryAccountNumber: categoryLine?.account_number || null,
      categoryAccountName: categoryLine?.account_name || null,
      dumpAccountNumber: dumpLine?.account_number || null,
      statementDate: stmtDate,
      documentJournalId: docOnDraft ? draft.id : (docOnSource ? sourceJournalId : null),
      hasDocument: docOnDraft || docOnSource,
      sourceDescription: rawDesc,
      // Internal only — never shown as primary UI labels
      _draftJeNumber: draft.je_number,
      _sourceJeNumber: source?.je_number || null,
      _sourceJournalId: sourceJournalId,
    });
  }

  // Pending bank/card downloads (import queue) — same review screen, plain labels.
  const pendingImports = await db.all(
    `SELECT it.date, it.amount, it.description, it.journal_entry_id, it.offset_account_id,
            it.account_id, je.je_number, je.description AS je_description, je.posting_date,
            ba.account_number AS bank_account_number, ba.account_name AS bank_account_name,
            oa.id AS offset_id, oa.account_number AS offset_number, oa.account_name AS offset_name
     FROM import_transactions it
     JOIN journal_entries je ON je.id = it.journal_entry_id
     LEFT JOIN accounts ba ON ba.id = it.account_id
     LEFT JOIN accounts oa ON oa.id = it.offset_account_id
     WHERE it.entity_id = ?
       AND it.status = 'DRAFT'
       AND je.status = 'DRAFT'
     ORDER BY it.date ASC, it.created_at ASC
     LIMIT ?`,
    [entityId, limit]
  );

  const existingIds = new Set(items.map((it) => it.id));
  for (const row of pendingImports || []) {
    if (existingIds.has(row.journal_entry_id)) continue;
    const postingDate = normalizeIsoDate(row.date || row.posting_date)
      || String(row.date || row.posting_date || '').slice(0, 10);
    const rawDesc = row.description || row.je_description || '';
    const descLines = toStatementDescLines(rawDesc);
    const amt = Math.abs(Number(row.amount) || 0);
    const isAmex = String(row.bank_account_number) === '2010'
      || /amex|american express/i.test(rawDesc)
      || /^AMEX-/i.test(row.je_number || '');
    const feedKey = isAmex ? 'amex' : 'bank';
    items.push({
      id: row.journal_entry_id,
      postingDate,
      monthKey: monthKey(postingDate),
      monthLabel: monthLabel(monthKey(postingDate)),
      feedKey,
      feedLabel: isAmex ? FEED_LABELS.amex : (row.bank_account_name || FEED_LABELS.bank),
      amount: amt,
      descLines: descLines.length ? descLines : ['(no description)'],
      categoryAccountId: row.offset_id || null,
      categoryAccountNumber: row.offset_number || null,
      categoryAccountName: row.offset_name || null,
      dumpAccountNumber: null,
      statementDate: null,
      documentJournalId: null,
      hasDocument: false,
      sourceDescription: rawDesc,
      isBankImport: !isAmex,
      _draftJeNumber: row.je_number,
      _sourceJeNumber: null,
      _sourceJournalId: null,
    });
  }

  // Group: feed → month → items
  const feedMap = new Map();
  for (const item of items) {
    if (!feedMap.has(item.feedKey)) {
      feedMap.set(item.feedKey, {
        key: item.feedKey,
        label: item.feedLabel,
        accountId: item.feedKey === 'amex' ? amexAcct?.id || null
          : item.feedKey === 'bank' ? bankAcct?.id || null
            : null,
        months: new Map(),
        count: 0,
      });
    }
    const feed = feedMap.get(item.feedKey);
    feed.count += 1;
    if (!feed.months.has(item.monthKey)) {
      feed.months.set(item.monthKey, {
        key: item.monthKey,
        label: item.monthLabel,
        statementDate: item.statementDate,
        items: [],
        count: 0,
        withDocument: 0,
      });
    }
    const month = feed.months.get(item.monthKey);
    month.items.push(item);
    month.count += 1;
    if (item.hasDocument) month.withDocument += 1;
    if (!month.statementDate && item.statementDate) month.statementDate = item.statementDate;
  }

  const feedOrder = ['amex', 'bank', 'other'];
  const feeds = feedOrder
    .filter((k) => feedMap.has(k))
    .concat([...feedMap.keys()].filter((k) => !feedOrder.includes(k)))
    .map((k) => {
      const feed = feedMap.get(k);
      const months = [...feed.months.values()]
        .sort((a, b) => String(a.key).localeCompare(String(b.key)))
        .map((m) => ({
          ...m,
          items: m.items.sort((a, b) => {
            if (a.postingDate !== b.postingDate) return a.postingDate < b.postingDate ? -1 : 1;
            return String(a.descLines[0] || '').localeCompare(String(b.descLines[0] || ''));
          }),
        }));
      return {
        key: feed.key,
        label: feed.label,
        accountId: feed.accountId,
        count: feed.count,
        months,
      };
    });

  const accounts = allAccounts.map((a) => ({
    id: a.id,
    number: a.account_number,
    name: a.account_name,
    type: a.account_type,
    parentAccountId: a.parent_account_id || null,
  }));

  return {
    entityId,
    total: items.length,
    feeds,
    accounts,
    // Backward-compatible alias used by older clients
    expenseAccounts: accounts.filter((a) => a.type === 'EXPENSE'),
  };
}
