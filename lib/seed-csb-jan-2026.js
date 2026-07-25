/**
 * Seed CSB DDA x1385 (GL 1002) for January 2026 reconcile from bank history PDF.
 *
 * Bank history (Account Snapshot through 1/13/2026):
 *   12/31/25 balance $118.17
 *   1/2/26 Check 1107251 ($24.37) → $93.80
 *   1/9/26 Check 1107252 ($93.80) → $0.00
 *   1/13/26 Closing → $0.00
 *
 * Books had OB $93.80 only + one OFX credit $93.80. This restates opening to
 * $118.17, posts the missing check, loads statement lines, and does NOT create
 * a force-balance / plug JE.
 */
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { postJournalEntryToGl } from './post-journal.js';
import { reopenPeriod, monthBounds } from './period-lock.js';

const ENTITY = 'ent-ljc';
const ACCT = '1002';
const OB_JE = 'CSB-1385-OB-20260101';
const CHK1_JE = 'CSB-1385-CHK-1107251';

function round2(n) {
  return new Decimal(n || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

async function ensurePostedJe(db, {
  entityId, jeNumber, postingDate, description, memo, source, userId, lines,
}) {
  const existing = await db.get(
    `SELECT id, status FROM journal_entries WHERE entity_id = ? AND je_number = ?`,
    [entityId, jeNumber]
  );
  if (existing?.status === 'POSTED') {
    return { jeId: existing.id, skipped: true };
  }

  const { periodStart, periodEnd } = monthBounds(postingDate);
  await reopenPeriod(db, { entityId, periodStart, periodEnd }).catch(() => {});

  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  for (const l of lines) {
    totalDebit = totalDebit.plus(l.debit || 0);
    totalCredit = totalCredit.plus(l.credit || 0);
  }
  if (!totalDebit.equals(totalCredit) || lines.length < 2) {
    throw new Error(`Unbalanced JE ${jeNumber}: ${totalDebit} vs ${totalCredit}`);
  }

  let jeId = existing?.id;
  if (!jeId) {
    jeId = `je-${uuidv4()}`;
    await db.run(
      `INSERT INTO journal_entries
       (id, entity_id, je_number, description, posting_date, status, created_by, memo, source, total_debit, total_credit)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
      [
        jeId, entityId, jeNumber, description, postingDate, userId, memo, source,
        totalDebit.toFixed(2), totalCredit.toFixed(2),
      ]
    );
  } else {
    await db.run(`DELETE FROM journal_entry_lines WHERE journal_entry_id = ?`, [jeId]);
    await db.run(
      `UPDATE journal_entries SET description = ?, posting_date = ?, status = 'DRAFT', memo = ?, source = ? WHERE id = ?`,
      [description, postingDate, memo, source, jeId]
    );
  }

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await db.run(
      `INSERT INTO journal_entry_lines
       (id, journal_entry_id, line_number, account_id, debit, credit, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        `jel-${uuidv4()}`, jeId, i + 1, l.accountId,
        round2(l.debit).toFixed(2), round2(l.credit).toFixed(2),
        l.description || description,
      ]
    );
  }

  await postJournalEntryToGl(db, { journalId: jeId, entityId, userId });
  return { jeId, skipped: false };
}

async function upsertStatementLines(db, { entityId, accountId, userId }) {
  const lines = [
    {
      date: '2026-01-02',
      amount: -24.37,
      description: 'Check 1107251',
      fitid: 'csb-1385-20260102-1107251',
    },
    {
      date: '2026-01-09',
      amount: -93.8,
      description: 'Check 1107252',
      fitid: 'csb-1385-20260109-1107252',
    },
  ];
  const importId = `imp-csb-hist-${uuidv4()}`;
  let imported = 0;
  let skipped = 0;
  for (const t of lines) {
    const existing = await db.get(
      `SELECT id FROM import_transactions WHERE entity_id = ? AND account_id = ? AND fitid = ?`,
      [entityId, accountId, t.fitid]
    );
    if (existing) { skipped += 1; continue; }
    await db.run(
      `INSERT INTO import_transactions (
        id, fitid, import_id, entity_id, account_id, journal_entry_id,
        date, amount, description, status, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'DRAFT', ?)`,
      [
        `imp-txn-${uuidv4()}`, t.fitid, importId, entityId, accountId,
        t.date, t.amount, t.description, new Date().toISOString(),
      ]
    );
    imported += 1;
  }
  return { imported, skipped, importId, userId };
}

export async function seedCsbJan2026(db, {
  entityId = ENTITY,
  userId = 'usr-admin',
} = {}) {
  const cash = await db.get(
    `SELECT id, account_number FROM accounts WHERE entity_id = ? AND account_number = ?`,
    [entityId, ACCT]
  );
  if (!cash) throw new Error('Account 1002 Cash - CSB Checking not found');

  const equity = await db.get(
    `SELECT id FROM accounts WHERE entity_id = ? AND account_number = '3000' AND is_active = 1`,
    [entityId]
  );
  const draws = await db.get(
    `SELECT id FROM accounts WHERE entity_id = ? AND account_number = '3005' AND is_active = 1`,
    [entityId]
  );
  if (!equity || !draws) throw new Error('Accounts 3000 / 3005 required');

  // Opening was booked at $93.80; bank history Dec 31 ending is $118.17 (+$24.37).
  const ob = await ensurePostedJe(db, {
    entityId,
    jeNumber: OB_JE,
    postingDate: '2026-01-01',
    description: 'CSB DDA 1385 — Dec 31 2025 balance per bank account history ($118.17)',
    memo: 'REST-CSB-1385-HISTORY',
    source: 'csb-history-seed',
    userId,
    lines: [
      {
        accountId: cash.id,
        debit: 24.37,
        credit: 0,
        description: 'CSB 1385 cash to match Dec 31 bank history',
      },
      {
        accountId: equity.id,
        debit: 0,
        credit: 24.37,
        description: 'CSB 1385 opening equity (bank history)',
      },
    ],
  });

  const chk1 = await ensurePostedJe(db, {
    entityId,
    jeNumber: CHK1_JE,
    postingDate: '2026-01-02',
    description: 'CSB Check 1107251',
    memo: 'From CSB account history PDF',
    source: 'csb-history-seed',
    userId,
    lines: [
      {
        accountId: draws.id,
        debit: 24.37,
        credit: 0,
        description: 'Check 1107251',
      },
      {
        accountId: cash.id,
        debit: 0,
        credit: 24.37,
        description: 'Check 1107251',
      },
    ],
  });

  // Align the existing OFX $93.80 credit description to Check 1107252 when present.
  await db.run(
    `UPDATE general_ledger
     SET description = 'Check 1107252 (CSB history)'
     WHERE entity_id = ? AND account_id = ? AND ABS(credit - 93.80) < 0.005
       AND description LIKE '%DEPOSIT - MOBILE%'`,
    [entityId, cash.id]
  ).catch(() => {});

  const stmt = await upsertStatementLines(db, {
    entityId,
    accountId: cash.id,
    userId,
  });

  const bal = await db.get(
    `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS bal
     FROM general_ledger WHERE entity_id = ? AND account_id = ?`,
    [entityId, cash.id]
  );

  return {
    accountId: cash.id,
    accountNumber: ACCT,
    openingRestatement: ob,
    check1107251: chk1,
    statementLines: stmt,
    bookBalance: round2(bal?.bal).toNumber(),
    statement: {
      previousBalance: 118.17,
      endingBalance: 0,
      statementDate: '2026-01-13',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-13',
    },
  };
}
