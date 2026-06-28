/**
 * Bank import / reconciliation targets for 2026 catch-up.
 * Add statement ending balances as you receive each monthly statement.
 */
export const BANK_ACCOUNTS = {
  'ent-ljc': [
    { accountNumber: '1000', name: 'Simmons Bank ckg-0260', ofxAccountId: '0260' },
    { accountNumber: '1001', name: 'Lone Star Bank ckg-7367', ofxAccountId: '7367' },
  ],
  'ent-justin': [{ accountNumber: '1000', name: 'Primary checking' }],
  'ent-omc': [{ accountNumber: '1000', name: 'Primary checking' }],
  'ent-gm': [{ accountNumber: '1000', name: 'Primary checking' }],
  'ent-4jl': [{ accountNumber: '1000', name: 'Primary checking' }],
  'ent-qof': [{ accountNumber: '1000', name: 'Primary checking' }],
};

/** Statement date → ending balance (from bank statement, not calculated). */
export const RECONCILIATION_TARGETS = {
  'ent-ljc': {
    '1000': [
      { statementDate: '2026-02-01', endingBalance: 15880.28, label: 'January 2026' },
      { statementDate: '2026-03-01', endingBalance: 9912.36, label: 'February 2026' },
      { statementDate: '2026-03-31', endingBalance: 33074.61, label: 'March 2026' },
      { statementDate: '2026-04-30', endingBalance: 79722.84, label: 'April 2026' },
      { statementDate: '2026-05-31', endingBalance: 19977.13, label: 'May 2026' },
    ],
    '1001': [
      { statementDate: '2026-01-31', endingBalance: 726.07, label: 'January 2026' },
      { statementDate: '2026-02-28', endingBalance: 195073.68, label: 'February 2026' },
      { statementDate: '2026-03-31', endingBalance: 180566.92, label: 'March 2026' },
      { statementDate: '2026-04-30', endingBalance: 108556.88, label: 'April 2026' },
      { statementDate: '2026-05-31', endingBalance: 3528.66, label: 'May 2026' },
    ],
  },
};

export const IMPORT_DIR = 'data/bank-imports';
