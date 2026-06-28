import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { FULL_CHART_OF_ACCOUNTS } from '../config/coa-full.js';
import { QBO_PL_JAN_2026 } from '../config/qbo-pl-jan2026-targets.js';
import { QBO_PL_PERIODS_2026, getQboPlConfig } from '../config/qbo-pl-periods.js';
import { POSTED_GL_SUBQUERY } from './posted-gl.js';
import { postJournalEntryToGl } from './post-journal.js';
import { seedDatabaseContent } from '../config/bootstrap-seed.js';

export const LJC_ENTITY_ID = 'ent-ljc';
const ENTITY_ID = LJC_ENTITY_ID;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Ensure any missing COA rows from coa-full exist and names stay current (idempotent). */
export async function ensureLjcCoa(db) {
  await seedDatabaseContent(db);
  for (const acc of FULL_CHART_OF_ACCOUNTS.filter((a) => a.entity === ENTITY_ID)) {
    const normalBalance = ['ASSET', 'EXPENSE'].includes(acc.type) ? 'DEBIT' : 'CREDIT';
    await db.run(
      `UPDATE accounts SET account_name = ?, account_type = ?, normal_balance = ?
       WHERE entity_id = ? AND account_number = ?`,
      [acc.name, acc.type, normalBalance, ENTITY_ID, acc.number]
    );
  }
}

async function resolveAccount(db, accountNumber) {
  return db.get(
    'SELECT id, account_number, account_name, account_type, normal_balance FROM accounts WHERE entity_id = ? AND account_number = ?',
    [ENTITY_ID, accountNumber]
  );
}

/**
 * Posted P&L balance for one account in a period, excluding prior QBO catch-up JEs.
 */
export async function getPostedPlBalance(db, accountNumber, startDate, endDate, excludeJeNumber = null) {
  const params = [ENTITY_ID, startDate, endDate, ENTITY_ID, accountNumber];
  let excludeSql = '';
  if (excludeJeNumber) {
    excludeSql = ' AND (je.je_number IS NULL OR je.je_number != ?)';
    params.push(excludeJeNumber);
  }
  const row = await db.get(
    `SELECT a.normal_balance,
            COALESCE(SUM(gl.debit), 0) AS total_debit,
            COALESCE(SUM(gl.credit), 0) AS total_credit
       FROM accounts a
       LEFT JOIN (${POSTED_GL_SUBQUERY}) gl ON gl.account_id = a.id AND gl.entity_id = ?
         AND gl.posting_date >= ? AND gl.posting_date <= ?
       LEFT JOIN journal_entries je ON je.id = gl.journal_entry_id
      WHERE a.entity_id = ? AND a.account_number = ?
        ${excludeSql}
      GROUP BY a.id, a.normal_balance`,
    params
  );
  if (!row?.normal_balance) {
    const acct = await resolveAccount(db, accountNumber);
    if (!acct) return 0;
    return 0;
  }
  const debit = new Decimal(row.total_debit || 0);
  const credit = new Decimal(row.total_credit || 0);
  if (row.normal_balance === 'DEBIT') return round2(debit.minus(credit).toNumber());
  return round2(credit.minus(debit).toNumber());
}

