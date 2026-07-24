/**
 * Append-only reclass: move posted bank-import offsets out of 1100 Undeposited Funds
 * onto the correct category account (rules + fallbacks). Required for suspense-clean month close.
 */
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { postJournalEntryToGl } from './post-journal.js';
import { categorizeTransaction, seedDefaultRules } from './categorization-rules.js';

const ENTITY_ID = 'ent-ljc';
const UNDEPOSITED = '1100';

async function accountByNumber(db, entityId, number) {
  return db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, number]
  );
}

/**
 * @returns {Promise<object>}
 */
export async function reclassPostedUndepositedOffsets(db, {
  entityId = ENTITY_ID,
  userId = 'usr-admin',
  asOfDate = '2026-06-30',
  dryRun = false,
} = {}) {
  await seedDefaultRules(db, entityId);

  const a1100 = await accountByNumber(db, entityId, UNDEPOSITED);
  if (!a1100) throw new Error('Account 1100 not found');

  const fallbackExpense = await accountByNumber(db, entityId, '5700');
  const fallbackIncome = await accountByNumber(db, entityId, '4200');
  if (!fallbackExpense || !fallbackIncome) {
    throw new Error('Fallback accounts 5700/4200 required');
  }

  const rows = await db.all(
    `SELECT gl.id AS gl_id, gl.debit, gl.credit, gl.posting_date,
            je.id AS journal_id, je.je_number, je.description, je.memo
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id
       AND je.status = 'POSTED'
       AND je.reversed_by_je_id IS NULL
       AND je.reverses_je_id IS NULL
     WHERE gl.entity_id = ? AND gl.account_id = ?
       AND gl.posting_date >= '2026-01-01' AND gl.posting_date <= ?
       AND je.je_number LIKE 'IMP-%'
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries r
         WHERE r.entity_id = je.entity_id
           AND r.status = 'POSTED'
           AND r.reversed_by_je_id IS NULL
           AND r.memo LIKE ('reclass-1100:' || je.id || '%')
       )
     ORDER BY gl.posting_date, je.je_number`,
    [entityId, a1100.id, asOfDate]
  );

  const results = [];
  let reclassed = 0;
  let skipped = 0;

  for (const row of rows) {
    const debit = new Decimal(row.debit || 0);
    const credit = new Decimal(row.credit || 0);
    if (debit.isZero() && credit.isZero()) {
      skipped += 1;
      continue;
    }

    const cat = await categorizeTransaction(db, entityId, row.description || '');
    let target = null;
    let label = cat.label || 'Reclass from Undeposited';

    if (cat.offsetAccountId) {
      const acct = await db.get(
        'SELECT id, account_number, account_name FROM accounts WHERE id = ?',
        [cat.offsetAccountId]
      );
      // Never reclass back onto 1100 (e.g. old SETTLEMENT rule)
      if (acct && acct.account_number !== UNDEPOSITED) {
        target = acct;
      }
    }

    if (!target) {
      // Debit on 1100 = bank outflow (expense/draw); credit on 1100 = bank inflow (income/loan)
      target = debit.gt(0) ? fallbackExpense : fallbackIncome;
      label = debit.gt(0)
        ? 'Uncategorized outflow — parked to Office/misc pending review'
        : 'Uncategorized inflow — parked to fee income pending review';
    }

    const amount = Decimal.max(debit, credit);
    const entry = {
      jeNumber: row.je_number,
      postingDate: String(row.posting_date).slice(0, 10),
      amount: Number(amount.toFixed(2)),
      from1100Debit: Number(debit.toFixed(2)),
      from1100Credit: Number(credit.toFixed(2)),
      toAccount: target.account_number,
      label,
      description: (row.description || '').slice(0, 120),
    };

    if (dryRun) {
      results.push({ ...entry, dryRun: true });
      reclassed += 1;
      continue;
    }

    const jeId = `je-${uuidv4()}`;
    const jeNumber = `RCLS-1100-${Date.now()}-${uuidv4().substring(0, 6)}`;
    const memo = `reclass-1100:${row.journal_id}`;
    const postingDate = String(row.posting_date).slice(0, 10);

    await db.run(
      `INSERT INTO journal_entries
       (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
      [
        jeId,
        entityId,
        jeNumber,
        `Reclass Undeposited → ${target.account_number}: ${row.je_number}`,
        postingDate,
        userId,
        amount.toFixed(2),
        amount.toFixed(2),
        memo,
      ]
    );

    // Move balance off 1100 onto target (opposite of the original 1100 line)
    if (debit.gt(0)) {
      // Original: Dr 1100 → reclass: Dr target / Cr 1100
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, ?, 0, ?, 1)`,
        [`jel-${uuidv4()}`, jeId, target.id, debit.toFixed(2), label]
      );
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, 0, ?, ?, 2)`,
        [`jel-${uuidv4()}`, jeId, a1100.id, debit.toFixed(2), 'Clear Undeposited']
      );
    } else {
      // Original: Cr 1100 → reclass: Dr 1100 / Cr target
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, ?, 0, ?, 1)`,
        [`jel-${uuidv4()}`, jeId, a1100.id, credit.toFixed(2), 'Clear Undeposited']
      );
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, 0, ?, ?, 2)`,
        [`jel-${uuidv4()}`, jeId, target.id, credit.toFixed(2), label]
      );
    }

    await postJournalEntryToGl(db, { journalId: jeId, entityId, userId });
    results.push({ ...entry, reclassJeId: jeId, reclassJeNumber: jeNumber });
    reclassed += 1;
  }

  // Suspense after
  const balRow = await db.get(
    `SELECT COALESCE(SUM(gl.debit),0) AS dr, COALESCE(SUM(gl.credit),0) AS cr
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id AND je.status = 'POSTED'
       AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
     WHERE gl.entity_id = ? AND gl.account_id = ? AND gl.posting_date <= ?`,
    [entityId, a1100.id, asOfDate]
  );
  const balance1100 = new Decimal(balRow?.dr || 0).minus(balRow?.cr || 0);

  return {
    entityId,
    scanned: rows.length,
    reclassed,
    skipped,
    balance1100AsOf: Number(balance1100.toFixed(2)),
    clean: balance1100.abs().lt(0.005),
    results,
  };
}
