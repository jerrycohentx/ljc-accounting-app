#!/usr/bin/env node
/**
 * 2026 catch-up: import OFX → categorize → post → reconcile → close 2025.
 *
 * Usage:
 *   node scripts/catch-up-2026.js --status
 *   node scripts/catch-up-2026.js --close-2025
 *   node scripts/catch-up-2026.js --import-all
 *   node scripts/catch-up-2026.js --post-all
 *   node scripts/catch-up-2026.js --reconcile
 *   node scripts/catch-up-2026.js --full
 *   node scripts/catch-up-2026.js --ofx path/to/file.ofx --entity ent-ljc --account 1000
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDatabase, closeDatabase } from '../config/database.js';
import { seedDatabaseContent } from '../config/bootstrap-seed.js';
import {
  importOfxFile,
  postAllPendingImports,
  reconcileToTarget,
  closeYear2025,
  findOfxFiles,
  build2026StatusReport,
  getPostedBankBalance,
} from '../lib/bank-catchup.js';
import { BANK_ACCOUNTS, RECONCILIATION_TARGETS, IMPORT_DIR } from '../config/bank-import-targets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

function inferEntityFromPath(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (base.includes('justin')) return 'ent-justin';
  if (base.includes('omc')) return 'ent-omc';
  if (base.includes('graceful') || base.includes('_gm_')) return 'ent-gm';
  if (base.includes('qof')) return 'ent-qof';
  if (base.includes('4j') || base.includes('4jl')) return 'ent-4jl';
  return 'ent-ljc';
}

function inferAccountFromPath(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (base.includes('7367') || base.includes('lone') || base.includes('1001')) return '1001';
  return '1000';
}

async function runImportAll(db) {
  fs.mkdirSync(path.join(root, IMPORT_DIR), { recursive: true });
  const files = findOfxFiles(root);
  if (!files.length) {
    console.log(`No OFX files in ${IMPORT_DIR}/ — drop bank exports there and re-run.`);
    return [];
  }
  const results = [];
  for (const filePath of files) {
    const entityId = getArg('--entity') || inferEntityFromPath(filePath);
    const account = getArg('--account') || inferAccountFromPath(filePath);
    try {
      const r = await importOfxFile(db, { filePath, entityId, bankAccountNumber: account });
      results.push({ ...r, entityId, account });
      console.log(`Imported ${r.imported} from ${path.basename(filePath)} (${entityId} acct ${account})`);
    } catch (e) {
      results.push({ filePath, error: e.message });
      console.error(`Failed ${filePath}: ${e.message}`);
    }
  }
  return results;
}

async function runReconcileAll(db) {
  const results = [];
  for (const [entityId, accounts] of Object.entries(RECONCILIATION_TARGETS)) {
    for (const [accountNumber, targets] of Object.entries(accounts)) {
      for (const target of targets) {
        if (target.endingBalance == null) continue;
        const r = await reconcileToTarget(db, {
          entityId,
          accountNumber,
          statementDate: target.statementDate,
          endingBalance: target.endingBalance,
        });
        results.push({ entityId, accountNumber, ...r });
        console.log(
          r.reconciled
            ? `✓ Reconciled ${entityId} ${accountNumber} to ${target.endingBalance} on ${target.statementDate}`
            : `✗ Reconcile failed ${entityId} ${accountNumber}: variance ${r.variance}`
        );
      }
    }
  }
  return results;
}

async function main() {
  const db = await getDatabase();
  await seedDatabaseContent(db);

  if (flags.has('--status') || args.length === 0) {
    const report = await build2026StatusReport(db, root);
    console.log(JSON.stringify(report, null, 2));
    await closeDatabase();
    process.exitCode = report.ofxFilesFound.length ? 0 : 1;
    return;
  }

  if (flags.has('--close-2025')) {
    const closed = await closeYear2025(db);
    console.log('Closed 2025 for', closed.length, 'entities');
  }

  const ofxPath = getArg('--ofx');
  if (ofxPath) {
    const entityId = getArg('--entity') || 'ent-ljc';
    const account = getArg('--account') || '1000';
    const r = await importOfxFile(db, { filePath: path.resolve(ofxPath), entityId, bankAccountNumber: account });
    console.log(JSON.stringify(r, null, 2));
  }

  if (flags.has('--import-all') || flags.has('--full')) {
    await runImportAll(db);
  }

  if (flags.has('--post-all') || flags.has('--full')) {
    for (const entityId of Object.keys(BANK_ACCOUNTS)) {
      const r = await postAllPendingImports(db, entityId);
      if (r.posted) console.log(`Posted ${r.posted} pending imports for ${entityId}`);
    }
  }

  if (flags.has('--reconcile') || flags.has('--full')) {
    await runReconcileAll(db);
  }

  if (flags.has('--full')) {
    await closeYear2025(db);
  }

  const ljc = await getPostedBankBalance(db, 'ent-ljc', '1000');
  console.log('\nLJC Simmons (1000) posted balance:', ljc?.balance);

  const report = await build2026StatusReport(db, root);
  const outPath = path.join(root, 'data/reports/2026-status.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('Status written to', path.relative(root, outPath));

  await closeDatabase();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
