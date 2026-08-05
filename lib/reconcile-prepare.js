import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RECONCILIATION_TARGETS, IMPORT_DIR, BANK_ACCOUNTS } from '../config/bank-import-targets.js';
import {
  getBeginningBalance,
  getLastClosedSession,
  getEarliestOpenSession,
  getSessionForPeriod,
} from './bank-reconcile-session.js';
import {
  getBankStatementView,
  peekBundledStatement,
  nextBundledStatementEnd,
  normalizeIsoDate,
} from './bank-statement-view.js';
import { importStatementForReconcile } from './reconcile-statement-import.js';
import { findOfxFiles } from './bank-catchup.js';
import { resolveStatementFile } from './statement-file-locate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** End of the calendar month following the given statement date (UTC, YYYY-MM-DD). */
function nextStatementEnd(lastDateISO) {
  const iso = String(lastDateISO).slice(0, 10);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Day 0 of (month + 2) === last day of the month after the statement month.
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0));
  return end.toISOString().slice(0, 10);
}

/** Match configured ending balance for account + date or month. */
export function lookupReconciliationTarget(entityId, accountNumber, statementDate = null) {
  const targets = RECONCILIATION_TARGETS[entityId]?.[accountNumber] || [];
  if (!statementDate) return targets[targets.length - 1] || null;

  const sd = String(statementDate).slice(0, 10);
  const month = sd.slice(0, 7);
  return (
    targets.find((t) => t.statementDate === sd)
    || targets.find((t) => String(t.statementDate).slice(0, 7) === month)
    || null
  );
}

function ofxAccountHint(content) {
  const m = content.match(/<ACCTID>([^<\r\n]+)/i);
  return m ? m[1].trim().slice(-4) : null;
}

