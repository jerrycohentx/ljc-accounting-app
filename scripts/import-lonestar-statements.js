#!/usr/bin/env node
/**
 * Import Lone Star Bank ckg-7367 PDF statements → GL, reconcile through May 2026.
 * Usage: node scripts/import-lonestar-statements.js [pdf-dir-or-files...]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { getDatabase, closeDatabase } from '../config/database.js';
import { seedDatabaseContent } from '../config/bootstrap-seed.js';
import { runLonestarCatchUp } from '../lib/lonestar-catchup.js';
import { build2026StatusReport } from '../lib/bank-catchup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const DEMO_USER = 'usr-demo';

function extractPdf(pdfPath) {
  const raw = execFileSync('python3', [path.join(root, 'scripts/extract-simmons-pdf.py'), pdfPath], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function collectPdfs(args) {
  if (args.length) {
    return args.flatMap((a) => {
      const p = path.resolve(a);
      if (fs.statSync(p).isDirectory()) {
        return fs.readdirSync(p).filter((f) => f.toLowerCase().endsWith('.pdf')).map((f) => path.join(p, f));
      }
      return [p];
    });
  }
  const uploadDir = '/home/ubuntu/.cursor/projects/workspace/uploads';
  const dirs = [uploadDir, path.join(root, 'data/bank-imports/LJC/statements')];
  const files = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase().includes('7367') && f.toLowerCase().endsWith('.pdf')) {
        files.push(path.join(dir, f));
      }
    }
  }
  return [...new Set(files)];
}

function dedupeStatements(parsedList) {
  const byPeriod = new Map();
  for (const p of parsedList) {
    const key = p.meta?.periodEnd || p.file;
    const existing = byPeriod.get(key);
    if (!existing || p.transactionCount > existing.transactionCount) {
      byPeriod.set(key, p);
    }
  }
  return [...byPeriod.values()].sort((a, b) => (a.meta?.periodStart || '').localeCompare(b.meta?.periodStart || ''));
}

async function main() {
  const pdfs = collectPdfs(process.argv.slice(2));
  if (!pdfs.length) {
    console.error('No Lone Star PDF statements found (ckg-7367).');
    process.exit(1);
  }

  const parsed = [];
  for (const pdf of pdfs) {
    try {
      const data = extractPdf(pdf);
      if (data.error) throw new Error(data.error);
      parsed.push(data);
      console.log(
        `Parsed ${path.basename(pdf)}: ${data.transactionCount} txns, ending $${data.meta?.currentBalance ?? 'n/a'}, var ${data.netVariance ?? 'n/a'}`
      );
    } catch (e) {
      console.error(`Skip ${pdf}: ${e.message}`);
    }
  }

  const statements = dedupeStatements(parsed);
  if (!statements.length) {
    console.error('No valid statements parsed.');
    process.exit(1);
  }

  const jsonPath = path.join(root, 'data/bank-imports/LJC/lonestar-2026-statements.json');
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), statements }, null, 2));
  console.log(`Wrote ${jsonPath} (${statements.length} statements)`);

  const db = await getDatabase();
  await seedDatabaseContent(db);

  const result = await runLonestarCatchUp(db, { userId: DEMO_USER, rootDir: root });
  console.log(JSON.stringify(result, null, 2));

  const report = await build2026StatusReport(db, root);
  const outPath = path.join(root, 'data/reports/2026-status.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  await closeDatabase();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
