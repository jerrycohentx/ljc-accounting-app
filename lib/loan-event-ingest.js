import { v4 as uuidv4 } from 'uuid';
import { ensureLoanEventSchema } from './loan-event-schema.js';
import { matchPaymentReturnFromLoanEvent } from './bank-return-match.js';
import { isPaymentEvent, draftJournalFromLoanEvent } from './loan-event-journal.js';

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

  // Payment / payoff events auto-draft a balanced JE for review (never posted).
  let draft = null;
  let draftError = null;
  if (isPaymentEvent(eventType)) {
    try {
      draft = await draftJournalFromLoanEvent(db, { payload, eventId: id });
      if (draft.drafted) {
        await db.run(
          "UPDATE loan_tracker_events SET journal_entry_id = ?, status = 'DRAFTED' WHERE id = ?",
          [draft.journalId, id]
        );
      }
    } catch (err) {
      // Keep the event (idempotency stands) but surface why no draft was made.
      draftError = err.message;
      await db.run(
        "UPDATE loan_tracker_events SET status = 'DRAFT_FAILED' WHERE id = ?",
        [id]
      );
      console.warn('loan-event auto-draft failed:', err.message);
    }
  }

  return {
    accepted: true,
    id,
    idempotencyKey: key,
    eventType,
    status: draft?.drafted ? 'DRAFTED' : (draftError ? 'DRAFT_FAILED' : 'PENDING'),
    paymentReturnMatch,
    draft: draft?.drafted
      ? { journalId: draft.journalId, jeNumber: draft.jeNumber, totalCents: draft.totalCents, lines: draft.lines }
      : null,
    draftError,
    note: draft?.drafted
      ? 'DRAFT journal entry created for review — not posted. Approve in the accounting app to post.'
      : (draftError
        ? `Event stored; auto-draft failed: ${draftError}`
        : 'Suggestion only — no journal posted automatically'),
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
