import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../config/database.js';

const HOLDING_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS holdback_disbursements (
  id TEXT PRIMARY KEY,
  draw_id TEXT NOT NULL UNIQUE,
  entity_id TEXT NOT NULL,
  loan_id TEXT,
  loan_num TEXT,
  borrower_name TEXT,
  property_address TEXT,
  draw_date DATE NOT NULL,
  gross_amount NUMERIC(19,2) NOT NULL,
  inspection_fee NUMERIC(19,2) DEFAULT 0,
  wire_fee NUMERIC(19,2) DEFAULT 35,
  net_disbursement NUMERIC(19,2) NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'exported', 'matched', 'verified')),
  journal_entry_id TEXT,
  gl_entry_id TEXT,
  import_transaction_id TEXT,
  bank_reference TEXT,
  verified_at TIMESTAMP,
  verified_by TEXT,
  memo TEXT,
  note TEXT,
  source_app TEXT DEFAULT 'loan-tracker',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_holdback_draw_id ON holdback_disbursements(draw_id);
CREATE INDEX IF NOT EXISTS idx_holdback_status ON holdback_disbursements(status);
`;

export async function ensureHoldbackTable(db) {
  const statements = HOLDING_TABLE_SQL.split(';').map((s) => s.trim()).filter(Boolean);
  for (const statement of statements) {
    try {
      await db.exec(statement);
    } catch (error) {
      if (!/already exists/i.test(error.message)) {
        console.warn('holdback_disbursements DDL:', error.message);
      }
    }
  }
}

async function findAccounts(db, entityId) {
  const cash = await db.get(
    `SELECT id, account_number, account_name FROM accounts
     WHERE entity_id = ? AND account_number = '1000' LIMIT 1`,
    entityId
  );
  const loanRecv = await db.get(
    `SELECT id, account_number, account_name FROM accounts
     WHERE entity_id = ? AND account_number = '1400' LIMIT 1`,
    entityId
  );
  const expense = await db.get(
    `SELECT id, account_number, account_name FROM accounts
     WHERE entity_id = ? AND account_number = '5100' LIMIT 1`,
    entityId
  );
  return { cash, loanRecv, expense };
}

export async function createHoldbackJournal(db, {
  entityId,
  userId,
  drawId,
  drawDate,
  grossAmount,
  inspectionFee,
  wireFee,
  netDisbursement,
  borrowerName,
  loanNum,
  note,
}) {
  const accounts = await findAccounts(db, entityId);
  if (!accounts.cash || !accounts.loanRecv) {
    throw new Error('Chart of accounts missing 1000 Cash or 1400 Loan Receivable for this entity');
  }

  const expenseAccount = accounts.expense || accounts.cash;
  const gross = new Decimal(grossAmount);
  const inspection = new Decimal(inspectionFee || 0);
  const wire = new Decimal(wireFee || 0);
  const net = new Decimal(netDisbursement);

  if (!gross.equals(inspection.plus(wire).plus(net))) {
    throw new Error('Gross amount must equal net disbursement plus fees');
  }

  const journalId = `je-${uuidv4()}`;
  const jeNumber = `HB-${drawId.slice(-8).toUpperCase()}`;
  const description = `Holdback draw ${loanNum || ''} ${borrowerName || ''}`.trim();
  const memo = `HOLDBACK-DRAW:${drawId}${note ? ` | ${note}` : ''}`;

  const lines = [
    {
      accountId: accounts.loanRecv.id,
      debit: gross.toFixed(2),
      credit: 0,
      description: `Principal increase (gross) — ${drawId}`,
    },
    {
      accountId: accounts.cash.id,
      debit: 0,
      credit: net.toFixed(2),
      description: `Wire to borrower (net) — ${drawId}`,
    },
  ];

  if (inspection.gt(0)) {
    lines.push({
      accountId: expenseAccount.id,
      debit: 0,
      credit: inspection.toFixed(2),
      description: `Inspection fee — ${drawId}`,
    });
  }
  if (wire.gt(0)) {
    lines.push({
      accountId: expenseAccount.id,
      debit: 0,
      credit: wire.toFixed(2),
      description: `Wire fee — ${drawId}`,
    });
  }

  const totalDebit = lines.reduce((s, l) => s.plus(l.debit || 0), new Decimal(0));
  const totalCredit = lines.reduce((s, l) => s.plus(l.credit || 0), new Decimal(0));
  if (!totalDebit.equals(totalCredit)) {
    throw new Error('Journal out of balance');
  }

  await db.run(
    `INSERT INTO journal_entries
     (id, entity_id, je_number, description, posting_date, status, created_by, memo, total_debit, total_credit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      journalId,
      entityId,
      jeNumber,
      description,
      drawDate,
      'APPROVED',
      userId,
      memo,
      totalDebit.toFixed(2),
      totalCredit.toFixed(2),
    ]
  );

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    await db.run(
      `INSERT INTO journal_entry_lines
       (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        `jel-${uuidv4()}`,
        journalId,
        line.accountId,
        line.debit,
        line.credit,
        line.description,
        i + 1,
      ]
    );
  }

  let cashGlId = null;
  for (const line of lines) {
    const glId = `gl-${uuidv4()}`;
    await db.run(
      `INSERT INTO general_ledger
       (id, entity_id, account_id, journal_entry_id, debit, credit, posting_date, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        glId,
        entityId,
        line.accountId,
        journalId,
        line.debit,
        line.credit,
        drawDate,
        `${description} — ${line.description}`,
      ]
    );
    if (line.accountId === accounts.cash.id && Number(line.credit) > 0) {
      cashGlId = glId;
    }
  }

  await db.run(
    `UPDATE journal_entries SET status = 'POSTED', posted_date = CURRENT_TIMESTAMP WHERE id = ?`,
    journalId
  );

  return { journalId, jeNumber, cashGlId, memo };
}

