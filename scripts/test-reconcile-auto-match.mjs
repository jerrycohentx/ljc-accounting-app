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

const duplicateEntries = [
  { id: 'gl-a', posting_date: '2026-01-05', debit: 2500, credit: 0 },
  { id: 'gl-b', posting_date: '2026-01-05', debit: 2500, credit: 0 },
];
const duplicateLines = [
  { id: 's-a', date: '2026-01-05', amount: 2500, description: 'Duplicate candidate' },
];
const ambiguous = matchStatementToRegister({
  statementLines: duplicateLines,
  entries: duplicateEntries,
  normalBalance: 'DEBIT',
});
assert(ambiguous.matchedStmtCount === 0, 'ambiguous date+amount should not auto-match');
assert(ambiguous.reviewSummary.needsReview === 1, 'ambiguous line should be needs_review');

const journalLinked = matchStatementToRegister({
  statementLines: [{ id: 's-j', date: '2026-01-09', amount: 99, description: 'JE linked', journalEntryId: 'je-9' }],
  entries: [{ id: 'gl-j', journal_entry_id: 'je-9', posting_date: '2026-01-01', debit: 0, credit: 99 }],
  normalBalance: 'CREDIT',
});
assert(journalLinked.matchedStmtCount === 1, 'journal_entry_id exact link should auto-match');

const peek = peekBundledStatement('1001', '2026-01-01');
assert(peek?.meta?.periodEnd === '2026-01-31', 'Jan 2026 Lone Star by month');
assert(peek?.meta?.currentBalance === 726.07, 'ending balance from JSON');
assert(peek?.lineCount === 12, '12 statement lines');

console.log('✓ reconcile auto-match tests passed');
