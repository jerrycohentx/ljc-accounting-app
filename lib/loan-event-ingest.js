import { v4 as uuidv4 } from 'uuid';
import { ensureLoanEventSchema } from './loan-event-schema.js';

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

  return {
    accepted: true,
    id,
    idempotencyKey: key,
    eventType,
    status: 'PENDING',
    note: 'Suggestion only — no journal posted automatically',
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
