#!/usr/bin/env node
/**
 * Income Statement Reconciliation Diagnostic
 * ==========================================
 *
 * Read-only tool to explain why the Cohen Entities accounting app income
 * statement differs from QuickBooks Online (QBO) for a given entity/period
 * (defaults: LJC Financial — ent-ljc — January 2026).
 *
 * It does NOT modify any data. It reproduces the app's income-statement math
 * (routes/reports.js) and decomposes it so the gap vs QBO becomes visible:
 *
 *   1. App P&L (ALL general_ledger rows, matching current reports.js behavior).
 *   2. Posted-only P&L (general_ledger rows whose journal_entries.status =
 *      'POSTED' — what QBO-style "posted transactions only" should match).
 *   3. The delta between (1) and (2) = revenue/expense sitting in DRAFT or
 *      APPROVED journals that the app reports but QBO would not.
 *   4. Per-account decomposition by source (manual JE, bank OFX import,
 *      receipt collector, holdback draw/funds/adjustment) and by JE status.
 *   5. Anomaly flags: posting_date outside the period, JE created in a
 *      different month than its posting_date, and warehouse draw/wire fees
 *      booked to the P&L (a common QBO classification difference).
 *
 * Optionally paste QBO totals to get a line-by-line variance:
 *   QBO_REVENUE=12345.67 QBO_EXPENSE=8910.11 node scripts/reconcile-income-statement.js
 *
 * Usage:
 *   node scripts/reconcile-income-statement.js [entityId] [startDate] [endDate]
 *   node scripts/reconcile-income-statement.js ent-ljc 2026-01-01 2026-01-31
 *
 * Works against whatever database getDatabase() resolves to: local SQLite by
 * default, or production PostgreSQL when DATABASE_URL is set.
 */

import { getDatabase, isPostgres, closeDatabase } from '../config/database.js';

const [, , argEntity, argStart, argEnd] = process.argv;
const ENTITY_ID = argEntity || 'ent-ljc';
const START_DATE = argStart || '2026-01-01';
const END_DATE = argEnd || '2026-01-31';

const fmt = (n) =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);
const line = (c = '-', w = 92) => c.repeat(w);

function sourceBucket(jeNumber = '', memo = '') {
  const n = String(jeNumber).toUpperCase();
  if (n.startsWith('HB-FR-')) return 'Holdback funds received';
  if (n.startsWith('HB-ADJ-')) return 'Holdback fee correction';
  if (n.startsWith('HB-')) return 'Holdback draw disbursement';
  if (n.startsWith('IMP-')) return 'Bank OFX import';
  if (n.startsWith('RCPT-')) return 'Receipt collector';
  if (n.startsWith('JE-')) return 'Manual journal entry';
  if (/HOLDBACK-/.test(String(memo).toUpperCase())) return 'Holdback (memo-tagged)';
  return 'Other';
}

// Signed P&L contribution: revenue is credit-normal (credit - debit),
// expense is debit-normal (debit - credit). Matches reports.js calculateBalance.
function signedAmount(accountType, debit, credit) {
  const d = Number(debit || 0);
  const c = Number(credit || 0);
  return accountType === 'REVENUE' ? c - d : d - c;
}

async function tableExists(db, name) {
  try {
    if (isPostgres()) {
      const row = await db.get('SELECT to_regclass(?) AS t', [name]);
      return Boolean(row && row.t);
    }
    const row = await db.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      [name]
    );
    return Boolean(row);
  } catch {
    return false;
  }
}

