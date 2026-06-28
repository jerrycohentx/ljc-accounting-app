#!/usr/bin/env node
/**
 * Import Amex card 88007 Jan–Jun 2026 from PDF + CSV exports.
 * Usage: node scripts/import-amex-statements.js [files...]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { getDatabase, closeDatabase } from '../config/database.js';
import { seedDatabaseContent } from '../config/bootstrap-seed.js';
import { parseAmexCsvFile } from '../lib/parse-amex-csv.js';
import { runAmexCatchUp } from '../lib/amex-catchup.js';
import { build2026StatusReport } from '../lib/bank-catchup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const DEMO_USER = 'usr-demo';
const UPLOAD = '/home/ubuntu/.cursor/projects/workspace/uploads';

const CSV_META = {
  'April_2833.csv': { closingDate: '2026-04-08', previousBalance: 84369.45, newBalance: 84148.66 },
  'May_a08e.csv': { closingDate: '2026-05-08', previousBalance: 84148.66, newBalance: 82982.56 },
  'June_3a0d.csv': { closingDate: '2026-06-08', previousBalance: 82982.56, newBalance: 83162.65 },
};

function extractPdf(pdfPath) {
  const raw = execFileSync('python3', [path.join(root, 'scripts/extract-amex-pdf.py'), pdfPath], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function collectFiles(args) {
  if (args.length) {
    return args.map((a) => path.resolve(a));
  }
  const files = [];
  for (const dir of [UPLOAD, path.join(root, 'data/bank-imports/LJC/amex')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const lower = f.toLowerCase();
      if ((lower.endsWith('.pdf') && lower.includes('2026-') && !lower.includes('ckg_260') && !lower.includes('7367'))
        || (lower.endsWith('.csv') && /^(april|may|june)_/i.test(f))) {
        files.push(path.join(dir, f));
      }
    }
  }
  return [...new Set(files)];
}

async function main() {
  const files = collectFiles(process.argv.slice(2));
  const parsed = [];

  for (const file of files) {
    try {
      if (file.toLowerCase().endsWith('.pdf')) {
        const data = extractPdf(file);
        if (data.error) throw new Error(data.error);
        parsed.push(data);
        console.log(`Parsed PDF ${path.basename(file)}: ${data.transactionCount} txns, close $${data.meta?.newBalance}, var ${data.netVariance ?? 'n/a'}`);
      } else if (file.toLowerCase().endsWith('.csv')) {
        const base = path.basename(file);
        const meta = CSV_META[base] || {};
        const data = parseAmexCsvFile(file, meta);
        parsed.push(data);
        console.log(`Parsed CSV ${base}: ${data.transactionCount} txns, net ${data.netChange}, var ${data.netVariance ?? 'n/a'}`);
      }
    } catch (e) {
      console.error(`Skip ${file}: ${e.message}`);
    }
  }

  const byClose = new Map();
  for (const p of parsed) {
    const key = p.meta?.closingDate || p.file;
    const existing = byClose.get(key);
    if (!existing || p.transactionCount > existing.transactionCount) byClose.set(key, p);
  }
  const statements = [...byClose.values()].sort((a, b) =>
    (a.meta?.closingDate || '').localeCompare(b.meta?.closingDate || '')
  );

  if (!statements.length) {
    console.error('No Amex statements parsed.');
    process.exit(1);
  }

  const jsonPath = path.join(root, 'data/bank-imports/LJC/amex-2026-statements.json');
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), statements }, null, 2));
  console.log(`Wrote ${jsonPath} (${statements.length} statements, ${statements.reduce((s, x) => s + x.transactionCount, 0)} txns)`);

  const db = await getDatabase();
  await seedDatabaseContent(db);
  const result = await runAmexCatchUp(db, { userId: DEMO_USER, rootDir: root });
  console.log(JSON.stringify(result, null, 2));

  const report = await build2026StatusReport(db, root);
  fs.writeFileSync(path.join(root, 'data/reports/2026-status.json'), JSON.stringify(report, null, 2));
  await closeDatabase();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