function buildJeLines(dbAccounts, deltas) {
  const jeLines = [];
  let lineNum = 1;

  for (const d of deltas) {
    if (Math.abs(d.delta) < 0.005) continue;
    const pl = dbAccounts.get(d.account);
    const off = dbAccounts.get(d.offset);
    if (!pl || !off) throw new Error(`Missing account ${d.account} or offset ${d.offset}`);

    const amt = round2(Math.abs(d.delta));
    const isRevenue = pl.account_type === 'REVENUE';
    const increasing = d.delta > 0;

    if (isRevenue) {
      if (increasing) {
        jeLines.push({ accountId: pl.id, debit: 0, credit: amt, desc: d.label, lineNum: lineNum++ });
        jeLines.push({ accountId: off.id, debit: amt, credit: 0, desc: `${d.label} offset`, lineNum: lineNum++ });
      } else {
        jeLines.push({ accountId: pl.id, debit: amt, credit: 0, desc: d.label, lineNum: lineNum++ });
        jeLines.push({ accountId: off.id, debit: 0, credit: amt, desc: `${d.label} offset`, lineNum: lineNum++ });
      }
    } else {
      if (increasing) {
        jeLines.push({ accountId: pl.id, debit: amt, credit: 0, desc: d.label, lineNum: lineNum++ });
        jeLines.push({ accountId: off.id, debit: 0, credit: amt, desc: `${d.label} offset`, lineNum: lineNum++ });
      } else {
        jeLines.push({ accountId: pl.id, debit: 0, credit: amt, desc: d.label, lineNum: lineNum++ });
        jeLines.push({ accountId: off.id, debit: amt, credit: 0, desc: `${d.label} offset`, lineNum: lineNum++ });
      }
    }
  }

  return jeLines;
}

export async function previewQboPlCatchUp(db, config = QBO_PL_JAN_2026) {
  await ensureLjcCoa(db);
  const { periodStart, periodEnd, jeNumber, lines } = config;

  const deltas = [];
  for (const line of lines) {
    const current = await getPostedPlBalance(db, line.account, periodStart, periodEnd, jeNumber);
    const delta = round2(line.target - current);
    deltas.push({
      account: line.account,
      label: line.label,
      offset: line.offset,
      target: line.target,
      current,
      delta,
    });
  }

  const dbAccounts = new Map();
  const nums = new Set([...lines.map((l) => l.account), ...lines.map((l) => l.offset)]);
  for (const num of nums) {
    const acct = await resolveAccount(db, num);
    if (acct) dbAccounts.set(num, acct);
  }

  const jeLines = buildJeLines(dbAccounts, deltas);
  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of jeLines) {
    totalDebit += l.debit;
    totalCredit += l.credit;
  }

  return {
    period: { startDate: periodStart, endDate: periodEnd },
    jeNumber,
    deltas,
    jeLineCount: jeLines.length,
    totalDebit: round2(totalDebit),
    totalCredit: round2(totalCredit),
    balanced: Math.abs(totalDebit - totalCredit) < 0.02,
  };
}

