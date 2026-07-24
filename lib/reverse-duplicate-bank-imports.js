/**
 * Reverse duplicate Lonestar / Amex journal entries that mirror bank IMP lines.
 * Keeps IMP-* as source of truth; reverses manual JE-* twins (append-only).
 */
import { reverseJournalEntry } from './reverse-journal.js';
import { normalizeIsoDate } from './bank-statement-view.js';

const ENTITY_ID = 'ent-ljc';

/**
 * Find posted non-IMP/AMEX/OFX/RCLS/CLR/OB journals that duplicate an IMP
 * on the same date+amount+bank account (1001 or 1000 card-payment pattern).
 */
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
              je.id AS journal_id, je.je_number, je.description, je.reversed_by_je_id
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

    // Group by date + signed cents
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

      const imps = group.filter((g) => String(g.je_number || '').startsWith('IMP-'));
      const amex = group.filter((g) => String(g.je_number || '').startsWith('AMEX-'));
      const others = group.filter(
        (g) =>
          !String(g.je_number || '').startsWith('IMP-') &&
          !String(g.je_number || '').startsWith('AMEX-') &&
          !String(g.je_number || '').startsWith('RCLS-') &&
          !String(g.je_number || '').startsWith('CLR-') &&
          !String(g.je_number || '').startsWith('OB-') &&
          !String(g.je_number || '').startsWith('REV-') &&
          !String(g.je_number || '').startsWith('TRUEUP-') &&
          !String(g.je_number || '').startsWith('FIX-')
      );

      // Prefer IMP (bank feed), else AMEX statement line, else first other
      const keep = imps[0] || amex[0] || others[0];
      if (!keep) continue;

      const toReverse = [];
      for (const g of group) {
        if (g.journal_id === keep.journal_id) continue;
        // Always reverse manual JE twins
        if (others.includes(g)) {
          toReverse.push(g);
          continue;
        }
        // Extra IMP copies
        if (imps.includes(g) && g.journal_id !== imps[0]?.journal_id) {
          toReverse.push(g);
          continue;
        }
        // On card: if IMP payment exists, AMEX "MOBILE PAYMENT" twin is duplicate
        if (
          accountNumber === '2010' &&
          imps.length > 0 &&
          amex.includes(g) &&
          /mobile payment|thank you|payment received|online payment/i.test(g.description || '')
        ) {
          toReverse.push(g);
          continue;
        }
        // Extra AMEX copies of same charge
        if (amex.includes(g) && keep === amex[0] && g.journal_id !== amex[0].journal_id) {
          toReverse.push(g);
        }
      }

      for (const dup of toReverse) {
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
            reversalId: result?.reversalJournalId || result?.reversalId || result?.id,
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
