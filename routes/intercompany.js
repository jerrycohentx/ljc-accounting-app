import express from 'express';
import { getDatabase } from '../config/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { INTERCOMPANY_PAIRS } from '../config/intercompany-pairs.js';
import Decimal from 'decimal.js';

const router = express.Router();

async function getIcBalance(db, entityId, accountNumber, asOfDate) {
  const acc = await db.get(
    'SELECT id, normal_balance FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, accountNumber]
  );
  if (!acc) return null;

  const row = await db.get(
    `SELECT COALESCE(SUM(gl.debit),0) as td, COALESCE(SUM(gl.credit),0) as tc
     FROM general_ledger gl
     INNER JOIN journal_entries je ON je.id = gl.journal_entry_id AND je.status = 'POSTED'
     WHERE gl.account_id = ? AND gl.entity_id = ?
       AND (? IS NULL OR gl.posting_date <= ?)`,
    [acc.id, entityId, asOfDate, asOfDate]
  );
  const td = new Decimal(row?.td || 0);
  const tc = new Decimal(row?.tc || 0);
  return acc.normal_balance === 'DEBIT' ? td.minus(tc) : tc.minus(td);
}

// GET /api/intercompany/verify?asOfDate=YYYY-MM-DD
router.get('/verify', authMiddleware, async (req, res) => {
  try {
    const asOfDate = req.query.asOfDate || null;
    const db = await getDatabase();
    const pairs = [];
    let allTied = true;

    for (const pair of INTERCOMPANY_PAIRS) {
      const balA = await getIcBalance(db, pair.sideA.entity, pair.sideA.account, asOfDate);
      const balB = await getIcBalance(db, pair.sideB.entity, pair.sideB.account, asOfDate);
      const a = balA || new Decimal(0);
      const b = balB || new Decimal(0);
      const variance = a.minus(b).abs();
      const tied = variance.lt(0.01);
      if (!tied) allTied = false;

      pairs.push({
        id: pair.id,
        label: pair.label,
        sideA: { entity: pair.sideA.entity, account: pair.sideA.account, balance: a.toFixed(2) },
        sideB: { entity: pair.sideB.entity, account: pair.sideB.account, balance: b.toFixed(2) },
        variance: variance.toFixed(2),
        tied,
      });
    }

    res.json({ asOfDate, allTied, pairs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
