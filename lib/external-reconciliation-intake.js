/**
 * Claude → Cursor external reconciliation intake.
 *
 * Shared bytes live in THIS git repo under
 *   05_Application_Code/ops/state/external_reconciliation_inbox/<packageId>/
 *
 * Claude writes only to claude/. Cursor writes only to cursor/.
 * Missing or mismatched hashes are a hard STOP. Claude conclusions are
 * UNVERIFIED until independently checked against current LJCOS.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const INBOX_REL = '05_Application_Code/ops/state/external_reconciliation_inbox';

export const CLAUDE_OWNED_NAMES = new Set([
  'MANIFEST.sha256',
  'source_manifest.csv',
  'PACKAGE.json',
  'CLAUDE_CONCLUSIONS.json',
  'PROPOSED_CORRECTIONS.json',
]);

export const CURSOR_OWNED_PREFIXES = [
  'CURSOR_',
  'VERIFIED_',
  'INTAKE_',
  'LJCOS_',
  'HANDOFF_',
  'CLASSIFICATION_',
];

export function isCursorOwnedName(name) {
  const base = path.basename(name);
  if (CURSOR_OWNED_PREFIXES.some((p) => base.startsWith(p))) return true;
  return false;
}

export function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function parseSha256Manifest(text) {
  const rows = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (!m) {
      throw new Error(`MANIFEST.sha256 unreadable line: ${line}`);
    }
    rows.push({ sha256: m[1].toLowerCase(), fileName: m[2].trim().replace(/^\.\//, '') });
  }
  return rows;
}

export function parseSourceManifestCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) return [];
  const header = lines[0].split(',').map((s) => s.trim().toLowerCase());
  const pathIdx = header.findIndex((h) => h === 'path' || h === 'file' || h === 'filename');
  const hashIdx = header.findIndex((h) => h === 'sha256' || h === 'hash' || h === 'checksum');
  if (pathIdx < 0 || hashIdx < 0) {
    throw new Error('source_manifest.csv must have path,sha256 columns');
  }
  const rows = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(',').map((s) => s.trim());
    if (cols.length <= Math.max(pathIdx, hashIdx)) continue;
    rows.push({
      path: cols[pathIdx].replace(/^\.\//, ''),
      sha256: String(cols[hashIdx] || '').toLowerCase(),
      role: header.includes('role') ? cols[header.indexOf('role')] : null,
    });
  }
  return rows;
}

export function packagePaths(repoRoot, packageId) {
  const root = path.join(repoRoot, INBOX_REL, packageId);
  return {
    root,
    claudeDir: path.join(root, 'claude'),
    cursorDir: path.join(root, 'cursor'),
  };
}

function stop(errors, extra = {}) {
  return {
    ok: false,
    stop: true,
    claudeConclusions: 'UNVERIFIED',
    errors,
    ...extra,
  };
}

/**
 * Verify a package on disk. Does not call LJCOS (network is the CLI wrapper).
 */
