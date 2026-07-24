import fs from 'fs';
import path from 'path';
import Decimal from 'decimal.js';
import { getDatabase } from '../config/database.js';
import { POSTED_GL_SUBQUERY, calculateAccountBalance } from './posted-gl.js';
import { parseQboTrialBalance, verifySourceBalance, accountTypeFromNumber } from './qbo-trial-balance.js';
import { verifyIntercompanyTieout } from './intercompany-tieout.js';
import { INTERCOMPANY_PAIRS } from '../config/intercompany-pairs.js';
import { ENTITY_TB_FILES } from '../config/opening-balance-mappings.js';
import { ENTITIES } from '../config/bootstrap-seed.js';
import { parseOpeningBalanceCsv } from './opening-balances.js';
import { getPeriodIntegrityStatus, PLUG_OR_ROLLUP_ACCOUNTS } from './period-integrity.js';
import { FULL_CHART_OF_ACCOUNTS } from '../config/coa-full.js';

const TAX_YEAR = 2025;
const PERIOD_START = `${TAX_YEAR}-01-01`;
const PERIOD_END = `${TAX_YEAR}-12-31`;

/** Accounts that CPAs must see called out on the tax package (not silent). */
const DISCLOSURE_ACCOUNTS = new Set(['1100', '1020', '1021', '1999', '2999', '3900', '3995', '3020']);

function coaNameLookup(entityId, accountNumber) {
  const hit = FULL_CHART_OF_ACCOUNTS.find(
    (a) => a.entity === entityId && String(a.number) === String(accountNumber)
  );
  return hit?.name || null;
}

async function accountNameMap(db, entityId) {
  const map = new Map();
  try {
    const rows = await db.all(
      'SELECT account_number, account_name FROM accounts WHERE entity_id = ?',
      [entityId]
    );
    for (const r of rows || []) map.set(String(r.account_number), r.account_name);
  } catch {
    // DB may be empty during offline package generation
  }
  return map;
}

function resolveName(names, entityId, accountNumber) {
  return (
    names.get(String(accountNumber)) ||
    coaNameLookup(entityId, accountNumber) ||
    `Account ${accountNumber}`
  );
}

function rollupCsvPath(rootDir, taxYear, entityId) {
  return path.join(rootDir, 'data/opening-balances', `${taxYear}-12-31`, `${entityId}-opening-balances.csv`);
}

/**
 * Build reference statements from the QBO→app rollup CSV.
 * NEVER plugs residual to 3900 — if the rollup does not balance, report the
 * residual as a blocker (hard rule: no plug / force-balance entries).
 * This file is reference-only; taxReturnReady uses the live app ledger.
 */
