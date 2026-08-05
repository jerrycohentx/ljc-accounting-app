/**
 * Fix OMC Jan 2026 recon: beginning/ending from …7036 PDF, attach statement PDF.
 * Usage: node scripts/fix-omc-jan-recon.mjs
 * Uses DATABASE_URL from .env (production Postgres when set).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { getDatabase } from '../config/database.js';
import { ensureStatementFileSchema, saveStatementFile } from '../lib/statement-file-schema.js';
import { extractPdfStatementFromFile } from '../lib/extract-pdf-statement.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const ENTITY = 'ent-omc';
const ACCOUNT_NUMBER = '1000';
const STATEMENT_DATE = '2026-01-31';
const BEGIN = 1463.62;
const END = 1983.97;

const PDF_CANDIDATES = [
  path.join(ROOT, 'data/bank-imports/OMC/OMC ckg 7036-STATEMENT-01-30-2026-37cb5a09-53fd-4103-a1d1-ac4a2e4ac0bb.pdf'),
  'C:/Users/jerry/OneDrive/Desktop/Downloads-Jerry OneDrive/OMC ckg 7036-STATEMENT-01-30-2026-37cb5a09-53fd-4103-a1d1-ac4a2e4ac0bb.pdf',
];

async function main() {
  const pdfPath = PDF_CANDIDATES.find((p) => fs.existsSync(p));
  if (!pdfPath) throw new Error('OMC Jan …7036 PDF not found');

  const parsed = await extractPdfStatementFromFile(pdfPath);
  if (Math.abs((parsed.meta?.previousBalance || 0) - BEGIN) > 0.01
    || Math.abs((parsed.meta?.currentBalance || 0) - END) > 0.01) {
    throw new Error(
      `PDF balances unexpected: prev=${parsed.meta?.previousBalance} curr=${parsed.meta?.currentBalance}`
    );
  }

  const db = await getDatabase();
  const account = await db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE entity_id = ? AND account_number = ?',
    [ENTITY, ACCOUNT_NUMBER]
  );
  if (!account) throw new Error('OMC account 1000 not found');

  const session = await db.get(
    `SELECT id, beginning_balance, ending_balance, status, notes
     FROM bank_reconciliation_sessions
     WHERE entity_id = ? AND account_id = ? AND statement_date = ?`,
    [ENTITY, account.id, STATEMENT_DATE]
  );
  if (!session) throw new Error(`No session for ${STATEMENT_DATE}`);

  console.log('Before:', {
    id: session.id,
    status: session.status,
    begin: session.beginning_balance,
    end: session.ending_balance,
  });

  await db.run(
    `UPDATE bank_reconciliation_sessions
     SET beginning_balance = ?, ending_balance = ?,
         notes = ?
     WHERE id = ?`,
    [
      BEGIN,
      END,
      'OMC Jan 2026 Simmons …7036 — begin 1463.62 / end 1983.97 from statement PDF (not LJC 11450.19)',
      session.id,
    ]
  );

  await ensureStatementFileSchema(db);
  const b64 = fs.readFileSync(pdfPath).toString('base64');
  await saveStatementFile(db, {
    entityId: ENTITY,
    accountId: account.id,
    statementDate: STATEMENT_DATE,
    fileName: path.basename(pdfPath),
    fileMime: 'application/pdf',
    fileDataBase64: b64,
    userId: 'usr-admin',
  });
  // Also store under statement periodEnd (2/01) for fuzzy lookup.
  if (parsed.meta?.periodEnd && parsed.meta.periodEnd !== STATEMENT_DATE) {
    await saveStatementFile(db, {
      entityId: ENTITY,
      accountId: account.id,
      statementDate: parsed.meta.periodEnd,
      fileName: path.basename(pdfPath),
      fileMime: 'application/pdf',
      fileDataBase64: b64,
      userId: 'usr-admin',
    });
  }

  const after = await db.get(
    `SELECT beginning_balance, ending_balance, status, notes FROM bank_reconciliation_sessions WHERE id = ?`,
    [session.id]
  );
  const file = await db.get(
    `SELECT file_name, length(file_data) AS bytes FROM bank_statement_files
     WHERE entity_id = ? AND account_id = ? AND statement_date = ?`,
    [ENTITY, account.id, STATEMENT_DATE]
  );

  console.log('After:', after);
  console.log('Statement file:', file);
  console.log('OK — beginning should be', BEGIN, 'ending', END);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
