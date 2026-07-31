import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { getBankStatementView, peekBundledStatement, normalizeIsoDate } from './bank-statement-view.js';
import { matchStatementToRegister, persistImportAutoMatches, suggestFeeInterest } from './reconcile-auto-match.js';
import { computeReconcileTotals, sumClearedBySide, toCents } from './reconcile-calc.js';
import { postReconcileFees } from './reconcile-fees.js';
import { verifySessionClearedMatchesStatement } from './recon-cleared-integrity.js';

async function reopenSessionGl(db, sessionId) {
  await db.run(
    `UPDATE general_ledger SET reconciliation_status = NULL, reconciliation_session_id = NULL
     WHERE reconciliation_session_id = ?`,
    [sessionId]
  );
}

/**
 * Hard bar: a row may not stay CLOSED unless live Cleared Balance === statement ending.
 * Stored difference=0 alone is not enough (that is how fake CLOSED banners recur).
 */
async function repairInvalidClosedSessions(db) {
  const closed = await db.all(
    `SELECT s.*, a.account_number, a.account_name, a.normal_balance
     FROM bank_reconciliation_sessions s
     JOIN accounts a ON a.id = s.account_id
     WHERE s.status = 'CLOSED'`
  );
  for (const row of closed || []) {
    const storedOff = Math.abs(Number(row.difference) || 0) >= 0.01;
    const live = storedOff
      ? { ok: false, difference: Number(row.difference), issue: { code: 'RECON_OFF_PENNY' } }
      : await verifySessionClearedMatchesStatement(db, row, {
          account_number: row.account_number,
          account_name: row.account_name,
          normal_balance: row.normal_balance,
        });
    if (live.ok) continue;
    await reopenSessionGl(db, row.id);
    await db.run(
      `UPDATE bank_reconciliation_sessions
       SET status = 'OPEN',
           difference = ?,
           closed_at = NULL,
           notes = COALESCE(notes, '') || ?
       WHERE id = ?`,
      [
        live.difference != null ? round2(live.difference) : round2(row.difference),
        ` | AUTO-REOPEN ${live.issue?.code || 'RECON_INVALID'}: live Cleared ≠ statement`,
        row.id,
      ]
    );
  }
}

