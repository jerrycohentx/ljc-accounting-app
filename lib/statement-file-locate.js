/**
 * Locate the correct bank OR credit-card statement PDF for reconcile viewing.
 * Hard rule: card accounts never get checking PDFs; checking never gets card PDFs.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { peekBundledStatement } from './bank-statement-view.js';
import { reconExportDir, BANKS_ROOT_DEFAULT } from '../config/recon-bank-folders.js';
import { BANK_ACCOUNTS } from '../config/bank-import-targets.js';
import { getStatementFile, saveStatementFile } from './statement-file-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/** kind bank | cc — hints required; exclude always wins. */
const ACCOUNT_STATEMENT_SPECS = {
  'ent-ljc': {
    '1000': {
      kind: 'bank',
      hints: ['ckg_260', 'ckg-260', 'simmons', '0260', 'spirit'],
      exclude: ['6508', '88007', 'amex', 'american express', 'statements-6508', 'chase card', 'united card'],
    },
    '1001': {
      kind: 'bank',
      hints: ['7367', 'lone star', 'lonestar', 'lsb'],
      exclude: ['6508', '88007', 'amex', '0260', 'simmons', '7036'],
    },
    '1002': {
      kind: 'bank',
      hints: ['1385', 'csb', 'citizens state', 'citizens'],
      exclude: ['6508', '88007', 'amex', '0260', '7367'],
    },
    '2010': {
      kind: 'cc',
      hints: ['amex', '88007', 'american express'],
      exclude: ['simmons', '0260', '7367', '7036', '6508', 'ckg', 'checking', 'spirit'],
      zipNames: ['amex'],
    },
  },
  'ent-omc': {
    '1000': {
      kind: 'bank',
      hints: ['7036', 'omc ckg', 'ckg 7036', 'ckg_7036', 'simmons'],
      exclude: ['6508', '88007', 'amex', 'statements-6508', 'chase card', 'united card', 'omc cc'],
    },
    '2011': {
      kind: 'cc',
      hints: ['6508', 'chase', 'omc cc', 'statements-6508', 'united'],
      exclude: ['7036', 'ckg', 'simmons', '0260', '7367', '88007', 'amex', 'checking', 'comm chk'],
      zipNames: ['omc cc'],
    },
  },
  'ent-gm': {
    '1000': { kind: 'bank', hints: ['graceful', 'meadows', '7292', 'wells'], exclude: ['6508', '88007', '5068', 'amex'] },
    '2011': {
      kind: 'cc',
      hints: ['5068', 'chase', 'visa', 'graceful'],
      exclude: ['7292', 'wells', '0260', '7036', '88007', 'amex'],
    },
  },
  'ent-justin': {
    '1000': { kind: 'bank', hints: ['justin'], exclude: ['6508', '88007', '5068', 'amex', '7036'] },
  },
  'ent-4jl': {
    '1000': { kind: 'bank', hints: ['4jl', '5718'], exclude: ['6508', '88007', '5068', 'amex'] },
  },
  'ent-qof': {
    '1000': { kind: 'bank', hints: ['qof'], exclude: ['6508', '88007', '5068', 'amex'] },
  },
};

function accountSpec(entityId, accountNumber) {
  const num = String(accountNumber || '');
  const spec = ACCOUNT_STATEMENT_SPECS[entityId]?.[num];
  if (spec) return spec;
  const bankMeta = (BANK_ACCOUNTS[entityId] || []).find((b) => String(b.accountNumber) === num);
  if (!bankMeta) return null;
  const isCc = /^20\d{2}$/.test(num);
  const ofx = bankMeta.ofxAccountId ? [String(bankMeta.ofxAccountId)] : [];
  return {
    kind: isCc ? 'cc' : 'bank',
    hints: [...ofx, bankMeta.name].filter(Boolean),
    exclude: isCc ? ['ckg', 'checking', 'simmons'] : ['6508', '88007', '5068', 'amex', 'statements-6508'],
  };
}

