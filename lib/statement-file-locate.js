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
  'ent-ljc': {
    '1000': ['ckg_260', 'ckg-260', 'simmons', '0260', 'spirit'],
    '1001': ['7367', 'lone star', 'lonestar', 'lsb'],
    '1002': ['csb', '1385', 'citizens state'],
    '2010': ['amex', '88007', 'american express'],
  },
  'ent-omc': {
    '1000': ['omc', '7036', 'ckg 7036', 'ckg_7036'],
  },
  'ent-justin': {
    '1000': ['justin', 'financial'],
  },
  'ent-gm': {
    '1000': ['graceful', 'meadows', 'gm '],
  },
  'ent-4jl': {
    '1000': ['4j', '4jl'],
  },
  'ent-qof': {
    '1000': ['qof'],
  },
};

function pdfHintsFor(entityId, accountNumber) {
  const byEntity = ACCOUNT_PDF_HINTS[entityId] || {};
  if (byEntity[String(accountNumber)]) return byEntity[String(accountNumber)];
  // Never fall back to LJC 1000 hints for sister entities — that attached
  // Simmons …0260 May PDFs onto OMC / GM / Justin January recons.
  if (entityId && entityId !== 'ent-ljc') return [`${entityId}`.replace(/^ent-/, '')];
  return ACCOUNT_PDF_HINTS['ent-ljc']?.[String(accountNumber)] || [];
}

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
  dirs.push(path.join(ROOT, 'data/bank-imports/OMC'));
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

function findPdfOnDisk(accountNumber, statementDate, entityId = null) {
  const bundled = peekBundledStatement(accountNumber, statementDate, entityId || 'ent-ljc');
  const exactName = bundled?.meta?.label || null;
  const hints = pdfHintsFor(entityId, accountNumber);
  const dirs = buildSearchDirs(accountNumber, statementDate);
  let best = null;
  let bestScore = 0;

  const sd = String(statementDate || '').slice(0, 10);
  const y = sd.slice(0, 4);
  const m = sd.slice(5, 7);

  for (const dir of dirs) {
    for (const pdfPath of listPdfs(dir, 2)) {
      let score = scorePdfPath(pdfPath, { exactName, hints, statementDate });
      if (score <= 0) continue;
      // Require the filename to reference this statement's year+month so a May
      // Simmons PDF cannot attach to a January ending date.
      if (y && m) {
        const base = path.basename(pdfPath).toLowerCase();
        const hasYear = base.includes(y);
        const hasMonth = base.includes(`-${m}-`) || base.includes(`_${m}_`)
          || base.includes(`${m}-`) || base.includes(`${m}_`)
          || base.includes(`${y}-${m}`) || base.includes(`${y}${m}`);
        if (!hasYear || !hasMonth) continue;
      }
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

  const hit = findPdfOnDisk(accountNumber, date, entityId);
  if (!hit?.pdfPath) return null;

  let pdfBase64;
  try {
    pdfBase64 = fs.readFileSync(hit.pdfPath).toString('base64');
  } catch (err) {
    console.warn('statement-file-locate read failed:', hit.pdfPath, err.message);
    return null;
  }

  // Always index under the reconcile statementDate Jerry opened (e.g. 2026-01-31).
  // Simmons cycles often end on the 1st of next month (2026-02-01) — also store
  // that key so either date finds the same PDF. Never only-store periodEnd or
  // January recon cannot load a file saved as February 1.
  const periodEnd = hit.bundledMeta?.periodEnd ? String(hit.bundledMeta.periodEnd).slice(0, 10) : null;
  const datesToSave = [...new Set([date, periodEnd].filter(Boolean))];
  for (const sd of datesToSave) {
    await saveStatementFile(db, {
      entityId,
      accountId,
      statementDate: sd,
      fileName: hit.fileName,
      fileMime: 'application/pdf',
      fileDataBase64: pdfBase64,
      userId,
    });
  }

  row = await getStatementFile(db, { entityId, accountId, statementDate: date });
  if (!row?.file_data) return null;
  return {
    ...row,
    source: 'discovered',
    discoveredPath: hit.pdfPath,
  };
}
