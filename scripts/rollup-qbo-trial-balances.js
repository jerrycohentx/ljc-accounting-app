#!/usr/bin/env node
/**
 * Roll up QBO trial balances and apply intercompany tie-out.
 * Usage: node scripts/rollup-qbo-trial-balances.js [sourceDir] [asOfDate]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseQboTrialBalance,
  rollupTrialBalance,
  verifySourceBalance,
} from '../lib/qbo-trial-balance.js';
import { tieOutRollups } from '../lib/intercompany-tieout.js';
import { ENTITY_TB_FILES, ENTITY_ROLLUP_CONFIG } from '../config/opening-balance-mappings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const sourceDir = process.argv[2] || path.join(root, 'data/qbo-trial-balances/2025-12-31');
const asOfDate = process.argv[3] || '2025-12-31';
const outDir = path.join(root, 'data/opening-balances', asOfDate);

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const rollupsByEntity = {};
const qboRowsByEntity = {};
const summary = [];

for (const [entityId, fileName] of Object.entries(ENTITY_TB_FILES)) {
  const filePath = path.join(sourceDir, fileName);
  if (!fs.existsSync(filePath)) {
    console.warn(`Missing: ${fileName}`);
    continue;
  }

  const csvText = fs.readFileSync(filePath, 'utf8');
  const rows = parseQboTrialBalance(csvText);
  qboRowsByEntity[entityId] = rows;
  const source = verifySourceBalance(rows);
  const config = ENTITY_ROLLUP_CONFIG[entityId];
  const { balances, unmapped } = rollupTrialBalance(rows, config.mappings, config.fallbacks);
  rollupsByEntity[entityId] = balances;

  summary.push({
    entityId,
    sourceFile: path.basename(filePath),
    sourceBalanced: source.balanced,
    preTieAccountCount: balances.length,
    unmappedCount: unmapped.length,
  });

  if (unmapped.length) {
    fs.writeFileSync(path.join(outDir, `${entityId}-unmapped.txt`), unmapped.join('\n'));
  }
}

const { tiedRollups, tieReport, verification } = tieOutRollups(rollupsByEntity, qboRowsByEntity);

for (const [entityId, balances] of Object.entries(tiedRollups)) {
  const csvOut = ['account_number,balance', ...balances.map((b) => `${b.accountNumber},${b.balance}`)].join('\n');
  fs.writeFileSync(path.join(outDir, `${entityId}-opening-balances.csv`), csvOut);
}

fs.writeFileSync(
  path.join(outDir, 'intercompany-tieout.json'),
  JSON.stringify({ asOfDate, tieReport, verification }, null, 2)
);

console.log(JSON.stringify({ asOfDate, summary, verification, tieReport }, null, 2));

if (!verification.allTied) {
  process.exitCode = 1;
}
