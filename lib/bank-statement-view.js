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
  const base = normalizeIsoDate(isoDate);
  if (!base) throw new Error('Invalid statement date');
  const d = new Date(`${base}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid time value');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Normalize PG/SQLite dates to YYYY-MM-DD. */
export function normalizeIsoDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Statement period: day after prior closed session, else first of statement month. */
export async function resolveStatementPeriod(db, { entityId, accountId, statementDate }) {
  const periodEnd = normalizeIsoDate(statementDate);
  if (!periodEnd) {
    throw new Error('Valid statement date required (YYYY-MM-DD)');
  }

  const prior = await getPriorClosedSession(db, entityId, accountId, periodEnd);
  const priorEnd = normalizeIsoDate(prior?.statement_date);
  const periodStart = priorEnd
    ? addDays(priorEnd, 1)
    : `${periodEnd.slice(0, 7)}-01`;
  return { periodStart, periodEnd };
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

function statementPeriodEnd(meta) {
  return meta?.periodEnd || meta?.closingDate || null;
}

/**
 * Pick the statement that covers `statementDate`.
 *
 * The rules below MUST be applied one rule at a time across every statement,
 * strongest first -- never all rules against one statement before moving on.
 * Statement cycles routinely spill into the next calendar month (Simmons'
 * January period runs 1/01 thru 2/01), so a weak month-based rule will happily
 * claim a February date for the JANUARY statement if January is tested first.
 * That returned January's balances for February's activity and showed a phantom
 * variance on books that actually tied to the penny.
 */
function findJsonStatement(statements, statementDate, periodStart, periodEnd) {
  const sd = String(statementDate || periodEnd).slice(0, 10);
  const month = sd.slice(0, 7);

  const usable = statements.filter((s) => statementPeriodEnd(s.meta));
  const endOf = (s) => statementPeriodEnd(s.meta);
  const startOf = (s) => s.meta?.periodStart || `${endOf(s).slice(0, 7)}-01`;

  // 1. The statement whose own period CONTAINS the date. Authoritative -- wins outright.
  const contains = usable.find((s) => sd >= startOf(s) && sd <= endOf(s));
  if (contains) return contains;

  // 2. A statement closing exactly on the requested period end.
  const exact = usable.find((s) => endOf(s) === periodEnd);
  if (exact) return exact;

  // 3. A statement closing somewhere inside the reconciliation window.
  const inWindow = usable.find((s) => endOf(s) >= periodStart && endOf(s) <= periodEnd);
  if (inWindow) return inWindow;

  // 4. Last-resort month heuristic. Never hand back a statement that already
  //    CLOSED before the requested date -- that is the exact misfire above.
  return usable.find((s) => endOf(s).slice(0, 7) === month && sd <= endOf(s)) || null;
}

/** Preview bundled statement meta without DB (for prepare step). */
export function peekBundledStatement(accountNumber, statementDate = null) {
  const rel = STATEMENT_JSON_BY_ACCOUNT[accountNumber];
  if (!rel) return null;
  const filePath = path.join(ROOT, rel);
  if (!fs.existsSync(filePath)) return null;

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const statements = data.statements || [];
  const sd = statementDate || statements[statements.length - 1]?.meta?.periodEnd;
  if (!sd) return null;

  const month = String(sd).slice(0, 7);
  const periodStart = `${month}-01`;
  const match = findJsonStatement(statements, sd, periodStart, sd);
  if (!match) return null;

  const end = statementPeriodEnd(match.meta);
  return {
    meta: {
      periodStart: match.meta?.periodStart || periodStart,
      periodEnd: end,
      previousBalance: match.meta?.previousBalance != null ? round2(match.meta.previousBalance) : null,
      currentBalance: match.meta?.currentBalance != null ? round2(match.meta.currentBalance) : null,
      bankName: match.meta?.bankName || null,
      label: match.file || null,
    },
    lineCount: (match.transactions || []).length,
  };
}

function loadJsonStatement(accountNumber, periodStart, periodEnd, statementDate = periodEnd) {
  const rel = STATEMENT_JSON_BY_ACCOUNT[accountNumber];
  if (!rel) return null;
  const filePath = path.join(ROOT, rel);
  if (!fs.existsSync(filePath)) return null;

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const statements = data.statements || [];
  const match = findJsonStatement(statements, statementDate, periodStart, periodEnd);

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

  const end = statementPeriodEnd(match.meta);
  const endingBal = match.meta?.currentBalance ?? match.meta?.newBalance;

  return {
    meta: {
      periodStart: match.meta?.periodStart || periodStart,
      periodEnd: end || periodEnd,
      previousBalance: match.meta?.previousBalance != null ? round2(match.meta.previousBalance) : null,
      currentBalance: endingBal != null ? round2(endingBal) : null,
      bankName: match.meta?.bankName || null,
      cardName: match.meta?.cardName || null,
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
     ORDER BY id ASC`,
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
    const jsonView = loadJsonStatement(accountNumber, periodStart, periodEnd, statementDate);
    if (jsonView) {
      lines = jsonView.lines;
      meta = { ...meta, ...jsonView.meta, source: jsonView.meta.source, lineCount: lines.length };
      if (jsonView.meta.periodEnd && jsonView.meta.periodEnd !== periodEnd) {
        meta.periodEnd = jsonView.meta.periodEnd;
      }
    }
  } else if (accountNumber) {
    const jsonView = loadJsonStatement(accountNumber, periodStart, periodEnd, statementDate);
    if (jsonView?.meta) {
      meta.previousBalance = jsonView.meta.previousBalance;
      meta.currentBalance = jsonView.meta.currentBalance;
      meta.bankName = jsonView.meta.bankName;
      meta.cardName = jsonView.meta.cardName;
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
