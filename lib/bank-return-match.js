import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { ensurePaymentReturnSchema, normalizePaymentReturnRow } from './payment-return-schema.js';
import { ensureHoldbackTable } from './holdback-disbursement.js';
import { postJournalEntryToGl } from './post-journal.js';
import { wireAmountMatchesDraw, borrowerMatchesWireDescription } from './holdback-bank-match.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.join(__dirname, '..', 'integration', 'return-payment-rules.json');

Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

function loadRules() {
  try {
    const raw = fs.readFileSync(RULES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.rules || [];
  } catch (error) {
    console.warn('return-payment-rules.json missing or invalid:', error.message);
    return [];
  }
}

function normalizeText(text) {
  return String(text || '').toUpperCase();
}

function amountSign(amount) {
  const n = Number(amount);
  if (n > 0) return 'credit';
  if (n < 0) return 'debit';
  return 'zero';
}

function ruleMatches(rule, { description, amount }) {
  const hay = normalizeText(description);
  const pat = normalizeText(rule.pattern);
  const sign = amountSign(amount);
  if (rule.amountSign === 'credit' && sign !== 'credit') return false;
  if (rule.amountSign === 'debit' && sign !== 'debit') return false;
  const absCents = Math.round(Math.abs(Number(amount)) * 100);
  if (rule.minAmountCents && absCents < rule.minAmountCents) return false;
  if (rule.maxAmountCents && absCents > rule.maxAmountCents) return false;

  if (rule.matchType === 'regex') {
    try {
      return new RegExp(rule.pattern, 'i').test(description || '');
    } catch {
      return false;
    }
  }
  if (rule.matchType === 'exact') return hay === pat;
  if (rule.matchType === 'starts_with') return hay.startsWith(pat);
  return hay.includes(pat);
}

async function resolveAccountId(db, entityId, accountNumber) {
  const row = await db.get(
    'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ? AND is_active = 1',
    [entityId, accountNumber]
  );
  return row?.id || null;
}

async function resolveBankAccountId(db, entityId, bankAccountNumber = '1000') {
  return resolveAccountId(db, entityId, bankAccountNumber);
}

async function matchHoldbackDraw(db, entityId, { amountCents, description }) {
  await ensureHoldbackTable(db);
  const rows = await db.all(
    `SELECT draw_id, loan_id, loan_num, net_disbursement, memo
     FROM holdback_disbursements
     WHERE entity_id = ? AND status IN ('exported', 'matched', 'verified')
     ORDER BY updated_at DESC LIMIT 200`,
    [entityId]
  );
  const target = amountCents / 100;
  for (const row of rows) {
    const net = Math.abs(Number(row.net_disbursement) || 0);
    if (wireAmountMatchesDraw(net, target, description)) {
      return {
        holdbackDrawId: row.draw_id,
        loanId: row.loan_id,
        loanNum: row.loan_num,
      };
    }
    if (borrowerMatchesWireDescription(row.borrower_name, description)
      && wireAmountMatchesDraw(net, target, description)) {
      return {
        holdbackDrawId: row.draw_id,
        loanId: row.loan_id,
        loanNum: row.loan_num,
      };
    }
    const memo = String(row.memo || description || '');
    const drawTag = `HOLDBACK-DRAW:${row.draw_id}`;
    if (memo.includes(drawTag) || String(description || '').includes(drawTag)) {
      return {
        holdbackDrawId: row.draw_id,
        loanId: row.loan_id,
        loanNum: row.loan_num,
      };
    }
  }
  return null;
}

async function matchLoanFromEvents(db, entityId, { amountCents, description }) {
  const rows = await db.all(
    `SELECT loan_id, loan_num, amount_cents, payload_json
     FROM loan_tracker_events
     WHERE entity_id = ? AND event_type IN ('nsf_return', 'ach_return', 'payment_return')
     ORDER BY created_at DESC LIMIT 100`,
    [entityId]
  );
  for (const row of rows) {
    if (row.amount_cents != null && Math.abs(row.amount_cents - Math.abs(amountCents)) <= 1) {
      return { loanId: row.loan_id, loanNum: row.loan_num };
    }
    try {
      const payload = JSON.parse(row.payload_json || '{}');
      const blob = `${payload.reference || ''} ${payload.note || ''} ${description || ''}`;
      if (row.loan_id && blob.toLowerCase().includes(String(row.loan_id).toLowerCase())) {
        return { loanId: row.loan_id, loanNum: row.loan_num };
      }
    } catch { /* ignore */ }
  }
  return null;
}

export function classifyBankReturn({ description, amount }) {
  const rules = loadRules();
  for (const rule of rules) {
    if (ruleMatches(rule, { description, amount })) {
      return rule;
    }
  }
  return null;
}

export async function detectPaymentReturn(db, {
  entityId = 'ent-ljc',
  txn,
  importTransactionId,
  bankAccountNumber = '1000',
  userId = 'system',
}) {
  if (!txn || !importTransactionId) return null;
  await ensurePaymentReturnSchema(db);

  const existing = await db.get(
    'SELECT id FROM payment_returns WHERE entity_id = ? AND bank_fitid = ?',
    [entityId, txn.fitid]
  );
  if (existing) return { duplicate: true, id: existing.id };

  const rule = classifyBankReturn({ description: txn.description, amount: txn.amount });
  if (!rule) return null;

  const amountCents = Math.round(Math.abs(Number(txn.amount)) * 100);
  let loanId = null;
  let loanNum = null;
  let holdbackDrawId = null;

  if (rule.returnType === 'wire_return') {
    const draw = await matchHoldbackDraw(db, entityId, { amountCents, description: txn.description });
    if (draw) {
      holdbackDrawId = draw.holdbackDrawId;
      loanId = draw.loanId;
      loanNum = draw.loanNum;
    }
  } else {
    const eventMatch = await matchLoanFromEvents(db, entityId, { amountCents, description: txn.description });
    if (eventMatch) {
      loanId = eventMatch.loanId;
      loanNum = eventMatch.loanNum;
    }
  }

  const id = `pr-${uuidv4()}`;
  const status = loanId || holdbackDrawId ? 'matched' : 'pending';
  await db.run(
    `INSERT INTO payment_returns
     (id, entity_id, return_type, status, sync_status, amount_cents, return_amount_cents, description, bank_reference,
      bank_fitid, import_transaction_id, loan_id, loan_num, holdback_draw_id, match_rule_id, recorded_at, synced_to_loan_tracker)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      id,
      entityId,
      rule.returnType,
      status,
      amountCents,
      amountCents,
      txn.description,
      txn.fitid || null,
      txn.fitid || null,
      importTransactionId,
      loanId,
      loanNum,
      holdbackDrawId,
      rule.id,
      txn.date || new Date().toISOString().slice(0, 10),
    ]
  );

  await db.run(
    'UPDATE import_transactions SET payment_return_id = ? WHERE id = ?',
    [id, importTransactionId]
  );

  if (status === 'matched' && rule.autoPostWhenMatched) {
    await draftOrPostPaymentReturnJe(db, {
      returnId: id,
      entityId,
      bankAccountNumber,
      userId,
      autoPost: true,
    });
  } else if (status === 'matched') {
    await draftOrPostPaymentReturnJe(db, {
      returnId: id,
      entityId,
      bankAccountNumber,
      userId,
      autoPost: false,
    });
  }

  return { id, returnType: rule.returnType, status, loanId, holdbackDrawId };
}

export async function draftOrPostPaymentReturnJe(db, {
  returnId,
  entityId,
  bankAccountNumber = '1000',
  userId = 'system',
  autoPost = false,
}) {
  const row = normalizePaymentReturnRow(
    await db.get('SELECT * FROM payment_returns WHERE id = ? AND entity_id = ?', [returnId, entityId])
  );
  if (!row) throw new Error('Payment return not found');
  if (row.journal_entry_id) {
    return { journalEntryId: row.journal_entry_id, alreadyDrafted: true };
  }

  const rules = loadRules();
  const rule = rules.find((r) => r.id === row.match_rule_id);
  if (!rule?.offsetAccount) {
    throw new Error('No offset account for payment return rule — cannot draft JE without proof mapping');
  }

  const bankAccountId = await resolveBankAccountId(db, entityId, bankAccountNumber);
  const offsetAccountId = await resolveAccountId(db, entityId, rule.offsetAccount);
  if (!bankAccountId || !offsetAccountId) {
    throw new Error(`Missing GL accounts for payment return (${bankAccountNumber} / ${rule.offsetAccount})`);
  }

  const amountCents = row.amount_cents ?? row.return_amount_cents ?? 0;
  const amount = new Decimal(amountCents).div(100);
  const isCredit = row.return_type === 'ach_nsf' || row.return_type === 'wire_return';
  const bankDebit = isCredit ? amount : new Decimal(0);
  const bankCredit = isCredit ? new Decimal(0) : amount;
  const offsetDebit = isCredit ? new Decimal(0) : amount;
  const offsetCredit = isCredit ? amount : new Decimal(0);

  const jeId = `je-${uuidv4()}`;
  const jeNumber = `RET-${row.return_type.toUpperCase()}-${Date.now().toString(36)}`;
  await db.run(
    `INSERT INTO journal_entries
     (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [
      jeId,
      entityId,
      jeNumber,
      `Payment return: ${rule.label || row.return_type}`,
      row.recorded_at || new Date().toISOString().slice(0, 10),
      userId,
      amount.toNumber(),
      amount.toNumber(),
      `payment_return:${returnId} | ${row.description || ''}`.slice(0, 500),
    ]
  );

  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [`jel-${uuidv4()}`, jeId, bankAccountId, bankDebit.toNumber(), bankCredit.toNumber(), row.description || 'Bank']
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 2)`,
    [`jel-${uuidv4()}`, jeId, offsetAccountId, offsetDebit.toNumber(), offsetCredit.toNumber(), rule.label || row.return_type]
  );

  await db.run(
    `UPDATE payment_returns
     SET journal_entry_id = ?, return_journal_id = ?, status = 'matched', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [jeId, jeId, returnId]
  );

  let posted = false;
  if (autoPost && row.import_transaction_id && (row.loan_id || row.holdback_draw_id)) {
    await postJournalEntryToGl(db, { journalId: jeId, entityId, userId });
    await db.run(
      `UPDATE payment_returns SET status = 'posted', posted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [returnId]
    );
    posted = true;
  }

  return { journalEntryId: jeId, jeNumber, posted, draft: !posted };
}

export async function listPendingPaymentReturnSync(db, entityId = 'ent-ljc') {
  await ensurePaymentReturnSchema(db);
  const rows = await db.all(
    `SELECT id, entity_id, return_type, status, amount_cents, return_amount_cents, description, bank_reference,
            loan_id, loan_num, holdback_draw_id, recorded_at, created_at, sync_status, synced_to_loan_tracker
     FROM payment_returns
     WHERE entity_id = ?
       AND (
         sync_status = 'pending'
         OR sync_status IS NULL AND COALESCE(synced_to_loan_tracker, 0) = 0
       )
       AND return_type IN ('ach_nsf', 'wire_return', 'ach_nsf_bank_fee')
       AND (loan_id IS NOT NULL OR holdback_draw_id IS NOT NULL)
     ORDER BY created_at ASC`,
    [entityId]
  );
  return rows.map((r) => {
    const row = normalizePaymentReturnRow(r);
    return {
      id: row.id,
      entityId: row.entity_id,
      returnType: row.return_type,
      status: row.status,
      amountCents: row.amount_cents,
      description: row.description,
      bankReference: row.bank_reference,
      loanId: row.loan_id,
      loanNum: row.loan_num,
      holdbackDrawId: row.holdback_draw_id,
      recordedAt: row.recorded_at,
      createdAt: row.created_at,
    };
  });
}

export async function ackPaymentReturnSync(db, returnId) {
  await ensurePaymentReturnSchema(db);
  const row = await db.get('SELECT id, sync_status FROM payment_returns WHERE id = ?', [returnId]);
  if (!row) throw new Error('Payment return not found');
  await db.run(
    `UPDATE payment_returns
     SET sync_status = 'synced', synced_to_loan_tracker = 1, synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [returnId]
  );
  return { id: returnId, syncStatus: 'synced' };
}

/** When loan app pushes NSF, link to an unmatched bank-feed return by amount + date. */
export async function matchPaymentReturnFromLoanEvent(db, payload) {
  await ensurePaymentReturnSchema(db);
  const entityId = payload.entityId || 'ent-ljc';
  const amountCents = Math.abs(Number(payload.amountCents) || 0);
  if (!amountCents || !payload.loanId) return null;

  const row = await db.get(
    `SELECT id FROM payment_returns
     WHERE entity_id = ? AND loan_id IS NULL AND holdback_draw_id IS NULL
       AND status = 'pending'
       AND (ABS(COALESCE(amount_cents, return_amount_cents, 0) - ?) <= 1)
     ORDER BY created_at DESC LIMIT 1`,
    [entityId, amountCents]
  );
  if (!row) return null;

  await db.run(
    `UPDATE payment_returns
     SET loan_id = ?, loan_num = ?, status = 'matched', matched_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [payload.loanId, payload.loanNum || null, row.id]
  );
  return { matchedReturnId: row.id, loanId: payload.loanId };
}
