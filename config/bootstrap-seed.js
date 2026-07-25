import bcryptjs from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { FULL_CHART_OF_ACCOUNTS } from './coa-full.js';

export const ENTITIES = [
  { id: 'ent-ljc', name: 'LJC Financial, LLC', code: 'LJC', type: 'OPERATING' },
  { id: 'ent-justin', name: 'Justin Financial LLC', code: 'JUSTIN', type: 'RELATED' },
  { id: 'ent-omc', name: 'OMC Housing LLC', code: 'OMC', type: 'RELATED' },
  { id: 'ent-gm', name: 'Graceful Meadows Assisted Living LLC', code: 'GM', type: 'RELATED' },
  { id: 'ent-qof', name: 'LJC QOF LLC', code: 'QOF', type: 'RELATED' },
  { id: 'ent-4jl', name: '4 J & L Partners, LTD', code: '4JL', type: 'RELATED' },
];

const ALL_ENTITY_IDS = ENTITIES.map((e) => e.id);

/** @deprecated use FULL_CHART_OF_ACCOUNTS */
export const CHART_OF_ACCOUNTS = FULL_CHART_OF_ACCOUNTS;

async function upsertEntity(db, entity) {
  const existing = await db.get('SELECT id FROM entities WHERE id = ?', entity.id);
  if (existing) return;
  await db.run(
    'INSERT INTO entities (id, name, code, type, status) VALUES (?, ?, ?, ?, ?)',
    [entity.id, entity.name, entity.code, entity.type, 'ACTIVE']
  );
}

async function upsertUser(db, { id, email, password, fullName, role, entitiesAccess, phone }) {
  const existing = await db.get('SELECT id FROM users WHERE email = ?', email);
  if (existing) return;
  const passwordHash = await bcryptjs.hash(password, 10);
  const phoneVal = phone || null;
  try {
    await db.run(
      'INSERT INTO users (id, email, password_hash, full_name, role, entities_access, is_active, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, email, passwordHash, fullName, role, JSON.stringify(entitiesAccess), 1, phoneVal]
    );
  } catch {
    await db.run(
      'INSERT INTO users (id, email, password_hash, full_name, role, entities_access, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, email, passwordHash, fullName, role, JSON.stringify(entitiesAccess), 1]
    );
  }
}

async function seedChartOfAccounts(db) {
  for (const acc of FULL_CHART_OF_ACCOUNTS) {
    const existing = await db.get(
      'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
      [acc.entity, acc.number]
    );
    if (existing) continue;
    const normalBalance = ['ASSET', 'EXPENSE'].includes(acc.type) ? 'DEBIT' : 'CREDIT';
    let parentId = null;
    if (acc.parent) {
      const parent = await db.get(
        'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
        [acc.entity, acc.parent]
      );
      parentId = parent?.id || null;
    }
    await db.run(
      `INSERT INTO accounts
       (id, entity_id, account_number, account_name, account_type, normal_balance, parent_account_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [`acc-${uuidv4()}`, acc.entity, acc.number, acc.name, acc.type, normalBalance, parentId, 1]
    );
  }

  // Idempotent parent link for accounts that already existed before parent support.
  for (const acc of FULL_CHART_OF_ACCOUNTS) {
    if (!acc.parent) continue;
    const parent = await db.get(
      'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
      [acc.entity, acc.parent]
    );
    if (!parent?.id) continue;
    await db.run(
      `UPDATE accounts
       SET parent_account_id = ?
       WHERE entity_id = ? AND account_number = ?
         AND (parent_account_id IS NULL OR parent_account_id <> ?)`,
      [parent.id, acc.entity, acc.number, parent.id]
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
    entitiesAccess: ALL_ENTITY_IDS,
  });

  const adminEmail = process.env.ADMIN_EMAIL || 'jerry@ljcfinancial.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  await upsertUser(db, {
    id: 'usr-admin',
    email: adminEmail,
    password: adminPassword,
    fullName: 'Admin User',
    role: 'ADMIN',
    entitiesAccess: ALL_ENTITY_IDS,
    phone: process.env.ADMIN_PHONE || null,
  });

  await seedChartOfAccounts(db);
}
