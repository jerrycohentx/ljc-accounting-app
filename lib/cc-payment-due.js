/**
 * Credit-card payment-due commitments created during Begin Reconciliation.
 *
 * Creates a DRAFT journal (not posted) dated on the payment date
 * (which may differ from the statement due date):
 *   DR credit-card liability  /  CR pay-from cash
 * so the cash register can show the upcoming outflow for cash planning.
 * When a real posted card payment appears, the draft is removed.
 */

import { v4 as uuidv4 } from 'uuid';

export const CC_PAYMENT_DUE_SOURCE = 'cc-payment-due';

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

export function jeNumberFor(cardAccountNumber, statementDate) {
  const day = String(statementDate || '').slice(0, 10).replace(/-/g, '');
  return `CC-PMT-DUE-${cardAccountNumber}-${day}`;
}

/** Load existing scheduled payment-due draft for a card statement period (if any). */
export async function getCreditCardPaymentDue(db, { entityId, cardAccountId, statementDate }) {
  const card = await db.get(
    `SELECT id, account_number FROM accounts WHERE id = ? AND entity_id = ?`,
    [cardAccountId, entityId]
  );
  if (!card) return null;
  const jeNumber = jeNumberFor(card.account_number, statementDate);
  const je = await db.get(
    `SELECT id, je_number, posting_date, description, status, source
     FROM journal_entries
     WHERE entity_id = ? AND je_number = ? AND status = 'DRAFT' AND source = ?
     LIMIT 1`,
    [entityId, jeNumber, CC_PAYMENT_DUE_SOURCE]
  );
  if (!je) return null;
  const cashLine = await db.get(
    `SELECT jel.account_id, jel.credit AS amount
     FROM journal_entry_lines jel
     JOIN accounts a ON a.id = jel.account_id
     WHERE jel.journal_entry_id = ? AND a.account_type = 'ASSET' AND jel.credit > 0
     LIMIT 1`,
    [je.id]
  );
  const payDate = String(je.posting_date || '').slice(0, 10);
  const dueMatch = String(je.description || '').match(/\bdue\s+(\d{4}-\d{2}-\d{2})\b/i);
  return {
    jeId: je.id,
    jeNumber: je.je_number,
    paymentDate: payDate,
    paymentDueDate: dueMatch?.[1] || payDate,
    amount: round2(cashLine?.amount || 0),
    payFromAccountId: cashLine?.account_id || null,
    cardAccountId,
    statementDate: String(statementDate || '').slice(0, 10),
  };
}

async function deleteDraftJe(db, entityId, jeId) {
  if (!jeId) return;
  await db.run(
    `DELETE FROM journal_entry_lines WHERE journal_entry_id = ?`,
    [jeId]
  );
  await db.run(
    `DELETE FROM journal_entries WHERE id = ? AND entity_id = ? AND status = 'DRAFT' AND source = ?`,
    [jeId, entityId, CC_PAYMENT_DUE_SOURCE]
  );
}

/**
 * Create or refresh the scheduled CC payment draft for a statement period.
 * Pass amount <= 0 to remove any existing draft for that period.
 */
