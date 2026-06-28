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

  let transactions = [];
  let meta = { fileName, source: null };

  if (ofxContent) {
    const parsed = parseOFX(ofxContent, { strict: false });
    if (!parsed.success) {
      throw new Error((parsed.errors || ['OFX parse failed']).join('; '));
    }
    transactions = parsed.transactions || [];
    meta = {
      ...meta,
      source: 'ofx',
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

  const importId = `imp-recon-${uuidv4()}`;
  let posted = 0;

  if (dedup.newCount > 0) {
    await commitBankImportTransactions(db, {
      entityId,
      transactions: dedup.newTransactions,
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
    imported: dedup.newCount,
    skippedDuplicates: dedup.duplicateCount,
    posted,
    importId,
    meta,
    beginningBalance: meta.previousBalance != null ? Number(meta.previousBalance) : null,
    endingBalance: meta.currentBalance != null ? Number(meta.currentBalance) : null,
    statementDate: meta.periodEnd || meta.dateRange?.end || null,
  };
}
