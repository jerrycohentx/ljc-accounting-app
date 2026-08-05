import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parsePdfBuffer } from '../lib/pdf-parse-compat.js';
import { parseChaseCcVendorsFromText } from '../lib/vendor-defaults-list.js';
import { deriveVendorPattern } from '../lib/vendor-category-rule.js';

const zip = process.argv[2] || 'C:\\Users\\jerry\\OneDrive\\Desktop\\Downloads-Jerry OneDrive\\OMC CC.zip';
const member = process.argv[3] || '20260118-statements-6508-.pdf';
const outPath = process.argv[4] || 'data/vendor-statement-seeds/ent-omc/2026-01-chase-cc.json';

const script =
  'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); sys.stdout.buffer.write(z.read(sys.argv[2]))';
const buf = execSync(`python -c "${script}" "${zip}" "${member}"`, { maxBuffer: 10 * 1024 * 1024 });
const text = await parsePdfBuffer(buf);
const raw = parseChaseCcVendorsFromText(text);
const byPattern = new Map();
for (const v of raw) {
  const pattern = deriveVendorPattern(v.description);
  if (!pattern) continue;
  const key = pattern.toUpperCase();
  const cur = byPattern.get(key) || {
    pattern: key,
    sampleDescription: v.description,
    transactionCount: 0,
    totalAmount: 0,
  };
  cur.transactionCount += 1;
  cur.totalAmount += v.amount;
  byPattern.set(key, cur);
}
const payload = {
  entityId: 'ent-omc',
  month: '2026-01',
  statementSource: `${zip}!${member}`,
  statementEnding: '2026-01-18',
  cardLast4: '6508',
  vendors: [...byPattern.values()].sort((a, b) => b.totalAmount - a.totalAmount),
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log('Wrote', outPath, '—', payload.vendors.length, 'vendors');
payload.vendors.forEach((v) => console.log(`  ${v.totalAmount.toFixed(2)}  ${v.pattern}`));
