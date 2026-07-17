import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isPostgres, getDatabase } from '../config/database.js';
import { ensureBackupsSchema } from '../config/backups-schema.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(ROOT, 'db', 'backups');
const MANIFEST_FILE = path.join(BACKUP_DIR, 'manifest.json');
const SQLITE_DB = path.join(ROOT, 'db', 'accounting.db');
const INTERVAL_MS = Math.max(5, Number(process.env.BACKUP_INTERVAL_MINUTES || 60)) * 60 * 1000;
// Snapshots are stored INSIDE the production database, so retention is a disk
// budget, not a nicety: 30 hourly ~20MB snapshots = 815MB — which filled the
// 1GB disk on 2026-07-16 and took the whole app down (Postgres shed
// connections, the client crash-looped the process). Keep 3.
const RETENTION = Math.max(1, Number(process.env.BACKUP_RETENTION_COUNT || 3));

let timer = null;
let lastBackupAt = null;
let lastBackupError = null;
let backupRunning = false;
// In-memory metadata cache (no content) so getBackupStatus()/listBackups() stay synchronous.
let pgCache = [];

function toIso(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  try {
    return new Date(v).toISOString();
  } catch {
    return String(v);
  }
}

function readManifest() {
  try {
    if (!fs.existsSync(MANIFEST_FILE)) return [];
    return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeManifest(entries) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(entries, null, 2));
}

function timestampSlug(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- SQLite (local) — file-based backups -----------------------------------

async function backupSqlite(reason) {
  if (!fs.existsSync(SQLITE_DB)) {
    throw new Error('SQLite database file not found');
  }
  const slug = timestampSlug();
  const filename = `accounting-${slug}-${reason}.db`;
  const dest = path.join(BACKUP_DIR, filename);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(SQLITE_DB, dest);
  const stat = fs.statSync(dest);
  return { filename, path: dest, sizeBytes: stat.size, databaseType: 'sqlite' };
}

function pruneOldBackups(entries) {
  if (entries.length <= RETENTION) return entries;
  const sorted = [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const keep = sorted.slice(0, RETENTION);
  const drop = sorted.slice(RETENTION);
  for (const row of drop) {
    const full = path.join(BACKUP_DIR, row.filename);
    try {
      if (fs.existsSync(full)) fs.unlinkSync(full);
    } catch {
      /* ignore */
    }
  }
  return keep;
}

// ---- PostgreSQL (cloud) — durable backups stored in the database -----------

async function backupPostgresContent(reason) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const slug = timestampSlug();

  try {
    // Exclude app_backups so a snapshot never contains earlier snapshots.
    const { stdout } = await execFileAsync(
      'pg_dump',
      ['--no-owner', '--no-acl', '--exclude-table=app_backups', url],
      { maxBuffer: 128 * 1024 * 1024, env: process.env },
    );
    return { filename: `postgres-${slug}-${reason}.sql`, content: stdout, databaseType: 'postgres-sql' };
  } catch (err) {
    // Render/slim images may lack pg_dump — fall back to a JSON snapshot.
    const db = await getDatabase();
    const tables = ['entities', 'users', 'accounts', 'journal_entries', 'journal_entry_lines', 'general_ledger'];
    const snapshot = { exportedAt: new Date().toISOString(), tables: {} };
    for (const table of tables) {
      try {
        snapshot.tables[table] = await db.all(`SELECT * FROM ${table}`);
      } catch {
        snapshot.tables[table] = [];
      }
    }
    return {
      filename: `postgres-${slug}-${reason}.json`,
      content: JSON.stringify(snapshot),
      databaseType: 'postgres-json',
      note: `pg_dump unavailable (${err.message})`,
    };
  }
}

async function prunePgBackups(db) {
  const rows = await db.all('SELECT id FROM app_backups ORDER BY created_at DESC');
  if (rows.length <= RETENTION) return;
  const toDelete = rows.slice(RETENTION).map((r) => r.id);
  for (const id of toDelete) {
    await db.run('DELETE FROM app_backups WHERE id = ?', id);
  }
}

async function refreshPgCache(db) {
  const rows = await db.all(
    'SELECT id, filename, created_at, reason, database_type, size_bytes, created_by, note FROM app_backups ORDER BY created_at DESC',
  );
  pgCache = rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    createdAt: toIso(r.created_at),
    reason: r.reason,
    databaseType: r.database_type,
    sizeBytes: Number(r.size_bytes) || 0,
    createdBy: r.created_by,
    note: r.note,
  }));
  if (!lastBackupAt && pgCache[0]) lastBackupAt = pgCache[0].createdAt;
}

