import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { postJournalEntryToGl } from './post-journal.js';

/**
 * Homebase -> ljc-accounting-app sync (Graceful Meadows / ent-gm)
 *
 * Pulls approved timecards from the Homebase Public API for the Graceful
 * Meadows location and books them as an accrued payroll journal entry:
 *   DR 6000  Payroll Expense - Wages
 *   CR 2100  Payroll Liabilities
 *
 * Homebase's public API (as of 2026-07) exposes scheduling / timeclock /
 * timecard data and computed labor cost (ActualLabor.costs = wage_rate x
 * hours), but does NOT expose actual payroll runs (net pay, tax withholding,
 * deductions, direct deposit amounts). So this sync books the *gross wage
 * cost accrual* based on approved hours worked, not a real payroll
 * disbursement. Once Jerry runs real payroll (e.g. via Homebase Payroll or
 * a payroll provider), that provider's actual net pay / tax data should be
 * the source for the cash disbursement entries; this sync only handles the
 * "hours worked -> wages owed" accrual side.
 */

const HOMEBASE_API_BASE = 'https://api.joinhomebase.com';
const HOMEBASE_ACCEPT_HEADER = 'application/vnd.homebase-v1+json';

const GM_ENTITY_ID = 'ent-gm';
const GM_LOCATION_UUID = process.env.HOMEBASE_GM_LOCATION_UUID || 'de8c7db7-b64f-49d7-b1ec-d2394926df6c';

const PAYROLL_EXPENSE_ACCOUNT_NUMBER = '6000'; // Payroll Expense - Wages
const PAYROLL_LIABILITY_ACCOUNT_NUMBER = '2100'; // Payroll Liabilities

export function isHomebaseConfigured() {
  return Boolean(process.env.HOMEBASE_API_KEY);
}

function homebaseHeaders() {
  if (!isHomebaseConfigured()) {
    throw new Error('Homebase is not configured. Set HOMEBASE_API_KEY.');
  }
  return {
    Authorization: `Bearer ${process.env.HOMEBASE_API_KEY}`,
    Accept: HOMEBASE_ACCEPT_HEADER,
  };
}

