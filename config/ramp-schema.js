/**
 * Ramp integration schema.
 *
 * One connection row per entity holds encrypted OAuth client credentials plus
 * sync bookkeeping (cursor page + last-sync watermark). Ramp card transactions
 * are deduped through the shared import_transactions.fitid (`ramp-<id>`), so no
 * separate transaction mirror table is needed.
 */
export const RAMP_CONNECTIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ramp_connections (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'production',
  client_id_encrypted TEXT NOT NULL,
  client_secret_encrypted TEXT NOT NULL,
  business_name TEXT,
  remote_connection_id TEXT,
  last_synced_at TIMESTAMP,
  last_sync_from TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ramp_connections_entity ON ramp_connections(entity_id);
`;

export async function ensureRampSchema(db) {
  const statements = RAMP_CONNECTIONS_TABLE_SQL.split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.exec(statement);
  }
}
