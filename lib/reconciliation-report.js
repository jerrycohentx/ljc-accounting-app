import { v4 as uuidv4 } from 'uuid';
import { getBeginningBalance, signedGlDelta, getSessionForPeriod } from './bank-reconcile-session.js';

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
 *  - New Transactions: posted, unreconciled lines dated after the statement
 *    date but on/before `asOfDate` (defaults to today) -- activity the
 *    register has picked up since this period was reconciled
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
  const beginningBalance = await getBeginningBalance(
    db, entityId, accountId, statementDate, account.normal_balance
  );

  const effectiveAsOf = asOfDate || new Date().toISOString().slice(0, 10);

  // "Cleared" = anything marked RECONCILED that belongs to THIS period -- either
  // linked to this exact statement period's session (the authoritative case,
  // once a formal close has happened), or a "legacy" reconciled row with no
  // session link at all (this app also marks rows RECONCILED directly during
  // automated statement loads, before any formal reconciliation session is
  // ever opened/closed for that period -- those rows are just as real and
  // must count as cleared, not silently disappear from every bucket). Rows
  // tied to a DIFFERENT (earlier) closed session are excluded here since
  // they already belong to that earlier period's report and are already
  // folded into this period's beginning balance.
  const clearedRows = await db.all(
    `SELECT gl.id, gl.journal_entry_id, gl.posting_date, gl.debit, gl.credit, gl.description,
            je.je_number, je.description AS je_description, gl.created_at
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id
     WHERE gl.entity_id = ? AND gl.account_id = ?
       AND je.status = 'POSTED' AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
       AND gl.reconciliation_status = 'RECONCILED'
       AND (gl.reconciliation_session_id IS NULL${session ? ' OR gl.reconciliation_session_id = ?' : ''})
       AND gl.posting_date <= ?
     ORDER BY gl.posting_date ASC, gl.created_at ASC`,
    session
      ? [entityId, accountId, session.id, statementDate]
      : [entityId, accountId, statementDate]
  );

  const unclearedRows = await db.all(
    `SELECT gl.id, gl.journal_entry_id, gl.posting_date, gl.debit, gl.credit, gl.description,
            je.je_number, je.description AS je_description, gl.created_at
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id
     WHERE gl.entity_id = ? AND gl.account_id = ?
       AND je.status = 'POSTED' AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
       AND gl.reconciliation_status IS NULL
       AND gl.posting_date <= ?
     ORDER BY gl.posting_date ASC, gl.created_at ASC`,
    [entityId, accountId, statementDate]
  );

  const newRows = await db.all(
    `SELECT gl.id, gl.journal_entry_id, gl.posting_date, gl.debit, gl.credit, gl.description,
            je.je_number, je.description AS je_description, gl.created_at
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id
     WHERE gl.entity_id = ? AND gl.account_id = ?
       AND je.status = 'POSTED' AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
       AND gl.reconciliation_status IS NULL
       AND gl.posting_date > ? AND gl.posting_date <= ?
     ORDER BY gl.posting_date ASC, gl.created_at ASC`,
    [entityId, accountId, statementDate, effectiveAsOf]
  );

  function bucketize(rows) {
    const payments = [];
    const deposits = [];
    for (const r of rows) {
      const amt = round2(signedGlDelta(r, account.normal_balance).toNumber());
      const item = {
        type: inferType(r, amt),
        date: String(r.posting_date).slice(0, 10),
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
  const newB = bucketize(newRows);

  const clearedPaymentsTotal = sumAmt(clearedB.payments);
  const clearedDepositsTotal = sumAmt(clearedB.deposits);
  const totalCleared = round2(clearedPaymentsTotal + clearedDepositsTotal);
  const clearedBalance = round2(beginningBalance + totalCleared);

  const unclearedPaymentsTotal = sumAmt(unclearedB.payments);
  const unclearedDepositsTotal = sumAmt(unclearedB.deposits);
  const totalUncleared = round2(unclearedPaymentsTotal + unclearedDepositsTotal);
  const registerBalance = round2(clearedBalance + totalUncleared);

  const newPaymentsTotal = sumAmt(newB.payments);
  const newDepositsTotal = sumAmt(newB.deposits);
  const totalNew = round2(newPaymentsTotal + newDepositsTotal);
  const endingBalance = round2(registerBalance + totalNew);

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
        paymentsCount: newB.payments.length,
        paymentsTotal: newPaymentsTotal,
        depositsCount: newB.deposits.length,
        depositsTotal: newDepositsTotal,
        total: totalNew,
      },
      endingBalance,
    },
    detail: {
      paymentsLabel,
      depositsLabel,
      beginningBalance,
      cleared: { payments: withRunning(clearedB.payments), deposits: withRunning(clearedB.deposits), total: totalCleared, balance: clearedBalance },
      uncleared: { payments: withRunning(unclearedB.payments), deposits: withRunning(unclearedB.deposits), total: totalUncleared, balance: registerBalance },
      newTransactions: { payments: withRunning(newB.payments), deposits: withRunning(newB.deposits), total: totalNew, balance: endingBalance },
      endingBalance,
    },
    meta: {
      entityId,
      accountId,
      isClosed: session?.status === 'CLOSED',
      sessionId: session?.id || null,
      statementDate,
      asOfDate: effectiveAsOf,
    },
  };
}

export async function saveReconciliationReport(db, report, { userId = null } = {}) {
  await ensureReconciliationReportsTable(db);
  const id = `recrpt-${uuidv4()}`;
  await db.run(
    `INSERT INTO reconciliation_reports
     (id, entity_id, account_id, account_number, account_name, session_id, statement_date, as_of_date,
      report_label, is_closed, beginning_balance, ending_balance, summary_json, detail_json, generated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      report.meta.entityId,
      report.meta.accountId,
      report.header.accountNumber,
      report.header.accountName,
      report.meta.sessionId,
      report.meta.statementDate,
      report.meta.asOfDate,
      `${report.header.accountLabel}, Period Ending ${report.meta.statementDate}`,
      !!report.meta.isClosed,
      report.summary.beginningBalance,
      report.summary.endingBalance,
      JSON.stringify(report.summary),
      JSON.stringify(report.detail),
      userId,
    ]
  );
  return id;
}

export async function listReconciliationReports(db, { entityId, accountId = null }) {
  await ensureReconciliationReportsTable(db);
  const params = [entityId];
  let sql = `SELECT id, entity_id, account_id, account_number, account_name, statement_date, as_of_date,
                    report_label, is_closed, beginning_balance, ending_balance, generated_by, generated_at
             FROM reconciliation_reports WHERE entity_id = ?`;
  if (accountId) {
    sql += ' AND account_id = ?';
    params.push(accountId);
  }
  sql += ' ORDER BY statement_date DESC, generated_at DESC';
  return db.all(sql, params);
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
