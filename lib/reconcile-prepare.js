import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RECONCILIATION_TARGETS, IMPORT_DIR, BANK_ACCOUNTS } from '../config/bank-import-targets.js';
import { getBeginningBalance, getLastClosedSession } from './bank-reconcile-session.js';
import { getBankStatementView, peekBundledStatement } from './bank-statement-view.js';
import { importStatementForReconcile } from './reconcile-statement-import.js';
import { findOfxFiles } from './bank-catchup.js';

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
 */
export async function prepareReconciliation(db, {
  entityId,
  accountId,
  statementDate = null,
  userId = 'usr-admin',
  importFromFolder = true,
}) {
  const account = await db.get(
    'SELECT id, account_number, account_name, normal_balance FROM accounts WHERE id = ? AND entity_id = ?',
    [accountId, entityId]
  );
  if (!account) throw new Error('Account not found');

  const entityTargets = RECONCILIATION_TARGETS[entityId]?.[account.account_number];
  const bundled = peekBundledStatement(account.account_number, statementDate);
  const target = lookupReconciliationTarget(entityId, account.account_number, statementDate)
    || lookupReconciliationTarget(entityId, account.account_number, bundled?.meta?.periodEnd)
    || (entityTargets ? entityTargets[0] : null);

  // Default the next period to the month after the last completed reconciliation.
  const lastClosed = await getLastClosedSession(db, entityId, accountId);
  const lastReconciledDate = lastClosed?.statement_date
    ? String(lastClosed.statement_date).slice(0, 10)
    : null;
  const suggestedNext = lastReconciledDate ? nextStatementEnd(lastReconciledDate) : null;

  let suggestedStatementDate =
    statementDate
    || suggestedNext
    || bundled?.meta?.periodEnd
    || target?.statementDate
    || null;

  let imported = null;
  if (importFromFolder) {
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
          autoPost: true,
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
    suggestedStatementDate = new Date().toISOString().slice(0, 10);
  }

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
  const endingBalance = round2(
    meta.currentBalance
    ?? imported?.endingBalance
    ?? target?.endingBalance
    ?? null
  );
  const statementBeginning = meta.previousBalance != null
    ? round2(meta.previousBalance)
    : round2(bookBeginning);

  return {
    account: {
      id: account.id,
      accountNumber: account.account_number,
      accountName: account.account_name,
    },
    statementDate: suggestedStatementDate,
    suggestedStatementDate,
    lastReconciledDate,
    periodStart: statementView.period?.periodStart || meta.periodStart,
    periodEnd: statementView.period?.periodEnd || meta.periodEnd,
    beginningBalance: statementBeginning,
    bookBeginningBalance: round2(bookBeginning),
    endingBalance,
    statementLineCount: statementView.lines?.length || 0,
    statementMeta: meta,
    statementLabel: meta.statementLabel || meta.label || target?.label || null,
    source: meta.source || (imported?.imported ? 'folder-ofx' : 'bundled-json'),
    folderImport: imported,
    message: statementView.lines?.length
      ? `Statement ready — ${statementView.lines.length} line(s), ending ${endingBalance != null ? endingBalance.toFixed(2) : 'n/a'}`
      : endingBalance != null
        ? `Balances loaded (${endingBalance.toFixed(2)} ending) — import PDF/OFX for line detail, or pick another statement date`
        : bundled?.meta?.periodEnd
          ? `No statement for ${String(suggestedStatementDate).slice(0, 10)} — try ${bundled.meta.periodEnd} or import a PDF/OFX`
          : 'No statement found — click Import statement (PDF / OFX) or add files to data/bank-imports/',
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
