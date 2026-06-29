import Decimal from 'decimal.js';

/** All reconcile money math in cents — never floats. */
export function toCents(n) {
  return Math.round(Number(n) * 100);
}

export function fromCents(c) {
  return Math.round(c) / 100;
}

/**
 * QuickBooks Desktop reconcile formula (spec §5).
 * markedDeposits / markedPayments are positive amounts.
 */
export function computeReconcileTotals({
  beginningBalance,
  serviceCharge = 0,
  interestEarned = 0,
  markedDeposits = 0,
  markedPayments = 0,
  endingBalance,
}) {
  const begin = toCents(beginningBalance);
  const svc = toCents(serviceCharge);
  const int = toCents(interestEarned);
  const dep = toCents(markedDeposits);
  const pay = toCents(markedPayments);
  const end = toCents(endingBalance);

  const clearedBalance = begin - svc + int + dep - pay;
  const difference = end - clearedBalance;

  return {
    beginningBalance: fromCents(begin),
    serviceCharge: fromCents(svc),
    interestEarned: fromCents(int),
    markedDeposits: fromCents(dep),
    markedPayments: fromCents(pay),
    clearedBalance: fromCents(clearedBalance),
    endingBalance: fromCents(end),
    difference: fromCents(difference),
    balanced: difference === 0,
  };
}

/** Sum cleared deposit-side and payment-side lines (positive amounts). */
export function sumClearedBySide(entries, account, checkedIds, normalBalance) {
  const checked = new Set(checkedIds || []);
  let markedDeposits = 0;
  let markedPayments = 0;
  let depositCount = 0;
  let paymentCount = 0;

  for (const e of entries || []) {
    if (!checked.has(e.id)) continue;
    const signed = signedEntryCents(e, normalBalance);
    if (signed > 0) {
      markedDeposits += signed;
      depositCount += 1;
    } else if (signed < 0) {
      markedPayments += Math.abs(signed);
      paymentCount += 1;
    }
  }

  return {
    markedDeposits: fromCents(markedDeposits),
    markedPayments: fromCents(markedPayments),
    depositCount,
    paymentCount,
  };
}

function signedEntryCents(entry, normalBalance) {
  const d = toCents(entry.debit || 0);
  const c = toCents(entry.credit || 0);
  return normalBalance === 'CREDIT' ? c - d : d - c;
}

export function signedGlDeltaDecimal(entry, normalBalance) {
  const d = new Decimal(entry.debit || 0);
  const c = new Decimal(entry.credit || 0);
  return normalBalance === 'CREDIT' ? c.minus(d) : d.minus(c);
}
