/**
 * Clear stale QBO conversion clearing balances that block 2026 month close.
 * Mirrors prior owner-approved write-offs (Undeposited Funds → RE).
 *
 * - 1100: reverse Mar 31 P&L write-off path; clear to RE as of 2026-01-01
 * - 1021: clear opening Transfers In Transit credit to RE as of 2026-01-01
 */
import { v4 as uuidv4 } from 'uuid';
import { postJournalEntryToGl } from './post-journal.js';
import { reverseJournalEntry } from './reverse-journal.js';
import { checkSuspenseAccounts } from './suspense-check.js';

const ENTITY_ID = 'ent-ljc';
const OPEN = '2026-01-01';
const UNDEPOSITED_WO_ID = 'je-7c3598c7-34af-423d-abb7-11aea96f91a9';
const RECLASS_ID = 'je-aa486095-038f-45c6-8435-28b09f0653c4';
const FIN_WO_ID = 'je-1647c20e-5bf2-425e-b3c7-be7f3687d66e';

async function accountId(db, number) {
  const row = await db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE entity_id = ? AND account_number = ?',
    [ENTITY_ID, number]
  );
  if (!row) throw new Error(`Account ${number} not found`);
  return row;
}

async function postBalancedJe(db, { jeNumber, description, postingDate, userId, lines, memo }) {
  const existing = await db.get(
    `SELECT id FROM journal_entries WHERE entity_id = ? AND je_number = ? AND status = 'POSTED' AND reversed_by_je_id IS NULL`,
    [ENTITY_ID, jeNumber]
  );
  if (existing) return { skipped: true, journalId: existing.id, jeNumber };

  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of lines) {
    totalDebit += Number(l.debit || 0);
    totalCredit += Number(l.credit || 0);
  }
  if (Math.round(totalDebit * 100) !== Math.round(totalCredit * 100)) {
    throw new Error(`Unbalanced JE ${jeNumber}: ${totalDebit} != ${totalCredit}`);
  }

  const jeId = `je-${uuidv4()}`;
  await db.run(
    `INSERT INTO journal_entries
     (id, entity_id, je_number, description, posting_date, status, created_by, memo, total_debit, total_credit)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [jeId, ENTITY_ID, jeNumber, description, postingDate, userId, memo || null, totalDebit.toFixed(2), totalCredit.toFixed(2)]
  );
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await db.run(
      `INSERT INTO journal_entry_lines
       (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`jel-${uuidv4()}`, jeId, l.accountId, l.debit || 0, l.credit || 0, l.description || description, i + 1]
    );
  }
  await postJournalEntryToGl(db, { journalId: jeId, entityId: ENTITY_ID, userId });
  return { posted: true, journalId: jeId, jeNumber };
}

async function safeReverse(db, journalId, userId, reversalDate) {
  const je = await db.get(
    `SELECT id, description, reversed_by_je_id, status FROM journal_entries WHERE id = ? AND entity_id = ?`,
    [journalId, ENTITY_ID]
  );
  if (!je) return { skipped: true, reason: 'not found', journalId };
  if (je.reversed_by_je_id) return { skipped: true, reason: 'already reversed', journalId };
  if (je.status !== 'POSTED') return { skipped: true, reason: `status ${je.status}`, journalId };
  const result = await reverseJournalEntry(db, {
    journalId,
    entityId: ENTITY_ID,
    userId,
    reversalDate,
    memo: 'Reverse to re-date conversion clearing to 2026-01-01 for month-close suspense gate',
  });
  return { reversed: true, journalId, ...result };
}

/**
 * Make suspense clean as of 2026-01-01 so Jan–Jun 2026 period closes can pass.
 */
export async function clearConversionSuspenseFor2026(db, { userId = 'usr-admin' } = {}) {
  const steps = [];

  // 1) Undo Mar 31 P&L write-off + combined RE reclass (will rebuild financing-only reclass)
  steps.push({ undepositedWo: await safeReverse(db, UNDEPOSITED_WO_ID, userId, '2026-03-31') });
  steps.push({ reclass: await safeReverse(db, RECLASS_ID, userId, '2026-03-31') });

  const a1100 = await accountId(db, '1100');
  const a1021 = await accountId(db, '1021');
  const a3100 = await accountId(db, '3100');
  const a5000 = await accountId(db, '5000');
  const a1600 = await accountId(db, '1600');

  // 2) Clear Undeposited Funds as of open date → prior RE (owner-approved stale receipts)
  steps.push({
    clear1100: await postBalancedJe(db, {
      jeNumber: 'CLR-20260101-1100',
      description:
        'Clear stale Undeposited Funds (pre-2020 uncleared receipts; cash long since banked) to Retained Earnings as of 1/1/26 — re-dated for H1 2026 month-close suspense gate',
      postingDate: OPEN,
      userId,
      memo: 'Conversion clearing — owner-approved pattern 2026-07-19',
      lines: [
        { accountId: a3100.id, debit: 9866.88, credit: 0, description: 'Prior-period undeposited write-off' },
        { accountId: a1100.id, debit: 0, credit: 9866.88, description: 'Clear 1100' },
      ],
    }),
  });

  // 3) Clear Transfers In Transit opening credit → prior RE
  steps.push({
    clear1021: await postBalancedJe(db, {
      jeNumber: 'CLR-20260101-1021',
      description:
        'Clear stale Transfers In Transit opening credit ($18,014 QBO conversion) to Retained Earnings as of 1/1/26 — required for H1 2026 month-close suspense gate',
      postingDate: OPEN,
      userId,
      memo: 'Conversion clearing',
      lines: [
        { accountId: a1021.id, debit: 18014.0, credit: 0, description: 'Clear 1021' },
        { accountId: a3100.id, debit: 0, credit: 18014.0, description: 'Prior-period transit clearing' },
      ],
    }),
  });

  // 4) Rebuild financing write-off reclass to RE only (no undeposited P&L piece)
  // Keep original 3/31 financing write-off (je-1647c20e) if still posted; reclass expense → RE
  const finWo = await db.get(
    `SELECT id, reversed_by_je_id, status FROM journal_entries WHERE id = ? AND entity_id = ?`,
    [FIN_WO_ID, ENTITY_ID]
  );
  if (finWo?.status === 'POSTED' && !finWo.reversed_by_je_id) {
    steps.push({
      finReclass: await postBalancedJe(db, {
        jeNumber: 'RECLASS-20260331-FIN-RE',
        description:
          'Reclass Deferred Financing Costs write-off from Q1 2026 Interest Expense to prior-year Retained Earnings',
        postingDate: '2026-03-31',
        userId,
        memo: 'Rebuild after suspense re-date',
        lines: [
          { accountId: a3100.id, debit: 26699.91, credit: 0, description: 'To RE' },
          { accountId: a5000.id, debit: 0, credit: 26699.91, description: 'Reverse P&L expense' },
        ],
      }),
    });
  } else {
    steps.push({ finReclass: { skipped: true, reason: 'financing write-off missing/reversed', a1600: a1600.account_number } });
  }

  const suspenseJan = await checkSuspenseAccounts(db, ENTITY_ID, '2026-01-31');
  const suspenseJun = await checkSuspenseAccounts(db, ENTITY_ID, '2026-06-30');

  return {
    entityId: ENTITY_ID,
    steps,
    suspenseJan,
    suspenseJun,
    cleanForH1: suspenseJan.clean && suspenseJun.clean,
  };
}
