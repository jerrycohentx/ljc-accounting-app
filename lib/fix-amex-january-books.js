/**
 * Fix Amex 2010 so books as of the Jan 9 statement equal statement ending.
 * No plugs — only reverse restore noise, JE twins, and AMEX: / Amex stmt duplicates.
 */
import { reverseRestoreImportJournals } from './reverse-restore-imports.js';
import { reverseDuplicateBankImports } from './reverse-duplicate-bank-imports.js';
import { reverseJournalEntry } from './reverse-journal.js';
import { getPostedBankBalance } from './bank-catchup.js';
import {
  autoReconcileToTarget,
  reopenBankReconciliation,
  ensureBankReconSessionTables,
} from './bank-reconcile-session.js';
import { normalizeIsoDate } from './bank-statement-view.js';
import { RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';

const ENTITY_ID = 'ent-ljc';
const CARD = '2010';
const JAN_STMT = '2026-01-09';
const JAN_TARGET = 80091.93;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function normDesc(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/^AMEX\s*STMT\s*\d{4}-\d{2}-\d{2}:\s*/i, '')
    .replace(/^AMEX:\s*/i, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .slice(0, 40);
}

/**
 * Reverse active "AMEX: …" lines that duplicate an "Amex stmt …" line,
 * and extra identical "Amex stmt" / AMEX-* posts (keep first).
 */
async function reverseAmexLabelTwins(db, { entityId, userId, dryRun }) {
  const acc = await db.get(
    `SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?`,
    [entityId, CARD]
  );
  if (!acc) throw new Error('Account 2010 not found');

  const rows = await db.all(
    `SELECT gl.id AS gl_id, gl.debit, gl.credit, gl.posting_date, gl.description,
            je.id AS je_id, je.je_number
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id
     WHERE gl.entity_id = ? AND gl.account_id = ?
       AND je.status = 'POSTED'
       AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
       AND gl.posting_date >= '2025-12-01' AND gl.posting_date <= ?
     ORDER BY gl.posting_date, je.je_number`,
    [entityId, acc.id, JAN_STMT]
  );

  const byKey = new Map(); // key -> [rows]
  for (const r of rows || []) {
    const iso = normalizeIsoDate(r.posting_date);
    const cents = Math.round((Number(r.credit || 0) - Number(r.debit || 0)) * 100);
    const key = `${iso}|${cents}|${normDesc(r.description)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ ...r, iso, cents });
  }

  const toReverse = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    // Prefer keeping Amex stmt / AMEX-* feed; reverse AMEX: label and extras
    const rank = (r) => {
      const d = String(r.description || '');
      const n = String(r.je_number || '');
      if (/^Amex stmt\s/i.test(d) || n.startsWith('AMEX-')) return 0;
      if (/^AMEX:\s/i.test(d)) return 2;
      return 1;
    };
    group.sort((a, b) => rank(a) - rank(b) || String(a.je_number).localeCompare(String(b.je_number)));
    const keep = group[0];
    for (const twin of group.slice(1)) {
      toReverse.push({ twin, keep });
    }
  }

  const reversed = [];
  const skipped = [];
  const seenJe = new Set();

  for (const { twin, keep } of toReverse) {
    if (seenJe.has(twin.je_id)) continue;
    seenJe.add(twin.je_id);
    if (dryRun) {
      reversed.push({
        dryRun: true,
        reverse: twin.je_number,
        keep: keep.je_number,
        date: twin.iso,
        amount: twin.cents / 100,
      });
      continue;
    }
    try {
      const result = await reverseJournalEntry(db, {
        journalId: twin.je_id,
        entityId,
        userId,
        reversalDate: twin.iso,
        memo: `Reverse Amex duplicate twin of ${keep.je_number}`,
      });
      reversed.push({
        reverse: twin.je_number,
        keep: keep.je_number,
        date: twin.iso,
        amount: twin.cents / 100,
        reversalId: result.reversalJournalId,
      });
    } catch (e) {
      skipped.push({ je: twin.je_number, error: e.message });
    }
  }

  return { reversedCount: reversed.length, skippedCount: skipped.length, reversed, skipped };
}

export async function fixAmexJanuaryBooks(db, {
  entityId = ENTITY_ID,
  userId = 'usr-admin',
  dryRun = false,
  rebuildRecon = true,
} = {}) {
  await ensureBankReconSessionTables(db);

  const before = await getPostedBankBalance(db, entityId, CARD, JAN_STMT);
  const report = {
    entityId,
    statementDate: JAN_STMT,
    statementEnding: JAN_TARGET,
    beforeBalance: before?.balance ?? null,
    dryRun,
    steps: {},
  };

  report.steps.undoRestores = await reverseRestoreImportJournals(db, {
    entityId,
    userId,
    dryRun,
  });

  report.steps.amexLabelTwins = await reverseAmexLabelTwins(db, {
    entityId,
    userId,
    dryRun,
  });

  report.steps.dedupeBank = await reverseDuplicateBankImports(db, {
    entityId,
    userId,
    dryRun,
  });

  const mid = await getPostedBankBalance(db, entityId, CARD, JAN_STMT);
  report.afterCleanupBalance = mid?.balance ?? null;
  report.gapAfterCleanup = round2((mid?.balance ?? 0) - JAN_TARGET);

  if (!dryRun && rebuildRecon) {
    const amex = await db.get(
      `SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?`,
      [entityId, CARD]
    );
    try {
      await reopenBankReconciliation(db, {
        entityId,
        accountId: amex.id,
        statementDate: JAN_STMT,
      });
    } catch (e) {
      report.reopenError = e.message;
    }

    const targets = (RECONCILIATION_TARGETS[entityId]?.[CARD] || []).filter(
      (t) => String(t.statementDate).slice(0, 7) <= '2026-01'
    );
    let prev = '2025-12-09';
    report.reconResults = [];
    for (const t of targets) {
      const r = await autoReconcileToTarget(db, {
        entityId,
        accountNumber: CARD,
        statementDate: t.statementDate,
        endingBalance: t.endingBalance,
        userId,
        notes: `Fix Amex books/recon ${t.statementDate}`,
        clearedAfterDate: prev,
      });
      report.reconResults.push(r);
      if (r.reconciled) prev = t.statementDate;
    }
  }

  const after = await getPostedBankBalance(db, entityId, CARD, JAN_STMT);
  report.finalBalance = after?.balance ?? null;
  report.finalGap = round2((after?.balance ?? 0) - JAN_TARGET);
  report.booksMatchStatement = Math.abs(report.finalGap) < 0.005;
  return report;
}
