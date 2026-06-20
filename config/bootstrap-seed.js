import bcryptjs from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

export const ENTITIES = [
  { id: 'ent-ljc', name: 'LJC Financial, LLC', code: 'LJC', type: 'OPERATING' },
  { id: 'ent-justin', name: 'Justin Cohen', code: 'JUSTIN', type: 'RELATED' },
  { id: 'ent-omc', name: 'OMC', code: 'OMC', type: 'RELATED' },
  { id: 'ent-gm', name: 'GM', code: 'GM', type: 'RELATED' },
];

export const CHART_OF_ACCOUNTS = [
  { entity: 'ent-ljc', number: '1000', name: 'Cash & Bank Accounts', type: 'ASSET' },
  { entity: 'ent-ljc', number: '1200', name: 'Accounts Receivable', type: 'ASSET' },
  { entity: 'ent-ljc', number: '1300', name: 'Notes Receivable', type: 'ASSET' },
  { entity: 'ent-ljc', number: '1400', name: 'Loan Receivable', type: 'ASSET' },
  { entity: 'ent-ljc', number: '2000', name: 'Accounts Payable', type: 'LIABILITY' },
  { entity: 'ent-ljc', number: '3000', name: "Owner's Equity", type: 'EQUITY' },
  { entity: 'ent-ljc', number: '4000', name: 'Interest Income', type: 'REVENUE' },
  { entity: 'ent-ljc', number: '5000', name: 'Interest Expense', type: 'EXPENSE' },
];

async function upsertEntity(db, entity) {
  const existing = await db.get('SELECT id FROM entities WHERE id = ?', entity.id);
  if (existing) return;
  await db.run(
    'INSERT INTO entities (id, name, code, type, status) VALUES (?, ?, ?, ?, ?)',
    [entity.id, entity.name, entity.code, entity.type, 'ACTIVE']
  );
}

async function upsertUser(db, { id, email, password, fullName, role, entitiesAccess }) {
  const existing = await db.get('SELECT id FROM users WHERE email = ?', email);
  if (existing) return;
  const passwordHash = await bcryptjs.hash(password, 10);
  await db.run(
    'INSERT INTO users (id, email, password_hash, full_name, role, entities_access, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, email, passwordHash, fullName, role, JSON.stringify(entitiesAccess), 1]
  );
}

async function seedChartOfAccounts(db) {
  for (const acc of CHART_OF_ACCOUNTS) {
    const existing = await db.get(
      'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
      [acc.entity, acc.number]
    );
    if (existing) continue;
    const normalBalance = ['ASSET', 'EXPENSE'].includes(acc.type) ? 'DEBIT' : 'CREDIT';
    await db.run(
      'INSERT INTO accounts (id, entity_id, account_number, account_name, account_type, normal_balance, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [`acc-${uuidv4()}`, acc.entity, acc.number, acc.name, acc.type, normalBalance, 1]
    );
  }
}

export async function seedDatabaseContent(db) {
  for (const entity of ENTITIES) {
    await upsertEntity(db, entity);
  }

  await upsertUser(db, {
    id: 'usr-demo',
    email: 'demo@ljcfinancial.com',
    password: 'demo123',
    fullName: 'Demo User',
    role: 'ACCOUNTANT',
    entitiesAccess: ['ent-ljc', 'ent-justin', 'ent-omc', 'ent-gm'],
  });

  const adminEmail = process.env.ADMIN_EMAIL || 'jerry@ljcfinancial.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  await upsertUser(db, {
    id: 'usr-admin',
    email: adminEmail,
    password: adminPassword,
    fullName: 'Admin User',
    role: 'ADMIN',
    entitiesAccess: ['ent-ljc', 'ent-justin', 'ent-omc', 'ent-gm'],
  });

  await seedChartOfAccounts(db);
}
