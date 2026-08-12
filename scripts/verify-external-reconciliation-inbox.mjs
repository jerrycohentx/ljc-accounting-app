#!/usr/bin/env node
/**
 * Verify a Claude → Cursor external reconciliation package.
 *
 *   node scripts/verify-external-reconciliation-inbox.mjs --package lone_star_7367_2026_01
 *   node scripts/verify-external-reconciliation-inbox.mjs --package lone_star_7367_2026_01 --capture-ljcos
 *
 * Exit 0 = hashes OK (Claude conclusions still UNVERIFIED).
 * Exit 2 = hard STOP (missing/mismatch/already-reversed).
 * Never posts or mutates accounting records.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  verifyPackageOnDisk,
  packagePaths,
  assertCursorDidNotWriteClaude,
} from '../lib/external-reconciliation-intake.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const BASE = process.env.LJC_API_BASE || 'https://ljc-accounting-app.onrender.com';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const packageId = arg('--package');
if (!packageId) {
  console.error('Usage: node scripts/verify-external-reconciliation-inbox.mjs --package <id> [--capture-ljcos]');
  process.exit(1);
}

const captureLjcos = process.argv.includes('--capture-ljcos');

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@ljcfinancial.com', password: 'demo123' }),
  });
  const data = await res.json();
  if (!data.token) throw new Error(`login failed: ${JSON.stringify(data)}`);
  return data.token;
}

async function getJson(pathname, token) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, text: text.slice(0, 400) };
  }
}

function readProposedJournalIds(claudeDir) {
  const p = path.join(claudeDir, 'PROPOSED_CORRECTIONS.json');
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const rows = Array.isArray(data) ? data : data.proposed || data.items || [];
    return rows
      .map((r) => r.journalId || r.journal_id || r.id)
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function captureSnapshot(token, { entityId, accountId, statementDate, journalIds }) {
  const integrity = await getJson(
    `/api/entities/${entityId}/accounting/periods/integrity?year=${statementDate.slice(0, 4)}&month=${Number(statementDate.slice(5, 7))}`,
    token
  );
  const worksheet = accountId
    ? await getJson(
        `/api/reconciliation/bank/worksheet?entityId=${entityId}&accountId=${accountId}&statementDate=${statementDate}`,
        token
      )
    : null;
  const journals = {};
  for (const id of journalIds) {
    journals[id] = (await getJson(`/api/entities/${entityId}/journals/${id}`, token)).json;
  }
  return {
    capturedAt: new Date().toISOString(),
    base: BASE,
    entityId,
    accountId,
    statementDate,
    integrity: integrity.json,
    worksheet: worksheet?.json || null,
    journals,
  };
}

function writeCursorFile(cursorDir, name, body) {
  fs.mkdirSync(cursorDir, { recursive: true });
  const dest = path.join(cursorDir, name);
  fs.writeFileSync(dest, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n');
  return dest;
}

const paths = packagePaths(repoRoot, packageId);
const claudeWriteViolations = assertCursorDidNotWriteClaude(repoRoot, packageId);

let proposedJournals = [];
let snapshot = null;

if (captureLjcos) {
  try {
    const token = await login();
    const entityId = 'ent-ljc';
    const accounts = (await getJson(`/api/entities/${entityId}/accounts`, token)).json;
    const list = Array.isArray(accounts) ? accounts : accounts?.data || [];
    const a1001 = list.find((a) => a.account_number === '1001');
    const journalIds = fs.existsSync(paths.claudeDir) ? readProposedJournalIds(paths.claudeDir) : [];
    snapshot = await captureSnapshot(token, {
      entityId,
      accountId: a1001?.id || null,
      statementDate: '2026-01-31',
      journalIds,
    });
    proposedJournals = journalIds
      .map((id) => snapshot.journals[id])
      .filter((j) => j && j.id);
    writeCursorFile(paths.cursorDir, 'LJCOS_SNAPSHOT.json', snapshot);
  } catch (e) {
    console.error('LJCOS capture failed (read-only):', e.message);
  }
}

const result = verifyPackageOnDisk(repoRoot, packageId, { proposedJournals });
if (claudeWriteViolations.length) {
  result.ok = false;
  result.stop = true;
  result.errors = [
    ...(result.errors || []),
    ...claudeWriteViolations.map((n) => `STOP: Cursor-owned file in claude/: ${n}`),
  ];
}

result.ljcosCaptured = Boolean(snapshot);
if (snapshot?.worksheet?.liveTotals) {
  result.ljcosCash = {
    statementEnding: snapshot.worksheet.endingBalance,
    clearedBalance: snapshot.worksheet.liveTotals.clearedBalance,
    difference: snapshot.worksheet.liveTotals.difference,
    balanced: snapshot.worksheet.liveTotals.balanced,
  };
}
if (snapshot?.integrity) {
  result.ljcosIntegrity = {
    isClosed: snapshot.integrity.isClosed,
    canClose: snapshot.integrity.canClose,
    blockers: snapshot.integrity.blockers,
    account1001: (snapshot.integrity.accounts || []).find((a) => a.accountNumber === '1001') || null,
  };
}

result.packageRoot = path.relative(repoRoot, paths.root);
result.claudeDir = path.relative(repoRoot, paths.claudeDir);
if (result.cursorDir) result.cursorDir = path.relative(repoRoot, paths.cursorDir);

writeCursorFile(paths.cursorDir, 'INTAKE_RESULT.json', {
  ...result,
  verifiedAt: new Date().toISOString(),
  packageId,
  note: 'Claude conclusions are UNVERIFIED until independently checked against current LJCOS. This file is Cursor-owned.',
});

console.log(JSON.stringify({
  packageId,
  ok: result.ok,
  stop: result.stop,
  claudeConclusions: result.claudeConclusions,
  errors: result.errors,
  verifiedFileCount: (result.verifiedFiles || []).length,
  ljcosCaptured: result.ljcosCaptured,
  ljcosCash: result.ljcosCash || null,
}, null, 2));

if (result.stop || !result.ok) process.exit(2);
process.exit(0);
