/**
 * Property management report import schema.
 *
 * mgmt_report_imports: one row per uploaded report (one property, one
 * period). Parsed income/expense/other line items are stored as JSON so the
 * review screen can show and, if needed, correct them before a journal
 * entry is generated. Money is integer cents throughout.
 *
 * Written the same way as config/receipts-schema.js — compatible with both
 * SQLite (local) and PostgreSQL (cloud).
 */

export const MGMT_REPORTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mgmt_report_imports (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL DEFAULT 'UNKNOWN',
  management_company TEXT,
  property_raw TEXT,
  property_canonical TEXT,
  property_matched BOOLEAN DEFAULT FALSE,
  period_start DATE,
  period_end DATE,
  income_lines TEXT,
  expense_lines TEXT,
  other_lines TEXT,
  total_income_cents INTEGER DEFAULT 0,
  total_expense_cents INTEGER DEFAULT 0,
  net_income_cents INTEGER DEFAULT 0,
  confidence_score REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  needs_review BOOLEAN DEFAULT TRUE,
  notes TEXT,
  raw_text TEXT,
  file_name TEXT,
  file_mime TEXT,
  file_data TEXT,
  journal_entry_id TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mgmt_report_imports_entity ON mgmt_report_imports(entity_id);
CREATE INDEX IF NOT EXISTS idx_mgmt_report_imports_status ON mgmt_report_imports(entity_id, status);
`;

export async function ensureMgmtReportsSchema(db) {
  const statements = MGMT_REPORTS_SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.exec(statement);
  }
}
