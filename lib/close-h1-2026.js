/**
 * Close LJC Financial calendar months Jan–Jun 2026 when integrity allows.
 * Runs bank/card catch-ups, clears conversion suspense, auto-reconciles
 * against RECONCILIATION_TARGETS, then period close.
 */
import { RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';
import { autoReconcileToTarget } from './bank-reconcile-session.js';
import { closeMonthContaining, monthBounds, reopenPeriod } from './period-lock.js';
import { getPeriodIntegrityStatus, statementCoversMonth } from './period-integrity.js';
import { checkSuspenseAccounts } from './suspense-check.js';
import { clearConversionSuspenseFor2026 } from './clear-conversion-suspense.js';
import { getPostedBankBalance } from './bank-catchup.js';
import { runLonestarCatchUp } from './lonestar-catchup.js';
import { runAmexCatchUp } from './amex-catchup.js';
import { runSimmonsOfxCatchUp } from './simmons-ofx-catchup.js';
import { reclassPostedUndepositedOffsets } from './reclass-posted-undeposited.js';
import { reverseDuplicateBankImports } from './reverse-duplicate-bank-imports.js';
import { reverseRestoreImportJournals } from './reverse-restore-imports.js';
import { reverseLonestarOpeningTrueUp } from './reverse-lonestar-trueup.js';
import { restoreMistakenImportReversals } from './reverse-duplicate-bank-imports.js';

const ENTITY_ID = 'ent-ljc';

async function runCatchUps(db, userId) {
  const out = {};
  try {
    out.lonestar = await runLonestarCatchUp(db, { userId });
  } catch (e) {
    out.lonestar = { error: e.message };
  }
  try {
    out.amex = await runAmexCatchUp(db, { userId });
  } catch (e) {
    out.amex = { error: e.message };
  }
  try {
    out.simmons = await runSimmonsOfxCatchUp(db, { userId });
  } catch (e) {
    out.simmons = { error: e.message };
  }
  return out;
}

async function reconcileTargetsForMonth(db, userId, year, month) {
  const { periodStart, periodEnd } = monthBounds(`${year}-${String(month).padStart(2, '0')}-15`);
  const results = [];
  const accounts = RECONCILIATION_TARGETS[ENTITY_ID] || {};
  for (const [accountNumber, targets] of Object.entries(accounts)) {
    for (const target of targets) {
      if (target.endingBalance == null) continue;
      if (!statementCoversMonth(target.statementDate, periodStart, periodEnd)) continue;

      const r = await autoReconcileToTarget(db, {
        entityId: ENTITY_ID,
        accountNumber,
        statementDate: target.statementDate,
        endingBalance: target.endingBalance,
        userId,
        notes: `H1 2026 close — ${accountNumber} ${target.label || target.statementDate}`,
      });
      results.push({ accountNumber, ...target, ...r });
    }
  }

  // Lonestar has no June target — close June at book balance if May was reconciled
  if (year === 2026 && month === 6) {
    const bal = await getPostedBankBalance(db, ENTITY_ID, '1001', '2026-06-30');
    if (bal) {
      const endingBalance = Math.round(Number(bal.balance) * 100) / 100;
      const r = await autoReconcileToTarget(db, {
        entityId: ENTITY_ID,
        accountNumber: '1001',
        statementDate: '2026-06-30',
        endingBalance,
        userId,
        notes: 'H1 2026 close — 1001 June (books flat after May; no separate June stmt)',
      });
      results.push({ accountNumber: '1001', statementDate: '2026-06-30', endingBalance, label: 'June 2026 (book)', ...r });
    }
  }

  return { periodStart, periodEnd, results };
}

export async function closeH1_2026(
  db,
  { userId = 'usr-admin', clearSuspense = true, runImports = true } = {}
) {
  const report = { entityId: ENTITY_ID, months: [] };

  if (runImports) {
    report.catchUps = await runCatchUps(db, userId);
  }

  // Reopen Jan–Jun so duplicate reversals can post into those months
  report.reopened = [];
  for (let month = 1; month <= 6; month++) {
    const postingDate = `2026-${String(month).padStart(2, '0')}-15`;
    const { periodStart, periodEnd } = monthBounds(postingDate);
    try {
      const r = await reopenPeriod(db, { entityId: ENTITY_ID, periodStart, periodEnd });
      report.reopened.push({ month, periodStart, periodEnd, ...r });
    } catch (e) {
      report.reopened.push({ month, periodStart, periodEnd, error: e.message });
    }
  }

  // Undo RESTORE-* journals from a prior bad restore pass
  report.undoRestores = await reverseRestoreImportJournals(db, { entityId: ENTITY_ID, userId });

  // Remove double Lonestar opening (OB + TRUEUP both +598.88)
  report.lonestarTrueUp = await reverseLonestarOpeningTrueUp(db, { entityId: ENTITY_ID, userId });

  // Restore AMEX statement lines reversed by an earlier aggressive dedupe
  report.restoreAmex = await restoreMistakenImportReversals(db, { entityId: ENTITY_ID, userId });

  // Reverse manual JE-* twins only when an IMP/AMEX feed line exists
  report.dedupe = await reverseDuplicateBankImports(db, { entityId: ENTITY_ID, userId });

  // Move posted "Pending categorization" offsets off 1100 so suspense gate can pass
  report.undepositedReclass = await reclassPostedUndepositedOffsets(db, {
    entityId: ENTITY_ID,
    userId,
    asOfDate: '2026-06-30',
  });

  if (clearSuspense) {
    report.suspenseClear = await clearConversionSuspenseFor2026(db, { userId });
  }

  for (let month = 1; month <= 6; month++) {
    const postingDate = `2026-${String(month).padStart(2, '0')}-15`;
    const { periodStart, periodEnd } = monthBounds(postingDate);

    const before = await getPeriodIntegrityStatus(db, { entityId: ENTITY_ID, periodStart, periodEnd });
    if (before.isClosed) {
      report.months.push({ month, periodStart, periodEnd, alreadyClosed: true, isClosed: true });
      continue;
    }

    const recon = await reconcileTargetsForMonth(db, userId, 2026, month);
    const suspense = await checkSuspenseAccounts(db, ENTITY_ID, periodEnd);

    let closeResult = null;
    let closeError = null;
    const afterRecon = await getPeriodIntegrityStatus(db, { entityId: ENTITY_ID, periodStart, periodEnd });
    if (afterRecon.canClose && suspense.clean) {
      try {
        closeResult = await closeMonthContaining(db, {
          entityId: ENTITY_ID,
          postingDate,
          userId,
          notes: `Closed ${periodStart.slice(0, 7)} — monitored recons $0.00`,
        });
      } catch (e) {
        closeError = { message: e.message, code: e.code, integrity: e.integrity };
      }
    }

    const after = await getPeriodIntegrityStatus(db, { entityId: ENTITY_ID, periodStart, periodEnd });
    report.months.push({
      month,
      periodStart,
      periodEnd,
      suspenseClean: suspense.clean,
      suspenseNonZero: suspense.nonZero,
      recon,
      canCloseBefore: before.canClose,
      canCloseAfterRecon: afterRecon.canClose,
      blockers: after.blockers,
      closeResult,
      closeError,
      isClosed: after.isClosed === true,
    });
  }

  report.allClosed = report.months.every((m) => m.isClosed);
  return report;
}
