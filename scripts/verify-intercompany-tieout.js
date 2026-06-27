#!/usr/bin/env node
/**
 * Verify intercompany pairs tie across all entities (from opening balance CSVs or live GL).
 * Usage: node scripts/verify-intercompany-tieout.js [asOfDate]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDatabase, closeDatabase } from '../config/database.js';
import { parseOpeningBalanceCsv } from '../lib/opening-balances.js';
import { balancesToMap, verifyIntercompanyTieout, INTERCOMPANY_PAIRS } from '../lib/intercompany-tieout.js';
import { ENTITY_TB_FILES } from '../config/opening-balance-mappings.js';
import Decimal from 'decimal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const asOfDate = process.argv[2] || '2025-12-31';
const fromGl = process.argv.includes('--gl');
const obDir = path.join(root, 'data/opening-balances', asOfDate);

const balanceMaps = {};

if (fromGl) {
  const db = await getDatabase();
  for (const entityId of Object.keys(ENTITY_TB_FILES)) {
    balanceMaps[entityId] = new Map();
    for (const pair of INTERCOMPANY_PAIRS) {
      for (const side of [pair.sideA, pair.sideB]) {
        if (side.entity !== entityId || balanceMaps[entityId].has(side.account)) continue;
        const acc = await db.get(
          'SELECT id, normal_balance FROM accounts WHERE entity_id = ? AND account_number = ?',
          [entityId, side.account]
        );
        if (!acc) continue;
        const row = await db.get(
          `SELECT COALESCE(SUM(debit),0) as td, COALESCE(SUM(credit),0) as tc
           FROM general_ledger gl
           JOIN journal_entries je ON je.id = gl.journal_entry_id AND je.status = 'POSTED'
           WHERE gl.account_id = ? AND gl.entity_id = ? AND gl.posting_date <= ?`,
          [acc.id, entityId, asOfDate]
        );
        const td = new Decimal(row?.td || 0);
        const tc = new Decimal(row?.tc || 0);
        const bal = acc.normal_balance === 'DEBIT' ? td.minus(tc) : tc.minus(td);
        if (bal.abs().gt(0.004)) balanceMaps[entityId].set(side.account, bal);
      }
    }
  }
  await closeDatabase();
} else {
  for (const entityId of Object.keys(ENTITY_TB_FILES)) {
    const filePath = path.join(obDir, `${entityId}-opening-balances.csv`);
    if (!fs.existsSync(filePath)) continue;
    balanceMaps[entityId] = balancesToMap(parseOpeningBalanceCsv(fs.readFileSync(filePath, 'utf8')));
  }
}

const verification = verifyIntercompanyTieout(balanceMaps);
console.log(JSON.stringify(verification, null, 2));
process.exitCode = verification.allTied ? 0 : 1;
