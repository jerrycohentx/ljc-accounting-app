import { v4 as uuidv4 } from 'uuid';

/**
 * Detect bank chargebacks (e.g. Wellington chargebacks on Simmons statement)
 * and queue them for review / automatic reversal posting.
 */

export async function detectAndQueueChargeback(db, { entityId, fitid, amount, description, date, userId }) {
  const existing = await db.get(
    'SELECT id FROM chargeback_events WHERE entity_id = ? AND bank_fitid = ?',
    [entityId, fitid]
  );
  if (existing) return existing;

  const id = `cb-${uuidv4()}`;
  await db.run(
    `INSERT INTO chargeback_events (id, entity_id, bank_fitid, amount, description, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    [id, entityId, fitid, Math.abs(Number(amount)), description]
  );
  return { id, status: 'pending' };
}

export async function listPendingChargebacks(db, entityId) {
  return db.all(
    "SELECT * FROM chargeback_events WHERE entity_id = ? AND status = 'pending' ORDER BY detected_at DESC",
    [entityId]
  );
}
