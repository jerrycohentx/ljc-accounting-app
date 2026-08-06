/**
 * Storage for the bank-statement PDF that backs a reconciliation, so the
 * statement being reconciled can be shown automatically next to the register
 * on any later visit (not just in the session where it was uploaded).
 *
 * One row per (entity, account, statement date). File bytes are kept as a
 * base64 string in file_data, matching the receipts/file_data pattern already
 * used in this app and compatible with both SQLite (local) and PostgreSQL.
 */

import { v4 as uuidv4 } from 'uuid';

export const STATEMENT_FILE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bank_statement_files (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  statement_date DATE NOT NULL,
  file_name TEXT,
  file_mime TEXT DEFAULT 'application/pdf',
  file_data TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (entity_id, account_id, statement_date)
);

CREATE INDEX IF NOT EXISTS idx_bank_stmt_files_lookup
  ON bank_statement_files(entity_id, account_id, statement_date);
`;

import { normalizeIsoDate } from './bank-statement-view.js';

export async function ensureStatementFileSchema(db) {
  const statements = STATEMENT_FILE_SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.exec(statement);
  }
}

/**
 * Upsert the statement file for a period. Delete-then-insert keeps this
 * portable across SQLite and PostgreSQL (no ON CONFLICT dialect differences).
 */
export async function saveStatementFile(db, {
  entityId,
  accountId,
  statementDate,
  fileName = 'statement.pdf',
  fileMime = 'application/pdf',
  fileDataBase64,
  userId = null,
}) {
  if (!entityId || !accountId || !statementDate || !fileDataBase64) return false;
  const date = String(statementDate).slice(0, 10);
  await db.run(
    'DELETE FROM bank_statement_files WHERE entity_id = ? AND account_id = ? AND statement_date = ?',
    [entityId, accountId, date]
  );
  await db.run(
    `INSERT INTO bank_statement_files
       (id, entity_id, account_id, statement_date, file_name, file_mime, file_data, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [`stmtfile-${uuidv4()}`, entityId, accountId, date, fileName, fileMime, fileDataBase64, userId]
  );
  return true;
}

function daysBetweenIso(a, b) {
  const ms = Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ms)) return Number.POSITIVE_INFINITY;
  return Math.abs(ms) / 86400000;
}

/**
 * Load the statement PDF for a reconcile period.
 * Exact date first; then nearest stored file within fuzzyDays — but ONLY when
 * the stored file is the same calendar year-month as the statement ending date
 * (never attach a May PDF to a January recon).
 *
 * Simmons-style day-1 endings (e.g. Jan cycle → 2026-02-01) may also match a
 * file stored under the prior calendar month.
 */
export async function getStatementFile(db, { entityId, accountId, statementDate, fuzzyDays = 5 }) {
  if (!entityId || !accountId || !statementDate) return null;
  const date = String(statementDate).slice(0, 10);
  const exact = await db.get(
    `SELECT file_name, file_mime, file_data, statement_date
       FROM bank_statement_files
      WHERE entity_id = ? AND account_id = ? AND statement_date = ?`,
    [entityId, accountId, date]
  );
  if (exact?.file_data) {
    return { ...exact, matchedStatementDate: date, fuzzy: false };
  }

  const allowedMonths = new Set([date.slice(0, 7)]);
  if (date.slice(8, 10) === '01') {
    const [y, m] = date.split('-').map(Number);
    const priorM = m === 1 ? 12 : m - 1;
    const priorY = m === 1 ? y - 1 : y;
    allowedMonths.add(`${priorY}-${String(priorM).padStart(2, '0')}`);
  }

  const rows = await db.all(
    `SELECT file_name, file_mime, file_data, statement_date
       FROM bank_statement_files
      WHERE entity_id = ? AND account_id = ?`,
    [entityId, accountId]
  );
  let best = null;
  let bestDays = Number.POSITIVE_INFINITY;
  for (const row of rows || []) {
    const sd = normalizeIsoDate(row.statement_date);
    if (!sd) continue;
    if (!allowedMonths.has(sd.slice(0, 7))) continue;
    const d = daysBetweenIso(sd, date);
    if (d <= fuzzyDays && d < bestDays) {
      best = row;
      bestDays = d;
    }
  }
  if (!best?.file_data) return null;
  return {
    ...best,
    matchedStatementDate: String(best.statement_date).slice(0, 10),
    fuzzy: true,
    requestedStatementDate: date,
  };
}
