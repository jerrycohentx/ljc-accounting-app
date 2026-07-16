import { v4 as uuidv4 } from 'uuid';
import { ensureLoanEventSchema } from './loan-event-schema.js';
import { matchPaymentReturnFromLoanEvent } from './bank-return-match.js';

function idempotencyKey(payload) {
  if (payload.idempotencyKey) return payload.idempotencyKey;
  return [
    payload.eventType,
    payload.loanId || '',
    payload.eventDate || '',
    payload.amountCents ?? '',
    payload.reference || '',
  ].join('|').toLowerCase();
}

export async function ingestLoanTrackerEvent(db, payload) {
  await ensureLoanEventSchema(db);
  const eventType = String(payload.eventType || '').trim();
  if (!eventType) throw new Error('eventType required');

  const key = idempotencyKey(payload);
  const existing = await db.get(
    'SELECT id, status FROM loan_tracker_events WHERE idempotency_key = ?',
    [key]
  );
  if (existing) {
    return { duplicate: true, id: existing.id, status: existing.status, idempotencyKey: key };
  }

  const id = `lte-${uuidv4()}`;
  await db.run(
    `INSERT INTO loan_tracker_events
     (id, entity_id, event_type, loan_id, loan_num, borrower_name, amount_cents, event_date, payload_json, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      payload.entityId || 'ent-ljc',
      eventType,
      payload.loanId || null,
      payload.loanNum || null,
      payload.borrowerName || null,
      payload.amountCents ?? null,
      payload.eventDate || null,
      JSON.stringify(payload),
      key,
    ]
  );

  let paymentReturnMatch = null;
  if (['nsf_return', 'ach_return', 'payment_return'].includes(eventType)) {
    try {
      paymentReturnMatch = await matchPaymentReturnFromLoanEvent(db, payload);
    } catch (err) {
      console.warn('loan-event payment return match (non-fatal):', err.message);
    }
  }

  // DATA-ONLY receiver (Jerry's gross-only rule, 2026-07-16): loan payment /
  // payoff events are RECORDED but never drafted as journal entries. The ACH
  // batch reaches the books at its GROSS amount via the bank import; per-loan
  // detail lives in the servicing app. These event rows exist so a bank
  // chargeback can auto-match to the right loan (lib/bank-return-match.js
  // matches NSF amounts against loan_tracker_events).
  return {
    accepted: true,
    id,
    idempotencyKey: key,
    eventType,
    status: 'PENDING',
    paymentReturnMatch,
    draft: null,
    note: 'Recorded for loan matching only — no journal entry is created (gross-only ACH rule).',
  };
}

export async function listLoanTrackerEvents(db, { entityId = 'ent-ljc', status = 'PENDING', limit = 50 } = {}) {
  await ensureLoanEventSchema(db);
  return db.all(
    `SELECT id, entity_id, event_type, loan_id, loan_num, borrower_name, amount_cents, event_date, status, created_at
     FROM loan_tracker_events WHERE entity_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`,
    [entityId, status, limit]
  );
}