async function homebaseGet(path, params = {}) {
  const url = new URL(`${HOMEBASE_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: homebaseHeaders() });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message = (body && body.error) || `Homebase API error ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Fetch approved timecards for the Graceful Meadows location within a date
 * range (inclusive). Homebase paginates; we follow pages until exhausted.
 */
export async function fetchGmTimecards(startDate, endDate) {
  const perPage = 100;
  let page = 1;
  const all = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await homebaseGet(`/locations/${GM_LOCATION_UUID}/timecards`, {
      start_date: startDate,
      end_date: endDate,
      page,
      per_page: perPage,
    });
    const rows = Array.isArray(batch) ? batch : [];
    all.push(...rows);
    if (rows.length < perPage) break;
    page += 1;
    if (page > 50) break; // safety valve
  }
  return all;
}

export async function fetchGmEmployees() {
  const employees = await homebaseGet(`/locations/${GM_LOCATION_UUID}/employees`);
  return Array.isArray(employees) ? employees : [];
}

/**
 * Summarize approved timecards into a gross wage total, using each
 * timecard's computed labor.costs (Homebase's own wage_rate x hours calc).
 * Unapproved timecards and timecards with no computed cost are excluded
 * from the accrual but included in the summary for visibility.
 */
export function summarizeTimecards(timecards) {
  let totalCost = new Decimal(0);
  let totalHours = new Decimal(0);
  let approvedCount = 0;
  let unapprovedCount = 0;

  for (const tc of timecards) {
    if (!tc.approved) {
      unapprovedCount += 1;
      continue;
    }
    approvedCount += 1;
    const cost = new Decimal(tc.labor?.costs || 0);
    const hours = new Decimal(tc.labor?.paid_hours || 0);
    totalCost = totalCost.plus(cost);
    totalHours = totalHours.plus(hours);
  }

  return {
    approvedCount,
    unapprovedCount,
    totalCount: timecards.length,
    totalCost: totalCost.toFixed(2),
    totalHours: totalHours.toFixed(2),
  };
}

async function getAccountId(db, entityId, accountNumber) {
  const account = await db.get(
    'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, accountNumber]
  );
  return account ? account.id : null;
}

/**
 * Run the sync for a date range: fetch Homebase timecards, and if there's
 * any approved wage cost, book it as a payroll accrual journal entry.
 * Idempotent per date range: if a journal entry already exists for this
 * exact range (same je_number), the existing entry's summary is returned
 * instead of double-posting.
 */
export async function runHomebaseSync(db, { startDate, endDate, userId }) {
  if (!isHomebaseConfigured()) {
    throw new Error('HOMEBASE_API_KEY is not set. Cannot run sync.');
  }
  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required (YYYY-MM-DD)');
  }

  const [timecards, employees] = await Promise.all([
    fetchGmTimecards(`${startDate}T00:00:00Z`, `${endDate}T23:59:59Z`),
    fetchGmEmployees(),
  ]);

  const summary = summarizeTimecards(timecards);
  const jeNumber = `HB-${startDate.replace(/-/g, '')}-${endDate.replace(/-/g, '')}`;

  const result = {
    entityId: GM_ENTITY_ID,
    locationUuid: GM_LOCATION_UUID,
    startDate,
    endDate,
    employeeCount: employees.length,
    ...summary,
    posted: false,
    jeNumber,
  };

  const total = new Decimal(summary.totalCost);
  if (total.lte(0)) {
    result.message = 'Sync ran cleanly. No approved payroll cost to post for this range (no caregivers/paid hours yet).';
    return result;
  }

  const existing = await db.get(
    'SELECT id, status FROM journal_entries WHERE entity_id = ? AND je_number = ?',
    [GM_ENTITY_ID, jeNumber]
  );
  if (existing) {
    result.posted = existing.status === 'POSTED';
    result.alreadyExists = true;
    result.message = `Journal entry ${jeNumber} already exists (status: ${existing.status}); not double-posting.`;
    return result;
  }

  const expenseAccountId = await getAccountId(db, GM_ENTITY_ID, PAYROLL_EXPENSE_ACCOUNT_NUMBER);
  const liabilityAccountId = await getAccountId(db, GM_ENTITY_ID, PAYROLL_LIABILITY_ACCOUNT_NUMBER);
  if (!expenseAccountId || !liabilityAccountId) {
    throw new Error(
      `Expected chart-of-accounts entries missing for ent-gm (account ${PAYROLL_EXPENSE_ACCOUNT_NUMBER} or ${PAYROLL_LIABILITY_ACCOUNT_NUMBER})`
    );
  }

  const jeId = `je-${uuidv4()}`;
  const amt = total.toFixed(2);

  await db.run(
    `INSERT INTO journal_entries (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [
      jeId,
      GM_ENTITY_ID,
      jeNumber,
      `Homebase payroll accrual ${startDate} to ${endDate}`,
      endDate,
      userId || 'system',
      amt,
      amt,
      `AUTO-HOMEBASE-SYNC | ${summary.approvedCount} approved timecard(s), ${summary.totalHours} hrs`,
    ]
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number) VALUES (?, ?, ?, ?, 0, ?, 1)`,
    [`jel-${uuidv4()}`, jeId, expenseAccountId, amt, 'Homebase payroll wage accrual']
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number) VALUES (?, ?, ?, 0, ?, ?, 2)`,
    [`jel-${uuidv4()}`, jeId, liabilityAccountId, amt, 'Accrued payroll liability - Homebase']
  );

  await postJournalEntryToGl(db, { journalId: jeId, entityId: GM_ENTITY_ID, userId });

  result.posted = true;
  result.amountPosted = amt;
  result.message = `Posted $${amt} payroll accrual (${summary.approvedCount} approved timecard(s)) as journal entry ${jeNumber}.`;
  return result;
}
