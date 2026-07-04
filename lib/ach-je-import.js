/**
 * ACH Interest JE Import
 * ======================
 *
 * Imports the monthly "interest due" journal entry that the LJC LOAN SERVICING
 * app exports as a QBO-style JE CSV into this accounting app's GL (ent-ljc).
 *
 * Source file pattern (one summary JE per month, N lines):
 *   .../1 ACH lists/<YYYY>/<Month>/QBO_ACH_JE_<YYYY-MM>.csv
 *
 * CSV schema (QBO "Journal Entry" import layout):
 *   *JournalNo,*JournalDate,*AccountName,Memo,Debits,Credits,TaxCode,Description,Name,Location,Class
 *   - *JournalNo  : deterministic per-month key, e.g. "ACH-2026-07"  -> used for IDEMPOTENCY
 *   - *JournalDate: MM/DD/YYYY on the first data row (statement month)
 *   - *AccountName: QBO account path; mapped to an ent-ljc COA number below
 *   - Debits/Credits: one amount per row; the rows must balance (sum DR == sum CR)
 *
 * Design guarantees:
 *   - Double-entry balanced (rejects if DR != CR) — integer-cents math, ROUND_HALF_UP.
 *   - Entity-scoped to ent-ljc, dated to the statement month.
 *   - IDEMPOTENT — re-importing the same month never creates a duplicate JE
 *     (keyed on je_number == *JournalNo).
 *   - Append-only & auditable; NO auto-plugs. Unmapped accounts go to review
 *     (commit is rejected and the unmapped names are surfaced) rather than a catch-all.
 */

import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { postJournalEntryToGl } from './post-journal.js';

// Currency rounding: half-up, the GAAP-standard rounding for money.
Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

export const LJC_ENTITY_ID = 'ent-ljc';

/**
 * QBO AccountName (from the loan-servicing export) -> ent-ljc COA account number.
 * Keys are compared lower-cased + trimmed. Add new rows here as the loan app
 * emits new account names; unmapped names are surfaced for review, never plugged.
 */
export const ACH_ACCOUNT_MAP = {
  // Interest collected via ACH is in transit / due from the bank — a receivable.
  // Booked to 1201, a sub-account of 1200 Accounts Receivable.
  'due from - to:ach collections due from bank': '1201',
  // Monthly portfolio loan interest income (note-rate).
  'lending income:portfolio loans:interest income': '4010',
  // Penalty-rate (default) interest — tracked separately from note-rate interest.
  'lending income:portfolio loans:default interest': '4011',
  // ACH processing fees ($5/loan) collected from borrowers — fee income.
  'lending income:portfolio loans:misc': '4200',
  // NSF fee assessed to borrower on returned ACH — receivable side (asset).
  'notes receivable:lending:notes receivable-simmons dloc': '1310',
  // NSF fee charged to borrower — booked as a contra/recovery against Bank Service Charges
  // (the expense account that absorbed the bank's own NSF fee), not as fee income.
  'lending income:portfolio loans:nsf payments:bank nsf fees charged': '5200',
};

/** Parse a money cell ("36,272.35", "$1,000", "(45.00)") into a Decimal. */
function parseAmount(raw) {
  if (raw == null) return new Decimal(0);
  let s = String(raw).trim();
  if (!s) return new Decimal(0);
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, '');
  if (!s || Number.isNaN(Number(s))) return new Decimal(0);
  const d = new Decimal(s);
  return negative ? d.negated() : d;
}

/** RFC-4180-ish single line splitter that respects double quotes. */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** Parse the QBO ACH JE CSV text into { journalNo, journalDate, lines[] }. */
export function parseAchJeCsv(csvText) {
  const text = String(csvText || '').replace(/^\uFEFF/, '');
  const rawLines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!rawLines.length) throw new Error('CSV is empty');

  const header = splitCsvLine(rawLines[0]).map((h) => h.trim().replace(/^\*/, '').toLowerCase());
  const colIndex = (name) => header.indexOf(name);
  const idx = {
    journalNo: colIndex('journalno'),
    journalDate: colIndex('journaldate'),
    accountName: colIndex('accountname'),
    memo: colIndex('memo'),
    debits: colIndex('debits'),
    credits: colIndex('credits'),
    description: colIndex('description'),
  };
  if (idx.accountName < 0 || idx.debits < 0 || idx.credits < 0) {
    throw new Error(
      `CSV missing required columns (AccountName, Debits, Credits). Found: ${header.join(', ')}`
    );
  }

  let journalNo = '';
  let journalDate = '';
  const lines = [];
  for (let r = 1; r < rawLines.length; r += 1) {
    const cells = splitCsvLine(rawLines[r]);
    const get = (i) => (i >= 0 && i < cells.length ? String(cells[i]).trim() : '');
    if (!journalNo && get(idx.journalNo)) journalNo = get(idx.journalNo);
    if (!journalDate && get(idx.journalDate)) journalDate = get(idx.journalDate);

    const accountName = get(idx.accountName);
    if (!accountName) continue;
    const debit = parseAmount(get(idx.debits));
    const credit = parseAmount(get(idx.credits));
    if (debit.isZero() && credit.isZero()) continue;

    lines.push({
      accountName,
      memo: idx.memo >= 0 ? get(idx.memo) : '',
      description: idx.description >= 0 ? get(idx.description) : '',
      debit,
      credit,
    });
  }

  if (!journalNo) throw new Error('CSV missing *JournalNo (used as the idempotency key)');
  if (!lines.length) throw new Error('CSV has no journal lines');
  return { journalNo, journalDate, lines };
}