export async function runQboPlCatchUp(db, { userId = 'usr-admin', config = QBO_PL_JAN_2026 } = {}) {
  await ensureLjcCoa(db);
  const { periodStart, periodEnd, postingDate, jeNumber, lines, qboTotalRevenue, qboTotalExpense, qboNetIncome } = config;

  const existing = await db.get(
    `SELECT id, status FROM journal_entries WHERE entity_id = ? AND je_number = ? AND reversed_by_je_id IS NULL`,
    [ENTITY_ID, jeNumber]
  );
  if (existing?.status === 'POSTED') {
    const verification = await verifyQboPlMatch(db, config);
    if (verification.matched) {
      return { skipped: true, reason: 'already posted', jeNumber, verification };
    }
    await db.run('DELETE FROM general_ledger WHERE journal_entry_id = ?', [existing.id]);
    await db.run('DELETE FROM journal_entry_lines WHERE journal_entry_id = ?', [existing.id]);
    await db.run('DELETE FROM journal_entries WHERE id = ?', [existing.id]);
  } else if (existing) {
    await db.run('DELETE FROM journal_entry_lines WHERE journal_entry_id = ?', [existing.id]);
    await db.run('DELETE FROM general_ledger WHERE journal_entry_id = ?', [existing.id]);
    await db.run('DELETE FROM journal_entries WHERE id = ?', [existing.id]);
  }

  const preview = await previewQboPlCatchUp(db, config);
  if (!preview.balanced) {
    throw new Error(`QBO P&L catch-up out of balance: DR ${preview.totalDebit} CR ${preview.totalCredit}`);
  }
  if (preview.jeLineCount < 2) {
    return { skipped: true, reason: 'no deltas', verification: await verifyQboPlMatch(db, config) };
  }

  const dbAccounts = new Map();
  const nums = new Set([...lines.map((l) => l.account), ...lines.map((l) => l.offset)]);
  for (const num of nums) {
    const acct = await resolveAccount(db, num);
    if (!acct) throw new Error(`Account ${num} not found`);
    dbAccounts.set(num, acct);
  }

  const jeLines = buildJeLines(dbAccounts, preview.deltas);
  const totalAmt = round2(jeLines.reduce((s, l) => s + l.debit, 0));
  const jeId = `je-${uuidv4()}`;

  await db.run(
    `INSERT INTO journal_entries (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [
      jeId,
      ENTITY_ID,
      jeNumber,
      `QBO P&L catch-up ${periodStart} .. ${periodEnd}`,
      postingDate,
      userId,
      totalAmt,
      totalAmt,
      'QBO-PL-CATCHUP',
    ]
  );

  for (const line of jeLines) {
    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`jel-${uuidv4()}`, jeId, line.accountId, line.debit, line.credit, line.desc, line.lineNum]
    );
  }

  await postJournalEntryToGl(db, { journalId: jeId, entityId: ENTITY_ID, userId });

  const verification = await verifyQboPlMatch(db, config);

  return {
    posted: true,
    jeNumber,
    jeId,
    lineCount: preview.deltas.filter((d) => Math.abs(d.delta) >= 0.005).length,
    qboTargets: { revenue: qboTotalRevenue, expense: qboTotalExpense, netIncome: qboNetIncome },
    verification,
  };
}

/** Compare rolled-up app P&L vs QBO targets after catch-up. */
export async function verifyQboPlMatch(db, config = QBO_PL_JAN_2026) {
  const {
    periodStart,
    periodEnd,
    lines,
    qboTotalRevenue,
    qboOtherIncome = 0,
    qboTotalExpense,
    qboNetIncome,
  } = config;

  const accounts = [];
  let operatingRevenue = 0;
  let otherIncome = 0;
  let totalExpense = 0;

  for (const line of lines) {
    const current = await getPostedPlBalance(db, line.account, periodStart, periodEnd);
    const acct = await resolveAccount(db, line.account);
    const row = {
      account: line.account,
      label: line.label,
      target: line.target,
      actual: current,
      variance: round2(current - line.target),
    };
    accounts.push(row);
    if (acct?.account_type === 'REVENUE') {
      if (line.section === 'other') otherIncome += current;
      else operatingRevenue += current;
    } else if (acct?.account_type === 'EXPENSE') {
      totalExpense += current;
    }
  }

  operatingRevenue = round2(operatingRevenue);
  otherIncome = round2(otherIncome);
  totalExpense = round2(totalExpense);
  const totalRevenue = round2(operatingRevenue + otherIncome);
  const netIncome = round2(operatingRevenue + otherIncome - totalExpense);

  return {
    period: { startDate: periodStart, endDate: periodEnd },
    accounts,
    operatingRevenue,
    otherIncome,
    totalRevenue,
    totalExpense,
    netIncome,
    qbo: {
      totalRevenue: qboTotalRevenue,
      otherIncome: qboOtherIncome,
      totalExpense: qboTotalExpense,
      netIncome: qboNetIncome,
    },
    revenueMatch: Math.abs(operatingRevenue - qboTotalRevenue) < 0.1,
    otherIncomeMatch: Math.abs(otherIncome - qboOtherIncome) < 0.05,
    expenseMatch: Math.abs(totalExpense - qboTotalExpense) < 0.05,
    netIncomeMatch: Math.abs(netIncome - qboNetIncome) < 0.1,
    matched:
      Math.abs(operatingRevenue - qboTotalRevenue) < 0.1
      && Math.abs(otherIncome - qboOtherIncome) < 0.05
      && Math.abs(totalExpense - qboTotalExpense) < 0.05
      && Math.abs(netIncome - qboNetIncome) < 0.1,
  };
}

/** Run all configured 2026 QBO P&L catch-up periods (Jan, then Feb–Jun). */
export async function runAllQboPlCatchUps(db, { userId = 'usr-admin', periods = QBO_PL_PERIODS_2026 } = {}) {
  const results = [];
  for (const config of periods) {
    const result = await runQboPlCatchUp(db, { userId, config });
    results.push({ jeNumber: config.jeNumber, period: `${config.periodStart}..${config.periodEnd}`, ...result });
  }
  const ytd = await verifyQboPlYtd(db, periods);
  return { periods: results, ytd };
}

/** Verify combined YTD P&L across multiple catch-up periods vs sum of QBO targets. */
export async function verifyQboPlYtd(db, periods = QBO_PL_PERIODS_2026) {
  if (!periods.length) return { matched: false };

  const startDate = periods[0].periodStart;
  const endDate = periods[periods.length - 1].periodEnd;

  let qboOperatingRevenue = 0;
  let qboOtherIncome = 0;
  let qboTotalExpense = 0;
  let qboNetIncome = 0;
  const accountTargets = new Map();

  for (const config of periods) {
    qboOperatingRevenue += config.qboTotalRevenue;
    qboOtherIncome += config.qboOtherIncome || 0;
    qboTotalExpense += config.qboTotalExpense;
    qboNetIncome += config.qboNetIncome;
    for (const line of config.lines) {
      accountTargets.set(line.account, (accountTargets.get(line.account) || 0) + line.target);
    }
  }

  let operatingRevenue = 0;
  let otherIncome = 0;
  let totalExpense = 0;

  for (const [account, target] of accountTargets) {
    const actual = await getPostedPlBalance(db, account, startDate, endDate);
    const acct = await resolveAccount(db, account);
    if (acct?.account_type === 'REVENUE') {
      const line = periods.flatMap((p) => p.lines).find((l) => l.account === account);
      if (line?.section === 'other') otherIncome += actual;
      else operatingRevenue += actual;
    } else if (acct?.account_type === 'EXPENSE') {
      totalExpense += actual;
    }
  }

  operatingRevenue = round2(operatingRevenue);
  otherIncome = round2(otherIncome);
  totalExpense = round2(totalExpense);
  const netIncome = round2(operatingRevenue + otherIncome - totalExpense);

  qboOperatingRevenue = round2(qboOperatingRevenue);
  qboOtherIncome = round2(qboOtherIncome);
  qboTotalExpense = round2(qboTotalExpense);
  qboNetIncome = round2(qboNetIncome);

  return {
    period: { startDate, endDate },
    operatingRevenue,
    otherIncome,
    totalExpense,
    netIncome,
    qbo: {
      totalRevenue: qboOperatingRevenue,
      otherIncome: qboOtherIncome,
      totalExpense: qboTotalExpense,
      netIncome: qboNetIncome,
    },
    revenueMatch: Math.abs(operatingRevenue - qboOperatingRevenue) < 0.15,
    otherIncomeMatch: Math.abs(otherIncome - qboOtherIncome) < 0.1,
    expenseMatch: Math.abs(totalExpense - qboTotalExpense) < 0.15,
    netIncomeMatch: Math.abs(netIncome - qboNetIncome) < 0.15,
    matched:
      Math.abs(operatingRevenue - qboOperatingRevenue) < 0.15
      && Math.abs(otherIncome - qboOtherIncome) < 0.1
      && Math.abs(totalExpense - qboTotalExpense) < 0.15
      && Math.abs(netIncome - qboNetIncome) < 0.15,
  };
}

export { getQboPlConfig, QBO_PL_PERIODS_2026 };
