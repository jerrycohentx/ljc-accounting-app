import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPriorClosedSession } from './bank-reconcile-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const STATEMENT_JSON_BY_ACCOUNT = {
  '1000': 'data/bank-imports/LJC/simmons-2026-statements.json',
  '1001': 'data/bank-imports/LJC/lonestar-2026-statements.json',
  '2010': 'data/bank-imports/LJC/amex-2026-statements.json',
};

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Statement period: day after prior closed session, else first of statement month. */
export async function resolveStatementPeriod(db, { entityId, accountId, statementDate }) {
  const prior = await getPriorClosedSession(db, entityId, accountId, statementDate);
  const periodStart = prior?.statement_date
    ? addDays(String(prior.statement_date).slice(0, 10), 1)
    : `${String(statementDate).slice(0, 7)}-01`;
  return { periodStart, periodEnd: String(statementDate).slice(0, 10) };
}

function lineFromImportRow(row) {
  const amount = Number(row.amount);
  const deposit = amount > 0 ? round2(amount) : null;
  const payment = amount < 0 ? round2(Math.abs(amount)) : null;
  return {
    id: row.id,
    source: 'import',
    date: row.date,
    description: row.description || '',
    amount: round2(amount),
    deposit,
    payment,
    fitid: row.fitid,
    matchedGlId: row.matched_to_gl_id || null,
    journalEntryId: row.journal_entry_id || null,
    status: row.status,
  };
}

function loadJsonStatement(accountNumber, periodStart, periodEnd) {
  const rel = STATEMENT_JSON_BY_ACCOUNT[accountNumber];
  if (!rel) return null;
  const filePath = path.join(ROOT, rel);
  if (!fs.existsSync(filePath)) return null;

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const statements = data.statements || [];
  const match = statements.find((s) => {
    const end = s.meta?.periodEnd;
    if (!end) return false;
    return end >= periodStart && end <= periodEnd;
  }) || statements.find((s) => s.meta?.periodEnd === periodEnd);

  if (!match) return null;

  const lines = (match.transactions || []).map((t, idx) => {
    const amount = Number(t.amount);
    const deposit = amount > 0 ? round2(amount) : null;
    const payment = amount < 0 ? round2(Math.abs(amount)) : null;
    return {
      id: t.fitid || `stmt-${idx}`,
      source: 'statement-json',
      date: t.date,
      description: t.description || '',
      amount: round2(amount),
      deposit,
      payment,
      fitid: t.fitid || null,
      matchedGlId: null,
      journalEntryId: null,
      status: null,
    };
  });

  return {
    meta: {
      periodStart: match.meta?.periodStart || periodStart,
      periodEnd: match.meta?.periodEnd || periodEnd,
      previousBalance: match.meta?.previousBalance != null ? round2(match.meta.previousBalance) : null,
      currentBalance: match.meta?.currentBalance != null ? round2(match.meta.currentBalance) : null,
      bankName: match.meta?.bankName || null,
      label: match.file || null,
      source: rel,
    },
    lines,
  };
}

/**
 * Bank statement lines for side-by-side QBD reconcile view.
 * Prefers import_transactions; falls back to bundled statement JSON for LJC accounts.
 */
export async function getBankStatementView(db, { entityId, accountId, accountNumber, statementDate }) {
  const { periodStart, periodEnd } = await resolveStatementPeriod(db, {
    entityId,
    accountId,
    statementDate,
  });

  const importRows = await db.all(
    `SELECT id, fitid, date, amount, description, matched_to_gl_id, journal_entry_id, status
     FROM import_transactions
     WHERE entity_id = ? AND account_id = ?
       AND date >= ? AND date <= ?
     ORDER BY date ASC, id ASC`,
    [entityId, accountId, periodStart, periodEnd]
  ).catch(() => []);

  let lines = (importRows || []).map(lineFromImportRow);
  let meta = {
    periodStart,
    periodEnd,
    previousBalance: null,
    currentBalance: null,
    source: 'import_transactions',
    lineCount: lines.length,
  };

  if (lines.length === 0 && accountNumber) {
    const jsonView = loadJsonStatement(accountNumber, periodStart, periodEnd);
    if (jsonView) {
      lines = jsonView.lines;
      meta = { ...meta, ...jsonView.meta, source: jsonView.meta.source, lineCount: lines.length };
    }
  } else if (accountNumber) {
    const jsonView = loadJsonStatement(accountNumber, periodStart, periodEnd);
    if (jsonView?.meta) {
      meta.previousBalance = jsonView.meta.previousBalance;
      meta.currentBalance = jsonView.meta.currentBalance;
      meta.bankName = jsonView.meta.bankName;
      meta.statementLabel = jsonView.meta.label;
    }
  }

  // Enrich with GL links via journal_entry_id when matched_to_gl_id missing
  for (const line of lines) {
    if (line.matchedGlId || !line.journalEntryId) continue;
    const gl = await db.get(
      `SELECT id FROM general_ledger WHERE journal_entry_id = ? AND entity_id = ? AND account_id = ? LIMIT 1`,
      [line.journalEntryId, entityId, accountId]
    );
    if (gl) line.matchedGlId = gl.id;
  }

  return { period: { periodStart, periodEnd }, meta, lines };
}
