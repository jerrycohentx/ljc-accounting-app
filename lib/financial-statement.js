/**
 * QuickBooks-style financial statement builder.
 *
 * Produces an ordered list of report ROWS (header / account / subtotal / total /
 * grand-total / blank) for a Balance Sheet (as of a date) or a Profit & Loss
 * (over a period), rolling child accounts up into parent subtotals exactly like
 * QuickBooks — including the "<Parent> - Other" line QuickBooks shows when a
 * parent account also has its own direct postings.
 *
 * Each amount-bearing row also carries a `drill` descriptor so the on-screen
 * report can make EVERY number clickable (QuickZoom): a leaf drills into that
 * one account's register; a subtotal/total drills into a transaction-detail of
 * every account under it for the same period.
 *
 * Totals and signs deliberately mirror the app's existing /reports/balance-sheet
 * and /reports/income-statement endpoints (lib/posted-gl.js calculateAccountBalance),
 * so a statement built here foots to the same numbers the app already trusts.
 */

import Decimal from 'decimal.js';
import { POSTED_GL_SUBQUERY, calculateAccountBalance } from './posted-gl.js';

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Signed display amount for one account, QuickBooks-style. CONTRA (e.g. accumulated
 * depreciation) shows negative and reduces its section total. */
function signedAmount(acc) {
  const bal = calculateAccountBalance(acc);
  if (acc.account_type === 'CONTRA') return bal.negated();
  return bal;
}

async function loadAccountRows(db, entityId, { asOfDate, startDate, endDate, types }) {
  const params = [entityId];
  let dateJoin = '';
  if (asOfDate) {
    dateJoin = 'AND (gl.posting_date IS NULL OR gl.posting_date <= ?)';
    params.push(asOfDate);
  } else if (startDate && endDate) {
    dateJoin = 'AND (gl.posting_date IS NULL OR (gl.posting_date >= ? AND gl.posting_date <= ?))';
    params.push(startDate, endDate);
  }
  params.push(entityId);
  let typeFilter = '';
  if (types && types.length) {
    typeFilter = `AND a.account_type IN (${types.map(() => '?').join(',')})`;
    params.push(...types);
  }
  const rows = await db.all(
    `SELECT a.id, a.account_number, a.account_name, a.account_type, a.parent_account_id, a.normal_balance,
            COALESCE(SUM(gl.debit), 0) AS total_debit,
            COALESCE(SUM(gl.credit), 0) AS total_credit
     FROM accounts a
     LEFT JOIN (${POSTED_GL_SUBQUERY}) gl ON a.id = gl.account_id AND gl.entity_id = ? ${dateJoin}
     WHERE a.entity_id = ? AND a.is_active = true ${typeFilter}
     GROUP BY a.id, a.account_number, a.account_name, a.account_type, a.parent_account_id, a.normal_balance
     ORDER BY a.account_number`,
    params
  );
  return rows || [];
}

/** Build a parent→children tree from a flat account list. Roots = accounts whose
 * parent is absent from this set. Each node keeps its own signed balance. */
function buildTree(accounts) {
  const byId = new Map();
  accounts.forEach((a) => byId.set(a.id, { acc: a, children: [], own: signedAmount(a) }));
  const roots = [];
  for (const node of byId.values()) {
    const pid = node.acc.parent_account_id;
    if (pid && byId.has(pid)) byId.get(pid).children.push(node);
    else roots.push(node);
  }
  const sortNodes = (list) => {
    list.sort((x, y) => String(x.acc.account_number || '').localeCompare(String(y.acc.account_number || '')));
    list.forEach((n) => sortNodes(n.children));
  };
  sortNodes(roots);
  return roots;
}

/** Emit QuickBooks rows for one account subtree. Returns { rows, total } where total
 * is a Decimal. `mode`/`period` shape the drill descriptor. */
