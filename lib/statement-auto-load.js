import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BANK_ACCOUNTS } from '../config/bank-import-targets.js';
import { prepareReconciliation, listImportFolder } from './reconcile-prepare.js';
import { findOfxFiles } from './bank-catchup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const LOG_DIR = process.env.STATEMENT_AUTO_LOAD_LOG_DIR || path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'statement-auto-load.json');
const INTERVAL_MS = Math.max(
  1,
  Number(process.env.STATEMENT_AUTO_LOAD_INTERVAL_HOURS || 24)
) * 60 * 60 * 1000;
const ENTITIES = (process.env.STATEMENT_AUTO_LOAD_ENTITIES || 'ent-ljc')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let timer = null;
let lastRunAt = null;
let lastRunError = null;
let lastRunSummary = null;
let running = false;

function readLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function appendLog(entry) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const rows = readLog();
  rows.unshift(entry);
  fs.writeFileSync(LOG_FILE, JSON.stringify(rows.slice(0, 50), null, 2));
}

/**
 * For each configured bank account, import new OFX from data/bank-imports/ and refresh statement metadata.
 */
export async function runStatementAutoLoad(db, { reason = 'scheduled' } = {}) {
  if (running) {
    return { skipped: true, reason: 'already running' };
  }
  running = true;
  const started = new Date().toISOString();
  const accountResults = [];

  try {
    for (const entityId of ENTITIES) {
      const specs = BANK_ACCOUNTS[entityId] || [];
      for (const spec of specs) {
        const account = await db.get(
          'SELECT id, account_number, account_name FROM accounts WHERE entity_id = ? AND account_number = ?',
          [entityId, spec.accountNumber]
        );
        if (!account) {
          accountResults.push({
            entityId,
            accountNumber: spec.accountNumber,
            skipped: true,
            message: 'Account not in chart of accounts',
          });
          continue;
        }

        try {
          const prepared = await prepareReconciliation(db, {
            entityId,
            accountId: account.id,
            userId: 'usr-admin',
            importFromFolder: true,
          });
          accountResults.push({
            entityId,
            accountNumber: spec.accountNumber,
            accountName: account.account_name,
            statementDate: prepared.statementDate,
            endingBalance: prepared.endingBalance,
            statementLineCount: prepared.statementLineCount,
            source: prepared.source,
            folderImport: prepared.folderImport?.imported
              ? { imported: prepared.folderImport.imported, skippedDuplicates: prepared.folderImport.skippedDuplicates }
              : prepared.folderImport?.error
                ? { error: prepared.folderImport.error }
                : null,
            message: prepared.message,
          });
        } catch (err) {
          accountResults.push({
            entityId,
            accountNumber: spec.accountNumber,
            error: err.message,
          });
        }
      }
    }

    const summary = {
      reason,
      startedAt: started,
      finishedAt: new Date().toISOString(),
      entities: ENTITIES,
      importFolderFiles: listImportFolder(),
      ofxFiles: findOfxFiles(ROOT).map((f) => path.relative(ROOT, f).replace(/\\/g, '/')),
      accounts: accountResults,
    };

    lastRunAt = summary.finishedAt;
    lastRunError = null;
    lastRunSummary = summary;
    appendLog(summary);
    return summary;
  } catch (err) {
    lastRunError = err.message;
    throw err;
  } finally {
    running = false;
  }
}

export function getStatementAutoLoadStatus() {
  return {
    enabled: process.env.STATEMENT_AUTO_LOAD_ENABLED !== '0',
    intervalHours: INTERVAL_MS / (60 * 60 * 1000),
    entities: ENTITIES,
    lastRunAt,
    lastRunError,
    lastRunSummary,
    importFolder: 'data/bank-imports/',
    logFile: path.relative(ROOT, LOG_FILE),
  };
}

export function startStatementAutoLoad(getDb) {
  if (process.env.STATEMENT_AUTO_LOAD_ENABLED === '0') {
    console.log('Statement auto-load disabled (STATEMENT_AUTO_LOAD_ENABLED=0)');
    return;
  }

  const tick = async (reason) => {
    try {
      const db = await getDb();
      const result = await runStatementAutoLoad(db, { reason });
      const ok = (result.accounts || []).filter((a) => !a.error && !a.skipped).length;
      console.log(`✓ Statement auto-load (${reason}): ${ok} account(s) refreshed`);
    } catch (err) {
      console.error('Statement auto-load failed:', err.message);
    }
  };

  if (process.env.STATEMENT_AUTO_LOAD_ON_STARTUP !== '0') {
    setTimeout(() => tick('startup'), 8000);
  }

  timer = setInterval(() => tick('scheduled'), INTERVAL_MS);
  console.log(`✓ Statement auto-load scheduled every ${INTERVAL_MS / (60 * 60 * 1000)}h`);
}

export function stopStatementAutoLoad() {
  if (timer) clearInterval(timer);
  timer = null;
}
