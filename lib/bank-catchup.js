import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { getDatabase } from '../config/database.js';
import { parseOFX, deduplicateTransactions } from './ofx-parser.js';
import { commitBankImportTransactions, getExistingFitidsForEntity } from './import-commit.js';
import { postJournalEntryToGl } from './post-journal.js';
import { seedDefaultRules } from './categorization-rules.js';
import { closePeriod } from './period-lock.js';
import { POSTED_GL_SUBQUERY, calculateAccountBalance } from './posted-gl.js';
import { BANK_ACCOUNTS, RECONCILIATION_TARGETS } from '../config/bank-import-targets.js';
import { ENTITY_TB_FILES } from '../config/opening-balance-mappings.js';

const DEMO_USER = 'usr-demo';

export async function getPostedBankBalance(db, entityId, accountNumber, asOfDate = null) {
  const acc = await db.get(
    'SELECT id, normal_balance FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, accountNumber]
  );
  if (!acc) return null;

  let sql = `
    SELECT COALESCE(SUM(gl.debit), 0) AS total_debit, COALESCE(SUM(gl.credit), 0) AS total_credit
    FROM (${POSTED_GL_SUBQUERY}) gl
    WHERE gl.account_id = ? AND gl.entity_id = ?`;
  const params = [acc.id, entityId];
  if (asOfDate) {
    sql += ' AND gl.posting_date <= ?';
    params.push(asOfDate);
  }
  const row = await db.get(sql, params);
  const bal = calculateAccountBalance({ ...acc, total_debit: row?.total_debit, total_credit: row?.total_credit });
  return { accountId: acc.id, accountNumber, balance: Number(bal) };
}

export async function importOfxFile(db, {
  filePath,
  entityId = 'ent-ljc',
  bankAccountNumber = '1000',
  userId = DEMO_USER,
}) {
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = parseOFX(content, { strict: false });
  if (!parsed.success) {
    throw new Error(`OFX parse failed: ${(parsed.errors || []).join('; ')}`);
  }

  const existing = await getExistingFitidsForEntity(entityId);
  const dedup = deduplicateTransactions(parsed.transactions, existing);
  if (dedup.newCount === 0) {
    return { filePath, imported: 0, skipped: dedup.duplicateCount, message: 'All transactions already imported' };
  }

  await seedDefaultRules(db, entityId);
  const importId = `imp-${uuidv4()}`;
  const result = await commitBankImportTransactions(db, {
    entityId,
    transactions: dedup.newTransactions,
    importId,
    userId,
    sourceLabel: `OFX: ${path.basename(filePath)}`,
    bankAccountNumber,
  });

  return {
    filePath,
    importId,
    imported: result.createdJECount,
    skipped: dedup.duplicateCount,
    dateRange: parsed.dateRange,
  };
}

export async function postAllPendingImports(db, entityId, userId = DEMO_USER) {
  const rows = await db.all(
    `SELECT je.id FROM journal_entries je
     JOIN import_transactions it ON it.journal_entry_id = je.id
     WHERE je.entity_id = ? AND je.status = 'DRAFT' AND it.status = 'DRAFT'`,
    [entityId]
  );
  let posted = 0;
  for (const row of rows) {
    await postJournalEntryToGl(db, { journalId: row.id, entityId, userId });
    await db.run(
      "UPDATE import_transactions SET status = 'RECONCILED' WHERE journal_entry_id = ? AND entity_id = ?",
      [row.id, entityId]
    );
    posted += 1;
  }
  return { posted, pending: rows.length - posted };
}

export async function reconcileToTarget(db, {
  entityId,
  accountNumber,
  statementDate,
  endingBalance,
  userId = DEMO_USER,
}) {
  const acc = await db.get(
    'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, accountNumber]
  );
  if (!acc) throw new Error(`Account ${accountNumber} not found`);

  const entries = await db.all(
    `SELECT gl.id, gl.debit, gl.credit, gl.posting_date
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id
     WHERE gl.entity_id = ? AND gl.account_id = ?
       AND gl.reconciliation_status IS NULL
       AND je.status = 'POSTED'
       AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
       AND gl.posting_date <= ?
     ORDER BY gl.posting_date ASC`,
    [entityId, acc.id, statementDate]
  );

  const beginning = await db.get(
    `SELECT COALESCE(SUM(debit - credit), 0) AS bal FROM general_ledger
     WHERE entity_id = ? AND account_id = ? AND reconciliation_status IS NOT NULL`,
    [entityId, acc.id]
  );
  const begBal = new Decimal(beginning?.bal || 0);

  // Greedy: clear entries until cleared balance matches statement ending
  const target = new Decimal(endingBalance);
  const clearedIds = [];
  let running = begBal;
  for (const e of entries) {
    const delta = new Decimal(e.debit || 0).minus(e.credit || 0);
    running = running.plus(delta);
    clearedIds.push(e.id);
    if (running.minus(target).abs().lt(0.02)) break;
  }

  if (running.minus(target).abs().gte(0.02)) {
    return {
      reconciled: false,
      statementDate,
      endingBalance,
      computedBalance: running.toNumber(),
      variance: running.minus(target).toNumber(),
      clearedCount: 0,
      message: 'Could not match statement ending balance — check imports or ending balance',
    };
  }

  if (clearedIds.length) {
    const placeholders = clearedIds.map(() => '?').join(',');
    await db.run(
      `UPDATE general_ledger SET reconciliation_status = 'RECONCILED'
       WHERE id IN (${placeholders}) AND entity_id = ? AND account_id = ?`,
      [...clearedIds, entityId, acc.id]
    );
  }

  return {
    reconciled: true,
    statementDate,
    endingBalance,
    computedBalance: running.toNumber(),
    clearedCount: clearedIds.length,
  };
}

