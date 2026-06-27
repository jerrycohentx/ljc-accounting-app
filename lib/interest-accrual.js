import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { postJournalEntryToGl } from './post-journal.js';

/**
 * Monthly interest accrual for notes receivable / loan portfolio.
 * DR Notes Receivable (1310) / CR Interest Income (4000).
 */

function daysBetween(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  return Math.max(0, Math.round((b - a) / 86400000));
}

export async function previewAccrual(db, entityId, asOfDate) {
  const schedules = await db.all(
    'SELECT * FROM loan_accrual_schedules WHERE entity_id = ? AND is_active = 1',
    [entityId]
  );
  const previews = [];
  let totalAccrual = new Decimal(0);

  for (const s of schedules) {
    const from = s.last_accrual_date || `${asOfDate.slice(0, 7)}-01`;
    const days = daysBetween(from, asOfDate);
    if (days <= 0) continue;
    const dailyRate = new Decimal(s.annual_rate_bps).div(10000).div(365);
    const accrual = new Decimal(s.principal).times(dailyRate).times(days);
    previews.push({
      scheduleId: s.id,
      loanNum: s.loan_num,
      principal: Number(s.principal),
      days,
      accrual: accrual.toFixed(2),
    });
    totalAccrual = totalAccrual.plus(accrual);
  }

  return { asOfDate, previews, totalAccrual: totalAccrual.toFixed(2) };
}

export async function postAccrualBatch(db, { entityId, asOfDate, userId }) {
  const { previews, totalAccrual } = await previewAccrual(db, entityId, asOfDate);
  const total = new Decimal(totalAccrual);
  if (total.lte(0)) return { posted: 0, message: 'No accrual due' };

  const nr = await db.get(
    "SELECT id FROM accounts WHERE entity_id = ? AND account_number = '1310'",
    [entityId]
  );
  const income = await db.get(
    "SELECT id FROM accounts WHERE entity_id = ? AND account_number = '4000'",
    [entityId]
  );
  if (!nr || !income) throw new Error('Accrual accounts 1310/4000 not found');

  const jeId = `je-${uuidv4()}`;
  const jeNumber = `ACCR-${asOfDate.replace(/-/g, '')}`;
  const amt = total.toFixed(2);

  await db.run(
    `INSERT INTO journal_entries (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [jeId, entityId, jeNumber, `Interest accrual through ${asOfDate}`, asOfDate, userId, amt, amt, 'AUTO-ACCRUAL']
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number) VALUES (?, ?, ?, ?, 0, ?, 1)`,
    [`jel-${uuidv4()}`, jeId, nr.id, amt, 'Interest accrual - NR']
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number) VALUES (?, ?, ?, 0, ?, ?, 2)`,
    [`jel-${uuidv4()}`, jeId, income.id, amt, 'Interest income accrual']
  );

  await postJournalEntryToGl(db, { journalId: jeId, entityId, userId });

  for (const p of previews) {
    await db.run(
      'UPDATE loan_accrual_schedules SET last_accrual_date = ? WHERE id = ?',
      [asOfDate, p.scheduleId]
    );
  }

  return { posted: 1, jeNumber, totalAccrual: amt, previews };
}
