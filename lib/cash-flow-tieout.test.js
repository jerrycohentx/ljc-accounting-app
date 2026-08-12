/**
 * Smoke test for cash-flow tie-out helpers (no DB).
 * Run: node lib/cash-flow-tieout.test.js
 */
import { dayBefore } from './cash-flow-tieout.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(dayBefore('2026-01-01') === '2025-12-31', 'Jan 1 → Dec 31');
assert(dayBefore('2026-03-01') === '2026-02-28', 'Mar 1 → Feb 28 2026');

// Phantom $9.02 decomposition (scope error, not a book variance)
const cfAll100x = 4439.11;
const simmonsOnly = 4430.09;
const loneStar = 127.19;
const csb = -118.17;
const phantom = Math.round((cfAll100x - simmonsOnly) * 100) / 100;
const otherCash = Math.round((loneStar + csb) * 100) / 100;
assert(phantom === 9.02, `phantom=${phantom}`);
assert(otherCash === 9.02, `otherCash=${otherCash}`);
assert(Math.round((simmonsOnly + loneStar + csb) * 100) / 100 === cfAll100x, 'all-cash ties');

console.log('cash-flow-tieout.test.js: PASS');
