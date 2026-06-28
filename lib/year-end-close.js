import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { postJournalEntryToGl } from './post-journal.js';
import { assertPeriodOpen } from './period-lock.js';

async function getIncomeExpenseBalances(db, entityId, asOfDate) {
  const rows = await db.all(
    `SELECT
       a.id, a.account_number, a.account_name, a.account_type, a.normal_balance,
       COALESCE(SUM(gl.debit), 0) AS total_debit,
       COALESCE(SUM(gl.credit), 0) AS total_credit
     FROM accounts a
     LEFT JOIN general_ledger gl ON gl.account_id = a.id AND gl.entity_id = ?
     LEFT JOIN journal_entries je ON je.id = gl.journal_entry_id AND je.status = 'POSTED'
     WHERE a.entity_id = ? AND a.is_active = 1
       AND a.account_type IN ('REVENUE', 'EXPENSE')
       AND (gl.id IS NULL OR (je.status = 'POSTED' AND gl.posting_date <= ?))
     GROUP BY a.id
     HAVING ABS(COALESCE(SUM(gl.debit), 0) - COALESCE(SUM(gl.credit), 0)) > 0.001
     ORDER BY a.account_type, a.account_number`,
    [entityId, entityId, asOfDate]
  );

  return rows.map((row) => {
    const debit = new Decimal(row.total_debit || 0);
    const credit = new Decimal(row.total_credit || 0);
    const balance = row.normal_balance === 'DEBIT' ? debit.minus(credit) : credit.minus(debit);
    return { ...row, balance: balance.toFixed(2) };
  });
}

export async function previewYearEndClose(db, entityId, asOfDate) {
  const accounts = await getIncomeExpenseBalances(db, entityId, asOfDate);
  const retained = await db.get(
    `SELECT id, account_number, account_name FROM accounts
     WHERE entity_id = ? AND account_number IN ('3100', '3000')
     ORDER BY CASE account_number WHEN '3100' THEN 0 ELSE 1 END LIMIT 1`,
    [entityId]
  );

  const closingLines = [];
  let netToRetained = new Decimal(0);

  for (const acct of accounts) {
    const bal = new Decimal(acct.balance);
    if (bal.isZero()) continue;

    if (acct.account_type === 'REVENUE') {
      closingLines.push({
        accountNumber: acct.account_number,
        accountName: acct.account_name,
        accountId: acct.id,
        debit: bal.toFixed(2),
        credit: 0,
        type: 'REVENUE',
      });
      netToRetained = netToRetained.plus(bal);
    } else {
      closingLines.push({
        accountNumber: acct.account_number,
        accountName: acct.account_name,
        accountId: acct.id,
        debit: 0,
        credit: bal.toFixed(2),
        type: 'EXPENSE',
      });
      netToRetained = netToRetained.minus(bal);
    }
  }

  if (retained && !netToRetained.isZero()) {
    if (netToRetained.gt(0)) {
      closingLines.push({
        accountNumber: retained.account_number,
        accountName: retained.account_name,
        accountId: retained.id,
        debit: 0,
        credit: netToRetained.toFixed(2),
        type: 'EQUITY',
      });
    } else {
      closingLines.push({
        accountNumber: retained.account_number,
        accountName: retained.account_name,
        accountId: retained.id,
        debit: netToRetained.abs().toFixed(2),
        credit: 0,
        type: 'EQUITY',
      });
    }
  }

  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  for (const line of closingLines) {
    totalDebit = totalDebit.plus(line.debit || 0);
    totalCredit = totalCredit.plus(line.credit || 0);
  }

  return {
    asOfDate,
    closingLines,
    netIncome: netToRetained.toFixed(2),
    retainedEarningsAccount: retained?.account_number || null,
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
    balanced: totalDebit.equals(totalCredit),
    accountCount: accounts.length,
  };
}

export async function postYearEndClose(db, { entityId, asOfDate, userId, memo }) {
  await assertPeriodOpen(db, entityId, asOfDate);

  const preview = await previewYearEndClose(db, entityId, asOfDate);
  if (preview.closingLines.length < 2) {
    return { posted: false, message: 'No income or expense balances to close' };
  }
  if (!preview.balanced) {
    throw new Error('Year-end closing entry does not balance');
  }

  const year = asOfDate.slice(0, 4);
  const existing = await db.get(
    `SELECT id FROM journal_entries WHERE entity_id = ? AND je_number = ?`,
    [entityId, `YEC-${year}`]
  );
  if (existing) {
    throw new Error(`Year-end close for ${year} already posted`);
  }

  const jeId = `je-${uuidv4()}`;
  const jeNumber = `YEC-${year}`;

  await db.run(
    `INSERT INTO journal_entries
     (id, entity_id, je_number, description, posting_date, status, created_by, memo, total_debit, total_credit)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [
      jeId,
      entityId,
      jeNumber,
      `Year-end close ${year}`,
      asOfDate,
      userId,
      memo || 'AUTO-YEAR-END-CLOSE',
      preview.totalDebit,
      preview.totalCredit,
    ]
  );

  for (let i = 0; i < preview.closingLines.length; i++) {
    const line = preview.closingLines[i];
    await db.run(
      `INSERT INTO journal_entry_lines
       (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        `jel-${uuidv4()}`,
        jeId,
        line.accountId,
        line.debit || 0,
        line.credit || 0,
        `Close ${line.accountNumber} to retained earnings`,
        i + 1,
      ]
    );
  }

  await postJournalEntryToGl(db, { journalId: jeId, entityId, userId });

  return {
    posted: true,
    journalId: jeId,
    jeNumber,
    netIncome: preview.netIncome,
    ...preview,
  };
}
