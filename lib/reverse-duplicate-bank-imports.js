/**
 * Reverse duplicate bank/card journals: ONLY manual JE-* twins when an IMP/AMEX
 * feed line exists for the same date+amount. Never IMP-vs-IMP or AMEX-vs-AMEX.
 *
 * Also restores feed lines that an earlier aggressive dedupe reversed by mistake
 * (re-posts matching amounts — append-only; cannot reverse a REV entry).
 */
import { v4 as uuidv4 } from 'uuid';
import { reverseJournalEntry } from './reverse-journal.js';
import { postJournalEntryToGl } from './post-journal.js';
import { normalizeIsoDate } from './bank-statement-view.js';

const ENTITY_ID = 'ent-ljc';

function isManualJe(jeNumber) {
  const n = String(jeNumber || '');
  return n.startsWith('JE-');
}

/**
 * Re-post amounts for IMP/AMEX rows that were reversed by mistaken dedupe.
 */
export async function restoreMistakenImportReversals(db, {
  entityId = ENTITY_ID,
  userId = 'usr-admin',
  dryRun = false,
} = {}) {
  const rows = await db.all(
    `SELECT orig.id AS orig_id, orig.je_number AS orig_number, orig.posting_date,
            orig.description AS orig_description,
            rev.id AS rev_id, rev.je_number AS rev_number, rev.memo AS rev_memo
     FROM journal_entries orig
     JOIN journal_entries rev ON rev.id = orig.reversed_by_je_id
       AND rev.entity_id = orig.entity_id
       AND rev.status = 'POSTED'
     WHERE orig.entity_id = ?
       AND orig.status = 'POSTED'
       AND (orig.je_number LIKE 'AMEX-%')
       AND orig.posting_date >= '2026-01-01' AND orig.posting_date <= '2026-06-30'
       AND (
         COALESCE(rev.memo, '') LIKE 'Reverse duplicate of %'
         OR COALESCE(rev.description, '') LIKE 'Reverse duplicate of %'
       )
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries r2
         WHERE r2.entity_id = orig.entity_id
           AND r2.status = 'POSTED'
           AND r2.reversed_by_je_id IS NULL
           AND r2.memo LIKE ('restore-import:' || orig.id || '%')
       )`,
    [entityId]
  );

  const restored = [];
  const skipped = [];

  for (const row of rows) {
    const iso = normalizeIsoDate(row.posting_date);
    const lines = await db.all(
      `SELECT account_id, debit, credit, description, line_number
       FROM journal_entry_lines WHERE journal_entry_id = ? ORDER BY line_number`,
      [row.orig_id]
    );
    if (!lines.length) {
      skipped.push({ je: row.orig_number, reason: 'no lines' });
      continue;
    }

    let totalDebit = 0;
    let totalCredit = 0;
    for (const l of lines) {
      totalDebit += Number(l.debit || 0);
      totalCredit += Number(l.credit || 0);
    }

    if (dryRun) {
      restored.push({
        dryRun: true,
        original: row.orig_number,
        rev: row.rev_number,
        date: iso,
        amount: totalDebit,
      });
      continue;
    }

    try {
      const jeId = `je-${uuidv4()}`;
      const jeNumber = `RESTORE-${row.orig_number}-${Date.now().toString().slice(-6)}`;
      const memo = `restore-import:${row.orig_id}`;
      await db.run(
        `INSERT INTO journal_entries
         (id, entity_id, je_number, description, posting_date, status, created_by, memo, total_debit, total_credit)
         VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
        [
          jeId,
          entityId,
          jeNumber,
          `Restore mistaken dedupe reversal of ${row.orig_number}`,
          iso,
          userId,
          memo,
          totalDebit.toFixed(2),
          totalCredit.toFixed(2),
        ]
      );
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        await db.run(
          `INSERT INTO journal_entry_lines
           (id, journal_entry_id, account_id, debit, credit, description, line_number)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            `jel-${uuidv4()}`,
            jeId,
            l.account_id,
            l.debit || 0,
            l.credit || 0,
            l.description || `Restore ${row.orig_number}`,
            i + 1,
          ]
        );
      }
      await postJournalEntryToGl(db, { journalId: jeId, entityId, userId });
      restored.push({
        original: row.orig_number,
        rev: row.rev_number,
        restoreJe: jeNumber,
        date: iso,
        amount: totalDebit,
      });
    } catch (e) {
      skipped.push({ je: row.orig_number, error: e.message });
    }
  }

  return { restoredCount: restored.length, skippedCount: skipped.length, restored, skipped };
}

export async function reverseDuplicateBankImports(db, {
  entityId = ENTITY_ID,
  userId = 'usr-admin',
  dryRun = false,
} = {}) {
  const bankAccounts = await db.all(
    `SELECT id, account_number FROM accounts
     WHERE entity_id = ? AND account_number IN ('1000', '1001', '2010')`,
    [entityId]
  );
  const byNum = Object.fromEntries(bankAccounts.map((a) => [a.account_number, a.id]));

  const reversed = [];
  const skipped = [];

  for (const accountNumber of ['1001', '1000', '2010']) {
    const accountId = byNum[accountNumber];
    if (!accountId) continue;

    const rows = await db.all(
      `SELECT gl.id AS gl_id, gl.debit, gl.credit, gl.posting_date,
              je.id AS journal_id, je.je_number, je.description
       FROM general_ledger gl
       JOIN journal_entries je ON je.id = gl.journal_entry_id
         AND je.status = 'POSTED'
         AND je.reversed_by_je_id IS NULL
         AND je.reverses_je_id IS NULL
       WHERE gl.entity_id = ? AND gl.account_id = ?
         AND gl.posting_date >= '2026-01-01' AND gl.posting_date <= '2026-06-30'
       ORDER BY gl.posting_date, ABS(gl.debit - gl.credit), je.je_number`,
      [entityId, accountId]
    );

    const groups = new Map();
    for (const r of rows) {
      const cents = Math.round((Number(r.debit || 0) - Number(r.credit || 0)) * 100);
      const iso = normalizeIsoDate(r.posting_date);
      if (!iso) continue;
      const key = `${iso}|${cents}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...r, iso, cents });
    }

    for (const [, group] of groups) {
      if (group.length < 2) continue;

      const feeds = group.filter(
        (g) =>
          String(g.je_number || '').startsWith('IMP-') ||
          String(g.je_number || '').startsWith('AMEX-')
      );
      const manuals = group.filter((g) => isManualJe(g.je_number));
      if (!feeds.length || !manuals.length) continue;
      const keep = feeds[0];

      for (const dup of manuals) {
        if (dryRun) {
          reversed.push({
            dryRun: true,
            accountNumber,
            keep: keep.je_number,
            reverse: dup.je_number,
            date: dup.iso,
            amount: Math.abs(dup.cents) / 100,
          });
          continue;
        }
        try {
          const result = await reverseJournalEntry(db, {
            journalId: dup.journal_id,
            entityId,
            userId,
            reversalDate: dup.iso,
            memo: `Reverse duplicate of ${keep.je_number} on ${accountNumber}`,
          });
          reversed.push({
            accountNumber,
            keep: keep.je_number,
            reverse: dup.je_number,
            date: dup.iso,
            amount: Math.abs(dup.cents) / 100,
            reversalId: result?.reversalJournalId,
          });
        } catch (e) {
          skipped.push({ je: dup.je_number, error: e.message });
        }
      }
    }
  }

  return {
    entityId,
    dryRun,
    reversedCount: reversed.length,
    skippedCount: skipped.length,
    reversed,
    skipped,
  };
}
