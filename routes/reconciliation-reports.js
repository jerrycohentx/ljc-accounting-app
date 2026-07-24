import express from 'express';
import { getDatabase } from '../config/database.js';
import {
  buildReconciliationReport,
  saveReconciliationReport,
  listReconciliationReports,
  getReconciliationReport,
  pruneSupersededReconciliationReports,
  deleteReconciliationReport,
} from '../lib/reconciliation-report.js';
import { renderReconciliationReportPdf } from '../lib/reconciliation-report-pdf.js';
import { bankFolderMeta } from '../config/recon-bank-folders.js';
import { normalizeIsoDate } from '../lib/bank-statement-view.js';

const router = express.Router();

function safeFilePart(s) {
  return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'account';
}

function withFolderMeta(row) {
  const sd = normalizeIsoDate(row.statement_date) || String(row.statement_date).slice(0, 10);
  const meta = bankFolderMeta(row.account_number);
  return {
    ...row,
    statement_date: sd,
    bankFolder: meta.bankFolder,
    bankLabel: meta.shortLabel,
    year: sd.slice(0, 4),
    reconciliationsFolder: meta.reconciliationsFolder,
  };
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

/** GET /api/reconciliation/reports?entityId=&accountId=&canonicalOnly=1 -- history list. */
router.get('/', async (req, res) => {
  try {
    const { entityId, accountId } = req.query;
    if (!entityId) return res.status(400).json({ error: 'entityId is required' });
    const canonicalOnly = String(req.query.canonicalOnly ?? '1') !== '0';
    const db = await getDatabase();
    const reports = await listReconciliationReports(db, {
      entityId,
      accountId: accountId || null,
      canonicalOnly,
    });
    res.json({
      reports: (reports || []).map(withFolderMeta),
      organization: 'Bank → Year → reconciliations (one report per statement period)',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/reconciliation/reports/prune-duplicates
 * Body: { entityId } — delete superseded archives (keep one Closed per account+date).
 */
router.post('/prune-duplicates', async (req, res) => {
  try {
    const entityId = req.body?.entityId;
    if (!entityId) return res.status(400).json({ error: 'entityId required' });
    const db = await getDatabase();
    const result = await pruneSupersededReconciliationReports(db, { entityId });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/reconciliation/reports/refresh-closed
 * Rebuild+save the authoritative Closed archive for each closed session in range.
 * Body: { entityId, accountNumbers?: string[], fromDate?, toDate? }
 */
router.post('/refresh-closed', async (req, res) => {
  try {
    const { entityId, accountNumbers = null, fromDate = '2026-01-01', toDate = '2026-06-30' } = req.body || {};
    if (!entityId) return res.status(400).json({ error: 'entityId required' });
    const db = await getDatabase();
    const params = [entityId, fromDate, toDate];
    let sql = `
      SELECT s.id, s.account_id, s.statement_date, a.account_number
      FROM bank_reconciliation_sessions s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.entity_id = ? AND s.status = 'CLOSED' AND ABS(COALESCE(s.difference,0)) < 0.005
        AND s.statement_date >= ? AND s.statement_date <= ?`;
    if (accountNumbers?.length) {
      sql += ` AND a.account_number IN (${accountNumbers.map(() => '?').join(',')})`;
      params.push(...accountNumbers.map(String));
    }
    sql += ' ORDER BY a.account_number, s.statement_date';
    const sessions = await db.all(sql, params);
    const saved = [];
    for (const s of sessions || []) {
      const report = await buildReconciliationReport(db, {
        entityId,
        accountId: s.account_id,
        statementDate: normalizeIsoDate(s.statement_date) || String(s.statement_date).slice(0, 10),
      });
      const sess = await db.get(
        'SELECT ending_balance, beginning_balance FROM bank_reconciliation_sessions WHERE id = ?',
        [s.id]
      );
      if (sess) {
        report.summary.statementEndingBalance = Number(sess.ending_balance);
        report.summary.beginningBalance = Number(sess.beginning_balance);
        report.summary.clearedBalance = Number(sess.ending_balance);
      }
      report.meta.isClosed = true;
      report.meta.sessionId = s.id;
      const id = await saveReconciliationReport(db, report, { userId: req.user?.id || null });
      saved.push({
        id,
        accountNumber: s.account_number,
        statementDate: normalizeIsoDate(s.statement_date),
        ending: report.summary.statementEndingBalance ?? report.summary.endingBalance,
        folder: withFolderMeta({
          account_number: s.account_number,
          statement_date: s.statement_date,
        }),
      });
    }
    const pruned = await pruneSupersededReconciliationReports(db, { entityId });
    res.json({ saved, pruned });
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

/** DELETE /api/reconciliation/reports/:id */
router.delete('/:id', async (req, res) => {
  try {
    const db = await getDatabase();
    const ok = await deleteReconciliationReport(db, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Report not found' });
    res.json({ deleted: true, id: req.params.id });
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

/**
 * POST /api/reconciliation/reports/render-pdf
 * Build AND render a QuickBooks-style reconciliation PDF on demand for the
 * given account/period, WITHOUT saving it -- used by the Reconcile screen's
 * "Reconciliation Report" print picker (Summary / Detail / Both) so a report
 * can be printed for the current worksheet even before it is closed. The
 * frontend fetches this as an authenticated blob and opens it for printing.
 * body: { entityId, accountId, statementDate, asOfDate?, companyName?, mode? }
 */
router.post('/render-pdf', async (req, res) => {
  try {
    const { entityId, accountId, statementDate, asOfDate, companyName, mode } = req.body || {};
    if (!entityId || !accountId || !statementDate) {
      return res.status(400).json({ error: 'entityId, accountId, and statementDate are required' });
    }
    const m = ['summary', 'detail', 'both'].includes(mode) ? mode : 'both';
    const db = await getDatabase();
    const built = await buildReconciliationReport(db, { entityId, accountId, statementDate, asOfDate, companyName });
    const report = {
      company_name: built.header.companyName,
      account_name: built.header.accountName,
      account_number: built.header.accountNumber,
      statement_date: built.header.statementDate,
      generated_at: built.header.reportGeneratedAt,
      is_closed: !!(built.meta && built.meta.isClosed),
      summary: built.summary,
      detail: built.detail,
    };
    const pdf = await renderReconciliationReportPdf(report, { mode: m });
    const fileName = `Reconciliation_${safeFilePart(built.header.accountName)}_${safeFilePart(built.header.statementDate)}_${m}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Length', pdf.length);
    return res.end(pdf);
  } catch (error) {
    console.error('Reconciliation render-pdf error:', error);
    return res.status(500).json({ error: error.message || 'Failed to render reconciliation PDF' });
  }
});

export default router;
