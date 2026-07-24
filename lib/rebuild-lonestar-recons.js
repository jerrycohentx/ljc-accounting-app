/**
 * Rebuild Lone Star (1001) reconciliations from live, non-reversed GL lines
 * that match each statement. Prior closes often locked reversed duplicate JEs
 * so reports (which skip reversals) showed Cleared ≠ statement ending.
 */

import { loadLonestarStatements } from './lonestar-catchup.js';
import {
  autoReconcileToTarget,
  reopenBankReconciliation,
  closeBankReconciliation,
  getBeginningBalance,
  ensureBankReconSessionTables,
  signedGlDelta,
} from './bank-reconcile-session.js';
import { RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';
import { normalizeIsoDate } from './bank-statement-view.js';
import { toCents } from './reconcile-calc.js';

const ENTITY_ID = 'ent-ljc';
const BANK_ACCT = '1001';

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function isNoiseJe(jeNumber, description) {
  const j = String(jeNumber || '');
  const d = String(description || '');
  if (/^REV-/i.test(j)) return true;
  if (/^TRUEUP-/i.test(j)) return true;
  if (/^OB-/i.test(j)) return true;
  if (/^RESTORE-/i.test(j)) return true;
  if (/Reversal:/i.test(d)) return true;
  return false;
}

function preferBankLabel(description) {
  const d = String(description || '');
  if (/^Bank:/i.test(d)) return 3;
  if (/Lone Star checking interest/i.test(d)) return 3;
  if (/Interest paid/i.test(d)) return 2;
  if (/OFX Import/i.test(d)) return 0;
  return 1;
}

/** Meet-in-the-middle subset sum (cents). Caps at 40 items. */
function findSubsetSumCents(items, needCents) {
  if (!items.length) return needCents === 0 ? [] : null;
  let list = items.filter((i) => i.cents !== 0);
  if (list.length > 40) {
    list = [...list].sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents)).slice(0, 40);
  }
  const mid = Math.floor(list.length / 2);
  const left = list.slice(0, mid);
  const right = list.slice(mid);
  const enumHalf = (half) => {
    const map = new Map();
    const m = half.length;
    for (let mask = 0; mask < 1 << m; mask++) {
      let sum = 0;
      const ids = [];
      for (let i = 0; i < m; i++) {
        if (mask & (1 << i)) {
          sum += half[i].cents;
          ids.push(half[i].id);
        }
      }
      if (!map.has(sum)) map.set(sum, ids);
    }
    return map;
  };
  const L = enumHalf(left);
  const R = enumHalf(right);
  for (const [sumL, idsL] of L) {
    const needR = needCents - sumL;
    if (R.has(needR)) return [...idsL, ...R.get(needR)];
  }
  return null;
}

/**
 * Pick uncleared posted lines for one statement period that sum to
 * ending − beginning, preferring statement PDF ("Bank:") rows over OFX twins.
 */
export async function selectLonestarClearedIds(db, {
  entityId,
  accountId,
  normalBalance,
  statementDate,
  beginningBalance,
  endingBalance,
  clearedAfterDate = null,
}) {
  const stmtIso = normalizeIsoDate(statementDate);
  const priorIso = clearedAfterDate ? normalizeIsoDate(clearedAfterDate) : null;
  const params = [entityId, accountId, stmtIso];
  let sql = `
    SELECT gl.id, gl.debit, gl.credit, gl.posting_date, gl.description,
           je.je_number, je.description AS je_description
    FROM general_ledger gl
    JOIN journal_entries je ON je.id = gl.journal_entry_id
    WHERE gl.entity_id = ? AND gl.account_id = ?
      AND gl.reconciliation_status IS NULL
      AND je.status = 'POSTED'
      AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
      AND gl.posting_date <= ?`;
  if (priorIso) {
    sql += ' AND gl.posting_date > ?';
    params.push(priorIso);
  }
  sql += ' ORDER BY gl.posting_date ASC, gl.created_at ASC';

  const raw = await db.all(sql, params);
  const candidates = [];
  for (const row of raw || []) {
    if (isNoiseJe(row.je_number, row.je_description || row.description)) continue;
    const signed = round2(signedGlDelta(row, normalBalance).toNumber());
    if (Math.abs(signed) < 0.005) continue;
    candidates.push({
      id: row.id,
      signed,
      cents: Math.round(signed * 100),
      date: normalizeIsoDate(row.posting_date),
      description: row.je_description || row.description || '',
      prefer: preferBankLabel(row.je_description || row.description),
    });
  }

  const bankKeys = new Set(
    candidates.filter((c) => c.prefer >= 3).map((c) => `${c.date}|${c.cents}`)
  );
  const filtered = candidates.filter((c) => {
    if (c.prefer >= 1) return true;
    return !bankKeys.has(`${c.date}|${c.cents}`);
  });

  const needCents = toCents(endingBalance) - toCents(beginningBalance);
  const ordered = [...filtered].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return b.prefer - a.prefer;
  });

  let running = 0;
  const picked = [];
  for (const c of ordered) {
    running += c.cents;
    picked.push(c.id);
    if (running === needCents) {
      return { glIds: picked, matched: 'greedy', needCents, lineCount: picked.length };
    }
  }

  const subset = findSubsetSumCents(
    filtered.map((c) => ({ id: c.id, cents: c.cents })),
    needCents
  );
  if (subset) {
    return { glIds: subset, matched: 'subset', needCents, lineCount: subset.length };
  }

  return {
    glIds: [],
    matched: null,
    needCents,
    lineCount: 0,
    candidates: filtered.length,
    runningFromCents: running,
  };
}

