/**
 * Holdback draw disbursements — import from Loan Tracker, bank recon verification
 */
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../config/database.js';
import {
  ensureHoldbackTable,
  createHoldbackJournal,
  verifyDrawById,
  drawMemoContainsId,
} from '../lib/holdback-disbursement.js';

const router = express.Router();

router.use(async (req, res, next) => {
  try {
    const db = await getDatabase();
    await ensureHoldbackTable(db);
    req.db = db;
    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/import', async (req, res) => {
  try {
    const {
      drawId,
      entityId = 'ent-ljc',
      loanId,
      loanNum,
      borrowerName,
      propertyAddress,
      drawDate,
      grossAmount,
      inspectionFee = 0,
      wireFee = 35,
      netDisbursement,
      memo,
      note,
    } = req.body;

    if (!drawId || !drawDate || grossAmount == null || netDisbursement == null) {
      return res.status(400).json({ error: 'drawId, drawDate, grossAmount, and netDisbursement are required' });
    }

    const db = req.db;
    const existing = await db.get('SELECT * FROM holdback_disbursements WHERE draw_id = ?', drawId);
    if (existing) {
      return res.json({
        id: existing.id,
        drawId: existing.draw_id,
        status: existing.status,
        journalEntryId: existing.journal_entry_id,
        message: 'Draw already imported',
      });
    }

    const journal = await createHoldbackJournal(db, {
      entityId,
      userId: req.user.id,
      drawId,
      drawDate,
      grossAmount,
      inspectionFee,
      wireFee,
      netDisbursement,
      borrowerName,
      loanNum,
      note,
    });

    const id = `hbd-${uuidv4()}`;
    const recordMemo = memo || `HOLDBACK-DRAW:${drawId}`;

    await db.run(
      `INSERT INTO holdback_disbursements
       (id, draw_id, entity_id, loan_id, loan_num, borrower_name, property_address,
        draw_date, gross_amount, inspection_fee, wire_fee, net_disbursement,
        status, journal_entry_id, gl_entry_id, memo, note, source_app)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        drawId,
        entityId,
        loanId || null,
        loanNum || null,
        borrowerName || null,
        propertyAddress || null,
        drawDate,
        grossAmount,
        inspectionFee,
        wireFee,
        netDisbursement,
        'exported',
        journal.journalId,
        journal.cashGlId,
        recordMemo,
        note || null,
        'loan-tracker',
      ]
    );

    return res.status(201).json({
      id,
      drawId,
      journalEntryId: journal.journalId,
      jeNumber: journal.jeNumber,
      glEntryId: journal.cashGlId,
      status: 'exported',
      memo: recordMemo,
      message: 'Holdback draw exported to accounting',
    });
  } catch (error) {
    console.error('Holdback import error:', error);
    return res.status(500).json({ error: error.message });
  }
});

router.get('/pending', async (req, res) => {
  try {
    const { entityId = 'ent-ljc' } = req.query;
    const rows = await req.db.all(
      `SELECT * FROM holdback_disbursements
       WHERE entity_id = ? AND status IN ('exported', 'matched')
       ORDER BY draw_date DESC`,
      entityId
    );
    return res.json({ disbursements: rows || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    const { drawIds } = req.query;
    if (!drawIds) {
      return res.status(400).json({ error: 'drawIds query parameter required' });
    }
    const ids = String(drawIds).split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) {
      return res.json({ disbursements: [] });
    }
    const placeholders = ids.map(() => '?').join(',');
    const rows = await req.db.all(
      `SELECT draw_id, status, verified_at, net_disbursement, draw_date, memo
       FROM holdback_disbursements WHERE draw_id IN (${placeholders})`,
      ids
    );
    return res.json({ disbursements: rows || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/verify-match', async (req, res) => {
  try {
    const { drawId, importTransactionId, bankReference } = req.body;
    if (!drawId) {
      return res.status(400).json({ error: 'drawId required' });
    }

    const updated = await verifyDrawById(req.db, drawId, {
      userId: req.user.id,
      importTransactionId,
      bankReference,
    });

    if (!updated) {
      return res.status(404).json({ error: 'Draw not found' });
    }

    if (importTransactionId) {
      await req.db.run(
        `UPDATE import_transactions SET status = 'RECONCILED' WHERE id = ?`,
        importTransactionId
      );
    }

    return res.json({
      drawId: updated.draw_id,
      status: updated.status,
      verifiedAt: updated.verified_at,
      message: 'Draw marked as verified — wire confirmed on bank statement',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/verify-from-statement', async (req, res) => {
  try {
    const { importTransactionId, entityId = 'ent-ljc' } = req.body;
    if (!importTransactionId) {
      return res.status(400).json({ error: 'importTransactionId required' });
    }

    const txn = await req.db.get('SELECT * FROM import_transactions WHERE id = ?', importTransactionId);
    if (!txn) {
      return res.status(404).json({ error: 'Bank transaction not found' });
    }

    const amount = Math.abs(Number(txn.amount) || 0);
    const rows = await req.db.all(
      `SELECT * FROM holdback_disbursements
       WHERE entity_id = ? AND status IN ('exported', 'matched')`,
      entityId
    );

    let match = null;
    for (const row of rows) {
      const text = `${txn.description || ''} ${txn.check_number || ''} ${row.memo || ''}`;
      const memoHit = drawMemoContainsId(text, row.draw_id);
      const amountHit = Math.abs(Number(row.net_disbursement) - amount) < 0.02;
      if (memoHit && amountHit) {
        match = row;
        break;
      }
      if (!match && amountHit) {
        match = row;
      }
    }

    if (!match) {
      return res.status(404).json({ error: 'No matching holdback draw for this bank line' });
    }

    const updated = await verifyDrawById(req.db, match.draw_id, {
      userId: req.user.id,
      importTransactionId,
      bankReference: txn.fitid || txn.id,
    });

    await req.db.run(
      `UPDATE import_transactions SET status = 'RECONCILED', matched_to_gl_id = COALESCE(matched_to_gl_id, ?) WHERE id = ?`,
      [match.gl_entry_id, importTransactionId]
    );

    return res.json({
      drawId: updated.draw_id,
      status: updated.status,
      borrowerName: match.borrower_name,
      netDisbursement: match.net_disbursement,
      message: 'Holdback draw verified against bank statement',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
