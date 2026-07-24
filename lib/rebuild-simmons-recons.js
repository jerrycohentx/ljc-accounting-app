/**
 * Rebuild Simmons (1000) reconciliations from statement PDF lines.
 * January/February statements are dated the 1st of the next month (periodEnd
 * 2026-02-01 covers January). Do not treat those as stubs.
 */

import fs from 'fs';
import path from 'path';
import { RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';
import {
  closeBankReconciliation,
  reopenBankReconciliation,
  ensureBankReconSessionTables,
  signedGlDelta,
} from './bank-reconcile-session.js';
import { normalizeIsoDate } from './bank-statement-view.js';
import { toCents } from './reconcile-calc.js';
import { statementCoversMonth } from './period-integrity.js';

const ENTITY_ID = 'ent-ljc';
const BANK_ACCT = '1000';

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function signedStatementAmount(t) {
  const abs = Math.abs(Number(t.amount) || 0);
  if (t.isCredit === true) return abs;
  if (t.isCredit === false) return -abs;
  return Number(t.amount) || 0;
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

function preferLabel(description) {
  const d = String(description || '');
  if (/^Bank:/i.test(d)) return 3;
  if (/Statement import|PDF/i.test(d)) return 2;
  if (/OFX Import|Plaid/i.test(d)) return 0;
  return 1;
}

export function loadSimmonsStatements(rootDir = process.cwd()) {
  const p = path.join(rootDir, 'data/bank-imports/LJC/simmons-2026-statements.json');
  if (!fs.existsSync(p)) return [];
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return raw.statements || [];
}

/**
 * Match uncleared GL lines to statement PDF rows (date + signed cents),
 * dropping OFX twins when a higher-preference row exists.
 */
export async function selectSimmonsClearedIds(db, {
  entityId,
  accountId,
  normalBalance,
  statementDate,
  beginningBalance,
  endingBalance,
  statementTxns = [],
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
      prefer: preferLabel(row.je_description || row.description),
      used: false,
    });
  }

  // Drop OFX twin when a Bank:/PDF row exists for same date+cents.
  const preferKeys = new Set(
    candidates.filter((c) => c.prefer >= 2).map((c) => `${c.date}|${c.cents}`)
  );
  const filtered = candidates.filter((c) => {
    if (c.prefer >= 1) return true;
    return !preferKeys.has(`${c.date}|${c.cents}`);
  });

  const needCents = toCents(endingBalance) - toCents(beginningBalance);
  const picked = [];

  if (statementTxns?.length) {
    const pool = [...filtered];
    for (const t of statementTxns) {
      const date = normalizeIsoDate(t.date);
      const cents = Math.round(signedStatementAmount(t) * 100);
      // Prefer highest-label match for this date+cents
      let bestIdx = -1;
      let bestPrefer = -1;
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i];
        if (c.used || c.date !== date || c.cents !== cents) continue;
        if (c.prefer > bestPrefer) {
          bestPrefer = c.prefer;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) continue;
      pool[bestIdx].used = true;
      picked.push(pool[bestIdx].id);
    }
    const sumPicked = filtered
      .filter((c) => picked.includes(c.id))
      .reduce((s, c) => s + c.cents, 0);
    if (sumPicked === needCents && picked.length) {
      return {
        glIds: picked,
        matched: 'statement-lines',
        needCents,
        lineCount: picked.length,
      };
    }
    // Partial statement match — do not run exponential subset (OOM on Render).
    return {
      glIds: [],
      matched: null,
      needCents,
      lineCount: 0,
      candidates: filtered.length,
      statementMatched: picked.length,
      statementMatchedCents: sumPicked,
      statementTxnCount: statementTxns.length,
    };
  }

  // No statement PDF rows — chronological greedy only (no subset-sum).
  let running = 0;
  const greedy = [];
  const ordered = [...filtered].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return b.prefer - a.prefer;
  });
  for (const c of ordered) {
    running += c.cents;
    greedy.push(c.id);
    if (running === needCents) {
      return { glIds: greedy, matched: 'greedy', needCents, lineCount: greedy.length };
    }
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

function coverMonthKey(statementDate) {
  const iso = normalizeIsoDate(statementDate);
  const [y, m, d] = iso.split('-').map(Number);
  let cy = y;
  let cm = m;
  if (d === 1) {
    cm -= 1;
    if (cm < 1) {
      cm = 12;
      cy -= 1;
    }
  }
  return `${cy}-${String(cm).padStart(2, '0')}`;
}

export async function rebuildSimmonsRecons(db, {
  entityId = ENTITY_ID,
  userId = 'usr-admin',
  throughMonth = '2026-03',
  reopen = true,
  rootDir = process.cwd(),
} = {}) {
  await ensureBankReconSessionTables(db);
  const acc = await db.get(
    `SELECT id, normal_balance FROM accounts WHERE entity_id = ? AND account_number = ?`,
    [entityId, BANK_ACCT]
  );
  if (!acc) throw new Error('Account 1000 not found');

  const targets = (RECONCILIATION_TARGETS[entityId]?.[BANK_ACCT] || []).filter(
    (t) => coverMonthKey(t.statementDate) <= throughMonth
  );
  const statements = loadSimmonsStatements(rootDir);

  // Mis-dated calendar month-end sessions (e.g. 01-31 / 02-28) duplicate the
  // real 1st-of-month statement closes — drop only those extras.
  const targetDates = new Set(targets.map((t) => normalizeIsoDate(t.statementDate)));
  const extras = await db.all(
    `SELECT id, statement_date FROM bank_reconciliation_sessions
     WHERE entity_id = ? AND account_id = ?
       AND statement_date IN ('2026-01-31', '2026-02-28')`,
    [entityId, acc.id]
  );
  const droppedExtras = [];
  for (const row of extras || []) {
    const iso = normalizeIsoDate(row.statement_date);
    if (targetDates.has(iso)) continue;
    // Unreconcile GL first — deleting the session alone leaves orphan RECONCILED lines.
    await reopenBankReconciliation(db, {
      entityId,
      accountId: acc.id,
      statementDate: iso,
    });
    await db.run(`DELETE FROM bank_reconciliation_session_lines WHERE session_id = ?`, [row.id]);
    await db.run(`DELETE FROM bank_reconciliation_sessions WHERE id = ?`, [row.id]);
    droppedExtras.push(iso);
  }

  const reopenResults = [];
  if (reopen) {
    for (const target of [...targets].reverse()) {
      try {
        reopenResults.push({
          statementDate: target.statementDate,
          ...(await reopenBankReconciliation(db, {
            entityId,
            accountId: acc.id,
            statementDate: target.statementDate,
          })),
        });
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
    const begin =
      stmt?.meta?.previousBalance != null
        ? round2(stmt.meta.previousBalance)
        : round2(
            (
              await db.get(
                `SELECT beginning_balance FROM bank_reconciliation_sessions
                 WHERE entity_id = ? AND account_id = ? AND statement_date = ?`,
                [entityId, acc.id, target.statementDate]
              )
            )?.beginning_balance ?? 0
          );

    const pick = await selectSimmonsClearedIds(db, {
      entityId,
      accountId: acc.id,
      normalBalance: acc.normal_balance,
      statementDate: target.statementDate,
      beginningBalance: begin,
      endingBalance: target.endingBalance,
      statementTxns: stmt?.transactions || [],
      clearedAfterDate: prevStatementDate,
    });

    if (!pick.glIds?.length) {
      results.push({
        statementDate: target.statementDate,
        begin,
        endingBalance: target.endingBalance,
        reconciled: false,
        pick,
        message: 'Could not match statement lines to GL — skipped auto subset (OOM-safe)',
      });
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
        notes: `Rebuild Simmons ${target.label || target.statementDate} from statement lines`,
        beginningBalanceOverride: begin,
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
    } catch (err) {
      results.push({
        statementDate: target.statementDate,
        begin,
        endingBalance: target.endingBalance,
        reconciled: false,
        matched: pick.matched,
        lineCount: pick.lineCount,
        error: err.message,
        code: err.code || null,
      });
    }
  }

  return { throughMonth, droppedExtras, reopenResults, results };
}

export { statementCoversMonth };