function emitNode(node, depth, out, drillCtx) {
  const { acc, children, own } = node;
  const leafDrill = { kind: 'account', accountId: acc.id, accountNumber: acc.account_number, ...drillCtx };
  if (!children.length) {
    out.push({ depth, label: acc.account_name, accountNumber: acc.account_number, accountId: acc.id, kind: 'account', amount: round2(own.toNumber()), drill: leafDrill });
    return own;
  }
  // Parent with children: header, children, optional "- Other", subtotal.
  out.push({ depth, label: acc.account_name, accountNumber: acc.account_number, accountId: acc.id, kind: 'header', amount: null, drill: null });
  let total = new Decimal(own);
  for (const child of children) {
    total = total.plus(emitNode(child, depth + 1, out, drillCtx));
  }
  if (!own.isZero()) {
    out.push({ depth: depth + 1, label: `${acc.account_name} - Other`, accountNumber: acc.account_number, accountId: acc.id, kind: 'account', amount: round2(own.toNumber()), drill: leafDrill });
  }
  const subtreeNumbers = collectNumbers(node);
  out.push({ depth, label: `Total ${acc.account_name}`, kind: 'subtotal', amount: round2(total.toNumber()), drill: { kind: 'group', accountNumbers: subtreeNumbers, ...drillCtx } });
  return total;
}

function collectNumbers(node) {
  const nums = [node.acc.account_number];
  node.children.forEach((c) => nums.push(...collectNumbers(c)));
  return nums.filter(Boolean);
}

function sectionRows(roots, depth, out, drillCtx) {
  let total = new Decimal(0);
  for (const node of roots) total = total.plus(emitNode(node, depth, out, drillCtx));
  return total;
}

/** Net income (revenue − expense) over [from,to] or through asOf — QuickBooks'
 * current-period earnings equity plug. Mirrors the /balance-sheet endpoint. */
async function computeNetIncome(db, entityId, { asOfDate, startDate, endDate }) {
  const rows = await loadAccountRows(db, entityId, { asOfDate, startDate, endDate, types: ['REVENUE', 'EXPENSE'] });
  let net = new Decimal(0);
  for (const a of rows) {
    const bal = calculateAccountBalance(a);
    net = a.account_type === 'REVENUE' ? net.plus(bal) : net.minus(bal);
  }
  return net;
}

export async function buildBalanceSheet(db, { entityId, asOfDate, companyName }) {
  const drillCtx = { mode: 'asof', asOfDate };
  const accounts = await loadAccountRows(db, entityId, { asOfDate, types: ['ASSET', 'CONTRA', 'LIABILITY', 'EQUITY'] });
  const assetsA = accounts.filter((a) => a.account_type === 'ASSET' || a.account_type === 'CONTRA');
  const liabA = accounts.filter((a) => a.account_type === 'LIABILITY');
  const eqA = accounts.filter((a) => a.account_type === 'EQUITY');

  const rows = [];
  rows.push({ depth: 0, label: 'ASSETS', kind: 'section' });
  const totalAssets = sectionRows(buildTree(assetsA), 1, rows, drillCtx);
  rows.push({ depth: 0, label: 'TOTAL ASSETS', kind: 'grandtotal', amount: round2(totalAssets.toNumber()), drill: { kind: 'group', accountNumbers: assetsA.map((a) => a.account_number), ...drillCtx } });

  rows.push({ depth: 0, label: 'LIABILITIES & EQUITY', kind: 'section' });
  rows.push({ depth: 1, label: 'Liabilities', kind: 'header' });
  const totalLiab = sectionRows(buildTree(liabA), 2, rows, drillCtx);
  rows.push({ depth: 1, label: 'Total Liabilities', kind: 'subtotal', amount: round2(totalLiab.toNumber()), drill: { kind: 'group', accountNumbers: liabA.map((a) => a.account_number), ...drillCtx } });

  rows.push({ depth: 1, label: 'Equity', kind: 'header' });
  const eqTotalAccts = sectionRows(buildTree(eqA), 2, rows, drillCtx);
  const netIncome = await computeNetIncome(db, entityId, { asOfDate });
  rows.push({ depth: 2, label: 'Net Income', kind: 'account', amount: round2(netIncome.toNumber()), drill: { kind: 'group', accountTypes: ['REVENUE', 'EXPENSE'], net: true, ...drillCtx } });
  const totalEquity = eqTotalAccts.plus(netIncome);
  rows.push({ depth: 1, label: 'Total Equity', kind: 'subtotal', amount: round2(totalEquity.toNumber()), drill: { kind: 'group', accountNumbers: eqA.map((a) => a.account_number), withNetIncome: true, ...drillCtx } });

  const totalLE = totalLiab.plus(totalEquity);
  rows.push({ depth: 0, label: 'TOTAL LIABILITIES & EQUITY', kind: 'grandtotal', amount: round2(totalLE.toNumber()), drill: null });

  return {
    header: { reportType: 'balance_sheet', title: 'Balance Sheet', companyName: companyName || 'LJC Financial, LLC', asOfDate, basis: 'Accrual Basis' },
    rows,
    totals: { totalAssets: round2(totalAssets.toNumber()), totalLiabilities: round2(totalLiab.toNumber()), totalEquity: round2(totalEquity.toNumber()), totalLiabilitiesAndEquity: round2(totalLE.toNumber()), netIncome: round2(netIncome.toNumber()) },
  };
}

