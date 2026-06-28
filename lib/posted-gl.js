import Decimal from 'decimal.js';

/** Posted GL rows for financial/tax reports — excludes reversed and reversing journals. */
export const POSTED_GL_SUBQUERY = `
  SELECT gl.* FROM general_ledger gl
  INNER JOIN journal_entries je ON je.id = gl.journal_entry_id
    AND je.status = 'POSTED'
    AND je.reversed_by_je_id IS NULL
    AND je.reverses_je_id IS NULL
`;

export function calculateAccountBalance(account) {
  const debit = new Decimal(account.total_debit || 0);
  const credit = new Decimal(account.total_credit || 0);
  if (account.normal_balance === 'DEBIT') return debit.minus(credit);
  return credit.minus(debit);
}
