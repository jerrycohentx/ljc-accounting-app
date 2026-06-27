import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { postJournalEntryToGl } from './post-journal.js';
import { assertPeriodOpen } from './period-lock.js';

const OPENING_EQUITY = '3900';

/**
 * Convert a natural (signed) balance to debit/credit lines.
 * Positive balance = normal side for the account type.
 */
function balanceToLines(account, balance) {
  const amt = new Decimal(balance).abs();
  if (amt.isZero()) return { debit: 0, credit: 0 };

  const isDebitNormal = account.normal_balance === 'DEBIT';
  const positive = new Decimal(balance).gte(0);

  if (isDebitNormal) {
    return positive
      ? { debit: amt.toFixed(2), credit: 0 }
      : { debit: 0, credit: amt.toFixed(2) };
  }
  return positive
    ? { debit: 0, credit: amt.toFixed(2) }
    : { debit: amt.toFixed(2), credit: 0 };
}

export async function previewOpeningBalances(db, entityId, { asOfDate, balances }) {
  const lines = [];
  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  const warnings = [];

  for (const row of balances) {
    const account = await db.get(
      'SELECT * FROM accounts WHERE entity_id = ? AND account_number = ?',
      [entityId, row.accountNumber]
    );
    if (!account) {
      warnings.push(`Account ${row.accountNumber} not found`);
      continue;
    }
    if (account.account_number === OPENING_EQUITY) {
      warnings.push(`Skipping ${OPENING_EQUITY} — used as offset`);
      continue;
    }

    const { debit, credit } = balanceToLines(account, row.balance);
    if (Number(debit) === 0 && Number(credit) === 0) continue;

    lines.push({
      accountNumber: account.account_number,
      accountName: account.account_name,
      accountId: account.id,
      debit,
      credit,
    });
    totalDebit = totalDebit.plus(debit || 0);
    totalCredit = totalCredit.plus(credit || 0);
  }

  const diff = totalDebit.minus(totalCredit);
  if (!diff.isZero()) {
    const equity = await db.get(
      'SELECT * FROM accounts WHERE entity_id = ? AND account_number = ?',
      [entityId, OPENING_EQUITY]
    );
    if (!equity) {
      warnings.push(`${OPENING_EQUITY} Opening Balance Equity account missing`);
    } else if (diff.gt(0)) {
      lines.push({
        accountNumber: equity.account_number,
        accountName: equity.account_name,
        accountId: equity.id,
        debit: 0,
        credit: diff.toFixed(2),
        isOffset: true,
      });
      totalCredit = totalCredit.plus(diff);
    } else {
      lines.push({
        accountNumber: equity.account_number,
        accountName: equity.account_name,
        accountId: equity.id,
        debit: diff.abs().toFixed(2),
        credit: 0,
        isOffset: true,
      });
      totalDebit = totalDebit.plus(diff.abs());
    }
  }

  return {
    asOfDate,
    lines,
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
    balanced: totalDebit.equals(totalCredit),
    warnings,
  };
}

export async function postOpeningBalances(db, { entityId, asOfDate, balances, userId, memo }) {
  await assertPeriodOpen(db, entityId, asOfDate);

  const preview = await previewOpeningBalances(db, entityId, { asOfDate, balances });
  if (!preview.balanced) {
    throw new Error('Opening balances do not balance after equity offset');
  }
  if (preview.lines.length < 2) {
    throw new Error('At least two opening balance lines required');
  }

  const existing = await db.get(
    `SELECT id FROM journal_entries WHERE entity_id = ? AND je_number LIKE 'OB-%' AND status = 'POSTED' LIMIT 1`,
    [entityId]
  );
  if (existing) {
    throw new Error('Opening balance entry already posted for this entity; reverse it first');
  }

  const jeId = `je-${uuidv4()}`;
  const jeNumber = `OB-${asOfDate.replace(/-/g, '')}`;

  await db.run(
    `INSERT INTO journal_entries
     (id, entity_id, je_number, description, posting_date, status, created_by, memo, total_debit, total_credit)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [
      jeId,
      entityId,
      jeNumber,
      `Opening balances as of ${asOfDate}`,
      asOfDate,
      userId,
      memo || 'QBO migration opening balances',
      preview.totalDebit,
      preview.totalCredit,
    ]
  );

  for (let i = 0; i < preview.lines.length; i++) {
    const line = preview.lines[i];
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
        `Opening balance — ${line.accountNumber}`,
        i + 1,
      ]
    );
  }

  await postJournalEntryToGl(db, { journalId: jeId, entityId, userId });

  return { journalId: jeId, jeNumber, ...preview };
}

/** Parse CSV text: account_number,balance per line (optional header). */
export function parseOpeningBalanceCsv(text) {
  const rows = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^account/i.test(line)) continue;
    const [accountNumber, balanceStr] = line.split(',').map((s) => s.trim());
    if (!accountNumber) continue;
    const balance = Number(balanceStr);
    if (Number.isNaN(balance)) continue;
    rows.push({ accountNumber, balance });
  }
  return rows;
}