export async function ensureCreditCardPaymentDue(db, {
  entityId,
  cardAccountId,
  payFromAccountId,
  statementDate,
  paymentDueDate,
  paymentDate = null,
  amount,
  userId = 'usr-admin',
}) {
  const stmtDay = String(statementDate || '').slice(0, 10);
  const dueDay = String(paymentDueDate || paymentDate || '').slice(0, 10);
  // Cash register date — when Jerry will actually pay (may differ from statement due date).
  const payDay = String(paymentDate || paymentDueDate || '').slice(0, 10);
  const amt = round2(amount);

  const card = await db.get(
    `SELECT id, account_number, account_name, account_type, normal_balance
     FROM accounts WHERE id = ? AND entity_id = ?`,
    [cardAccountId, entityId]
  );
  if (!card) throw new Error('Credit card account not found');
  if (card.account_type !== 'LIABILITY' && card.normal_balance !== 'CREDIT') {
    throw new Error('Payment due date applies only to credit card (liability) accounts');
  }

  const jeNumber = jeNumberFor(card.account_number, stmtDay);
  const existing = await db.get(
    `SELECT id, status, source FROM journal_entries
     WHERE entity_id = ? AND je_number = ? LIMIT 1`,
    [entityId, jeNumber]
  );

  if (!(amt > 0.005) || !payDay || !payFromAccountId) {
    if (existing?.status === 'DRAFT' && existing.source === CC_PAYMENT_DUE_SOURCE) {
      await deleteDraftJe(db, entityId, existing.id);
      return { removed: true, jeNumber };
    }
    return { skipped: true, reason: 'missing amount, payment date, or pay-from account' };
  }

  const cash = await db.get(
    `SELECT id, account_number, account_name, account_type
     FROM accounts WHERE id = ? AND entity_id = ? AND is_active = 1`,
    [payFromAccountId, entityId]
  );
  if (!cash) throw new Error('Pay-from account not found');
  if (cash.account_type !== 'ASSET') {
    throw new Error('Pay-from account must be a cash / bank asset account');
  }

  const cardLabel = card.account_name || card.account_number;
  const dueNote = dueDay && dueDay !== payDay ? ` · due ${dueDay}` : (dueDay ? ` · due ${dueDay}` : '');
  const description = `Scheduled payment — ${cardLabel} (stmt ${stmtDay})${dueNote}`;

  if (existing && existing.status !== 'DRAFT') {
    // Already posted somehow — do not touch.
    return { skipped: true, reason: 'journal already posted', jeId: existing.id, jeNumber };
  }

  let jeId = existing?.id;
  if (!jeId) {
    jeId = `je-${uuidv4()}`;
    await db.run(
      `INSERT INTO journal_entries
       (id, entity_id, je_number, posting_date, description, status, created_by, source)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
      [jeId, entityId, jeNumber, payDay, description, userId, CC_PAYMENT_DUE_SOURCE]
    );
  } else {
    await db.run(
      `UPDATE journal_entries
       SET posting_date = ?, description = ?, source = ?, status = 'DRAFT'
       WHERE id = ? AND entity_id = ?`,
      [payDay, description, CC_PAYMENT_DUE_SOURCE, jeId, entityId]
    );
    await db.run(`DELETE FROM journal_entry_lines WHERE journal_entry_id = ?`, [jeId]);
  }

  // DR card liability (payment), CR cash — dated on paymentDate for cash planning
  await db.run(
    `INSERT INTO journal_entry_lines
     (id, journal_entry_id, line_number, account_id, debit, credit, description)
     VALUES (?, ?, 1, ?, ?, 0, ?)`,
    [`jel-${uuidv4()}`, jeId, cardAccountId, amt, description]
  );
  await db.run(
    `INSERT INTO journal_entry_lines
     (id, journal_entry_id, line_number, account_id, debit, credit, description)
     VALUES (?, ?, 2, ?, 0, ?, ?)`,
    [`jel-${uuidv4()}`, jeId, payFromAccountId, amt, description]
  );

  return {
    created: !existing,
    updated: !!existing,
    jeId,
    jeNumber,
    paymentDueDate: dueDay || payDay,
    paymentDate: payDay,
    amount: amt,
    payFromAccountId,
    cardAccountId,
  };
}

/**
 * Remove DRAFT payment-due journals when a real posted payment already covers them.
 */
export async function supersedePaidCreditCardPaymentDues(db, entityId, accountId = null) {
  let drafts;
  if (accountId) {
    drafts = await db.all(
      `SELECT DISTINCT je.id, je.je_number, je.posting_date
       FROM journal_entries je
       JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
       WHERE je.entity_id = ? AND je.status = 'DRAFT' AND je.source = ?
         AND jel.account_id = ?`,
      [entityId, CC_PAYMENT_DUE_SOURCE, accountId]
    );
  } else {
    drafts = await db.all(
      `SELECT id, je_number, posting_date FROM journal_entries
       WHERE entity_id = ? AND status = 'DRAFT' AND source = ?`,
      [entityId, CC_PAYMENT_DUE_SOURCE]
    );
  }

  let removed = 0;
  for (const draft of drafts || []) {
    const cashLine = await db.get(
      `SELECT jel.account_id, jel.credit AS amount
       FROM journal_entry_lines jel
       JOIN accounts a ON a.id = jel.account_id
       WHERE jel.journal_entry_id = ? AND a.account_type = 'ASSET' AND jel.credit > 0
       LIMIT 1`,
      [draft.id]
    );
    const cardLine = await db.get(
      `SELECT jel.account_id, jel.debit AS amount
       FROM journal_entry_lines jel
       JOIN accounts a ON a.id = jel.account_id
       WHERE jel.journal_entry_id = ? AND a.account_type = 'LIABILITY' AND jel.debit > 0
       LIMIT 1`,
      [draft.id]
    );
    if (!cashLine || !cardLine) continue;

    const amt = round2(cashLine.amount);
    const due = String(draft.posting_date || '').slice(0, 10);
    const dueMs = Date.parse(`${due}T00:00:00Z`);
    const fromDay = Number.isFinite(dueMs)
      ? new Date(dueMs - 14 * 86400000).toISOString().slice(0, 10)
      : due;
    const toDay = Number.isFinite(dueMs)
      ? new Date(dueMs + 14 * 86400000).toISOString().slice(0, 10)
      : due;
    // Look for a posted payment: CR cash + DR card, same amount, within 14 days of due date.
    const match = await db.get(
      `SELECT je.id
       FROM journal_entries je
       JOIN journal_entry_lines cash ON cash.journal_entry_id = je.id
         AND cash.account_id = ? AND ABS(cash.credit - ?) < 0.005
       JOIN journal_entry_lines card ON card.journal_entry_id = je.id
         AND card.account_id = ? AND ABS(card.debit - ?) < 0.005
       WHERE je.entity_id = ? AND je.status = 'POSTED'
         AND je.posting_date >= ? AND je.posting_date <= ?
       LIMIT 1`,
      [cashLine.account_id, amt, cardLine.account_id, amt, entityId, fromDay, toDay]
    );
    if (match) {
      await deleteDraftJe(db, entityId, draft.id);
      removed += 1;
    }
  }
  return { removed };
}

/**
 * Scheduled DRAFT lines for a register (cash or card), shaped like GL rows.
 */
export async function listScheduledPaymentDueLines(db, entityId, accountId, { startDate, endDate } = {}) {
  await supersedePaidCreditCardPaymentDues(db, entityId, accountId);

  let sql = `
    SELECT
      jel.id,
      je.id AS journal_entry_id,
      je.je_number,
      je.posting_date,
      je.description AS je_description,
      jel.description,
      jel.debit,
      jel.credit,
      je.status,
      je.source
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.entity_id = ?
      AND jel.account_id = ?
      AND je.status = 'DRAFT'
      AND je.source = ?
  `;
  const params = [entityId, accountId, CC_PAYMENT_DUE_SOURCE];
  if (startDate) {
    sql += ' AND je.posting_date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    sql += ' AND je.posting_date <= ?';
    params.push(endDate);
  }
  sql += ' ORDER BY je.posting_date ASC, je.je_number ASC';

  const rows = await db.all(sql, params);
  return (rows || []).map((r) => ({
    ...r,
    id: `sched-${r.id}`,
    scheduled: true,
    reconciliation_status: null,
  }));
}
