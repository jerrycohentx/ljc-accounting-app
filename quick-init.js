import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

async function quickInit() {
  try {
    const db = await open({
      filename: './db/accounting.db',
      driver: sqlite3.Database
    });

    // Delete existing demo user if exists
    await db.run("DELETE FROM users WHERE email = 'demo@ljcfinancial.com'");

    // Insert demo user with plain password (for testing only)
    await db.run(
      "INSERT INTO users (id, email, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?, ?)",
      ['demo-user-1', 'demo@ljcfinancial.com', 'demo123', 'Demo User', 'ADMIN', 1]
    );

    console.log('✓ Demo user reset');
    console.log('  Email: demo@ljcfinancial.com');
    console.log('  Password: demo123\n');

    await db.close();
  } catch (error) {
    console.error('Error:', error.message);
  }
}

quickInit();
