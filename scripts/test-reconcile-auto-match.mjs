#!/usr/bin/env node
import { matchStatementToRegister } from '../lib/reconcile-auto-match.js';
import { peekBundledStatement } from '../lib/bank-statement-view.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const entries = [
  { id: 'gl-1', posting_date: '2026-01-05', debit: 2500, credit: 0 },
  { id: 'gl-2', posting_date: '2026-01-06', debit: 3000, credit: 0 },
  { id: 'gl-3', posting_date: '2026-01-02', debit: 0, credit: 35 },
];

const lines = [
  { id: 's-1', date: '2026-01-05', amount: 2500, description: 'Credit Memo' },
  { id: 's-2', date: '2026-01-06', amount: 3000, description: 'Credit Memo' },
  { id: 's-3', date: '2026-01-02', amount: -35, description: 'Fee' },
  { id: 's-4', date: '2026-01-23', amount: 725.87, description: 'Interest' },
];

const result = matchStatementToRegister({
  statementLines: lines,
  entries,
  normalBalance: 'DEBIT',
});

assert(result.matchedStmtCount === 3, `expected 3 matches, got ${result.matchedStmtCount}`);
assert(result.suggestedCheckedGlIds.length === 3, 'expected 3 gl ids');
assert(result.unmatchedStmtLines.length === 1, 'one stmt line unmatched');

const peek = peekBundledStatement('1001', '2026-01-01');
assert(peek?.meta?.periodEnd === '2026-01-31', 'Jan 2026 Lone Star by month');
assert(peek?.meta?.currentBalance === 726.07, 'ending balance from JSON');
assert(peek?.lineCount === 12, '12 statement lines');

console.log('✓ reconcile auto-match tests passed');
