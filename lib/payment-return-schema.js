const PAYMENT_RETURN_ALTER = [
  'ALTER TABLE payment_returns ADD COLUMN bank_fitid TEXT',
  'ALTER TABLE payment_returns ADD COLUMN match_rule_id TEXT',
  'ALTER TABLE payment_returns ADD COLUMN matched_at TIMESTAMP',
  'ALTER TABLE payment_returns ADD COLUMN posted_at TIMESTAMP',
  'ALTER TABLE payment_returns ADD COLUMN synced_at TIMESTAMP',
  'ALTER TABLE payment_returns ADD COLUMN amount_cents INTEGER',
  'ALTER TABLE payment_returns ADD COLUMN sync_status TEXT',
  'ALTER TABLE payment_returns ADD COLUMN journal_entry_id TEXT',
];

export const PAYMENT_RETURN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS payment_returns (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL DEFAULT 'ent-ljc',
  return_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  amount_cents INTEGER,
  return_amount_cents INTEGER,
  bank_fee_cents INTEGER DEFAULT 0,
  description TEXT,
  bank_reference TEXT,
  bank_fitid TEXT,
  import_transaction_id TEXT,
  journal_entry_id TEXT,
  return_journal_id TEXT,
  fee_journal_id TEXT,
  loan_id TEXT,
  loan_num TEXT,
  holdback_draw_id TEXT,
  match_rule_id TEXT,
  recorded_at TEXT,
  matched_at TIMESTAMP,
  posted_at TIMESTAMP,
  synced_at TIMESTAMP,
  synced_to_loan_tracker INTEGER DEFAULT 0,
  sync_status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
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
  for (const statement of PAYMENT_RETURN_ALTER) {
    try {
      await db.run(statement);
    } catch (error) {
      if (!/duplicate column|already exists/i.test(error.message)) {
        console.warn('payment_returns alter:', error.message);
      }
    }
  }
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_payment_returns_entity ON payment_returns(entity_id)',
    'CREATE INDEX IF NOT EXISTS idx_payment_returns_sync ON payment_returns(entity_id, sync_status)',
    'CREATE INDEX IF NOT EXISTS idx_payment_returns_fitid ON payment_returns(bank_fitid)',
  ];
  for (const statement of indexes) {
    try {
      await db.exec(statement);
    } catch (error) {
      if (!/already exists/i.test(error.message)) {
        console.warn('payment_returns index:', error.message);
      }
    }
  }
  try {
    await db.run('ALTER TABLE import_transactions ADD COLUMN payment_return_id TEXT');
  } catch (error) {
    if (!/duplicate column|already exists/i.test(error.message)) {
      console.warn('import_transactions.payment_return_id:', error.message);
    }
  }
  // Backfill sync_status from legacy synced_to_loan_tracker flag.
  try {
    await db.run(
      `UPDATE payment_returns SET sync_status = 'synced'
       WHERE sync_status IS NULL AND COALESCE(synced_to_loan_tracker, 0) = 1`
    );
    await db.run(
      `UPDATE payment_returns SET sync_status = 'pending'
       WHERE sync_status IS NULL`
    );
    await db.run(
      `UPDATE payment_returns SET amount_cents = return_amount_cents
       WHERE amount_cents IS NULL AND return_amount_cents IS NOT NULL`
    );
  } catch (error) {
    console.warn('payment_returns backfill:', error.message);
  }
}

/** Normalize legacy + new column names on a payment_returns row. */
export function normalizePaymentReturnRow(row) {
  if (!row) return row;
  return {
    ...row,
    amount_cents: row.amount_cents ?? row.return_amount_cents ?? 0,
    journal_entry_id: row.journal_entry_id ?? row.return_journal_id ?? null,
    sync_status: row.sync_status
      ?? (Number(row.synced_to_loan_tracker) ? 'synced' : 'pending'),
  };
}
