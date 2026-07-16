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

/**
 * The account this entity holds for a given bank-account last4 — the inverse of
 * expectedAcctLast4. Lets a statement uploaded against the WRONG account be
 * routed to the RIGHT one instead of merely refused: the statement itself is the
 * authority on which account it belongs to.
 */
async function accountForLast4(db, entityId, last4) {
  const spec = (BANK_ACCOUNTS[entityId] || []).find(
    (b) => b.ofxAccountId && String(b.ofxAccountId).slice(-4) === String(last4)
  );
  if (!spec) return null;
  return db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, spec.accountNumber]
  );
}

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/**
 * Import OFX or bank-statement PDF.
 *
 * TWO MODES, and the difference is the whole ballgame:
 *
 * createEntries=false (the RECONCILE screen and prepare's folder auto-load):
 *   statement LINES ONLY — import_transactions rows with journal_entry_id NULL,
 *   for side-by-side matching. NEVER creates journal entries. Reconciliation
 *   consumes statements; creating register entries is Bank Import's job. This is
 *   what makes re-uploading a statement harmless: lines dedup against existing
 *   lines, and there are no entries to duplicate. (Before this, every upload of
 *   an already-drafted month minted a full duplicate set of draft JEs — 2026-07-16
 *   a double-click created 74 rows/42 duplicate drafts, $2.43M of double-count
 *   risk sitting in the review list.)
 *
 * createEntries=true (email statement ingest):
 *   keeps creating draft entries as designed, BUT the register-coverage dedup now
 *   sees DRAFT journal entries too — the old check consulted POSTED GL only, so a
 *   statement arriving for a fully-drafted month re-created everything.
 */
