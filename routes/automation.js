import express from 'express';
import { getDatabase } from '../config/database.js';
import { LJC_ENTITY_ID } from '../lib/ach-je-import.js';
import { runAchJeInboxScan, getAchJeInboxScanStatus } from '../lib/ach-je-inbox-worker.js';
import { listLoanTrackerEvents } from '../lib/loan-event-ingest.js';
import { buildPlatformHealthPayload } from '../lib/platform-health.js';
import { loadAutomationManifest } from '../lib/automation-manifest.js';
import { requireRole } from '../middleware/auth.js';

const router = express.Router();

router.get('/manifest', (_req, res) => {
  res.json(loadAutomationManifest());
});

router.get('/status', async (req, res) => {
  try {
    const db = await getDatabase();
    res.json({
      achJeInboxScan: getAchJeInboxScanStatus(),
      loanEventsPending: (await listLoanTrackerEvents(db, { limit: 5 })).length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/loan-events', requireRole('ADMIN', 'ACCOUNTANT'), async (req, res) => {
  try {
    const db = await getDatabase();
    const events = await listLoanTrackerEvents(db, {
      entityId: req.query.entityId || LJC_ENTITY_ID,
      status: req.query.status || 'PENDING',
      limit: Number(req.query.limit || 50),
    });
    res.json({ events });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cleanup for Jerry's gross-only rule (2026-07-16): the loan-event receiver
// records events without drafting journal entries, and any LN- drafts pushed
// before that change are per-loan detail that must not reach the books.
// Deletes DRAFT entries only; posted entries are never touched.
router.delete('/loan-event-drafts', requireRole('ADMIN', 'ACCOUNTANT'), async (req, res) => {
  try {
    const db = await getDatabase();
    const entityId = req.query.entityId || LJC_ENTITY_ID;
    const drafts = await db.all(
      "SELECT id, je_number FROM journal_entries WHERE entity_id = ? AND status = 'DRAFT' AND je_number LIKE 'LN-%'",
      [entityId]
    );
    for (const d of drafts) {
      await db.run('DELETE FROM journal_entry_lines WHERE journal_entry_id = ?', d.id);
      try {
        await db.run(
          "UPDATE loan_tracker_events SET journal_entry_id = NULL, status = 'PENDING' WHERE journal_entry_id = ?",
          d.id
        );
      } catch { /* loan_tracker_events may not exist yet — non-fatal */ }
      await db.run("DELETE FROM journal_entries WHERE id = ? AND status = 'DRAFT'", d.id);
    }
    res.json({ deleted: drafts.length, jeNumbers: drafts.map((d) => d.je_number) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cleanup for the reconcile-screen auto-post incident (2026-07-16): before the
// lines-only fix deployed, opening the reconcile screen imported the folder OFX
// and auto-POSTED 42 "Reconcile: <file>:" entries spanning Mar–Jun (10 exact
// duplicates of the reviewed March entries, 32 never-reviewed Apr–Jun posts).
// Deletes ONLY entries carrying that signature: je_number in the given IMP-
// batch prefix AND description starting "Reconcile: ". Statement lines are
// KEPT — their journal link is nulled so they stay available for reconciling.
router.delete('/reconcile-autoposted', requireRole('ADMIN', 'ACCOUNTANT'), async (req, res) => {
  try {
    const prefix = String(req.query.jeNumberPrefix || '').trim();
    if (!/^IMP-\d{6,}$/.test(prefix)) {
      return res.status(400).json({ error: 'jeNumberPrefix required, e.g. IMP-1784219' });
    }
    const db = await getDatabase();
    const entityId = req.query.entityId || LJC_ENTITY_ID;
    const rows = await db.all(
      `SELECT id, je_number, posting_date, total_debit, description FROM journal_entries
       WHERE entity_id = ? AND je_number LIKE ? AND description LIKE 'Reconcile: %'`,
      [entityId, `${prefix}%`]
    );
    let linesKept = 0;
    for (const r of rows) {
      const upd = await db.run(
        "UPDATE import_transactions SET journal_entry_id = NULL, status = 'DRAFT' WHERE journal_entry_id = ?",
        r.id
      );
      linesKept += upd?.changes || 0;
      await db.run('DELETE FROM journal_entry_lines WHERE journal_entry_id = ?', r.id);
      await db.run('DELETE FROM journal_entry_documents WHERE journal_entry_id = ?', r.id);
      // Posted entries also carry general_ledger rows (the FK that blocks a bare delete).
      await db.run('DELETE FROM general_ledger WHERE journal_entry_id = ?', r.id);
      await db.run('DELETE FROM journal_entries WHERE id = ?', r.id);
    }
    res.json({
      deleted: rows.length,
      statementLinesKept: linesKept,
      jeNumbers: rows.map((r) => r.je_number),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/ach-je/scan', requireRole('ADMIN'), async (req, res) => {
  try {
    const summary = await runAchJeInboxScan(getDatabase, { reason: 'manual' });
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

export { buildPlatformHealthPayload, runAchJeInboxScan, getAchJeInboxScanStatus };
