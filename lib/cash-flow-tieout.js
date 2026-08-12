/**
 * Cash-flow control: net activity on all 100x cash accounts must equal
 * balance-sheet cash movement for the same accounts over the same window.
 *
 * Do NOT compare CF to Simmons 1000 alone — that creates a phantom variance
 * (Jan 2026: $9.02 = 1001 +$127.19 + 1002 −$118.17).
 */
import { POSTED_GL_SUBQUERY } from './posted-gl.js';

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export function dayBefore(isoDate) {
  const s = String(isoDate || '').slice(0, 10);
  const d = new Date(`${s}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${isoDate}`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function cashAccountRows(db, entityId) {
  return db.all(
    `SELECT id, account_number, account_name, normal_balance
     FROM accounts
     WHERE entity_id = ?
       AND account_type = 'ASSET'
       AND account_number LIKE '100%'
     ORDER BY account_number`,
    [entityId]
  );
}

async function balanceAsOf(db, entityId, accountId, asOfDate, normalBalance) {
  const expr = normalBalance === 'CREDIT' ? '(gl.credit - gl.debit)' : '(gl.debit - gl.credit)';
  const row = await db.get(
    `SELECT COALESCE(SUM(${expr}), 0) AS bal
     FROM (${POSTED_GL_SUBQUERY}) gl
     WHERE gl.entity_id = ? AND gl.account_id = ? AND gl.posting_date <= ?`,
    [entityId, accountId, asOfDate]
  );
  return round2(row?.bal || 0);
}

async function periodActivity(db, entityId, accountId, startDate, endDate) {
  const row = await db.get(
    `SELECT
       COALESCE(SUM(gl.debit), 0) AS debit,
       COALESCE(SUM(gl.credit), 0) AS credit
     FROM (${POSTED_GL_SUBQUERY}) gl
     WHERE gl.entity_id = ?
       AND gl.account_id = ?
       AND gl.posting_date >= ?
       AND gl.posting_date <= ?`,
    [entityId, accountId, startDate, endDate]
  );
  const debit = round2(row?.debit || 0);
  const credit = round2(row?.credit || 0);
  return { debit, credit, netChange: round2(debit - credit) };
}

/**
 * @returns {Promise<{
 *   period: { startDate: string, endDate: string, beginningAsOf: string },
 *   comparisonScope: string,
 *   accounts: Array<object>,
 *   operatingActivities: number,
 *   investingActivities: number,
 *   financingActivities: number,
 *   netCashFlow: number,
 *   beginningCash: number,
 *   endingCash: number,
 *   bsCashDelta: number,
 *   variance: number,
 *   tieoutOk: boolean
 * }>}
 */
export async function computeCashFlowTieout(db, entityId, startDate, endDate) {
  const beginningAsOf = dayBefore(startDate);
  const rows = await cashAccountRows(db, entityId);
  const accounts = [];
  let netCashFlow = 0;
  let beginningCash = 0;
  let endingCash = 0;

  for (const a of rows) {
    const activity = await periodActivity(db, entityId, a.id, startDate, endDate);
    const beginning = await balanceAsOf(db, entityId, a.id, beginningAsOf, a.normal_balance || 'DEBIT');
    const ending = await balanceAsOf(db, entityId, a.id, endDate, a.normal_balance || 'DEBIT');
    const bsDelta = round2(ending - beginning);
    accounts.push({
      accountNumber: a.account_number,
      accountName: a.account_name,
      beginning,
      ending,
      bsDelta,
      periodDebit: activity.debit,
      periodCredit: activity.credit,
      netChange: activity.netChange,
      activityVsBsDelta: round2(activity.netChange - bsDelta),
    });
    netCashFlow = round2(netCashFlow + activity.netChange);
    beginningCash = round2(beginningCash + beginning);
    endingCash = round2(endingCash + ending);
  }

  const bsCashDelta = round2(endingCash - beginningCash);
  const variance = round2(netCashFlow - bsCashDelta);
  return {
    period: { startDate, endDate, beginningAsOf },
    comparisonScope: 'all_100x_cash_accounts',
    accounts,
    operatingActivities: 0,
    investingActivities: 0,
    financingActivities: 0,
    netCashFlow,
    beginningCash,
    endingCash,
    bsCashDelta,
    variance,
    tieoutOk: Math.abs(variance) < 0.005,
  };
}
