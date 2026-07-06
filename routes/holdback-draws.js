/**
 * Holdback draw disbursements — import from Loan Tracker, bank recon verification
 */
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../config/database.js';
import {
  ensureHoldbackTable,
  createHoldbackDisbursementJournal,
  ensureFundsReceivedJournal,
  postHoldbackFeeCorrection,
  verifyDrawById,
  resolveFundingBank,
} from '../lib/holdback-disbursement.js';
import { findHoldbackDrawForBankTxn } from '../lib/holdback-bank-match.js';

function holdbackFeesMatch(existing, payload) {
  const eq = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;
  return eq(existing.gross_amount, payload.grossAmount)
    && eq(existing.inspection_fee, payload.inspectionFee)
    && eq(existing.wire_fee, payload.wireFee)
    && eq(existing.net_disbursement, payload.netDisbursement);
}

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

router.post('/funds-received', async (req, res) => {
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
      fundingBank,
      memo,
      note,
    } = req.body;

    if (!drawId || !drawDate || grossAmount == null) {
      return res.status(400).json({ error: 'drawId, drawDate, and grossAmount are required' });
    }

    const db = req.db;
    const bank = resolveFundingBank(fundingBank);
    const existing = await db.get('SELECT * FROM holdback_disbursements WHERE draw_id = ?', drawId);

    const funds = await ensureFundsReceivedJournal(db, {
      entityId,
      userId: req.user.id,
      drawId,
      drawDate,
      grossAmount,
      borrowerName,
      loanNum,
      fundingBank: bank,
      note,
      existingFundsJournalId: existing?.funds_journal_id,
    });

    if (existing) {
      if (!existing.funds_journal_id) {
        await db.run(
          `UPDATE holdback_disbursements
           SET funds_journal_id = ?, funding_bank = ?, updated_at = CURRENT_TIMESTAMP
           WHERE draw_id = ?`,
          [funds.journalId, bank, drawId]
        );
      }
      return res.json({
        id: existing.id,
        drawId: existing.draw_id,
        fundsJournalId: funds.journalId,
        status: existing.status,
        fundingBank: bank,
        message: funds.alreadyPosted ? 'Funds already recorded in accounting' : 'Simmons advance recorded',
      });
    }

    const id = `hbd-${uuidv4()}`;
    const recordMemo = memo || `HOLDBACK-FUNDS:${drawId}`;
    await db.run(
      `INSERT INTO holdback_disbursements
       (id, draw_id, entity_id, loan_id, loan_num, borrower_name, property_address,
        draw_date, gross_amount, inspection_fee, wire_fee, net_disbursement,
        status, funds_journal_id, funding_bank, memo, note, source_app)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
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
        grossAmount,
        'pending',
        funds.journalId,
        bank,
        recordMemo,
        note || null,
        'loan-tracker',
      ]
    );

    return res.status(201).json({
      id,
      drawId,
      fundsJournalId: funds.journalId,
      status: 'pending',
      fundingBank: bank,
      message: 'Simmons advance recorded in accounting',
    });
  } catch (error) {
    console.error('Holdback funds-received error:', error);
    return res.status(500).json({ error: error.message });
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
      fundingBank,
      memo,
      note,
    } = req.body;

    if (!drawId || !drawDate || grossAmount == null || netDisbursement == null) {
      return res.status(400).json({ error: 'drawId, drawDate, grossAmount, and netDisbursement are required' });
    }

    const db = req.db;
    const bank = resolveFundingBank(fundingBank);
    const existing = await db.get('SELECT * FROM holdback_disbursements WHERE draw_id = ?', drawId);
    if (existing) {
      const payload = { grossAmount, inspectionFee, wireFee, netDisbursement };
      if (holdbackFeesMatch(existing, payload) && existing.journal_entry_id) {
        return res.json({
          id: existing.id,
          drawId: existing.draw_id,
          status: existing.status,
          journalEntryId: existing.journal_entry_id,
          fundsJournalId: existing.funds_journal_id,
          fundingBank: existing.funding_bank || bank,
          message: 'Draw already imported',
        });
      }

      if (existing.status === 'verified') {
        return res.status(409).json({ error: 'Draw already verified; fees cannot be changed' });
      }

      if (existing.funds_journal_id && !existing.journal_entry_id) {
        const journal = await createHoldbackDisbursementJournal(db, {
          entityId,
          userId: req.user.id,
          drawId,
          drawDate: existing.draw_date || drawDate,
          grossAmount,
          inspectionFee,
          wireFee,
          netDisbursement,
          borrowerName: borrowerName || existing.borrower_name,
          loanNum: loanNum || existing.loan_num,
          fundingBank: existing.funding_bank || bank,
          note,
        });
        const recordMemo = memo || `HOLDBACK-DRAW:${drawId}`;
        await db.run(
          `UPDATE holdback_disbursements
           SET draw_date = ?, inspection_fee = ?, wire_fee = ?, net_disbursement = ?,
               status = 'exported', journal_entry_id = ?, gl_entry_id = ?, memo = ?,
               funding_bank = ?, updated_at = CURRENT_TIMESTAMP
           WHERE draw_id = ?`,
          [
            drawDate,
            inspectionFee,
            wireFee,
            netDisbursement,
            journal.journalId,
            journal.cashGlId,
            recordMemo,
            bank,
            drawId,
          ]
        );
        return res.json({
          id: existing.id,
          drawId: existing.draw_id,
          journalEntryId: journal.journalId,
          fundsJournalId: existing.funds_journal_id,
          jeNumber: journal.jeNumber,
          glEntryId: journal.cashGlId,
          status: 'exported',
          fundingBank: bank,
          message: 'Holdback disbursement posted (Simmons DLOC / holdback mapping)',
        });
      }

      if (existing.journal_entry_id) {
        const correction = await postHoldbackFeeCorrection(db, {
          entityId,
          userId: req.user.id,
          drawId,
          drawDate: existing.draw_date || drawDate,
          borrowerName: borrowerName || existing.borrower_name,
          loanNum: loanNum || existing.loan_num,
          oldInspectionFee: existing.inspection_fee,
          oldWireFee: existing.wire_fee,
          oldNetDisbursement: existing.net_disbursement,
          inspectionFee,
          wireFee,
          netDisbursement,
          fundingBank: existing.funding_bank || bank,
        });
        await db.run(
          `UPDATE holdback_disbursements
           SET inspection_fee = ?, wire_fee = ?, net_disbursement = ?, funding_bank = ?, updated_at = CURRENT_TIMESTAMP
           WHERE draw_id = ?`,
          [inspectionFee, wireFee, netDisbursement, bank, drawId]
        );
        return res.json({
          id: existing.id,
          drawId: existing.draw_id,
          status: existing.status,
          correctionJournalId: correction?.journalId,
          correctionJeNumber: correction?.jeNumber,
          fundingBank: bank,
          message: 'Holdback draw fees corrected in accounting',
        });
      }
    }

    const funds = await ensureFundsReceivedJournal(db, {
      entityId,
      userId: req.user.id,
      drawId,
      drawDate,
      grossAmount,
      borrowerName,
      loanNum,
      fundingBank: bank,
      note,
      existingFundsJournalId: null,
    });

    const journal = await createHoldbackDisbursementJournal(db, {
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
      fundingBank: bank,
      note,
    });

    const id = `hbd-${uuidv4()}`;
    const recordMemo = memo || `HOLDBACK-DRAW:${drawId}`;

    await db.run(
      `INSERT INTO holdback_disbursements
       (id, draw_id, entity_id, loan_id, loan_num, borrower_name, property_address,
        draw_date, gross_amount, inspection_fee, wire_fee, net_disbursement,
        status, journal_entry_id, funds_journal_id, funding_bank, gl_entry_id, memo, note, source_app)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        funds.journalId,
        bank,
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
      fundsJournalId: funds.journalId,
      jeNumber: journal.jeNumber,
      glEntryId: journal.cashGlId,
      status: 'exported',
      fundingBank: bank,
      memo: recordMemo,
      message: 'Holdback draw exported to accounting (Simmons DLOC / holdback mapping)',
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
    const match = await findHoldbackDrawForBankTxn(req.db, {
      entityId,
      importTransaction: txn,
    });

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

/** Post $35 wire return + $35 resend fees when a holdback wire bounces; reduces expected net wire. */
router.post('/:drawId/wire-resend-fees', async (req, res) => {
  try {
    const { drawId } = req.params;
    const row = await req.db.get('SELECT * FROM holdback_disbursements WHERE draw_id = ?', drawId);
    if (!row) return res.status(404).json({ error: 'Draw not found' });
    if (row.status === 'verified') {
      return res.status(409).json({ error: 'Draw already verified; cannot adjust wire resend fees' });
    }

    const wireReturnFee = 35;
    const wireResendFee = 35;
    const oldWireFee = Number(row.wire_fee) || 0;
    const oldNet = Number(row.net_disbursement) || 0;
    const newWireFee = oldWireFee + wireReturnFee + wireResendFee;
    const newNet = oldNet - wireReturnFee - wireResendFee;

    if (newNet <= 0) {
      return res.status(400).json({ error: 'Net disbursement would be zero after wire resend fees' });
    }

    const correction = await postHoldbackFeeCorrection(req.db, {
      entityId: row.entity_id,
      userId: req.user.id,
      drawId,
      drawDate: row.draw_date,
      borrowerName: row.borrower_name,
      loanNum: row.loan_num,
      oldInspectionFee: row.inspection_fee,
      oldWireFee,
      oldNetDisbursement: oldNet,
      inspectionFee: row.inspection_fee,
      wireFee: newWireFee,
      netDisbursement: newNet,
      fundingBank: row.funding_bank,
    });

    await req.db.run(
      `UPDATE holdback_disbursements
       SET wire_fee = ?, net_disbursement = ?, status = CASE WHEN status = 'verified' THEN status ELSE 'matched' END,
           updated_at = CURRENT_TIMESTAMP
       WHERE draw_id = ?`,
      [newWireFee, newNet, drawId]
    );

    return res.json({
      drawId,
      wireFee: newWireFee,
      netDisbursement: newNet,
      correctionJournalId: correction?.journalId,
      message: 'Wire return + resend fees posted; net wire reduced by $70',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