function sessionDisplay(session, clearedCount, live = null) {
  const storedDiff = round2(session.difference);
  const liveOk = live ? !!live.ok : (session.status === 'CLOSED' && Math.abs(storedDiff) < 0.01);
  const balanced = session.status === 'CLOSED' && liveOk;
  const difference = balanced ? 0 : round2(live?.difference ?? storedDiff);
  return {
    statementDate: session.statement_date,
    status: balanced ? 'CLOSED' : 'OPEN',
    endingBalance: round2(session.ending_balance),
    beginningBalance: round2(session.beginning_balance),
    difference,
    clearedCount: live?.lineCount ?? clearedCount,
    balanced,
    liveClearedBalance: live?.clearedBalance ?? null,
    compromised: session.status === 'CLOSED' && !balanced,
    notes: session.notes || null,
    message: balanced
      ? null
      : (live?.issue?.message
        || (session.status === 'CLOSED'
          ? `Stored CLOSED but live difference ${difference.toFixed(2)} — hard rule violated.`
          : null)),
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
  // Authoritative: this period's own session beginning (CLOSED or OPEN rebuild).
  const thisSession = await db.get(
    `SELECT beginning_balance, status FROM bank_reconciliation_sessions
     WHERE entity_id = ? AND account_id = ? AND statement_date = ?
     LIMIT 1`,
    [entityId, accountId, statementDate]
  );
  // Locked CLOSED session beginning is authoritative. OPEN sessions may still
  // hold a stale begin from a bad rebuild — prefer prior close / statement.
  if (thisSession && thisSession.beginning_balance != null && thisSession.status === 'CLOSED') {
    return round2(thisSession.beginning_balance);
  }

  // Walk prior CLOSED sessions newest-first. Ignore $0 cutover stubs with no
  // cleared lines — they are not a real statement close and must not force the
  // next month's beginning to $0 (Simmons Jan 2026 opened at $11,450.19).
  const priors = await db.all(
    `SELECT id, ending_balance, statement_date, beginning_balance
     FROM bank_reconciliation_sessions
     WHERE entity_id = ? AND account_id = ? AND status = 'CLOSED'
       AND statement_date < ?
     ORDER BY statement_date DESC`,
    [entityId, accountId, statementDate]
  );
  for (const prior of priors || []) {
    if (prior.ending_balance == null) continue;
    const end = round2(prior.ending_balance);
    const begin = round2(prior.beginning_balance || 0);
    const lineCount = await countSessionLines(db, prior.id);
    const isCutoverStub = Math.abs(end) < 0.01 && Math.abs(begin) < 0.01 && lineCount === 0;
    if (isCutoverStub) continue;
    return end;
  }

  // Sum only lines locked to PRIOR sessions — never this period's own cleared lines
  // (that used to inflate "beginning" to the period's cleared-net and break the worksheet).
  const expr = normalBalance === 'CREDIT' ? '(gl.credit - gl.debit)' : '(gl.debit - gl.credit)';
  const row = await db.get(
    `SELECT COALESCE(SUM(${expr}), 0) AS bal
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id AND je.status = 'POSTED'
     WHERE gl.entity_id = ? AND gl.account_id = ?
       AND gl.reconciliation_status = 'RECONCILED'
       AND gl.posting_date < ?
       AND (
         gl.reconciliation_session_id IS NULL
         OR gl.reconciliation_session_id IN (
           SELECT id FROM bank_reconciliation_sessions
           WHERE entity_id = ? AND account_id = ? AND statement_date < ?
         )
       )`,
    [entityId, accountId, statementDate, entityId, accountId, statementDate]
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

/** Most recent closed reconciliation for an account (no date bound). */
export async function getLastClosedSession(db, entityId, accountId) {
  await ensureBankReconSessionTables(db);
  return db.get(
    `SELECT * FROM bank_reconciliation_sessions
     WHERE entity_id = ? AND account_id = ? AND status = 'CLOSED'
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
    const live = session.status === 'CLOSED'
      ? await verifySessionClearedMatchesStatement(db, session, account)
      : null;
    periodSession = sessionDisplay(session, await countSessionLines(db, session.id), live);
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
    const priorLive = await verifySessionClearedMatchesStatement(db, priorClosedRow, account);
    if (priorLive.ok) {
      priorClosedSession = sessionDisplay(
        priorClosedRow,
        await countSessionLines(db, priorClosedRow.id),
        priorLive
      );
    }
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
       AND je.je_number NOT LIKE '%-OB-%'
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
  // CLOSED session beginning is locked. For OPEN / first cycle, prefer the
  // statement's previousBalance (PDF) so Amex Begin Reconciliation matches what
  // Jerry reads — then fall back to prior closed ending / books beginning.
  const displayBeginning = session?.status === 'CLOSED' && session?.beginning_balance != null
    ? round2(session.beginning_balance)
    : (stmtMetaFinal.previousBalance != null && !priorClosedSession
      ? round2(stmtMetaFinal.previousBalance)
      : (priorClosedSession
        ? beginningBalance
        : (stmtMetaFinal.previousBalance != null ? round2(stmtMetaFinal.previousBalance) : beginningBalance)));
  const suggestedEnding = session?.ending_balance != null
    ? round2(session.ending_balance)
    : (stmtMetaFinal.currentBalance != null ? round2(stmtMetaFinal.currentBalance) : null);

  // Only treat as locked CLOSED when live Cleared === statement (periodSession.balanced).
  const sessionBalancedClosed = !!(periodSession && periodSession.balanced);

  const autoMatchResult = matchStatementToRegister({
    statementLines: statementView.lines,
    entries: entries || [],
    normalBalance: account.normal_balance,
  });

  const feeSuggestions = sessionBalancedClosed
    ? {}
    : suggestFeeInterest(autoMatchResult.statementLines);

  // Lines locked to THIS period's session via session_lines (same source as integrity).
  // Do NOT require reconciliation_status / posting_date / non-reversed filters — those
  // dropped cleared lines from the worksheet while the DB session still showed CLOSED
  // at $0.00 (Jerry saw difference $479.90 on a truly balanced Jan Simmons recon).
  let reconciledEntries = [];
  if (session) {
    reconciledEntries = await db.all(
      `SELECT gl.id, gl.journal_entry_id, gl.posting_date, gl.debit, gl.credit, gl.description,
              gl.reconciliation_status, gl.reconciliation_session_id,
              je.je_number, je.description AS je_description
       FROM bank_reconciliation_session_lines sl
       JOIN general_ledger gl ON gl.id = sl.gl_id
       JOIN journal_entries je ON gl.journal_entry_id = je.id
       WHERE sl.session_id = ?
         AND je.status = 'POSTED'
       ORDER BY gl.posting_date ASC`,
      [session.id]
    );
    // Heal drift: session_lines are the lock — restore RECONCILED markers if lost.
    if (sessionBalancedClosed) {
      for (const row of reconciledEntries) {
        if (
          row.reconciliation_status !== 'RECONCILED'
          || row.reconciliation_session_id !== session.id
        ) {
          await db.run(
            `UPDATE general_ledger
             SET reconciliation_status = 'RECONCILED', reconciliation_session_id = ?
             WHERE id = ? AND entity_id = ?`,
            [session.id, row.id, entityId]
          );
          row.reconciliation_status = 'RECONCILED';
          row.reconciliation_session_id = session.id;
        }
      }
    }
  }
  const reconciledDecorated = reconciledEntries.map((e) => ({
    ...e,
    clearState: 'reconciled',
    matchedStatementLineId: null,
    matchConfidence: null,
    alreadyReconciled: true,
  }));
  const reconciledGlIds = reconciledDecorated.map((e) => e.id);
  const reconciledIdSet = new Set(reconciledGlIds);
  // Prefer session-locked rows; drop duplicates from the open-register query.
  const openEntries = (autoMatchResult.entries || []).filter((e) => !reconciledIdSet.has(e.id));
  const mergedEntries = [...openEntries, ...reconciledDecorated]
    .sort((a, b) => String(a.posting_date).localeCompare(String(b.posting_date)));
  // Closed balanced: only session lines are checked. Open: auto-match + session lines.
  const mergedCheckedGlIds = sessionBalancedClosed
    ? reconciledGlIds
    : [...new Set([...(autoMatchResult.suggestedCheckedGlIds || []), ...reconciledGlIds])];

  // Same math the UI footer uses — if this is not $0.00, never report balanced/CLOSED.
  const endingForLive = session?.ending_balance != null
    ? round2(session.ending_balance)
    : (suggestedEnding ?? 0);
  const sides = sumClearedBySide(
    mergedEntries,
    account,
    mergedCheckedGlIds,
    account.normal_balance
  );
  const liveTotals = computeReconcileTotals({
    beginningBalance: displayBeginning,
    markedDeposits: sides.markedDeposits,
    markedPayments: sides.markedPayments,
    endingBalance: endingForLive,
  });
  if (periodSession && session?.status === 'CLOSED' && !liveTotals.balanced) {
    periodSession = {
      ...periodSession,
      balanced: false,
      status: 'OPEN',
      compromised: true,
      difference: liveTotals.difference,
      liveClearedBalance: liveTotals.clearedBalance,
      liveDifference: liveTotals.difference,
      message:
        `Worksheet difference ${liveTotals.difference.toFixed(2)} — hard rule: Cleared Balance must equal statement ending. Do not treat as reconciled.`,
    };
  } else if (periodSession) {
    periodSession = {
      ...periodSession,
      liveClearedBalance: liveTotals.clearedBalance,
      liveDifference: liveTotals.difference,
    };
  }

  return {
    account,
    statementDate: stmtMetaFinal.periodEnd || effectiveAsOf,
    beginningBalance: displayBeginning,
    displayBeginning,
    endingBalance: session?.ending_balance != null ? round2(session.ending_balance) : suggestedEnding,
    suggestedEndingBalance: suggestedEnding,
    sessionStatus: periodSession?.status || displayStatus,
    sessionDifference: periodSession?.difference ?? sessionDifference,
    periodSession,
    priorClosedSession,
    priorSession: periodSession,
    liveTotals: {
      clearedBalance: liveTotals.clearedBalance,
      difference: liveTotals.difference,
      balanced: liveTotals.balanced,
      markedDeposits: liveTotals.markedDeposits,
      markedPayments: liveTotals.markedPayments,
    },
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
  beginningBalanceOverride = null,
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

  const beginningBalance =
    beginningBalanceOverride != null
      ? round2(beginningBalanceOverride)
      : await getBeginningBalance(
          db,
          entityId,
          accountId,
          statementDate,
          account.normal_balance
        );

  // Empty clear list is allowed ONLY for true dormant months: beginning == ending
  // AND no uncleared posted register lines through the statement date.
  // Setting begin=end with glIds=[] while the register still has activity is a
  // fake close (Difference $0.00, "0 cleared lines") — permanently blocked.
  if (glIds.length === 0) {
    if (toCents(beginningBalance) !== toCents(statementEndingBalance)) {
      const err = new Error(
        'Select at least one cleared transaction (or set statement ending equal to beginning balance for a $0-activity close)'
      );
      err.code = 'RECON_EMPTY_CLEAR_LIST';
      throw err;
    }
    const prior = await getPriorClosedSession(db, entityId, accountId, statementDate);
    const priorIso = prior ? normalizeIsoDate(prior.statement_date) : null;
    const uncParams = [entityId, accountId, statementDate];
    let uncSql = `
      SELECT COUNT(*) AS n
      FROM general_ledger gl
      JOIN journal_entries je ON je.id = gl.journal_entry_id
      WHERE gl.entity_id = ? AND gl.account_id = ?
        AND gl.reconciliation_status IS NULL
        AND je.status = 'POSTED'
        AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
        AND je.je_number NOT LIKE 'OB-%'
        AND gl.posting_date <= ?`;
    if (priorIso) {
      uncSql += ' AND gl.posting_date > ?';
      uncParams.push(priorIso);
    }
    const unc = await db.get(uncSql, uncParams);
    if (Number(unc?.n || 0) > 0) {
      const err = new Error(
        `Fake empty reconciliation blocked: ${unc.n} uncleared posted line(s) exist through ${statementDate}. ` +
          `Clear the real register lines — do not close with beginning = ending and zero cleared lines.`
      );
      err.code = 'FAKE_EMPTY_RECON_BLOCKED';
      throw err;
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

  // Refresh beginning from live statement/books so a wrong locked begin
  // (e.g. Amex folded $82,139.67 vs PDF $84,373.94) does not stick on reopen.
  const account = await db.get(
    'SELECT id, account_number, normal_balance FROM accounts WHERE id = ? AND entity_id = ?',
    [accountId, entityId]
  );
  let refreshedBegin = null;
  if (account) {
    const bundled = peekBundledStatement(account.account_number, statementDate);
    if (bundled?.meta?.previousBalance != null) {
      refreshedBegin = round2(bundled.meta.previousBalance);
    } else {
      refreshedBegin = await getBeginningBalance(
        db,
        entityId,
        accountId,
        statementDate,
        account.normal_balance
      );
      // getBeginningBalance may still see THIS session's old beginning — prefer
      // prior closed ending when the session row is the only source.
      const prior = await getPriorClosedSession(db, entityId, accountId, statementDate);
      if (prior && Math.abs(Number(prior.ending_balance) || 0) >= 0.01) {
        refreshedBegin = round2(prior.ending_balance);
      }
    }
  }

  if (refreshedBegin != null) {
    await db.run(
      `UPDATE bank_reconciliation_sessions
       SET status = 'OPEN', difference = 0, closed_at = NULL, beginning_balance = ?
       WHERE id = ?`,
      [refreshedBegin, session.id]
    );
  } else {
    await db.run(
      `UPDATE bank_reconciliation_sessions SET status = 'OPEN', difference = 0, closed_at = NULL WHERE id = ?`,
      [session.id]
    );
  }
  return {
    reopened: true,
    sessionId: session.id,
    status: 'OPEN',
    beginningBalance: refreshedBegin,
  };
}

/**
 * QuickBooks-style "Undo Last Reconciliation": reopen the chronologically last
 * CLOSED session for this account (not the statement date currently on screen).
 * Example: working February with a wrong beginning → undoes January so you can
 * rework January until its ending matches the January statement.
 *
 * Also refreshes beginning_balance on any later OPEN sessions that had locked
 * in the undone ending as their start.
 */
export async function undoLastBankReconciliation(db, { entityId, accountId }) {
  await ensureBankReconSessionTables(db);
  if (!entityId || !accountId) throw new Error('entityId and accountId required');

  const last = await getLastClosedSession(db, entityId, accountId);
  if (!last) {
    const err = new Error('No completed reconciliation to undo for this account');
    err.code = 'NO_CLOSED_RECON';
    throw err;
  }

  const undoneStatementDate = last.statement_date;
  const previousEndingBalance = round2(last.ending_balance);
  const result = await reopenBankReconciliation(db, {
    entityId,
    accountId,
    statementDate: undoneStatementDate,
  });

  // Later OPEN months (e.g. February) may still store January's old ending as
  // beginning — clear them so the next prepare/worksheet recomputes from the
  // statement PDF previous-balance or books after January is redone.
  const laterOpen = await db.all(
    `SELECT id, statement_date FROM bank_reconciliation_sessions
     WHERE entity_id = ? AND account_id = ? AND status = 'OPEN'
       AND statement_date > ?`,
    [entityId, accountId, undoneStatementDate]
  );
  const refreshedLater = [];
  for (const row of laterOpen || []) {
    const account = await db.get(
      'SELECT id, account_number, normal_balance FROM accounts WHERE id = ? AND entity_id = ?',
      [accountId, entityId]
    );
    let begin = null;
    if (account) {
      const bundled = peekBundledStatement(account.account_number, row.statement_date);
      if (bundled?.meta?.previousBalance != null) {
        begin = round2(bundled.meta.previousBalance);
      } else {
        begin = await getBeginningBalance(
          db,
          entityId,
          accountId,
          row.statement_date,
          account.normal_balance
        );
      }
    }
    if (begin != null) {
      await db.run(
        `UPDATE bank_reconciliation_sessions SET beginning_balance = ? WHERE id = ?`,
        [begin, row.id]
      );
      refreshedLater.push({ statementDate: row.statement_date, beginningBalance: begin });
    }
  }

  return {
    ...result,
    undoneStatementDate,
    previousEndingBalance,
    refreshedLaterSessions: refreshedLater,
  };
}

/**
 * Reopen every CLOSED bank/card reconciliation whose statement month falls in
 * [fromMonth, throughMonth] (inclusive YYYY-MM). Used to bulk-undo a span of
 * periods (e.g. March–June 2026) across Simmons, Lone Star, CSB, and Amex.
 */
export async function undoBankReconsInRange(db, {
  entityId,
  fromMonth = '2026-03',
  throughMonth = '2026-06',
  accountNumbers = ['1000', '1001', '1002', '2010'],
}) {
  await ensureBankReconSessionTables(db);
  if (!entityId) throw new Error('entityId required');

  const from = String(fromMonth).slice(0, 7);
  const through = String(throughMonth).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(through)) {
    throw new Error('fromMonth and throughMonth must be YYYY-MM');
  }
  const [throughY, throughM] = through.split('-').map(Number);
  const fromDate = `${from}-01`;
  const throughDate = new Date(Date.UTC(throughY, throughM, 0)).toISOString().slice(0, 10);

  const results = [];

  for (const accountNumber of accountNumbers) {
    const account = await db.get(
      'SELECT id, account_number, normal_balance FROM accounts WHERE entity_id = ? AND account_number = ?',
      [entityId, String(accountNumber)]
    );
    if (!account) {
      results.push({ accountNumber, error: 'Account not found' });
      continue;
    }

    const sessions = await db.all(
      `SELECT id, statement_date, status
       FROM bank_reconciliation_sessions
       WHERE entity_id = ? AND account_id = ?
         AND statement_date >= ?
         AND statement_date <= ?
       ORDER BY statement_date DESC`,
      [entityId, account.id, fromDate, throughDate]
    );

    const reopened = [];
    for (const row of sessions || []) {
      const statementDate = normalizeIsoDate(row.statement_date);
      if (!statementDate) continue;
      if (row.status !== 'CLOSED') {
        reopened.push({ statementDate, action: 'skipped', status: row.status });
        continue;
      }
      const r = await reopenBankReconciliation(db, {
        entityId,
        accountId: account.id,
        statementDate,
      });
      reopened.push({ statementDate, action: 'reopened', ...r });
    }

    const laterOpen = await db.all(
      `SELECT id, statement_date FROM bank_reconciliation_sessions
       WHERE entity_id = ? AND account_id = ? AND status = 'OPEN'
       ORDER BY statement_date ASC`,
      [entityId, account.id]
    );
    const refreshedLater = [];
    for (const row of laterOpen || []) {
      const sd = normalizeIsoDate(row.statement_date);
      if (!sd) continue;
      const bundled = peekBundledStatement(account.account_number, sd);
      let begin = bundled?.meta?.previousBalance != null
        ? round2(bundled.meta.previousBalance)
        : await getBeginningBalance(db, entityId, account.id, sd, account.normal_balance);
      if (begin != null) {
        await db.run(
          'UPDATE bank_reconciliation_sessions SET beginning_balance = ? WHERE id = ?',
          [begin, row.id]
        );
        refreshedLater.push({ statementDate: sd, beginningBalance: begin });
      }
    }

    results.push({
      accountNumber,
      accountId: account.id,
      reopened,
      refreshedLaterSessions: refreshedLater,
    });
  }

  return { entityId, fromMonth: from, throughMonth: through, fromDate, throughDate, accountNumbers, results };
}

/** Auto-reconcile for catch-up scripts — uses same zero-difference guard. */
export async function autoReconcileToTarget(db, {
  entityId,
  accountNumber,
  statementDate,
  endingBalance,
  userId,
  notes = null,
  clearedAfterDate = null,
  beginningBalanceOverride = null,
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

  let beginningBalance =
    beginningBalanceOverride != null
      ? round2(beginningBalanceOverride)
      : await getBeginningBalance(
          db,
          entityId,
          acc.id,
          statementDate,
          acc.normal_balance
        );

  // Rebuild path: keep OPEN session beginning when getBeginningBalance would reset to statement previous.
  if (
    beginningBalanceOverride == null &&
    existing &&
    Math.abs(Number(existing.beginning_balance) || 0) >= 0.01 &&
    Math.abs(round2(existing.beginning_balance) - beginningBalance) >= 0.01
  ) {
    // Prefer chained session beginning when present (books-adjusted).
    beginningBalance = round2(existing.beginning_balance);
  }

  const prior = await getPriorClosedSession(db, entityId, acc.id, statementDate);
  // Ignore placeholder $0 prior closes (e.g. cutover stub) — they zero out beginnings.
  let priorIso =
    prior && Math.abs(Number(prior.ending_balance) || 0) >= 0.01
      ? normalizeIsoDate(prior.statement_date)
      : null;
  if (clearedAfterDate) {
    priorIso = normalizeIsoDate(clearedAfterDate) || priorIso;
  }

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
  // Only clear register lines on/before the statement date. Pulling later
  // activity (former +14d credit-card window) faked Cleared=$0 while books as
  // of the statement date still disagreed — forbidden under BOOK_NE_STATEMENT.
  sql += ' AND gl.posting_date <= ?';
  params.push(statementDate);
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

  if (running.minus(target).abs().gte(0.02)) {
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
