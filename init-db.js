import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import bcryptjs from 'bcryptjs';
import { v4 as uuid } from 'uuid';

async function initDb() {
  try {
    console.log('Initializing database...\n');

    // Open database
    const db = await open({
      filename: './db/accounting.db',
      driver: sqlite3.Database
    });

    await db.exec('PRAGMA foreign_keys = ON');

    // Check if users table exists
    const result = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='users'");

    if (!result) {
      console.log('Creating tables...');
      await db.exec(`
        CREATE TABLE entities (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          code TEXT NOT NULL UNIQUE,
          type TEXT,
          status TEXT DEFAULT 'ACTIVE'
        );

        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          full_name TEXT NOT NULL,
          role TEXT DEFAULT 'USER',
          is_active BOOLEAN DEFAULT 1,
          entities_access TEXT,
          last_login DATETIME
        );

        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL,
          account_number TEXT NOT NULL,
          account_name TEXT NOT NULL,
          account_type TEXT NOT NULL,
          parent_account_id TEXT,
          description TEXT,
          is_active BOOLEAN DEFAULT 1,
          normal_balance TEXT,
          UNIQUE(entity_id, account_number),
          FOREIGN KEY(entity_id) REFERENCES entities(id)
        );

        CREATE TABLE journal_entries (
          id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL,
          je_number TEXT NOT NULL,
          description TEXT NOT NULL,
          posting_date DATE NOT NULL,
          status TEXT DEFAULT 'DRAFT',
          created_by TEXT NOT NULL,
          approved_by TEXT,
          posted_date DATETIME,
          approved_date DATETIME,
          memo TEXT,
          total_debit DECIMAL DEFAULT 0,
          total_credit DECIMAL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(entity_id, je_number),
          FOREIGN KEY(entity_id) REFERENCES entities(id),
          FOREIGN KEY(created_by) REFERENCES users(id)
        );

        CREATE TABLE journal_entry_lines (
          id TEXT PRIMARY KEY,
          journal_entry_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          debit DECIMAL DEFAULT 0,
          credit DECIMAL DEFAULT 0,
          description TEXT,
          line_number INT,
          FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id),
          FOREIGN KEY(account_id) REFERENCES accounts(id)
        );

        CREATE TABLE general_ledger (
          id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          journal_entry_id TEXT NOT NULL,
          debit DECIMAL DEFAULT 0,
          credit DECIMAL DEFAULT 0,
          balance DECIMAL,
          posting_date DATE NOT NULL,
          description TEXT,
          FOREIGN KEY(entity_id) REFERENCES entities(id),
          FOREIGN KEY(account_id) REFERENCES accounts(id),
          FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
        );
      `);
    }

    // Create default entity
    const entityId = uuid();
    await db.run(
      'INSERT OR IGNORE INTO entities (id, name, code, type, status) VALUES (?, ?, ?, ?, ?)',
      [entityId, 'LJC Financial, LLC', 'LJC', 'OPERATING', 'ACTIVE']
    );

    // Create demo user
    const userId = uuid();
    const passwordHash = await bcryptjs.hash('demo123', 10);

    await db.run(
      'INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role, is_active, entities_access) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, 'demo@ljcfinancial.com', passwordHash, 'Demo User', 'ADMIN', 1, JSON.stringify(['ent-ljc'])]
    );

    console.log('✓ Database initialized');
    console.log('\n✓ Demo user created:');
    console.log('  Email: demo@ljcfinancial.com');
    console.log('  Password: demo123');
    console.log('\n✓ Ready to use!\n');

    await db.close();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

initDb();
