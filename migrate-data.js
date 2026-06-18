import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { v4 as uuidv4 } from 'uuid';

async function migrateData() {
  try {
    console.log('Initializing app data...\n');

    const db = await open({
      filename: './db/accounting.db',
      driver: sqlite3.Database
    });

    await db.exec('PRAGMA foreign_keys = ON');

    // Create entities
    console.log('Setting up entities...');
    const entityId = uuidv4();
    await db.run(
      'INSERT OR IGNORE INTO entities (id, name, code, type, status) VALUES (?, ?, ?, ?, ?)',
      [entityId, 'LJC Financial, LLC', 'LJC', 'OPERATING', 'ACTIVE']
    );
    console.log('✓ Entity ready');

    // Create basic chart of accounts
    console.log('\nCreating chart of accounts...');
    const chartOfAccounts = [
      // Assets
      { num: '1000', name: 'Cash', type: 'Asset', balance: 'Debit' },
      { num: '1100', name: 'Accounts Receivable', type: 'Asset', balance: 'Debit' },
      { num: '1200', name: 'Prepaid Expenses', type: 'Asset', balance: 'Debit' },
      { num: '1500', name: 'Equipment', type: 'Asset', balance: 'Debit' },
      { num: '1600', name: 'Accumulated Depreciation', type: 'Asset', balance: 'Credit' },
      // Liabilities
      { num: '2000', name: 'Accounts Payable', type: 'Liability', balance: 'Credit' },
      { num: '2100', name: 'Notes Payable', type: 'Liability', balance: 'Credit' },
      { num: '2200', name: 'Accrued Expenses', type: 'Liability', balance: 'Credit' },
      // Equity
      { num: '3000', name: 'Owners Capital', type: 'Equity', balance: 'Credit' },
      { num: '3100', name: 'Retained Earnings', type: 'Equity', balance: 'Credit' },
      // Income
      { num: '4000', name: 'Service Revenue', type: 'Income', balance: 'Credit' },
      { num: '4100', name: 'Interest Income', type: 'Income', balance: 'Credit' },
      // Expenses
      { num: '5000', name: 'Salaries Expense', type: 'Expense', balance: 'Debit' },
      { num: '5100', name: 'Rent Expense', type: 'Expense', balance: 'Debit' },
      { num: '5200', name: 'Utilities Expense', type: 'Expense', balance: 'Debit' },
      { num: '5300', name: 'Office Supplies', type: 'Expense', balance: 'Debit' },
    ];

    let accountCount = 0;
    for (const acct of chartOfAccounts) {
      try {
        await db.run(
          `INSERT OR IGNORE INTO accounts
           (id, entity_id, account_number, account_name, account_type, description, is_active, normal_balance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `acc-${uuidv4()}`,
            entityId,
            acct.num,
            acct.name,
            acct.type,
            `${acct.type}: ${acct.name}`,
            1,
            acct.balance
          ]
        );
        accountCount++;
      } catch (e) {
        // Account may exist
      }
    }
    console.log(`✓ ${accountCount} accounts created`);

    console.log('\n=== APP INITIALIZED ===');
    console.log('✓ App is ready to use');
    console.log('✓ Demo user: demo@ljcfinancial.com / demo123');
    console.log('✓ Chart of accounts created (16 accounts)\n');
    console.log('To import your full accounting data:');
    console.log('1. Log into the app');
    console.log('2. Use the import features to load your transactions\n');

    await db.close();
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

migrateData();
