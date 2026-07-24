/**
 * Build a cash-basis P&L from a QBO year-end trial balance CSV.
 * Used when the app ledger has no income/expense activity in a closed tax year
 * (e.g. 2025 loaded as 1/1/2026 opening balances).
 */

import fs from 'fs';
import path from 'path';
import Decimal from 'decimal.js';
import { ENTITY_TB_FILES } from '../config/opening-balance-mappings.js';
import { parseQboTrialBalance, inferQboCategory } from './qbo-trial-balance.js';

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * @returns {object|null} Same shape as buildProfitLoss(), or null if unavailable.
 */
export function buildProfitLossFromQboTb(rootDir, entityId, { startDate, endDate, companyName }) {
  const year = String(startDate || '').slice(0, 4);
  if (!year || startDate !== `${year}-01-01` || endDate !== `${year}-12-31`) return null;

  const fileName = ENTITY_TB_FILES[entityId];
  if (!fileName || !String(fileName).startsWith(`${year}_`)) return null;

  const filePath = path.join(rootDir, 'data/qbo-trial-balances', `${year}-12-31`, fileName);
  if (!fs.existsSync(filePath)) return null;

  const tbRows = parseQboTrialBalance(fs.readFileSync(filePath, 'utf8'));
  const revenues = [];
  const expenses = [];
  let totalRev = new Decimal(0);
  let totalExp = new Decimal(0);

  for (const r of tbRows) {
    const cat = inferQboCategory(r.name);
    if (cat === 'REVENUE') {
      const amt = r.credit.minus(r.debit);
      if (amt.abs().lt(0.005)) continue;
      revenues.push({ name: r.name, amount: round2(amt.toNumber()) });
      totalRev = totalRev.plus(amt);
    } else if (cat === 'EXPENSE') {
      const amt = r.debit.minus(r.credit);
      if (amt.abs().lt(0.005)) continue;
      expenses.push({ name: r.name, amount: round2(amt.toNumber()) });
      totalExp = totalExp.plus(amt);
    }
  }

  if (revenues.length === 0 && expenses.length === 0) return null;

  revenues.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  expenses.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const totalRevN = round2(totalRev.toNumber());
  const totalExpN = round2(totalExp.toNumber());
  const netN = round2(totalRev.minus(totalExp).toNumber());

  const rows = [];
  rows.push({ depth: 0, label: 'Ordinary Income/Expense', kind: 'section' });
  rows.push({ depth: 1, label: 'Income', kind: 'header' });
  for (const r of revenues) {
    rows.push({ depth: 2, label: r.name, kind: 'account', amount: r.amount });
  }
  rows.push({ depth: 1, label: 'Total Income', kind: 'subtotal', amount: totalRevN });
  rows.push({ depth: 1, label: 'Gross Profit', kind: 'subtotal', amount: totalRevN });

  rows.push({ depth: 1, label: 'Expense', kind: 'header' });
  for (const r of expenses) {
    rows.push({ depth: 2, label: r.name, kind: 'account', amount: r.amount });
  }
  rows.push({ depth: 1, label: 'Total Expense', kind: 'subtotal', amount: totalExpN });

  rows.push({ depth: 1, label: 'Net Ordinary Income', kind: 'subtotal', amount: netN });
  rows.push({ depth: 0, label: 'Net Income', kind: 'grandtotal', amount: netN });

  return {
    header: {
      reportType: 'pnl',
      title: 'Profit & Loss',
      companyName: companyName || 'LJC Financial, LLC',
      startDate,
      endDate,
      basis: 'Cash Basis (QBO)',
      dataSource: 'qbo_trial_balance',
      sourceFile: fileName,
      sourceNote:
        'App ledger has no income/expense in this period (activity was loaded as next-year opening balances). ' +
        'Showing the QBO year-end trial balance P&L (cash basis) so you can review the real 2025 results.',
    },
    rows,
    totals: {
      totalRevenue: totalRevN,
      totalExpense: totalExpN,
      netIncome: netN,
    },
  };
}

/** True when app GL P&L has no material revenue or expense. */
export function isEmptyAppProfitLoss(statement) {
  const t = statement?.totals || {};
  return Math.abs(t.totalRevenue || 0) < 0.005 && Math.abs(t.totalExpense || 0) < 0.005;
}
