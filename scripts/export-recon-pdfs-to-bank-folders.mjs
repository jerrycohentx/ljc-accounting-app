/**
 * Download closed recon PDFs from production into Jerry's OneDrive bank folders:
 *   Banks / {Bank} / Reconciliations / {year} / Reconciliation_....pdf
 */
import fs from 'fs';
import path from 'path';
import { reconExportDir, BANKS_ROOT_DEFAULT } from '../config/recon-bank-folders.js';

const BASE = process.env.APP_URL || 'https://ljc-accounting-app.onrender.com';
const BANKS_ROOT = process.env.RECON_BANKS_ROOT || BANKS_ROOT_DEFAULT;

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'demo@ljcfinancial.com', password: 'demo123' }),
}).then((r) => r.json());
if (!login.token) {
  console.error('login failed', login);
  process.exit(1);
}
const token = login.token;
const h = async (url, opts = {}) => {
  const r = await fetch(url.startsWith('http') ? url : BASE + url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return { status: r.status, json: await r.json(), buf: null };
  }
  return { status: r.status, json: null, buf: Buffer.from(await r.arrayBuffer()) };
};

console.log('Prune duplicates…');
console.log(await h('/api/reconciliation/reports/prune-duplicates', {
  method: 'POST',
  body: JSON.stringify({ entityId: 'ent-ljc' }),
}).then((x) => x.json));

console.log('Refresh closed archives Jan–Jun 2026…');
const refreshed = await h('/api/reconciliation/reports/refresh-closed', {
  method: 'POST',
  body: JSON.stringify({
    entityId: 'ent-ljc',
    fromDate: '2026-01-01',
    toDate: '2026-06-30',
  }),
});
console.log(JSON.stringify(refreshed.json, null, 2).slice(0, 3000));

const list = await h('/api/reconciliation/reports?entityId=ent-ljc&canonicalOnly=1');
const reports = list.json?.reports || [];
console.log('Canonical reports:', reports.length);

const written = [];
for (const r of reports) {
  if (!r.is_closed) continue;
  const sd = String(r.statement_date).slice(0, 10);
  if (sd < '2026-01-01' || sd > '2026-06-30') continue;
  const { dir, shortLabel } = reconExportDir(r.account_number, sd, BANKS_ROOT);
  fs.mkdirSync(dir, { recursive: true });
  const fname = `Reconciliation_${shortLabel.replace(/[^A-Za-z0-9]+/g, '_')}_${sd}_both.pdf`;
  const dest = path.join(dir, fname);
  const pdf = await h(`/api/reconciliation/reports/${r.id}/pdf?mode=both`);
  if (pdf.status !== 200 || !pdf.buf?.length) {
    console.error('PDF fail', r.id, pdf.status);
    continue;
  }
  fs.writeFileSync(dest, pdf.buf);
  written.push(dest);
  console.log('Wrote', dest, `(${pdf.buf.length} bytes)`);
}

console.log(JSON.stringify({ banksRoot: BANKS_ROOT, written: written.length, files: written }, null, 2));
