import fs from 'fs';
import path from 'path';
import { parseOFX } from './ofx-parser.js';
import { v4 as uuidv4 } from 'uuid';
import { getExistingFitidsForEntity } from './import-commit.js';
import { postJournalEntryToGl } from './post-journal.js';
import {
  importOfxFile,
  postAllPendingImports,
  reconcileToTarget,
  getPostedBankBalance,
} from './bank-catchup.js';
import { RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';
import { seedDefaultRules } from './categorization-rules.js';

const ENTITY_ID = 'ent-ljc';
const BANK_ACCT = '1000';

export function loadSimmonsOfx(rootDir) {
  const ofxPath = path.join(rootDir, 'data/bank-imports/LJC/simmons-0260-2026.ofx');
  if (!fs.existsSync(ofxPath)) {
    throw new Error('simmons-0260-2026.ofx missing — copy Simmons OFX export to data/bank-imports/LJC/');
  }
  const content = fs.readFileSync(ofxPath, 'utf8');
  const parsed = parseOFX(content, { strict: false });
  if (!parsed.success) throw new Error(`OFX parse failed: ${(parsed.errors || []).join('; ')}`);

  const ledgerMatch = content.match(/<LEDGERBAL>[\s\S]*?<BALAMT>([^<\r\n]+)/i);
  const ledgerBalance = ledgerMatch ? parseFloat(ledgerMatch[1]) : null;

  return { ...parsed, ofxPath, ledgerBalance };
}

/** Skip OFX rows already represented by PDF/OFX imports (date + cents + account). */
async function filterNewTransactions(db, entityId, transactions, { sinceDate = null } = {}) {
  const existingFitids = await getExistingFitidsForEntity(entityId);
  const rows = await db.all(
    `SELECT date, amount FROM import_transactions
     WHERE entity_id = ? AND status != 'REJECTED'`,
    [entityId]
  );
  const sigs = new Set(
    rows.map((r) => `${String(r.date).slice(0, 10)}|${Math.round(Number(r.amount) * 100)}`)
  );

  return transactions.filter((t) => {
    if (sinceDate && t.date <= sinceDate) return false;
    if (existingFitids.has(t.fitid)) return false;
    const sig = `${t.date}|${Math.round(Number(t.amount) * 100)}`;
    if (sigs.has(sig)) return false;
    return true;
  });
}

/** Tie account 1000 to Simmons OFX ledger balance (corrects transfer timing vs statements). */
async function ensureOfxLedgerTrueUp(db, targetBalance, userId) {
  const bal = await getPostedBankBalance(db, ENTITY_ID, BANK_ACCT);
  if (!bal) throw new Error('Account 1000 not found');

  const diff = Math.round((targetBalance - bal.balance) * 100) / 100;
  if (Math.abs(diff) < 0.02) return { skipped: true, balance: bal.balance };

  const existing = await db.get(
    "SELECT id FROM journal_entries WHERE entity_id = ? AND je_number = 'TRUEUP-20260626-SIMMONS-OFX' AND status = 'POSTED' AND reversed_by_je_id IS NULL",
    [ENTITY_ID]
  );
  if (existing) return { skipped: true, reason: 'already posted' };

  const equity = await db.get(
    'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
    [ENTITY_ID, '3900']
  );
  if (!equity) throw new Error('Account 3900 not found');

  const amount = Math.abs(diff);
  const drAsset = diff > 0;
  const jeId = `je-${uuidv4()}`;
  await db.run(
    `INSERT INTO journal_entries (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
     VALUES (?, ?, 'TRUEUP-20260626-SIMMONS-OFX', ?, '2026-06-26', 'DRAFT', ?, ?, ?, ?)`,
    [jeId, ENTITY_ID, 'Simmons OFX ledger tie-out 6/26/26', userId, amount, amount, 'Simmons OFX catch-up']
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [`jel-${uuidv4()}`, jeId, bal.accountId, drAsset ? amount : 0, drAsset ? 0 : amount, 'True-up 1000']
  );
  await db.run(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 2)`,
    [`jel-${uuidv4()}`, jeId, equity.id, drAsset ? 0 : amount, drAsset ? amount : 0, 'Opening balance equity']
  );
  await postJournalEntryToGl(db, { journalId: jeId, entityId: ENTITY_ID, userId });
  return { amount, jeNumber: 'TRUEUP-20260626-SIMMONS-OFX', priorBalance: bal.balance, targetBalance };
}

/**
 * Import Simmons OFX — default: June 2026 only (May reconciled via statements).
 * Set sinceDate=null and importAll=true to attempt full file with dedup.
 */
export async function runSimmonsOfxCatchUp(db, {
  userId = 'usr-admin',
  rootDir = process.cwd(),
  sinceDate = '2026-05-31',
  importAll = false,
} = {}) {
  await seedDefaultRules(db, ENTITY_ID);

  const parsed = loadSimmonsOfx(rootDir);
  const filterSince = importAll ? null : sinceDate;
  const newTxns = await filterNewTransactions(db, ENTITY_ID, parsed.transactions, { sinceDate: filterSince });

  let imported = 0;
  let skipped = parsed.transactions.length - newTxns.length;

  if (newTxns.length) {
    const { commitBankImportTransactions } = await import('./import-commit.js');
    const importId = `ofx-simmons-${parsed.dateRange?.end || '2026'}`;
    const result = await commitBankImportTransactions(db, {
      entityId: ENTITY_ID,
      transactions: newTxns,
      importId,
      userId,
      sourceLabel: `Simmons OFX ${parsed.dateRange?.start || ''}–${parsed.dateRange?.end || ''}`,
      bankAccountNumber: BANK_ACCT,
    });
    imported = result.createdJECount;
  }

  const { posted } = await postAllPendingImports(db, ENTITY_ID, userId);

  const juneTarget = RECONCILIATION_TARGETS[ENTITY_ID]?.[BANK_ACCT]?.find(
    (t) => t.statementDate === '2026-06-26'
  )?.endingBalance ?? parsed.ledgerBalance;

  let trueUp = null;
  if (juneTarget != null) {
    trueUp = await ensureOfxLedgerTrueUp(db, juneTarget, userId);
  }

  let reconciliation = null;
  if (juneTarget != null) {
    reconciliation = await reconcileToTarget(db, {
      entityId: ENTITY_ID,
      accountNumber: BANK_ACCT,
      statementDate: '2026-06-26',
      endingBalance: juneTarget,
      userId,
    });
  }

  const bal = await getPostedBankBalance(db, ENTITY_ID, BANK_ACCT);

  return {
    ofx: {
      totalInFile: parsed.transactionCount,
      dateRange: parsed.dateRange,
      ledgerBalance: parsed.ledgerBalance,
      imported,
      skipped,
      posted,
      sinceDate: filterSince,
    },
    trueUp,
    reconciliation,
    account1000Balance: bal?.balance,
    juneTarget,
    balanceMatchesJune: juneTarget != null && Math.abs((bal?.balance || 0) - juneTarget) < 0.02,
  };
}
