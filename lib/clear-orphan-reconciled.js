/**
 * Clear orphan RECONCILED marks on bank GL lines that are not tied to a CLOSED
 * $0 session covering their month — so auto-reconcile can rebuild the month.
 */
import { normalizeIsoDate } from './bank-statement-view.js';
import { ensureBankReconSessionTables } from './bank-reconcile-session.js';
import { statementCoversMonth } from './period-integrity.js';
import { monthBounds } from './period-lock.js';

const ENTITY_ID = 'ent-ljc';

export async function clearOrphanReconciledMarks(db, {
  entityId = ENTITY_ID,
  accountNumber,
  fromDate,
  toDate,
} = {}) {
  await ensureBankReconSessionTables(db);
  const acc = await db.get(
    'SELECT id, account_number FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, accountNumber]
  );
  if (!acc) throw new Error(`Account ${accountNumber} not found`);

  const sessions = await db.all(
    `SELECT id, statement_date, status, difference
     FROM bank_reconciliation_sessions
     WHERE entity_id = ? AND account_id = ? AND status = 'CLOSED' AND ABS(difference) < 0.01`,
    [entityId, acc.id]
  );

  const validSessionIds = new Set();
  for (const s of sessions || []) {
    const sd = normalizeIsoDate(s.statement_date);
    if (!sd) continue;
    // Keep session id as valid for lines linked to it
    validSessionIds.add(s.id);
  }

  // Lines in range marked RECONCILED but session missing / not closed $0 / or session
  // does not cover the line's calendar month
  const rows = await db.all(
    `SELECT gl.id, gl.posting_date, gl.reconciliation_session_id, gl.reconciliation_status
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id
       AND je.status = 'POSTED'
       AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
     WHERE gl.entity_id = ? AND gl.account_id = ?
       AND gl.reconciliation_status = 'RECONCILED'
       AND gl.posting_date >= ? AND gl.posting_date <= ?`,
    [entityId, acc.id, fromDate, toDate]
  );

  let cleared = 0;
  for (const row of rows) {
    const iso = normalizeIsoDate(row.posting_date);
    const sid = row.reconciliation_session_id;
    let keep = false;
    if (sid && validSessionIds.has(sid)) {
      const sess = (sessions || []).find((s) => s.id === sid);
      if (sess) {
        const { periodStart, periodEnd } = monthBounds(iso);
        if (statementCoversMonth(sess.statement_date, periodStart, periodEnd)) {
          keep = true;
        }
      }
    }
    if (keep) continue;
    await db.run(
      `UPDATE general_ledger
       SET reconciliation_status = NULL, reconciliation_session_id = NULL
       WHERE id = ?`,
      [row.id]
    );
    cleared += 1;
  }

  return {
    accountNumber,
    fromDate,
    toDate,
    scanned: rows.length,
    cleared,
  };
}

export async function clearOrphanReconciledForH1Banks(db, { entityId = ENTITY_ID } = {}) {
  const accounts = ['1000', '1001', '2010'];
  const results = [];
  for (const accountNumber of accounts) {
    results.push(
      await clearOrphanReconciledMarks(db, {
        entityId,
        accountNumber,
        fromDate: '2026-04-01',
        toDate: '2026-06-30',
      })
    );
  }
  return results;
}
