import express from 'express';
import { getDatabase } from '../config/database.js';
import {
  buildReconciliationReport,
  saveReconciliationReport,
  listReconciliationReports,
  getReconciliationReport,
} from '../lib/reconciliation-report.js';
import { renderReconciliationReportPdf } from '../lib/reconciliation-report-pdf.js';

const router = express.Router();

function safeFilePart(s) {
  return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'account';
}

/**
 * POST /api/reconciliation/reports/generate
 * Build a QuickBooks-style Summary + Detail reconciliation report for any
 * account (bank, credit card, intercompany). Pass save:true to archive it
 * permanently so it can be pulled up later even if the ledger changes --
 * closing a reconciliation from the Bank Feeds screen does this
 * automatically; this endpoint also lets you generate (and optionally save)
 * a report on demand, e.g. to backfill a period that was reconciled before
 * this feature existed.
 */
router.post('/generate', async (req, res) => {
  try {
    const { entityId, accountId, statementDate, asOfDate, save, companyName } = req.body || {};
    if (!entityId || !accountId || !statementDate) {
      return res.status(400).json({ error: 'entityId, accountId, and statementDate are required' });
    }
    const db = await getDatabase();
    const report = await buildReconciliationReport(db, {
      entityId,
      accountId,
      statementDate,
      asOfDate,
      companyName,
    });
    let savedId = null;
    if (save) {
      savedId = await saveReconciliationReport(db, report, { userId: req.user?.id || null });
    }
    res.json({ report, savedId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/reconciliation/reports?entityId=&accountId= -- history list for an entity (optionally one account). */
router.get('/', async (req, res) => {
  try {
    const { entityId, accountId } = req.query;
    if (!entityId) return res.status(400).json({ error: 'entityId is required' });
    const db = await getDatabase();
    const reports = await listReconciliationReports(db, { entityId, accountId: accountId || null });
    res.json({ reports });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** GET /api/reconciliation/reports/:id -- fetch one saved report (full summary + detail). */
router.get('/:id', async (req, res) => {
  try {
    const db = await getDatabase();
    const report = await getReconciliationReport(db, req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json({ report });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/reconciliation/reports/:id/pdf?mode=summary|detail|both
 * Stream a QuickBooks-style PDF of a saved (closed) reconciliation. Rendered
 * on demand from the archived summary/detail JSON via headless Chromium.
 */
router.get('/:id/pdf', async (req, res) => {
  try {
    const mode = ['summary', 'detail', 'both'].includes(req.query.mode) ? req.query.mode : 'both';
    const db = await getDatabase();
    const report = await getReconciliationReport(db, req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const pdf = await renderReconciliationReportPdf(report, { mode });
    const fileName = `Reconciliation_${safeFilePart(report.account_name)}_${safeFilePart(report.statement_date)}_${mode}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', pdf.length);
    return res.end(pdf);
  } catch (error) {
    console.error('Reconciliation report PDF error:', error);
    return res.status(500).json({ error: error.message || 'Failed to generate reconciliation PDF' });
  }
});

export default router;
