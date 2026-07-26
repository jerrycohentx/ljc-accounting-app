/**
 * Locate a bank-statement PDF on disk (Downloads, OneDrive bank folders,
 * data/bank-imports) and persist it for side-by-side reconcile viewing.
 *
 * Cloud deployments only see paths that exist on the server; once a PDF is
 * saved to bank_statement_files it is returned from the DB on later visits.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { peekBundledStatement } from './bank-statement-view.js';
import { reconExportDir, BANKS_ROOT_DEFAULT } from '../config/recon-bank-folders.js';
import { getStatementFile, saveStatementFile } from './statement-file-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const ACCOUNT_PDF_HINTS = {
  '1000': ['ckg_260', 'ckg-260', 'simmons', '0260', 'spirit'],
  '1001': ['7367', 'lone star', 'lonestar', 'lsb'],
  '1002': ['csb', '1385', 'citizens state'],
  '2010': ['amex', '88007', 'american express'],
};

function listPdfs(dir, maxDepth = 2, depth = 0) {
  if (!dir || depth > maxDepth || !fs.existsSync(dir)) return [];
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listPdfs(full, maxDepth, depth + 1));
    else if (/\.pdf$/i.test(ent.name)) out.push(full);
  }
  return out;
}

function buildSearchDirs(accountNumber, statementDate) {
  const dirs = [];
  const fromEnv = (process.env.STATEMENT_SEARCH_DIRS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  dirs.push(...fromEnv);

  const profile = process.env.USERPROFILE || process.env.HOME;
  if (profile) {
    dirs.push(path.join(profile, 'Downloads'));
    dirs.push(path.join(profile, 'OneDrive', 'Downloads'));
    dirs.push(path.join(profile, 'OneDrive', 'Desktop', 'Downloads-Jerry OneDrive'));
  }
  dirs.push('C:\\Users\\jerry\\Downloads');
  dirs.push('C:\\Users\\jerry\\OneDrive\\Desktop\\Downloads-Jerry OneDrive');
  dirs.push(path.join(ROOT, 'data/bank-imports/LJC'));
  dirs.push(path.join(ROOT, 'data/bank-imports'));

  try {
    const banksRoot = process.env.RECON_BANKS_ROOT || BANKS_ROOT_DEFAULT;
    const { dir, bankFolder } = reconExportDir(accountNumber, statementDate, banksRoot);
    dirs.push(dir);
    dirs.push(path.dirname(dir));
    dirs.push(path.join(banksRoot, bankFolder));
  } catch {
    /* invalid date */
  }

  return [...new Set(dirs.filter((d) => d && fs.existsSync(d)))];
}

function scorePdfPath(filePath, { exactName, hints, statementDate }) {
  const base = path.basename(filePath).toLowerCase();
  if (exactName && base === String(exactName).toLowerCase()) return 1000;

  const sd = String(statementDate || '').slice(0, 10);
  let score = 0;
  for (const h of hints || []) {
    if (base.includes(String(h).toLowerCase())) score += 10;
  }
  if (!score) return 0;

  const y = sd.slice(0, 4);
  const m = sd.slice(5, 7);
  const d = sd.slice(8, 10);
  if (base.includes(`${y}-${m}-${d}`) || base.includes(`${y}${m}${d}`)) score += 40;
  else if (base.includes(`${m}-${d}-${y}`) || base.includes(`${m}_${d}_${y}`)) score += 35;
  else if (base.includes(`${y}-${m}`) || base.includes(`${m}-${y}`)) score += 15;

  if (/statement/i.test(base)) score += 5;
  return score;
}

function findPdfOnDisk(accountNumber, statementDate) {
  const bundled = peekBundledStatement(accountNumber, statementDate);
  const exactName = bundled?.meta?.label || null;
  const hints = ACCOUNT_PDF_HINTS[String(accountNumber)] || [];
  const dirs = buildSearchDirs(accountNumber, statementDate);
  let best = null;
  let bestScore = 0;

  for (const dir of dirs) {
    for (const pdfPath of listPdfs(dir, 2)) {
      const score = scorePdfPath(pdfPath, { exactName, hints, statementDate });
      if (score > bestScore) {
        best = pdfPath;
        bestScore = score;
      }
    }
  }

  if (!best || bestScore < 10) return null;
  return {
    pdfPath: best,
    fileName: path.basename(best),
    bundledMeta: bundled?.meta || null,
    score: bestScore,
  };
}

/**
 * Return stored statement PDF, or discover on disk, save, and return.
 */
export async function resolveStatementFile(db, {
  entityId,
  accountId,
  accountNumber,
  statementDate,
  userId = null,
  discover = true,
}) {
  const date = String(statementDate || '').slice(0, 10);
  if (!entityId || !accountId || !date) return null;

  let row = await getStatementFile(db, { entityId, accountId, statementDate: date });
  if (row?.file_data) {
    return { ...row, source: 'database' };
  }

  if (!discover || !accountNumber) return null;

  const hit = findPdfOnDisk(accountNumber, date);
  if (!hit?.pdfPath) return null;

  let pdfBase64;
  try {
    pdfBase64 = fs.readFileSync(hit.pdfPath).toString('base64');
  } catch (err) {
    console.warn('statement-file-locate read failed:', hit.pdfPath, err.message);
    return null;
  }

  const saveDate = hit.bundledMeta?.periodEnd || date;
  await saveStatementFile(db, {
    entityId,
    accountId,
    statementDate: saveDate,
    fileName: hit.fileName,
    fileMime: 'application/pdf',
    fileDataBase64: pdfBase64,
    userId,
  });

  row = await getStatementFile(db, { entityId, accountId, statementDate: date });
  if (!row?.file_data) return null;
  return {
    ...row,
    source: 'discovered',
    discoveredPath: hit.pdfPath,
  };
}
