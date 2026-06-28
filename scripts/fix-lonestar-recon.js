#!/usr/bin/env node
/**
 * Reopen Lone Star (1001) bank reconciliations and re-run month-by-month with balance guard.
 *
 * Usage:
 *   node scripts/fix-lonestar-recon.js [--reopen-only] [--from 2026-01-31]
 */
import { getDatabase, closeDatabase } from '../config/database.js';
import { seedDatabaseContent } from '../config/bootstrap-seed.js';
import { reopenBankReconciliation, autoReconcileToTarget, buildWorksheet } from '../lib/bank-reconcile-session.js';
import { RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';

const ENTITY = 'ent-ljc';
const ACCOUNT = '1001';
const args = process.argv.slice(2);
const reopenOnly = args.includes('--reopen-only');
const fromIdx = args.indexOf('--from');
const fromDate = fromIdx >= 0 ? args[fromIdx + 1] : null;

async function main() {
  const db = await getDatabase();
  await seedDatabaseContent(db);

  const acc = await db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE entity_id = ? AND account_number = ?',
    [ENTITY, ACCOUNT]
  );
  if (!acc) {
    console.error(`Account ${ACCOUNT} not found for ${ENTITY}`);
    process.exit(1);
  }
  console.log(`Lone Star account: ${acc.account_number} · ${acc.account_name} (${acc.id})`);

  const targets = (RECONCILIATION_TARGETS[ENTITY]?.[ACCOUNT] || []).filter(
    (t) => !fromDate || t.statementDate >= fromDate
  );

  for (const target of targets) {
    console.log(`\nReopening ${target.label || target.statementDate}...`);
    const reopened = await reopenBankReconciliation(db, {
      entityId: ENTITY,
      accountId: acc.id,
      statementDate: target.statementDate,
    });
    console.log(' ', reopened);
  }

  if (reopenOnly) {
    await closeDatabase();
    return;
  }

  for (const target of targets) {
    if (target.endingBalance == null) continue;
    console.log(`\nReconciling ${target.label || target.statementDate} → $${target.endingBalance}...`);
    const ws = await buildWorksheet(db, {
      entityId: ENTITY,
      accountId: acc.id,
      statementDate: target.statementDate,
    });
    console.log(`  Beginning balance: $${ws.beginningBalance}`);

    const r = await autoReconcileToTarget(db, {
      entityId: ENTITY,
      accountNumber: ACCOUNT,
      statementDate: target.statementDate,
      endingBalance: target.endingBalance,
      userId: 'usr-demo',
      notes: `Fix Lone Star recon ${target.statementDate}`,
    });

    if (r.reconciled) {
      console.log(`  ✓ Closed — ${r.clearedCount} lines, session ${r.sessionId}`);
    } else {
      console.error(`  ✗ Failed: ${r.message || 'unknown'}`);
      if (r.variance != null) console.error(`    variance: ${r.variance}, computed: ${r.computedBalance}`);
      process.exitCode = 1;
      break;
    }
  }

  await closeDatabase();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
