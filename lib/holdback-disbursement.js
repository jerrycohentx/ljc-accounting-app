import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { assertPeriodOpen } from './period-lock.js';
import {
  ACTIVE_FUNDING_BANK,
  ensureFundingBankAccounts,
  resolveFundingBank,
} from './holdback-coa.js';

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
  funds_journal_id TEXT,
  funding_bank TEXT DEFAULT 'Simmons',
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

const HOLDING_TABLE_ALTER = [
  `ALTER TABLE holdback_disbursements ADD COLUMN funds_journal_id TEXT`,
  `ALTER TABLE holdback_disbursements ADD COLUMN funding_bank TEXT DEFAULT 'Simmons'`,
];

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
  for (const statement of HOLDING_TABLE_ALTER) {
    try {
      await db.exec(statement);
    } catch (error) {
      if (!/duplicate column|already exists/i.test(error.message)) {
        console.warn('holdback_disbursements ALTER:', error.message);
      }
    }
  }
}

/** @deprecated use ensureFundingBankAccounts — kept for fee correction compat */
export async function ensureHoldbackExpenseAccount(db, entityId) {
  const { accounts } = await ensureFundingBankAccounts(db, entityId, ACTIVE_FUNDING_BANK);
  return accounts.expense.id;
}

function assertBalanced(lines) {
  const totalDebit = lines.reduce((s, l) => s.plus(l.debit || 0), new Decimal(0));
  const totalCredit = lines.reduce((s, l) => s.plus(l.credit || 0), new Decimal(0));
  if (!totalDebit.equals(totalCredit)) {
    throw new Error(`Journal out of balance (DR ${totalDebit} ≠ CR ${totalCredit})`);
  }
  return { totalDebit, totalCredit };
}

