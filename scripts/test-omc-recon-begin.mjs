/**
 * Unit checks for OMC/Simmons thru-date begin balance + YE exclusion.
 * Run: node scripts/test-omc-recon-begin.mjs
 */
import assert from 'assert';
import { peekBundledStatement } from '../lib/bank-statement-view.js';
import { isNonBankReconJournal, sqlExcludeNonBankReconJournals } from '../lib/bank-recon-exclude.js';

const peek31 = peekBundledStatement('1000', '2026-01-31', 'ent-omc');
const peek01 = peekBundledStatement('1000', '2026-02-01', 'ent-omc');

console.log('2026-01-31', peek31?.meta);
console.log('2026-02-01', peek01?.meta);

assert.ok(peek31, 'Jan 31 peek');
assert.ok(peek01, 'Feb 1 peek');
assert.strictEqual(peek31.meta.previousBalance, 1463.62);
assert.strictEqual(peek31.meta.currentBalance, 1983.97);
assert.strictEqual(
  peek01.meta.previousBalance,
  1463.62,
  'thru-date 2/01 must NOT fold Jan into beginning'
);
assert.strictEqual(peek01.meta.currentBalance, 1983.97);
assert.notStrictEqual(
  peek01.meta.previousBalance,
  peek01.meta.currentBalance,
  'begin must not equal end with empty clear'
);

assert.ok(isNonBankReconJournal({
  description: 'YE reclass — remove QBO /simmons bank/ rollup from cash 1000',
}));
assert.ok(isNonBankReconJournal({ source: 'ye-reclass' }));
assert.ok(!isNonBankReconJournal({
  description: 'Simmons x7036 wire credit $20,000 — Kisha',
}));

const excl = sqlExcludeNonBankReconJournals('je');
assert.ok(excl.sql.includes('YE reclass%'));
assert.ok(excl.params.includes('ye-reclass'));

console.log('OK — begin/thru-date + YE exclusion checks passed');
