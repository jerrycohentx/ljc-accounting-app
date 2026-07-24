import fs from 'fs';
import path from 'path';
import { commitBankImportTransactions, getExistingFitidsForEntity } from './import-commit.js';
import { seedDefaultRules } from './categorization-rules.js';
import {
  getPostedBankBalance,
  postAllPendingImports,
  reconcileToTarget,
} from './bank-catchup.js';
import { RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';

const ENTITY_ID = 'ent-ljc';
const BANK_ACCT = '1001';

export function loadLonestarStatements(rootDir) {
  const jsonPath = path.join(rootDir, 'data/bank-imports/LJC/lonestar-2026-statements.json');
  if (!fs.existsSync(jsonPath)) {
    throw new Error('lonestar-2026-statements.json missing — run import-lonestar-statements.js locally first');
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  return (data.statements || []).sort((a, b) =>
    (a.meta?.periodStart || '').localeCompare(b.meta?.periodStart || '')
  );
}

async function ensureOpeningTrueUp(db, bankOpeningBalance, _userId) {
  const bal = await getPostedBankBalance(db, ENTITY_ID, BANK_ACCT, '2025-12-31');
  if (!bal) throw new Error('Account 1001 not found');

  const diff = Math.round((bal.balance - bankOpeningBalance) * 100) / 100;
  if (Math.abs(diff) < 0.02) return { skipped: true, balance: bal.balance };

  return {
    blocked: true,
    code: 'PLUG_ENTRY_BLOCKED',
    reason:
      'Hard rule: Lone Star opening true-up via 3900 Opening Balance Equity is permanently disabled. Fix opening balances with real entries — no equity plugs.',
    priorBalance: bal.balance,
    bankOpeningBalance,
    variance: diff,
  };
}

async function importStatements(db, rootDir, userId) {
  const statements = loadLonestarStatements(rootDir);
  const existingFitids = await getExistingFitidsForEntity(ENTITY_ID);
  let imported = 0;
  let skipped = 0;

  for (const stmt of statements) {
    const txns = stmt.transactions.filter((t) => !existingFitids.has(t.fitid));
    skipped += stmt.transactions.length - txns.length;
    if (!txns.length) continue;

    const importId = `lonestar-${stmt.meta?.periodEnd || stmt.file}`;
    const { createdJECount } = await commitBankImportTransactions(db, {
      entityId: ENTITY_ID,
      transactions: txns,
      importId,
      userId,
      sourceLabel: `Lone Star stmt ${stmt.meta?.periodStart || ''}`,
      bankAccountNumber: BANK_ACCT,
    });
    imported += createdJECount;
    for (const t of txns) existingFitids.add(t.fitid);
  }

  const { posted } = await postAllPendingImports(db, ENTITY_ID, userId);
  return { statements: statements.length, imported, skippedDuplicates: skipped, posted };
}

/**
 * Import Lone Star ckg-7367 Jan–May 2026, reconcile through May. Idempotent on fitid.
 */
export async function runLonestarCatchUp(db, { userId = 'usr-admin', rootDir = process.cwd() } = {}) {
  await seedDefaultRules(db, ENTITY_ID);

  const statements = loadLonestarStatements(rootDir);
  const firstOpening = statements[0]?.meta?.previousBalance;
  const trueUp = firstOpening != null
    ? await ensureOpeningTrueUp(db, firstOpening, userId)
    : null;

  const lonestar = await importStatements(db, rootDir, userId);

  const reconciliations = [];
  for (const target of RECONCILIATION_TARGETS[ENTITY_ID]?.[BANK_ACCT] || []) {
    const r = await reconcileToTarget(db, {
      entityId: ENTITY_ID,
      accountNumber: BANK_ACCT,
      statementDate: target.statementDate,
      endingBalance: target.endingBalance,
      userId,
    });
    reconciliations.push({ ...target, ...r });
  }

  const bal = await getPostedBankBalance(db, ENTITY_ID, BANK_ACCT);
  const mayTarget = RECONCILIATION_TARGETS[ENTITY_ID]?.[BANK_ACCT]?.slice(-1)[0]?.endingBalance;

  return {
    trueUp,
    lonestar,
    reconciliations,
    account1001Balance: bal?.balance,
    mayTarget,
    balanceMatchesMay: mayTarget != null && Math.abs((bal?.balance || 0) - mayTarget) < 0.07,
  };
}
