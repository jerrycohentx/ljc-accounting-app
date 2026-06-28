#!/usr/bin/env node
/**
 * Generate tax-return-ready financial packages for all Cohen entities.
 * Usage: node scripts/generate-tax-package.js [taxYear]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDatabase, closeDatabase } from '../config/database.js';
import { seedDatabaseContent } from '../config/bootstrap-seed.js';
import { buildAllEntitiesTaxPackage, taxPackageToCsv } from '../lib/tax-financials.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const taxYear = parseInt(process.argv[2] || '2025', 10);

const db = await getDatabase();
await seedDatabaseContent(db);

const pkg = await buildAllEntitiesTaxPackage(db, { taxYear, rootDir: root });
const outDir = path.join(root, 'data/tax-packages', String(taxYear));
fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(outDir, 'tax-package.json'), JSON.stringify(pkg, null, 2));

for (const entity of pkg.entities) {
  fs.writeFileSync(
    path.join(outDir, `${entity.entityId}-tax-${taxYear}.csv`),
    taxPackageToCsv(entity)
  );
}

console.log(JSON.stringify({
  taxYear,
  allTaxReturnReady: pkg.allTaxReturnReady,
  intercompanyTied: pkg.intercompany.allTied,
  entities: pkg.entities.map((e) => ({
    name: e.entityName,
    taxReturnReady: e.taxReturnReady,
    netIncome: e.incomeStatement.netIncome,
    totalAssets: e.balanceSheet.totalAssets,
  })),
  outputDir: path.relative(root, outDir),
}, null, 2));

await closeDatabase();
process.exitCode = pkg.allTaxReturnReady ? 0 : 1;
