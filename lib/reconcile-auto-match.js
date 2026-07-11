import { v4 as uuidv4 } from 'uuid';
import { signedGlDelta } from './bank-reconcile-session.js';

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function toIsoDay(value) {
  if (value == null || value === '') return '';
  return String(value).slice(0, 10);
}

function cents(value) {
  return Math.round(Number(value || 0) * 100);
}

function statementKey(line) {
  return `${toIsoDay(line.date)}|${cents(line.amount)}`;
}

function glSignedAmount(entry, normalBalance) {
  return round2(signedGlDelta(entry, normalBalance));
}

function registerKey(entry, normalBalance) {
  return `${toIsoDay(entry.posting_date)}|${cents(glSignedAmount(entry, normalBalance))}`;
}

/**
 * 4-step linear routine:
 * [Import Statement] -> [Exact Match Check] -> [User Verification] -> [Flag & Post]
 *
 * Matching is strict one-to-one with unique identifiers only:
 * 1) exact journal_entry_id link when available
 * 2) exact (date, signed amount) key
 *
 * No fuzzy scoring and no multi-transaction grouping.
 */
export function matchStatementToRegister({ statementLines, entries, normalBalance }) {
  const allLines = statementLines || [];
  const allEntries = entries || [];
  const usedGl = new Set();
  const usedStmt = new Set();
  const pairs = [];
  const ambiguousStmt = new Set();
  const ambiguousGl = new Set();
  const entryIds = new Set(allEntries.map((e) => e.id));

  const addPair = (line, entry, method) => {
    pairs.push({
      stmtId: line.id,
      glId: entry.id,
      method,
      confidence: 100,
      matchStatus: 'matched',
    });
    usedStmt.add(line.id);
    usedGl.add(entry.id);
  };

  // 1) Persisted links first
  for (const line of allLines) {
    if (line.matchedGlId && entryIds.has(line.matchedGlId)) {
      addPair(line, { id: line.matchedGlId }, 'persisted');
    }
  }

  // 2) Exact journal_entry_id matches
  const entriesByJournal = new Map();
  for (const entry of allEntries) {
    const je = entry.journal_entry_id || entry.journalEntryId;
    if (!je) continue;
    const key = String(je);
    if (!entriesByJournal.has(key)) entriesByJournal.set(key, []);
    entriesByJournal.get(key).push(entry);
  }
  for (const line of allLines) {
    if (usedStmt.has(line.id)) continue;
    const je = line.journalEntryId || line.journal_entry_id;
    if (!je) continue;
    const candidates = (entriesByJournal.get(String(je)) || []).filter((e) => !usedGl.has(e.id));
    if (candidates.length === 1) {
      addPair(line, candidates[0], 'exact-journal-id');
    } else if (candidates.length > 1) {
      ambiguousStmt.add(line.id);
      candidates.forEach((e) => ambiguousGl.add(e.id));
    }
  }

  // 3) Exact date+amount key matches
  const entriesByKey = new Map();
  for (const entry of allEntries) {
    const key = registerKey(entry, normalBalance);
    if (!entriesByKey.has(key)) entriesByKey.set(key, []);
    entriesByKey.get(key).push(entry);
  }
  for (const line of allLines) {
    if (usedStmt.has(line.id)) continue;
    const key = statementKey(line);
    const candidates = (entriesByKey.get(key) || []).filter((e) => !usedGl.has(e.id));
    if (candidates.length === 1) {
      addPair(line, candidates[0], 'exact-date-amount');
    } else if (candidates.length > 1) {
      ambiguousStmt.add(line.id);
      candidates.forEach((e) => ambiguousGl.add(e.id));
    }
  }

  const pairByStmt = new Map(pairs.map((p) => [p.stmtId, p]));
  const pairByGl = new Map(pairs.map((p) => [p.glId, p]));

  const enrichedLines = allLines.map((line) => {
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

  const enrichedEntries = allEntries.map((entry) => {
    const pair = pairByGl.get(entry.id);
    let clearState = 'unmatched';
    if (pair) clearState = pair.matchStatus === 'matched' ? 'auto_pending' : 'needs_review';
    else if (ambiguousGl.has(entry.id)) clearState = 'needs_review';
    return {
      ...entry,
      clearState,
      matchedStatementLineId: pair?.stmtId || null,
      matchConfidence: pair?.confidence ?? null,
    };
  });

  const matchedCount = pairs.filter((p) => p.matchStatus === 'matched').length;
  const needsReviewCount = enrichedLines.filter((l) => l.matchStatus === 'needs_review').length;
  const unmatchedStmtCount = enrichedLines.filter((l) => l.matchStatus === 'unmatched').length;

  return {
    pairs,
    suggestedCheckedGlIds: pairs.filter((p) => p.matchStatus === 'matched').map((p) => p.glId),
    statementLines: enrichedLines,
    entries: enrichedEntries,
    matchedStmtCount: matchedCount,
    needsReviewCount,
    totalStmtLines: allLines.length,
    unmatchedStmtLines: enrichedLines.filter((l) => l.matchStatus === 'unmatched'),
    unmatchedRegisterIds: allEntries.filter((e) => !usedGl.has(e.id)).map((e) => e.id),
    reviewSummary: {
      autoMatched: matchedCount,
      needsReview: needsReviewCount,
      onStatementOnly: unmatchedStmtCount,
    },
  };
}

/** Persist import_transactions ↔ GL links (legacy reconciliation_matches table). */
export async function persistImportAutoMatches(db, { entityId, accountId, asOfDate, userId = 'usr-admin' }) {
  const account = await db.get(
    'SELECT normal_balance FROM accounts WHERE id = ? AND entity_id = ?',
    [accountId, entityId]
  ).catch(() => null);
  const normalBalance = account?.normal_balance || 'DEBIT';

  const glEntries = await db.all(
    `SELECT gl.id, gl.journal_entry_id, gl.posting_date, gl.debit, gl.credit
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
    `SELECT id, journal_entry_id, date, amount
     FROM import_transactions
     WHERE entity_id = ? AND account_id = ? AND matched_to_gl_id IS NULL
       ${asOfDate ? 'AND date <= ?' : ''}
     ORDER BY id ASC`,
    asOfDate ? [entityId, accountId, asOfDate] : [entityId, accountId]
  );

  let matchCount = 0;
  const usedGl = new Set();
  const usedBank = new Set();

  const persistPair = async (gl, bank, method) => {
    const glAmount = glSignedAmount(gl, normalBalance);
    const matchId = `match-${uuidv4()}`;
    await db.run(
      `INSERT INTO reconciliation_matches (
        id, gl_entry_id, import_transaction_id, matched_amount, matched_date, matched_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        matchId,
        gl.id,
        bank.id,
        glAmount,
        toIsoDay(bank.date) || new Date().toISOString().slice(0, 10),
        `${userId}:${method}`,
        new Date().toISOString(),
      ]
    );
    await db.run(
      'UPDATE import_transactions SET matched_to_gl_id = ?, status = ? WHERE id = ?',
      [gl.id, 'MATCHED', bank.id]
    );
    usedGl.add(gl.id);
    usedBank.add(bank.id);
    matchCount += 1;
  };

  // Step A: exact one-to-one by journal_entry_id (unique identifier)
  const glByJournal = new Map();
  for (const gl of glEntries || []) {
    if (!gl.journal_entry_id) continue;
    const key = String(gl.journal_entry_id);
    if (!glByJournal.has(key)) glByJournal.set(key, []);
    glByJournal.get(key).push(gl);
  }
  for (const bank of bankTxns || []) {
    if (usedBank.has(bank.id) || !bank.journal_entry_id) continue;
    const candidates = (glByJournal.get(String(bank.journal_entry_id)) || []).filter((gl) => !usedGl.has(gl.id));
    if (candidates.length === 1) {
      await persistPair(candidates[0], bank, 'exact-journal-id');
    }
  }

  // Step B: exact one-to-one by (date, signed amount)
  const glByKey = new Map();
  for (const gl of glEntries || []) {
    const key = registerKey(gl, normalBalance);
    if (!glByKey.has(key)) glByKey.set(key, []);
    glByKey.get(key).push(gl);
  }
  for (const bank of bankTxns || []) {
    if (usedBank.has(bank.id)) continue;
    const key = `${toIsoDay(bank.date)}|${cents(bank.amount)}`;
    const candidates = (glByKey.get(key) || []).filter((gl) => !usedGl.has(gl.id));
    if (candidates.length === 1) {
      await persistPair(candidates[0], bank, 'exact-date-amount');
    }
  }

  return { persistedMatches: matchCount };
}

/**
 * Detect bank fee / interest keywords for Modify suggestions (spec §6b).
 *
 * `alreadyRecorded` is true when that statement line matched an existing register
 * transaction — i.e. the interest/fee is already in the books (usually because
 * statement lines are auto-imported). The frontend uses this to pre-fill the
 * Interest Earned / Service Charge fields ONLY when the amount is NOT already
 * recorded, so it never double-counts an interest line that is already a txn.
 */
export function suggestFeeInterest(statementLines) {
  let serviceCharge = null;
  let interestEarned = null;
  for (const line of statementLines || []) {
    const desc = String(line.description || '').toLowerCase();
    const amt = Math.abs(round2(line.amount));
    const alreadyRecorded = line.matchStatus === 'matched' || !!line.matchedGlId;
    if (/service charge|monthly fee|maintenance fee|overdraft fee/.test(desc)) {
      serviceCharge = { amount: amt, date: line.date, description: line.description, alreadyRecorded };
    }
    if (/interest earned|interest paid|interest payment|interest credit|cd interest/.test(desc) && line.amount > 0) {
      interestEarned = { amount: amt, date: line.date, description: line.description, alreadyRecorded };
    }
  }
  return { serviceCharge, interestEarned };
}
