import { v4 as uuidv4 } from 'uuid';
import { getBeginningBalance, signedGlDelta, getSessionForPeriod } from './bank-reconcile-session.js';
import { getBankStatementView } from './bank-statement-view.js';

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export async function ensureReconciliationReportsTable(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS reconciliation_reports (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_number TEXT,
      account_name TEXT,
      session_id TEXT,
      statement_date DATE NOT NULL,
      as_of_date DATE NOT NULL,
      report_label TEXT,
      is_closed BOOLEAN DEFAULT false,
      beginning_balance DECIMAL(19,2),
      ending_balance DECIMAL(19,2),
      summary_json TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      generated_by TEXT,
      generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * Best-effort "Type" label for a GL line, matching the vocabulary QuickBooks
 * Desktop uses in its reconciliation reports (Check, Deposit, Bill Pmt -Check,
 * General Journal, Credit Card Credit). This app doesn't track a dedicated
 * transaction-type field, so this is inferred from the entry's description --
 * it's a display convenience, not something the report's dollar totals
 * depend on.
 */
function inferType(entry, amount) {
  const desc = `${entry.je_description || ''} ${entry.description || ''}`.toLowerCase();
  if (/general journal|reversal|reverse|clean redo|dedup|true-?up|correct/.test(desc)) return 'General Journal';
  if (/bill pmt|bill payment/.test(desc)) return 'Bill Pmt -Check';
  if (amount < 0) {
    if (/credit card credit/.test(desc)) return 'Credit Card Credit';
    return 'Check';
  }
  if (/credit card credit/.test(desc)) return 'Credit Card Credit';
  return 'Deposit';
}

function extractNum(entry) {
  const m = String(entry.je_number || '').match(/^(\d{3,})$/);
  return m ? m[1] : null;
}

/**
 * Build a QuickBooks-style reconciliation report (Summary + Detail) for ANY
 * account -- bank, credit card, or intercompany due-to/due-from -- as of a
 * given statement date. Works whether the period's session is CLOSED
 * (authoritative: "cleared" = exactly what that session locked in) or still
 * OPEN (best-effort preview using whatever is currently marked reconciled).
 *
 * Three buckets, matching QuickBooks Desktop's report sections:
 *  - Cleared Transactions: GL lines linked to this statement period's session
 *  - Uncleared Transactions: posted, unreconciled lines dated on/before the
 *    statement date
 *
 * Activity dated AFTER the statement date is never included — a reconciliation
 * report is a point-in-time document for that statement period only.
 *
 * Each bucket splits into "payments" (money out) and "deposits" (money in)
 * by the sign of the entry relative to the account's normal balance -- for a
 * LIABILITY (credit card) account these are relabeled "Charges and Cash
 * Advances" / "Payments and Credits" to match QuickBooks' own credit-card
 * report vocabulary.
 */
export async function buildReconciliationReport(db, {
  entityId,
  accountId,
  statementDate,
  asOfDate = null,
  companyName = null,
}) {
  await ensureReconciliationReportsTable(db);

  const account = await db.get(
    'SELECT id, account_number, account_name, normal_balance, account_type FROM accounts WHERE id = ? AND entity_id = ?',
    [accountId, entityId]
  );
  if (!account) throw new Error('Account not found');

  let entityName = companyName;
  if (!entityName) {
    const entity = await db.get('SELECT name FROM entities WHERE id = ?', entityId);
    entityName = entity?.name || null;
  }

  const isCreditCard = account.account_type === 'LIABILITY';
  const paymentsLabel = isCreditCard ? 'Charges and Cash Advances' : 'Checks and Payments';
  const depositsLabel = isCreditCard ? 'Payments and Credits' : 'Deposits and Credits';

  const session = await getSessionForPeriod(db, entityId, accountId, statementDate);

  // Prefer the real bank statement's own "previous balance" (loaded from the
  // actual statement file/import for this period) as the reconciliation's
  // beginning balance -- this is what QuickBooks itself treats as ground
  // truth. Only fall back to summing ad-hoc RECONCILED flags when no
  // statement data exists for the period, since that fallback can't tell
  // "settled in an earlier, properly closed period" apart from "just
  // happens to be flagged reconciled sometime during this same period" --
  // it's a real gap that only fully closes once every period has gone
  // through a formal close.
  const statementView = await getBankStatementView(db, {
    entityId, accountId, accountNumber: account.account_number, statementDate,
  });
  const statementMeta = statementView?.meta || {};
  const beginningBalance = statementMeta.previousBalance != null
    ? round2(statementMeta.previousBalance)
    : await getBeginningBalance(db, entityId, accountId, statementDate, account.normal_balance);
  const statementEndingBalance = statementMeta.currentBalance != null
    ? round2(statementMeta.currentBalance)
    : null;

  // Only THIS period's own activity belongs in cleared/uncleared -- anything
  // dated before the period start (e.g. a prior opening-balance or true-up
  // entry) is already folded into beginningBalance above and must not be
  // double-counted here.
  const periodStart = statementMeta.periodStart || `${String(statementDate).slice(0, 7)}-01`;

  // "Cleared" for a CLOSED session = only lines locked to that session.
  // Orphan RECONCILED rows (null session_id) must NOT inflate Cleared Balance —
  // that was allowing Cleared ≠ statement while the month still looked "closed".
  const clearedRows = session?.status === 'CLOSED'
    ? await db.all(
      `SELECT gl.id, gl.journal_entry_id, gl.posting_date, gl.debit, gl.credit, gl.description,
              je.je_number, je.description AS je_description, gl.created_at
       FROM bank_reconciliation_session_lines sl
       JOIN general_ledger gl ON gl.id = sl.gl_id
       JOIN journal_entries je ON je.id = gl.journal_entry_id
       WHERE sl.session_id = ?
         AND gl.entity_id = ? AND gl.account_id = ?
         AND je.status = 'POSTED' AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
       ORDER BY gl.posting_date ASC, gl.created_at ASC`,
      [session.id, entityId, accountId]
    )
    : await db.all(
      `SELECT gl.id, gl.journal_entry_id, gl.posting_date, gl.debit, gl.credit, gl.description,
              je.je_number, je.description AS je_description, gl.created_at
       FROM general_ledger gl
       JOIN journal_entries je ON je.id = gl.journal_entry_id
       WHERE gl.entity_id = ? AND gl.account_id = ?
         AND je.status = 'POSTED' AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
         AND gl.reconciliation_status = 'RECONCILED'
         AND je.je_number NOT LIKE 'TRUEUP-%'
         AND (gl.reconciliation_session_id IS NULL${session ? ' OR gl.reconciliation_session_id = ?' : ''})
         AND gl.posting_date >= ? AND gl.posting_date <= ?
       ORDER BY gl.posting_date ASC, gl.created_at ASC`,
      session
        ? [entityId, accountId, session.id, periodStart, statementDate]
        : [entityId, accountId, periodStart, statementDate]
    );

  const unclearedRows = await db.all(
    `SELECT gl.id, gl.journal_entry_id, gl.posting_date, gl.debit, gl.credit, gl.description,
            je.je_number, je.description AS je_description, gl.created_at
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id
     WHERE gl.entity_id = ? AND gl.account_id = ?
       AND je.status = 'POSTED' AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
       AND gl.reconciliation_status IS NULL
       AND je.je_number NOT LIKE 'TRUEUP-%'
       AND gl.posting_date >= ? AND gl.posting_date <= ?
     ORDER BY gl.posting_date ASC, gl.created_at ASC`,
    [entityId, accountId, periodStart, statementDate]
  );

  function bucketize(rows) {
    const payments = [];
    const deposits = [];
    for (const r of rows) {
      const amt = round2(signedGlDelta(r, account.normal_balance).toNumber());
      const item = {
        type: inferType(r, amt),
        // posting_date may be a JS Date (Postgres) or a string; normalize to
        // YYYY-MM-DD. String(dateObj) would yield "Fri Jan 02" and drop the year.
        date: r.posting_date instanceof Date
          ? r.posting_date.toISOString().slice(0, 10)
          : String(r.posting_date).slice(0, 10),
        num: extractNum(r),
        name: null,
        description: r.je_description || r.description || '',
        amount: amt,
        glId: r.id,
        jeNumber: r.je_number,
      };
      if (amt < 0) payments.push(item);
      else deposits.push(item);
    }
    return { payments, deposits };
  }

  function sumAmt(items) {
    return round2(items.reduce((s, i) => s + i.amount, 0));
  }

  function withRunning(items) {
    let running = 0;
    return items.map((i) => {
      running = round2(running + i.amount);
      return { ...i, runningBalance: running };
    });
  }

  const clearedB = bucketize(clearedRows);
  const unclearedB = bucketize(unclearedRows);

  const clearedPaymentsTotal = sumAmt(clearedB.payments);
  const clearedDepositsTotal = sumAmt(clearedB.deposits);
  const totalCleared = round2(clearedPaymentsTotal + clearedDepositsTotal);
  const clearedBalance = round2(beginningBalance + totalCleared);

  const unclearedPaymentsTotal = sumAmt(unclearedB.payments);
  const unclearedDepositsTotal = sumAmt(unclearedB.deposits);
  const totalUncleared = round2(unclearedPaymentsTotal + unclearedDepositsTotal);
  const registerBalance = round2(clearedBalance + totalUncleared);

  // Ending = register as of statement date (cleared + uncleared through statement).
  // Do not roll forward with later activity.
  const endingBalance = registerBalance;

  const accountLabel = `${account.account_name}${account.account_number ? ' ' + account.account_number : ''}`;

  return {
    header: {
      companyName: entityName || 'LJC Financial, LLC',
      accountLabel,
      accountNumber: account.account_number,
      accountName: account.account_name,
      statementDate,
      reportGeneratedAt: new Date().toISOString(),
    },
    summary: {
      beginningBalance,
      paymentsLabel,
      depositsLabel,
      cleared: {
        paymentsCount: clearedB.payments.length,
        paymentsTotal: clearedPaymentsTotal,
        depositsCount: clearedB.deposits.length,
        depositsTotal: clearedDepositsTotal,
        total: totalCleared,
      },
      clearedBalance,
      uncleared: {
        paymentsCount: unclearedB.payments.length,
        paymentsTotal: unclearedPaymentsTotal,
        depositsCount: unclearedB.deposits.length,
        depositsTotal: unclearedDepositsTotal,
        total: totalUncleared,
      },
      registerBalance,
      registerBalanceAsOf: statementDate,
      newTransactions: {
        paymentsCount: 0,
        paymentsTotal: 0,
        depositsCount: 0,
        depositsTotal: 0,
        total: 0,
      },
      endingBalance,
      statementEndingBalance,
      statementVariance:
        statementEndingBalance != null
          ? round2(clearedBalance - statementEndingBalance)
          : null,
    },
    detail: {
      paymentsLabel,
      depositsLabel,
      beginningBalance,
      cleared: { payments: withRunning(clearedB.payments), deposits: withRunning(clearedB.deposits), total: totalCleared, balance: clearedBalance },
      uncleared: { payments: withRunning(unclearedB.payments), deposits: withRunning(unclearedB.deposits), total: totalUncleared, balance: registerBalance },
      newTransactions: { payments: [], deposits: [], total: 0, balance: endingBalance },
      endingBalance,
    },
    meta: {
      entityId,
      accountId,
      isClosed: session?.status === 'CLOSED',
      sessionId: session?.id || null,
      statementDate,
      asOfDate: statementDate,
    },
  };
}

export async function saveReconciliationReport(db, report, { userId = null } = {}) {
  await ensureReconciliationReportsTable(db);
  const entityId = report.meta.entityId;
  const accountId = report.meta.accountId;
  const statementDate = report.meta.statementDate;
  const isClosed = !!report.meta.isClosed;

  // Statement ending is what Jerry cares about in the list — not register roll-forward.
  const endingBalance =
    report.summary.statementEndingBalance != null
      ? report.summary.statementEndingBalance
      : report.summary.clearedBalance != null && isClosed
        ? report.summary.clearedBalance
        : report.summary.endingBalance;

  // One archive per account + statement date: replace prior drafts / stale closes.
  const prior = await db.all(
    `SELECT id FROM reconciliation_reports
     WHERE entity_id = ? AND account_id = ? AND statement_date = ?`,
    [entityId, accountId, statementDate]
  );
  for (const row of prior || []) {
    await db.run('DELETE FROM reconciliation_reports WHERE id = ?', [row.id]);
  }

  const id = `recrpt-${uuidv4()}`;
  await db.run(
    `INSERT INTO reconciliation_reports
     (id, entity_id, account_id, account_number, account_name, session_id, statement_date, as_of_date,
      report_label, is_closed, beginning_balance, ending_balance, summary_json, detail_json, generated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      entityId,
      accountId,
      report.header.accountNumber,
      report.header.accountName,
      report.meta.sessionId,
      statementDate,
      report.meta.asOfDate,
      `${report.header.accountLabel}, Period Ending ${statementDate}`,
      isClosed,
      report.summary.beginningBalance,
      endingBalance,
      JSON.stringify(report.summary),
      JSON.stringify(report.detail),
      userId,
    ]
  );
  return id;
}

/**
 * Keep one report per account + statement date.
 * Prefer CLOSED; among ties keep newest generated_at. Delete the rest.
 */
export async function pruneSupersededReconciliationReports(db, { entityId } = {}) {
  await ensureReconciliationReportsTable(db);
  const rows = await db.all(
    `SELECT id, entity_id, account_id, account_number, statement_date, is_closed, generated_at, ending_balance
     FROM reconciliation_reports
     WHERE entity_id = ?
     ORDER BY account_id, statement_date, is_closed DESC, generated_at DESC`,
    [entityId]
  );
  const keep = new Set();
  const remove = [];
  for (const row of rows || []) {
    const key = `${row.account_id}|${String(row.statement_date).slice(0, 10)}`;
    if (keep.has(key)) {
      remove.push(row);
    } else {
      keep.add(key);
    }
  }
  for (const row of remove) {
    await db.run('DELETE FROM reconciliation_reports WHERE id = ?', [row.id]);
  }
  return {
    entityId,
    kept: keep.size,
    removed: remove.length,
    removedIds: remove.map((r) => r.id),
  };
}

export async function listReconciliationReports(db, {
  entityId,
  accountId = null,
  canonicalOnly = true,
}) {
  await ensureReconciliationReportsTable(db);
  const params = [entityId];
  let sql = `SELECT id, entity_id, account_id, account_number, account_name, statement_date, as_of_date,
                    report_label, is_closed, beginning_balance, ending_balance, generated_by, generated_at
             FROM reconciliation_reports WHERE entity_id = ?`;
  if (accountId) {
    sql += ' AND account_id = ?';
    params.push(accountId);
  }
  sql += ' ORDER BY account_number ASC, statement_date DESC, is_closed DESC, generated_at DESC';
  const rows = await db.all(sql, params);
  if (!canonicalOnly) return rows || [];

  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = `${row.account_id}|${String(row.statement_date).slice(0, 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export async function deleteReconciliationReport(db, id) {
  await ensureReconciliationReportsTable(db);
  const row = await db.get('SELECT id FROM reconciliation_reports WHERE id = ?', [id]);
  if (!row) return false;
  await db.run('DELETE FROM reconciliation_reports WHERE id = ?', [id]);
  return true;
}

export async function getReconciliationReport(db, id) {
  await ensureReconciliationReportsTable(db);
  const row = await db.get('SELECT * FROM reconciliation_reports WHERE id = ?', id);
  if (!row) return null;
  return {
    ...row,
    summary: JSON.parse(row.summary_json),
    detail: JSON.parse(row.detail_json),
  };
}
