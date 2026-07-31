import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCardPaymentTxn,
  isMerchantCreditTxn,
  isCashLikeAccountNumber,
} from './card-import-guards.js';

describe('card-import-guards', () => {
  it('detects merchant credits separately from payments', () => {
    assert.equal(isMerchantCreditTxn({ description: 'Credit: THE HOME DEPOT', amount: -216.49 }), true);
    assert.equal(isCardPaymentTxn({ description: 'Credit: THE HOME DEPOT', amount: -216.49 }), false);
  });

  it('detects mobile/online payments as card payoffs', () => {
    assert.equal(isCardPaymentTxn({ description: 'MOBILE PAYMENT - THANK YOU', amount: -5000 }), true);
    assert.equal(isMerchantCreditTxn({ description: 'MOBILE PAYMENT - THANK YOU', amount: -5000 }), false);
  });

  it('treats negative non-credit amounts as payments', () => {
    assert.equal(isCardPaymentTxn({ description: 'AUTOPAY', amount: -100, isPayment: true }), true);
  });

  it('flags cash-like GL numbers', () => {
    assert.equal(isCashLikeAccountNumber('1000'), true);
    assert.equal(isCashLikeAccountNumber('1100'), true);
    assert.equal(isCashLikeAccountNumber('5700'), false);
    assert.equal(isCashLikeAccountNumber('2010'), false);
  });
});
