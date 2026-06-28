import fs from 'fs';
import path from 'path';
import { parseOFX } from './ofx-parser.js';
import { getExistingFitidsForEntity } from './import-commit.js';
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
    reconciliation,
    account1000Balance: bal?.balance,
    juneTarget,
    balanceMatchesJune: juneTarget != null && Math.abs((bal?.balance || 0) - juneTarget) < 0.02,
  };
}
