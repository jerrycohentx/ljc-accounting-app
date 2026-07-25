/**
 * Verify Amex statement charge-date matching recovers distinct Sam's Club Fuel dates
 * instead of collapsing them all onto 2026-01-01.
 */
import assert from 'assert';
import {
  loadAmexStatementCharges,
  matchChargesToStatement,
  softMerchantKey,
} from '../lib/categorization-review.js';

const charges = loadAmexStatementCharges();
assert.ok(charges.length > 50, `expected Amex statement charges, got ${charges.length}`);

const samsReview = [
  { postingDate: '2026-01-01', amount: 40.22, descLines: ["SAM'S CLUB FUEL 4769 4769 HOUSTON TX AUTO FUEL DISPENSER"] },
  { postingDate: '2026-01-01', amount: 26.61, descLines: ["SAM'S CLUB FUEL 4769 4769 HOUSTON TX AUTO FUEL DISPENSER"] },
  { postingDate: '2026-01-01', amount: 40.05, descLines: ["SAM'S CLUB FUEL 4769 4769 HOUSTON TX AUTO FUEL DISPENSER"] },
  { postingDate: '2026-01-01', amount: 38.14, descLines: ["SAM'S CLUB FUEL 4769 4769 HOUSTON TX AUTO FUEL DISPENSER"] },
];

const matched = matchChargesToStatement(samsReview, charges);
assert.strictEqual(matched.size, 4, `expected 4 Sam's matches, got ${matched.size}`);

const dates = [...matched.values()].map((c) => c.date).sort();
assert.deepStrictEqual(dates, ['2025-12-12', '2025-12-18', '2025-12-24', '2025-12-30']);

assert.ok(softMerchantKey("Amex stmt 2026-01-09: SAM'S CLUB FUEL").includes('SAM'));
console.log('ok: categorization-review charge dates', dates.join(', '));
