import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import pg from 'pg';
import { createPgAdapter } from './pg-adapter.js';
import { bootstrapPostgres } from './bootstrap-postgres.js';

let db = null;
let postgresBootstrapped = false;

const usePostgres = Boolean(
  process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgresql')
);

export function isPostgres() {
  return usePostgres;
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
    db = await open({
      filename: './db/accounting.db',
      driver: sqlite3.Database,
    });
    await db.exec('PRAGMA foreign_keys = ON');
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
}