/** Hydrate the in-memory cache from the database at startup. */
export async function initBackupStore() {
  if (!isPostgres()) return;
  try {
    const db = await getDatabase();
    await ensureBackupsSchema(db);
    await refreshPgCache(db);
  } catch (err) {
    console.warn('Backup store init failed:', err.message);
  }
}

// ---- Public API ------------------------------------------------------------

export async function runBackup({ reason = 'manual', userId = null } = {}) {
  if (backupRunning) {
    return { skipped: true, reason: 'backup already in progress' };
  }
  backupRunning = true;
  try {
    if (isPostgres()) {
      const res = await backupPostgresContent(reason);
      const sizeBytes = Buffer.byteLength(res.content, 'utf8');
      const id = `bak-${timestampSlug()}`;
      const createdAt = new Date().toISOString();
      const db = await getDatabase();
      await ensureBackupsSchema(db);
      await db.run(
        'INSERT INTO app_backups (id, filename, created_at, reason, database_type, size_bytes, created_by, note, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, res.filename, createdAt, reason, res.databaseType, sizeBytes, userId, res.note || null, res.content,
      );
      await prunePgBackups(db);
      await refreshPgCache(db);
      lastBackupAt = createdAt;
      lastBackupError = null;
      return {
        ok: true,
        backup: { id, filename: res.filename, createdAt, reason, sizeBytes, databaseType: res.databaseType, createdBy: userId, note: res.note || null },
      };
    }

    // SQLite / local — file-based
    const result = await backupSqlite(reason);
    const entry = {
      id: `bak-${timestampSlug()}`,
      filename: result.filename,
      createdAt: new Date().toISOString(),
      reason,
      sizeBytes: result.sizeBytes,
      databaseType: result.databaseType,
      createdBy: userId,
      note: result.note || null,
    };
    const manifest = pruneOldBackups([entry, ...readManifest()]);
    writeManifest(manifest);
    lastBackupAt = entry.createdAt;
    lastBackupError = null;
    return { ok: true, backup: entry };
  } catch (err) {
    lastBackupError = err.message;
    throw err;
  } finally {
    backupRunning = false;
  }
}

function metaList() {
  return isPostgres()
    ? pgCache
    : readManifest().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function listBackups(limit = 20) {
  return metaList()
    .slice(0, limit)
    .map((e) => ({ ...e, sizeLabel: formatBytes(e.sizeBytes) }));
}

export function getBackupStatus() {
  const entries = metaList();
  const latest = entries[0] || null;
  if (!lastBackupAt && latest) lastBackupAt = latest.createdAt;
  return {
    backupDir: isPostgres() ? 'postgres:app_backups' : BACKUP_DIR,
    intervalMinutes: INTERVAL_MS / 60000,
    retentionCount: RETENTION,
    autoBackupEnabled: timer != null,
    lastBackupAt: lastBackupAt || latest?.createdAt || null,
    lastBackup: latest,
    lastBackupError,
    backupCount: entries.length,
    backupRunning,
    durable: isPostgres(),
    storageLabel: isPostgres() ? 'PostgreSQL (survives restarts)' : 'local file (db/backups)',
  };
}

/** Returns { filename, databaseType, content } for download, or null. */
export async function getBackupContent(id) {
  if (isPostgres()) {
    const db = await getDatabase();
    const row = await db.get('SELECT filename, database_type, content FROM app_backups WHERE id = ?', id);
    if (!row) return null;
    return { filename: row.filename, databaseType: row.database_type, content: row.content };
  }
  const entry = readManifest().find((e) => e.id === id);
  if (!entry) return null;
  const full = path.join(BACKUP_DIR, entry.filename);
  if (!fs.existsSync(full)) return null;
  return { filename: entry.filename, databaseType: entry.databaseType, content: fs.readFileSync(full) };
}

export function startAutoBackup() {
  if (process.env.DISABLE_AUTO_BACKUP === '1') {
    console.log('Auto backup disabled (DISABLE_AUTO_BACKUP=1)');
    return;
  }
  if (timer) return;

  const tick = async () => {
    try {
      const result = await runBackup({ reason: 'auto' });
      if (result.ok) {
        console.log(`✓ Auto backup: ${result.backup.filename}`);
      }
    } catch (err) {
      console.warn('Auto backup failed:', err.message);
    }
  };

  // Hydrate the durable store, then take an initial backup shortly after startup.
  initBackupStore().finally(() => {
    setTimeout(tick, 15000);
  });
  timer = setInterval(tick, INTERVAL_MS);
  console.log(`✓ Auto backup every ${INTERVAL_MS / 60000} minutes (durable: ${isPostgres() ? 'PostgreSQL' : 'local file'})`);
}

export function stopAutoBackup() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
