/**
 * Shared GL query helpers — all financial reports use POSTED journals only
 * (QBO-compatible). Bank reconciliation already enforced this; reports did not.
 */

/** SQL fragment: join general_ledger to posted journal_entries only. */
export const POSTED_GL_JOIN = `
  JOIN journal_entries je ON je.id = gl.journal_entry_id AND je.status = 'POSTED'
`;

/** Optional date filter appended after POSTED_GL_JOIN (alias gl). */
export function postedGlDateFilter(asOfDate, startDate, endDate) {
  const clauses = [];
  const params = [];
  if (asOfDate) {
    clauses.push('(gl.posting_date IS NULL OR gl.posting_date <= ?)');
    params.push(asOfDate);
  }
  if (startDate && endDate) {
    clauses.push('gl.posting_date >= ? AND gl.posting_date <= ?');
    params.push(startDate, endDate);
  } else if (startDate) {
    clauses.push('gl.posting_date >= ?');
    params.push(startDate);
  } else if (endDate) {
    clauses.push('gl.posting_date <= ?');
    params.push(endDate);
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}
