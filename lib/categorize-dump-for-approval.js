/**
 * Find 2026 dump-account (uncategorized) bank/card lines, propose categories,
 * attach statement PDFs as source documents, and create DRAFT reclass journals
 * for Jerry to approve in Journals / Review.
 *
 * Does NOT silent-post into closed periods — drafts wait for approval.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { categorizeTransaction, seedDefaultRules } from './categorization-rules.js';
import { learnCategorizationFromHistory } from './learn-categorization-from-history.js';
import { normalizeIsoDate } from './bank-statement-view.js';
import { getStatementFile } from './statement-file-schema.js';
import { FULL_CHART_OF_ACCOUNTS } from '../config/coa-full.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DEFAULT_DUMP = ['5700', '4091'];

const AMEX_PDF_BY_DATE = {
  '2026-01-09': 'data/bank-imports/LJC/amex/2026-01-09_0fb8.pdf',
  '2026-02-06': 'data/bank-imports/LJC/amex/2026-02-06_601f.pdf',
  '2026-03-09': 'data/bank-imports/LJC/amex/2026-03-09_6b56.pdf',
};

async function ensureAccount(db, entityId, number) {
  let row = await db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, number]
  );
  if (row) return row;
  const def = FULL_CHART_OF_ACCOUNTS.find(
    (a) => a.entity === entityId && a.number === number
  );
  if (!def) return null;
  const id = `acc-${uuidv4()}`;
  const normal = def.type === 'ASSET' || def.type === 'EXPENSE' ? 'DEBIT' : 'CREDIT';
  await db.run(
    `INSERT INTO accounts
       (id, entity_id, account_number, account_name, account_type, normal_balance, is_active, parent_account_id)
     VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`,
    [id, entityId, def.number, def.name, def.type, normal]
  );
  return { id, account_number: def.number, account_name: def.name };
}

function matchText(row) {
  return [row.je_description, row.gl_description, row.line_description, row.memo]
    .filter(Boolean)
    .join(' ');
}

function statementDateFromDescription(text) {
  const m = String(text || '').match(
    /(?:Amex|AMEX|stmt|statement)\s+(\d{4}-\d{2}-\d{2})/i
  );
  if (m) return m[1];
  const m2 = String(text || '').match(/\b(2026-\d{2}-\d{2})\b/);
  return m2 ? m2[1] : null;
}

async function hasJeDocument(db, journalId) {
  try {
    const row = await db.get(
      'SELECT id FROM journal_entry_documents WHERE journal_entry_id = ? LIMIT 1',
      [journalId]
    );
    return !!row;
  } catch {
    return false;
  }
}

async function attachPdfToJournal(db, {
  journalId,
  fileName,
  fileMime = 'application/pdf',
  fileDataBase64,
  userId,
}) {
  if (!fileDataBase64) return false;
  await db.run(`
    CREATE TABLE IF NOT EXISTS journal_entry_documents (
      id TEXT PRIMARY KEY,
      journal_entry_id TEXT NOT NULL,
      file_name TEXT,
      file_mime TEXT,
      file_data TEXT,
      uploaded_by TEXT,
      uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.run(
    `INSERT INTO journal_entry_documents
       (id, journal_entry_id, file_name, file_mime, file_data, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [`jedoc-${uuidv4()}`, journalId, fileName, fileMime, fileDataBase64, userId]
  );
  return true;
}

async function loadSourcePdfBase64(db, { entityId, cardAccountId, statementDate }) {
  if (!statementDate) return null;
  // Prefer stored bank_statement_files (production)
  if (cardAccountId) {
    const stored = await getStatementFile(db, {
      entityId,
      accountId: cardAccountId,
      statementDate,
      fuzzyDays: 5,
    });
    if (stored?.file_data) {
      return {
        fileName: stored.file_name || `${statementDate}-statement.pdf`,
        mime: stored.file_mime || 'application/pdf',
        dataBase64: stored.file_data,
        source: 'bank_statement_files',
      };
    }
  }
  // Bundled Amex PDFs in the repo
  const rel = AMEX_PDF_BY_DATE[statementDate];
  if (rel) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) {
      return {
        fileName: path.basename(abs),
        mime: 'application/pdf',
        dataBase64: fs.readFileSync(abs).toString('base64'),
        source: 'repo',
      };
    }
  }
  return null;
}

/**
 * @returns {Promise<object>}
 */
