import Decimal from 'decimal.js';

/**
 * Map a raw Ramp card transaction to the shared bank-import shape used by
 * commitBankImportTransactions.
 *
 * Ramp `amount` is in major units (dollars); positive = money spent on the
 * card. We book against a Ramp Card *liability* account, where in the shared
 * pipeline a "payment" (isCredit=false, negative amount) credits the card
 * account and debits the expense — correct for a card charge. A refund
 * (negative Ramp amount) flips to isCredit=true → debits the card liability
 * and credits the expense.
 */
export function mapRampTransaction(txn) {
  const rawAmount = new Decimal(txn.amount ?? 0);
  const dollars = rawAmount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  // Ramp: positive = spend (money out). Refund/credit = negative.
  const isRefund = dollars.lessThan(0);
  const absAmount = dollars.abs().toNumber();

  const date = pickDate(txn);
  const merchant = txn.merchant_name || txn.merchant_descriptor || 'Ramp transaction';
  const holder = txn.card_holder
    ? [txn.card_holder.first_name, txn.card_holder.last_name].filter(Boolean).join(' ').trim()
    : '';
  const parts = [merchant];
  if (holder) parts.push(holder);
  if (txn.memo) parts.push(String(txn.memo));
  const description = parts.join(' · ');

  return {
    fitid: `ramp-${txn.id}`,
    date,
    description,
    // isRefund → money in (credit); charge → money out (negative)
    amount: isRefund ? absAmount : -absAmount,
    isCredit: isRefund,
    type: 'ramp',
    checkNumber: null,
    pending: false,
    rampTransactionId: txn.id,
    merchantName: merchant,
    cardHolder: holder || null,
    rampCategory: txn.sk_category_name || txn.merchant_category_code_description || null,
    amountCents: dollars.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber(),
  };
}

/** Only settled card spend belongs in the ledger; skip pending/declined/error. */
export function isPostableRampState(txn) {
  const state = String(txn.state || '').toUpperCase();
  return state === 'CLEARED' || state === 'COMPLETION' || state === 'ALL' || state === '';
}

function pickDate(txn) {
  const raw = txn.accounting_date
    || txn.settlement_date
    || txn.user_transaction_time
    || txn.updated_at
    || '';
  const iso = String(raw).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : new Date().toISOString().slice(0, 10);
}

export function mapRampTransactions(rows) {
  return rows.filter(isPostableRampState).map(mapRampTransaction);
}
