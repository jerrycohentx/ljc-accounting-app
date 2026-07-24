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
import { reverseDuplicateBankImports } from '../lib/reverse-duplicate-bank-imports.js';

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
router.post('/periods/reopen', [entityAccessMiddleware, requireRole('ADMIN')], async (req, res) => {
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
    const { journalEntryIds } = req.body || {};
    if (!Array.isArray(journalEntryIds) || journalEntryIds.length === 0) {
      return res.status(400).json({ error: 'journalEntryIds[] required' });
    }
    if (journalEntryIds.length > 50) {
      return res.status(400).json({ error: 'refusing to delete more than 50 entries in one call' });
    }
    const db = await getDatabase();
    // Only operate on entries that actually belong to this entity.
    const inPh = journalEntryIds.map(() => '?').join(',');
    const owned = await db.all(
      `SELECT id, je_number, description FROM journal_entries WHERE entity_id = ? AND id IN (${inPh})`,
      [e, ...journalEntryIds]
    );
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
    await run('general_ledger', `DELETE FROM general_ledger WHERE journal_entry_id IN (${ph})`, ids);
    await run('import_transactions', `DELETE FROM import_transactions WHERE journal_entry_id IN (${ph})`, ids);
    await run('journal_entries', `DELETE FROM journal_entries WHERE entity_id = ? AND id IN (${ph})`, [e, ...ids]);
    res.json({ message: `Deleted ${ids.length} journal entr(ies) for ${e}`, deleted: owned, counts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