export async function importStatementForReconcile(db, {
  entityId,
  accountId,
  userId,
  ofxContent = null,
  pdfBase64 = null,
  fileName = 'statement',
  autoPost = true,
  createEntries = true,
}) {
  let account = await db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE id = ? AND entity_id = ?',
    [accountId, entityId]
  );
  if (!account) throw new Error('Account not found');

  // Cross-account handling: the statement itself is the authority on which
  // account it belongs to. When the statement identifies a DIFFERENT account
  // that this entity holds, ROUTE the import there and tell the caller —
  // uploading "the statement in hand" should just work regardless of which
  // account the screen happened to be sitting on (its default is Lone Star,
  // which is exactly how a Simmons statement got refused/misfiled repeatedly
  // on 2026-07-16). Refusal remains only for statements this entity has no
  // matching account for.
  const wantLast4 = expectedAcctLast4(entityId, account.account_number);
  let redirected = null;
  const routeOrRefuse = async (stmtLast4, bankName) => {
    if (!wantLast4 || !stmtLast4 || stmtLast4 === wantLast4) return;
    const right = await accountForLast4(db, entityId, stmtLast4);
    if (!right) {
      throw new Error(
        `This statement is for account ****${stmtLast4}${bankName ? ` (${bankName})` : ''}, `
        + `which does not match ${account.account_name} (****${wantLast4}) or any other account set up for this entity. `
        + 'Import canceled to prevent cross-account contamination.'
      );
    }
    redirected = {
      fromAccountId: accountId,
      fromAccountName: account.account_name,
      accountId: right.id,
      accountNumber: right.account_number,
      accountName: right.account_name,
      statementLast4: stmtLast4,
      bankName: bankName || null,
    };
    account = right;
    accountId = right.id;
  };

  let transactions = [];
  let meta = { fileName, source: null };

  if (ofxContent) {
    const parsed = parseOFX(ofxContent, { strict: false });
    if (!parsed.success) {
      throw new Error((parsed.errors || ['OFX parse failed']).join('; '));
    }
    const stmtLast4 = parsed.accountId ? String(parsed.accountId).slice(-4) : null;
    await routeOrRefuse(stmtLast4, null);
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

    // Route (or refuse) BEFORE mergeStatementJson — merging into the wrong
    // account's bundled JSON is exactly what contaminated Lone Star with
    // Simmons balances on 2026-07-16.
    const pdfLast4 = data.meta?.accountLast4 ? String(data.meta.accountLast4) : null;
    await routeOrRefuse(pdfLast4, data.meta?.bankName || null);

    data.file = fileName;
    transactions = data.transactions || [];
    meta = {
      ...meta,
      source: 'pdf',
      statementAccountLast4: pdfLast4,
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

  // Normalize any date shape (Date object, ISO string, or OFX YYYYMMDD) to YYYY-MM-DD.
  const normDay = (v) => {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = String(v || '');
    if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    return s.slice(0, 10);
  };
  const absCents = (n) => Math.round(Math.abs(Number(n) || 0) * 100);

  // REGISTER-COVERAGE dedup (date + absolute amount, consumable): which statement
  // transactions already exist in the register? Consults BOTH posted GL and DRAFT
  // journal lines on this bank account — the old POSTED-only check is what let a
  // statement upload re-create every entry of a fully-drafted month.
  let newTransactions = dedup.newTransactions;
  let alreadyBooked = 0;
  try {
    const glRows = await db.all(
      `SELECT gl.posting_date AS d, gl.debit AS dr, gl.credit AS cr
         FROM general_ledger gl
         JOIN journal_entries je ON je.id = gl.journal_entry_id
        WHERE gl.entity_id = ? AND gl.account_id = ? AND je.status = 'POSTED'`,
      [entityId, accountId]
    );
    const draftRows = await db.all(
      `SELECT je.posting_date AS d, jel.debit AS dr, jel.credit AS cr
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.entity_id = ? AND jel.account_id = ? AND je.status = 'DRAFT'`,
      [entityId, accountId]
    );
    const booked = new Map();
    for (const r of [...glRows, ...draftRows]) {
      const key = `${normDay(r.d)}|${absCents((Number(r.dr) || 0) - (Number(r.cr) || 0))}`;
      booked.set(key, (booked.get(key) || 0) + 1);
    }
    const kept = [];
    for (const t of newTransactions) {
      const key = `${normDay(t.date || t.postingDate)}|${absCents(t.amount)}`;
      if (booked.get(key) > 0) { booked.set(key, booked.get(key) - 1); alreadyBooked += 1; }
      else kept.push(t);
    }
    // Only the ENTRY-CREATING path consumes this filter. Statement LINES are wanted
    // for every statement transaction regardless of register coverage — a line's
    // whole purpose is to be matched against its register entry.
    if (createEntries) newTransactions = kept;
  } catch {
    // If the ledger lookup fails, fall back to fitid-dedup only — never block the import.
    newTransactions = dedup.newTransactions;
    alreadyBooked = 0;
  }

  const importId = `imp-recon-${uuidv4()}`;
  let posted = 0;
  let imported = 0;
  let lineDuplicates = 0;

  if (!createEntries) {
    // ---- STATEMENT LINES ONLY — journal_entry_id stays NULL; no entries, ever. ----
    // Idempotency: dedup against lines that already exist for this account (any
    // batch, any status except REJECTED), signed amount + date, consumable. A
    // re-upload — or a double-click — adds nothing the second time.
    const signedCents = (n) => Math.round((Number(n) || 0) * 100);
    const existingLines = await db.all(
      `SELECT date AS d, amount AS a FROM import_transactions
        WHERE entity_id = ? AND account_id = ? AND status != 'REJECTED'`,
      [entityId, accountId]
    );
    const have = new Map();
    for (const r of existingLines) {
      const key = `${normDay(r.d)}|${signedCents(r.a)}`;
      have.set(key, (have.get(key) || 0) + 1);
    }
    for (const [i, t] of newTransactions.entries()) {
      const key = `${normDay(t.date || t.postingDate)}|${signedCents(t.amount)}`;
      if (have.get(key) > 0) { have.set(key, have.get(key) - 1); lineDuplicates += 1; continue; }
      await db.run(
        `INSERT INTO import_transactions (
          id, fitid, import_id, entity_id, account_id, journal_entry_id,
          date, amount, description, status, created_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'DRAFT', ?)`,
        [
          `imp-txn-${uuidv4()}`,
          t.fitid || `stmtline-${importId}-${i}`,
          importId,
          entityId,
          accountId,
          normDay(t.date || t.postingDate),
          t.amount,
          t.description || '',
          new Date().toISOString(),
        ]
      );
      imported += 1;
    }
  } else if (newTransactions.length > 0) {
    // ---- ENTRY-CREATING path (email statement ingest) — unchanged behavior,
    // now protected by the draft-aware register dedup above. ----
    await commitBankImportTransactions(db, {
      entityId,
      transactions: newTransactions,
      importId,
      userId,
      sourceLabel: `Reconcile: ${fileName}`,
      bankAccountNumber: account.account_number,
    });
    imported = newTransactions.length;

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
    imported,
    skippedDuplicates: dedup.duplicateCount + lineDuplicates,
    alreadyBooked,
    posted,
    importId,
    redirected,
    meta,
    beginningBalance: meta.previousBalance != null ? Number(meta.previousBalance) : null,
    endingBalance: meta.currentBalance != null ? Number(meta.currentBalance) : null,
    statementDate: meta.periodEnd || meta.dateRange?.end || null,
  };
}
