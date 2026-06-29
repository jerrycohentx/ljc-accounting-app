/**
 * Durable backup storage schema.
 *
 * On the cloud (PostgreSQL on Render) the web instance has an ephemeral disk:
 * any backup written to db/backups/ is wiped on every restart/redeploy/sleep.
 * To make backups survive, each backup snapshot is stored as a row in the
 * managed Postgres database (which persists), and can be downloaded off-site
 * from the Company Backups dialog.
 *
 * NOTE: pg_dump excludes this table (see lib/app-backup.js) so snapshots never
 * contain previous snapshots (which would grow exponentially).
 *
 * Compatible with both SQLite (local) and PostgreSQL (cloud).
 */

export const BACKUPS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_backups (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reason TEXT,
  database_type TEXT,
  size_bytes INTEGER DEFAULT 0,
  created_by TEXT,
  note TEXT,
  content TEXT
);

CREATE INDEX IF NOT EXISTS idx_app_backups_created ON app_backups(created_at);
`;

export async function ensureBackupsSchema(db) {
  const statements = BACKUPS_SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.exec(statement);
  }
}
