/**
 * Reconcile procedure: discovered statement PDF → bundled JSON + posted register lines.
 * Sister-entity Chase cards (OMC 2011, etc.) have no email OFX path — this fills the register
 * when Jerry opens Reconcile so the worksheet is populated automatically.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractPdfStatementFromFile } from './extract-pdf-statement.js';
import { extractChaseCcPdfFromBuffer, looksLikeChaseCcStatement } from './extract-chase-cc-pdf.js';
import { commitAmexImportTransactions } from './amex-import-commit.js';
import { v4 as uuidv4 } from 'uuid';
import { resolveStatementFile } from './statement-file-locate.js';
import { mergeStatementJson, jsonPathForAccount } from './statement-json-merge.js';
import { lookupReconciliationTarget } from './reconcile-prepare.js';
import { loadBundledStatementForImport } from './bank-statement-view.js';
import { postJournalEntryToGl } from './post-journal.js';
import { parsePdfBuffer } from './pdf-parse-compat.js';
import { BANK_ACCOUNTS } from '../config/bank-import-targets.js';
import { isLiabilityAccount } from './card-import-guards.js';

/** Prevent concurrent duplicate imports (prepare + worksheet used to double-parse PDF → OOM on Render). */
const inflightImports = new Map();

function cardLast4(entityId, accountNumber) {
  const spec = (BANK_ACCOUNTS[entityId] || []).find((b) => b.accountNumber === String(accountNumber));
  return spec?.ofxAccountId ? String(spec.ofxAccountId).slice(-4) : null;
}

