import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { extractChaseCcPdfFromBuffer } from '../lib/extract-chase-cc-pdf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const zip = 'C:/Users/jerry/OneDrive/Desktop/Downloads-Jerry OneDrive/OMC CC.zip';
const member = '20260118-statements-6508-.pdf';
const outRel = 'data/bank-imports/OMC/chase-6508-2026-statements.json';
const pdfOutDir = path.join(ROOT, 'data/bank-imports/OMC/chase');

if (!fs.existsSync(zip)) {
  console.error('Zip not found:', zip);
  process.exit(1);
}
const script =
  'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); sys.stdout.buffer.write(z.read(sys.argv[2]))';
const buf = execSync(`python -c "${script}" "${zip}" "${member}"`, { maxBuffer: 10 * 1024 * 1024 });
const parsed = await extractChaseCcPdfFromBuffer(buf, { last4: '6508' });
parsed.meta.periodEnd = parsed.meta.periodEnd || '2026-01-18';
parsed.meta.periodStart = parsed.meta.periodStart || '2025-12-19';
parsed.meta.currentBalance = parsed.meta.currentBalance ?? 6530.77;
parsed.meta.previousBalance = parsed.meta.previousBalance ?? 0;
parsed.meta.accountLast4 = '6508';
parsed.file = member;

const doc = {
  generatedAt: new Date().toISOString(),
  entityId: 'ent-omc',
  statements: [parsed],
};
const outPath = path.join(ROOT, outRel);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.mkdirSync(pdfOutDir, { recursive: true });
fs.writeFileSync(path.join(pdfOutDir, member), buf);
fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));
console.log('Wrote', outRel, '—', parsed.transactions.length, 'transactions');
console.log('Copied PDF to', path.join('data/bank-imports/OMC/chase', member));
