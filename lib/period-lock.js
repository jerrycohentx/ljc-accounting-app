import { v4 as uuidv4 } from 'uuid';
import { assertPeriodCloseable } from './period-integrity.js';

/** First and last calendar day for the month containing dateStr (YYYY-MM-DD). */
export function monthBounds(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return {
    periodStart: `${y}-${String(m).padStart(2, '0')}-01`,
    periodEnd: `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  };
}

export async function assertPeriodOpen(db, entityId, postingDate) {
  const closed = await db.get(
    `SELECT period_start, period_end FROM accounting_periods
     WHERE entity_id = ? AND status = 'CLOSED'
       AND period_start <= ? AND period_end >= ?`,
    [entityId, postingDate, postingDate]
  );
  if (closed) {
    throw new Error(
      `Cannot post to closed period ${closed.period_start} through ${closed.period_end}`
    );
  }
}

export async function listPeriods(db, entityId) {
  return db.all(
    `SELECT * FROM accounting_periods WHERE entity_id = ? ORDER BY period_start DESC`,
    [entityId]
  );
}

export async function closePeriod(db, { entityId, periodStart, periodEnd, userId, notes = null }) {
  const existing = await db.get(
    `SELECT * FROM accounting_periods WHERE entity_id = ? AND period_start = ? AND period_end = ?`,
    [entityId, periodStart, periodEnd]
  );

  if (existing?.status === 'CLOSED') {
    // Re-verify: a legacy CLOSE without $0 recons is not trustworthy.
    const integrity = await assertPeriodCloseable(db, { entityId, periodStart, periodEnd });
    return {
      periodId: existing.id,
      alreadyClosed: true,
      integrity,
      isClosed: true,
    };
  }

  const integrity = await assertPeriodCloseable(db, { entityId, periodStart, periodEnd });

  const periodId = existing?.id || `period-${uuidv4()}`;
  if (existing) {
    await db.run(
      `UPDATE accounting_periods SET status = 'CLOSED', closed_by = ?, closed_at = CURRENT_TIMESTAMP, notes = COALESCE(?, notes)
       WHERE id = ?`,
      [userId, notes, periodId]
    );
  } else {
    await db.run(
      `INSERT INTO accounting_periods (id, entity_id, period_start, period_end, status, closed_by, closed_at, notes)
       VALUES (?, ?, ?, ?, 'CLOSED', ?, CURRENT_TIMESTAMP, ?)`,
      [periodId, entityId, periodStart, periodEnd, userId, notes]
    );
  }

  return {
    periodId,
    periodStart,
    periodEnd,
    closed: true,
    isClosed: true,
    integrity,
  };
}

export async function reopenPeriod(db, { entityId, periodStart, periodEnd }) {
  const existing = await db.get(
    `SELECT * FROM accounting_periods WHERE entity_id = ? AND period_start = ? AND period_end = ?`,
    [entityId, periodStart, periodEnd]
  );
  if (!existing || existing.status !== 'CLOSED') {
    throw new Error('Period is not closed');
  }

  await db.run(
    `UPDATE accounting_periods SET status = 'OPEN', closed_by = NULL, closed_at = NULL WHERE id = ?`,
    [existing.id]
  );
  return { periodId: existing.id, reopened: true };
}

/** Close the calendar month containing postingDate. */
export async function closeMonthContaining(db, { entityId, postingDate, userId, notes }) {
  const { periodStart, periodEnd } = monthBounds(postingDate);
  return closePeriod(db, { entityId, periodStart, periodEnd, userId, notes });
}