export async function closeYear2025(db, userId = DEMO_USER) {
  const entities = Object.keys(ENTITY_TB_FILES);
  const results = [];
  for (const entityId of entities) {
    const r = await closePeriod(db, {
      entityId,
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
      userId,
      notes: '2025 closed — tax package complete; 2026 operations open',
    });
    results.push({ entityId, ...r });
  }
  return results;
}

export function findOfxFiles(rootDir, importDir = 'data/bank-imports') {
  const base = path.join(rootDir, importDir);
  if (!fs.existsSync(base)) return [];
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.toLowerCase().endsWith('.ofx')) files.push(full);
    }
  };
  walk(base);
  return files.sort();
}

export async function build2026StatusReport(db, rootDir = process.cwd()) {
  const entities = Object.keys(ENTITY_TB_FILES);
  const ofxFiles = findOfxFiles(rootDir);
  const report = {
    generatedAt: new Date().toISOString(),
    ofxFilesFound: ofxFiles.map((f) => path.relative(rootDir, f)),
    entities: [],
    blockers: [],
  };

  if (ofxFiles.length === 0) {
    report.blockers.push({
      id: 'no_ofx',
      severity: 'critical',
      message: 'No OFX files in data/bank-imports/ — cannot import 2026 bank activity',
    });
  }

  for (const entityId of entities) {
    const entityRow = await db.get('SELECT name FROM entities WHERE id = ?', entityId);
    const pending = await db.get(
      `SELECT COUNT(*) AS c FROM import_transactions it
       JOIN journal_entries je ON je.id = it.journal_entry_id
       WHERE it.entity_id = ? AND je.status = 'DRAFT'`,
      [entityId]
    );
    const posted2026 = await db.get(
      `SELECT COUNT(*) AS c FROM journal_entries je
       WHERE je.entity_id = ? AND je.status = 'POSTED' AND je.posting_date >= '2026-01-01'
         AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
         AND je.je_number NOT LIKE 'OB-%' AND je.description NOT LIKE 'Opening balances%'`,
      [entityId]
    );

    const banks = [];
    for (const spec of BANK_ACCOUNTS[entityId] || [{ accountNumber: '1000' }]) {
      const bal = await getPostedBankBalance(db, entityId, spec.accountNumber);
      const targets = RECONCILIATION_TARGETS[entityId]?.[spec.accountNumber] || [];
      banks.push({
        accountNumber: spec.accountNumber,
        name: spec.name || spec.accountNumber,
        currentBalance: bal?.balance ?? null,
        reconciliationTargets: targets,
      });
    }

    const period2025 = await db.get(
      `SELECT status FROM accounting_periods
       WHERE entity_id = ? AND period_start = '2025-01-01' AND period_end = '2025-12-31'`,
      [entityId]
    );

    report.entities.push({
      entityId,
      name: entityRow?.name || entityId,
      period2025Closed: period2025?.status === 'CLOSED',
      postedTransactions2026: posted2026?.c || 0,
      pendingDraftImports: pending?.c || 0,
      bankAccounts: banks,
    });
  }

  const missingTargets = [];
  for (const [entityId, accounts] of Object.entries(RECONCILIATION_TARGETS)) {
    for (const [acct, targets] of Object.entries(accounts)) {
      for (const t of targets) {
        if (t.endingBalance == null) {
          missingTargets.push(`${entityId} acct ${acct} stmt ${t.statementDate}`);
        }
      }
    }
  }
  if (missingTargets.length) {
    report.blockers.push({
      id: 'missing_stmt_balances',
      severity: 'warning',
      message: 'Some reconciliation targets need statement ending balances',
      details: missingTargets,
    });
  }

  report.readyFor2026Ops = report.blockers.filter((b) => b.severity === 'critical').length === 0
    && report.entities.every((e) => e.period2025Closed);

  return report;
}
