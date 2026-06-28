import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isPostgres } from '../config/database.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(ROOT, 'db', 'backups');
const MANIFEST_FILE = path.join(BACKUP_DIR, 'manifest.json');
const SQLITE_DB = path.join(ROOT, 'db', 'accounting.db');
const INTERVAL_MS = Math.max(5, Number(process.env.BACKUP_INTERVAL_MINUTES || 60)) * 60 * 1000;
const RETENTION = Math.max(5, Number(process.env.BACKUP_RETENTION_COUNT || 30));

let timer = null;
let lastBackupAt = null;
let lastBackupError = null;
let backupRunning = false;

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

async function backupPostgres(reason) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const slug = timestampSlug();
  const filename = `postgres-${slug}-${reason}.sql`;
  const dest = path.join(BACKUP_DIR, filename);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  try {
    const { stdout } = await execFileAsync('pg_dump', ['--no-owner', '--no-acl', url], {
      maxBuffer: 64 * 1024 * 1024,
      env: process.env,
    });
    fs.writeFileSync(dest, stdout);
  } catch (err) {
    // Render/slim images may lack pg_dump — fall back to JSON snapshot
    const { getDatabase } = await import('../config/database.js');
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
    const jsonName = `postgres-${slug}-${reason}.json`;
    const jsonDest = path.join(BACKUP_DIR, jsonName);
    fs.writeFileSync(jsonDest, JSON.stringify(snapshot));
    const stat = fs.statSync(jsonDest);
    return { filename: jsonName, path: jsonDest, sizeBytes: stat.size, databaseType: 'postgres-json', note: `pg_dump unavailable (${err.message})` };
  }

  const stat = fs.statSync(dest);
  return { filename, path: dest, sizeBytes: stat.size, databaseType: 'postgres-sql' };
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

export async function runBackup({ reason = 'manual', userId = null } = {}) {
  if (backupRunning) {
    return { skipped: true, reason: 'backup already in progress' };
  }
  backupRunning = true;
  try {
    const result = isPostgres() ? await backupPostgres(reason) : await backupSqlite(reason);
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

export function listBackups(limit = 20) {
  const entries = readManifest().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return entries.slice(0, limit).map((e) => ({
    ...e,
    sizeLabel: formatBytes(e.sizeBytes),
  }));
}

export function getBackupStatus() {
  const manifest = readManifest().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = manifest[0] || null;
  if (!lastBackupAt && latest) lastBackupAt = latest.createdAt;
  return {
    backupDir: BACKUP_DIR,
    intervalMinutes: INTERVAL_MS / 60000,
    retentionCount: RETENTION,
    autoBackupEnabled: timer != null,
    lastBackupAt: lastBackupAt || latest?.createdAt || null,
    lastBackup: latest,
    lastBackupError,
    backupCount: manifest.length,
    backupRunning,
  };
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

  // Initial backup shortly after startup (loan tracker pattern)
  setTimeout(tick, 15000);
  timer = setInterval(tick, INTERVAL_MS);
  console.log(`✓ Auto backup every ${INTERVAL_MS / 60000} minutes → ${BACKUP_DIR}`);
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