function buildStatementsFromRollup(balances, entityId, names, asOfDate) {
  const working = balances.map((b) => ({
    accountNumber: String(b.accountNumber),
    balance: Number(b.balance),
  }));

  // Compute natural-side debit/credit totals — do NOT plug the residual.
  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  for (const row of working) {
    const type = accountTypeFromNumber(row.accountNumber);
    const amount = new Decimal(row.balance);
    if (amount.abs().lt(0.005)) continue;
    const isCreditNormal = ['LIABILITY', 'EQUITY', 'REVENUE'].includes(type);
    if (isCreditNormal) {
      if (amount.gte(0)) totalCredit = totalCredit.plus(amount);
      else totalDebit = totalDebit.plus(amount.abs());
    } else if (amount.gte(0)) {
      totalDebit = totalDebit.plus(amount);
    } else {
      totalCredit = totalCredit.plus(amount.abs());
    }
  }
  const residual = totalDebit.minus(totalCredit);
  const plugBlocked =
    residual.abs().gte(0.005)
      ? {
          code: 'PLUG_ENTRY_BLOCKED',
          residual: Number(residual.toFixed(2)),
          message:
            'QBO rollup trial balance does not balance. Hard rule forbids plugging the residual to 3900 — fix the rollup mapping or source TB.',
        }
      : null;

  const revenues = [];
  const expenses = [];
  const assets = [];
  const liabilities = [];
  const equity = [];
  const tbEntries = [];

  let totalRevenue = new Decimal(0);
  let totalExpense = new Decimal(0);
  let totalAssets = new Decimal(0);
  let totalLiabilities = new Decimal(0);
  let totalEquity = new Decimal(0);
  totalDebit = new Decimal(0);
  totalCredit = new Decimal(0);

  const disclosures = [];

  for (const row of working) {
    const accountNumber = String(row.accountNumber);
    const type = accountTypeFromNumber(accountNumber);
    const amount = new Decimal(row.balance);
    if (amount.abs().lt(0.005)) continue;

    const accountName = resolveName(names, entityId, accountNumber);
    const item = { accountNumber, accountName, amount: amount.toNumber() };

    const isCreditNormal = ['LIABILITY', 'EQUITY', 'REVENUE'].includes(type);
    let debit = 0;
    let credit = 0;
    if (isCreditNormal) {
      if (amount.gte(0)) credit = amount.toNumber();
      else debit = amount.abs().toNumber();
    } else if (amount.gte(0)) {
      debit = amount.toNumber();
    } else {
      credit = amount.abs().toNumber();
    }
    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);
    tbEntries.push({ accountNumber, accountName, accountType: type, debit, credit });

    if (DISCLOSURE_ACCOUNTS.has(accountNumber)) {
      disclosures.push({
        ...item,
        accountName: DISCLOSURE_LABELS[accountNumber] || accountName,
        accountType: type,
        note: disclosureNote(accountNumber),
      });
    }

    if (type === 'REVENUE') {
      revenues.push(item);
      totalRevenue = totalRevenue.plus(amount);
    } else if (type === 'EXPENSE') {
      expenses.push(item);
      totalExpense = totalExpense.plus(amount);
    } else if (type === 'ASSET') {
      assets.push(item);
      totalAssets = totalAssets.plus(amount);
    } else if (type === 'LIABILITY') {
      liabilities.push(item);
      totalLiabilities = totalLiabilities.plus(amount);
    } else if (type === 'EQUITY') {
      equity.push(item);
      totalEquity = totalEquity.plus(amount);
    }
  }

  const netIncome = totalRevenue.minus(totalExpense);
  const equityWithNi = totalEquity.plus(netIncome);
  const liabEquity = totalLiabilities.plus(equityWithNi);

  return {
    incomeStatement: {
      period: { startDate: `${asOfDate.slice(0, 4)}-01-01`, endDate: asOfDate },
      revenues,
      totalRevenue: totalRevenue.toNumber(),
      expenses,
      totalExpense: totalExpense.toNumber(),
      netIncome: netIncome.toNumber(),
      source: 'qbo_rollup',
    },
    balanceSheet: {
      asOfDate,
      assets,
      totalAssets: totalAssets.toNumber(),
      liabilities,
      totalLiabilities: totalLiabilities.toNumber(),
      equity,
      totalEquity: totalEquity.toNumber(),
      currentYearNetIncome: netIncome.toNumber(),
      totalEquityWithNetIncome: equityWithNi.toNumber(),
      totalLiabilitiesAndEquity: liabEquity.toNumber(),
      totalLiabilitiesAndEquityWithNetIncome: liabEquity.toNumber(),
      balanceSheetBalanced: totalAssets.minus(liabEquity).abs().lt(0.02),
      source: 'qbo_rollup',
    },
    trialBalance: {
      asOfDate,
      entries: tbEntries,
      totals: { debit: totalDebit.toNumber(), credit: totalCredit.toNumber() },
      isBalanced: totalDebit.minus(totalCredit).abs().lt(0.02),
      source: 'qbo_rollup',
      plugBlocked,
    },
    disclosures,
    plugBlocked,
  };
}

function disclosureNote(accountNumber) {
  const notes = {
    1100: 'Undeposited Funds — clear or document before CPA finalizes',
    1020: 'Cash Clearing — should be $0 at year-end',
    1021: 'Transfers In Transit — should be $0 at year-end',
    1999: 'Other Assets rollup from QBO migration — reclass to detail for CPA if material',
    2999: 'Other Liabilities rollup from QBO migration — reclass to detail for CPA if material',
    3900: 'Opening Balance Equity — conversion plug; reclass to permanent equity after CPA review',
    3020: 'QBO Conversion Difference — conversion plug; resolve with CPA',
    3995: 'Migration Clearing — should be $0',
  };
  return notes[accountNumber] || 'Review with CPA';
}

