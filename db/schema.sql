-- Entities (companies)
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  type TEXT CHECK(type IN ('OPERATING', 'HOLDING', 'QOF', 'RELATED')),
  status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'INACTIVE')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT DEFAULT 'USER' CHECK(role IN ('ADMIN', 'ACCOUNTANT', 'USER', 'VIEWER')),
  entities_access TEXT, -- JSON array of entity IDs
  is_active BOOLEAN DEFAULT 1,
  last_login DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Chart of Accounts
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE', 'CONTRA')),
  parent_account_id TEXT,
  description TEXT,
  is_active BOOLEAN DEFAULT 1,
  normal_balance TEXT CHECK(normal_balance IN ('DEBIT', 'CREDIT')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(entity_id) REFERENCES entities(id),
  FOREIGN KEY(parent_account_id) REFERENCES accounts(id),
  UNIQUE(entity_id, account_number)
);

-- General Ledger
CREATE TABLE IF NOT EXISTS general_ledger (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  journal_entry_id TEXT NOT NULL,
  debit DECIMAL(19,2) DEFAULT 0,
  credit DECIMAL(19,2) DEFAULT 0,
  balance DECIMAL(19,2),
  posting_date DATE NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(entity_id) REFERENCES entities(id),
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id),
  INDEX idx_entity_date (entity_id, posting_date),
  INDEX idx_account_date (account_id, posting_date)
);

-- Journal Entries
CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  je_number TEXT NOT NULL,
  description TEXT NOT NULL,
  posting_date DATE NOT NULL,
  status TEXT DEFAULT 'DRAFT' CHECK(status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'REJECTED')),
  created_by TEXT NOT NULL,
  approved_by TEXT,
  posted_date DATETIME,
  approved_date DATETIME,
  memo TEXT,
  total_debit DECIMAL(19,2) DEFAULT 0,
  total_credit DECIMAL(19,2) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(entity_id) REFERENCES entities(id),
  FOREIGN KEY(created_by) REFERENCES users(id),
  FOREIGN KEY(approved_by) REFERENCES users(id),
  UNIQUE(entity_id, je_number),
  INDEX idx_entity_date (entity_id, posting_date)
);

-- Journal Entry Line Items
CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id TEXT PRIMARY KEY,
  journal_entry_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  debit DECIMAL(19,2) DEFAULT 0,
  credit DECIMAL(19,2) DEFAULT 0,
  description TEXT,
  line_number INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE,
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);

-- Reconciliations
CREATE TABLE IF NOT EXISTS reconciliations (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  counterparty_entity_id TEXT,
  account_id TEXT NOT NULL,
  reconciliation_type TEXT CHECK(reconciliation_type IN ('INTERCOMPANY', 'BANK', 'LOAN', 'AP', 'AR')),
  status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'IN_PROGRESS', 'MATCHED', 'VARIANCE', 'RESOLVED', 'CLEARED')),
  our_balance DECIMAL(19,2) NOT NULL,
  their_balance DECIMAL(19,2),
  variance DECIMAL(19,2),
  as_of_date DATE NOT NULL,
  resolved_date DATETIME,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(entity_id) REFERENCES entities(id),
  FOREIGN KEY(counterparty_entity_id) REFERENCES entities(id),
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(created_by) REFERENCES users(id)
);

-- Audit Log
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  entity_id TEXT,
  action TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_id TEXT,
  old_values TEXT, -- JSON
  new_values TEXT, -- JSON
  changes_summary TEXT,
  ip_address TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(entity_id) REFERENCES entities(id),
  INDEX idx_user_timestamp (user_id, timestamp),
  INDEX idx_entity_action (entity_id, action, timestamp)
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Import Transactions (from OFX files)
CREATE TABLE IF NOT EXISTS import_transactions (
  id TEXT PRIMARY KEY,
  fitid TEXT NOT NULL UNIQUE,
  import_id TEXT,
  entity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  journal_entry_id TEXT,
  date DATE NOT NULL,
  amount DECIMAL(19,2) NOT NULL,
  description TEXT,
  check_number TEXT,
  transaction_type TEXT,
  matched_to_gl_id TEXT,
  status TEXT DEFAULT 'DRAFT' CHECK(status IN ('DRAFT', 'MATCHED', 'RECONCILED', 'REJECTED')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(entity_id) REFERENCES entities(id),
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id),
  INDEX idx_fitid (fitid),
  INDEX idx_entity_account (entity_id, account_id),
  INDEX idx_date (date)
);

-- Reconciliation Matches (GL to Bank)
CREATE TABLE IF NOT EXISTS reconciliation_matches (
  id TEXT PRIMARY KEY,
  gl_entry_id TEXT NOT NULL,
  import_transaction_id TEXT NOT NULL,
  matched_amount DECIMAL(19,2),
  matched_date DATE,
  matched_by TEXT NOT NULL,
  cleared BOOLEAN DEFAULT 0,
  cleared_date DATE,
  cleared_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(gl_entry_id) REFERENCES general_ledger(id),
  FOREIGN KEY(import_transaction_id) REFERENCES import_transactions(id),
  FOREIGN KEY(matched_by) REFERENCES users(id),
  FOREIGN KEY(cleared_by) REFERENCES users(id),
  INDEX idx_gl_entry (gl_entry_id),
  INDEX idx_import_txn (import_transaction_id),
  INDEX idx_cleared (cleared)
);

CREATE TABLE IF NOT EXISTS plaid_items (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  item_id TEXT NOT NULL UNIQUE,
  access_token_encrypted TEXT NOT NULL,
  institution_id TEXT,
  institution_name TEXT,
  sync_cursor TEXT,
  created_by TEXT NOT NULL,
  is_active BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(entity_id) REFERENCES entities(id),
  FOREIGN KEY(created_by) REFERENCES users(id)
);

CREATE INDEX idx_plaid_items_entity ON plaid_items(entity_id);
