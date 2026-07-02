/**
 * Cross-source duplicate detection for bank/card feed imports.
 *
 * Different import sources assign totally different transaction IDs (fitids)
 * for the SAME real-world transaction:
 *   - a scanned/PDF statement import derives `pdf-<sha256 of date|amount|desc>`
 *   - an OFX file carries the bank's own native <FITID>
 *   - Plaid assigns `plaid-<transaction_id>`
 * so fitid-only dedup lets the same transaction in twice whenever it arrives
 * through two different pipelines (this is exactly how ~250 Simmons
 * transactions got double-posted across Jan-May 2026: once from a statement
 * import, once from an OFX reconcile import, on the same day).
 *
 * This module closes that gap by ALSO recognizing an already-known
 * transaction by its content -- date + signed amount + a similar description
 * -- scoped to the SAME bank/card account, so a statement import won't
 * re-post what an OFX import (or Plaid, or any future source) already
 * posted for that account, and vice versa. An Amex charge and a Simmons
 * bank debit on the same day for the same amount are NOT considered
 * duplicates of each other, because they're scoped to different accounts.
 *
 * It is deliberately CONSERVATIVE: when unsure, it lets the transaction
 * through (better to surface a possible duplicate for human review than to
 * silently swallow a real, legitimate transaction). Matching is one-for-one,
 * so two legitimately identical same-day transactions are not collapsed into
 * one duplicate.
 */

export function normalizeDesc(desc) {
  return String(desc || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function signedCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Loose description match tolerant of OFX vs PDF vs Plaid wording differences. */
export function descriptionsMatch(a, b) {
  const na = normalizeDesc(a);
  const nb = normalizeDesc(b);
  if (!na || !nb) return false; // can't confirm -- let it through to review
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // token overlap (Jaccard) as a fallback for reordered/abbreviated wording
  const ta = new Set(na.split(' ').filter((w) => w.length > 1));
  const tb = new Set(nb.split(' ').filter((w) => w.length > 1));
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union > 0 && inter / union >= 0.6;
}

/** Every previously-imported row for this entity+account, any source, not rejected. */
const KNOWN_ROWS_SQL = `
  SELECT it.date, it.amount, it.description, it.fitid
    FROM import_transactions it
   WHERE it.entity_id = ?
     AND it.account_id = ?
     AND it.status != 'REJECTED'
`;

function buildContentBuckets(existing) {
  const buckets = new Map();
  for (const e of existing) {
    const key = `${String(e.date).slice(0, 10)}|${signedCents(e.amount)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ norm: normalizeDesc(e.description), used: false });
  }
  return buckets;
}

function partitionByContent(buckets, transactions) {
  const kept = [];
  const dropped = [];
  for (const t of transactions) {
    const key = `${String(t.date).slice(0, 10)}|${signedCents(t.amount)}`;
    const candidates = buckets.get(key);
    let matched = false;
    if (candidates && candidates.length) {
      const tn = normalizeDesc(t.description);
      for (const cand of candidates) {
        if (cand.used) continue;
        if (descriptionsMatch(tn, cand.norm)) {
          cand.used = true;
          matched = true;
          break;
        }
      }
    }
    if (matched) dropped.push(t);
    else kept.push(t);
  }
  return { kept, dropped };
}

/**
 * Split incoming transactions for a specific (entity, account) into
 * { kept, duplicates }, where `duplicates` already exist -- either by exact
 * fitid match (fast path, catches same-source re-imports) or by content
 * match (date + signed amount + similar description, scoped to this
 * account -- catches the same real transaction arriving through a
 * DIFFERENT import source). Every previously-imported row (DRAFT,
 * MATCHED, or POSTED -- anything not REJECTED) counts as "already known",
 * so a duplicate is blocked whether the original is still pending review
 * or has already been posted.
 *
 * This is the single choke point every bank/card commit function should
 * call before creating journal entries, so ANY current or future import
 * method (statement upload, OFX file, Plaid sync, Amex feed, a one-off
 * backfill script, etc.) gets the same protection automatically.
 */
export async function filterNewTransactions(db, entityId, accountId, transactions) {
  if (!transactions?.length) {
    return { kept: [], duplicates: [], fitidDuplicateCount: 0, contentDuplicateCount: 0 };
  }

  const existing = await db.all(KNOWN_ROWS_SQL, [entityId, accountId]);
  const existingFitids = new Set(existing.map((r) => r.fitid).filter((f) => f));

  const afterFitid = [];
  const fitidDuplicates = [];
  for (const t of transactions) {
    if (t.fitid && existingFitids.has(t.fitid)) {
      fitidDuplicates.push(t);
    } else {
      afterFitid.push(t);
    }
  }

  const buckets = buildContentBuckets(existing);
  const { kept, dropped: contentDuplicates } = partitionByContent(buckets, afterFitid);

  return {
    kept,
    duplicates: [...fitidDuplicates, ...contentDuplicates],
    fitidDuplicateCount: fitidDuplicates.length,
    contentDuplicateCount: contentDuplicates.length,
  };
}