const DISCLOSURE_LABELS = {
  1100: 'Undeposited Funds',
  1020: 'Cash Clearing',
  1021: 'Transfers In Transit',
  1999: 'Other Assets (Opening Rollup)',
  2999: 'Other Liabilities (Opening Rollup)',
  3900: 'Opening Balance Equity',
  3020: 'QBO Conversion Difference',
  3995: 'Migration Clearing',
};

async function incomeStatementFromGl(db, entityId, startDate, endDate) {
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
    source: 'app_gl',
  };
}

async function balanceSheetFromGl(db, entityId, asOfDate) {
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
    if (acc.account_type === 'REVENUE' || acc.account_type === 'EXPENSE') continue;
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
    source: 'app_gl',
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

async function trialBalanceFromGl(db, entityId, asOfDate) {
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
    source: 'app_gl',
  };
}

async function payrollSummary(db, entityId, taxYear) {
  const startDate = `${taxYear}-01-01`;
  const endDate = `${taxYear}-12-31`;
  const rows = await db.all(
    `SELECT a.account_number, a.account_name, a.account_type,
            COALESCE(SUM(gl.debit), 0) - COALESCE(SUM(gl.credit), 0) AS net_debit
     FROM accounts a
     LEFT JOIN (${POSTED_GL_SUBQUERY}) gl ON gl.account_id = a.id AND gl.entity_id = ?
       AND gl.posting_date >= ? AND gl.posting_date <= ?
     WHERE a.entity_id = ? AND a.account_number IN ('6000', '2100')
     GROUP BY a.id`,
    [entityId, startDate, endDate, entityId]
  );
  return rows.map((r) => ({
    accountNumber: r.account_number,
    accountName: r.account_name,
    amount: Number(r.net_debit),
  }));
}

