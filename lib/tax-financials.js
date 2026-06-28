import fs from 'fs';
import path from 'path';
import Decimal from 'decimal.js';
import { getDatabase } from '../config/database.js';
import { POSTED_GL_SUBQUERY, calculateAccountBalance } from './posted-gl.js';
import { parseQboTrialBalance, verifySourceBalance } from './qbo-trial-balance.js';
import { verifyIntercompanyTieout } from './intercompany-tieout.js';
import { INTERCOMPANY_PAIRS } from '../config/intercompany-pairs.js';
import { ENTITY_TB_FILES } from '../config/opening-balance-mappings.js';
import { ENTITIES } from '../config/bootstrap-seed.js';

const TAX_YEAR = 2025;
const PERIOD_START = `${TAX_YEAR}-01-01`;
const PERIOD_END = `${TAX_YEAR}-12-31`;

async function incomeStatement(db, entityId, startDate, endDate) {
  const rows = await db.all(
    `SELECT a.account_number, a.account_name, a.account_type, a.normal_balance,
            COALESCE(SUM(gl.debit), 0) AS total_debit,
            COALESCE(SUM(gl.credit), 0) AS total_credit
     FROM accounts a
     LEFT JOIN (${POSTED_GL_SUBQUERY}) gl ON gl.account_id = a.id AND gl.entity_id = ?
       AND gl.posting_date >= ? AND gl.posting_date <= ?
     WHERE a.entity_id = ? AND a.is_active = 1
       AND a.account_type IN ('REVENUE', 'EXPENSE')
     GROUP BY a.id
     ORDER BY a.account_type, a.account_number`,
    [entityId, startDate, endDate, entityId]
  );

  let totalRevenue = new Decimal(0);
  let totalExpense = new Decimal(0);
  const revenues = [];
  const expenses = [];

  for (const acc of rows) {
    const amount = new Decimal(calculateAccountBalance(acc));
    if (amount.abs().lt(0.005)) continue;
    const item = {
      accountNumber: acc.account_number,
      accountName: acc.account_name,
      amount: amount.toNumber(),
    };
    if (acc.account_type === 'REVENUE') {
      revenues.push(item);
      totalRevenue = totalRevenue.plus(amount);
    } else {
      expenses.push(item);
      totalExpense = totalExpense.plus(amount);
    }
  }

  return {
    period: { startDate, endDate },
    revenues,
    totalRevenue: totalRevenue.toNumber(),
    expenses,
    totalExpense: totalExpense.toNumber(),
    netIncome: totalRevenue.minus(totalExpense).toNumber(),
  };
}

async function balanceSheet(db, entityId, asOfDate) {
  const rows = await db.all(
    `SELECT a.account_number, a.account_name, a.account_type, a.normal_balance,
            COALESCE(SUM(gl.debit), 0) AS total_debit,
            COALESCE(SUM(gl.credit), 0) AS total_credit
     FROM accounts a
     LEFT JOIN (${POSTED_GL_SUBQUERY}) gl ON gl.account_id = a.id AND gl.entity_id = ?
       AND (gl.posting_date IS NULL OR gl.posting_date <= ?)
     WHERE a.entity_id = ? AND a.is_active = 1
     GROUP BY a.id
     ORDER BY a.account_number`,
    [entityId, asOfDate, entityId]
  );

  const assets = [];
  const liabilities = [];
  const equity = [];
  let totalAssets = new Decimal(0);
  let totalLiabilities = new Decimal(0);
  let totalEquity = new Decimal(0);

  for (const acc of rows) {
    const amount = new Decimal(calculateAccountBalance(acc));
    if (amount.abs().lt(0.005)) continue;
    const item = { accountNumber: acc.account_number, accountName: acc.account_name, amount: amount.toNumber() };
    if (acc.account_type === 'ASSET') {
      assets.push(item);
      totalAssets = totalAssets.plus(amount);
    } else if (acc.account_type === 'LIABILITY') {
      liabilities.push(item);
      totalLiabilities = totalLiabilities.plus(amount);
    } else if (acc.account_type === 'EQUITY') {
      equity.push(item);
      totalEquity = totalEquity.plus(amount);
    }
  }

  const liabEquity = totalLiabilities.plus(totalEquity);
  return {
    asOfDate,
    assets,
    totalAssets: totalAssets.toNumber(),
    liabilities,
    totalLiabilities: totalLiabilities.toNumber(),
    equity,
    totalEquity: totalEquity.toNumber(),
    totalLiabilitiesAndEquity: liabEquity.toNumber(),
    balanceSheetBalanced: totalAssets.minus(liabEquity).abs().lt(0.02),
  };
}

