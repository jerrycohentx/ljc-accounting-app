import { categorizeTransaction, resolveAccountByNumber } from './categorization-rules.js';
import { isCardPaymentTxn, isMerchantCreditTxn } from './card-import-guards.js';

const DEFAULT_EXPENSE = '5700';

/** Map Amex export Category strings to GL expense accounts. */
const AMEX_CATEGORY_MAP = [
  { pattern: /interest charge/i, account: '5000', label: 'Interest expense' },
  { pattern: /fees & adjustments|renewal membership fee|late fee/i, account: '5200', label: 'Bank/card fees' },
  { pattern: /utilities/i, account: '5500', label: 'Utilities' },
  { pattern: /insurance/i, account: '5300', label: 'Insurance' },
  { pattern: /restaurants|food/i, account: '5700', label: 'Meals' },
  { pattern: /travel|airline|hotel|car rental/i, account: '5600', label: 'Travel' },
  { pattern: /professional|legal|accounting/i, account: '5600', label: 'Legal & professional fees' },
  { pattern: /merchandise|internet purchase|mail order/i, account: '5700', label: 'Office/supplies' },
  { pattern: /business services|contracting/i, account: '5700', label: 'Business services' },
  { pattern: /health|medical|pharmacy/i, account: '5400', label: 'Health' },
  { pattern: /gas|fuel|automotive/i, account: '5700', label: 'Auto/fuel' },
  { pattern: /advertising|marketing/i, account: '5700', label: 'Marketing' },
];

export async function categorizeAmexTransaction(db, entityId, txn) {
  // True card payoffs must NOT post CR Cash — bank OFX owns that leg.
  if (isCardPaymentTxn(txn) && !isMerchantCreditTxn(txn)) {
    return {
      offsetAccountId: null,
      offsetAccountNumber: null,
      label: 'Card payment (match bank ACH — do not post cash)',
      isPayment: true,
      skipCashPosting: true,
    };
  }

  // Learned + merchant bank rules win over coarse Amex export categories.
  const bankRule = await categorizeTransaction(db, entityId, txn.description || '');
  if (bankRule.offsetAccountId && !bankRule.isTransfer && bankRule.offsetAccountNumber !== DEFAULT_EXPENSE) {
    return {
      ...bankRule,
      isMerchantCredit: isMerchantCreditTxn(txn),
    };
  }

  const category = txn.category || '';
  for (const rule of AMEX_CATEGORY_MAP) {
    if (rule.pattern.test(category) || rule.pattern.test(txn.description || '')) {
      const acct = await resolveAccountByNumber(db, entityId, rule.account);
      if (acct) {
        return {
          offsetAccountId: acct.id,
          offsetAccountNumber: rule.account,
          label: rule.label,
          isMerchantCredit: isMerchantCreditTxn(txn),
        };
      }
    }
  }

  if (bankRule.offsetAccountId && !bankRule.isTransfer) {
    return {
      ...bankRule,
      isMerchantCredit: isMerchantCreditTxn(txn),
    };
  }

  const fallback = await resolveAccountByNumber(db, entityId, DEFAULT_EXPENSE);
  return {
    offsetAccountId: fallback?.id,
    offsetAccountNumber: DEFAULT_EXPENSE,
    label: isMerchantCreditTxn(txn) ? 'Amex merchant credit' : 'Amex expense (uncategorized)',
    isMerchantCredit: isMerchantCreditTxn(txn),
  };
}
