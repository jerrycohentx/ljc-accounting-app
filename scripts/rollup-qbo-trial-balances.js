#!/usr/bin/env node
/**
 * Roll up QBO trial balance CSVs into app opening-balance files.
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
import { ENTITY_TB_FILES, ENTITY_ROLLUP_CONFIG } from '../config/opening-balance-mappings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const sourceDir = process.argv[2] || path.join(root, 'data/qbo-trial-balances/2025-12-31');
const asOfDate = process.argv[3] || '2025-12-31';
const outDir = path.join(root, 'data/opening-balances', asOfDate);

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const summary = [];

for (const [entityId, fileName] of Object.entries(ENTITY_TB_FILES)) {
  const filePath = path.join(sourceDir, fileName);
  if (!fs.existsSync(filePath)) {
    // Try alternate upload naming
    const alt = fs.readdirSync(sourceDir).find((f) => f.toLowerCase().includes(fileName.split('_')[1]?.toLowerCase().slice(0, 8)));
    if (!alt) {
      console.warn(`Missing: ${fileName}`);
      continue;
    }
  }

  const resolved = fs.existsSync(filePath)
    ? filePath
    : path.join(sourceDir, fs.readdirSync(sourceDir).find((f) => f.includes(entityId.replace('ent-', ''))) || fileName);

  const csvText = fs.readFileSync(resolved, 'utf8');
  const rows = parseQboTrialBalance(csvText);
  const source = verifySourceBalance(rows);
  const config = ENTITY_ROLLUP_CONFIG[entityId];
  const { balances, unmapped } = rollupTrialBalance(rows, config.mappings, config.fallbacks);

  const csvOut = ['account_number,balance', ...balances.map((b) => `${b.accountNumber},${b.balance}`)].join('\n');
  const outFile = path.join(outDir, `${entityId}-opening-balances.csv`);
  fs.writeFileSync(outFile, csvOut);

  summary.push({
    entityId,
    sourceFile: path.basename(resolved),
    sourceBalanced: source.balanced,
    sourceTotal: source.totalDebit,
    accountCount: balances.length,
    unmappedCount: unmapped.length,
    outFile: path.relative(root, outFile),
  });

  if (unmapped.length) {
    fs.writeFileSync(
      path.join(outDir, `${entityId}-unmapped.txt`),
      unmapped.join('\n')
    );
  }
}

console.log(JSON.stringify({ asOfDate, summary }, null, 2));
