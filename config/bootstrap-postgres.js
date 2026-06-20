import { seedDatabaseContent } from './bootstrap-seed.js';

const SCHEMA = `
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
  is_active BOOLEAN DEFAULT TRUE,
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
  is_active BOOLEAN DEFAULT TRUE,
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

CREATE TABLE IF NOT EXISTS import_transactions (
  id TEXT PRIMARY KEY,
  fitid TEXT NOT NULL UNIQUE,
  import_id TEXT,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  journal_entry_id TEXT,
  date DATE NOT NULL,
  amount NUMERIC(19,2) NOT NULL,
  description TEXT,
  check_number TEXT,
  transaction_type TEXT,
  matched_to_gl_id TEXT,
  status TEXT DEFAULT 'DRAFT' CHECK(status IN ('DRAFT', 'MATCHED', 'RECONCILED', 'REJECTED')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reconciliation_matches (
  id TEXT PRIMARY KEY,
  gl_entry_id TEXT NOT NULL REFERENCES general_ledger(id),
  import_transaction_id TEXT NOT NULL REFERENCES import_transactions(id),
  matched_amount NUMERIC(19,2),
  matched_date DATE,
  matched_by TEXT NOT NULL REFERENCES users(id),
  cleared BOOLEAN DEFAULT FALSE,
  cleared_date DATE,
  cleared_by TEXT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reconciliations (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  counterparty_entity_id TEXT REFERENCES entities(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  reconciliation_type TEXT CHECK(reconciliation_type IN ('INTERCOMPANY', 'BANK', 'LOAN', 'AP', 'AR')),
  status TEXT DEFAULT 'PENDING',
  our_balance NUMERIC(19,2),
  their_balance NUMERIC(19,2),
  variance NUMERIC(19,2),
  as_of_date DATE,
  resolved_date TIMESTAMP,
  notes TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  entity_id TEXT REFERENCES entities(id),
  action TEXT NOT NULL,
  table_name TEXT,
  record_id TEXT,
  old_values TEXT,
  new_values TEXT,
  changes_summary TEXT,
  ip_address TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_je_entity_date ON journal_entries(entity_id, posting_date);
CREATE INDEX IF NOT EXISTS idx_gl_entity_date ON general_ledger(entity_id, posting_date);
CREATE INDEX IF NOT EXISTS idx_gl_account_date ON general_ledger(account_id, posting_date);
CREATE INDEX IF NOT EXISTS idx_import_fitid ON import_transactions(fitid);
`;

export async function bootstrapPostgres(db) {
  console.log('Initializing PostgreSQL schema...');
  await db.exec(SCHEMA);
  await seedDatabaseContent(db);
  console.log('✓ PostgreSQL bootstrap complete (demo@ljcfinancial.com / demo123)');
}
