import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';
import path from 'path';

const dbPath = './db/accounting.db';

async function initDatabase() {
  try {
    // Remove existing database to start fresh
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      console.log('Removed existing database');
    }

    const db = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });

    // Read and execute schema
    const schema = fs.readFileSync('./db/schema.sql', 'utf8');
    const statements = schema.split(';').filter(s => s.trim());
    
    for (const statement of statements) {
      if (statement.trim()) {
        await db.exec(statement);
      }
    }

    console.log('✓ Database schema initialized');

    // Create initial entities
    await db.run(
      'INSERT INTO entities (id, name, code, type) VALUES (?, ?, ?, ?)',
      ['ent-ljc', 'LJC Financial, LLC', 'LJC', 'OPERATING']
    );

    await db.run(
      'INSERT INTO entities (id, name, code, type) VALUES (?, ?, ?, ?)',
      ['ent-justin', 'Justin Financial', 'JUSTIN', 'RELATED']
    );

    await db.run(
      'INSERT INTO entities (id, name, code, type) VALUES (?, ?, ?, ?)',
      ['ent-omc', 'OMC Housing', 'OMC', 'RELATED']
    );

    await db.run(
      'INSERT INTO entities (id, name, code, type) VALUES (?, ?, ?, ?)',
      ['ent-gm', 'Graceful Meadows Assisted Living', 'GM', 'RELATED']
    );

    console.log('✓ Default entities created');
    console.log('✓ Database initialized at:', dbPath);

    await db.close();
  } catch (error) {
    console.error('Database initialization error:', error);
    process.exit(1);
  }
}

initDatabase();
