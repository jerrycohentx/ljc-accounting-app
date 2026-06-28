/**
 * Receipt / invoice collector schema (WellyBox-style automated bookkeeping).
 *
 * Tables:
 * - inbox_connections : connected email / cloud / accounting accounts per entity
 * - receipts          : extracted receipts & invoices (integer-cents money)
 * - receipt_sync_logs : audit trail of inbox scans and accounting pushes
 *
 * Written to be compatible with both SQLite (local) and PostgreSQL (cloud),
 * using the same idioms as config/plaid-schema.js. Money is stored as integer
 * minor units (cents) to satisfy the zero-floating-point bookkeeping rule.
 */

export const RECEIPTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS inbox_connections (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  account_label TEXT,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  status TEXT DEFAULT 'CONNECTED',
  last_sync_at TIMESTAMP,
  created_by TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inbox_connections_entity ON inbox_connections(entity_id);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  source_connection_id TEXT,
  vendor TEXT,
  receipt_date DATE,
  currency TEXT DEFAULT 'USD',
  subtotal_cents INTEGER DEFAULT 0,
  tax_cents INTEGER DEFAULT 0,
  total_cents INTEGER DEFAULT 0,
  category TEXT,
  confidence_score REAL DEFAULT 0,
  status TEXT DEFAULT 'PENDING_REVIEW',
  needs_review BOOLEAN DEFAULT TRUE,
  raw_text TEXT,
  file_name TEXT,
  file_mime TEXT,
  file_data TEXT,
  external_ref TEXT,
  journal_entry_id TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_receipts_entity ON receipts(entity_id);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(entity_id, status);
CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(receipt_date);

CREATE TABLE IF NOT EXISTS receipt_sync_logs (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  connection_id TEXT,
  provider TEXT,
  action TEXT NOT NULL,
  discovered INTEGER DEFAULT 0,
  imported INTEGER DEFAULT 0,
  duplicates INTEGER DEFAULT 0,
  status TEXT DEFAULT 'OK',
  message TEXT,
  created_by TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_receipt_sync_logs_entity ON receipt_sync_logs(entity_id, created_at);
`;

export async function ensureReceiptsSchema(db) {
  const statements = RECEIPTS_SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.exec(statement);
  }
}