export function verifyPackageOnDisk(repoRoot, packageId, { proposedJournals = [] } = {}) {
  const paths = packagePaths(repoRoot, packageId);
  const errors = [];
  const warnings = [];
  const verifiedFiles = [];

  if (!fs.existsSync(paths.root)) {
    return stop([`Package folder missing: ${path.relative(repoRoot, paths.root)}`]);
  }
  if (!fs.existsSync(paths.claudeDir)) {
    return stop([
      `claude/ folder missing under ${packageId}. Claude originals were never deposited in this git repo.`,
      'Do not recreate Claude files and represent them as originals.',
    ], { packageRoot: paths.root });
  }

  const manifestPath = path.join(paths.claudeDir, 'MANIFEST.sha256');
  if (!fs.existsSync(manifestPath)) {
    return stop([
      `STOP: ${packageId}/claude/MANIFEST.sha256 is missing.`,
      'Cursor cannot checksum Claude originals. Do not analyze proposed corrections.',
    ], { packageRoot: paths.root, claudeDir: paths.claudeDir });
  }

  let manifestRows;
  try {
    manifestRows = parseSha256Manifest(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return stop([`STOP: MANIFEST.sha256 parse failed: ${e.message}`]);
  }
  if (!manifestRows.length) {
    return stop(['STOP: MANIFEST.sha256 is empty.']);
  }

  for (const row of manifestRows) {
    if (isCursorOwnedName(row.fileName) || row.fileName.startsWith('cursor/')) {
      errors.push(`MANIFEST lists Cursor-owned file ${row.fileName} — Claude must not checksum Cursor output.`);
      continue;
    }
    const abs = path.join(paths.claudeDir, row.fileName);
    if (!fs.existsSync(abs)) {
      errors.push(`STOP: MANIFEST file missing: claude/${row.fileName}`);
      continue;
    }
    const actual = sha256File(abs);
    if (actual !== row.sha256) {
      errors.push(`STOP: hash mismatch claude/${row.fileName} expected ${row.sha256} actual ${actual}`);
      continue;
    }
    verifiedFiles.push({ fileName: row.fileName, sha256: actual, role: 'claude' });
  }

  const sourceCsvPath = path.join(paths.claudeDir, 'source_manifest.csv');
  if (!fs.existsSync(sourceCsvPath)) {
    errors.push('STOP: claude/source_manifest.csv is missing.');
  } else {
    let sourceRows;
    try {
      sourceRows = parseSourceManifestCsv(fs.readFileSync(sourceCsvPath, 'utf8'));
    } catch (e) {
      errors.push(`STOP: source_manifest.csv parse failed: ${e.message}`);
      sourceRows = [];
    }
    for (const row of sourceRows) {
      const abs = path.join(paths.claudeDir, row.path);
      if (!fs.existsSync(abs)) {
        errors.push(`STOP: source document missing: claude/${row.path}`);
        continue;
      }
      const actual = sha256File(abs);
      if (actual !== row.sha256) {
        errors.push(`STOP: source hash mismatch claude/${row.path} expected ${row.sha256} actual ${actual}`);
        continue;
      }
      verifiedFiles.push({ fileName: row.path, sha256: actual, role: row.role || 'source' });
    }
  }

  const alreadyReversed = [];
  for (const je of proposedJournals) {
    if (je && je.reversed_by_je_id) {
      alreadyReversed.push({
        journalId: je.id || je.journalId,
        jeNumber: je.je_number || je.jeNumber,
        reversedBy: je.reversed_by_je_id,
      });
      errors.push(
        `STOP: proposed reversal ${je.je_number || je.id} is already reversed by ${je.reversed_by_je_id}.`
      );
    }
  }

  const claudeConclusionsPath = path.join(paths.claudeDir, 'CLAUDE_CONCLUSIONS.json');
  const claudeConclusionsStatus = fs.existsSync(claudeConclusionsPath)
    ? 'UNVERIFIED'
    : 'UNVERIFIED_MISSING';

  if (errors.length) {
    return {
      ok: false,
      stop: true,
      claudeConclusions: claudeConclusionsStatus,
      errors,
      warnings,
      verifiedFiles,
      alreadyReversed,
      packageRoot: paths.root,
    };
  }

  return {
    ok: true,
    stop: false,
    claudeConclusions: claudeConclusionsStatus,
    errors: [],
    warnings,
    verifiedFiles,
    alreadyReversed,
    packageRoot: paths.root,
    claudeDir: paths.claudeDir,
    cursorDir: paths.cursorDir,
  };
}

export function assertCursorDidNotWriteClaude(repoRoot, packageId) {
  const { claudeDir } = packagePaths(repoRoot, packageId);
  if (!fs.existsSync(claudeDir)) return [];
  const bad = [];
  for (const name of fs.readdirSync(claudeDir)) {
    if (isCursorOwnedName(name)) bad.push(name);
  }
  return bad;
}
