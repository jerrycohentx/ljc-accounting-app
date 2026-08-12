/**
 * Intake checksum / STOP gates (no network).
 * Run: node lib/external-reconciliation-intake.test.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  parseSha256Manifest,
  parseSourceManifestCsv,
  sha256File,
  verifyPackageOnDisk,
  INBOX_REL,
} from './external-reconciliation-intake.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function write(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

function hash(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-inbox-'));
const pkgId = 'fixture_bank_0000_2026_01';
const claude = path.join(tmp, INBOX_REL, pkgId, 'claude');
fs.mkdirSync(claude, { recursive: true });
fs.mkdirSync(path.join(tmp, INBOX_REL, pkgId, 'cursor'), { recursive: true });

const stmt = 'BEGIN 1.00\nEND 2.00\n';
const conclusions = '{"difference": 0}\n';
const stmtHash = hash(stmt);
const conclHash = hash(conclusions);
write(path.join(claude, 'statement.txt'), stmt);
write(path.join(claude, 'CLAUDE_CONCLUSIONS.json'), conclusions);
write(
  path.join(claude, 'source_manifest.csv'),
  `path,sha256,role\nstatement.txt,${stmtHash},source\n`
);
const sourceCsv = fs.readFileSync(path.join(claude, 'source_manifest.csv'));
const sourceCsvHash = crypto.createHash('sha256').update(sourceCsv).digest('hex');
write(
  path.join(claude, 'MANIFEST.sha256'),
  `${stmtHash}  statement.txt\n${conclHash}  CLAUDE_CONCLUSIONS.json\n${sourceCsvHash}  source_manifest.csv\n`
);

assert(parseSha256Manifest(`${stmtHash}  statement.txt\n`).length === 1, 'parse manifest');
assert(parseSourceManifestCsv('path,sha256\nstatement.txt,' + stmtHash).length === 1, 'parse csv');
assert(sha256File(path.join(claude, 'statement.txt')) === stmtHash, 'sha256File');

const pass = verifyPackageOnDisk(tmp, pkgId);
assert(pass.ok === true, `expected pass, got ${JSON.stringify(pass.errors)}`);
assert(pass.stop === false, 'pass must not STOP');
assert(pass.claudeConclusions === 'UNVERIFIED', 'conclusions remain UNVERIFIED even when hashes match');

const mismatch = verifyPackageOnDisk(tmp, pkgId);
fs.writeFileSync(path.join(claude, 'statement.txt'), 'TAMPERED');
const failHash = verifyPackageOnDisk(tmp, pkgId);
assert(failHash.ok === false && failHash.stop === true, 'tamper must STOP');
assert(failHash.errors.some((e) => /hash mismatch/.test(e)), `tamper errors: ${failHash.errors}`);
fs.writeFileSync(path.join(claude, 'statement.txt'), stmt);

const already = verifyPackageOnDisk(tmp, pkgId, {
  proposedJournals: [{ id: 'je-1', je_number: 'JE-1', reversed_by_je_id: 'je-rev' }],
});
assert(already.stop === true, 'already-reversed must STOP');
assert(already.errors.some((e) => /already reversed/.test(e)), 'already-reversed message');

const missing = verifyPackageOnDisk(tmp, 'does_not_exist');
assert(missing.stop === true, 'missing package STOP');

const emptyClaude = 'empty_pkg_2026_01';
fs.mkdirSync(path.join(tmp, INBOX_REL, emptyClaude, 'claude'), { recursive: true });
const noManifest = verifyPackageOnDisk(tmp, emptyClaude);
assert(noManifest.stop === true, 'missing MANIFEST STOP');
assert(noManifest.errors.some((e) => /MANIFEST\.sha256 is missing/.test(e)), 'missing MANIFEST message');

void mismatch;
console.log('external-reconciliation-intake.test.js: PASS');