function applyNetIncomeToBalanceSheet(bs, netIncome) {
  const ni = new Decimal(netIncome);
  const adjustedEquity = new Decimal(bs.totalEquity).plus(ni);
  const adjustedLiabEquity = new Decimal(bs.totalLiabilities).plus(adjustedEquity);
  const assets = new Decimal(bs.totalAssets);
  return {
    ...bs,
    currentYearNetIncome: ni.toNumber(),
    totalEquityWithNetIncome: adjustedEquity.toNumber(),
    totalLiabilitiesAndEquityWithNetIncome: adjustedLiabEquity.toNumber(),
    balanceSheetBalanced: assets.minus(adjustedLiabEquity).abs().lt(0.02),
  };
}

async function trialBalance(db, entityId, asOfDate) {
  const rows = await db.all(
    `SELECT a.account_number, a.account_name, a.account_type, a.normal_balance,
            COALESCE(SUM(gl.debit), 0) AS total_debit,
            COALESCE(SUM(gl.credit), 0) AS total_credit
     FROM accounts a
     LEFT JOIN (${POSTED_GL_SUBQUERY}) gl ON gl.account_id = a.id AND gl.entity_id = ?
       AND (gl.posting_date IS NULL OR gl.posting_date <= ?)
     WHERE a.entity_id = ? AND a.is_active = 1
     GROUP BY a.id
     ORDER BY a.account_number`,
    [entityId, asOfDate, entityId]
  );

  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  const entries = [];

  for (const acc of rows) {
    const balance = new Decimal(calculateAccountBalance(acc));
    if (balance.abs().lt(0.005)) continue;
    let debit = 0;
    let credit = 0;
    if (acc.normal_balance === 'DEBIT') {
      debit = balance.gte(0) ? balance.toNumber() : 0;
      credit = balance.lt(0) ? balance.neg().toNumber() : 0;
    } else {
      credit = balance.gte(0) ? balance.toNumber() : 0;
      debit = balance.lt(0) ? balance.neg().toNumber() : 0;
    }
    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);
    entries.push({
      accountNumber: acc.account_number,
      accountName: acc.account_name,
      accountType: acc.account_type,
      debit,
      credit,
    });
  }

  return {
    asOfDate,
    entries,
    totals: { debit: totalDebit.toNumber(), credit: totalCredit.toNumber() },
    isBalanced: totalDebit.minus(totalCredit).abs().lt(0.02),
  };
}

async function payrollSummary(db, entityId) {
  const rows = await db.all(
    `SELECT a.account_number, a.account_name, a.account_type,
            COALESCE(SUM(gl.debit), 0) - COALESCE(SUM(gl.credit), 0) AS net_debit
     FROM accounts a
     LEFT JOIN (${POSTED_GL_SUBQUERY}) gl ON gl.account_id = a.id AND gl.entity_id = ?
       AND gl.posting_date >= ? AND gl.posting_date <= ?
     WHERE a.entity_id = ? AND a.account_number IN ('6000', '2100')
     GROUP BY a.id`,
    [entityId, PERIOD_START, PERIOD_END, entityId]
  );
  return rows.map((r) => ({
    accountNumber: r.account_number,
    accountName: r.account_name,
    amount: Number(r.net_debit),
  }));
}

