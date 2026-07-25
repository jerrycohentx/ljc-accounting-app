/**
 * Build a Jerry-friendly categorization review queue:
 * drafts grouped by feed type (AMEX / Bank / Other) then month,
 * with Amex-statement-style display fields (no internal JE numbers).
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

async function hasDocument(db, journalId) {
  if (!journalId) return false;
  try {
    const row = await db.get(
      'SELECT id FROM journal_entry_documents WHERE journal_entry_id = ? LIMIT 1',
      [journalId]
    );
    if (row) return true;
  } catch { /* table may not exist */ }
  try {
    const mri = await db.get(
      'SELECT id FROM mgmt_report_imports WHERE journal_entry_id = ? LIMIT 1',
      [journalId]
    );
    return !!mri;
  } catch {
    return false;
  }
}

/**
 * @returns {{ feeds: Array, expenseAccounts: Array, total: number }}
 */
export async function buildCategorizationReview(db, { entityId, limit = 1000 } = {}) {
  const drafts = await db.all(
    `SELECT *
     FROM journal_entries
     WHERE entity_id = ?
       AND status = 'DRAFT'
     ORDER BY posting_date ASC, created_at ASC
     LIMIT ?`,
    [entityId, limit]
  );

  const expenseAccounts = await db.all(
    `SELECT id, account_number, account_name
     FROM accounts
     WHERE entity_id = ?
       AND is_active = 1
       AND account_type = 'EXPENSE'
     ORDER BY account_number`,
    [entityId]
  );

  const amexAcct = await db.get(
    `SELECT id, account_number FROM accounts
     WHERE entity_id = ? AND account_number = '2010' LIMIT 1`,
    [entityId]
  );
  const bankAcct = await db.get(
    `SELECT id, account_number FROM accounts
     WHERE entity_id = ? AND account_number = '1000' LIMIT 1`,
    [entityId]
  );

  const items = [];
  for (const draft of drafts) {
    const lines = await db.all(
      `SELECT jel.*, a.account_number, a.account_name
       FROM journal_entry_lines jel
       JOIN accounts a ON a.id = jel.account_id
       WHERE jel.journal_entry_id = ?
       ORDER BY jel.line_number`,
      [draft.id]
    );

    const memo = String(draft.memo || '');
    const srcMatch = memo.match(/cat-approve:(je-[a-f0-9-]+)/i);
    const sourceJournalId = srcMatch ? srcMatch[1] : null;
    let source = null;
    if (sourceJournalId) {
      source = await db.get(
        'SELECT id, je_number, description, memo, posting_date FROM journal_entries WHERE id = ? AND entity_id = ?',
        [sourceJournalId, entityId]
      );
    }

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
    if (hint && !descLines.some((l) => l.toLowerCase() === hint.toLowerCase())) {
      // Keep Amex-style category hint (e.g. ELECTRICITY) when present in memo.
      if (!/office\/supplies|clear \d{4}/i.test(hint)) descLines.push(hint);
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
      ...lines.map((l) => Number(l.debit) || 0),
      0
    );

    const docOnDraft = await hasDocument(db, draft.id);
    const docOnSource = sourceJournalId ? await hasDocument(db, sourceJournalId) : false;

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

  return {
    entityId,
    total: items.length,
    feeds,
    expenseAccounts: expenseAccounts.map((a) => ({
      id: a.id,
      number: a.account_number,
      name: a.account_name,
    })),
  };
}
