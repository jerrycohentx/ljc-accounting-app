import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPgAdapter } from './pg-adapter.js';
import { bootstrapPostgres } from './bootstrap-postgres.js';
import { bootstrapSqlite } from './bootstrap-sqlite.js';
import { isPostgresUrl } from './db-url.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db = null;
let postgresBootstrapped = false;
let sqliteBootstrapped = false;

const usePostgres = isPostgresUrl(process.env.DATABASE_URL);

export function isPostgres() {
  return usePostgres;
}

function ensureDbDirectory() {
  const dbDir = path.join(__dirname, '..', 'db');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

export async function getDatabase() {
  if (db) {
    return db;
  }

  if (usePostgres) {
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    });
    await client.connect();
    db = createPgAdapter(client);

    if (!postgresBootstrapped) {
      await bootstrapPostgres(db);
      postgresBootstrapped = true;
    }

    console.log('✓ Connected to PostgreSQL (cloud)');
  } else {
    ensureDbDirectory();
    db = await open({
      filename: './db/accounting.db',
      driver: sqlite3.Database,
    });
    await db.exec('PRAGMA foreign_keys = ON');

    if (!sqliteBootstrapped) {
      await bootstrapSqlite(db);
      sqliteBootstrapped = true;
    }

    console.log('✓ Connected to SQLite (local)');
  }

  return db;
}

export async function closeDatabase() {
  if (!db) return;

  if (usePostgres) {
    await db.raw.end();
  } else {
    await db.close();
  }
  db = null;
  postgresBootstrapped = false;
  sqliteBootstrapped = false;
}
