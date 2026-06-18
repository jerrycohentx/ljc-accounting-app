import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable not set');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const schema = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  type TEXT CHECK(type IN ('OPERATING', 'HOLDING', 'QOF', 'RELATED')),
  status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT DEFAULT 'USER' CHECK(role IN ('ADMIN', 'ACCOUNTANT', 'USER', 'VIEWER')),
  entities_access TEXT,
  is_active BOOLEAN DEFAULT true,
  last_login TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  account_number TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE', 'CONTRA')),
  parent_account_id TEXT REFERENCES accounts(id),
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  normal_balance TEXT CHECK(normal_balance IN ('DEBIT', 'CREDIT')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(entity_id, account_number)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  je_number TEXT NOT NULL,
  description TEXT NOT NULL,
  posting_date DATE NOT NULL,
  status TEXT DEFAULT 'DRAFT' CHECK(status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'REJECTED')),
  created_by TEXT NOT NULL REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  posted_date TIMESTAMP,
  approved_date TIMESTAMP,
  memo TEXT,
  total_debit NUMERIC(19,2) DEFAULT 0,
  total_credit NUMERIC(19,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(entity_id, je_number)
);

CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id TEXT PRIMARY KEY,
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  debit NUMERIC(19,2) DEFAULT 0,
  credit NUMERIC(19,2) DEFAULT 0,
  description TEXT,
  line_number INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS general_ledger (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  debit NUMERIC(19,2) DEFAULT 0,
  credit NUMERIC(19,2) DEFAULT 0,
  balance NUMERIC(19,2),
  posting_date DATE NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reconciliations (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  reconciliation_date DATE NOT NULL,
  our_balance NUMERIC(19,2),
  their_balance NUMERIC(19,2),
  variance NUMERIC(19,2),
  status TEXT DEFAULT 'PENDING',
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  table_name TEXT,
  record_id TEXT,
  changes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_je_entity_date ON journal_entries(entity_id, posting_date);
CREATE INDEX IF NOT EXISTS idx_gl_entity_date ON general_ledger(entity_id, posting_date);
CREATE INDEX IF NOT EXISTS idx_gl_account_date ON general_ledger(account_id, posting_date);
CREATE INDEX IF NOT EXISTS idx_audit_entity_date ON audit_logs(entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user_entity ON sessions(user_id, entity_id);
`;

async function initializeDatabase() {
  try {
    console.log('Connecting to PostgreSQL...');
    await client.connect();
    console.log('✓ Connected');

    console.log('Creating schema...');
    await client.query(schema);
    console.log('✓ Schema created');

    // Create default entity
    const entityId = 'ent-ljc';
    const existingEntity = await client.query('SELECT id FROM entities WHERE id = $1', [entityId]);

    if (existingEntity.rows.length === 0) {
      await client.query(
        'INSERT INTO entities (id, name, code, type, status) VALUES ($1, $2, $3, $4, $5)',
        [entityId, 'LJC Financial, LLC', 'LJC', 'OPERATING', 'ACTIVE']
      );
      console.log('✓ Default entity created');
    }

    // Create admin user
    const userId = 'user-admin';
    const adminEmail = process.env.ADMIN_EMAIL || 'jerry@ljcfinancial.com';
    const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [adminEmail]);

    if (existingUser.rows.length === 0) {
      // Note: In production, hash the password properly
      const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
      await client.query(
        'INSERT INTO users (id, email, password_hash, full_name, role, is_active) VALUES ($1, $2, $3, $4, $5, $6)',
        [userId, adminEmail, password, 'Admin User', 'ADMIN', true]
      );
      console.log(`✓ Admin user created: ${adminEmail}`);
    }

    console.log('\n✓ PostgreSQL database initialized successfully');
    console.log(`\nLogin with:`);
    console.log(`  Email: ${adminEmail}`);
    console.log(`  Password: (as set in environment)`);

  } catch (error) {
    console.error('✗ Error initializing database:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

initializeDatabase();
