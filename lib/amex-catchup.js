import fs from 'fs';
import path from 'path';
import { getExistingFitidsForEntity } from './import-commit.js';
import { commitAmexImportTransactions } from './amex-import-commit.js';
import { seedDefaultRules } from './categorization-rules.js';
import {
  getPostedBankBalance,
  postAllPendingImports,
  reconcileToTarget,
} from './bank-catchup.js';
import { RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';

const ENTITY_ID = 'ent-ljc';
const CARD_ACCT = '2010';

export function loadAmexStatements(rootDir) {
  const jsonPath = path.join(rootDir, 'data/bank-imports/LJC/amex-2026-statements.json');
  if (!fs.existsSync(jsonPath)) {
    throw new Error('amex-2026-statements.json missing — run import-amex-statements.js locally first');
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  return (data.statements || []).sort((a, b) =>
    (a.meta?.closingDate || '').localeCompare(b.meta?.closingDate || '')
  );
}

/** Hard-blocked: never park Amex variance in 2999 (Commandment 5) or force-balance. */
async function ensureCardOpeningTrueUp(db, statementOpeningBalance, _userId) {
  const bal = await getPostedBankBalance(db, ENTITY_ID, CARD_ACCT);
  if (!bal) throw new Error('Account 2010 not found');

  const diff = Math.round((bal.balance - statementOpeningBalance) * 100) / 100;
  if (Math.abs(diff) < 0.02) return { skipped: true, balance: bal.balance };

  return {
    blocked: true,
    code: 'PLUG_ENTRY_BLOCKED',
    reason:
      'Hard rule: Amex opening true-up to account 2999 (Opening Rollup) is permanently disabled. Reclass other cards to real accounts — never 2999.',
    priorBalance: bal.balance,
    statementOpeningBalance,
    variance: diff,
  };
}

const OPEN_DATE = '2026-01-01';

function clampOpenPeriod(date) {
  return String(date).slice(0, 10) < OPEN_DATE ? OPEN_DATE : String(date).slice(0, 10);
}

async function importStatements(db, rootDir, userId) {
  const statements = loadAmexStatements(rootDir);
  const existingFitids = await getExistingFitidsForEntity(ENTITY_ID);
  let imported = 0;
  let matchedPayments = 0;
  let skippedDuplicates = 0;

  for (const stmt of statements) {
    const txns = stmt.transactions
      .filter((t) => !existingFitids.has(t.fitid))
      .map((t) => ({ ...t, date: clampOpenPeriod(t.date) }));
    skippedDuplicates += stmt.transactions.length - txns.length;
    if (!txns.length) continue;

    const importId = `amex-${stmt.meta?.closingDate || stmt.file}`;
    const result = await commitAmexImportTransactions(db, {
      entityId: ENTITY_ID,
      transactions: txns,
      importId,
      userId,
      sourceLabel: `Amex stmt ${stmt.meta?.closingDate || ''}`,
      cardAccountNumber: CARD_ACCT,
    });
    imported += result.createdJECount;
    matchedPayments += result.matchedPayments;
    for (const t of txns) existingFitids.add(t.fitid);
  }

  const { posted } = await postAllPendingImports(db, ENTITY_ID, userId);
  return { statements: statements.length, imported, matchedPayments, skippedDuplicates, posted };
}

export async function runAmexCatchUp(db, { userId = 'usr-admin', rootDir = process.cwd() } = {}) {
  await seedDefaultRules(db, ENTITY_ID);

  const statements = loadAmexStatements(rootDir);
  const firstOpening = statements[0]?.meta?.previousBalance;
  const trueUp = firstOpening != null
    ? await ensureCardOpeningTrueUp(db, firstOpening, userId)
    : null;

  const amex = await importStatements(db, rootDir, userId);

  let bal = await getPostedBankBalance(db, ENTITY_ID, CARD_ACCT);
  const junTarget = RECONCILIATION_TARGETS[ENTITY_ID]?.[CARD_ACCT]?.slice(-1)[0]?.endingBalance;

  const adjustment = junTarget != null
    ? await ensureAmexReconcileAdjustment(db, bal?.balance, junTarget, userId)
    : null;

  bal = await getPostedBankBalance(db, ENTITY_ID, CARD_ACCT);

  const reconciliations = [];
  for (const target of RECONCILIATION_TARGETS[ENTITY_ID]?.[CARD_ACCT] || []) {
    const r = await reconcileToTarget(db, {
      entityId: ENTITY_ID,
      accountNumber: CARD_ACCT,
      statementDate: target.statementDate,
      endingBalance: target.endingBalance,
      userId,
    });
    reconciliations.push({ ...target, ...r });
  }

  const finalBal = await getPostedBankBalance(db, ENTITY_ID, CARD_ACCT);

  return {
    trueUp,
    amex,
    adjustment,
    reconciliations,
    account2010Balance: finalBal?.balance,
    juneTarget: junTarget,
    balanceMatchesJune: junTarget != null && Math.abs((finalBal?.balance || 0) - junTarget) < 0.07,
  };
}

/** Hard-blocked: never force Amex to statement via 3900. */
async function ensureAmexReconcileAdjustment(db, currentBalance, targetBalance, _userId) {
  const diff = Math.round((currentBalance - targetBalance) * 100) / 100;
  if (Math.abs(diff) < 0.07) return { skipped: true, balance: currentBalance };

  return {
    blocked: true,
    code: 'PLUG_ENTRY_BLOCKED',
    reason:
      'Hard rule: Amex statement tie-out plug to 3900 is permanently disabled. Clear the real payment/charge variance.',
    priorBalance: currentBalance,
    targetBalance,
    variance: diff,
  };
}
