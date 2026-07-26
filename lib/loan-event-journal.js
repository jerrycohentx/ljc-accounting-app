import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { INTERCOMPANY_PAIRS } from '../config/intercompany-pairs.js';

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

// journal_entries.created_by is a FK to users(id). The loan-tracker key path
// has no logged-in user, so resolve a real one: prefer an explicitly-passed
// valid user, then the machine/demo user, then any user.
async function resolveCreatedBy(db, preferred) {
  if (preferred) {
    const u = await db.get('SELECT id FROM users WHERE id = ?', [preferred]).catch(() => null);
    if (u) return u.id;
  }
  let u = await db.get(
    "SELECT id FROM users WHERE id = 'usr-demo' OR email = 'demo@ljcfinancial.com' LIMIT 1"
  ).catch(() => null);
  if (u) return u.id;
  u = await db.get('SELECT id FROM users LIMIT 1').catch(() => null);
  if (!u) throw new Error('no users available for journal_entries.created_by');
  return u.id;
}

/**
 * Build (but do not post) a DRAFT journal entry for a payment/payoff event.
 * Returns { drafted: false, reason } when the event carries no usable split,
 * or { drafted: true, journalId, jeNumber, totalCents, lines } on success.
 * Throws only on genuine misconfiguration (missing account for a non-zero
 * component, or an unbalanced split) so a bad push surfaces loudly.
 */
export async function draftJournalFromLoanEvent(db, { payload, eventId, userId = null }) {
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
  const createdBy = await resolveCreatedBy(db, userId);

  await db.run(
    `INSERT INTO journal_entries (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [jeId, entityId, jeNumber, description, eventDate, createdBy, grossStr, grossStr, `LOAN-EVENT:${eventId}`]
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

/**
 * Related-party prepaid interest (and similar no-cash charges).
 *
 * Rule: cash does not change hands between related Cohen entities. Book
 * intercompany instead:
 *   LJC:      Dr Due from counterparty · Cr interest income
 *   Borrower: Dr interest expense · Cr Due to LJC
 *
 * DRAFT only — Jerry approves. Uses INTERCOMPANY_PAIRS account numbers.
 */
const RELATED_PARTY_IC_EVENTS = new Set([
  'related_party_prepaid_interest',
  'related_party_interest',
  'related_party_charge',
]);

export function isRelatedPartyIcEvent(eventType) {
  return RELATED_PARTY_IC_EVENTS.has(String(eventType || '').trim().toLowerCase());
}

function findIcPair(ljcEntityId, counterpartyEntityId) {
  return INTERCOMPANY_PAIRS.find((p) => {
    const a = p.sideA;
    const b = p.sideB;
    return (
      (a.entity === ljcEntityId && a.role === 'due_from' && b.entity === counterpartyEntityId && b.role === 'due_to') ||
      (b.entity === ljcEntityId && b.role === 'due_from' && a.entity === counterpartyEntityId && a.role === 'due_to')
    );
  });
}

function icAccountsForPair(pair, ljcEntityId, counterpartyEntityId) {
  if (!pair) return null;
  const ljcSide = pair.sideA.entity === ljcEntityId ? pair.sideA : pair.sideB;
  const cpSide = pair.sideA.entity === counterpartyEntityId ? pair.sideA : pair.sideB;
  if (!ljcSide || !cpSide) return null;
  return {
    ljcDueFrom: ljcSide.role === 'due_from' ? ljcSide.account : null,
    counterpartyDueTo: cpSide.role === 'due_to' ? cpSide.account : null,
  };
}

async function draftOneIcJournal(db, {
  entityId, jeNumber, description, eventDate, userId, eventId,
  debitNumber, creditNumber, amountCents, debitLabel, creditLabel,
}) {
  const amtStr = dollars(amountCents);
  const debitId = await resolveAccount(db, entityId, debitNumber);
  const creditId = await resolveAccount(db, entityId, creditNumber);
  if (!debitId) throw new Error(`related-party IC: account ${debitNumber} not found for ${entityId}`);
  if (!creditId) throw new Error(`related-party IC: account ${creditNumber} not found for ${entityId}`);

  const existing = await db.get(
    'SELECT id, je_number, status FROM journal_entries WHERE entity_id = ? AND je_number = ?',
    [entityId, jeNumber]
  );
  if (existing) {
    return { drafted: false, skipped: true, journalId: existing.id, jeNumber: existing.je_number, entityId };
  }

  const createdBy = await resolveCreatedBy(db, userId);
  const jeId = `je-${uuidv4()}`;
  await db.run(
    `INSERT INTO journal_entries (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [jeId, entityId, jeNumber, description, eventDate, createdBy, amtStr, amtStr, `LOAN-EVENT:${eventId}`]
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, 0, ?, 1)`,
    [`jel-${uuidv4()}`, jeId, debitId, amtStr, debitLabel]
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, 0, ?, ?, 2)`,
    [`jel-${uuidv4()}`, jeId, creditId, amtStr, creditLabel]
  );
  return {
    drafted: true,
    journalId: jeId,
    jeNumber,
    entityId,
    totalCents: amountCents,
    lines: [
      { account: debitNumber, debit: amtStr, credit: '0.00' },
      { account: creditNumber, debit: '0.00', credit: amtStr },
    ],
  };
}

