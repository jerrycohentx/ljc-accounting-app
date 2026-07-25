/**
 * Remove Jerry's personal Simmons DDA x4177 (GL 1015) from LJC books.
 *
 * Transfers were booked as cash↔1015. Personal money belongs in Member's Draws
 * (3005), not as a company bank account. Zero 1015 → draws, then deactivate.
 */
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { postJournalEntryToGl } from './post-journal.js';
import { reopenPeriod, monthBounds } from './period-lock.js';

const ENTITY = 'ent-ljc';
const PERSONAL_ACCT = '1015';
const DRAWS_ACCT = '3005';
const JE_NUMBER = 'RECLASS-REMOVE-PERSONAL-4177';

function round2(n) {
  return new Decimal(n || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export async function removePersonalSimmons4177(db, {
  entityId = ENTITY,
  userId = 'usr-admin',
  postingDate = '2026-06-30',
} = {}) {
  const personal = await db.get(
    `SELECT id, account_number, account_name, is_active FROM accounts
     WHERE entity_id = ? AND account_number = ?`,
    [entityId, PERSONAL_ACCT]
  );
  if (!personal) {
    return { skipped: true, reason: 'Account 1015 not found' };
  }

  const draws = await db.get(
    `SELECT id, account_number, account_name FROM accounts
     WHERE entity_id = ? AND account_number = ? AND is_active = 1`,
    [entityId, DRAWS_ACCT]
  );
  if (!draws) throw new Error(`Member's Draws account ${DRAWS_ACCT} not found`);

  const bal = await db.get(
    `SELECT COALESCE(SUM(debit), 0) AS debits, COALESCE(SUM(credit), 0) AS credits
     FROM general_ledger WHERE entity_id = ? AND account_id = ?`,
    [entityId, personal.id]
  );
  const debits = round2(bal?.debits);
  const credits = round2(bal?.credits);
  const net = debits.minus(credits); // asset signed balance (debit − credit)

  const existing = await db.get(
    `SELECT id, status FROM journal_entries WHERE entity_id = ? AND je_number = ?`,
    [entityId, JE_NUMBER]
  );
  if (existing?.status === 'POSTED') {
    // Still ensure deactivated
    await db.run(
      `UPDATE accounts SET is_active = 0, description = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND entity_id = ?`,
      [
        'PERSONAL — removed from LJC books (Simmons x4177). Do not reactivate.',
        personal.id,
        entityId,
      ]
    );
    return {
      skipped: true,
      reason: 'reclass already posted',
      jeId: existing.id,
      deactivated: true,
      priorBalance: net.toNumber(),
    };
  }

  let jeId = existing?.id;
  const day = String(postingDate).slice(0, 10);
  const { periodStart, periodEnd } = monthBounds(day);
  await reopenPeriod(db, { entityId, periodStart, periodEnd }).catch(() => {});

  if (net.abs().gte(0.01)) {
    // Zero asset: opposite of net. Net debit → credit 1015; net credit → debit 1015.
    const zeroDebit = net.isNegative() ? net.abs() : new Decimal(0);
    const zeroCredit = net.isPositive() ? net : new Decimal(0);
    // Draws (contra-equity, debit normal): mirror so owner draws reflect personal transfers.
    const drawsDebit = zeroCredit;
    const drawsCredit = zeroDebit;

    const totalDebit = zeroDebit.plus(drawsDebit);
    const totalCredit = zeroCredit.plus(drawsCredit);
    if (!totalDebit.equals(totalCredit)) {
      throw new Error(`Unbalanced reclass: ${totalDebit} vs ${totalCredit}`);
    }

    if (!jeId) {
      jeId = `je-${uuidv4()}`;
      await db.run(
        `INSERT INTO journal_entries
         (id, entity_id, je_number, description, posting_date, status, created_by, memo, source, total_debit, total_credit)
         VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, 'owner-reclass', ?, ?)`,
        [
          jeId,
          entityId,
          JE_NUMBER,
          'Remove personal Simmons x4177 (1015) — reclass to Member\'s Draws',
          day,
          userId,
          'Personal account — not LJC cash',
          totalDebit.toFixed(2),
          totalCredit.toFixed(2),
        ]
      );
    } else {
      await db.run(`DELETE FROM journal_entry_lines WHERE journal_entry_id = ?`, [jeId]);
      await db.run(
        `UPDATE journal_entries SET posting_date = ?, status = 'DRAFT', description = ?, memo = ? WHERE id = ?`,
        [
          day,
          'Remove personal Simmons x4177 (1015) — reclass to Member\'s Draws',
          'Personal account — not LJC cash',
          jeId,
        ]
      );
    }

    await db.run(
      `INSERT INTO journal_entry_lines
       (id, journal_entry_id, line_number, account_id, debit, credit, description)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
      [
        `jel-${uuidv4()}`,
        jeId,
        personal.id,
        zeroDebit.toFixed(2),
        zeroCredit.toFixed(2),
        'Zero personal Simmons x4177',
      ]
    );
    await db.run(
      `INSERT INTO journal_entry_lines
       (id, journal_entry_id, line_number, account_id, debit, credit, description)
       VALUES (?, ?, 2, ?, ?, ?, ?)`,
      [
        `jel-${uuidv4()}`,
        jeId,
        draws.id,
        drawsDebit.toFixed(2),
        drawsCredit.toFixed(2),
        'Personal Simmons x4177 transfers → Member\'s Draws',
      ]
    );

    await postJournalEntryToGl(db, { journalId: jeId, entityId, userId });
  }

  // Confirm zero
  const after = await db.get(
    `SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0) AS bal
     FROM general_ledger WHERE entity_id = ? AND account_id = ?`,
    [entityId, personal.id]
  );
  const afterBal = round2(after?.bal).toNumber();
  if (Math.abs(afterBal) >= 0.01) {
    throw new Error(`1015 still has balance ${afterBal} after reclass`);
  }

  await db.run(
    `UPDATE accounts SET is_active = 0, description = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND entity_id = ?`,
    [
      'PERSONAL — removed from LJC books (Simmons x4177). Do not reactivate.',
      personal.id,
      entityId,
    ]
  );

  // Soft-rename so it is obvious if anything still references it
  await db.run(
    `UPDATE accounts SET account_name = ? WHERE id = ? AND entity_id = ?`,
    ['[INACTIVE PERSONAL] Simmons x4177', personal.id, entityId]
  );

  return {
    removed: true,
    accountId: personal.id,
    accountNumber: PERSONAL_ACCT,
    priorBalance: net.toNumber(),
    reclassJeId: jeId || null,
    drawsAccount: DRAWS_ACCT,
    deactivated: true,
  };
}