async function postJournalEntry(db, {
  entityId,
  userId,
  jeNumber,
  description,
  postingDate,
  memo,
  lines,
  cashAccountId,
}) {
  assertBalanced(lines);

  await assertPeriodOpen(db, entityId, postingDate);

  const journalId = `je-${uuidv4()}`;
  const { totalDebit, totalCredit } = assertBalanced(lines);

  await db.run(
    `INSERT INTO journal_entries
     (id, entity_id, je_number, description, posting_date, status, created_by, memo, total_debit, total_credit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      journalId,
      entityId,
      jeNumber,
      description,
      postingDate,
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
        postingDate,
        `${description} — ${line.description}`,
      ]
    );
    if (cashAccountId && line.accountId === cashAccountId && Number(line.credit) > 0) {
      cashGlId = glId;
    }
  }

  await db.run(
    `UPDATE journal_entries SET status = 'POSTED', posted_date = CURRENT_TIMESTAMP WHERE id = ?`,
    journalId
  );

  return { journalId, jeNumber, cashGlId, memo };
}

function validateDrawAmounts(grossAmount, inspectionFee, wireFee, netDisbursement) {
  const gross = new Decimal(grossAmount);
  const inspection = new Decimal(inspectionFee || 0);
  const wire = new Decimal(wireFee || 0);
  const net = new Decimal(netDisbursement);
  if (!gross.equals(inspection.plus(wire).plus(net))) {
    throw new Error('Gross amount must equal net disbursement plus fees');
  }
  return { gross, inspection, wire, net };
}

/**
 * Simmons warehouse advance hits LJC operating cash (gross).
 * DR Cash (1000) · CR DLOC Simmons (2110)
 */
export async function createHoldbackFundsReceivedJournal(db, {
  entityId,
  userId,
  drawId,
  drawDate,
  grossAmount,
  borrowerName,
  loanNum,
  fundingBank = ACTIVE_FUNDING_BANK,
  note,
}) {
  const { gross } = validateDrawAmounts(grossAmount, 0, 0, grossAmount);
  const { accounts } = await ensureFundingBankAccounts(db, entityId, fundingBank);

  const jeNumber = `HB-FR-${drawId.slice(-8).toUpperCase()}`;
  const description = `Simmons advance received ${loanNum || ''} ${borrowerName || ''}`.trim();
  const memo = `HOLDBACK-FUNDS:${drawId}${note ? ` | ${note}` : ''}`;

  const lines = [
    {
      accountId: accounts.cash.id,
      debit: gross.toFixed(2),
      credit: 0,
      description: `Simmons gross advance — ${drawId}`,
    },
    {
      accountId: accounts.dloc.id,
      debit: 0,
      credit: gross.toFixed(2),
      description: `DLOC advance liability — ${drawId}`,
    },
  ];

  return postJournalEntry(db, {
    entityId,
    userId,
    jeNumber,
    description,
    postingDate: drawDate,
    memo,
    lines,
    cashAccountId: accounts.cash.id,
  });
}

/**
 * Disburse holdback draw through Simmons mapping:
 * 1) DR NR Simmons · CR DLOC Simmons (gross)
 * 2) DR 5100 fees · CR Holdbacks Simmons (fees)
 * 3) DR Holdbacks Simmons · CR Cash (net wire to borrower)
 */
export async function createHoldbackDisbursementJournal(db, {
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
  fundingBank = ACTIVE_FUNDING_BANK,
  note,
}) {
  const { gross, inspection, wire, net } = validateDrawAmounts(
    grossAmount,
    inspectionFee,
    wireFee,
    netDisbursement
  );
  const { accounts } = await ensureFundingBankAccounts(db, entityId, fundingBank);
  const fees = inspection.plus(wire);

  const jeNumber = `HB-${drawId.slice(-8).toUpperCase()}`;
  const description = `Holdback draw ${loanNum || ''} ${borrowerName || ''}`.trim();
  const memo = `HOLDBACK-DRAW:${drawId}${note ? ` | ${note}` : ''}`;

  const lines = [
    {
      accountId: accounts.notesReceivable.id,
      debit: gross.toFixed(2),
      credit: 0,
      description: `Notes receivable (gross draw) — ${drawId}`,
    },
    {
      accountId: accounts.dloc.id,
      debit: 0,
      credit: gross.toFixed(2),
      description: `Clear Simmons DLOC advance — ${drawId}`,
    },
  ];

  if (inspection.gt(0)) {
    lines.push({
      accountId: accounts.expense.id,
      debit: inspection.toFixed(2),
      credit: 0,
      description: `Inspection fee — ${drawId}`,
    });
  }
  if (wire.gt(0)) {
    lines.push({
      accountId: accounts.expense.id,
      debit: wire.toFixed(2),
      credit: 0,
      description: `Wire fee — ${drawId}`,
    });
  }
  if (fees.gt(0)) {
    lines.push({
      accountId: accounts.holdback.id,
      debit: 0,
      credit: fees.toFixed(2),
      description: `Holdback fees (Simmons) — ${drawId}`,
    });
  }
  if (net.gt(0)) {
    lines.push(
      {
        accountId: accounts.holdback.id,
        debit: net.toFixed(2),
        credit: 0,
        description: `Holdback release (net wire) — ${drawId}`,
      },
      {
        accountId: accounts.cash.id,
        debit: 0,
        credit: net.toFixed(2),
        description: `Wire to borrower (net) — ${drawId}`,
      }
    );
  }

  return postJournalEntry(db, {
    entityId,
    userId,
    jeNumber,
    description,
    postingDate: drawDate,
    memo,
    lines,
    cashAccountId: accounts.cash.id,
  });
}

/** Backward-compatible alias — funds JE (if needed) + disbursement. */
export async function createHoldbackJournal(db, params) {
  const funds = await ensureFundsReceivedJournal(db, {
    ...params,
    existingFundsJournalId: null,
  });
  const disburse = await createHoldbackDisbursementJournal(db, params);
  return {
    ...disburse,
    fundsJournalId: funds.journalId,
    fundsJeNumber: funds.jeNumber,
  };
}

export async function ensureFundsReceivedJournal(db, {
  entityId,
  userId,
  drawId,
  drawDate,
  grossAmount,
  borrowerName,
  loanNum,
  fundingBank,
  note,
  existingFundsJournalId,
}) {
  if (existingFundsJournalId) {
    return { journalId: existingFundsJournalId, alreadyPosted: true };
  }
  const dup = await db.get(
    `SELECT id FROM journal_entries WHERE memo LIKE ? LIMIT 1`,
    [`%HOLDBACK-FUNDS:${drawId}%`]
  );
  if (dup) return { journalId: dup.id, alreadyPosted: true };

  const journal = await createHoldbackFundsReceivedJournal(db, {
    entityId,
    userId,
    drawId,
    drawDate,
    grossAmount,
    borrowerName,
    loanNum,
    fundingBank,
    note,
  });
  return { ...journal, alreadyPosted: false };
}

export async function postHoldbackFeeCorrection(db, {
  entityId,
  userId,
  drawId,
  drawDate,
  borrowerName,
  loanNum,
  oldInspectionFee,
  oldWireFee,
  oldNetDisbursement,
  inspectionFee,
  wireFee,
  netDisbursement,
  fundingBank = ACTIVE_FUNDING_BANK,
}) {
  const { accounts } = await ensureFundingBankAccounts(db, entityId, fundingBank);
  const inspectionDelta = new Decimal(inspectionFee || 0).minus(oldInspectionFee || 0);
  const wireDelta = new Decimal(wireFee || 0).minus(oldWireFee || 0);
  const netDelta = new Decimal(netDisbursement || 0).minus(oldNetDisbursement || 0);
  const lines = [];

  const pushPair = (debitAccount, creditAccount, amount, label) => {
    const amt = new Decimal(amount).abs();
    if (amt.lte(0)) return;
    lines.push(
      {
        accountId: debitAccount.id,
        debit: amt.toFixed(2),
        credit: 0,
        description: `${label} — ${drawId}`,
      },
      {
        accountId: creditAccount.id,
        debit: 0,
        credit: amt.toFixed(2),
        description: `${label} — ${drawId}`,
      }
    );
  };

  if (inspectionDelta.gt(0)) {
    pushPair(accounts.expense, accounts.holdback, inspectionDelta, 'Inspection fee adjustment');
  } else if (inspectionDelta.lt(0)) {
    pushPair(accounts.holdback, accounts.expense, inspectionDelta, 'Reverse inspection fee');
  }

  if (wireDelta.gt(0)) {
    pushPair(accounts.expense, accounts.holdback, wireDelta, 'Wire fee adjustment');
  } else if (wireDelta.lt(0)) {
    pushPair(accounts.holdback, accounts.expense, wireDelta, 'Reverse wire fee');
  }

  if (netDelta.lt(0)) {
    pushPair(accounts.holdback, accounts.cash, netDelta, 'Reduce net wire');
  } else if (netDelta.gt(0)) {
    pushPair(accounts.cash, accounts.holdback, netDelta, 'Increase net wire');
  }

  if (!lines.length) return null;

  const jeNumber = `HB-ADJ-${drawId.slice(-6).toUpperCase()}`;
  const description = `Holdback fee correction ${loanNum || ''} ${borrowerName || ''}`.trim();
  return postJournalEntry(db, {
    entityId,
    userId,
    jeNumber,
    description,
    postingDate: drawDate,
    memo: `HOLDBACK-FEE-ADJ:${drawId}`,
    lines,
    cashAccountId: accounts.cash.id,
  });
}

export function drawMemoContainsId(memoOrDescription, drawId) {
  if (!memoOrDescription || !drawId) return false;
  return memoOrDescription.includes(`HOLDBACK-DRAW:${drawId}`)
    || memoOrDescription.includes(`HOLDBACK-FUNDS:${drawId}`)
    || memoOrDescription.includes(drawId);
}

export async function tryVerifyDrawFromBankTxn(db, { importTransaction, userId, entityId }) {
  if (!importTransaction) return null;

  const { findHoldbackDrawForBankTxn, wireAttemptNumber } = await import('./holdback-bank-match.js');
  const match = await findHoldbackDrawForBankTxn(db, { entityId, importTransaction });
  if (!match) return null;

  if (match.status === 'verified' && match.import_transaction_id) {
    const prev = await db.get('SELECT description FROM import_transactions WHERE id = ?', match.import_transaction_id);
    const prevAttempt = wireAttemptNumber(prev?.description);
    const newAttempt = wireAttemptNumber(importTransaction.description);
    if (newAttempt <= prevAttempt) return null;
  }

  await db.run(
    `UPDATE holdback_disbursements
     SET status = 'verified', import_transaction_id = ?, bank_reference = ?,
         verified_at = CURRENT_TIMESTAMP, verified_by = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      importTransaction.id,
      importTransaction.fitid || importTransaction.id,
      userId || null,
      match.id,
    ]
  );

  return { ...match, status: 'verified' };
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

export { resolveFundingBank, ACTIVE_FUNDING_BANK };
