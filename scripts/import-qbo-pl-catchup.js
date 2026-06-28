#!/usr/bin/env node
/**
 * Post QBO Profit & Loss catch-up for LJC Financial 2026.
 * Idempotent on je_number per period (Jan + Feb–Jun).
 *
 * Usage:
 *   node scripts/import-qbo-pl-catchup.js [--preview] [--period=all|jan|feb-jun]
 */
import { getDatabase, closeDatabase } from '../config/database.js';
import {
  previewQboPlCatchUp,
  runQboPlCatchUp,
  runAllQboPlCatchUps,
  verifyQboPlMatch,
  verifyQboPlYtd,
  getQboPlConfig,
  QBO_PL_PERIODS_2026,
} from '../lib/qbo-pl-catchup.js';
import { QBO_PL_JAN_2026 } from '../config/qbo-pl-jan2026-targets.js';

const previewOnly = process.argv.includes('--preview');
const periodArg = process.argv.find((a) => a.startsWith('--period='));
const period = periodArg ? periodArg.split('=')[1] : 'all';

async function main() {
  const db = await getDatabase();

  if (previewOnly) {
    if (period === 'all' || period === '2026') {
      for (const config of QBO_PL_PERIODS_2026) {
        console.log(`\n--- Preview ${config.periodStart} .. ${config.periodEnd} ---`);
        console.log(JSON.stringify(await previewQboPlCatchUp(db, config), null, 2));
      }
      return;
    }
    const config = getQboPlConfig(period) || QBO_PL_JAN_2026;
    console.log(JSON.stringify(await previewQboPlCatchUp(db, config), null, 2));
    return;
  }

  if (period === 'all' || period === '2026') {
    const result = await runAllQboPlCatchUps(db, { userId: 'usr-admin' });
    console.log(JSON.stringify(result, null, 2));
    printYtd(result.ytd);
    if (!result.ytd?.matched) process.exitCode = 1;
    return;
  }

  const config = getQboPlConfig(period) || QBO_PL_JAN_2026;
  const result = await runQboPlCatchUp(db, { userId: 'usr-admin', config });
  console.log(JSON.stringify(result, null, 2));
  const verify = await verifyQboPlMatch(db, config);
  printPeriod(verify);
  if (!verify.matched) process.exitCode = 1;
}

function printPeriod(verify) {
  console.log('\n=== QBO MATCH ===');
  console.log(`Revenue: app ${verify.operatingRevenue} vs QBO ${verify.qbo.totalRevenue} — ${verify.revenueMatch ? 'MATCH' : 'MISMATCH'}`);
  console.log(`Other income: app ${verify.otherIncome} vs QBO ${verify.qbo.otherIncome} — ${verify.otherIncomeMatch ? 'MATCH' : 'MISMATCH'}`);
  console.log(`Expense: app ${verify.totalExpense} vs QBO ${verify.qbo.totalExpense} — ${verify.expenseMatch ? 'MATCH' : 'MISMATCH'}`);
  console.log(`Net Income: app ${verify.netIncome} vs QBO ${verify.qbo.netIncome} — ${verify.netIncomeMatch ? 'MATCH' : 'MISMATCH'}`);
}

function printYtd(ytd) {
  console.log('\n=== YTD QBO MATCH (Jan 1 – Jun 27) ===');
  console.log(`Revenue: app ${ytd.operatingRevenue} vs QBO ${ytd.qbo.totalRevenue} — ${ytd.revenueMatch ? 'MATCH' : 'MISMATCH'}`);
  console.log(`Other income: app ${ytd.otherIncome} vs QBO ${ytd.qbo.otherIncome} — ${ytd.otherIncomeMatch ? 'MATCH' : 'MISMATCH'}`);
  console.log(`Expense: app ${ytd.totalExpense} vs QBO ${ytd.qbo.totalExpense} — ${ytd.expenseMatch ? 'MATCH' : 'MISMATCH'}`);
  console.log(`Net Income: app ${ytd.netIncome} vs QBO ${ytd.qbo.netIncome} — ${ytd.netIncomeMatch ? 'MATCH' : 'MISMATCH'}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeDatabase();
    } catch {
      /* ignore */
    }
  });