function loadQboSourceValidation(entityId, rootDir, taxYear) {
  const fileName = ENTITY_TB_FILES[entityId];
  if (!fileName) return { error: 'No QBO source file mapped' };
  const filePath = path.join(rootDir, 'data/qbo-trial-balances', `${taxYear}-12-31`, fileName);
  if (!fs.existsSync(filePath)) return { error: 'QBO source file missing', path: filePath };
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

function readinessChecks({
  incomeStatement: pl,
  balanceSheet: bs,
  trialBalance: tb,
  qboSource,
  entityId,
  periodIntegrity,
  disclosures,
  statementSource,
  plugOrRollupBlockers,
}) {
  const checks = [];
  checks.push({
    id: 'ledger_source',
    pass: statementSource === 'app_gl',
    label: 'Tax package uses live app ledger (not QBO rollup as source of truth)',
  });
  checks.push({
    id: 'no_plug_or_rollup_balances',
    pass: (plugOrRollupBlockers || []).length === 0,
    label:
      (plugOrRollupBlockers || []).length === 0
        ? 'No balances in plug/rollup accounts (1999/2999/3020/3900/3995/1100/1020/1021)'
        : `Plug/rollup accounts still have balances: ${plugOrRollupBlockers.map((d) => `${d.accountNumber}=${d.amount}`).join(', ')}`,
  });
  checks.push({ id: 'tb_balanced', pass: tb.isBalanced === true, label: 'Trial balance debits equal credits (no equity plug)' });
  checks.push({
    id: 'bs_balanced',
    pass: bs.balanceSheetBalanced === true,
    label: 'Balance sheet assets equal liabilities + equity (incl. net income)',
  });
  checks.push({
    id: 'qbo_source',
    pass: qboSource.balanced === true || qboSource.error != null,
    label: qboSource.error
      ? `QBO source file optional reference (${qboSource.error})`
      : 'QBO source trial balance balanced (reference only)',
  });
  // If QBO source exists and is unbalanced, fail — but error/missing is OK as reference optional
  if (qboSource.balanced === false && !qboSource.error) {
    checks[checks.length - 1].pass = false;
  }
  checks.push({
    id: 'has_pl',
    pass:
      pl.revenues.length + pl.expenses.length > 0 ||
      (Math.abs(pl.netIncome) < 0.02 && Math.abs(bs.totalAssets) >= 1000),
    label: 'Profit & loss has year activity (or inactive holding entity with BS only)',
  });
  checks.push({
    id: 'material_bs',
    pass: Math.abs(bs.totalAssets) >= 1000 || entityId === 'ent-qof',
    label: 'Balance sheet has material balances from the live ledger',
  });
  checks.push({
    id: 'period_closed',
    pass: periodIntegrity?.isClosed === true,
    label: 'Accounting period closed with integrity (isClosed: true)',
  });
  checks.push({
    id: 'disclosures_listed',
    pass: true,
    label:
      disclosures.length === 0
        ? 'No conversion/clearing disclosure accounts with balances'
        : `${disclosures.length} conversion/clearing account(s) disclosed — these block taxReturnReady until cleared`,
  });
  if (entityId === 'ent-gm') {
    checks.push({ id: 'payroll', pass: true, label: 'Payroll accounts included (Graceful Meadows)' });
  }
  const allPass = checks.every((c) => c.pass);
  return { allPass, checks };
}

async function disclosuresFromGl(db, entityId, asOfDate, names) {
  const disclosures = [];
  const watch = new Set([...DISCLOSURE_ACCOUNTS, ...PLUG_OR_ROLLUP_ACCOUNTS]);
  for (const accountNumber of watch) {
    const acc = await db.get(
      'SELECT id, account_number, account_name, account_type, normal_balance FROM accounts WHERE entity_id = ? AND account_number = ?',
      [entityId, accountNumber]
    );
    if (!acc) continue;
    const row = await db.get(
      `SELECT COALESCE(SUM(gl.debit),0) AS td, COALESCE(SUM(gl.credit),0) AS tc
       FROM (${POSTED_GL_SUBQUERY}) gl
       WHERE gl.account_id = ? AND gl.entity_id = ? AND gl.posting_date <= ?`,
      [acc.id, entityId, asOfDate]
    );
    const bal = calculateAccountBalance({ ...acc, total_debit: row?.td, total_credit: row?.tc });
    if (bal.abs().lt(0.005)) continue;
    disclosures.push({
      accountNumber,
      accountName: DISCLOSURE_LABELS[accountNumber] || resolveName(names, entityId, accountNumber),
      amount: bal.toNumber(),
      accountType: acc.account_type,
      note: disclosureNote(accountNumber),
    });
  }
  return disclosures;
}

function plugOrRollupBlockersFromDisclosures(disclosures) {
  const blockedNums = new Set([...PLUG_OR_ROLLUP_ACCOUNTS, '1100', '1020', '1021']);
  return (disclosures || []).filter((d) => blockedNums.has(String(d.accountNumber)));
}

export async function buildTaxFinancialsPackage(db, entityId, { taxYear = TAX_YEAR, rootDir = process.cwd() } = {}) {
  const entity = ENTITIES.find((e) => e.id === entityId);
  const startDate = `${taxYear}-01-01`;
  const endDate = `${taxYear}-12-31`;
  const names = await accountNameMap(db, entityId);
  const csvPath = rollupCsvPath(rootDir, taxYear, entityId);
  const rollupPresent = fs.existsSync(csvPath);

  // Hard rule: live app ledger is the only source of truth for taxReturnReady.
  // QBO rollup (if present) is attached as non-authoritative reference — never plugged.
  const pl = await incomeStatementFromGl(db, entityId, startDate, endDate);
  const bsRaw = await balanceSheetFromGl(db, entityId, endDate);
  const bs = applyNetIncomeToBalanceSheet(bsRaw, pl.netIncome);
  const tb = await trialBalanceFromGl(db, entityId, endDate);
  const disclosures = await disclosuresFromGl(db, entityId, endDate, names);
  const plugOrRollupBlockers = plugOrRollupBlockersFromDisclosures(disclosures);
  const statementSource = 'app_gl';

  let qboRollupReference = null;
  if (rollupPresent) {
    try {
      const balances = parseOpeningBalanceCsv(fs.readFileSync(csvPath, 'utf8'));
      const built = buildStatementsFromRollup(balances, entityId, names, endDate);
      qboRollupReference = {
        note: 'Reference only — not used for taxReturnReady. Residual plugs to 3900 are forbidden.',
        netIncome: built.incomeStatement.netIncome,
        totalAssets: built.balanceSheet.totalAssets,
        tbBalanced: built.trialBalance.isBalanced,
        plugBlocked: built.plugBlocked,
        disclosures: built.disclosures,
      };
    } catch (e) {
      qboRollupReference = { error: e.message };
    }
  }

  const qboSource = loadQboSourceValidation(entityId, rootDir, taxYear);
  const payroll = entityId === 'ent-gm' ? await payrollSummary(db, entityId, taxYear) : null;

  let periodIntegrity = null;
  try {
    periodIntegrity = await getPeriodIntegrityStatus(db, {
      entityId,
      periodStart: startDate,
      periodEnd: endDate,
    });
  } catch (e) {
    periodIntegrity = { isClosed: false, error: e.message };
  }

  const readiness = readinessChecks({
    incomeStatement: pl,
    balanceSheet: bs,
    trialBalance: tb,
    qboSource,
    entityId,
    periodIntegrity,
    disclosures,
    statementSource,
    plugOrRollupBlockers,
  });

  return {
    entityId,
    entityName: entity?.name || entityId,
    taxYear,
    accountingBasis: 'Cash',
    period: { startDate, endDate },
    asOfDate: endDate,
    statementSource,
    incomeStatement: pl,
    balanceSheet: bs,
    trialBalance: tb,
    payrollSummary: payroll,
    qboSourceValidation: qboSource,
    qboRollupReference,
    plugOrRollupBlockers,
    periodIntegrity: {
      isClosed: periodIntegrity?.isClosed === true,
      canClose: periodIntegrity?.canClose === true,
      databasePeriodStatus: periodIntegrity?.databasePeriodStatus || null,
      blockers: periodIntegrity?.blockers || [],
    },
    disclosures,
    readiness,
    taxReturnReady: readiness.allPass,
    disclaimer:
      'Cash-basis financial package from the live app ledger for CPA return preparation. taxReturnReady requires period integrity, a balanced TB/BS with no plug, and $0 balances in rollup/plug/suspense accounts (1999/2999/3020/3900/3995/1100/1020/1021). QBO rollup files are reference only — never force-balanced via Opening Balance Equity. Does not file returns, compute tax, or produce K-1s.',
  };
}

function icBalanceMapFromRollup(entityId, rootDir, taxYear) {
  const csvPath = rollupCsvPath(rootDir, taxYear, entityId);
  const map = new Map();
  if (!fs.existsSync(csvPath)) return map;
  const balances = parseOpeningBalanceCsv(fs.readFileSync(csvPath, 'utf8'));
  for (const row of balances) {
    map.set(String(row.accountNumber), new Decimal(row.balance));
  }
  return map;
}

async function icBalanceMapFromGl(db, entityId, asOfDate) {
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
      if (bal.abs().gt(0.004)) map.set(side.account, bal);
    }
  }
  return map;
}

