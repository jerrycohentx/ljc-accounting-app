import Decimal from 'decimal.js';

/**
 * Plaid: positive amount = money out (debit to bank asset).
 * OFX in this app: negative = debit, positive = credit (isCredit).
 * Normalize to OFX-compatible shape for shared import pipeline.
 */
export function mapPlaidTransaction(plaidTxn) {
  const amountDecimal = new Decimal(plaidTxn.amount);
  const dollars = amountDecimal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const isCredit = dollars.lessThan(0);
  const absAmount = dollars.abs().toNumber();

  return {
    fitid: `plaid-${plaidTxn.transaction_id}`,
    date: plaidTxn.date,
    description: plaidTxn.name || plaidTxn.merchant_name || 'Plaid transaction',
    amount: isCredit ? absAmount : -absAmount,
    isCredit,
    type: plaidTxn.payment_channel || 'plaid',
    checkNumber: plaidTxn.check_number || null,
    pending: plaidTxn.pending === true,
    plaidTransactionId: plaidTxn.transaction_id,
    amountCents: dollars.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber(),
  };
}

export function mapPlaidTransactions(plaidTransactions) {
  return plaidTransactions.map(mapPlaidTransaction);
}