export async function buildProfitLoss(db, { entityId, startDate, endDate, companyName }) {
  const drillCtx = { mode: 'range', startDate, endDate };
  const accounts = await loadAccountRows(db, entityId, { startDate, endDate, types: ['REVENUE', 'EXPENSE'] });
  // Drop accounts with zero activity in the period — QuickBooks P&L omits them.
  const active = accounts.filter((a) => !calculateAccountBalance(a).isZero());
  const revA = active.filter((a) => a.account_type === 'REVENUE');
  const expA = active.filter((a) => a.account_type === 'EXPENSE');

  const rows = [];
  rows.push({ depth: 0, label: 'Ordinary Income/Expense', kind: 'section' });
  rows.push({ depth: 1, label: 'Income', kind: 'header' });
  const totalRev = sectionRows(buildTree(revA), 2, rows, drillCtx);
  rows.push({ depth: 1, label: 'Total Income', kind: 'subtotal', amount: round2(totalRev.toNumber()), drill: { kind: 'group', accountNumbers: revA.map((a) => a.account_number), ...drillCtx } });
  rows.push({ depth: 1, label: 'Gross Profit', kind: 'subtotal', amount: round2(totalRev.toNumber()), drill: { kind: 'group', accountNumbers: revA.map((a) => a.account_number), ...drillCtx } });

  rows.push({ depth: 1, label: 'Expense', kind: 'header' });
  const totalExp = sectionRows(buildTree(expA), 2, rows, drillCtx);
  rows.push({ depth: 1, label: 'Total Expense', kind: 'subtotal', amount: round2(totalExp.toNumber()), drill: { kind: 'group', accountNumbers: expA.map((a) => a.account_number), ...drillCtx } });

  const netOrdinary = totalRev.minus(totalExp);
  rows.push({ depth: 1, label: 'Net Ordinary Income', kind: 'subtotal', amount: round2(netOrdinary.toNumber()), drill: { kind: 'group', accountTypes: ['REVENUE', 'EXPENSE'], net: true, ...drillCtx } });
  rows.push({ depth: 0, label: 'Net Income', kind: 'grandtotal', amount: round2(netOrdinary.toNumber()), drill: { kind: 'group', accountTypes: ['REVENUE', 'EXPENSE'], net: true, ...drillCtx } });

  return {
    header: { reportType: 'pnl', title: 'Profit & Loss', companyName: companyName || 'LJC Financial, LLC', startDate, endDate, basis: 'Accrual Basis' },
    rows,
    totals: { totalRevenue: round2(totalRev.toNumber()), totalExpense: round2(totalExp.toNumber()), netIncome: round2(netOrdinary.toNumber()) },
  };
}

/** Row identity for matching a statement to its comparison-period twin. */
function rowKey(r) {
  if (r.kind === 'account' || r.kind === 'subtotal') return `${r.kind}:${r.accountNumber || r.label}`;
  if (r.kind === 'grandtotal') return `grandtotal:${r.label}`;
  return `${r.kind}:${r.label}:${r.depth}`;
}

/** Attach comparison amounts + $ and % variance to each amount-bearing row by
 * matching rows against the comparison-period statement. */
export function mergeStatements(primary, comparison, comparePeriodLabel) {
  const cmpMap = new Map();
  (comparison?.rows || []).forEach((r) => { if (r.amount != null) cmpMap.set(rowKey(r), r); });
  const rows = primary.rows.map((r) => {
    if (r.amount == null) return { ...r };
    const cmp = cmpMap.get(rowKey(r));
    const cmpAmount = cmp ? cmp.amount : null;
    let variance = null;
    let variancePct = null;
    if (cmpAmount != null) {
      variance = round2(r.amount - cmpAmount);
      if (Math.abs(cmpAmount) >= 0.005) variancePct = round2((variance / Math.abs(cmpAmount)) * 100);
    }
    return { ...r, cmpAmount, variance, variancePct };
  });
  return { ...primary, rows, comparison: { period: comparePeriodLabel, totals: comparison?.totals || null } };
}
