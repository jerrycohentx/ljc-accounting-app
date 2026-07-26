/**
 * Unit checks for period integrity helpers (no DB required for date logic).
 * Run: node scripts/test-period-integrity.mjs
 */
import assert from 'assert';
import {
  statementCoversMonth,
  monitoredAccountNumbers,
  assertNotPlugJournal,
  eachMonthInRange,
  PLUG_JOURNAL_SOURCES,
} from '../lib/period-integrity.js';

assert.strictEqual(statementCoversMonth('2026-02-01', '2026-01-01', '2026-01-31'), true, 'Feb 1 → January');
assert.strictEqual(statementCoversMonth('2026-02-01', '2026-02-01', '2026-02-28'), false, 'Feb 1 not February');
assert.strictEqual(statementCoversMonth('2026-01-31', '2026-01-01', '2026-01-31'), true, 'Jan 31 → January');
assert.strictEqual(statementCoversMonth('2026-03-31', '2026-03-01', '2026-03-31'), true, 'Mar 31 → March');
assert.strictEqual(statementCoversMonth('2026-03-01', '2026-02-01', '2026-02-28'), true, 'Mar 1 → February');
assert.strictEqual(
  statementCoversMonth(new Date('2025-12-31T00:00:00.000Z'), '2025-12-01', '2025-12-31'),
  true,
  'PG Date object Dec 31 → December'
);
assert.strictEqual(
  statementCoversMonth('2025-12-31T00:00:00.000Z', '2025-12-01', '2025-12-31'),
  true,
  'ISO timestamp Dec 31 → December'
);

const yearMonths = eachMonthInRange('2025-01-01', '2025-12-31');
assert.strictEqual(yearMonths.length, 12, '2025 has 12 months');
assert.strictEqual(yearMonths[0].periodStart, '2025-01-01');
assert.strictEqual(yearMonths[0].periodEnd, '2025-01-31');
assert.strictEqual(yearMonths[11].periodStart, '2025-12-01');
assert.strictEqual(yearMonths[11].periodEnd, '2025-12-31');

const ljc = monitoredAccountNumbers('ent-ljc');
assert.ok(ljc.includes('1000'), 'Simmons monitored');
assert.ok(ljc.includes('1001'), 'Lone Star monitored');
assert.ok(ljc.includes('1002'), 'CSB monitored when period not scoped');
assert.ok(ljc.includes('2010'), 'Amex monitored via targets');

const ljcJan = monitoredAccountNumbers('ent-ljc', { periodStart: '2026-01-01' });
assert.ok(ljcJan.includes('1002'), 'CSB still monitored for January 2026');
const ljcFeb = monitoredAccountNumbers('ent-ljc', { periodStart: '2026-02-01' });
assert.ok(!ljcFeb.includes('1002'), 'CSB not monitored after January close');
assert.ok(ljcFeb.includes('1000') && ljcFeb.includes('1001') && ljcFeb.includes('2010'));

assert.ok(PLUG_JOURNAL_SOURCES.includes('reconcile-adjustment'));

let threw = false;
try {
  assertNotPlugJournal({ source: 'reconcile-adjustment' });
} catch (e) {
  threw = e.code === 'PLUG_ENTRY_BLOCKED';
}
assert.ok(threw, 'plug source blocked');

threw = false;
try {
  assertNotPlugJournal({ description: 'Amex recon adjustment' });
} catch (e) {
  threw = e.code === 'PLUG_ENTRY_BLOCKED';
}
assert.ok(threw, 'plug description blocked');

assertNotPlugJournal({ source: 'ofx-import', description: 'Wire to borrower' });

console.log('✓ period-integrity unit checks passed');