function pdfHaystack(filePath) {
  const base = path.basename(String(filePath || '')).toLowerCase();
  const member = String(filePath || '').includes('!')
    ? String(filePath).split('!').pop().toLowerCase()
    : '';
  return `${base} ${member}`.trim();
}

/** Exported for tests — reject wrong-account PDFs before attach or from DB cache. */
export function validateStatementPdfPath(filePath, entityId, accountNumber) {
  const spec = accountSpec(entityId, accountNumber);
  if (!spec) return { ok: false, reason: 'unknown-account' };
  const hay = pdfHaystack(filePath);

  for (const ex of spec.exclude || []) {
    if (hay.includes(String(ex).toLowerCase())) {
      return { ok: false, reason: `exclude:${ex}` };
    }
  }

  if (spec.kind === 'cc') {
    if (/ckg|checking|comm chk|spirit of texas|simmons bank.*statement/i.test(hay)) {
      return { ok: false, reason: 'bank-pdf-on-card-account' };
    }
    const hasHint = (spec.hints || []).some((h) => hay.includes(String(h).toLowerCase()));
    if (!hasHint) return { ok: false, reason: 'missing-card-hint' };
    return { ok: true };
  }

  if (spec.kind === 'bank') {
    if (/statements-\d{6,8}-6508|statements-\d{6,8}-5068|american express card|amex stmt/i.test(hay)) {
      return { ok: false, reason: 'card-pdf-on-bank-account' };
    }
    const hasHint = (spec.hints || []).some((h) => hay.includes(String(h).toLowerCase()));
    if (!hasHint) return { ok: false, reason: 'missing-bank-hint' };
    return { ok: true };
  }

  return { ok: false, reason: 'invalid-kind' };
}

function pdfHintsFor(entityId, accountNumber) {
  return accountSpec(entityId, accountNumber)?.hints || [];
}

