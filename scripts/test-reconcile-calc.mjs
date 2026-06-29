#!/usr/bin/env node
/**
 * Unit tests for QBD reconcile calculation (spec §5 screenshot test case).
 */
import { computeReconcileTotals, sumClearedBySide } from '../lib/reconcile-calc.js';

function assertEq(actual, expected, label) {
  if (Math.abs(actual - expected) > 0.001) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function testScreenshotCase() {
  const r = computeReconcileTotals({
    beginningBalance: 71452.58,
    serviceCharge: 12.0,
    interestEarned: 0.0,
    markedDeposits: 0,
    markedPayments: 0,
    endingBalance: 9299.05,
  });
  assertEq(r.clearedBalance, 71440.58, 'clearedBalance');
  assertEq(r.difference, -62141.53, 'difference');
  assertEq(r.balanced, false, 'balanced');
  console.log('✓ screenshot test case (71,452.58 − 12.00 = 71,440.58; diff −62,141.53)');
}

function testBalancedClose() {
  const r = computeReconcileTotals({
    beginningBalance: 598.88,
    serviceCharge: 0,
    interestEarned: 0,
    markedDeposits: 127.19,
    markedPayments: 0,
    endingBalance: 726.07,
  });
  assertEq(r.clearedBalance, 726.07, 'clearedBalance');
  assertEq(r.difference, 0, 'difference');
  assertEq(r.balanced, true, 'balanced');
  console.log('✓ balanced close with deposits');
}

function testSumClearedBySide() {
  const entries = [
    { id: '1', debit: 100, credit: 0 },
    { id: '2', debit: 0, credit: 35 },
  ];
  const s = sumClearedBySide(entries, { normal_balance: 'DEBIT' }, ['1', '2'], 'DEBIT');
  assertEq(s.markedDeposits, 100, 'deposits');
  assertEq(s.markedPayments, 35, 'payments');
  console.log('✓ sum cleared by side');
}

try {
  testScreenshotCase();
  testBalancedClose();
  testSumClearedBySide();
  console.log('\nAll reconcile calculation tests passed.');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