async function parseStatementPdfBuffer(buf, { entityId, accountNumber }) {
  const text = await parsePdfBuffer(buf);
  const last4 = cardLast4(entityId, accountNumber);
  if (last4 && looksLikeChaseCcStatement(text, last4)) {
    return extractChaseCcPdfFromBuffer(buf, { last4, text });
  }
  const tmp = path.join(os.tmpdir(), `recon-stmt-${process.pid}-${Date.now()}.pdf`);
  fs.writeFileSync(tmp, buf);
  try {
    return await extractPdfStatementFromFile(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

async function countPostedRegisterLines(db, entityId, accountId) {
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id
     WHERE gl.entity_id = ? AND gl.account_id = ?
       AND je.status = 'POSTED'
       AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
       AND gl.reconciliation_status IS NULL`,
    [entityId, accountId]
  );
  return Number(row?.c) || 0;
}

async function runEnsureStatementRegisterFromPdf(db, opts) {
  const {
    entityId,
    accountId,
    accountNumber,
    statementDate,
    userId = 'usr-admin',
    force = false,
  } = opts;

  const account = await db.get(
    'SELECT id, account_number, account_name, account_type FROM accounts WHERE id = ? AND entity_id = ?',
    [accountId, entityId]
  );
  if (!account) return { skipped: true, reason: 'account-not-found' };

  const postedCount = await countPostedRegisterLines(db, entityId, accountId);
  const isCard = isLiabilityAccount(account) || /^20\d{2}$/.test(String(account.account_number));
  if (!force && postedCount > 1 && !isCard) {
    return { skipped: true, reason: 'register-has-activity', postedCount };
  }

  let statementFile;
  let parsed = null;
  try {
    statementFile = await resolveStatementFile(db, {
      entityId,
      accountId,
      accountNumber: account.account_number,
      statementDate,
      userId,
      discover: true,
    });
  } catch (err) {
    console.warn('resolveStatementFile (non-fatal, will use bundled JSON):', err.message);
    statementFile = null;
  }

  if (!statementFile?.file_data) {
    parsed = loadBundledStatementForImport(account.account_number, statementDate, entityId);
    if (!parsed?.transactions?.length) {
      return { skipped: true, reason: 'no-statement-pdf-or-json' };
    }
  } else {
    const buf = Buffer.isBuffer(statementFile.file_data)
      ? statementFile.file_data
      : Buffer.from(statementFile.file_data);

    try {
      parsed = await parseStatementPdfBuffer(buf, { entityId, accountNumber: account.account_number });
    } catch (err) {
      return { skipped: true, reason: 'parse-failed', error: err.message };
    } finally {
      statementFile.file_data = null;
    }
  }

  const target = lookupReconciliationTarget(entityId, account.account_number, statementDate);
  if (target?.endingBalance != null && parsed.meta?.currentBalance == null) {
    parsed.meta = parsed.meta || {};
    parsed.meta.currentBalance = target.endingBalance;
  }
  if (target?.statementDate && !parsed.meta?.periodEnd) {
    parsed.meta = parsed.meta || {};
    parsed.meta.periodEnd = target.statementDate;
  }

  if (jsonPathForAccount(account.account_number, entityId)) {
    try {
      mergeStatementJson(account.account_number, parsed, entityId);
    } catch (err) {
      console.warn('mergeStatementJson (non-fatal):', err.message);
    }
  }

  const txnCount = parsed.transactions?.length || 0;
  if (!force && isCard && postedCount >= Math.max(1, txnCount - 2)) {
    return {
      skipped: true,
      reason: 'register-coverage-ok',
      postedCount,
      statementLines: txnCount,
    };
  }

  const importResult = await importStatementFromParsed(db, {
    entityId,
    accountId,
    accountNumber: account.account_number,
    userId,
    parsed,
    fileName: statementFile?.file_name || parsed.file || 'bundled-statement.json',
  });

  let posted = 0;
  const postErrors = [];
  if (importResult.importId) {
    const rows = await db.all(
      `SELECT journal_entry_id FROM import_transactions
       WHERE import_id = ? AND entity_id = ? AND journal_entry_id IS NOT NULL`,
      [importResult.importId, entityId]
    );
    for (const row of rows) {
      try {
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
      } catch (err) {
        postErrors.push({ journalId: row.journal_entry_id, error: err.message });
        console.warn('reconcile auto-post JE failed:', row.journal_entry_id, err.message);
      }
    }
  }

  return {
    skipped: false,
    imported: importResult.imported || 0,
    posted,
    alreadyBooked: importResult.alreadyBooked || 0,
    skippedDuplicates: importResult.skippedDuplicates || 0,
    statementLines: txnCount,
    beginningBalance: importResult.beginningBalance,
    endingBalance: importResult.endingBalance,
    statementDate: importResult.statementDate || statementDate,
    redirected: importResult.redirected || null,
    postErrors: postErrors.length ? postErrors : undefined,
  };
}

async function importStatementFromParsed(db, {
  entityId,
  accountId,
  accountNumber,
  userId,
  parsed,
  fileName,
}) {
  const importId = `imp-recon-${uuidv4()}`;
  try {
    // Orphan statement rows (fitid dedup, no JE) block re-import after a failed post.
    for (const t of parsed.transactions || []) {
      if (!t.fitid) continue;
      await db.run(
        `DELETE FROM import_transactions
         WHERE entity_id = ? AND account_id = ? AND fitid = ?
           AND (journal_entry_id IS NULL OR journal_entry_id = '')`,
        [entityId, accountId, t.fitid]
      );
    }

    const cardResult = await commitAmexImportTransactions(db, {
      entityId,
      transactions: parsed.transactions || [],
      importId,
      userId,
      sourceLabel: `Reconcile: ${fileName}`,
      cardAccountNumber: String(accountNumber),
      skipMatchedPayments: true,
    });
    return {
      importId,
      imported: cardResult.createdJECount || 0,
      alreadyBooked: 0,
      skippedDuplicates: cardResult.duplicatesSkipped || 0,
      duplicateDetail: cardResult.duplicateDetail || [],
      matchedPayments: cardResult.matchedPayments || 0,
      unmatchedPayments: cardResult.unmatchedPayments || 0,
      beginningBalance: parsed.meta?.previousBalance ?? null,
      endingBalance: parsed.meta?.currentBalance ?? null,
      statementDate: parsed.meta?.periodEnd || null,
      redirected: null,
    };
  } catch (err) {
    console.error('importStatementFromParsed failed:', err.message);
    return {
      importId: null,
      imported: 0,
      error: err.message,
      beginningBalance: parsed.meta?.previousBalance ?? null,
      endingBalance: parsed.meta?.currentBalance ?? null,
      statementDate: parsed.meta?.periodEnd || null,
    };
  }
}

/**
 * Import + post statement activity when the register is empty (or thin) for a card/bank recon.
 * Idempotent — dedup skips lines already on the books.
 */
export async function ensureStatementRegisterFromPdf(db, opts) {
  const key = `${opts.entityId}|${opts.accountId}|${String(opts.statementDate || '').slice(0, 10)}`;
  if (inflightImports.has(key)) {
    return inflightImports.get(key);
  }
  const job = runEnsureStatementRegisterFromPdf(db, opts);
  inflightImports.set(key, job);
  try {
    return await job;
  } finally {
    inflightImports.delete(key);
  }
}