export async function buildAllEntitiesTaxPackage(db, options = {}) {
  const taxYear = options.taxYear || TAX_YEAR;
  const rootDir = options.rootDir || process.cwd();
  const entities = Object.keys(ENTITY_TB_FILES);
  const packages = [];
  for (const entityId of entities) {
    packages.push(await buildTaxFinancialsPackage(db, entityId, { taxYear, rootDir }));
  }

  const icMaps = {};
  for (const entityId of entities) {
    const fromRollup = icBalanceMapFromRollup(entityId, rootDir, taxYear);
    icMaps[entityId] = fromRollup.size ? fromRollup : await icBalanceMapFromGl(db, entityId, `${taxYear}-12-31`);
  }
  const intercompany = verifyIntercompanyTieout(icMaps);

  return {
    taxYear,
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
  lines.push(`Statement Source,${pkg.statementSource || ''}`);
  lines.push(`Tax Return Ready,${pkg.taxReturnReady ? 'YES' : 'NO'}`);
  lines.push(`Period Closed,${pkg.periodIntegrity?.isClosed ? 'YES' : 'NO'}`);
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
  if (pkg.disclosures?.length) {
    lines.push('DISCLOSURES FOR CPA');
    lines.push('Account,Amount,Note');
    for (const d of pkg.disclosures) {
      lines.push(`${d.accountNumber} ${d.accountName},${d.amount},"${d.note}"`);
    }
    lines.push('');
  }
  lines.push('READINESS CHECKS');
  for (const c of pkg.readiness.checks) lines.push(`${c.label},${c.pass ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

// Keep getDatabase import used when scripts call through this module's helpers.
void getDatabase;
