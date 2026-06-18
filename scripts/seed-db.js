import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import bcryptjs from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

async function seedDatabase() {
  try {
    const db = await open({
      filename: './db/accounting.db',
      driver: sqlite3.Database
    });

    await db.exec('PRAGMA foreign_keys = ON');

    // Add demo user
    const demoEmail = 'demo@ljcfinancial.com';
    const existing = await db.get('SELECT id FROM users WHERE email = ?', demoEmail);

    if (!existing) {
      const passwordHash = await bcryptjs.hash('demo123', 10);
      const userId = `usr-${uuidv4()}`;
      
      await db.run(
        'INSERT INTO users (id, email, password_hash, full_name, role, entities_access, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          userId,
          demoEmail,
          passwordHash,
          'Demo User',
          'ACCOUNTANT',
          JSON.stringify(['ent-ljc', 'ent-justin', 'ent-omc', 'ent-gm']),
          1
        ]
      );
      console.log('✓ Demo user created: demo@ljcfinancial.com / demo123');
    } else {
      console.log('✓ Demo user already exists');
    }

    // Add default chart of accounts for LJC
    const chartOfAccounts = [
      { entity: 'ent-ljc', number: '1000', name: 'Cash & Bank Accounts', type: 'ASSET' },
      { entity: 'ent-ljc', number: '1200', name: 'Accounts Receivable', type: 'ASSET' },
      { entity: 'ent-ljc', number: '1300', name: 'Notes Receivable', type: 'ASSET' },
      { entity: 'ent-ljc', number: '1400', name: 'Loan Receivable', type: 'ASSET' },
      { entity: 'ent-ljc', number: '1500', name: 'Real Estate Owned (REO)', type: 'ASSET' },
      { entity: 'ent-ljc', number: '2000', name: 'Accounts Payable', type: 'LIABILITY' },
      { entity: 'ent-ljc', number: '2100', name: 'Notes Payable', type: 'LIABILITY' },
      { entity: 'ent-ljc', number: '2200', name: 'Warehouse Lines', type: 'LIABILITY' },
      { entity: 'ent-ljc', number: '3000', name: "Owner's Equity", type: 'EQUITY' },
      { entity: 'ent-ljc', number: '4000', name: 'Interest Income', type: 'REVENUE' },
      { entity: 'ent-ljc', number: '4100', name: 'Fee Income', type: 'REVENUE' },
      { entity: 'ent-ljc', number: '5000', name: 'Interest Expense', type: 'EXPENSE' },
      { entity: 'ent-ljc', number: '5100', name: 'Operating Expense', type: 'EXPENSE' }
    ];

    for (const acc of chartOfAccounts) {
      const existing = await db.get(
        'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
        [acc.entity, acc.number]
      );

      if (!existing) {
        const accId = `acc-${uuidv4()}`;
        const normalBalance = ['ASSET', 'EXPENSE'].includes(acc.type) ? 'DEBIT' : 'CREDIT';
        
        await db.run(
          'INSERT INTO accounts (id, entity_id, account_number, account_name, account_type, normal_balance) VALUES (?, ?, ?, ?, ?, ?)',
          [accId, acc.entity, acc.number, acc.name, acc.type, normalBalance]
        );
      }
    }
    console.log('✓ Default chart of accounts created');

    await db.close();
    console.log('✓ Database seeded successfully');
  } catch (error) {
    console.error('Seeding error:', error);
    process.exit(1);
  }
}

seedDatabase();