async function main() {
  const db = await getDatabase();

  console.log(line('='));
  console.log('INCOME STATEMENT RECONCILIATION — app vs QBO');
  console.log(`Entity: ${ENTITY_ID}   Period: ${START_DATE} .. ${END_DATE}`);
  console.log(`Database: ${isPostgres() ? 'PostgreSQL (cloud)' : 'SQLite (local)'}`);
  console.log(line('='));

  const entity = await db.get('SELECT id, name, code FROM entities WHERE id = ?', [ENTITY_ID]);
  if (!entity) {
    console.error(`\n!! Entity '${ENTITY_ID}' not found. Available entities:`);
    const all = await db.all('SELECT id, name, code FROM entities ORDER BY id');
    all.forEach((e) => console.error(`   ${e.id}  ${e.code}  ${e.name}`));
    return;
  }
  console.log(`\nEntity: ${entity.name} (${entity.code})`);

  // Pull every P&L general-ledger row in the period, with JE status + identity.
  const rows = await db.all(
    `SELECT gl.id AS gl_id, gl.account_id, gl.debit, gl.credit, gl.posting_date,
            gl.created_at AS gl_created_at,
            a.account_number, a.account_name, a.account_type, a.is_active,
            je.id AS je_id, je.je_number, je.status AS je_status, je.memo,
            je.posting_date AS je_posting_date
       FROM general_ledger gl
       JOIN accounts a ON a.id = gl.account_id
       LEFT JOIN journal_entries je ON je.id = gl.journal_entry_id
      WHERE gl.entity_id = ?
        AND a.account_type IN ('REVENUE','EXPENSE')
        AND gl.posting_date >= ? AND gl.posting_date <= ?
      ORDER BY a.account_type, a.account_number, gl.posting_date`,
    [ENTITY_ID, START_DATE, END_DATE]
  );

  if (!rows.length) {
    console.log('\nNo REVENUE/EXPENSE general_ledger rows found in this period.');
    console.log('Either no P&L activity exists for this entity/period, or this database');
    console.log('is not the one backing production. Set DATABASE_URL to the production');
    console.log('PostgreSQL connection string and re-run to reconcile live data.');
    return;
  }

  // Aggregate per account: ALL vs POSTED-only, plus source/status breakdowns.
  const accounts = new Map();
  const statusTotals = new Map();
  const sourceTotals = new Map();
  const anomalies = [];

  for (const r of rows) {
    const key = r.account_number;
    if (!accounts.has(key)) {
      accounts.set(key, {
        number: r.account_number,
        name: r.account_name,
        type: r.account_type,
        isActive: r.is_active,
        all: 0,
        posted: 0,
        bySource: new Map(),
      });
    }
    const acc = accounts.get(key);
    const signed = signedAmount(r.account_type, r.debit, r.credit);
    const status = r.je_status || 'NO_JE';
    const bucket = sourceBucket(r.je_number, r.memo);

    acc.all += signed;
    if (status === 'POSTED') acc.posted += signed;
    acc.bySource.set(bucket, (acc.bySource.get(bucket) || 0) + signed);

    statusTotals.set(status, (statusTotals.get(status) || 0) + signed * (r.account_type === 'REVENUE' ? 1 : -1));
    sourceTotals.set(bucket, (sourceTotals.get(bucket) || 0) + signed * (r.account_type === 'REVENUE' ? 1 : -1));

    // Anomaly: posting_date and JE posting_date disagree (rare, but possible).
    if (r.je_posting_date && r.je_posting_date.slice(0, 10) !== r.posting_date.slice(0, 10)) {
      anomalies.push(`GL ${r.gl_id} posting_date ${r.posting_date} ≠ JE ${r.je_number} date ${r.je_posting_date}`);
    }
    // Anomaly: GL row created (entered) in a different month than posted.
    if (r.gl_created_at) {
      const created = String(r.gl_created_at).slice(0, 7);
      const posted = String(r.posting_date).slice(0, 7);
      if (created !== posted) {
        anomalies.push(`GL ${r.gl_id} (${r.account_number}) posted ${posted} but entered ${created} — period-cutoff risk`);
      }
    }
  }

  // ---- App income statement (ALL rows) vs Posted-only --------------------
  const sorted = [...accounts.values()].sort(
    (a, b) => a.type.localeCompare(b.type) || a.number.localeCompare(b.number)
  );

  let appRev = 0, appExp = 0, postedRev = 0, postedExp = 0;

  console.log('\n' + line());
  console.log(`${pad('Acct', 8)}${pad('Name', 34)}${pad('Type', 9)}${padL('App (all)', 14)}${padL('Posted only', 14)}${padL('Delta', 13)}`);
  console.log(line());
  for (const a of sorted) {
    const delta = a.all - a.posted;
    if (a.type === 'REVENUE') { appRev += a.all; postedRev += a.posted; }
    else { appExp += a.all; postedExp += a.posted; }
    const flag = Math.abs(delta) > 0.005 ? '  <- unposted in P&L' : '';
    const inactive = a.isActive === 0 || a.isActive === false ? ' [INACTIVE]' : '';
    console.log(
      `${pad(a.number, 8)}${pad((a.name || '').slice(0, 33), 34)}${pad(a.type, 9)}${padL(fmt(a.all), 14)}${padL(fmt(a.posted), 14)}${padL(fmt(delta), 13)}${flag}${inactive}`
    );
  }
  console.log(line());
  const appNet = appRev - appExp;
  const postedNet = postedRev - postedExp;
  console.log(`${pad('', 51)}${padL('App (all)', 14)}${padL('Posted only', 14)}`);
  console.log(`${pad('Total Revenue', 51)}${padL(fmt(appRev), 14)}${padL(fmt(postedRev), 14)}`);
  console.log(`${pad('Total Expense', 51)}${padL(fmt(appExp), 14)}${padL(fmt(postedExp), 14)}`);
  console.log(`${pad('NET INCOME', 51)}${padL(fmt(appNet), 14)}${padL(fmt(postedNet), 14)}`);

  // ---- Breakdown by JE status -------------------------------------------
  console.log('\n' + line());
  console.log('NET INCOME CONTRIBUTION BY JOURNAL STATUS  (app counts ALL of these; QBO ~ POSTED only)');
  console.log(line());
  for (const [status, amt] of [...statusTotals.entries()].sort((a, b) => b[1] - a[1])) {
    const note = status === 'POSTED' ? '' : '   <- excluded from a posted-only / QBO view';
    console.log(`  ${pad(status, 18)}${padL(fmt(amt), 16)}${note}`);
  }

  // ---- Breakdown by source ----------------------------------------------
  console.log('\n' + line());
  console.log('NET INCOME CONTRIBUTION BY SOURCE');
  console.log(line());
  for (const [src, amt] of [...sourceTotals.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(src, 28)}${padL(fmt(amt), 16)}`);
  }

  // ---- Warehouse draw/wire fee analysis (account 5100) ------------------
  const feeRows = rows.filter((r) => r.account_number === '5100');
  if (feeRows.length) {
    const insp = feeRows.filter((r) => /inspection/i.test(r.account_name + ' ' + (r.memo || '') ) || /inspection/i.test(String(r.gl_id)));
    let feeTotal = 0, draws = new Set();
    for (const r of feeRows) {
      feeTotal += signedAmount(r.account_type, r.debit, r.credit);
      if (r.je_number) draws.add(r.je_number);
    }
    console.log('\n' + line());
    console.log('WAREHOUSE DRAW / WIRE FEES (acct 5100 "Draw & Inspection Fees")');
    console.log(line());
    console.log(`  Total booked to 5100 in period: ${fmt(feeTotal)}  across ${draws.size} journal(s)`);
    console.log('  NOTE: the app books BOTH inspection fees AND the $35 wire fee per draw to');
    console.log('        expense 5100. If QBO treats wire fees as a borrower pass-through (to a');
    console.log('        receivable) or splits inspection vs bank charges, this line will differ.');
  }

  // ---- Anomalies ---------------------------------------------------------
  if (anomalies.length) {
    console.log('\n' + line());
    console.log(`PERIOD / DATE ANOMALIES (${anomalies.length})`);
    console.log(line());
    anomalies.slice(0, 25).forEach((a) => console.log('  ! ' + a));
    if (anomalies.length > 25) console.log(`  ... and ${anomalies.length - 25} more`);
  }

  // ---- Optional QBO variance --------------------------------------------
  const qboRev = process.env.QBO_REVENUE != null ? Number(process.env.QBO_REVENUE) : null;
  const qboExp = process.env.QBO_EXPENSE != null ? Number(process.env.QBO_EXPENSE) : null;
  if (qboRev != null || qboExp != null) {
    console.log('\n' + line());
    console.log('VARIANCE vs QBO (provided via QBO_REVENUE / QBO_EXPENSE)');
    console.log(line());
    if (qboRev != null) {
      console.log(`  Revenue : app(all) ${fmt(appRev)} | posted ${fmt(postedRev)} | QBO ${fmt(qboRev)} | app-QBO ${fmt(appRev - qboRev)} | posted-QBO ${fmt(postedRev - qboRev)}`);
    }
    if (qboExp != null) {
      console.log(`  Expense : app(all) ${fmt(appExp)} | posted ${fmt(postedExp)} | QBO ${fmt(qboExp)} | app-QBO ${fmt(appExp - qboExp)} | posted-QBO ${fmt(postedExp - qboExp)}`);
    }
    if (qboRev != null && qboExp != null) {
      const qboNet = qboRev - qboExp;
      console.log(`  Net Inc : app(all) ${fmt(appNet)} | posted ${fmt(postedNet)} | QBO ${fmt(qboNet)} | app-QBO ${fmt(appNet - qboNet)} | posted-QBO ${fmt(postedNet - qboNet)}`);
    }
  }

  console.log('\n' + line('='));
  console.log('HOW TO READ THIS:');
  console.log('  - "Delta" / non-POSTED rows: amounts the app income statement includes but a');
  console.log('    posted-only (QBO-style) view would not. reports.js does NOT filter by JE');
  console.log('    status, while bank reconciliation requires je.status = POSTED.');
  console.log('  - Source breakdown shows which subsystem (manual, bank import, holdback, etc.)');
  console.log('    drives the gap.');
  console.log('  - Provide QBO_REVENUE / QBO_EXPENSE env vars for an exact line-by-line variance.');
  console.log(line('='));
}

main()
  .catch((err) => {
    console.error('Reconciliation failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await closeDatabase(); } catch { /* ignore */ }
  });