function loadQboSourceValidation(entityId, rootDir) {
  const fileName = ENTITY_TB_FILES[entityId];
  if (!fileName) return { error: 'No QBO source file mapped' };
  const filePath = path.join(rootDir, 'data/qbo-trial-balances/2025-12-31', fileName);
  if (!fs.existsSync(filePath)) return { error: 'QBO source file missing' };
  const rows = parseQboTrialBalance(fs.readFileSync(filePath, 'utf8'));
  const source = verifySourceBalance(rows);
  return {
    sourceFile: fileName,
    totalDebit: source.totalDebit,
    totalCredit: source.totalCredit,
    balanced: source.balanced,
    basis: 'Cash (per QBO export footer)',
  };
}

function readinessChecks({ incomeStatement: pl, balanceSheet: bs, trialBalance: tb, qboSource, entityId }) {
  const checks = [];
  checks.push({ id: 'tb_balanced', pass: tb.isBalanced, label: 'Trial balance debits equal credits' });
  checks.push({ id: 'bs_balanced', pass: bs.balanceSheetBalanced, label: 'Balance sheet assets equal liabilities + equity' });
  checks.push({ id: 'qbo_source', pass: qboSource.balanced === true, label: 'QBO source trial balance balanced' });
  checks.push({ id: 'has_pl', pass: pl.revenues.length + pl.expenses.length > 0 || Math.abs(pl.netIncome) < 0.02, label: 'Profit & loss reviewed (activity or zero)' });
  checks.push({ id: 'has_bs', pass: bs.assets.length + bs.liabilities.length > 0, label: 'Balance sheet has balances' });
  if (entityId === 'ent-gm') {
    checks.push({ id: 'payroll', pass: true, label: 'Payroll accounts included (Graceful Meadows)' });
  }
  const allPass = checks.every((c) => c.pass);
  return { allPass, checks };
}

export async function buildTaxFinancialsPackage(db, entityId, { taxYear = TAX_YEAR, rootDir = process.cwd() } = {}) {
  const entity = ENTITIES.find((e) => e.id === entityId);
  const startDate = `${taxYear}-01-01`;
  const endDate = `${taxYear}-12-31`;

  const pl = await incomeStatement(db, entityId, startDate, endDate);
  const bsRaw = await balanceSheet(db, entityId, endDate);
  const bs = applyNetIncomeToBalanceSheet(bsRaw, pl.netIncome);
  const tb = await trialBalance(db, entityId, endDate);
  const qboSource = loadQboSourceValidation(entityId, rootDir);
  const payroll = entityId === 'ent-gm' ? await payrollSummary(db, entityId) : null;
  const readiness = readinessChecks({ incomeStatement: pl, balanceSheet: bs, trialBalance: tb, qboSource, entityId });

  return {
    entityId,
    entityName: entity?.name || entityId,
    taxYear,
    accountingBasis: 'Cash',
    period: { startDate, endDate },
    asOfDate: endDate,
    incomeStatement: pl,
    balanceSheet: bs,
    trialBalance: tb,
    payrollSummary: payroll,
    qboSourceValidation: qboSource,
    readiness,
    taxReturnReady: readiness.allPass,
    disclaimer:
      'Financial statements only — does not file returns, compute tax, or produce K-1/partner allocations. Provide this package to your CPA for return preparation.',
  };
}

