import { v4 as uuidv4 } from 'uuid';
import { signedGlDelta } from './bank-reconcile-session.js';

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function dayDiff(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / (1000 * 60 * 60 * 24);
}

/**
 * Pair statement lines to uncleared register rows by persisted link or amount+date (±2 days).
 */
export function matchStatementToRegister({ statementLines, entries, normalBalance }) {
  const usedGl = new Set();
  const usedStmt = new Set();
  const pairs = [];

  for (const line of statementLines || []) {
    if (line.matchedGlId && entries.some((e) => e.id === line.matchedGlId)) {
      pairs.push({ stmtId: line.id, glId: line.matchedGlId, method: 'persisted' });
      usedGl.add(line.matchedGlId);
      usedStmt.add(line.id);
    }
  }

  for (const line of (statementLines || []).filter((l) => !usedStmt.has(l.id))) {
    const amt = round2(line.amount);
    let best = null;
    let bestDays = 999;

    for (const entry of entries) {
      if (usedGl.has(entry.id)) continue;
      const glAmt = round2(signedGlDelta(entry, normalBalance));
      if (Math.abs(glAmt - amt) >= 0.01) continue;
      const dd = dayDiff(entry.posting_date, line.date);
      if (dd <= 2 && dd < bestDays) {
        best = entry;
        bestDays = dd;
      }
    }

    if (best) {
      pairs.push({ stmtId: line.id, glId: best.id, method: 'amount-date' });
      usedGl.add(best.id);
      usedStmt.add(line.id);
    }
  }

  return {
    pairs,
    suggestedCheckedGlIds: [...usedGl],
    matchedStmtCount: usedStmt.size,
    totalStmtLines: (statementLines || []).length,
    unmatchedStmtLines: (statementLines || []).filter((l) => !usedStmt.has(l.id)),
    unmatchedRegisterIds: (entries || []).filter((e) => !usedGl.has(e.id)).map((e) => e.id),
  };
}

/** Persist import_transactions ↔ GL links (legacy reconciliation_matches table). */
export async function persistImportAutoMatches(db, { entityId, accountId, asOfDate, userId = 'usr-admin' }) {
  const glEntries = await db.all(
    `SELECT gl.*
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id
     WHERE gl.entity_id = ? AND gl.account_id = ?
       AND gl.reconciliation_status IS NULL
       AND je.status = 'POSTED'
       AND gl.id NOT IN (SELECT gl_entry_id FROM reconciliation_matches WHERE gl_entry_id IS NOT NULL)
       ${asOfDate ? 'AND gl.posting_date <= ?' : ''}
     ORDER BY gl.posting_date DESC`,
    asOfDate ? [entityId, accountId, asOfDate] : [entityId, accountId]
  );

  const bankTxns = await db.all(
    `SELECT * FROM import_transactions
     WHERE entity_id = ? AND account_id = ? AND matched_to_gl_id IS NULL
       ${asOfDate ? 'AND date <= ?' : ''}
     ORDER BY date DESC`,
    asOfDate ? [entityId, accountId, asOfDate] : [entityId, accountId]
  );

  let matchCount = 0;
  const matchedBankIds = new Set();

  for (const gl of glEntries || []) {
    const glAmount = gl.debit > 0 ? gl.debit : -gl.credit;
    let bestMatch = null;
    let bestScore = 0;

    for (const bank of bankTxns || []) {
      if (matchedBankIds.has(bank.id)) continue;
      if (Math.abs(glAmount - bank.amount) >= 0.01) continue;
      const dd = dayDiff(gl.posting_date, bank.date);
      if (dd > 2) continue;
      const score = 1.0 - dd / 2.0;
      if (score > bestScore) {
        bestMatch = bank;
        bestScore = score;
      }
    }

    if (bestMatch && bestScore > 0.5) {
      const matchId = `match-${uuidv4()}`;
      await db.run(
        `INSERT INTO reconciliation_matches (
          id, gl_entry_id, import_transaction_id, matched_amount, matched_date, matched_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          matchId,
          gl.id,
          bestMatch.id,
          glAmount,
          new Date().toISOString().split('T')[0],
          userId,
          new Date().toISOString(),
        ]
      );
      await db.run(
        'UPDATE import_transactions SET matched_to_gl_id = ?, status = ? WHERE id = ?',
        [gl.id, 'MATCHED', bestMatch.id]
      );
      matchedBankIds.add(bestMatch.id);
      matchCount += 1;
    }
  }

  return { persistedMatches: matchCount };
}
