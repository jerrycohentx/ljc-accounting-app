import express from 'express';
import { getDatabase } from '../config/database.js';
import { runLonestarCatchUp } from '../lib/lonestar-catchup.js';
import { runLonestarBalanceFixes } from '../lib/fix-lonestar-opening-balance.js';

const router = express.Router();

function integrationKeyOk(req) {
  const key = req.headers['x-loan-tracker-key'];
  const expected = process.env.LOAN_TRACKER_INTEGRATION_KEY;
  return expected && key && key === expected;
}

/** POST /api/lonestar-catchup — idempotent Lone Star Jan–May 2026 import on production */
router.post('/', async (req, res) => {
  if (!integrationKeyOk(req)) {
    return res.status(401).json({ error: 'Invalid integration key' });
  }

  try {
    const db = await getDatabase();
    const userId = process.env.LOAN_TRACKER_USER_EMAIL
      ? (await db.get('SELECT id FROM users WHERE email = ?', process.env.LOAN_TRACKER_USER_EMAIL))?.id
      : null;
    const result = await runLonestarCatchUp(db, { userId: userId || 'usr-admin' });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Lone Star catch-up failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/lonestar-catchup/fix-balance — correct 12/31/2025 opening balance + reverse errant true-up */
router.post('/fix-balance', async (req, res) => {
  if (!integrationKeyOk(req)) {
    return res.status(401).json({ error: 'Invalid integration key' });
  }

  try {
    const db = await getDatabase();
    const userId = process.env.LOAN_TRACKER_USER_EMAIL
      ? (await db.get('SELECT id FROM users WHERE email = ?', process.env.LOAN_TRACKER_USER_EMAIL))?.id
      : null;
    const result = await runLonestarBalanceFixes(db, { userId: userId || 'usr-admin' });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Lone Star catch-up failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/lonestar-catchup/fix-gl-orphan — one-time idempotent repair (AMEX-RECON-20260703):
 * a half-posted import JE left a one-sided GL row (2010 credit without its 1100 debit),
 * unbalancing the trial balance by $10. Inserts the missing mirror line if absent. */
router.post('/fix-gl-orphan', async (req, res) => {
  if (!integrationKeyOk(req)) {
    return res.status(401).json({ error: 'Invalid integration key' });
  }
  try {
    const db = await getDatabase();
    const JE = 'je-a5a949ff-da91-4626-b7ee-430a11655ca1';
    const A1100 = 'acc-2552d75d-6c0f-4027-9987-f5b535d09d01';
    const rows = await db.all('SELECT * FROM general_ledger WHERE journal_entry_id = ?', [JE]);
    if (rows.length === 1) {
      const o = rows[0];
      await db.run(
        `INSERT INTO general_ledger (id, entity_id, account_id, journal_entry_id, debit, credit, posting_date, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [`gl-orphanfix-${Date.now()}`, o.entity_id, A1100, JE, o.credit, o.debit, o.posting_date,
         'Bank: CLOUD ZNVN34 - repost of GL line missing from half-posted import (AMEX-RECON-20260703)']
      );
      return res.json({ ok: true, inserted: true });
    }
    return res.json({ ok: true, inserted: false, glRows: rows.length });
  } catch (error) {
    console.error('fix-gl-orphan failed:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
