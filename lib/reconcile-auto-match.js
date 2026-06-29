import { v4 as uuidv4 } from 'uuid';
import { signedGlDelta } from './bank-reconcile-session.js';

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function dayDiff(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / (86400000);
}

function sideFromAmount(amount) {
  return amount < 0 ? 'debit' : 'credit';
}

function entrySide(entry, normalBalance) {
  const signed = round2(signedGlDelta(entry, normalBalance));
  if (Math.abs(signed) < 0.005) return null;
  return signed < 0 ? 'payment' : 'deposit';
}

function descSimilarity(a, b) {
  const x = String(a || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  const y = String(b || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  if (!x || !y) return 0;
  const wordsX = new Set(x.split(/\s+/).filter((w) => w.length > 2));
  const wordsY = new Set(y.split(/\s+/).filter((w) => w.length > 2));
  if (!wordsX.size || !wordsY.size) return 0;
  let overlap = 0;
  for (const w of wordsX) if (wordsY.has(w)) overlap += 1;
  return overlap / Math.max(wordsX.size, wordsY.size);
}

function scoreCandidate({ line, entry, normalBalance }) {
  const amt = round2(line.amount);
  const glAmt = round2(signedGlDelta(entry, normalBalance));
  if (Math.abs(glAmt - amt) >= 0.01) return null;

  const stmtSide = sideFromAmount(amt);
  const regSide = entrySide(entry, normalBalance);
  if (stmtSide === 'debit' && regSide !== 'payment') return null;
  if (stmtSide === 'credit' && regSide !== 'deposit') return null;

  let confidence = 70;
  const dd = dayDiff(entry.posting_date, line.date);
  if (dd === 0) confidence += 20;
  else if (dd <= 1) confidence += 15;
  else if (dd <= 3) confidence += 8;
  else if (dd <= 7) confidence += 3;
  else return null;

  const chk = entry.je_number || entry.check_number || '';
  if (chk && String(line.description || '').includes(String(chk).replace(/\D/g, ''))) {
    confidence += 15;
  }

  confidence += Math.round(descSimilarity(line.description, entry.je_description || entry.description) * 10);
  return Math.min(100, confidence);
}

/**
 * Auto-match with confidence scoring (spec §6a).
 * Returns matchStatus per statement line and clearState per register entry.
 */
export function matchStatementToRegister({ statementLines, entries, normalBalance }) {
  const usedGl = new Set();
  const usedStmt = new Set();
  const pairs = [];
  const candidates = [];

  // Persisted links first
  for (const line of statementLines || []) {
    if (line.matchedGlId && entries.some((e) => e.id === line.matchedGlId)) {
      pairs.push({
        stmtId: line.id,
        glId: line.matchedGlId,
        method: 'persisted',
        confidence: 100,
        matchStatus: 'matched',
      });
      usedGl.add(line.matchedGlId);
      usedStmt.add(line.id);
    }
  }

  for (const line of (statementLines || []).filter((l) => !usedStmt.has(l.id))) {
    for (const entry of entries) {
      if (usedGl.has(entry.id)) continue;
      const confidence = scoreCandidate({ line, entry, normalBalance });
      if (confidence == null) continue;
      candidates.push({ stmtId: line.id, glId: entry.id, confidence, line, entry });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);

  const stmtCandidateCounts = new Map();
  for (const c of candidates) {
    stmtCandidateCounts.set(c.stmtId, (stmtCandidateCounts.get(c.stmtId) || 0) + 1);
  }

  const ambiguousStmt = new Set();
  for (const c of candidates) {
    if (usedStmt.has(c.stmtId) || usedGl.has(c.glId)) continue;
    const sameStmt = candidates.filter(
      (x) => x.stmtId === c.stmtId && x.confidence === c.confidence && !usedGl.has(x.glId)
    );
    if (sameStmt.length > 1 && c.confidence < 95) {
      ambiguousStmt.add(c.stmtId);
      continue;
    }
    if (ambiguousStmt.has(c.stmtId)) continue;

    const status = c.confidence >= 85 ? 'matched' : 'needs_review';
    pairs.push({
      stmtId: c.stmtId,
      glId: c.glId,
      method: 'auto',
      confidence: c.confidence,
      matchStatus: status,
    });
    usedGl.add(c.glId);
    usedStmt.add(c.stmtId);
  }

  const pairByStmt = new Map(pairs.map((p) => [p.stmtId, p]));
  const pairByGl = new Map(pairs.map((p) => [p.glId, p]));

  const enrichedLines = (statementLines || []).map((line) => {
    const pair = pairByStmt.get(line.id);
    let matchStatus = 'unmatched';
    if (pair) matchStatus = pair.matchStatus;
    else if (ambiguousStmt.has(line.id)) matchStatus = 'needs_review';
    return {
      ...line,
      matchStatus,
      matchedGlId: pair?.glId || line.matchedGlId || null,
      matchConfidence: pair?.confidence ?? null,
    };
  });

  const enrichedEntries = (entries || []).map((entry) => {
    const pair = pairByGl.get(entry.id);
    let clearState = 'unmatched';
    if (pair) clearState = pair.matchStatus === 'matched' ? 'auto_pending' : 'needs_review';
    return {
      ...entry,
      clearState,
      matchedStatementLineId: pair?.stmtId || null,
      matchConfidence: pair?.confidence ?? null,
    };
  });

  const matchedCount = pairs.filter((p) => p.matchStatus === 'matched').length;
  const needsReviewCount = pairs.filter((p) => p.matchStatus === 'needs_review').length
    + ambiguousStmt.size
    + enrichedLines.filter((l) => l.matchStatus === 'needs_review' && !pairByStmt.has(l.id)).length;
  const unmatchedStmtCount = enrichedLines.filter((l) => l.matchStatus === 'unmatched').length;

  return {
    pairs,
    suggestedCheckedGlIds: pairs.filter((p) => p.matchStatus === 'matched').map((p) => p.glId),
    statementLines: enrichedLines,
    entries: enrichedEntries,
    matchedStmtCount: matchedCount,
    needsReviewCount,
    totalStmtLines: (statementLines || []).length,
    unmatchedStmtLines: enrichedLines.filter((l) => l.matchStatus === 'unmatched'),
    unmatchedRegisterIds: (entries || []).filter((e) => !usedGl.has(e.id)).map((e) => e.id),
    reviewSummary: {
      autoMatched: matchedCount,
      needsReview: needsReviewCount,
      onStatementOnly: unmatchedStmtCount,
    },
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

/** Detect bank fee / interest keywords for Modify suggestions (spec §6b). */
export function suggestFeeInterest(statementLines) {
  let serviceCharge = null;
  let interestEarned = null;
  for (const line of statementLines || []) {
    const desc = String(line.description || '').toLowerCase();
    const amt = Math.abs(round2(line.amount));
    if (/service charge|monthly fee|maintenance fee|overdraft fee/.test(desc)) {
      serviceCharge = { amount: amt, date: line.date, description: line.description };
    }
    if (/interest earned|interest paid|cd interest/.test(desc) && line.amount > 0) {
      interestEarned = { amount: amt, date: line.date, description: line.description };
    }
  }
  return { serviceCharge, interestEarned };
}
