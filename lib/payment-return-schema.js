export const PAYMENT_RETURN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS payment_returns (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL DEFAULT 'ent-ljc',
  return_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sync_status TEXT NOT NULL DEFAULT 'pending',
  amount_cents INTEGER NOT NULL,
  description TEXT,
  bank_reference TEXT,
  bank_fitid TEXT,
  import_transaction_id TEXT,
  journal_entry_id TEXT,
  loan_id TEXT,
  loan_num TEXT,
  holdback_draw_id TEXT,
  match_rule_id TEXT,
  recorded_at TEXT,
  matched_at TIMESTAMP,
  posted_at TIMESTAMP,
  synced_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payment_returns_entity ON payment_returns(entity_id);
CREATE INDEX IF NOT EXISTS idx_payment_returns_sync ON payment_returns(entity_id, sync_status);
CREATE INDEX IF NOT EXISTS idx_payment_returns_fitid ON payment_returns(bank_fitid);
`;

export async function ensurePaymentReturnSchema(db) {
  const statements = PAYMENT_RETURN_SCHEMA_SQL.split(';').map((s) => s.trim()).filter(Boolean);
  for (const statement of statements) {
    try {
      await db.exec(statement);
    } catch (error) {
      if (!/already exists/i.test(error.message)) throw error;
    }
  }
  try {
    await db.run('ALTER TABLE import_transactions ADD COLUMN payment_return_id TEXT');
  } catch (error) {
    if (!/duplicate column|already exists/i.test(error.message)) {
      console.warn('import_transactions.payment_return_id:', error.message);
    }
  }
}
