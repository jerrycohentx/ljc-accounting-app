import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inferCategorizationIntent,
  validateCategorizationCandidate,
} from './categorization-logic.js';

test('recognizes CD interest as high-confidence bank interest income', () => {
  const intent = inferCategorizationIntent('C.D. INTEREST ACCOUNT NUMBER 112946', { amount: 725.87 });
  assert.equal(intent.code, 'BANK_INTEREST_INCOME');
  assert.equal(intent.confidence, 1);
});

test('blocks CD interest from an NSF income account', () => {
  const result = validateCategorizationCandidate(
    'C.D. INTEREST ACCOUNT NUMBER 112946',
    {
      account_number: '4770',
      account_name: 'Lending Income:Portfolio loans:NSF payments:Bank NSF fees charged',
      account_type: 'REVENUE',
    },
    { amount: 725.87 }
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /common-sense check/i);
  assert.match(result.message, /NSF/i);
});

test('allows CD interest in Interest Income - Banks', () => {
  const result = validateCategorizationCandidate(
    'C.D. INTEREST ACCOUNT NUMBER 112946',
    {
      account_number: '4000',
      account_name: 'Interest Income - Banks:Simmons Bank CD',
      account_type: 'REVENUE',
    },
    { amount: 725.87 }
  );
  assert.equal(result.ok, true);
});

test('blocks a bank service charge from revenue', () => {
  const result = validateCategorizationCandidate(
    'ACCOUNT ANALYSIS CHARGE',
    { account_number: '4000', account_name: 'Interest Income', account_type: 'REVENUE' },
    { amount: -325.96 }
  );
  assert.equal(result.ok, false);
});
