/**
 * QBO Profit & Loss targets for LJC Financial — February 1 through June 27, 2026.
 * Source: data/qbo-reports/LJC_FINANCIAL__LLC_Profit_and_Loss_2026-02-06.csv
 * Cash basis, exported 2026-06-28.
 */

export const QBO_PL_FEB_JUN_2026 = {
  entityId: 'ent-ljc',
  periodStart: '2026-02-01',
  periodEnd: '2026-06-27',
  postingDate: '2026-06-27',
  jeNumber: 'QBO-PL-20260627',
  qboTotalRevenue: 313507.54,
  qboOtherIncome: 1914.66,
  qboTotalExpense: 463782.98,
  qboNetIncome: -148360.78,
  lines: [
    { account: '4000', target: 705.97, offset: '1000', label: 'Interest Income - Banks', section: 'income' },
    { account: '4010', target: 148642.3, offset: '1300', label: 'Lending Income (portfolio loans)', section: 'income' },
    { account: '4100', target: 50217.65, offset: '1200', label: 'Rental Income', section: 'income' },
    { account: '4150', target: 153946.27, offset: '1500', label: 'REO / Property Sales', section: 'income' },
    { account: '4080', target: -40504.9, offset: '1500', label: 'Gain (Loss) on Sale of REO', section: 'income' },
    { account: '4091', target: 500.25, offset: '1200', label: 'Uncategorized Income', section: 'income' },
    { account: '4090', target: 1914.66, offset: '1300', label: 'Finance charges (other income)', section: 'other' },
    { account: '5910', target: 2557.18, offset: '3995', label: 'Automobile Expense' },
    { account: '5200', target: 1351.23, offset: '1000', label: 'Bank Service Charges' },
    { account: '5920', target: 154150.0, offset: '3995', label: 'Commissions Paid' },
    { account: '5710', target: 2442.82, offset: '3995', label: 'Computer & Internet' },
    { account: '6110', target: 9314.49, offset: '1500', label: 'Fees Paid on Sale of REO' },
    { account: '5400', target: 3759.27, offset: '3995', label: 'Health Insurance' },
    { account: '5800', target: 123075.96, offset: '2110', label: 'Lending (DLOC interest & fees)' },
    { account: '5740', target: 565.22, offset: '3995', label: 'Office Supplies & Postage' },
    { account: '6100', target: 165837.45, offset: '1500', label: 'Rental Property Expenses' },
    { account: '5750', target: 11.85, offset: '3995', label: 'Repairs & Maintenance' },
    { account: '5760', target: 717.51, offset: '3995', label: 'Telephone Expense' },
    { account: '5300', target: 0, offset: '3995', label: 'Clear insurance (QBO rental/lending buckets Feb-Jun)' },
    { account: '5600', target: 0, offset: '3995', label: 'Clear professional fees (QBO lending/legal)' },
    { account: '5000', target: 0, offset: '2010', label: 'Clear card interest (reclassed)' },
    { account: '5500', target: 0, offset: '3995', label: 'Clear utilities (in rental bucket)' },
    { account: '5700', target: 0, offset: '3995', label: 'Clear uncategorized card (reclassed)' },
  ],
};
