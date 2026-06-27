/**
 * Full chart of accounts for Cohen Entities — QBO replacement baseline.
 * LJC Financial gets the complete lender/operating chart; related entities
 * get operating + intercompany due-from/due-to pairs.
 */

export const FULL_CHART_OF_ACCOUNTS = [
  // ── LJC Financial (operating lender) ─────────────────────────────────────
  { entity: 'ent-ljc', number: '1000', name: 'Cash & Bank Accounts - Simmons', type: 'ASSET' },
  { entity: 'ent-ljc', number: '1001', name: 'Cash - Lone Star Bank', type: 'ASSET' },
  { entity: 'ent-ljc', number: '1010', name: 'Cash - Simmons Sub-Accounts (4177/4790/7036)', type: 'ASSET' },
  { entity: 'ent-ljc', number: '1100', name: 'Undeposited Funds', type: 'ASSET' },
  { entity: 'ent-ljc', number: '1200', name: 'Accounts Receivable', type: 'ASSET' },
  { entity: 'ent-ljc', number: '1300', name: 'Notes Receivable', type: 'ASSET' },
  { entity: 'ent-ljc', number: '1310', name: 'Notes Receivable - Simmons DLOC', type: 'ASSET' },
  { entity: 'ent-ljc', number: '1350', name: 'Holdbacks - Simmons Bank', type: 'ASSET' },
  { entity: 'ent-ljc', number: '1400', name: 'Loan Receivable', type: 'ASSET' },
  { entity: 'ent-ljc', number: '1410', name: 'Mortgage / Servicing Escrow', type: 'ASSET' },
  { entity: 'ent-ljc', number: '1500', name: 'REO / Property Held for Sale', type: 'ASSET' },
  { entity: 'ent-ljc', number: '1900', name: 'Due From - GM', type: 'ASSET' },
  { entity: 'ent-ljc', number: '1901', name: 'Due From - Justin Cohen', type: 'ASSET' },
  { entity: 'ent-ljc', number: '1902', name: 'Due From - OMC', type: 'ASSET' },
  { entity: 'ent-ljc', number: '2000', name: 'Accounts Payable', type: 'LIABILITY' },
  { entity: 'ent-ljc', number: '2010', name: 'Credit Card - American Express', type: 'LIABILITY' },
  { entity: 'ent-ljc', number: '2011', name: 'Credit Card - Chase', type: 'LIABILITY' },
  { entity: 'ent-ljc', number: '2110', name: 'DLOC - Simmons Bank', type: 'LIABILITY' },
  { entity: 'ent-ljc', number: '2900', name: 'Due To - GM', type: 'LIABILITY' },
  { entity: 'ent-ljc', number: '2901', name: 'Due To - Justin Cohen', type: 'LIABILITY' },
  { entity: 'ent-ljc', number: '2902', name: 'Due To - OMC', type: 'LIABILITY' },
  { entity: 'ent-ljc', number: '3000', name: "Owner's Equity", type: 'EQUITY' },
  { entity: 'ent-ljc', number: '3100', name: 'Retained Earnings', type: 'EQUITY' },
  { entity: 'ent-ljc', number: '3900', name: 'Opening Balance Equity', type: 'EQUITY' },
  { entity: 'ent-ljc', number: '4000', name: 'Interest Income', type: 'REVENUE' },
  { entity: 'ent-ljc', number: '4100', name: 'Rental Income', type: 'REVENUE' },
  { entity: 'ent-ljc', number: '4200', name: 'Origination & Fee Income', type: 'REVENUE' },
  { entity: 'ent-ljc', number: '5000', name: 'Interest Expense', type: 'EXPENSE' },
  { entity: 'ent-ljc', number: '5100', name: 'Draw & Inspection Fees', type: 'EXPENSE' },
  { entity: 'ent-ljc', number: '5200', name: 'Bank Service Charges', type: 'EXPENSE' },
  { entity: 'ent-ljc', number: '5300', name: 'Insurance Expense', type: 'EXPENSE' },
  { entity: 'ent-ljc', number: '5400', name: 'Health Insurance', type: 'EXPENSE' },
  { entity: 'ent-ljc', number: '5500', name: 'Utilities', type: 'EXPENSE' },
  { entity: 'ent-ljc', number: '5600', name: 'Professional Fees', type: 'EXPENSE' },
  { entity: 'ent-ljc', number: '5700', name: 'Office & Software', type: 'EXPENSE' },
  { entity: 'ent-ljc', number: '5800', name: 'Chargebacks & Reversals', type: 'EXPENSE' },

  // ── Justin Cohen (related) ───────────────────────────────────────────────
  { entity: 'ent-justin', number: '1000', name: 'Cash & Bank Accounts', type: 'ASSET' },
  { entity: 'ent-justin', number: '1900', name: 'Due From - LJC Financial', type: 'ASSET' },
  { entity: 'ent-justin', number: '2000', name: 'Accounts Payable', type: 'LIABILITY' },
  { entity: 'ent-justin', number: '2900', name: 'Due To - LJC Financial', type: 'LIABILITY' },
  { entity: 'ent-justin', number: '3000', name: "Owner's Equity", type: 'EQUITY' },
  { entity: 'ent-justin', number: '3100', name: 'Retained Earnings', type: 'EQUITY' },
  { entity: 'ent-justin', number: '3900', name: 'Opening Balance Equity', type: 'EQUITY' },
  { entity: 'ent-justin', number: '4000', name: 'Other Income', type: 'REVENUE' },
  { entity: 'ent-justin', number: '5000', name: 'Operating Expenses', type: 'EXPENSE' },

  // ── OMC ──────────────────────────────────────────────────────────────────
  { entity: 'ent-omc', number: '1000', name: 'Cash & Bank Accounts', type: 'ASSET' },
  { entity: 'ent-omc', number: '1900', name: 'Due From - LJC Financial', type: 'ASSET' },
  { entity: 'ent-omc', number: '2000', name: 'Accounts Payable', type: 'LIABILITY' },
  { entity: 'ent-omc', number: '2900', name: 'Due To - LJC Financial', type: 'LIABILITY' },
  { entity: 'ent-omc', number: '3000', name: "Owner's Equity", type: 'EQUITY' },
  { entity: 'ent-omc', number: '3100', name: 'Retained Earnings', type: 'EQUITY' },
  { entity: 'ent-omc', number: '3900', name: 'Opening Balance Equity', type: 'EQUITY' },
  { entity: 'ent-omc', number: '4000', name: 'Other Income', type: 'REVENUE' },
  { entity: 'ent-omc', number: '5000', name: 'Operating Expenses', type: 'EXPENSE' },

  // ── GM ───────────────────────────────────────────────────────────────────
  { entity: 'ent-gm', number: '1000', name: 'Cash & Bank Accounts', type: 'ASSET' },
  { entity: 'ent-gm', number: '1900', name: 'Due From - LJC Financial', type: 'ASSET' },
  { entity: 'ent-gm', number: '2000', name: 'Accounts Payable', type: 'LIABILITY' },
  { entity: 'ent-gm', number: '2900', name: 'Due To - LJC Financial', type: 'LIABILITY' },
  { entity: 'ent-gm', number: '3000', name: "Owner's Equity", type: 'EQUITY' },
  { entity: 'ent-gm', number: '3100', name: 'Retained Earnings', type: 'EQUITY' },
  { entity: 'ent-gm', number: '3900', name: 'Opening Balance Equity', type: 'EQUITY' },
  { entity: 'ent-gm', number: '4000', name: 'Other Income', type: 'REVENUE' },
  { entity: 'ent-gm', number: '5000', name: 'Operating Expenses', type: 'EXPENSE' },
];
