import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { parseOFX, deduplicateTransactions } from './ofx-parser.js';
import {
  commitBankImportTransactions,
  getExistingFitidsForEntity,
} from './import-commit.js';
import { postJournalEntryToGl } from './post-journal.js';
import { seedDefaultRules } from './categorization-rules.js';
import { extractPdfStatementFromFile } from './extract-pdf-statement.js';
import { jsonPathForAccount, mergeStatementJson } from './statement-json-merge.js';
import { BANK_ACCOUNTS } from '../config/bank-import-targets.js';

/** Last 4 of a configured bank account's OFX/ACCTID, e.g. '7367' for Lone Star (1001). */
function expectedAcctLast4(entityId, accountNumber) {
  const spec = (BANK_ACCOUNTS[entityId] || []).find((b) => b.accountNumber === accountNumber);
  return spec?.ofxAccountId ? String(spec.ofxAccountId).slice(-4) : null;
}

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/**
 * Import OFX or bank-statement PDF during reconcile; optionally post to register.
 */
export async function importStatementForReconcile(db, {
  entityId,
  accountId,
  userId,
  ofxContent = null,
  pdfBase64 = null,
  fileName = 'statement',
  autoPost = true,
}) {
  const account = await db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE id = ? AND entity_id = ?',
    [accountId, entityId]
  );
  if (!account) throw new Error('Account not found');

  // Guard against cross-account contamination: the statement being imported must belong to
  // the bank account being reconciled. (This is what previously let a Simmons OFX/PDF get
  // posted into the Lone Star account.)
  const wantLast4 = expectedAcctLast4(entityId, account.account_number);

  let transactions = [];
  let meta = { fileName, source: null };

  if (ofxContent) {
    const parsed = parseOFX(ofxContent, { strict: false });
    if (!parsed.success) {
      throw new Error((parsed.errors || ['OFX parse failed']).join('; '));
    }
    const stmtLast4 = parsed.accountId ? String(parsed.accountId).slice(-4) : null;
    if (wantLast4 && stmtLast4 && stmtLast4 !== wantLast4) {
      throw new Error(
        `This statement is for account ****${stmtLast4}, but you are reconciling ${account.account_name} (****${wantLast4}). `
        + 'Import canceled to prevent cross-account contamination — upload the statement that matches this account.'
      );
    }
    transactions = parsed.transactions || [];
    meta = {
      ...meta,
      source: 'ofx',
      statementAccountLast4: stmtLast4,
      dateRange: parsed.dateRange,
      statementType: parsed.statementType,
    };
  } else if (pdfBase64) {
    const buf = Buffer.from(pdfBase64, 'base64');
    const tmp = path.join(os.tmpdir(), `recon-stmt-${Date.now()}.pdf`);
    fs.writeFileSync(tmp, buf);
    let data;
    try {
      data = await extractPdfStatementFromFile(tmp);
    } catch (nodeErr) {
      const script = path.join(ROOT, 'scripts', 'extract-simmons-pdf.py');
      try {
        const { stdout } = await execFileAsync('python3', [script, tmp], {
          maxBuffer: 25 * 1024 * 1024,
        });
        data = JSON.parse(stdout);
        if (data.error) throw new Error(data.error);
      } catch {
        throw new Error(`PDF extract failed: ${nodeErr.message}`);
      }
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }

    data.file = fileName;
    transactions = data.transactions || [];
    meta = {
      ...meta,
      source: 'pdf',
      periodStart: data.meta?.periodStart,
      periodEnd: data.meta?.periodEnd,
      previousBalance: data.meta?.previousBalance,
      currentBalance: data.meta?.currentBalance,
      bankName: data.meta?.bankName,
    };

    if (jsonPathForAccount(account.account_number)) {
      mergeStatementJson(account.account_number, data);
    }
  } else {
    throw new Error('OFX content or PDF file required');
  }

  await seedDefaultRules(db, entityId);
  const existing = await getExistingFitidsForEntity(entityId);
  const dedup = deduplicateTransactions(transactions, existing);

  // SAFEGUARD: content-dedup against already-booked ledger entries for THIS account
  // (date + absolute amount, one-to-one/consumable). fitid-dedup alone misses entries
  // that carry no bank fitid (rebuilt / Beancount / manual), which is exactly how a
  // statement upload once re-posted an entire already-booked month as duplicates.
  let newTransactions = dedup.newTransactions;
  let alreadyBooked = 0;
  try {
    // Normalize any date shape (Date object, ISO string, or OFX YYYYMMDD) to YYYY-MM-DD.
    const normDay = (v) => {
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      const s = String(v || '');
      if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
      return s.slice(0, 10);
    };
    const cents = (n) => Math.round(Math.abs(Number(n) || 0) * 100);
    const glRows = await db.all(
      `SELECT gl.posting_date AS d, gl.debit AS dr, gl.credit AS cr
         FROM general_ledger gl
         JOIN journal_entries je ON je.id = gl.journal_entry_id
        WHERE gl.entity_id = ? AND gl.account_id = ? AND je.status = 'POSTED'`,
      [entityId, accountId]
    );
    const booked = new Map();
    for (const r of glRows) {
      const key = `${normDay(r.d)}|${cents((Number(r.dr) || 0) - (Number(r.cr) || 0))}`;
      booked.set(key, (booked.get(key) || 0) + 1);
    }
    const kept = [];
    for (const t of newTransactions) {
      const key = `${normDay(t.date || t.postingDate)}|${cents(t.amount)}`;
      if (booked.get(key) > 0) { booked.set(key, booked.get(key) - 1); alreadyBooked += 1; }
      else kept.push(t);
    }
    newTransactions = kept;
  } catch {
    // If the ledger lookup fails, fall back to fitid-dedup only — never block the import.
    newTransactions = dedup.newTransactions;
  }

  const importId = `imp-recon-${uuidv4()}`;
  let posted = 0;

  if (newTransactions.length > 0) {
    await commitBankImportTransactions(db, {
      entityId,
      transactions: newTransactions,
      importId,
      userId,
      sourceLabel: `Reconcile: ${fileName}`,
      bankAccountNumber: account.account_number,
    });

    if (autoPost) {
      const rows = await db.all(
        'SELECT journal_entry_id FROM import_transactions WHERE import_id = ? AND entity_id = ?',
        [importId, entityId]
      );
      for (const row of rows) {
        await postJournalEntryToGl(db, {
          journalId: row.journal_entry_id,
          entityId,
          userId,
        });
        await db.run(
          "UPDATE import_transactions SET status = 'RECONCILED' WHERE journal_entry_id = ? AND entity_id = ?",
          [row.journal_entry_id, entityId]
        );
        posted += 1;
      }
    }
  }

  return {
    imported: newTransactions.length,
    skippedDuplicates: dedup.duplicateCount,
    alreadyBooked,
    posted,
    importId,
    meta,
    beginningBalance: meta.previousBalance != null ? Number(meta.previousBalance) : null,
    endingBalance: meta.currentBalance != null ? Number(meta.currentBalance) : null,
    statementDate: meta.periodEnd || meta.dateRange?.end || null,
  };
}
