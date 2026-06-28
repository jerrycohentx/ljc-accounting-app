/**
 * Schema extensions for full QBO replacement: bank rules, chargebacks,
 * interest accrual schedules, import offset accounts.
 */

export const QBO_REPLACEMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bank_categorization_rules (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  match_type TEXT DEFAULT 'contains' CHECK(match_type IN ('contains', 'starts_with', 'regex', 'exact')),
  offset_account_number TEXT,
  offset_account_id TEXT,
  transfer_account_number TEXT,
  is_transfer BOOLEAN DEFAULT FALSE,
  is_chargeback BOOLEAN DEFAULT FALSE,
  priority INTEGER DEFAULT 100,
  label TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bank_rules_entity ON bank_categorization_rules(entity_id, priority);

CREATE TABLE IF NOT EXISTS chargeback_events (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  bank_fitid TEXT,
  original_je_id TEXT,
  reversal_je_id TEXT,
  amount NUMERIC(19,2) NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'posted', 'rejected')),
  detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  posted_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chargeback_entity ON chargeback_events(entity_id, status);

CREATE TABLE IF NOT EXISTS loan_accrual_schedules (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  loan_id TEXT,
  loan_num TEXT,
  principal NUMERIC(19,2) NOT NULL,
  annual_rate_bps INTEGER NOT NULL,
  income_account_id TEXT,
  receivable_account_id TEXT,
  last_accrual_date DATE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_accrual_entity ON loan_accrual_schedules(entity_id);

CREATE TABLE IF NOT EXISTS accounting_periods (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'CLOSED')),
  closed_by TEXT,
  closed_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(entity_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_periods_entity ON accounting_periods(entity_id, period_end);
`;

const ALTER_IMPORT = [
  'ALTER TABLE import_transactions ADD COLUMN offset_account_id TEXT',
  'ALTER TABLE import_transactions ADD COLUMN suggested_rule_id TEXT',
];

const ALTER_JOURNALS = [
  'ALTER TABLE journal_entries ADD COLUMN reverses_je_id TEXT',
  'ALTER TABLE journal_entries ADD COLUMN reversed_by_je_id TEXT',
];

export async function ensureQboReplacementSchema(db) {
  const statements = QBO_REPLACEMENT_SCHEMA_SQL.split(';').map((s) => s.trim()).filter(Boolean);
  for (const statement of statements) {
    await db.exec(statement);
  }
  for (const statement of ALTER_IMPORT) {
    try {
      await db.exec(statement);
    } catch (error) {
      if (!/duplicate column|already exists/i.test(error.message)) {
        console.warn('import_transactions ALTER:', error.message);
      }
    }
  }
  for (const statement of ALTER_JOURNALS) {
    try {
      await db.exec(statement);
    } catch (error) {
      if (!/duplicate column|already exists/i.test(error.message)) {
        console.warn('journal_entries ALTER:', error.message);
      }
    }
  }
}
