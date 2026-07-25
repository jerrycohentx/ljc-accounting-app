import express from 'express';
import { getDatabase } from '../config/database.js';
import { entityAccessMiddleware, requireRole } from '../middleware/auth.js';
import {
  listPeriods,
  closePeriod,
  reopenPeriod,
  closeMonthContaining,
  monthBounds,
} from '../lib/period-lock.js';
import { getPeriodIntegrityStatus } from '../lib/period-integrity.js';
import { previewOpeningBalances, postOpeningBalances, parseOpeningBalanceCsv } from '../lib/opening-balances.js';
import { previewYearEndClose, postYearEndClose } from '../lib/year-end-close.js';
import { runLonestarBalanceFixes } from '../lib/fix-lonestar-opening-balance.js';
import { checkSuspenseAccounts } from '../lib/suspense-check.js';
import { runCutoverYearClose } from '../lib/cutover-year-close.js';
import { closeH1_2026 } from '../lib/close-h1-2026.js';
import { clearConversionSuspenseFor2026 } from '../lib/clear-conversion-suspense.js';
import { reclassPostedUndepositedOffsets } from '../lib/reclass-posted-undeposited.js';
import { reclassPostedByLearnedRules } from '../lib/reclass-posted-by-rules.js';
import { learnCategorizationFromHistory } from '../lib/learn-categorization-from-history.js';
import { categorizeDumpForApproval } from '../lib/categorize-dump-for-approval.js';
import { buildCategorizationReview } from '../lib/categorization-review.js';
import { learnFromUserCategory } from '../lib/category-learn.js';
import {
  upsertVendorCategoryRule,
  listVendorCategoryRules,
  applyVendorRuleToOpenDrafts,
  postMatchingVendorDrafts,
  deriveVendorPattern,
} from '../lib/vendor-category-rule.js';
import { findDuplicateCatApprDrafts } from '../lib/cat-appr-dedupe.js';
import {
  applyWentworthTenantUtilityTreatment,
  WENTWORTH_UTIL_CONFIRM,
} from '../lib/wentworth-tenant-utilities.js';
import { reverseDuplicateBankImports } from '../lib/reverse-duplicate-bank-imports.js';
import {
  reclassOpeningBalanceEquity,
  previewReclassOpeningBalanceEquity,
} from '../lib/reclass-opening-balance-equity.js';
import {
  correctIvymountRentalMispost,
  IVYMOUNT_CORR_CONFIRM,
} from '../lib/correct-ivymount-rental-mispost.js';
import { repairOrphanReconciledInClosedPeriods } from '../lib/recon-cleared-integrity.js';
import { verifySessionClearedMatchesStatement } from '../lib/recon-cleared-integrity.js';
import {
  autoReconcileToTarget,
  reopenBankReconciliation,
  ensureBankReconSessionTables,
} from '../lib/bank-reconcile-session.js';
import { rebuildLonestarRecons } from '../lib/rebuild-lonestar-recons.js';
import { rebuildSimmonsRecons } from '../lib/rebuild-simmons-recons.js';
import { RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';
import { normalizeIsoDate } from '../lib/bank-statement-view.js';

const router = express.Router({ mergeParams: true });

// GET /api/entities/:entityId/accounting/periods
router.get('/periods', entityAccessMiddleware, async (req, res) => {
  try {
    const db = await getDatabase();
    const periods = await listPeriods(db, req.entityId);
    res.json({ data: periods });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/entities/:entityId/accounting/periods/integrity
 * Authoritative close / closable status. Agents MUST use this before claiming a month is closed.
 * Query: periodStart & periodEnd, or postingDate (calendar month), or year+month.
 */
router.get('/periods/integrity', entityAccessMiddleware, async (req, res) => {
  try {
    const db = await getDatabase();
    let { periodStart, periodEnd, postingDate, year, month } = req.query;

    if ((!periodStart || !periodEnd) && year && month) {
      const bounds = monthBounds(`${year}-${String(month).padStart(2, '0')}-15`);
      periodStart = bounds.periodStart;
      periodEnd = bounds.periodEnd;
    }

    const status = await getPeriodIntegrityStatus(db, {
      entityId: req.entityId,
      periodStart: periodStart || null,
      periodEnd: periodEnd || null,
      postingDate: postingDate || null,
    });
    res.json(status);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/entities/:entityId/accounting/suspense-check
// Zero-suspense gate (ledger-integrity guardrail): report any non-zero
// clearing/suspense/uncategorized account as of a date. Read-only.
router.get('/suspense-check', entityAccessMiddleware, async (req, res) => {
  try {
    const db = await getDatabase();
    const result = await checkSuspenseAccounts(db, req.entityId, req.query.asOf || null);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/accounting/periods/close
router.post('/periods/close', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const { periodStart, periodEnd, postingDate, notes } = req.body;
    const db = await getDatabase();

    // Zero-suspense gate: money must not be stranded in clearing/suspense accounts.
    // Hard bar — no force override.
    const suspenseAsOf = postingDate || periodEnd || null;
    const suspense = await checkSuspenseAccounts(db, req.entityId, suspenseAsOf);
    if (!suspense.clean) {
      return res.status(409).json({
        error: `Cannot close: $${suspense.totalAbs} stranded in ${suspense.nonZero.length} suspense/clearing account(s). Resolve them before closing.`,
        code: 'SUSPENSE_BLOCKED',
        suspense,
        isClosed: false,
      });
    }

    let result;
    if (postingDate) {
      result = await closeMonthContaining(db, {
        entityId: req.entityId,
        postingDate,
        userId: req.user.id,
        notes,
      });
    } else if (periodStart && periodEnd) {
      result = await closePeriod(db, {
        entityId: req.entityId,
        periodStart,
        periodEnd,
        userId: req.user.id,
        notes,
      });
    } else {
      return res.status(400).json({ error: 'Provide postingDate or periodStart and periodEnd' });
    }

    res.json({
      message: 'Period closed',
      suspense,
      ...result,
      isClosed: true,
    });
  } catch (error) {
    if (error.code === 'PERIOD_INTEGRITY_BLOCKED') {
      return res.status(409).json({
        error: error.message,
        code: error.code,
        integrity: error.integrity,
        isClosed: false,
      });
    }
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/accounting/periods/reopen
router.post('/periods/reopen', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const { periodStart, periodEnd } = req.body;
    if (!periodStart || !periodEnd) {
      return res.status(400).json({ error: 'periodStart and periodEnd required' });
    }
    const db = await getDatabase();
    const result = await reopenPeriod(db, {
      entityId: req.entityId,
      periodStart,
      periodEnd,
    });
    res.json({ message: 'Period reopened', ...result });
  } catch (error) {
    if (error.message.includes('not closed')) return res.status(409).json({ error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/entities/:entityId/accounting/reclass-opening-balance-equity/preview
 * Shows 3900 balance as of date and proposed Dr/Cr to Retained Earnings.
 */
router.get(
  '/reclass-opening-balance-equity/preview',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    try {
      const asOfDate = req.query.asOfDate || '2025-12-31';
      const db = await getDatabase();
      const preview = await previewReclassOpeningBalanceEquity(db, req.entityId, asOfDate);
      res.json(preview);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * POST /api/entities/:entityId/accounting/reclass-opening-balance-equity
 * Real equity reclass: 3900 Opening Balance Equity → 3100 Retained Earnings (or 3000).
 * Body: { confirm: "RECLASS-OBE-<entityId>-<asOfDate>", asOfDate?, targetAccountNumber?, reclose? }
 */
router.post(
  '/reclass-opening-balance-equity',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    try {
      const asOfDate = req.body?.asOfDate || '2025-12-31';
      const expected = `RECLASS-OBE-${req.entityId}-${asOfDate}`;
      if (req.body?.confirm !== expected) {
        return res.status(400).json({
          error: `confirm must equal "${expected}"`,
          code: 'CONFIRM_REQUIRED',
        });
      }
      const db = await getDatabase();
      const result = await reclassOpeningBalanceEquity(db, {
        entityId: req.entityId,
        asOfDate,
        userId: req.user.id,
        targetAccountNumber: req.body?.targetAccountNumber || '3100',
        reclose: req.body?.reclose !== false,
      });
      const status = result.skipped ? 200 : result.balance3900After === 0 ? 200 : 409;
      res.status(status).json({
        message: result.skipped
          ? '3900 already clear'
          : result.balance3900After === 0
            ? 'Opening Balance Equity reclassified to permanent equity'
            : 'Reclass posted but 3900 still non-zero — see response',
        ...result,
      });
    } catch (error) {
      if (error.code === 'PLUG_ENTRY_BLOCKED') {
        return res.status(403).json({ error: error.message, code: error.code });
      }
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * POST /api/entities/:entityId/accounting/repair-orphan-reconciled
 * Unmark RECONCILED GL rows with null session_id inside CLOSED recon periods
 * so Cleared Balance cannot be inflated past the statement.
 * Body: { accountId?: string }
 */
router.post(
  '/repair-orphan-reconciled',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    try {
      const db = await getDatabase();
      const result = await repairOrphanReconciledInClosedPeriods(db, {
        entityId: req.entityId,
        accountId: req.body?.accountId || null,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * GET /api/entities/:entityId/accounting/recon-session-diagnose?accountNumber=2010&statementDate=2026-01-09
 * Live Cleared vs statement for one closed session (debug / catch-up).
 */
router.get('/recon-session-diagnose', entityAccessMiddleware, async (req, res) => {
  try {
    const db = await getDatabase();
    await ensureBankReconSessionTables(db);
    const accountNumber = String(req.query.accountNumber || '').trim();
    const statementDate = normalizeIsoDate(req.query.statementDate);
    if (!accountNumber || !statementDate) {
      return res.status(400).json({ error: 'accountNumber and statementDate required' });
    }
    const account = await db.get(
      `SELECT id, account_number, account_name, normal_balance, account_type
       FROM accounts WHERE entity_id = ? AND account_number = ?`,
      [req.entityId, accountNumber]
    );
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const session = await db.get(
      `SELECT *
       FROM bank_reconciliation_sessions
       WHERE entity_id = ? AND account_id = ? AND statement_date = ?
       ORDER BY closed_at DESC NULLS LAST`,
      [req.entityId, account.id, statementDate]
    );
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const live = await verifySessionClearedMatchesStatement(db, session, account);
    const lineRows = await db.all(
      `SELECT gl.id, gl.posting_date, gl.debit, gl.credit, gl.description, je.je_number
       FROM bank_reconciliation_session_lines sl
       JOIN general_ledger gl ON gl.id = sl.gl_id
       LEFT JOIN journal_entries je ON je.id = gl.journal_entry_id
       WHERE sl.session_id = ?
         AND (je.id IS NULL OR je.status = 'POSTED')
       ORDER BY gl.posting_date, gl.id`,
      [session.id]
    );
    res.json({
      account,
      session: {
        id: session.id,
        status: session.status,
        statementDate: normalizeIsoDate(session.statement_date),
        beginningBalance: Number(session.beginning_balance),
        endingBalance: Number(session.ending_balance),
        clearedNet: Number(session.cleared_net),
        difference: Number(session.difference),
        notes: session.notes,
      },
      live,
      lineCount: (lineRows || []).length,
      lines: lineRows,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** In-memory status for long Simmons rebuilds (Render request timeout workaround). */
const simmonsRebuildJobs = new Map();

/**
 * POST /api/entities/:entityId/accounting/rebuild-simmons-recons
 * Reopen + rebuild Simmons (1000) from statement PDF lines.
 * January/February use statement dates 2026-02-01 / 2026-03-01 (not calendar month-end).
 * Body: { confirm: "REBUILD-SIMMONS-<entityId>", throughMonth?: "YYYY-MM", reopen?: boolean, async?: boolean }
 * Default async=true so Render proxy does not 502 mid-rebuild. Poll GET .../rebuild-simmons-recons/status
 */
router.post(
  '/rebuild-simmons-recons',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    try {
      const expected = `REBUILD-SIMMONS-${req.entityId}`;
      if (req.body?.confirm !== expected) {
        return res.status(400).json({
          error: `confirm must equal "${expected}"`,
          code: 'CONFIRM_REQUIRED',
        });
      }
      const throughMonth = req.body?.throughMonth || '2026-03';
      const reopen = req.body?.reopen !== false;
      const runAsync = req.body?.async !== false;
      const jobId = `simmons-${req.entityId}-${throughMonth}-${Date.now()}`;
      const job = {
        id: jobId,
        entityId: req.entityId,
        throughMonth,
        status: 'running',
        startedAt: new Date().toISOString(),
        result: null,
        error: null,
      };
      simmonsRebuildJobs.set(req.entityId, job);

      const run = async () => {
        try {
          const db = await getDatabase();
          const result = await rebuildSimmonsRecons(db, {
            entityId: req.entityId,
            userId: req.user.id,
            throughMonth,
            reopen,
          });
          job.status = 'done';
          job.finishedAt = new Date().toISOString();
          job.result = result;
        } catch (error) {
          job.status = 'error';
          job.finishedAt = new Date().toISOString();
          job.error = error.message;
        }
      };

      if (runAsync) {
        setImmediate(() => {
          run().catch((e) => {
            job.status = 'error';
            job.error = e.message;
            job.finishedAt = new Date().toISOString();
          });
        });
        return res.status(202).json({
          accepted: true,
          jobId,
          throughMonth,
          statusUrl: `/api/entities/${req.entityId}/accounting/rebuild-simmons-recons/status`,
        });
      }

      await run();
      if (job.status === 'error') return res.status(500).json({ error: job.error });
      return res.json(job.result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

router.get(
  '/rebuild-simmons-recons/status',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    const job = simmonsRebuildJobs.get(req.entityId);
    if (!job) return res.json({ status: 'none' });
    res.json(job);
  }
);

/**
 * POST /api/entities/:entityId/accounting/rebuild-lonestar-recons
 * Reopen + rebuild Lone Star (1001) from live statement lines (skip reversed JEs / OFX twins).
 * Body: { confirm: "REBUILD-LONESTAR-<entityId>", throughMonth?: "YYYY-MM", reopen?: boolean }
 */
router.post(
  '/rebuild-lonestar-recons',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    try {
      const expected = `REBUILD-LONESTAR-${req.entityId}`;
      if (req.body?.confirm !== expected) {
        return res.status(400).json({
          error: `confirm must equal "${expected}"`,
          code: 'CONFIRM_REQUIRED',
        });
      }
      const db = await getDatabase();
      const result = await rebuildLonestarRecons(db, {
        entityId: req.entityId,
        userId: req.user.id,
        throughMonth: req.body?.throughMonth || '2026-05',
        reopen: req.body?.reopen !== false,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * POST /api/entities/:entityId/accounting/rebuild-amex-recons
 * Reopen + auto-reconcile Amex (2010) for configured 2026 statement targets.
 * Body: { confirm: "REBUILD-AMEX-<entityId>", throughMonth?: "YYYY-MM", reopen?: boolean }
 * Default reopen=false — restores OPEN sessions that still hold begin/end balances.
 */
router.post(
  '/rebuild-amex-recons',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    try {
      const expected = `REBUILD-AMEX-${req.entityId}`;
      if (req.body?.confirm !== expected) {
        return res.status(400).json({
          error: `confirm must equal "${expected}"`,
          code: 'CONFIRM_REQUIRED',
        });
      }
      const db = await getDatabase();
      const throughMonth = req.body?.throughMonth || '2026-06';
      const doReopen = req.body?.reopen === true;
      const targets = (RECONCILIATION_TARGETS[req.entityId]?.['2010'] || []).filter((t) =>
        String(t.statementDate || '').slice(0, 7) <= throughMonth
      );
      const amex = await db.get(
        `SELECT id FROM accounts WHERE entity_id = ? AND account_number = '2010'`,
        [req.entityId]
      );
      if (!amex) return res.status(404).json({ error: 'Account 2010 not found' });

      // Drop cutover stubs ($0 ending) that poison period start / beginning.
      await db.run(
        `DELETE FROM bank_reconciliation_session_lines
         WHERE session_id IN (
           SELECT id FROM bank_reconciliation_sessions
           WHERE entity_id = ? AND account_id = ?
             AND statement_date < '2026-01-01'
             AND ABS(COALESCE(ending_balance, 0)) < 0.01
         )`,
        [req.entityId, amex.id]
      );
      await db.run(
        `DELETE FROM bank_reconciliation_sessions
         WHERE entity_id = ? AND account_id = ?
           AND statement_date < '2026-01-01'
           AND ABS(COALESCE(ending_balance, 0)) < 0.01`,
        [req.entityId, amex.id]
      );

      const reopenResults = [];
      if (doReopen) {
        for (const target of [...targets].reverse()) {
          try {
            const r = await reopenBankReconciliation(db, {
              entityId: req.entityId,
              accountId: amex.id,
              statementDate: target.statementDate,
            });
            reopenResults.push({ statementDate: target.statementDate, ...r });
          } catch (e) {
            reopenResults.push({ statementDate: target.statementDate, reopenError: e.message });
          }
        }
      }

      const results = [];
      let prevStatementDate = '2025-12-09'; // Amex Jan cycle starts after prior stmt close
      for (const target of targets) {
        const open = await db.get(
          `SELECT beginning_balance, ending_balance FROM bank_reconciliation_sessions
           WHERE entity_id = ? AND account_id = ? AND statement_date = ?`,
          [req.entityId, amex.id, target.statementDate]
        );
        const r = await autoReconcileToTarget(db, {
          entityId: req.entityId,
          accountNumber: '2010',
          statementDate: target.statementDate,
          endingBalance: target.endingBalance,
          userId: req.user.id,
          notes: open?.notes || `Rebuild Amex recon ${target.statementDate}`,
          clearedAfterDate: prevStatementDate,
          beginningBalanceOverride:
            open && Math.abs(Number(open.beginning_balance) || 0) >= 0.01
              ? Number(open.beginning_balance)
              : null,
        });
        results.push(r);
        if (r.reconciled) prevStatementDate = target.statementDate;
      }
      res.json({ throughMonth, reopen: doReopen, reopenResults, results });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * POST /api/entities/:entityId/accounting/correct-ivymount-rental-mispost
 * Dr 4100 / Cr 1901 $215,000 — Ivymount REO conveyance wrongly booked as rent.
 * Body: { confirm: "CORR-IVYMOUNT-215K-<entityId>", reclose? }
 */
router.post(
  '/correct-ivymount-rental-mispost',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    try {
      const expected = IVYMOUNT_CORR_CONFIRM(req.entityId);
      if (req.body?.confirm !== expected) {
        return res.status(400).json({
          error: `confirm must equal "${expected}"`,
          code: 'CONFIRM_REQUIRED',
        });
      }
      const db = await getDatabase();
      const result = await correctIvymountRentalMispost(db, {
        entityId: req.entityId,
        userId: req.user.id,
        reclose: req.body?.reclose !== false,
      });
      res.json({
        message: result.skipped
          ? 'Ivymount correction already posted'
          : 'Ivymount $215k removed from rental income and posted to Due from Justin Financial',
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// GET /api/entities/:entityId/accounting/periods/bounds?date=YYYY-MM-DD
router.get('/periods/bounds', entityAccessMiddleware, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date query param required' });
  res.json(monthBounds(date));
});

// POST /api/entities/:entityId/accounting/opening-balances/preview
router.post('/opening-balances/preview', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const { asOfDate, balances, csv } = req.body;
    if (!asOfDate) return res.status(400).json({ error: 'asOfDate required' });

    let rows = balances;
    if (csv && typeof csv === 'string') {
      rows = parseOpeningBalanceCsv(csv);
    }
    if (!rows?.length) return res.status(400).json({ error: 'balances array or csv text required' });

    const db = await getDatabase();
    const preview = await previewOpeningBalances(db, req.entityId, { asOfDate, balances: rows });
    res.json(preview);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/accounting/opening-balances
router.post('/opening-balances', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const { asOfDate, balances, csv, memo } = req.body;
    if (!asOfDate) return res.status(400).json({ error: 'asOfDate required' });

    let rows = balances;
    if (csv && typeof csv === 'string') {
      rows = parseOpeningBalanceCsv(csv);
    }
    if (!rows?.length) return res.status(400).json({ error: 'balances array or csv text required' });

    const db = await getDatabase();
    const result = await postOpeningBalances(db, {
      entityId: req.entityId,
      asOfDate,
      balances: rows,
      userId: req.user.id,
      memo,
    });
    res.status(201).json({ message: 'Opening balances posted', ...result });
  } catch (error) {
    if (/already posted|closed period/i.test(error.message)) {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

// GET /api/entities/:entityId/accounting/year-end/preview?asOfDate=YYYY-MM-DD
router.get('/year-end/preview', entityAccessMiddleware, async (req, res) => {
  try {
    const { asOfDate } = req.query;
    if (!asOfDate) return res.status(400).json({ error: 'asOfDate required' });
    const db = await getDatabase();
    const preview = await previewYearEndClose(db, req.entityId, asOfDate);
    res.json(preview);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/accounting/year-end/close
router.post('/year-end/close', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const { asOfDate, memo } = req.body;
    if (!asOfDate) return res.status(400).json({ error: 'asOfDate required' });
    const db = await getDatabase();
    const result = await postYearEndClose(db, {
      entityId: req.entityId,
      asOfDate,
      userId: req.user.id,
      memo,
    });
    res.json({ message: result.posted ? 'Year-end close posted' : result.message, ...result });
  } catch (error) {
    if (/already posted|closed period/i.test(error.message)) {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/entities/:entityId/accounting/cutover-year-close
 * Full cutover-year close: $0 dormant-month recons → YEC → period close.
 * Body: { year: 2025, confirm: "CLOSE-2025-<entityId>", memo? }
 */
router.post('/cutover-year-close', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const year = Number(req.body?.year);
    const confirm = req.body?.confirm;
    const expected = `CLOSE-${year}-${req.entityId}`;
    if (!year || confirm !== expected) {
      return res.status(400).json({
        error: `confirm must equal "${expected}"`,
        code: 'CONFIRM_REQUIRED',
      });
    }
    const db = await getDatabase();
    const result = await runCutoverYearClose(db, {
      entityId: req.entityId,
      year,
      userId: req.user.id,
      memo: req.body?.memo || null,
    });
    if (!result.isClosed) {
      return res.status(409).json({
        error: 'Cutover close ran but integrity isClosed is still false',
        code: 'PERIOD_INTEGRITY_BLOCKED',
        ...result,
      });
    }
    res.json({ message: `${year} closed`, ...result });
  } catch (error) {
    if (error.code === 'SUSPENSE_BLOCKED' || error.code === 'RECON_BLOCKED' || error.code === 'PERIOD_INTEGRITY_BLOCKED') {
      return res.status(409).json({
        error: error.message,
        code: error.code,
        suspense: error.suspense,
        detail: error.detail,
        integrity: error.integrity,
      });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/entities/:entityId/accounting/clear-conversion-suspense
 * Clear stale 1100/1021 conversion clearing as of 2026-01-01 (LJC).
 * Body: { confirm: "CLEAR-SUSPENSE-<entityId>" }
 */
router.post('/clear-conversion-suspense', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    if (req.entityId !== 'ent-ljc') {
      return res.status(400).json({ error: 'Only implemented for ent-ljc' });
    }
    const expected = `CLEAR-SUSPENSE-${req.entityId}`;
    if (req.body?.confirm !== expected) {
      return res.status(400).json({ error: `confirm must equal "${expected}"`, code: 'CONFIRM_REQUIRED' });
    }
    const db = await getDatabase();
    const result = await clearConversionSuspenseFor2026(db, { userId: req.user.id });
    res.json({ message: result.cleanForH1 ? 'Suspense cleared for H1 2026' : 'Suspense clear ran but still dirty', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/entities/:entityId/accounting/reclass-undeposited
 * Reclass posted IMP-* offsets out of 1100 using categorization rules.
 * Body: { confirm: "RECLASS-1100-<entityId>", dryRun?: boolean }
 */
router.post('/reclass-undeposited', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    if (req.entityId !== 'ent-ljc') {
      return res.status(400).json({ error: 'Only implemented for ent-ljc' });
    }
    const expected = `RECLASS-1100-${req.entityId}`;
    if (req.body?.confirm !== expected) {
      return res.status(400).json({ error: `confirm must equal "${expected}"`, code: 'CONFIRM_REQUIRED' });
    }
    const db = await getDatabase();
    const result = await reclassPostedUndepositedOffsets(db, {
      userId: req.user.id,
      dryRun: !!req.body?.dryRun,
    });
    res.json({ message: result.clean ? '1100 cleared' : '1100 reclass ran', ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/entities/:entityId/accounting/learn-categorization-from-history
 * Seed merchant rules + learn from correctly coded posted AMEX/IMP lines.
 * Body: { confirm: "LEARN-CAT-<entityId>", startDate?, endDate? }
 */
router.post(
  '/learn-categorization-from-history',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    try {
      if (req.entityId !== 'ent-ljc') {
        return res.status(400).json({ error: 'Only implemented for ent-ljc' });
      }
      const expected = `LEARN-CAT-${req.entityId}`;
      if (req.body?.confirm !== expected) {
        return res.status(400).json({ error: `confirm must equal "${expected}"`, code: 'CONFIRM_REQUIRED' });
      }
      const db = await getDatabase();
      const result = await learnCategorizationFromHistory(db, {
        entityId: req.entityId,
        startDate: req.body?.startDate || '2026-01-01',
        endDate: req.body?.endDate || '2026-06-30',
      });
      res.json({ message: 'Learned categorization rules from history', ...result });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * POST /api/entities/:entityId/accounting/reclass-by-learned-rules
 * Append-only reclass dump expense (5700) onto accounts assigned by learned rules.
 * Reopens closed months as needed and recloses when canClose.
 * Body: { confirm: "RECLASS-RULES-<entityId>", dryRun?, startDate?, endDate?, sourceAccounts?, reclose? }
 */

/**
 * GET /api/entities/:entityId/accounting/categorization-review
 * Draft categorizations grouped by feed type then month, with statement-style
 * display fields for the review UI.
 */
router.get(
  '/categorization-review',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    try {
      const db = await getDatabase();
      const result = await buildCategorizationReview(db, {
        entityId: req.entityId,
        limit: Math.min(parseInt(req.query.limit, 10) || 1000, 2000),
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * POST /api/entities/:entityId/accounting/categorization-review/:draftId/category
 * Change the expense account on a categorization draft and learn a durable rule.
 * Body: { accountId }
 */
router.post(
  '/categorization-review/:draftId/category',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    try {
      const db = await getDatabase();
      const draftId = req.params.draftId;
      const accountId = req.body?.accountId;
      if (!accountId) return res.status(400).json({ error: 'accountId required' });

      const draft = await db.get(
        'SELECT * FROM journal_entries WHERE id = ? AND entity_id = ?',
        [draftId, req.entityId]
      );
      if (!draft) return res.status(404).json({ error: 'Draft not found' });
      if (draft.status !== 'DRAFT') {
        return res.status(409).json({ error: 'Only draft entries can be recategorized here' });
      }

      const target = await db.get(
        'SELECT id, account_number, account_name FROM accounts WHERE id = ? AND entity_id = ?',
        [accountId, req.entityId]
      );
      if (!target) return res.status(404).json({ error: 'Account not found' });

      const lines = await db.all(
        'SELECT jel.*, a.account_number FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id WHERE jel.journal_entry_id = ? ORDER BY jel.line_number',
        [draftId]
      );
      // CAT-APPR: debit line is the category; credit clears the dump/source.
      const categoryLine = lines.find((l) => Number(l.debit) > 0) || lines[0];
      if (!categoryLine) {
        return res.status(400).json({ error: 'Could not find the category line on this draft' });
      }

      await db.run('UPDATE journal_entry_lines SET account_id = ? WHERE id = ?', [
        accountId,
        categoryLine.id,
      ]);

      const srcMatch = String(draft.memo || '').match(/cat-approve:(je-[a-f0-9-]+)/i);
      let learnDesc = draft.description || '';
      if (srcMatch) {
        const src = await db.get(
          'SELECT description, memo FROM journal_entries WHERE id = ? AND entity_id = ?',
          [srcMatch[1], req.entityId]
        );
        if (src?.description) learnDesc = src.description;
      }
      await learnFromUserCategory(db, {
        entityId: req.entityId,
        description: learnDesc,
        offsetAccountId: accountId,
      });

      res.json({
        ok: true,
        categoryAccountId: target.id,
        categoryAccountNumber: target.account_number,
        categoryAccountName: target.account_name,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * GET /api/entities/:entityId/accounting/vendor-category-rules
 * List active bank_categorization_rules (vendor → account).
 */
router.get(
  '/vendor-category-rules',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    try {
      const db = await getDatabase();
      const rules = await listVendorCategoryRules(db, { entityId: req.entityId });
      res.json({ entityId: req.entityId, count: rules.length, rules });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * POST /api/entities/:entityId/accounting/vendor-category-rule
 * Create/update a durable vendor rule, apply to open drafts, and (by default) post them.
 * Body: { pattern?, accountId, label?, description?, matchType?, applyToOpenDrafts?, postMatchingDrafts? }
 */
router.post(
  '/vendor-category-rule',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    try {
      const db = await getDatabase();
      const { pattern, accountId, label, description, matchType } = req.body || {};
      // Always apply to open review drafts unless explicitly opted out.
      const applyToOpenDrafts = req.body?.applyToOpenDrafts !== false;
      // Default: post every matching open draft so they leave Review & Approve.
      const postMatching = req.body?.postMatchingDrafts !== false;
      if (!accountId) return res.status(400).json({ error: 'accountId required' });

      const rule = await upsertVendorCategoryRule(db, {
        entityId: req.entityId,
        pattern,
        accountId,
        label,
        description,
        matchType,
        priority: 4,
      });

      let draftUpdate = null;
      let postResult = null;
      if (applyToOpenDrafts || postMatching) {
        draftUpdate = await applyVendorRuleToOpenDrafts(db, {
          entityId: req.entityId,
          pattern: rule.pattern,
          accountId: rule.accountId,
          matchType: rule.matchType,
        });
      }
      if (postMatching && draftUpdate?.matchedIds?.length) {
        postResult = await postMatchingVendorDrafts(db, {
          entityId: req.entityId,
          pattern: rule.pattern,
          accountId: rule.accountId,
          matchType: rule.matchType,
          userId: req.user?.id,
          draftIds: draftUpdate.matchedIds,
        });
      }

      res.json({
        ok: true,
        rule,
        suggestedPattern: description ? deriveVendorPattern(description) : null,
        draftUpdate,
        postResult,
        appliedToOpenDrafts: applyToOpenDrafts,
        postedMatchingDrafts: postMatching,
      });
    } catch (error) {
      const status = /required|not found|min 3/i.test(error.message) ? 400 : 500;
      res.status(status).json({ error: error.message });
    }
  }
);

/**
 * POST /api/entities/:entityId/accounting/cleanup-duplicate-cat-appr-drafts
 * Delete extra DRAFT CAT-APPR journals for the same source (keep earliest).
 * Body: { confirm: "DEDUP-CAT-APPR-<entityId>", dryRun? }
 */
router.post(
  '/cleanup-duplicate-cat-appr-drafts',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    try {
      const expected = `DEDUP-CAT-APPR-${req.entityId}`;
      if (req.body?.confirm !== expected) {
        return res.status(400).json({
          error: `confirm must equal "${expected}"`,
          code: 'CONFIRM_REQUIRED',
        });
      }
      const db = await getDatabase();
      const found = await findDuplicateCatApprDrafts(db, { entityId: req.entityId });
      if (req.body?.dryRun) {
        return res.json({
          dryRun: true,
          totalDrafts: found.totalDrafts,
          duplicateGroups: found.groups.length,
          wouldDelete: found.deleteIds.length,
          deleteIds: found.deleteIds,
          groups: found.groups.slice(0, 50),
        });
      }
      if (!found.deleteIds.length) {
        return res.json({
          deleted: 0,
          totalDrafts: found.totalDrafts,
          message: 'No duplicate CAT-APPR drafts found',
        });
      }

      const deleted = [];
      // delete-journal-entries caps at 50 — batch
      for (let i = 0; i < found.deleteIds.length; i += 50) {
        const batch = found.deleteIds.slice(i, i + 50);
        const owned = await db.all(
          `SELECT id, je_number, status, memo FROM journal_entries
           WHERE entity_id = ? AND id IN (${batch.map(() => '?').join(',')})`,
          [req.entityId, ...batch]
        );
        const safe = owned.filter(
          (r) => r.status === 'DRAFT'
            && String(r.je_number || '').startsWith('CAT-APPR-')
            && /cat-approve:/i.test(String(r.memo || ''))
        );
        if (!safe.length) continue;
        const ids = safe.map((r) => r.id);
        const ph = ids.map(() => '?').join(',');
        const safeRun = async (sql, params) => {
          try { await db.run(sql, params); } catch { /* table may not exist */ }
        };
        await safeRun(`DELETE FROM journal_entry_documents WHERE journal_entry_id IN (${ph})`, ids);
        await safeRun(`DELETE FROM journal_entry_lines WHERE journal_entry_id IN (${ph})`, ids);
        await safeRun(`DELETE FROM general_ledger WHERE journal_entry_id IN (${ph})`, ids);
        await db.run(
          `DELETE FROM journal_entries WHERE entity_id = ? AND status = 'DRAFT' AND id IN (${ph})`,
          [req.entityId, ...ids]
        );
        deleted.push(...safe);
      }

      res.json({
        deleted: deleted.length,
        totalDraftsBefore: found.totalDrafts,
        remainingEstimate: found.totalDrafts - deleted.length,
        deletedEntries: deleted.map((r) => ({ id: r.id, jeNumber: r.je_number })),
        groups: found.groups.length,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * POST /api/entities/:entityId/accounting/categorize-dump-for-approval
 * Find uncategorized dump-account lines (default 5700/4091), attach statement PDFs,
 * and create DRAFT reclass journals (CAT-APPR-*) for Jerry to approve.
 * Body: { confirm: "CAT-APPROVE-<entityId>", dryRun?, startDate?, endDate?, sourceAccounts? }
 */
router.post(
  '/categorize-dump-for-approval',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    try {
      if (req.entityId !== 'ent-ljc') {
        return res.status(400).json({ error: 'Only implemented for ent-ljc' });
      }
      const expected = `CAT-APPROVE-${req.entityId}`;
      if (req.body?.confirm !== expected) {
        return res.status(400).json({ error: `confirm must equal "${expected}"`, code: 'CONFIRM_REQUIRED' });
      }
      const db = await getDatabase();
      const sourceAccounts = Array.isArray(req.body?.sourceAccounts)
        ? req.body.sourceAccounts.map(String)
        : undefined;
      const result = await categorizeDumpForApproval(db, {
        entityId: req.entityId,
        userId: req.user.id,
        dryRun: !!req.body?.dryRun,
        startDate: req.body?.startDate || '2026-01-01',
        endDate: req.body?.endDate || '2026-12-31',
        sourceAccountNumbers: sourceAccounts,
        learnFirst: req.body?.learnFirst !== false,
        attachDocuments: req.body?.attachDocuments !== false,
        createDrafts: req.body?.createDrafts !== false,
      });
      res.json({
        message: result.dryRun
          ? `Dry run: ${result.proposedCount} categorizable, ${result.needsReviewCount} still need a rule`
          : `Created ${result.draftsCreated} draft categorization(s); ${result.needsReviewCount} still need review; attached ${result.documentsAttached} source PDF(s)`,
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

router.post(
  '/reclass-by-learned-rules',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    try {
      if (req.entityId !== 'ent-ljc') {
        return res.status(400).json({ error: 'Only implemented for ent-ljc' });
      }
      const expected = `RECLASS-RULES-${req.entityId}`;
      if (req.body?.confirm !== expected) {
        return res.status(400).json({ error: `confirm must equal "${expected}"`, code: 'CONFIRM_REQUIRED' });
      }
      const db = await getDatabase();
      const sourceAccounts = Array.isArray(req.body?.sourceAccounts)
        ? req.body.sourceAccounts.map(String)
        : undefined;
      const result = await reclassPostedByLearnedRules(db, {
        entityId: req.entityId,
        userId: req.user.id,
        dryRun: !!req.body?.dryRun,
        startDate: req.body?.startDate || '2026-01-01',
        endDate: req.body?.endDate || '2026-03-31',
        sourceAccountNumbers: sourceAccounts,
        reclose: req.body?.reclose !== false,
        learnFirst: req.body?.learnFirst !== false,
      });
      res.json({
        message: result.dryRun
          ? `Dry run: would reclass ${result.reclassed} of ${result.scanned}`
          : `Reclassified ${result.reclassed} of ${result.scanned}`,
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * POST /api/entities/:entityId/accounting/wentworth-tenant-utilities
 * Mark Wentworth gas/electric/water/internet as tenant-reimbursable assets (not P&L),
 * and move Comcast/Xfinity off office internet expense onto 6254.
 * Body: { confirm: "WENTWORTH-UTIL-<entityId>", dryRun?, startDate?, endDate?, reclose? }
 */
router.post(
  '/wentworth-tenant-utilities',
  [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')],
  async (req, res) => {
    try {
      if (req.entityId !== 'ent-ljc') {
        return res.status(400).json({ error: 'Only implemented for ent-ljc' });
      }
      const expected = WENTWORTH_UTIL_CONFIRM(req.entityId);
      if (req.body?.confirm !== expected) {
        return res.status(400).json({ error: `confirm must equal "${expected}"`, code: 'CONFIRM_REQUIRED' });
      }
      const db = await getDatabase();
      const result = await applyWentworthTenantUtilityTreatment(db, {
        entityId: req.entityId,
        userId: req.user.id,
        dryRun: !!req.body?.dryRun,
        startDate: req.body?.startDate || '2026-01-01',
        endDate: req.body?.endDate || '2026-06-30',
        reclose: req.body?.reclose !== false,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * POST /api/entities/:entityId/accounting/reverse-duplicate-bank-imports
 * Reverse JE twins that duplicate IMP/AMEX bank lines (H1 2026).
 * Body: { confirm: "DEDUPE-BANK-<entityId>", dryRun?: boolean }
 */
router.post('/reverse-duplicate-bank-imports', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    if (req.entityId !== 'ent-ljc') {
      return res.status(400).json({ error: 'Only implemented for ent-ljc' });
    }
    const expected = `DEDUPE-BANK-${req.entityId}`;
    if (req.body?.confirm !== expected) {
      return res.status(400).json({ error: `confirm must equal "${expected}"`, code: 'CONFIRM_REQUIRED' });
    }
    const db = await getDatabase();
    const result = await reverseDuplicateBankImports(db, {
      userId: req.user.id,
      dryRun: !!req.body?.dryRun,
    });
    res.json({ message: `Reversed ${result.reversedCount} duplicate(s)`, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/entities/:entityId/accounting/close-h1-2026
 * Clear suspense (optional), auto-reconcile targets, close Jan–Jun 2026.
 * Body: { confirm: "CLOSE-H1-2026-<entityId>", clearSuspense?: true }
 */
router.post('/close-h1-2026', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    if (req.entityId !== 'ent-ljc') {
      return res.status(400).json({ error: 'Only implemented for ent-ljc' });
    }
    const expected = `CLOSE-H1-2026-${req.entityId}`;
    if (req.body?.confirm !== expected) {
      return res.status(400).json({ error: `confirm must equal "${expected}"`, code: 'CONFIRM_REQUIRED' });
    }
    const db = await getDatabase();
    const result = await closeH1_2026(db, {
      userId: req.user.id,
      clearSuspense: req.body?.clearSuspense !== false,
      runImports: req.body?.runImports !== false,
    });
    const status = result.allClosed ? 200 : 409;
    res.status(status).json({
      message: result.allClosed ? 'Jan–Jun 2026 all closed' : 'H1 close incomplete — see months[].blockers',
      ...result,
    });
  } catch (error) {
    if (error.code === 'PERIOD_INTEGRITY_BLOCKED' || error.code === 'SUSPENSE_BLOCKED') {
      return res.status(409).json({ error: error.message, code: error.code, integrity: error.integrity, suspense: error.suspense });
    }
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/accounting/lonestar/fix-opening-balance
router.post('/lonestar/fix-opening-balance', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const db = await getDatabase();
    const result = await runLonestarBalanceFixes(db, { userId: req.user.id });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/accounting/purge
// DESTRUCTIVE: wipes ALL journal entries, GL, import rows and reconciliation artifacts for the
// entity so its ledger can be rebuilt cleanly from reconciled opening balances + a fresh import.
// Requires body.confirm === `PURGE-<entityId>`. PRESERVES chart of accounts, audit_logs, plaid_items.
router.post('/purge', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const e = req.entityId;
    const { confirm } = req.body || {};
    if (confirm !== `PURGE-${e}`) {
      return res.status(400).json({ error: `confirm must equal "PURGE-${e}"` });
    }
    const db = await getDatabase();
    const counts = {};
    const run = async (label, sql, params = []) => {
      try {
        const r = await db.run(sql, params);
        counts[label] = (r && (r.changes ?? r.rowCount)) ?? 'ok';
      } catch (err) {
        counts[label] = `skip: ${String(err.message).slice(0, 70)}`;
      }
    };
    // child / referencing rows first (FK-safe); journal_entry_lines cascades on JE delete
    await run('reconciliation_matches',
      `DELETE FROM reconciliation_matches
        WHERE gl_entry_id IN (SELECT id FROM general_ledger WHERE entity_id = ?)
           OR import_transaction_id IN (SELECT id FROM import_transactions WHERE entity_id = ?)`, [e, e]);
    await run('holdback_disbursements', 'DELETE FROM holdback_disbursements WHERE entity_id = ?', [e]);
    await run('captured_documents', 'DELETE FROM captured_documents WHERE entity_id = ?', [e]);
    await run('journal_entry_documents',
      'DELETE FROM journal_entry_documents WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE entity_id = ?)', [e]);
    await run('mgmt_report_imports',
      'DELETE FROM mgmt_report_imports WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE entity_id = ?)', [e]);
    await run('import_transactions', 'DELETE FROM import_transactions WHERE entity_id = ?', [e]);
    await run('general_ledger', 'DELETE FROM general_ledger WHERE entity_id = ?', [e]);
    await run('bank_reconciliation_session_lines', 'DELETE FROM bank_reconciliation_session_lines WHERE entity_id = ?', [e]);
    await run('bank_reconciliation_sessions', 'DELETE FROM bank_reconciliation_sessions WHERE entity_id = ?', [e]);
    await run('reconciliations', 'DELETE FROM reconciliations WHERE entity_id = ?', [e]);
    await run('email_import_log', 'DELETE FROM email_import_log WHERE entity_id = ?', [e]);
    // parent last — journal_entry_lines removed via ON DELETE CASCADE
    await run('journal_entries', 'DELETE FROM journal_entries WHERE entity_id = ?', [e]);
    res.json({ message: `Purged ledger for ${e}`, counts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/accounting/delete-journal-entries
// Targeted, FK-safe hard delete of a specific list of journal entries (and their
// GL lines, JE lines, bank import rows, match + session-line records) for this
// entity. Used to remove erroneous duplicate entries. Capped and entity-scoped.
router.post('/delete-journal-entries', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const e = req.entityId;
    const { journalEntryIds, draftCatApprOnly } = req.body || {};
    if (!Array.isArray(journalEntryIds) || journalEntryIds.length === 0) {
      return res.status(400).json({ error: 'journalEntryIds[] required' });
    }
    if (journalEntryIds.length > 50) {
      return res.status(400).json({ error: 'refusing to delete more than 50 entries in one call' });
    }
    const db = await getDatabase();
    // Only operate on entries that actually belong to this entity.
    const inPh = journalEntryIds.map(() => '?').join(',');
    let owned = await db.all(
      `SELECT id, je_number, description, status, memo FROM journal_entries WHERE entity_id = ? AND id IN (${inPh})`,
      [e, ...journalEntryIds]
    );
    if (draftCatApprOnly) {
      owned = owned.filter(
        (r) => r.status === 'DRAFT'
          && String(r.je_number || '').startsWith('CAT-APPR-')
          && /cat-approve:/i.test(String(r.memo || ''))
      );
    }
    const ids = owned.map((r) => r.id);
    if (ids.length === 0) return res.status(404).json({ error: 'no matching journal entries for this entity' });
    const ph = ids.map(() => '?').join(',');
    const counts = {};
    const run = async (label, sql, params = []) => {
      try {
        const r = await db.run(sql, params);
        counts[label] = (r && (r.changes ?? r.rowCount)) ?? 'ok';
      } catch (err) {
        counts[label] = `skip: ${String(err.message).slice(0, 80)}`;
      }
    };
    await run('reconciliation_matches',
      `DELETE FROM reconciliation_matches
        WHERE gl_entry_id IN (SELECT id FROM general_ledger WHERE journal_entry_id IN (${ph}))
           OR import_transaction_id IN (SELECT id FROM import_transactions WHERE journal_entry_id IN (${ph}))`,
      [...ids, ...ids]);
    await run('bank_reconciliation_session_lines',
      `DELETE FROM bank_reconciliation_session_lines WHERE gl_id IN (SELECT id FROM general_ledger WHERE journal_entry_id IN (${ph}))`, ids);
    await run('journal_entry_documents', `DELETE FROM journal_entry_documents WHERE journal_entry_id IN (${ph})`, ids);
    await run('journal_entry_lines', `DELETE FROM journal_entry_lines WHERE journal_entry_id IN (${ph})`, ids);
    await run('general_ledger', `DELETE FROM general_ledger WHERE journal_entry_id IN (${ph})`, ids);
    await run('import_transactions', `DELETE FROM import_transactions WHERE journal_entry_id IN (${ph})`, ids);
    await run('journal_entries', `DELETE FROM journal_entries WHERE entity_id = ? AND id IN (${ph})`, [e, ...ids]);
    res.json({ message: `Deleted ${ids.length} journal entr(ies) for ${e}`, deleted: owned, counts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
