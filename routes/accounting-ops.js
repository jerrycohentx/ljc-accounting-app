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
import { previewOpeningBalances, postOpeningBalances, parseOpeningBalanceCsv } from '../lib/opening-balances.js';
import { previewYearEndClose, postYearEndClose } from '../lib/year-end-close.js';
import { runLonestarBalanceFixes } from '../lib/fix-lonestar-opening-balance.js';

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

// POST /api/entities/:entityId/accounting/periods/close
router.post('/periods/close', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const { periodStart, periodEnd, postingDate, notes } = req.body;
    const db = await getDatabase();

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

    res.json({ message: 'Period closed', ...result });
  } catch (error) {
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

export default router;
