#!/usr/bin/env node
/**
 * Unit tests for bank reconciliation session guard (zero-difference close rule).
 */
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { v4 as uuidv4 } from 'uuid';
import {
  ensureBankReconSessionTables,
  closeBankReconciliation,
  reopenBankReconciliation,
  buildWorksheet,
  getBeginningBalance,
} from '../lib/bank-reconcile-session.js';

const ENTITY = 'ent-test';
const USER = 'usr-test';

async function seedMinimal(db) {
  await db.run(`INSERT OR IGNORE INTO entities (id, name, code, type) VALUES (?, 'Test', 'TST', 'OPERATING')`, [ENTITY]);
  await db.run(`INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role) VALUES (?, 't@test.com', 'x', 'Test', 'ADMIN')`, [USER]);
}

async function createAccount(db, { id, number, normalBalance = 'DEBIT' }) {
  await db.run(
    `INSERT INTO accounts (id, entity_id, account_number, account_name, account_type, normal_balance, is_active)
     VALUES (?, ?, ?, ?, 'ASSET', ?, 1)`,
    [id, ENTITY, number, 'Test Bank', normalBalance]
  );
}

async function postJe(db, { accountId, date, debit = 0, credit = 0, glId }) {
  const jeId = `je-${uuidv4()}`;
  const jelId = `jel-${uuidv4()}`;
  await db.run(
    `INSERT INTO journal_entries (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit)
     VALUES (?, ?, ?, 'test', ?, 'POSTED', ?, ?, ?)`,
    [jeId, ENTITY, `JE-${glId}`, date, USER, debit, credit]
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, line_number) VALUES (?, ?, ?, ?, ?, 1)`,
    [jelId, jeId, accountId, debit, credit]
  );
  await db.run(
    `INSERT INTO general_ledger (id, entity_id, account_id, journal_entry_id, debit, credit, posting_date, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [glId, ENTITY, accountId, jeId, debit, credit, date, 'test']
  );
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function testRefusesOutOfBalanceClose(db) {
  const acctId = `acc-${uuidv4()}`;
  await createAccount(db, { id: acctId, number: '9001' });
  await postJe(db, { accountId: acctId, date: '2026-01-05', debit: 100, glId: 'gl-1' });
  await postJe(db, { accountId: acctId, date: '2026-01-10', credit: 50, glId: 'gl-2' });

  let threw = false;
  try {
    await closeBankReconciliation(db, {
      entityId: ENTITY,
      accountId: acctId,
      glIds: ['gl-1'],
      statementDate: '2026-01-31',
      statementEndingBalance: 50,
      userId: USER,
    });
  } catch (e) {
    threw = e.code === 'RECON_OUT_OF_BALANCE';
  }
  assert(threw, 'close must reject non-zero difference');

  const session = await db.get(
    `SELECT status, difference FROM bank_reconciliation_sessions WHERE entity_id = ? AND account_id = ?`,
    [ENTITY, acctId]
  );
  assert(session?.status === 'OPEN', 'session must stay OPEN');
  assert(Math.abs(session.difference - (-50)) < 0.01, 'difference should be -50 (ending − cleared)');
  console.log('✓ refuses out-of-balance close');
}

async function testClosesWhenBalanced(db) {
  const acctId = `acc-${uuidv4()}`;
  await createAccount(db, { id: acctId, number: '9002' });
  await postJe(db, { accountId: acctId, date: '2026-01-05', debit: 726.07, glId: 'gl-a' });

  const result = await closeBankReconciliation(db, {
    entityId: ENTITY,
    accountId: acctId,
    glIds: ['gl-a'],
    statementDate: '2026-01-31',
    statementEndingBalance: 726.07,
    userId: USER,
  });
  assert(result.status === 'CLOSED', 'session should close');
  assert(result.difference === 0, 'difference zero');

  const bb = await getBeginningBalance(db, ENTITY, acctId, '2026-02-28', 'DEBIT');
  assert(Math.abs(bb - 726.07) < 0.01, 'Feb beginning should be Jan ending');
  console.log('✓ closes balanced session and chains beginning balance');
}

async function testReopenClearsLegacy(db) {
  const acctId = `acc-${uuidv4()}`;
  await createAccount(db, { id: acctId, number: '9003' });
  await postJe(db, { accountId: acctId, date: '2026-01-05', debit: 500, glId: 'gl-x' });
  await db.run(`UPDATE general_ledger SET reconciliation_status = 'RECONCILED' WHERE id = 'gl-x'`);

  const ws = await buildWorksheet(db, { entityId: ENTITY, accountId: acctId, statementDate: '2026-01-31' });
  assert(ws.periodSession?.balanced === false, 'legacy orphan should show unbalanced');
  assert(ws.entries.length === 0, 'orphan reconciled lines hidden from worksheet');

  await reopenBankReconciliation(db, { entityId: ENTITY, accountId: acctId, statementDate: '2026-01-31' });
  const ws2 = await buildWorksheet(db, { entityId: ENTITY, accountId: acctId, statementDate: '2026-01-31' });
  assert(ws2.entries.length === 1, 'reopen restores uncleared lines');
  console.log('✓ reopen clears legacy reconciled status');
}

async function testPostsServiceChargeAndInterest(db) {
  const acctId = `acc-${uuidv4()}`;
  await createAccount(db, { id: acctId, number: '9004' });
  await db.run(
    `INSERT INTO accounts (id, entity_id, account_number, account_name, account_type, normal_balance, is_active)
     VALUES (?, ?, '5200', 'Bank Service Charges', 'EXPENSE', 'DEBIT', 1)`,
    [`exp-${uuidv4()}`, ENTITY]
  );
  await db.run(
    `INSERT INTO accounts (id, entity_id, account_number, account_name, account_type, normal_balance, is_active)
     VALUES (?, ?, '4000', 'Interest Income', 'REVENUE', 'CREDIT', 1)`,
    [`rev-${uuidv4()}`, ENTITY]
  );
  await postJe(db, { accountId: acctId, date: '2026-01-05', debit: 100, glId: 'gl-f' });

  // clearedBalance = 0 - 10 + 2 + 100 - 0 = 92
  const result = await closeBankReconciliation(db, {
    entityId: ENTITY,
    accountId: acctId,
    glIds: ['gl-f'],
    statementDate: '2026-01-31',
    statementEndingBalance: 92,
    serviceCharge: 10,
    interestEarned: 2,
    userId: USER,
  });
  assert(result.status === 'CLOSED', 'fee session should close');
  assert(result.difference === 0, 'fee difference zero');
  assert(result.reconciledCount === 3, `reconciledCount should be 3 (1 deposit + 2 fees), got ${result.reconciledCount}`);

  const svcJe = await db.get(`SELECT id FROM journal_entries WHERE entity_id = ? AND je_number = 'SVC-CHG-9004-20260131'`, [ENTITY]);
  const intJe = await db.get(`SELECT id FROM journal_entries WHERE entity_id = ? AND je_number = 'INT-ERND-9004-20260131'`, [ENTITY]);
  assert(svcJe, 'service charge JE posted');
  assert(intJe, 'interest JE posted');

  const bankBal = await db.get(
    `SELECT COALESCE(SUM(debit - credit), 0) AS bal FROM general_ledger WHERE entity_id = ? AND account_id = ?`,
    [ENTITY, acctId]
  );
  assert(Math.abs(bankBal.bal - 92) < 0.01, `bank GL balance should equal ending 92, got ${bankBal.bal}`);

  const feeReconciled = await db.get(
    `SELECT COUNT(*) AS c FROM general_ledger WHERE entity_id = ? AND account_id = ? AND reconciliation_status = 'RECONCILED'`,
    [ENTITY, acctId]
  );
  assert(feeReconciled.c === 3, `all 3 bank lines should be reconciled, got ${feeReconciled.c}`);

  // Idempotency: reopen then re-close must not duplicate the fee journals.
  await reopenBankReconciliation(db, { entityId: ENTITY, accountId: acctId, statementDate: '2026-01-31' });
  await closeBankReconciliation(db, {
    entityId: ENTITY,
    accountId: acctId,
    glIds: ['gl-f'],
    statementDate: '2026-01-31',
    statementEndingBalance: 92,
    serviceCharge: 10,
    interestEarned: 2,
    userId: USER,
  });
  const svcCount = await db.get(`SELECT COUNT(*) AS c FROM journal_entries WHERE entity_id = ? AND je_number = 'SVC-CHG-9004-20260131'`, [ENTITY]);
  assert(svcCount.c === 1, `service charge JE must not duplicate on re-close, got ${svcCount.c}`);
  const bankBal2 = await db.get(
    `SELECT COALESCE(SUM(debit - credit), 0) AS bal FROM general_ledger WHERE entity_id = ? AND account_id = ?`,
    [ENTITY, acctId]
  );
  assert(Math.abs(bankBal2.bal - 92) < 0.01, `bank balance stays 92 after re-close, got ${bankBal2.bal}`);
  console.log('✓ posts and reconciles service charge + interest (idempotent)');
}

async function main() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  const schema = `
    CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT, code TEXT, type TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, password_hash TEXT, full_name TEXT, role TEXT);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, entity_id TEXT, account_number TEXT, account_name TEXT, account_type TEXT, normal_balance TEXT, is_active INTEGER);
    CREATE TABLE journal_entries (id TEXT PRIMARY KEY, entity_id TEXT, je_number TEXT, description TEXT, posting_date TEXT, status TEXT, created_by TEXT, approved_by TEXT, approved_date TEXT, posted_date TEXT, total_debit REAL, total_credit REAL, source TEXT, reversed_by_je_id TEXT, reverses_je_id TEXT);
    CREATE TABLE journal_entry_lines (id TEXT PRIMARY KEY, journal_entry_id TEXT, account_id TEXT, debit REAL, credit REAL, line_number INTEGER, description TEXT);
    CREATE TABLE general_ledger (id TEXT PRIMARY KEY, entity_id TEXT, account_id TEXT, journal_entry_id TEXT, debit REAL, credit REAL, posting_date TEXT, description TEXT, reconciliation_status TEXT, reconciliation_session_id TEXT, created_at TEXT);
    CREATE TABLE import_transactions (id TEXT PRIMARY KEY, fitid TEXT, entity_id TEXT, account_id TEXT, journal_entry_id TEXT, date TEXT, amount REAL, description TEXT, matched_to_gl_id TEXT, status TEXT);
    CREATE TABLE accounting_periods (id TEXT PRIMARY KEY, entity_id TEXT, period_start TEXT, period_end TEXT, status TEXT, closed_by TEXT, closed_at TEXT, notes TEXT);
  `;
  for (const stmt of schema.split(';').filter(Boolean)) await db.exec(stmt);
  await seedMinimal(db);
  await ensureBankReconSessionTables(db);

  for (const [name, fn] of [
    ['refuses out-of-balance close', testRefusesOutOfBalanceClose],
    ['closes balanced session', testClosesWhenBalanced],
    ['reopen clears legacy', testReopenClearsLegacy],
    ['posts service charge + interest', testPostsServiceChargeAndInterest],
  ]) {
    try {
      await fn(db);
    } catch (e) {
      throw new Error(`${name}: ${e.message}`);
    }
  }
  console.log('\nAll bank reconciliation session tests passed.');
  await db.close();
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
