/**
 * QBO Profit & Loss targets for LJC Financial — January 2026.
 * Source: data/qbo-reports/LJC_FINANCIAL__LLC_Profit_and_Loss_2026-01.csv
 * Cash basis, exported 2026-06-28.
 *
 * Amounts are QBO section totals mapped to app COA. Legacy rollup accounts
 * (5000, 5500, 5700) are zeroed — their bank/card activity is reclassified
 * into granular QBO-aligned accounts via catch-up deltas.
 */

export const QBO_PL_JAN_2026 = {
  entityId: 'ent-ljc',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  postingDate: '2026-01-31',
  jeNumber: 'QBO-PL-20260131',
  qboTotalRevenue: 69193.24,
  qboOtherIncome: 3.76,
  qboTotalExpense: 143486.58,
  qboNetIncome: -74289.58,
  /** @type {{ account: string, target: number, offset: string, label: string, section?: string }[]} */
  lines: [
    { account: '4000', target: 725.86, offset: '1000', label: 'Interest Income - Banks', section: 'income' },
    { account: '4010', target: 57947.73, offset: '1300', label: 'Lending Income (portfolio loans)', section: 'income' },
    { account: '4100', target: 10519.58, offset: '1200', label: 'Rental Income', section: 'income' },
    { account: '4090', target: 3.76, offset: '1300', label: 'Finance charges (other income)', section: 'other' },
    { account: '5910', target: 1189.33, offset: '3995', label: 'Automobile Expense' },
    { account: '5200', target: 465.96, offset: '1000', label: 'Bank Service Charges' },
    { account: '5710', target: 1005.34, offset: '3995', label: 'Computer & Internet' },
    { account: '5720', target: 500.0, offset: '3995', label: 'Donations' },
    { account: '5730', target: 158.58, offset: '3995', label: 'Dues & Subscriptions' },
    { account: '5400', target: 5696.48, offset: '3995', label: 'Health Insurance' },
    { account: '5300', target: 1445.0, offset: '3995', label: 'Member Life Insurance' },
    { account: '5800', target: 83483.8, offset: '2110', label: 'Lending (DLOC interest & fees)' },
    { account: '5740', target: 142.92, offset: '3995', label: 'Office Supplies' },
    { account: '6100', target: 47682.91, offset: '1500', label: 'Rental Property Expenses' },
    { account: '5750', target: 677.28, offset: '3995', label: 'Repairs & Maintenance' },
    { account: '5760', target: 338.98, offset: '3995', label: 'Telephone Expense' },
    { account: '5770', target: 700.0, offset: '3995', label: 'Unapplied Cash Bill Payment' },
    // Legacy rollup accounts — reclass Amex/bank misc into granular targets above
    { account: '5000', target: 0, offset: '2010', label: 'Clear Amex interest (reclass to lending/other)' },
    { account: '5500', target: 0, offset: '3995', label: 'Clear utilities (included in rental property target)' },
    { account: '5700', target: 0, offset: '3995', label: 'Clear uncategorized Amex (reclassed)' },
  ],
};