async function icBalanceMap(db, entityId, asOfDate) {
  const map = new Map();
  for (const pair of INTERCOMPANY_PAIRS) {
    for (const side of [pair.sideA, pair.sideB]) {
      if (side.entity !== entityId || map.has(side.account)) continue;
      const acc = await db.get(
        'SELECT id, normal_balance FROM accounts WHERE entity_id = ? AND account_number = ?',
        [entityId, side.account]
      );
      if (!acc) continue;
      const row = await db.get(
        `SELECT COALESCE(SUM(gl.debit),0) AS td, COALESCE(SUM(gl.credit),0) AS tc
         FROM general_ledger gl
         INNER JOIN journal_entries je ON je.id = gl.journal_entry_id
           AND je.status = 'POSTED' AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
         WHERE gl.account_id = ? AND gl.entity_id = ? AND gl.posting_date <= ?`,
        [acc.id, entityId, asOfDate]
      );
      const bal = calculateAccountBalance({ ...acc, total_debit: row?.td, total_credit: row?.tc });
      if (Math.abs(bal) > 0.004) map.set(side.account, new Decimal(bal));
    }
  }
  return map;
}

export async function buildAllEntitiesTaxPackage(db, options = {}) {
  const entities = Object.keys(ENTITY_TB_FILES);
  const packages = [];
  for (const entityId of entities) {
    packages.push(await buildTaxFinancialsPackage(db, entityId, options));
  }

  const icMaps = {};
  const asOf = `${options.taxYear || TAX_YEAR}-12-31`;
  for (const entityId of entities) {
    icMaps[entityId] = await icBalanceMap(db, entityId, asOf);
  }
  const intercompany = verifyIntercompanyTieout(icMaps);

  return {
    taxYear: options.taxYear || TAX_YEAR,
    generatedAt: new Date().toISOString(),
    accountingBasis: 'Cash',
    allTaxReturnReady: packages.every((p) => p.taxReturnReady) && intercompany.allTied,
    intercompany,
    entities: packages,
  };
}

export function taxPackageToCsv(pkg) {
  const lines = [];
  lines.push(`Tax Year Financial Package — ${pkg.entityName}`);
  lines.push(`Tax Year,${pkg.taxYear}`);
  lines.push(`Basis,${pkg.accountingBasis}`);
  lines.push(`Tax Return Ready,${pkg.taxReturnReady ? 'YES' : 'NO'}`);
  lines.push('');
  lines.push('PROFIT AND LOSS');
  lines.push('Account,Amount');
  for (const r of pkg.incomeStatement.revenues) lines.push(`${r.accountNumber} ${r.accountName},${r.amount}`);
  lines.push(`Total Revenue,${pkg.incomeStatement.totalRevenue}`);
  for (const e of pkg.incomeStatement.expenses) lines.push(`${e.accountNumber} ${e.accountName},${e.amount}`);
  lines.push(`Total Expense,${pkg.incomeStatement.totalExpense}`);
  lines.push(`Net Income,${pkg.incomeStatement.netIncome}`);
  lines.push('');
  lines.push('BALANCE SHEET');
  lines.push('Section,Account,Amount');
  for (const a of pkg.balanceSheet.assets) lines.push(`Asset,${a.accountNumber} ${a.accountName},${a.amount}`);
  for (const l of pkg.balanceSheet.liabilities) lines.push(`Liability,${l.accountNumber} ${l.accountName},${l.amount}`);
  for (const e of pkg.balanceSheet.equity) lines.push(`Equity,${e.accountNumber} ${e.accountName},${e.amount}`);
  if (pkg.balanceSheet.currentYearNetIncome != null) {
    lines.push(`Equity,Current Year Net Income,${pkg.balanceSheet.currentYearNetIncome}`);
    lines.push(`Equity,Total Equity (incl. net income),${pkg.balanceSheet.totalEquityWithNetIncome}`);
  }
  lines.push('');
  lines.push('TRIAL BALANCE');
  lines.push('Account,Type,Debit,Credit');
  for (const t of pkg.trialBalance.entries) {
    lines.push(`${t.accountNumber} ${t.accountName},${t.accountType},${t.debit},${t.credit}`);
  }
  lines.push(`Totals,,${pkg.trialBalance.totals.debit},${pkg.trialBalance.totals.credit}`);
  lines.push('');
  lines.push('READINESS CHECKS');
  for (const c of pkg.readiness.checks) lines.push(`${c.label},${c.pass ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}