export function drawMemoContainsId(memoOrDescription, drawId) {
  if (!memoOrDescription || !drawId) return false;
  return memoOrDescription.includes(`HOLDBACK-DRAW:${drawId}`) || memoOrDescription.includes(drawId);
}

export async function tryVerifyDrawFromBankTxn(db, { importTransaction, userId, entityId }) {
  if (!importTransaction) return null;

  const amount = Math.abs(Number(importTransaction.amount) || 0);
  const description = `${importTransaction.description || ''} ${importTransaction.check_number || ''}`;

  const pending = await db.all(
    `SELECT * FROM holdback_disbursements
     WHERE entity_id = ? AND status IN ('exported', 'matched')
     ORDER BY draw_date DESC`,
    entityId
  );

  for (const row of pending) {
    const memoHit = drawMemoContainsId(description, row.draw_id)
      || drawMemoContainsId(row.memo, row.draw_id);
    const amountHit = Math.abs(Number(row.net_disbursement) - amount) < 0.02;
    const dateHit = !importTransaction.date || !row.draw_date
      || Math.abs(new Date(importTransaction.date) - new Date(row.draw_date)) <= 7 * 86400000;

    if ((memoHit || amountHit) && amountHit && dateHit) {
      await db.run(
        `UPDATE holdback_disbursements
         SET status = 'verified', import_transaction_id = ?, bank_reference = ?,
             verified_at = CURRENT_TIMESTAMP, verified_by = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          importTransaction.id,
          importTransaction.fitid || importTransaction.id,
          userId || null,
          row.id,
        ]
      );
      return row;
    }
  }

  return null;
}

export async function verifyDrawById(db, drawId, { userId, importTransactionId, bankReference } = {}) {
  const row = await db.get('SELECT * FROM holdback_disbursements WHERE draw_id = ?', drawId);
  if (!row) return null;
  await db.run(
    `UPDATE holdback_disbursements
     SET status = 'verified', import_transaction_id = COALESCE(?, import_transaction_id),
         bank_reference = COALESCE(?, bank_reference),
         verified_at = CURRENT_TIMESTAMP, verified_by = ?, updated_at = CURRENT_TIMESTAMP
     WHERE draw_id = ?`,
    [importTransactionId || null, bankReference || null, userId || null, drawId]
  );
  return db.get('SELECT * FROM holdback_disbursements WHERE draw_id = ?', drawId);
}
