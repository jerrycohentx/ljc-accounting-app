import Decimal from 'decimal.js';

/**
 * Zero-suspense gate (ledger-integrity guardrail #3).
 *
 * Suspense / clearing / uncategorized accounts are transient — they exist only
 * to hold money mid-flight and MUST net to zero when the books are clean. A
 * non-zero balance means real money is stranded (an unmatched transfer, an
 * uncategorized deposit, a migration remnant) — exactly the kind of thing that
 * silently bleeds across months. This surfaces any such balance so it gets
 * resolved before a period is trusted as closed.
 *
 * Accounts are identified by NAME (robust to new accounts), so 1020 Cash
 * Clearing, 1021 Transfers In Transit, 1100 Undeposited Funds, 3995 Migration
 * Clearing, 4091 Uncategorized Income, and any future clearing/uncategorized
 * account are all covered automatically. Opening Balance Equity and real
 * receivables (e.g. Due From Jerry) are intentionally NOT matched — they can
 * legitimately carry balances.
 */

const SUSPENSE_NAME_RE = /suspense|clearing|undeposited|in transit|uncategor|ask my accountant/i;

export async function checkSuspenseAccounts(db, entityId, asOfDate = null) {
  const accounts = await db.all(
    'SELECT id, account_number, account_name, account_type FROM accounts WHERE entity_id = ? AND is_active = 1',
    [entityId]
  );
  const suspense = accounts.filter((a) => SUSPENSE_NAME_RE.test(a.account_name || ''));

  const nonZero = [];
  let totalAbs = new Decimal(0);
  for (const a of suspense) {
    const params = [a.id];
    let dateClause = '';
    if (asOfDate) {
      dateClause = ' AND je.posting_date <= ?';
      params.push(asOfDate);
    }
    const row = await db.get(
      `SELECT COALESCE(SUM(jel.debit), 0) AS dr, COALESCE(SUM(jel.credit), 0) AS cr
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE jel.account_id = ? AND je.status = 'POSTED'${dateClause}`,
      params
    );
    const bal = new Decimal(row?.dr || 0).minus(row?.cr || 0);
    if (bal.abs().greaterThanOrEqualTo('0.005')) {
      nonZero.push({
        accountNumber: a.account_number,
        accountName: a.account_name,
        accountType: a.account_type,
        balance: Number(bal.toFixed(2)),
      });
      totalAbs = totalAbs.plus(bal.abs());
    }
  }

  nonZero.sort((x, y) => Math.abs(y.balance) - Math.abs(x.balance));
  return {
    clean: nonZero.length === 0,
    asOfDate,
    accountsChecked: suspense.length,
    nonZero,
    totalAbs: Number(totalAbs.toFixed(2)),
  };
}