function runPythonScript(script, args = []) {
  try {
    const argStr = args.map((a) => `"${String(a).replace(/"/g, '')}"`).join(' ');
    return execSync(`python -c "${script.replace(/"/g, '\\"')}" ${argStr}`, {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function isZipFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf[0] === 0x50 && buf[1] === 0x4b;
  } catch {
    return false;
  }
}

function listZipPdfMembers(zipPath) {
  const script =
    'import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([n for n in z.namelist() if n.lower().endswith(".pdf")]))';
  const out = runPythonScript(script, [zipPath]);
  if (!out) return [];
  try {
    return JSON.parse(String(out).trim() || '[]');
  } catch {
    return [];
  }
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
    else if (/\.zip$/i.test(ent.name) && isZipFile(full)) {
      for (const member of listZipPdfMembers(full)) {
        out.push(`${full}!${member}`);
      }
    }
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

function monthInPdfName(filePath, statementDate) {
  const sd = String(statementDate || '').slice(0, 10);
  const y = sd.slice(0, 4);
  const m = sd.slice(5, 7);
  if (!y || !m) return true;
  const base = pdfHaystack(filePath);
  const hasYear = base.includes(y);
  const hasMonth =
    base.includes(`-${m}-`)
    || base.includes(`_${m}_`)
    || base.includes(`${m}-`)
    || base.includes(`${m}_`)
    || base.includes(`${y}-${m}`)
    || base.includes(`${y}${m}`);
  return hasYear && hasMonth;
}

function scorePdfPath(filePath, { exactName, hints, statementDate }) {
  const base = path.basename(filePath).toLowerCase();
  if (exactName && base === String(exactName).toLowerCase()) return 1000;

  const sd = String(statementDate || '').slice(0, 10);
  let score = 0;
  for (const h of hints || []) {
    if (pdfHaystack(filePath).includes(String(h).toLowerCase())) score += 10;
  }
  if (!score) return 0;

  const y = sd.slice(0, 4);
  const m = sd.slice(5, 7);
  const d = sd.slice(8, 10);
  const hay = pdfHaystack(filePath);
  if (hay.includes(`${y}-${m}-${d}`) || hay.includes(`${y}${m}${d}`)) score += 40;
  else if (hay.includes(`${m}-${d}-${y}`) || hay.includes(`${m}_${d}_${y}`)) score += 35;
  else if (hay.includes(`${y}-${m}`) || hay.includes(`${m}-${y}`)) score += 15;

  if (/statement/i.test(hay)) score += 5;
  return score;
}

function readPdfBytes(pdfPath) {
  if (pdfPath.includes('!')) {
    const [zipPath, member] = pdfPath.split('!');
    const script =
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); sys.stdout.buffer.write(z.read(sys.argv[2]))';
    try {
      return execSync(`python -c "${script.replace(/"/g, '\\"')}" "${zipPath.replace(/"/g, '')}" "${member.replace(/"/g, '')}"`, {
        maxBuffer: 20 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  }
  if (!fs.existsSync(pdfPath)) return null;
  return fs.readFileSync(pdfPath);
}

function findPdfOnDisk(accountNumber, statementDate, entityId = null) {
  const bundled = peekBundledStatement(accountNumber, statementDate, entityId || 'ent-ljc');
  const exactName = bundled?.meta?.label || null;
  const hints = pdfHintsFor(entityId, accountNumber);
  const spec = accountSpec(entityId, accountNumber);
  const dirs = buildSearchDirs(accountNumber, statementDate);
  let best = null;
  let bestScore = 0;

  for (const dir of dirs) {
    for (const pdfPath of listPdfs(dir, 2)) {
      const valid = validateStatementPdfPath(pdfPath, entityId, accountNumber);
      if (!valid.ok) continue;
      if (!monthInPdfName(pdfPath, statementDate)) continue;

      let score = scorePdfPath(pdfPath, { exactName, hints, statementDate });
      if (score <= 0) continue;

      if (spec?.zipNames?.some((z) => pdfHaystack(pdfPath).includes(String(z).toLowerCase()))) {
        score += 8;
      }

      if (score > bestScore) {
        best = pdfPath;
        bestScore = score;
      }
    }
  }

  if (!best || bestScore < 10) return null;
  const displayName = best.includes('!') ? best.split('!').pop() : path.basename(best);
  return {
    pdfPath: best,
    fileName: displayName,
    bundledMeta: bundled?.meta || null,
    score: bestScore,
  };
}

async function purgeWrongStoredStatement(db, { entityId, accountId, statementDate, accountNumber }) {
  const date = String(statementDate || '').slice(0, 10);
  const rows = await db.all(
    `SELECT statement_date, file_name FROM bank_statement_files
     WHERE entity_id = ? AND account_id = ?`,
    [entityId, accountId]
  );
  for (const row of rows || []) {
    const valid = validateStatementPdfPath(row.file_name || '', entityId, accountNumber);
    if (valid.ok) continue;
    await db.run(
      'DELETE FROM bank_statement_files WHERE entity_id = ? AND account_id = ? AND statement_date = ?',
      [entityId, accountId, String(row.statement_date).slice(0, 10)]
    );
    console.warn(
      `statement-file-locate: purged wrong PDF for ${entityId} ${accountNumber} ${row.statement_date}: ${row.file_name} (${valid.reason})`
    );
  }
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

  if (accountNumber) {
    await purgeWrongStoredStatement(db, { entityId, accountId, statementDate: date, accountNumber });
  }

  let row = await getStatementFile(db, { entityId, accountId, statementDate: date });
  if (row?.file_data) {
    const valid = validateStatementPdfPath(row.file_name || '', entityId, accountNumber);
    if (valid.ok) return { ...row, source: 'database' };
    await db.run(
      'DELETE FROM bank_statement_files WHERE entity_id = ? AND account_id = ? AND statement_date = ?',
      [entityId, accountId, date]
    );
    row = null;
  }

  if (!discover || !accountNumber) return null;

  const hit = findPdfOnDisk(accountNumber, date, entityId);
  if (!hit?.pdfPath) return null;

  let pdfBuf;
  try {
    pdfBuf = readPdfBytes(hit.pdfPath);
    if (!pdfBuf) throw new Error('empty read');
  } catch (err) {
    console.warn('statement-file-locate read failed:', hit.pdfPath, err.message);
    return null;
  }

  const pdfBase64 = pdfBuf.toString('base64');
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
