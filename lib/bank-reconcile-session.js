import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { getBankStatementView, peekBundledStatement, normalizeIsoDate } from './bank-statement-view.js';
import { matchStatementToRegister, persistImportAutoMatches, suggestFeeInterest } from './reconcile-auto-match.js';
import { computeReconcileTotals, sumClearedBySide, toCents } from './reconcile-calc.js';
import { postReconcileFees } from './reconcile-fees.js';

async function reopenSessionGl(db, sessionId) {
  await db.run(
    `UPDATE general_ledger SET reconciliation_status = NULL, reconciliation_session_id = NULL
     WHERE reconciliation_session_id = ?`,
    [sessionId]
  );
}

async function repairInvalidClosedSessions(db) {
  const invalid = await db.all(
    `SELECT id FROM bank_reconciliation_sessions
     WHERE status = 'CLOSED' AND ABS(difference) >= 0.01`
  );
  for (const row of invalid || []) {
    await reopenSessionGl(db, row.id);
    await db.run(
      `UPDATE bank_reconciliation_sessions
       SET status = 'OPEN', closed_at = NULL
       WHERE id = ?`,
      [row.id]
    );
  }
}

function sessionDisplay(session, clearedCount) {
  const difference = round2(session.difference);
  const balanced = session.status === 'CLOSED' && Math.abs(difference) < 0.01;
  const displayStatus = balanced ? 'CLOSED' : 'OPEN';
  return {
    statementDate: session.statement_date,
    status: displayStatus,
    endingBalance: round2(session.ending_balance),
    difference,
    clearedCount,
    balanced,
    notes: session.notes || null,
  };
}

