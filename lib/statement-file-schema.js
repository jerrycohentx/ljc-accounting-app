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

export async function getStatementFile(db, { entityId, accountId, statementDate }) {
  if (!entityId || !accountId || !statementDate) return null;
  const date = String(statementDate).slice(0, 10);
  return db.get(
    `SELECT file_name, file_mime, file_data
       FROM bank_statement_files
      WHERE entity_id = ? AND account_id = ? AND statement_date = ?`,
    [entityId, accountId, date]
  );
}
