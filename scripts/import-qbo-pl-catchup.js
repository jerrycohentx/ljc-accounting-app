#!/usr/bin/env node
/**
 * Post QBO Profit & Loss catch-up for LJC Financial January 2026.
 * Idempotent on je_number QBO-PL-20260131.
 *
 * Usage:
 *   node scripts/import-qbo-pl-catchup.js [--preview]
 */
import { getDatabase, closeDatabase } from '../config/database.js';
import { previewQboPlCatchUp, runQboPlCatchUp, verifyQboPlMatch } from '../lib/qbo-pl-catchup.js';

const previewOnly = process.argv.includes('--preview');

async function main() {
  const db = await getDatabase();

  if (previewOnly) {
    const preview = await previewQboPlCatchUp(db);
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  const result = await runQboPlCatchUp(db, { userId: 'usr-admin' });
  console.log(JSON.stringify(result, null, 2));

  const verify = await verifyQboPlMatch(db);
  console.log('\n=== QBO MATCH ===');
  console.log(`Revenue: app ${verify.operatingRevenue} vs QBO ${verify.qbo.totalRevenue} — ${verify.revenueMatch ? 'MATCH' : 'MISMATCH'}`);
  console.log(`Other income: app ${verify.otherIncome} vs QBO ${verify.qbo.otherIncome} — ${verify.otherIncomeMatch ? 'MATCH' : 'MISMATCH'}`);
  console.log(`Expense: app ${verify.totalExpense} vs QBO ${verify.qbo.totalExpense} — ${verify.expenseMatch ? 'MATCH' : 'MISMATCH'}`);
  console.log(`Net Income: app ${verify.netIncome} vs QBO ${verify.qbo.netIncome} — ${verify.netIncomeMatch ? 'MATCH' : 'MISMATCH'}`);
  if (!verify.matched) {
    process.exitCode = 1;
  }
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