export async function ensureBankReconSessionTables(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS bank_reconciliation_sessions (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      statement_date DATE NOT NULL,
      beginning_balance DECIMAL(19,2) NOT NULL,
      ending_balance DECIMAL(19,2) NOT NULL,
      cleared_net DECIMAL(19,2) DEFAULT 0,
      difference DECIMAL(19,2) DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'CLOSED')),
      notes TEXT,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMP,
      UNIQUE(entity_id, account_id, statement_date)
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS bank_reconciliation_session_lines (
      session_id TEXT NOT NULL,
      gl_id TEXT NOT NULL,
      PRIMARY KEY (session_id, gl_id),
      FOREIGN KEY(session_id) REFERENCES bank_reconciliation_sessions(id) ON DELETE CASCADE
    )
  `);
  try {
    await db.run('ALTER TABLE general_ledger ADD COLUMN reconciliation_session_id TEXT');
  } catch (e) {
    if (!/duplicate column|already exists/i.test(e.message)) throw e;
  }
  await repairInvalidClosedSessions(db);
}

export function signedGlDelta(entry, normalBalance) {
  const d = new Decimal(entry.debit || 0);
  const c = new Decimal(entry.credit || 0);
  return normalBalance === 'CREDIT' ? c.minus(d) : d.minus(c);
}

/** PDF-imported statements may not tie — still refuse close unless exact $0.00. */
const RECON_CLOSE_TOLERANCE = 0;

/** Beginning balance = prior CLOSED session ending, else reconciled GL, else statement previous balance. */
export async function getBeginningBalance(db, entityId, accountId, statementDate, normalBalance) {
  const prior = await db.get(
    `SELECT ending_balance FROM bank_reconciliation_sessions
     WHERE entity_id = ? AND account_id = ? AND status = 'CLOSED'
       AND statement_date < ?
     ORDER BY statement_date DESC LIMIT 1`,
    [entityId, accountId, statementDate]
  );
  if (prior) return round2(prior.ending_balance);

  const expr = normalBalance === 'CREDIT' ? '(gl.credit - gl.debit)' : '(gl.debit - gl.credit)';
  const row = await db.get(
    `SELECT COALESCE(SUM(${expr}), 0) AS bal
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id AND je.status = 'POSTED'
     WHERE gl.entity_id = ? AND gl.account_id = ?
       AND gl.reconciliation_status = 'RECONCILED'
       AND gl.posting_date < ?`,
    [entityId, accountId, statementDate]
  );
  const reconciledBal = round2(row?.bal || 0);
  if (Math.abs(reconciledBal) >= 0.01) return reconciledBal;

  const account = await db.get(
    'SELECT account_number FROM accounts WHERE id = ? AND entity_id = ?',
    [accountId, entityId]
  );
  const bundled = account?.account_number
    ? peekBundledStatement(account.account_number, statementDate)
    : null;
  if (bundled?.meta?.previousBalance != null) {
    return round2(bundled.meta.previousBalance);
  }

  return reconciledBal;
}

export async function getSessionForPeriod(db, entityId, accountId, statementDate) {
  return db.get(
    `SELECT * FROM bank_reconciliation_sessions
     WHERE entity_id = ? AND account_id = ? AND statement_date = ?`,
    [entityId, accountId, statementDate]
  );
}

export async function getPriorClosedSession(db, entityId, accountId, statementDate) {
  return db.get(
    `SELECT * FROM bank_reconciliation_sessions
     WHERE entity_id = ? AND account_id = ? AND status = 'CLOSED'
       AND statement_date < ?
     ORDER BY statement_date DESC LIMIT 1`,
    [entityId, accountId, statementDate]
  );
}

/** Most recent balanced/closed reconciliation for an account (no date bound). */
export async function getLastClosedSession(db, entityId, accountId) {
  await ensureBankReconSessionTables(db);
  return db.get(
    `SELECT * FROM bank_reconciliation_sessions
     WHERE entity_id = ? AND account_id = ? AND status = 'CLOSED'
       AND ABS(difference) < 0.01
     ORDER BY statement_date DESC LIMIT 1`,
    [entityId, accountId]
  );
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Meet-in-the-middle subset sum for small n (cents). Returns matching ids or null.
 * Caps at 40 items (2^20 meet-in-middle); if larger, takes the 40 largest |cents|.
 */
function findSubsetSumCents(items, needCents) {
  if (!items.length) return needCents === 0 ? [] : null;
  let list = items.filter((i) => i.cents !== 0);
  if (list.length > 40) {
    list = [...list].sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents)).slice(0, 40);
  }
  const n = list.length;
  const mid = Math.floor(n / 2);
  const left = list.slice(0, mid);
  const right = list.slice(mid);

  const enumHalf = (half) => {
    const map = new Map(); // sum -> ids
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

export async function buildWorksheet(db, {
  entityId,
  accountId,
  statementDate,
  autoMatch = false,
  userId = null,
}) {
  await ensureBankReconSessionTables(db);

  const account = await db.get(
    `SELECT id, account_number, account_name, normal_balance FROM accounts WHERE id = ? AND entity_id = ?`,
    [accountId, entityId]
  );
  if (!account) throw new Error('Account not found');

  const session = await getSessionForPeriod(db, entityId, accountId, statementDate);
  const beginningBalance = await getBeginningBalance(
    db,
    entityId,
    accountId,
    statementDate,
    account.normal_balance
  );

  let periodSession = null;
  if (session) {
    periodSession = sessionDisplay(session, await countSessionLines(db, session.id));
  } else {
    const orphanReconciled = await db.get(
      `SELECT COUNT(*) AS c FROM general_ledger gl
       WHERE gl.entity_id = ? AND gl.account_id = ?
         AND gl.reconciliation_status = 'RECONCILED'
         AND gl.reconciliation_session_id IS NULL
         AND gl.posting_date <= ?`,
      [entityId, accountId, statementDate]
    );
    if (orphanReconciled?.c > 0) {
      periodSession = {
        statementDate: statementDate.slice(0, 7),
        status: 'OPEN',
        orphanReconciled: orphanReconciled.c,
        balanced: false,
        clearedCount: orphanReconciled.c,
        message: 'Legacy cleared lines without a balanced session — reopen required',
      };
    }
  }

  const priorClosedRow = await getPriorClosedSession(db, entityId, accountId, statementDate);
  let priorClosedSession = null;
  if (priorClosedRow && Math.abs(priorClosedRow.difference) < 0.01) {
    priorClosedSession = sessionDisplay(
      priorClosedRow,
      await countSessionLines(db, priorClosedRow.id)
    );
  }

  const displayStatus = periodSession?.status || (priorClosedSession ? 'NONE' : 'NONE');
  const sessionDifference = periodSession?.difference ?? null;

  let statementView = await getBankStatementView(db, {
    entityId,
    accountId,
    accountNumber: account.account_number,
    statementDate,
  });

  const stmtMeta = statementView.meta || {};
  // Cutoff for which posted transactions appear in the reconcile = the LATER of the
  // requested statement date and the bundled statement's periodEnd. A stale or
  // mismatched bundled statement (e.g. a leftover periodEnd earlier than the month
  // being reconciled) must not hide posted transactions dated through the requested
  // reconcile date.
  const effectiveAsOf = [statementDate, stmtMeta.periodEnd].filter(Boolean).sort().pop() || statementDate;

  // NO upper date bound, deliberately.
  //
  // Reconciliation clears ITEMS. The date the BOOK gave an item does not decide
  // whether the STATEMENT cleared it. Card issuers credit a payment 2-4 days
  // before the bank settles it, and the books date card payments by bank date --
  // so every cycle has items the statement cleared inside the period that the
  // book dates after the statement date (AMEX credited a $2,500 payment 01/09;
  // Simmons settled it 1/13). Capping this fetch at the statement date hid those
  // rows outright, so the card could not be reconciled to its own statement
  // without inventing bridge entries -- the wrong fix.
  //
  // It also made the "Hide transactions after the statement's end date" checkbox
  // a lie: it can only hide rows, never reveal them, so unchecking it did
  // nothing while the server had already withheld the data. That limiter is a
  // VIEW preference (frontend, default on, per-user) -- not a rule the data
  // layer gets to enforce.
  //
  // Safe for auto-match: matchStatementToRegister keys on exact journal id or
  // exact (date, signed amount), never date proximity, so a later-dated entry
  // cannot false-match a line in this cycle.
  const entries = await db.all(
    `SELECT gl.id, gl.journal_entry_id, gl.posting_date, gl.debit, gl.credit, gl.description, gl.reconciliation_status,
            je.je_number, je.description AS je_description
     FROM general_ledger gl
     JOIN journal_entries je ON gl.journal_entry_id = je.id
     WHERE gl.entity_id = ? AND gl.account_id = ?
       AND je.status = 'POSTED'
       AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
       AND gl.reconciliation_status IS NULL
       AND je.je_number NOT LIKE 'OB-%'
     ORDER BY gl.posting_date ASC`,
    [entityId, accountId]
  );

  if (autoMatch && userId) {
    await persistImportAutoMatches(db, {
      entityId,
      accountId,
      asOfDate: effectiveAsOf,
      userId,
    });
    statementView = await getBankStatementView(db, {
      entityId,
      accountId,
      accountNumber: account.account_number,
      statementDate: effectiveAsOf,
    });
  }

  const stmtMetaFinal = statementView.meta || stmtMeta;
  // A reconciled prior period is the authoritative beginning for this one — it
  // must roll from the prior CLOSED session's ending (getBeginningBalance), NOT
  // from the bundled statement's previousBalance (which can be stale/wrong and
  // would otherwise break the month-to-month roll-forward).
  const displayBeginning = priorClosedSession
    ? beginningBalance
    : (stmtMetaFinal.previousBalance != null ? round2(stmtMetaFinal.previousBalance) : beginningBalance);
  const suggestedEnding = stmtMetaFinal.currentBalance != null
    ? round2(stmtMetaFinal.currentBalance)
    : (session?.ending_balance != null ? round2(session.ending_balance) : null);

  const autoMatchResult = matchStatementToRegister({
    statementLines: statementView.lines,
    entries: entries || [],
    normalBalance: account.normal_balance,
  });

  const feeSuggestions = suggestFeeInterest(autoMatchResult.statementLines);

  // Lines already reconciled in THIS period's session. The main `entries` query only
  // returns un-reconciled (status IS NULL) lines, so for a CLOSED/balanced period those
  // cleared lines would otherwise be invisible and uncounted — making the on-screen
  // Cleared Balance and Difference wrong (e.g. shows the net change as a difference).
  // Return them flagged + pre-checked so a reopened/closed reconciliation displays
  // balanced at $0.00 with the cleared items checked (QuickBooks Desktop behavior).
  let reconciledEntries = [];
  if (session) {
    reconciledEntries = await db.all(
      `SELECT gl.id, gl.journal_entry_id, gl.posting_date, gl.debit, gl.credit, gl.description,
              gl.reconciliation_status, je.je_number, je.description AS je_description
       FROM general_ledger gl
       JOIN journal_entries je ON gl.journal_entry_id = je.id
       WHERE gl.entity_id = ? AND gl.account_id = ?
         AND je.status = 'POSTED'
         AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
         AND gl.reconciliation_status = 'RECONCILED'
         AND gl.reconciliation_session_id = ?
         AND gl.posting_date <= ?
       ORDER BY gl.posting_date ASC`,
      [entityId, accountId, session.id, effectiveAsOf]
    );
  }
  const reconciledDecorated = reconciledEntries.map((e) => ({
    ...e,
    clearState: 'reconciled',
    matchedStatementLineId: null,
    matchConfidence: null,
    alreadyReconciled: true,
  }));
  const reconciledGlIds = reconciledDecorated.map((e) => e.id);
  const mergedEntries = [...autoMatchResult.entries, ...reconciledDecorated]
    .sort((a, b) => String(a.posting_date).localeCompare(String(b.posting_date)));
  const mergedCheckedGlIds = [
    ...new Set([...(autoMatchResult.suggestedCheckedGlIds || []), ...reconciledGlIds]),
  ];

  return {
    account,
    statementDate: stmtMetaFinal.periodEnd || effectiveAsOf,
    beginningBalance,
    displayBeginning,
    endingBalance: session?.ending_balance != null ? round2(session.ending_balance) : suggestedEnding,
    suggestedEndingBalance: suggestedEnding,
    sessionStatus: periodSession?.status || displayStatus,
    sessionDifference,
    periodSession,
    priorClosedSession,
    priorSession: periodSession,
    statementPeriod: {
      periodStart: statementView.period?.periodStart || stmtMeta.periodStart,
      periodEnd: stmtMetaFinal.periodEnd || statementView.period?.periodEnd || effectiveAsOf,
    },
    statementMeta: statementView.meta,
    statementLines: autoMatchResult.statementLines,
    entries: mergedEntries,
    suggestedCheckedGlIds: mergedCheckedGlIds,
    reconciledGlIds,
    feeSuggestions,
    autoMatch: {
      matchedStmtCount: autoMatchResult.matchedStmtCount,
      needsReviewCount: autoMatchResult.needsReviewCount,
      totalStmtLines: autoMatchResult.totalStmtLines,
      unmatchedStmtCount: autoMatchResult.unmatchedStmtLines.length,
      unmatchedRegisterCount: autoMatchResult.unmatchedRegisterIds.length,
      reviewSummary: autoMatchResult.reviewSummary,
      pairs: autoMatchResult.pairs.slice(0, 50),
    },
  };
}

async function countSessionLines(db, sessionId) {
  const row = await db.get(
    'SELECT COUNT(*) AS c FROM bank_reconciliation_session_lines WHERE session_id = ?',
    [sessionId]
  );
  return row?.c || 0;
}

/**
 * Close a bank reconciliation — refuses unless difference is zero.
 */
export async function closeBankReconciliation(db, {
  entityId,
  accountId,
  glIds,
  statementDate,
  statementEndingBalance,
  userId,
  notes = null,
  serviceCharge = 0,
  interestEarned = 0,
  serviceChargeAccountId = null,
  interestAccountId = null,
  serviceChargeDate = null,
  interestDate = null,
}) {
  await ensureBankReconSessionTables(db);

  if (!Array.isArray(glIds)) {
    throw new Error('glIds[] required');
  }
  if (statementEndingBalance == null || Number.isNaN(Number(statementEndingBalance))) {
    throw new Error('Statement ending balance is required');
  }

  const account = await db.get(
    'SELECT id, account_number, normal_balance FROM accounts WHERE id = ? AND entity_id = ?',
    [accountId, entityId]
  );
  if (!account) throw new Error('Account not found');

  const existing = await getSessionForPeriod(db, entityId, accountId, statementDate);
  if (existing?.status === 'CLOSED' && Math.abs(existing.difference) < 0.01) {
    return { skipped: true, reason: 'already closed balanced', sessionId: existing.id };
  }

  const beginningBalance = await getBeginningBalance(
    db,
    entityId,
    accountId,
    statementDate,
    account.normal_balance
  );

  // Empty clear list is allowed only when books already match the statement
  // (typical cutover / dormant month: beginning == ending, nothing to clear).
  if (glIds.length === 0) {
    if (toCents(beginningBalance) !== toCents(statementEndingBalance)) {
      throw new Error(
        'Select at least one cleared transaction (or set statement ending equal to beginning balance for a $0-activity close)'
      );
    }
  }

  let clearedRows = [];
  if (glIds.length > 0) {
    const placeholders = glIds.map(() => '?').join(',');
    clearedRows = await db.all(
      `SELECT gl.id, gl.debit, gl.credit, gl.reconciliation_status
       FROM general_ledger gl
       JOIN journal_entries je ON je.id = gl.journal_entry_id
       WHERE gl.id IN (${placeholders}) AND gl.entity_id = ? AND gl.account_id = ?
         AND je.status = 'POSTED' AND gl.reconciliation_status IS NULL`,
      [...glIds, entityId, accountId]
    );

    if (clearedRows.length !== glIds.length) {
      throw new Error('Some selected lines are missing, already reconciled, or not posted');
    }
  }

  const sideTotals = sumClearedBySide(clearedRows, account, glIds, account.normal_balance);
  const calc = computeReconcileTotals({
    beginningBalance,
    serviceCharge,
    interestEarned,
    markedDeposits: sideTotals.markedDeposits,
    markedPayments: sideTotals.markedPayments,
    endingBalance: statementEndingBalance,
  });
  const difference = calc.difference;
  const clearedNet = round2(calc.clearedBalance - beginningBalance);

  if (!calc.balanced) {
    const sessionId = existing?.id || `brs-${uuidv4()}`;
    if (!existing) {
      await db.run(
        `INSERT INTO bank_reconciliation_sessions
         (id, entity_id, account_id, statement_date, beginning_balance, ending_balance,
          cleared_net, difference, status, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
        [
          sessionId,
          entityId,
          accountId,
          statementDate,
          beginningBalance,
          round2(statementEndingBalance),
          clearedNet,
          difference,
          notes || 'Out of balance — session remains open',
          userId,
        ]
      );
    } else {
      await db.run(
        `UPDATE bank_reconciliation_sessions
         SET beginning_balance = ?, ending_balance = ?, cleared_net = ?, difference = ?,
             status = 'OPEN', notes = ?, closed_at = NULL
         WHERE id = ?`,
        [
          beginningBalance,
          round2(statementEndingBalance),
          clearedNet,
          difference,
          notes || 'Out of balance — session remains open',
          existing.id,
        ]
      );
    }

    const err = new Error(
      `Reconciliation does not balance: difference ${difference.toFixed(2)}. Session stays open until cleared to $0.00.`
    );
    err.code = 'RECON_OUT_OF_BALANCE';
    err.details = {
      beginningBalance,
      clearedNet: clearedNet,
      computedEnding: calc.clearedBalance,
      statementEndingBalance: round2(statementEndingBalance),
      difference,
      sessionId: existing?.id || sessionId,
      status: 'OPEN',
    };
    throw err;
  }

  const sessionId = existing?.id || `brs-${uuidv4()}`;

  if (existing) {
    await db.run('DELETE FROM bank_reconciliation_session_lines WHERE session_id = ?', [sessionId]);
    await reopenSessionGl(db, sessionId);
  }

  if (!existing) {
    await db.run(
      `INSERT INTO bank_reconciliation_sessions
       (id, entity_id, account_id, statement_date, beginning_balance, ending_balance,
        cleared_net, difference, status, notes, created_by, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'CLOSED', ?, ?, CURRENT_TIMESTAMP)`,
      [
        sessionId,
        entityId,
        accountId,
        statementDate,
        beginningBalance,
        round2(statementEndingBalance),
        clearedNet,
        notes,
        userId,
      ]
    );
  } else {
    await db.run(
      `UPDATE bank_reconciliation_sessions
       SET beginning_balance = ?, ending_balance = ?, cleared_net = ?, difference = 0,
           status = 'CLOSED', notes = ?, closed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        beginningBalance,
        round2(statementEndingBalance),
        clearedNet,
        notes,
        sessionId,
      ]
    );
  }

  for (const row of clearedRows) {
    await db.run(
      `UPDATE general_ledger SET reconciliation_status = 'RECONCILED', reconciliation_session_id = ?
       WHERE id = ? AND entity_id = ?`,
      [sessionId, row.id, entityId]
    );
    await db.run(
      'INSERT OR IGNORE INTO bank_reconciliation_session_lines (session_id, gl_id) VALUES (?, ?)',
      [sessionId, row.id]
    );
  }

  // QuickBooks-style: post the service charge / interest entered in the Begin
  // dialog as real transactions and clear them with this session. They are
  // already represented in the difference via the serviceCharge / interestEarned
  // terms, so they are not added to the cleared side totals (no double count).
  const fees = await postReconcileFees(db, {
    entityId,
    accountId,
    accountNumber: account.account_number,
    statementDate,
    serviceCharge,
    interestEarned,
    serviceChargeAccountId,
    interestAccountId,
    serviceChargeDate,
    interestDate,
    userId,
  });
  for (const glId of fees.feeGlIds) {
    await db.run(
      `UPDATE general_ledger SET reconciliation_status = 'RECONCILED', reconciliation_session_id = ?
       WHERE id = ? AND entity_id = ?`,
      [sessionId, glId, entityId]
    );
    await db.run(
      'INSERT OR IGNORE INTO bank_reconciliation_session_lines (session_id, gl_id) VALUES (?, ?)',
      [sessionId, glId]
    );
  }

  return {
    sessionId,
    status: 'CLOSED',
    reconciledCount: clearedRows.length + fees.feeGlIds.length,
    serviceChargePosted: fees.serviceChargeJe ? round2(serviceCharge) : 0,
    interestPosted: fees.interestJe ? round2(interestEarned) : 0,
    beginningBalance,
    endingBalance: round2(statementEndingBalance),
    clearedNet: clearedNet,
    difference: 0,
  };
}

/** Reopen a period — clears session and unreconciles its GL lines. */
export async function reopenBankReconciliation(db, { entityId, accountId, statementDate }) {
  await ensureBankReconSessionTables(db);
  const session = await getSessionForPeriod(db, entityId, accountId, statementDate);
  if (!session) {
    await db.run(
      `UPDATE general_ledger SET reconciliation_status = NULL, reconciliation_session_id = NULL
       WHERE entity_id = ? AND account_id = ?
         AND reconciliation_status = 'RECONCILED'
         AND posting_date <= ?`,
      [entityId, accountId, statementDate]
    );
    return { reopened: true, mode: 'legacy-clear' };
  }

  await reopenSessionGl(db, session.id);
  await db.run('DELETE FROM bank_reconciliation_session_lines WHERE session_id = ?', [session.id]);
  await db.run(
    `UPDATE bank_reconciliation_sessions SET status = 'OPEN', difference = 0, closed_at = NULL WHERE id = ?`,
    [session.id]
  );
  return { reopened: true, sessionId: session.id, status: 'OPEN' };
}

/** Auto-reconcile for catch-up scripts — uses same zero-difference guard. */
export async function autoReconcileToTarget(db, {
  entityId,
  accountNumber,
  statementDate,
  endingBalance,
  userId,
  notes = null,
}) {
  await ensureBankReconSessionTables(db);
  const acc = await db.get(
    'SELECT id, normal_balance FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, accountNumber]
  );
  if (!acc) throw new Error(`Account ${accountNumber} not found`);

  const existing = await getSessionForPeriod(db, entityId, acc.id, statementDate);
  if (existing?.status === 'CLOSED' && Math.abs(Number(existing.difference) || 0) < 0.01) {
    return {
      reconciled: true,
      skipped: true,
      statementDate,
      endingBalance: round2(existing.ending_balance),
      beginningBalance: round2(existing.beginning_balance),
      clearedCount: 0,
      sessionId: existing.id,
      message: 'Already CLOSED at $0.00',
    };
  }

  const beginningBalance = await getBeginningBalance(
    db,
    entityId,
    acc.id,
    statementDate,
    acc.normal_balance
  );

  const prior = await getPriorClosedSession(db, entityId, acc.id, statementDate);
  const priorIso = normalizeIsoDate(prior?.statement_date);

  const params = [entityId, acc.id];
  let sql = `
    SELECT gl.id, gl.debit, gl.credit, gl.posting_date
    FROM general_ledger gl
    JOIN journal_entries je ON je.id = gl.journal_entry_id
    WHERE gl.entity_id = ? AND gl.account_id = ?
      AND gl.reconciliation_status IS NULL
      AND je.status = 'POSTED'
      AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
      AND je.je_number NOT LIKE 'OB-%'`;
  // Credit cards: statement may clear payments the books date a few days later.
  // Cap at statementDate+14 so later months do not flood the match.
  if (acc.normal_balance === 'CREDIT') {
    const [y, m, d] = statementDate.split('-').map(Number);
    const cap = new Date(Date.UTC(y, m - 1, d + 14));
    const capIso = cap.toISOString().slice(0, 10);
    sql += ' AND gl.posting_date <= ?';
    params.push(capIso);
  } else {
    sql += ' AND gl.posting_date <= ?';
    params.push(statementDate);
  }
  if (priorIso) {
    sql += ' AND gl.posting_date > ?';
    params.push(priorIso);
  }
  sql += ' ORDER BY gl.posting_date ASC';

  const entries = await db.all(sql, params);

  const target = new Decimal(endingBalance);
  const needed = target.minus(beginningBalance);
  const clearedIds = [];
  let running = new Decimal(beginningBalance);

  // First try chronological greedy (works when register order matches statement)
  for (const e of entries) {
    running = running.plus(signedGlDelta(e, acc.normal_balance));
    clearedIds.push(e.id);
    if (running.minus(target).abs().lt(0.02)) break;
  }

  if (running.minus(target).abs().gte(0.02) && entries.length <= 36) {
    // Subset-sum fallback (cents): pick uncleared lines whose signed deltas equal needed
    const items = entries.map((e) => ({
      id: e.id,
      cents: Math.round(signedGlDelta(e, acc.normal_balance) * 100),
    }));
    const needCents = Math.round(needed.toNumber() * 100);
    const subset = findSubsetSumCents(items, needCents);
    if (subset) {
      clearedIds.length = 0;
      clearedIds.push(...subset);
      running = new Decimal(beginningBalance).plus(needed);
    }
  }

  if (running.minus(target).abs().gte(0.02)) {
    return {
      reconciled: false,
      statementDate,
      endingBalance,
      beginningBalance,
      priorStatementDate: priorIso,
      computedBalance: round2(running.toNumber()),
      variance: round2(running.minus(target).toNumber()),
      unclearedCandidates: entries.length,
      clearedCount: 0,
      message: 'Could not match statement ending balance — session stays open',
    };
  }

  try {
    const result = await closeBankReconciliation(db, {
      entityId,
      accountId: acc.id,
      glIds: clearedIds,
      statementDate,
      statementEndingBalance: endingBalance,
      userId,
      notes: notes || `Auto-reconcile ${accountNumber} ${statementDate}`,
    });
    return {
      reconciled: true,
      statementDate,
      endingBalance,
      beginningBalance,
      priorStatementDate: priorIso,
      computedBalance: round2(running.toNumber()),
      clearedCount: clearedIds.length,
      sessionId: result.sessionId,
    };
  } catch (err) {
    if (err.code === 'RECON_OUT_OF_BALANCE') {
      return {
        reconciled: false,
        statementDate,
        endingBalance,
        ...err.details,
        message: err.message,
      };
    }
    throw err;
  }
}