export async function categorizeDumpForApproval(db, {
  entityId = 'ent-ljc',
  userId = 'usr-admin',
  startDate = '2026-01-01',
  endDate = '2026-12-31',
  sourceAccountNumbers = DEFAULT_DUMP,
  dryRun = false,
  learnFirst = true,
  attachDocuments = true,
  createDrafts = true,
} = {}) {
  if (learnFirst) {
    await learnCategorizationFromHistory(db, { entityId, startDate, endDate });
  } else {
    await seedDefaultRules(db, entityId);
  }

  // Ensure target accounts used by seeds exist
  for (const num of ['5410', '6120', '5910', '5730', '5740', '5750', '5720', '5300', '5400', '5710', '5000', '5200', '6100']) {
    await ensureAccount(db, entityId, num);
  }

  const sources = [];
  for (const num of sourceAccountNumbers) {
    const acct = await db.get(
      'SELECT id, account_number, account_name FROM accounts WHERE entity_id = ? AND account_number = ?',
      [entityId, num]
    );
    if (acct) sources.push(acct);
  }
  if (!sources.length) throw new Error('No dump accounts found');

  const card = await db.get(
    `SELECT id FROM accounts WHERE entity_id = ? AND account_number = '2010'`,
    [entityId]
  );

  const sourceIds = sources.map((s) => s.id);
  const sourceNums = new Set(sources.map((s) => s.account_number));

  const rows = await db.all(
    `SELECT gl.id AS gl_id, gl.debit, gl.credit, gl.posting_date, gl.description AS gl_description,
            je.id AS journal_id, je.je_number, je.description AS je_description, je.memo,
            a.account_number AS from_account_number, a.id AS from_account_id,
            jel.description AS line_description
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id
       AND je.status = 'POSTED'
       AND je.reversed_by_je_id IS NULL
       AND je.reverses_je_id IS NULL
     JOIN accounts a ON a.id = gl.account_id
     LEFT JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id AND jel.account_id = gl.account_id
       AND ABS(COALESCE(jel.debit,0) - COALESCE(gl.debit,0)) < 0.02
       AND ABS(COALESCE(jel.credit,0) - COALESCE(gl.credit,0)) < 0.02
     WHERE gl.entity_id = ?
       AND gl.account_id IN (${sourceIds.map(() => '?').join(',')})
       AND gl.posting_date >= ? AND gl.posting_date <= ?
       AND (je.je_number LIKE 'AMEX-%' OR je.je_number LIKE 'IMP-%' OR je.je_number LIKE 'RESTORE-%')
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries d
         WHERE d.entity_id = je.entity_id
           AND d.status IN ('DRAFT', 'POSTED')
           AND d.reversed_by_je_id IS NULL
           AND (
             d.memo LIKE ('reclass-rules:' || je.id || ':' || gl.id || '%')
             OR d.memo LIKE ('cat-approve:' || je.id || ':' || gl.id || '%')
           )
       )
     ORDER BY gl.posting_date, je.je_number`,
    [entityId, ...sourceIds, startDate, endDate]
  );

  const proposed = [];
  const needsReview = [];
  const docsAttached = [];
  let draftsCreated = 0;
  let docsCount = 0;

  for (const row of rows) {
    const debit = new Decimal(row.debit || 0);
    const credit = new Decimal(row.credit || 0);
    if (debit.isZero() && credit.isZero()) continue;

    const text = matchText(row);
    const cat = await categorizeTransaction(db, entityId, text);
    const postingDate = normalizeIsoDate(row.posting_date) || String(row.posting_date).slice(0, 10);
    const stmtDate = statementDateFromDescription(row.je_description) || statementDateFromDescription(text);
    const amount = Number(Decimal.max(debit, credit).toFixed(2));

    let docMeta = null;
    if (attachDocuments && !(await hasJeDocument(db, row.journal_id))) {
      const pdf = await loadSourcePdfBase64(db, {
        entityId,
        cardAccountId: card?.id,
        statementDate: stmtDate,
      });
      if (pdf) {
        if (!dryRun) {
          await attachPdfToJournal(db, {
            journalId: row.journal_id,
            fileName: pdf.fileName,
            fileMime: pdf.mime,
            fileDataBase64: pdf.dataBase64,
            userId,
          });
        }
        docsCount += 1;
        docMeta = { fileName: pdf.fileName, source: pdf.source, statementDate: stmtDate };
        docsAttached.push({ je: row.je_number, ...docMeta });
      }
    } else if (await hasJeDocument(db, row.journal_id)) {
      docMeta = { alreadyAttached: true, statementDate: stmtDate };
    }

    const appUrl = `https://ljc-accounting-app.onrender.com/journals?je=${encodeURIComponent(row.je_number)}`;
    const base = {
      journalId: row.journal_id,
      glId: row.gl_id,
      jeNumber: row.je_number,
      postingDate,
      amount,
      fromAccount: row.from_account_number,
      description: (row.je_description || text).slice(0, 160),
      statementDate: stmtDate,
      document: docMeta,
      appUrl,
    };

    if (!cat.offsetAccountId || cat.isTransfer || cat.isChargeback) {
      needsReview.push({
        ...base,
        reason: 'no_rule',
        suggestedAccount: cat.offsetAccountNumber || null,
        label: cat.label || null,
      });
      continue;
    }

    const target = await db.get(
      'SELECT id, account_number, account_name FROM accounts WHERE id = ?',
      [cat.offsetAccountId]
    );
    if (!target || sourceNums.has(target.account_number)) {
      needsReview.push({
        ...base,
        reason: 'same_or_missing_target',
        suggestedAccount: cat.offsetAccountNumber || null,
        label: cat.label || null,
      });
      continue;
    }

    const entry = {
      ...base,
      toAccount: target.account_number,
      toAccountName: target.account_name,
      label: cat.label || 'Categorized from learned rules',
      confidence: 0.9,
    };

    if (dryRun || !createDrafts) {
      proposed.push({ ...entry, dryRun: !!dryRun });
      continue;
    }

    const jeId = `je-${uuidv4()}`;
    const jeNumber = `CAT-APPR-${Date.now().toString().slice(-8)}-${uuidv4().slice(0, 6)}`;
    const memo = `cat-approve:${row.journal_id}:${row.gl_id}`;

    await db.run(
      `INSERT INTO journal_entries
         (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
      [
        jeId,
        entityId,
        jeNumber,
        `Categorize ${row.from_account_number}→${target.account_number}: ${row.je_number}`,
        postingDate,
        userId,
        amount.toFixed(2),
        amount.toFixed(2),
        memo,
      ]
    );

    if (debit.gt(0)) {
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, ?, 0, ?, 1)`,
        [`jel-${uuidv4()}`, jeId, target.id, debit.toFixed(2), entry.label]
      );
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, 0, ?, ?, 2)`,
        [`jel-${uuidv4()}`, jeId, row.from_account_id, debit.toFixed(2), `Clear ${row.from_account_number}`]
      );
    } else {
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, ?, 0, ?, 1)`,
        [`jel-${uuidv4()}`, jeId, row.from_account_id, credit.toFixed(2), `Clear ${row.from_account_number}`]
      );
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, 0, ?, ?, 2)`,
        [`jel-${uuidv4()}`, jeId, target.id, credit.toFixed(2), entry.label]
      );
    }

    // Copy source PDF onto the draft so approval screen can open it.
    if (docMeta?.fileName || stmtDate) {
      const pdf = await loadSourcePdfBase64(db, {
        entityId,
        cardAccountId: card?.id,
        statementDate: stmtDate,
      });
      if (pdf) {
        await attachPdfToJournal(db, {
          journalId: jeId,
          fileName: pdf.fileName,
          fileMime: pdf.mime,
          fileDataBase64: pdf.dataBase64,
          userId,
        });
      }
    }

    draftsCreated += 1;
    proposed.push({
      ...entry,
      draftJeId: jeId,
      draftJeNumber: jeNumber,
      approveUrl: `https://ljc-accounting-app.onrender.com/journals?status=DRAFT&je=${encodeURIComponent(jeNumber)}`,
    });
  }

  return {
    entityId,
    startDate,
    endDate,
    scanned: rows.length,
    proposedCount: proposed.length,
    needsReviewCount: needsReview.length,
    draftsCreated,
    documentsAttached: docsCount,
    dryRun,
    proposed: proposed.slice(0, 200),
    needsReview: needsReview.slice(0, 200),
    docsAttached: docsAttached.slice(0, 100),
  };
}