function findOfxForAccount(accountNumber, ofxAccountId) {
  const files = findOfxFiles(ROOT);
  const last4 = String(accountNumber).slice(-4);
  const hint = ofxAccountId ? String(ofxAccountId).slice(-4) : last4;

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const acct = ofxAccountHint(content);
      if (acct && (acct.endsWith(hint) || acct.endsWith(last4))) {
        return filePath;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

/**
 * Load statement metadata and optionally import OFX from data/bank-imports/.
 * Returns suggested statement date, beginning/ending balances, and line count preview.
 *
 * Entity-agnostic resume rule (all Cohen entities): if this account already has
 * an OPEN recon and the caller did not force a different statementDate, prefer
 * that session — never invent the newest LJC bundled PDF for a sister entity.
 */
export async function prepareReconciliation(db, {
  entityId,
  accountId,
  statementDate = null,
  userId = 'usr-admin',
  importFromFolder = true,
  year = null,
}) {
  const account = await db.get(
    'SELECT id, account_number, account_name, normal_balance FROM accounts WHERE id = ? AND entity_id = ?',
    [accountId, entityId]
  );
  if (!account) throw new Error('Account not found');

  const requestedDate = normalizeIsoDate(statementDate);
  const resumeYear = year != null && Number.isFinite(Number(year))
    ? Number(year)
    : (requestedDate ? Number(requestedDate.slice(0, 4)) : 2026);

  const openSession = requestedDate
    ? await getSessionForPeriod(db, entityId, accountId, requestedDate)
    : await getEarliestOpenSession(db, entityId, accountId, { year: resumeYear });

  const entityTargets = RECONCILIATION_TARGETS[entityId]?.[account.account_number];
  const bundled = peekBundledStatement(account.account_number, requestedDate, entityId);
  const target = lookupReconciliationTarget(entityId, account.account_number, requestedDate)
    || lookupReconciliationTarget(entityId, account.account_number, bundled?.meta?.periodEnd)
    || (entityTargets ? entityTargets[0] : null);

  // THE RULE (Jerry, 2026-07-16): default statement date is the period after the
  // last COMPLETED recon — BUT an existing OPEN session always wins over
  // "next after close" / newest bundled JSON (sister entities previously fell
  // through to LJC May because peekBundledStatement was keyed by account # only).
  const lastClosed = await getLastClosedSession(db, entityId, accountId);
  const lastReconciledDate = normalizeIsoDate(lastClosed?.statement_date);
  let suggestedNext = null;
  if (lastReconciledDate) {
    const nextOnFile = nextBundledStatementEnd(account.account_number, lastReconciledDate, entityId);
    const nextTarget = (entityTargets || [])
      .map((t) => String(t.statementDate).slice(0, 10))
      .filter((d) => d > lastReconciledDate)
      .sort()[0] || null;
    suggestedNext = nextOnFile || nextTarget || nextStatementEnd(lastReconciledDate);
  }

  const openDate = openSession?.status === 'OPEN'
    ? normalizeIsoDate(openSession.statement_date)
    : null;

  let suggestedStatementDate =
    requestedDate
    || openDate
    || suggestedNext
    || bundled?.meta?.periodEnd
    || target?.statementDate
    || null;

  let imported = null;
  // Folder OFX auto-import is LJC-local (data/bank-imports). Other entities
  // must not pull LJC OFX by shared account number (1000).
  if (importFromFolder && entityId === 'ent-ljc') {
    const bankSpec = BANK_ACCOUNTS[entityId]
      ?.find((b) => b.accountNumber === account.account_number);
    const ofxPath = findOfxForAccount(account.account_number, bankSpec?.ofxAccountId);
    if (ofxPath && fs.existsSync(ofxPath)) {
      try {
        const ofxContent = fs.readFileSync(ofxPath, 'utf8');
        imported = await importStatementForReconcile(db, {
          entityId,
          accountId,
          userId,
          ofxContent,
          fileName: path.basename(ofxPath),
          autoPost: false,
          createEntries: false,
        });
        if (!suggestedStatementDate && imported.statementDate) {
          suggestedStatementDate = imported.statementDate;
        }
      } catch (e) {
        imported = { error: e.message };
      }
    }
  }

  if (!suggestedStatementDate) {
    suggestedStatementDate = new Date().toISOString().split('T')[0];
  }

  const openForDate = openSession
    && normalizeIsoDate(openSession.statement_date) === normalizeIsoDate(suggestedStatementDate)
    ? openSession
    : await getSessionForPeriod(db, entityId, accountId, suggestedStatementDate);

  const statementView = await getBankStatementView(db, {
    entityId,
    accountId,
    accountNumber: account.account_number,
    statementDate: suggestedStatementDate,
  });

  const bookBeginning = await getBeginningBalance(
    db,
    entityId,
    accountId,
    suggestedStatementDate,
    account.normal_balance
  );

  const meta = statementView.meta || {};
  // Prefer OPEN session balances when resuming — never overwrite with a
  // sister-entity bundled PDF ending (e.g. LJC May onto OMC).
  const endingBalance = round2(
    (openForDate?.status === 'OPEN' ? openForDate.ending_balance : null)
    ?? meta.currentBalance
    ?? imported?.endingBalance
    ?? target?.endingBalance
    ?? (openForDate ? openForDate.ending_balance : null)
    ?? null
  );
  const statementBeginning = openForDate?.beginning_balance != null
    ? round2(openForDate.beginning_balance)
    : (meta.previousBalance != null
      ? round2(meta.previousBalance)
      : round2(bookBeginning));

  let statementFile = null;
  try {
    statementFile = await resolveStatementFile(db, {
      entityId,
      accountId,
      accountNumber: account.account_number,
      statementDate: suggestedStatementDate,
      userId,
      discover: true,
    });
  } catch (err) {
    console.warn('prepare statement attach (non-fatal):', err.message);
  }

  const nextLabel = suggestedStatementDate ? String(suggestedStatementDate).slice(0, 10) : null;
  const lastLabel = lastReconciledDate || null;
  const resumeOpen = !!(openForDate && openForDate.status === 'OPEN');
  let message;
  if (resumeOpen) {
    message = `Resuming open reconciliation for ${normalizeIsoDate(openForDate.statement_date)}`
      + (endingBalance != null ? ` (ending ${endingBalance.toFixed(2)})` : '')
      + (statementFile ? ', statement attached' : '');
  } else if (statementView.lines?.length) {
    message = lastLabel
      ? `Last reconciled ${lastLabel} — loaded ${nextLabel} (${statementView.lines.length} line(s), ending ${endingBalance != null ? endingBalance.toFixed(2) : 'n/a'})`
      : `Statement ready — ${statementView.lines.length} line(s), ending ${endingBalance != null ? endingBalance.toFixed(2) : 'n/a'}`;
  } else if (endingBalance != null) {
    message = lastLabel
      ? `Last reconciled ${lastLabel} — next period ${nextLabel} (${endingBalance.toFixed(2)} ending)${statementFile ? ', statement attached' : ''}`
      : `Balances loaded (${endingBalance.toFixed(2)} ending) — import PDF/OFX for line detail, or pick another statement date`;
  } else if (bundled?.meta?.periodEnd) {
    message = `No statement for ${nextLabel} — try ${bundled.meta.periodEnd} or import a PDF/OFX`;
  } else {
    message = 'No statement found — click Import statement (PDF / OFX) or add files to data/bank-imports/';
  }

  return {
    account: {
      id: account.id,
      accountNumber: account.account_number,
      accountName: account.account_name,
    },
    statementDate: suggestedStatementDate,
    suggestedStatementDate,
    lastReconciledDate,
    openSession: openForDate
      ? {
          statementDate: normalizeIsoDate(openForDate.statement_date),
          status: openForDate.status,
          difference: Number(openForDate.difference) || 0,
          endingBalance: Number(openForDate.ending_balance),
          beginningBalance: Number(openForDate.beginning_balance),
        }
      : null,
    resumeOpen,
    periodStart: statementView.period?.periodStart || meta.periodStart,
    periodEnd: statementView.period?.periodEnd || meta.periodEnd,
    beginningBalance: statementBeginning,
    bookBeginningBalance: round2(bookBeginning),
    endingBalance,
    statementLineCount: statementView.lines?.length || 0,
    statementMeta: meta,
    statementLabel: meta.statementLabel || meta.label || target?.label || null,
    source: resumeOpen
      ? 'open-session'
      : (meta.source || (imported?.imported ? 'folder-ofx' : 'bundled-json')),
    folderImport: imported,
    statementFileAttached: !!statementFile?.file_data,
    statementFileSource: statementFile?.source || null,
    message,
  };
}

export function listImportFolder() {
  const base = path.join(ROOT, IMPORT_DIR);
  if (!fs.existsSync(base)) return [];
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(ofx|qfx|pdf|json)$/i.test(name)) {
        out.push(path.relative(ROOT, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(base);
  return out.sort();
}
