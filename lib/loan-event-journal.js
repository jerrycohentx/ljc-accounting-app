import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';

/**
 * Turn a loan-servicing payment/payoff event into a balanced DRAFT journal entry.
 *
 * The servicing app is the source of truth for every payment's split, so it
 * pushes the split (in cents) and this drafts the accounting entry:
 *
 *   DR  deposit/cash      = gross received
 *       CR  note principal          (principalCents  -> 1300)
 *       CR  interest income         (interestCents   -> 4010)
 *       CR  default interest income (defaultInterestCents -> 4011)
 *       CR  loan fee income         (feeCents        -> 4200)
 *       CR  ACH processor fees      (achFeeCents     -> 5210, borrower reimbursement / contra)
 *       CR  escrow liability        (escrowCents     -> escrowAccountNumber, optional)
 *
 * IMPORTANT: this NEVER posts to the GL. It leaves the entry in DRAFT so Jerry
 * reviews and approves it (draft-then-approve is a hard rule). The bank deposit
 * still gets matched at reconcile time against this drafted cash line.
 *
 * All money is passed in integer CENTS to avoid float drift; only non-zero
 * components produce a line. Account numbers are overridable via
 * payload.accountMap for entities whose chart differs.
 */

const PAYMENT_EVENT_TYPES = new Set([
  'loan_payment', 'payment', 'loan_payoff', 'payoff', 'principal_paydown',
]);

export function isPaymentEvent(eventType) {
  return PAYMENT_EVENT_TYPES.has(String(eventType || '').trim().toLowerCase());
}

const DEFAULT_ACCOUNT_MAP = {
  deposit: '1000',            // DR — cash account the payment landed in
  principal: '1300',          // CR — note/loan principal (receivable)
  interest: '4010',           // CR — regular interest income
  defaultInterest: '4011',    // CR — default-rate interest income
  fees: '4200',               // CR — loan fee income
  achFee: '5210',             // CR — ACH processor fees (borrower reimbursement, contra)
  escrow: null,               // CR — escrow liability (only if escrowCents present)
};

// (payload split field, account-map key) for every credit component.
const CREDIT_COMPONENTS = [
  ['principalCents', 'principal', 'Loan principal'],
  ['interestCents', 'interest', 'Interest income'],
  ['defaultInterestCents', 'defaultInterest', 'Default-rate interest'],
  ['feeCents', 'fees', 'Loan fees'],
  ['achFeeCents', 'achFee', 'Borrower ACH fee (contra)'],
  ['escrowCents', 'escrow', 'Escrow'],
];

function cents(v) {
  if (v == null || v === '') return 0;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw new Error(`invalid cent amount: ${v}`);
  return n;
}

function dollars(c) {
  return new Decimal(c).div(100).toFixed(2);
}

async function resolveAccount(db, entityId, number) {
  const row = await db.get(
    'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, String(number)]
  );
  return row ? row.id : null;
}

/**
 * Build (but do not post) a DRAFT journal entry for a payment/payoff event.
 * Returns { drafted: false, reason } when the event carries no usable split,
 * or { drafted: true, journalId, jeNumber, totalCents, lines } on success.
 * Throws only on genuine misconfiguration (missing account for a non-zero
 * component, or an unbalanced split) so a bad push surfaces loudly.
 */
export async function draftJournalFromLoanEvent(db, { payload, eventId, userId = 'loan-tracker-auto' }) {
  const entityId = payload.entityId || 'ent-ljc';
  const split = payload.split || payload;
  const accountMap = { ...DEFAULT_ACCOUNT_MAP, ...(payload.accountMap || {}) };

  // Gather non-zero credit components.
  const components = [];
  for (const [field, mapKey, label] of CREDIT_COMPONENTS) {
    const amt = cents(split[field]);
    if (amt === 0) continue;
    const number = accountMap[mapKey];
    if (!number) {
      throw new Error(`loan-event ${eventId}: ${field}=${amt}c but no account mapped for "${mapKey}"`);
    }
    components.push({ field, mapKey, label, cents: amt, number });
  }

  const grossCents = components.reduce((s, c) => s + c.cents, 0);
  if (grossCents <= 0) {
    return { drafted: false, reason: 'no non-zero split components' };
  }

  // Cross-check against the pushed gross, if provided.
  if (payload.amountCents != null && cents(payload.amountCents) !== grossCents) {
    throw new Error(
      `loan-event ${eventId}: split components sum to ${grossCents}c but amountCents=${cents(payload.amountCents)}c`
    );
  }

  // Resolve every account up front so we fail before writing anything.
  const depositId = await resolveAccount(db, entityId, accountMap.deposit);
  if (!depositId) throw new Error(`loan-event ${eventId}: deposit account ${accountMap.deposit} not found for ${entityId}`);
  for (const c of components) {
    c.accountId = await resolveAccount(db, entityId, c.number);
    if (!c.accountId) throw new Error(`loan-event ${eventId}: account ${c.number} (${c.mapKey}) not found for ${entityId}`);
  }

  const eventDate = payload.eventDate || payload.event_date;
  if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    throw new Error(`loan-event ${eventId}: eventDate must be YYYY-MM-DD (got ${eventDate})`);
  }

  const loanTag = String(payload.loanNum || payload.loanId || 'LOAN').replace(/[^A-Za-z0-9-]/g, '').slice(0, 20);
  const jeId = `je-${uuidv4()}`;
  const jeNumber = `LN-${loanTag}-${eventDate.replace(/-/g, '')}-${String(eventId).slice(-6)}`;
  const grossStr = dollars(grossCents);
  const borrower = payload.borrowerName ? ` ${payload.borrowerName}` : '';
  const description = `Loan payment${borrower} (${payload.loanNum || payload.loanId || ''})`.trim();

  await db.run(
    `INSERT INTO journal_entries (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [jeId, entityId, jeNumber, description, eventDate, userId, grossStr, grossStr, `LOAN-EVENT:${eventId}`]
  );

  // Line 1: DR deposit/cash for the gross.
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, 0, ?, 1)`,
    [`jel-${uuidv4()}`, jeId, depositId, grossStr, `Payment received${borrower}`.trim()]
  );

  // Lines 2..n: CR each non-zero component.
  let lineNo = 2;
  const lines = [{ account: accountMap.deposit, debit: grossStr, credit: '0.00' }];
  for (const c of components) {
    const amtStr = dollars(c.cents);
    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
      [`jel-${uuidv4()}`, jeId, c.accountId, amtStr, c.label, lineNo]
    );
    lines.push({ account: c.number, debit: '0.00', credit: amtStr, label: c.label });
    lineNo += 1;
  }

  return { drafted: true, journalId: jeId, jeNumber, totalCents: grossCents, lines };
}