/**
 * Draft mirrored IC journals for a related-party prepaid/interest event.
 * Returns { drafted, ljc, counterparty } — never posts.
 */
export async function draftRelatedPartyIntercompanyJournals(db, { payload, eventId, userId = null }) {
  const ljcEntityId = payload.entityId || 'ent-ljc';
  const counterpartyEntityId = payload.counterpartyEntityId;
  if (!counterpartyEntityId) {
    throw new Error(`loan-event ${eventId}: counterpartyEntityId required for related-party IC`);
  }
  const amountCents = cents(payload.amountCents);
  if (amountCents <= 0) {
    return { drafted: false, reason: 'amountCents must be > 0' };
  }
  const eventDate = payload.eventDate || payload.event_date;
  if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    throw new Error(`loan-event ${eventId}: eventDate must be YYYY-MM-DD (got ${eventDate})`);
  }

  const pair = findIcPair(ljcEntityId, counterpartyEntityId);
  const accounts = icAccountsForPair(pair, ljcEntityId, counterpartyEntityId);
  if (!accounts?.ljcDueFrom || !accounts?.counterpartyDueTo) {
    throw new Error(
      `loan-event ${eventId}: no intercompany due-from/due-to pair for ${ljcEntityId} ↔ ${counterpartyEntityId}`
    );
  }

  // Income on LJC; expense on borrower. Prefer dedicated interest accounts.
  const ljcIncome = (payload.accountMap && payload.accountMap.ljcInterestIncome) || '4010';
  let cpExpense = (payload.accountMap && payload.accountMap.counterpartyInterestExpense) || '5010';
  // Fall back to 5000 if 5010 is not seeded for that entity yet.
  if (!(await resolveAccount(db, counterpartyEntityId, cpExpense))) {
    cpExpense = '5000';
  }

  const loanTag = String(payload.loanNum || payload.loanId || 'LOAN').replace(/[^A-Za-z0-9-]/g, '').slice(0, 16);
  const dateTag = eventDate.replace(/-/g, '');
  const borrower = payload.borrowerName || 'related company';
  const property = payload.propertyAddress ? ` · ${payload.propertyAddress}` : '';
  const baseDesc = `Related-party prepaid interest (IC, no cash) — ${borrower}${property}`;

  const ljc = await draftOneIcJournal(db, {
    entityId: ljcEntityId,
    jeNumber: `IC-PPD-LJC-${loanTag}-${dateTag}`,
    description: baseDesc,
    eventDate,
    userId,
    eventId,
    debitNumber: accounts.ljcDueFrom,
    creditNumber: ljcIncome,
    amountCents,
    debitLabel: `Due from ${borrower} — prepaid interest (no cash)`,
    creditLabel: 'Prepaid / portfolio interest income (related party)',
  });

  const counterparty = await draftOneIcJournal(db, {
    entityId: counterpartyEntityId,
    jeNumber: `IC-PPD-CP-${loanTag}-${dateTag}`,
    description: baseDesc,
    eventDate,
    userId,
    eventId,
    debitNumber: cpExpense,
    creditNumber: accounts.counterpartyDueTo,
    amountCents,
    debitLabel: 'Interest expense — prepaid at closing (related party, no cash)',
    creditLabel: 'Due to LJC Financial — prepaid interest (intercompany)',
  });

  return {
    drafted: !!(ljc.drafted || counterparty.drafted),
    amountCents,
    ljc,
    counterparty,
  };
}
