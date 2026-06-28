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
import { ensurePlaidSchema } from './plaid-schema.js';
import { ensureQboReplacementSchema } from './qbo-replacement-schema.js';
import { ensureReceiptsSchema } from './receipts-schema.js';
import { seedDefaultRules } from '../lib/categorization-rules.js';

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

const RETRY_DELAY_MS = 3000;
const MAX_DB_RETRIES = 10;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectPostgres() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  return createPgAdapter(client);
}

export async function getDatabase() {
  if (db) {
    return db;
  }

  if (usePostgres) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_DB_RETRIES; attempt += 1) {
      try {
        db = await connectPostgres();

        if (!postgresBootstrapped) {
          await bootstrapPostgres(db);
          postgresBootstrapped = true;
        }
        await ensurePlaidSchema(db);
        await ensureQboReplacementSchema(db);
        await ensureReceiptsSchema(db);
        await seedDefaultRules(db, 'ent-ljc');

        console.log('✓ Connected to PostgreSQL (cloud)');
        return db;
      } catch (error) {
        lastError = error;
        console.warn(`PostgreSQL attempt ${attempt}/${MAX_DB_RETRIES} failed: ${error.message}`);
        db = null;
        if (attempt < MAX_DB_RETRIES) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
    throw lastError;
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
    await ensurePlaidSchema(db);
    await ensureQboReplacementSchema(db);
    await ensureReceiptsSchema(db);
    await seedDefaultRules(db, 'ent-ljc');

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
