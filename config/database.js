import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import pg from 'pg';

let db = null;
const usePostgres = process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgresql');

export async function getDatabase() {
  if (db) {
    return db;
  }

  if (usePostgres) {
    // Cloud deployment - use PostgreSQL
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    await client.connect();
    db = client;
    console.log('✓ Connected to PostgreSQL (cloud)');
  } else {
    // Local development - use SQLite
    db = await open({
      filename: './db/accounting.db',
      driver: sqlite3.Database
    });
    await db.exec('PRAGMA foreign_keys = ON');
    console.log('✓ Connected to SQLite (local)');
  }

  return db;
}

export async function closeDatabase() {
  if (db) {
    if (usePostgres) {
      await db.end();
    } else {
      await db.close();
    }
    db = null;
  }
}
