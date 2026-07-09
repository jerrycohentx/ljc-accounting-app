/**
 * Turns a parsed property-management report (see lib/mgmt-report-parser.js)
 * into a balanced DRAFT journal entry, following the same pattern Jerry
 * already uses by hand for WestSide Realty ("Due from Westside Realty" ->
 * account 1200 Accounts Receivable): gross rental income and each expense
 * line item are recognized on the books immediately (accrual), and the net
 * (income minus expenses withheld by the manager) sits in 1200 as a
 * receivable until the manager's actual cash remittance clears the bank —
 * which the existing bank-feed reconciliation pipeline already books
 * separately. This import intentionally does NOT touch cash/bank accounts
 * itself and does NOT book the report's "Received from owner" / "Paid to
 * owner" / deposit lines — those can be internal movements within the
 * manager's own trust account that never touch LJC's bank, or, when they do
 * hit the bank, are already captured by the Plaid/OFX reconciliation flow.
 * Booking them here too would risk double-counting. They're preserved on
 * the review record for Jerry's reference, just not posted.
 */

const AR_ACCOUNT_NUMBER = '1200';
const REVENUE_ACCOUNT_NUMBER = '4100';
const DEFAULT_EXPENSE_ACCOUNT_NUMBER = '6100';

function periodLabel(periodStart, periodEnd) {
  if (periodEnd) return periodEnd;
  return 'period unknown';
}

function resolveExpenseAccountNumber(property, label) {
  const l = String(label || '').toLowerCase();
  const u = property?.utilityAccounts;
  if (u) {
    if (/gas/.test(l) && u.gas) return u.gas;
    if (/electric/.test(l) && u.electric) return u.electric;
    if (/water|sewer/.test(l) && u.water) return u.water;
  }
  return DEFAULT_EXPENSE_ACCOUNT_NUMBER;
}

/**
 * accountsByNumber: Map<accountNumber, {id, account_number, account_name}>
 * for the target entity (caller loads these from the `accounts` table).
 */
export function buildJournalEntryPlan(parsed, property, accountsByNumber) {
  const missingAccounts = [];
  function acct(number) {
    const a = accountsByNumber.get(number);
    if (!a) missingAccounts.push(number);
    return a;
  }

  const propertyName = property ? property.canonical : (parsed.propertyRaw || 'Unknown property');
  const mgmtCo = parsed.managementCompany || 'property manager';
  const label = periodLabel(parsed.periodStart, parsed.periodEnd);

  const lines = [];

  if (parsed.totalIncomeCents > 0) {
    const ar = acct(AR_ACCOUNT_NUMBER);
    const rev = acct(REVENUE_ACCOUNT_NUMBER);
    lines.push({ accountNumber: AR_ACCOUNT_NUMBER, account: ar, debitCents: parsed.totalIncomeCents, creditCents: 0, description: `Due from ${mgmtCo} — gross rent — ${propertyName} — ${label}` });
    lines.push({ accountNumber: REVENUE_ACCOUNT_NUMBER, account: rev, debitCents: 0, creditCents: parsed.totalIncomeCents, description: `Rent — ${propertyName} — ${label}` });
  }

  for (const line of parsed.expenseLines) {
    if (!line.cents) continue;
    let accountNumber = resolveExpenseAccountNumber(property, line.label);
    let a = accountsByNumber.get(accountNumber);
    if (!a && accountNumber !== DEFAULT_EXPENSE_ACCOUNT_NUMBER) {
      // Registry pointed at a property-specific utility account that isn't
      // actually in this entity's chart yet — fall back to the generic
      // bucket rather than blocking the whole entry.
      accountNumber = DEFAULT_EXPENSE_ACCOUNT_NUMBER;
      a = accountsByNumber.get(accountNumber);
    }
    if (!a) missingAccounts.push(accountNumber);
    lines.push({ accountNumber, account: a, debitCents: line.cents, creditCents: 0, description: `${line.label} — ${propertyName}` });
  }

  if (parsed.totalExpenseCents > 0) {
    const ar = acct(AR_ACCOUNT_NUMBER);
    lines.push({ accountNumber: AR_ACCOUNT_NUMBER, account: ar, debitCents: 0, creditCents: parsed.totalExpenseCents, description: `${mgmtCo} withheld from rent — ${propertyName} — ${label}` });
  }

  const totalDebit = lines.reduce((s, l) => s + l.debitCents, 0);
  const totalCredit = lines.reduce((s, l) => s + l.creditCents, 0);
  const balanced = totalDebit === totalCredit && totalDebit > 0;

  const postingDate = parsed.periodEnd || new Date().toISOString().slice(0, 10);
  const description = `${mgmtCo} management report — ${propertyName} — ${label}`;

  return {
    description,
    postingDate,
    lines,
    totalDebitCents: totalDebit,
    totalCreditCents: totalCredit,
    balanced,
    missingAccounts: [...new Set(missingAccounts)],
    canPost: balanced && missingAccounts.length === 0 && lines.length >= 2,
  };
}

export { AR_ACCOUNT_NUMBER, REVENUE_ACCOUNT_NUMBER, DEFAULT_EXPENSE_ACCOUNT_NUMBER };
