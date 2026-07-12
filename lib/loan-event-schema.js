export const LOAN_EVENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS loan_tracker_events (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL DEFAULT 'ent-ljc',
  event_type TEXT NOT NULL,
  loan_id TEXT,
  loan_num TEXT,
  borrower_name TEXT,
  amount_cents INTEGER,
  event_date TEXT,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  idempotency_key TEXT NOT NULL UNIQUE,
  source_app TEXT DEFAULT 'loan-tracker',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

export async function ensureLoanEventSchema(db) {
  try {
    await db.exec(LOAN_EVENT_SCHEMA_SQL);
  } catch (error) {
    if (!/already exists/i.test(error.message)) throw error;
  }
  // journal_entry_id links an ingested event to the DRAFT JE it produced.
  try {
    await db.exec('ALTER TABLE loan_tracker_events ADD COLUMN IF NOT EXISTS journal_entry_id TEXT');
  } catch (error) {
    if (!/already exists|duplicate column/i.test(error.message)) throw error;
  }
}