/** MM/DD/YYYY or YYYY-MM-DD (falling back to *JournalNo) -> { isoDate, yearMonth }. */
function normalizeDate(raw, journalNo) {
  const s = String(raw || '').trim();
  let iso = '';
  let m;
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    iso = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  } else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) {
    iso = `${m[1]}-${m[2]}-${m[3]}`;
  }
  if (!iso) {
    const jm = String(journalNo).match(/(\d{4})-(\d{2})/);
    if (jm) iso = `${jm[1]}-${jm[2]}-01`;
  }
  return { isoDate: iso, yearMonth: iso.slice(0, 7) };
}

async function resolveByNumber(db, entityId, accountNumber) {
  return db.get(
    'SELECT id, account_number, account_name, account_type FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, accountNumber]
  );
}

/**
 * Build a preview of the resulting balanced JE without writing anything.
 * Reports mapped lines, any unmapped accounts, balance, and idempotency state.
 */
export async function buildAchJePreview(db, { csvText, fileName, entityId = LJC_ENTITY_ID }) {
  const parsed = parseAchJeCsv(csvText);
  const { isoDate, yearMonth } = normalizeDate(parsed.journalDate, parsed.journalNo);
  const jeNumber = parsed.journalNo;

  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  const lines = [];
  const unmapped = [];

  for (const line of parsed.lines) {
    const key = line.accountName.trim().toLowerCase();
    const acctNumber = ACH_ACCOUNT_MAP[key] || null;
    const debit = line.debit.toDecimalPlaces(2);
    const credit = line.credit.toDecimalPlaces(2);
    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);

    const account = acctNumber ? await resolveByNumber(db, entityId, acctNumber) : null;
    const row = {
      sourceAccountName: line.accountName,
      mappedAccountNumber: acctNumber,
      mappedAccountName: account?.account_name || null,
      accountId: account?.id || null,
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
      memo: line.memo || line.description || '',
    };
    if (!acctNumber || !account) unmapped.push(row);
    lines.push(row);
  }

  const balanced = totalDebit.equals(totalCredit);
  const existing = await db.get(
    'SELECT id, status, posting_date, total_debit FROM journal_entries WHERE entity_id = ? AND je_number = ?',
    [entityId, jeNumber]
  );

  return {
    jeNumber,
    fileName: fileName || null,
    postingDate: isoDate,
    yearMonth,
    lines,
    unmapped,
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
    balanced,
    alreadyImported: !!existing,
    existingStatus: existing?.status || null,
    existingJeId: existing?.id || null,
    canPost: balanced && unmapped.length === 0 && (!existing || existing.status !== 'POSTED'),
  };
}

/**
 * Commit the monthly ACH interest JE. Idempotent on je_number:
 *  - already POSTED  -> skip (no duplicate)
 *  - prior DRAFT     -> replaced
 * Rejects (no plug) if unbalanced or any account is unmapped.
 */
export async function commitAchJeImport(db, { csvText, fileName, entityId = LJC_ENTITY_ID, userId = 'usr-admin' }) {
  if (entityId !== LJC_ENTITY_ID) {
    throw new Error('ACH interest import is only available for ent-ljc (LJC Financial).');
  }

  const preview = await buildAchJePreview(db, { csvText, fileName, entityId });

  if (preview.alreadyImported && preview.existingStatus === 'POSTED') {
    return {
      skipped: true,
      idempotent: true,
      reason: 'already imported',
      jeNumber: preview.jeNumber,
      jeId: preview.existingJeId,
    };
  }
  if (!preview.balanced) {
    throw new Error(
      `Out of balance: debits ${preview.totalDebit} != credits ${preview.totalCredit}. Nothing posted.`
    );
  }
  if (preview.unmapped.length) {
    const names = preview.unmapped.map((u) => u.sourceAccountName).join('; ');
    throw new Error(
      `Unmapped account(s) need review before posting (not plugged): ${names}`
    );
  }

  // Replace a prior DRAFT carrying the same key (idempotent re-import).
  if (preview.existingJeId && preview.existingStatus !== 'POSTED') {
    await db.run('DELETE FROM journal_entry_lines WHERE journal_entry_id = ?', [preview.existingJeId]);
    await db.run('DELETE FROM general_ledger WHERE journal_entry_id = ?', [preview.existingJeId]);
    await db.run('DELETE FROM journal_entries WHERE id = ?', [preview.existingJeId]);
  }

  const total = new Decimal(preview.totalDebit);
  const jeId = `je-${uuidv4()}`;
  await db.run(
    `INSERT INTO journal_entries (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [
      jeId,
      entityId,
      preview.jeNumber,
      `Monthly ACH interest JE ${preview.yearMonth} (loan servicing import${fileName ? `: ${fileName}` : ''})`,
      preview.postingDate,
      userId,
      total.toFixed(2),
      total.toFixed(2),
      'ACH-JE-IMPORT',
    ]
  );

  let lineNumber = 1;
  for (const line of preview.lines) {
    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        `jel-${uuidv4()}`,
        jeId,
        line.accountId,
        line.debit,
        line.credit,
        line.memo || `ACH interest ${preview.yearMonth}`,
        lineNumber,
      ]
    );
    lineNumber += 1;
  }

  await postJournalEntryToGl(db, { journalId: jeId, entityId, userId });

  return {
    posted: true,
    jeId,
    jeNumber: preview.jeNumber,
    postingDate: preview.postingDate,
    yearMonth: preview.yearMonth,
    totalDebit: preview.totalDebit,
    totalCredit: preview.totalCredit,
    lineCount: preview.lines.length,
  };
}
