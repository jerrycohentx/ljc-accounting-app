import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedDatabaseContent } from './bootstrap-seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function bootstrapSqlite(db) {
  const usersTable = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
  );

  if (!usersTable) {
    console.log('Initializing SQLite schema...');
    const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const statements = schema
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      try {
        await db.exec(statement);
      } catch (error) {
        console.warn('Schema statement skipped:', error.message);
      }
    }
  }

  await seedDatabaseContent(db);
  console.log('✓ SQLite bootstrap complete (demo@ljcfinancial.com / demo123)');
}
