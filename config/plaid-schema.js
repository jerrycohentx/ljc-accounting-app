export const PLAID_ITEMS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS plaid_items (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  item_id TEXT NOT NULL UNIQUE,
  access_token_encrypted TEXT NOT NULL,
  institution_id TEXT,
  institution_name TEXT,
  sync_cursor TEXT,
  created_by TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_plaid_items_entity ON plaid_items(entity_id);
`;

export async function ensurePlaidSchema(db) {
  const statements = PLAID_ITEMS_TABLE_SQL.split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.exec(statement);
  }
}
