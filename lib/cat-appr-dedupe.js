/**
 * Find duplicate CAT-APPR DRAFT journals for the same source charge.
 * Keeps the earliest created / lowest id. Never touches posted journals.
 */
import { normalizeIsoDate } from './bank-statement-view.js';

function centsFromAmount(n) {
  return Math.round(Number(n || 0) * 100);
}

/**
 * @returns {{ totalDrafts: number, keep: object[], deleteIds: string[], groups: object[] }}
 */
export async function findDuplicateCatApprDrafts(db, { entityId, limit = 5000 } = {}) {
  const drafts = await db.all(
    `SELECT id, je_number, description, memo, posting_date, total_debit, created_at
     FROM journal_entries
     WHERE entity_id = ?
       AND status = 'DRAFT'
       AND je_number LIKE 'CAT-APPR-%'
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
    [entityId, limit]
  );

  const bySource = new Map();
  const bySig = new Map();
  const meta = new Map();

  for (const d of drafts) {
    const memo = String(d.memo || '');
    const m = memo.match(/cat-approve:(je-[a-f0-9-]+)(?::([^\s|]+))?/i);
    const sourceJeId = m ? m[1] : null;
    const glId = m && m[2] ? m[2] : null;
    const postingDate = normalizeIsoDate(d.posting_date) || String(d.posting_date || '').slice(0, 10);
    const cents = centsFromAmount(d.total_debit);
    let sourceDesc = '';
    if (sourceJeId) {
      const src = await db.get(
        'SELECT description FROM journal_entries WHERE id = ? AND entity_id = ?',
        [sourceJeId, entityId]
      );
      sourceDesc = String(src?.description || '').replace(/\s+/g, ' ').trim().toUpperCase();
    }
    const info = {
      id: d.id,
      jeNumber: d.je_number,
      sourceJeId,
      glId,
      postingDate,
      cents,
      sourceDesc,
      createdAt: d.created_at,
    };
    meta.set(d.id, info);

    // One draft per source AMEX/IMP journal
    if (sourceJeId) {
      if (!bySource.has(sourceJeId)) bySource.set(sourceJeId, []);
      bySource.get(sourceJeId).push(d.id);
    }

    if (postingDate && sourceDesc) {
      const sig = `${postingDate}|${cents}|${sourceDesc}`;
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push(d.id);
    }
  }

  const deleteSet = new Set();
  const groups = [];

  function markGroup(ids, reason) {
    const unique = [...new Set(ids)];
    if (unique.length < 2) return;
    const sorted = unique.slice().sort((a, b) => {
      const A = meta.get(a);
      const B = meta.get(b);
      const ca = String(A?.createdAt || '');
      const cb = String(B?.createdAt || '');
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a < b ? -1 : 1;
    });
    const keep = sorted[0];
    const extras = sorted.slice(1).filter((id) => id !== keep);
    for (const id of extras) deleteSet.add(id);
    groups.push({
      reason,
      keepId: keep,
      deleteIds: extras,
      members: sorted.map((id) => meta.get(id)),
    });
  }

  for (const [, ids] of bySource) markGroup(ids, 'same_source');
  for (const [, ids] of bySig) markGroup(ids, 'same_date_amount_desc');

  const keep = drafts
    .filter((d) => !deleteSet.has(d.id))
    .map((d) => meta.get(d.id));

  return {
    totalDrafts: drafts.length,
    keep,
    deleteIds: [...deleteSet],
    groups,
  };
}
