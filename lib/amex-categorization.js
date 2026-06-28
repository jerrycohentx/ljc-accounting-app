import { categorizeTransaction, resolveAccountByNumber } from './categorization-rules.js';

const DEFAULT_EXPENSE = '5700';
const DEFAULT_PAYMENT_OFFSET = '1000';

/** Map Amex export Category strings to GL expense accounts. */
const AMEX_CATEGORY_MAP = [
  { pattern: /interest charge/i, account: '5000', label: 'Interest expense' },
  { pattern: /fees & adjustments|renewal membership fee|late fee/i, account: '5200', label: 'Bank/card fees' },
  { pattern: /utilities/i, account: '5500', label: 'Utilities' },
  { pattern: /insurance/i, account: '5300', label: 'Insurance' },
  { pattern: /restaurants|food/i, account: '5700', label: 'Meals' },
  { pattern: /travel|airline|hotel|car rental/i, account: '5600', label: 'Travel' },
  { pattern: /professional|legal|accounting/i, account: '5600', label: 'Professional fees' },
  { pattern: /merchandise|internet purchase|mail order/i, account: '5700', label: 'Office/supplies' },
  { pattern: /business services|contracting/i, account: '5700', label: 'Business services' },
  { pattern: /health|medical|pharmacy/i, account: '5400', label: 'Health' },
  { pattern: /gas|fuel|automotive/i, account: '5700', label: 'Auto/fuel' },
  { pattern: /advertising|marketing/i, account: '5700', label: 'Marketing' },
];

export async function categorizeAmexTransaction(db, entityId, txn) {
  if (txn.isPayment || txn.amount < 0) {
    const cash = await resolveAccountByNumber(db, entityId, DEFAULT_PAYMENT_OFFSET);
    return {
      offsetAccountId: cash?.id,
      offsetAccountNumber: DEFAULT_PAYMENT_OFFSET,
      label: 'Card payment (cash)',
      isPayment: true,
    };
  }

  const category = txn.category || '';
  for (const rule of AMEX_CATEGORY_MAP) {
    if (rule.pattern.test(category) || rule.pattern.test(txn.description)) {
      const acct = await resolveAccountByNumber(db, entityId, rule.account);
      if (acct) {
        return {
          offsetAccountId: acct.id,
          offsetAccountNumber: rule.account,
          label: rule.label,
        };
      }
    }
  }

  const bankRule = await categorizeTransaction(db, entityId, txn.description);
  if (bankRule.offsetAccountId && !bankRule.isTransfer) {
    return bankRule;
  }

  const fallback = await resolveAccountByNumber(db, entityId, DEFAULT_EXPENSE);
  return {
    offsetAccountId: fallback?.id,
    offsetAccountNumber: DEFAULT_EXPENSE,
    label: 'Amex expense (uncategorized)',
  };
}
