/**
 * Shared guards so credit-card feeds never invent bank cash legs.
 *
 * Correct model:
 *   Charge:          DR expense · CR card
 *   Merchant credit: DR card · CR expense
 *   Card payment:    comes from the bank OFX (DR card · CR cash) — card feed skips
 */

export const CASH_LIKE_ACCOUNT_NUMBERS = Object.freeze([
  '1000', '1001', '1002', '1020', '1021', '1030', '1100',
]);

const PAYMENT_DESC_RE = /\b(payment|thank you|epayment|autopay|online payment|mobile payment)\b/i;
const MERCHANT_CREDIT_DESC_RE = /^credit:\s*|merchant credit|statement credit|price adjustment/i;

export function isCashLikeAccountNumber(num) {
  return CASH_LIKE_ACCOUNT_NUMBERS.includes(String(num || ''));
}

export function isLiabilityAccount(account) {
  return String(account?.account_type || '').toUpperCase() === 'LIABILITY';
}

/** True merchant credit / refund on a card statement (not a payoff from bank). */
export function isMerchantCreditTxn(txn = {}) {
  if (txn.isMerchantCredit === true) return true;
  const desc = String(txn.description || '');
  if (MERCHANT_CREDIT_DESC_RE.test(desc)) return true;
  return false;
}

/** Card payoff that should already exist (or will exist) on the bank feed. */
export function isCardPaymentTxn(txn = {}) {
  if (isMerchantCreditTxn(txn)) return false;
  if (txn.isPayment === true) return true;
  const desc = String(txn.description || '');
  if (PAYMENT_DESC_RE.test(desc)) return true;
  // Negative amount without Credit: prefix → treat as payment (Amex CSV convention).
  if (Number(txn.amount) < 0 && !MERCHANT_CREDIT_DESC_RE.test(desc)) return true;
  return false;
}

export async function assertNotCashOffset(db, entityId, offsetAccountId, context = 'card import') {
  if (!offsetAccountId) return;
  const row = await db.get(
    'SELECT account_number, account_name, account_type FROM accounts WHERE id = ? AND entity_id = ?',
    [offsetAccountId, entityId]
  );
  if (!row) throw new Error(`${context}: offset account not found`);
  if (isCashLikeAccountNumber(row.account_number)) {
    throw new Error(
      `${context}: refused to post against cash-like account ${row.account_number} (${row.account_name}). ` +
      'Card feeds must use expense/income offsets; bank OFX owns cash.'
    );
  }
  return row;
}