export async function rebuildLonestarRecons(db, {
  entityId = ENTITY_ID,
  userId = 'usr-admin',
  throughMonth = '2026-05',
  reopen = true,
  rootDir = process.cwd(),
} = {}) {
  await ensureBankReconSessionTables(db);
  const acc = await db.get(
    `SELECT id, normal_balance FROM accounts WHERE entity_id = ? AND account_number = ?`,
    [entityId, BANK_ACCT]
  );
  if (!acc) throw new Error('Account 1001 not found');

  const targets = (RECONCILIATION_TARGETS[entityId]?.[BANK_ACCT] || []).filter(
    (t) => String(t.statementDate || '').slice(0, 7) <= throughMonth
  );
  const statements = loadLonestarStatements(rootDir);

  const reopenResults = [];
  if (reopen) {
    for (const target of [...targets].reverse()) {
      try {
        const r = await reopenBankReconciliation(db, {
          entityId,
          accountId: acc.id,
          statementDate: target.statementDate,
        });
        reopenResults.push({ statementDate: target.statementDate, ...r });
      } catch (e) {
        reopenResults.push({ statementDate: target.statementDate, reopenError: e.message });
      }
    }
  }

  const results = [];
  let prevStatementDate = '2025-12-31';
  for (const target of targets) {
    const stmt = statements.find(
      (s) => normalizeIsoDate(s.meta?.periodEnd) === normalizeIsoDate(target.statementDate)
    );
    const beginningFromStmt =
      stmt?.meta?.previousBalance != null ? round2(stmt.meta.previousBalance) : null;

    const existing = await db.get(
      `SELECT beginning_balance FROM bank_reconciliation_sessions
       WHERE entity_id = ? AND account_id = ? AND statement_date = ?`,
      [entityId, acc.id, target.statementDate]
    );
    let begin =
      existing && Math.abs(Number(existing.beginning_balance) || 0) >= 0.01
        ? round2(existing.beginning_balance)
        : beginningFromStmt;
    if (begin == null) {
      begin = await getBeginningBalance(
        db,
        entityId,
        acc.id,
        target.statementDate,
        acc.normal_balance
      );
    }

    const pick = await selectLonestarClearedIds(db, {
      entityId,
      accountId: acc.id,
      normalBalance: acc.normal_balance,
      statementDate: target.statementDate,
      beginningBalance: begin,
      endingBalance: target.endingBalance,
      clearedAfterDate: prevStatementDate,
    });

    if (!pick.glIds?.length) {
      const r = await autoReconcileToTarget(db, {
        entityId,
        accountNumber: BANK_ACCT,
        statementDate: target.statementDate,
        endingBalance: target.endingBalance,
        userId,
        notes: `Rebuild Lone Star ${target.statementDate} (auto fallback)`,
        clearedAfterDate: prevStatementDate,
        beginningBalanceOverride: begin,
      });
      results.push({ statementDate: target.statementDate, begin, pick, ...r });
      if (r.reconciled) prevStatementDate = target.statementDate;
      continue;
    }

    try {
      const closed = await closeBankReconciliation(db, {
        entityId,
        accountId: acc.id,
        glIds: pick.glIds,
        statementDate: target.statementDate,
        statementEndingBalance: target.endingBalance,
        userId,
        notes: `Rebuild Lone Star ${target.label || target.statementDate} from statement lines`,
      });
      results.push({
        statementDate: target.statementDate,
        begin,
        endingBalance: target.endingBalance,
        reconciled: true,
        matched: pick.matched,
        lineCount: pick.lineCount,
        sessionId: closed.sessionId,
        skipped: closed.skipped || false,
      });
      prevStatementDate = target.statementDate;
    } catch (e) {
      results.push({
        statementDate: target.statementDate,
        begin,
        endingBalance: target.endingBalance,
        reconciled: false,
        pick,
        error: e.message,
        details: e.details || null,
      });
    }
  }

  // Drop bogus June Lonestar session (wrong begin/end from H1 shortcut).
  const june = await db.get(
    `SELECT id FROM bank_reconciliation_sessions
     WHERE entity_id = ? AND account_id = ? AND statement_date = '2026-06-30'`,
    [entityId, acc.id]
  );
  if (june) {
    await db.run('DELETE FROM bank_reconciliation_session_lines WHERE session_id = ?', [june.id]);
    await db.run('DELETE FROM bank_reconciliation_sessions WHERE id = ?', [june.id]);
  }

  return { reopenResults, results, droppedJuneStub: !!june };
}
