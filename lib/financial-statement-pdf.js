/**
 * Render a QuickBooks-Desktop-style Balance Sheet or Profit & Loss to PDF.
 *
 * `buildStatementHtml()` is pure (no browser) so it can be unit-tested;
 * `renderFinancialStatementPdf()` prints it via the bundled headless Chromium
 * (see lib/playwright-browsers.js), same as the reconciliation report.
 *
 * Two layouts, matching QuickBooks:
 *  - Single period: one money column, stepped rightward by account depth
 *    (leaf amounts leftmost, grand totals rightmost), single-rule subtotals,
 *    double-rule grand totals.
 *  - Comparison: fixed columns [period] [compare period] [$ Change] [% Change],
 *    hierarchy shown by label indentation.
 */

import fs from 'fs';
import { ensurePlaywrightBrowsers, getPlaywrightBrowsersPath } from './playwright-browsers.js';

let playwrightModule = null;
async function loadPlaywright() {
  if (playwrightModule) return playwrightModule;
  try {
    playwrightModule = await import('playwright');
    return playwrightModule;
  } catch {
    throw new Error('Playwright is not installed. Run: npm install && npx playwright install chromium');
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function money(n) {
  if (n == null) return '';
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-${s}` : s;
}
function pct(n) {
  if (n == null) return '';
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return `${v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function iso(d) {
  if (!d) return '';
  const m = String(d).match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : '';
}
function shortDate(d) {
  const s = iso(d);
  if (!s) return String(d || '');
  const [y, mo, da] = s.split('-');
  return `${MONTHS[Number(mo) - 1]} ${Number(da)}, ${y.slice(2)}`;
}
function isFirstOfMonth(s) { return /-01$/.test(iso(s)); }
function isLastOfMonth(s) {
  const t = iso(s);
  if (!t) return false;
  const [y, mo] = t.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return Number(t.slice(8, 10)) === last;
}
/** P&L period column label, QuickBooks-style: "Jan - Mar 25", "Mar 25", else date range. */
function periodLabel(start, end) {
  const s = iso(start); const e = iso(end);
  if (!s || !e) return '';
  const [sy, sm] = s.split('-').map(Number);
  const [ey, em] = e.split('-').map(Number);
  if (isFirstOfMonth(s) && isLastOfMonth(e) && sy === ey) {
    if (sm === em) return `${MONTHS[sm - 1]} ${String(sy).slice(2)}`;
    return `${MONTHS[sm - 1]} - ${MONTHS[em - 1]} ${String(sy).slice(2)}`;
  }
  return `${shortDate(s)} - ${shortDate(e)}`;
}

function colLabel(statement) {
  const h = statement.header;
  return h.reportType === 'balance_sheet' ? shortDate(h.asOfDate) : periodLabel(h.startDate, h.endDate);
}
function compareColLabel(statement) {
  const h = statement.header;
  const cp = statement.comparison?.period;
  if (cp) return cp;
  return h.reportType === 'balance_sheet' ? 'Prior' : 'Prior';
}

function headerHtml(statement) {
  const h = statement.header;
  let gen = '';
  if (h.generatedAt) {
    const gd = h.generatedAt instanceof Date ? h.generatedAt : new Date(h.generatedAt);
    if (!Number.isNaN(gd.getTime())) {
      let hr = gd.getHours(); const ap = hr >= 12 ? 'PM' : 'AM'; hr = hr % 12 || 12;
      const mm = String(gd.getMinutes()).padStart(2, '0');
      const dd = `${String(gd.getMonth() + 1).padStart(2, '0')}/${String(gd.getDate()).padStart(2, '0')}/${String(gd.getFullYear()).slice(2)}`;
      gen = `${hr}:${mm} ${ap}<br>${dd}<br>${esc(h.basis || 'Accrual Basis')}`;
    }
  }
  const periodLine = h.reportType === 'balance_sheet'
    ? `As of ${shortDateLong(h.asOfDate)}`
    : periodLine_pl(h.startDate, h.endDate);
  return `<div class="hdr">
    <div class="tl">${gen}</div>
    <div class="ctr">
      <div class="co">${esc(h.companyName || 'LJC Financial, LLC')}</div>
      <div class="rt">${esc(h.title)}</div>
      <div class="ac">${esc(periodLine)}</div>
    </div>
  </div>`;
}
function shortDateLong(d) {
  const s = iso(d);
  if (!s) return String(d || '');
  const [y, mo, da] = s.split('-');
  const full = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${full[Number(mo) - 1]} ${Number(da)}, ${y}`;
}
function periodLine_pl(start, end) {
  const s = iso(start); const e = iso(end);
  const full = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  if (isFirstOfMonth(s) && isLastOfMonth(e)) {
    const [sy, sm] = s.split('-').map(Number);
    const [ey, em] = e.split('-').map(Number);
    if (sy === ey && sm === em) return `${full[sm - 1]} ${sy}`;
    if (sy === ey) return `${full[sm - 1]} through ${full[em - 1]} ${sy}`;
    return `${full[sm - 1]} ${sy} through ${full[em - 1]} ${ey}`;
  }
  return `${shortDateLong(s)} through ${shortDateLong(e)}`;
}

function indentPx(depth) { return 12 + depth * 14; }

/** Single-period layout with stepped money columns. */
function singleTable(statement) {
  const amountRows = statement.rows.filter((r) => r.amount != null);
  const maxDepth = amountRows.reduce((m, r) => Math.max(m, r.depth), 0);
  const nCols = maxDepth + 1;
  const colOf = (r) => Math.max(0, maxDepth - r.depth); // deeper = further left

  const head = `<tr><td class="lbl"></td>${Array.from({ length: nCols }, (_, i) =>
    `<td class="m pcol">${i === nCols - 1 ? esc(colLabel(statement)) : ''}</td>`).join('')}</tr>`;

  const body = statement.rows.map((r) => {
    const lblCls = ['lbl', r.kind === 'section' || r.kind === 'grandtotal' ? 'b' : '', (r.kind === 'subtotal') ? 'b' : ''].filter(Boolean).join(' ');
    const cells = [];
    const ci = r.amount != null ? colOf(r) : -1;
    for (let i = 0; i < nCols; i++) {
      let cls = 'm';
      if (i === ci) {
        if (r.kind === 'subtotal') cls += ' ul';
        else if (r.kind === 'grandtotal') cls += ' dul';
      }
      cells.push(`<td class="${cls}">${i === ci ? money(r.amount) : ''}</td>`);
    }
    return `<tr class="${r.kind}"><td class="${lblCls}" style="padding-left:${indentPx(r.depth)}px">${esc(r.label)}</td>${cells.join('')}</tr>`;
  }).join('');

  return `<table class="fs">${head}${body}</table>`;
}

/** Comparison layout: fixed [current][compare][$ change][% change] columns. */
function compareTable(statement) {
  const head = `<tr><td class="lbl"></td>`
    + `<td class="m pcol">${esc(colLabel(statement))}</td>`
    + `<td class="m pcol">${esc(compareColLabel(statement))}</td>`
    + `<td class="m pcol">$ Change</td>`
    + `<td class="m pcol">% Change</td></tr>`;
  const body = statement.rows.map((r) => {
    const isTot = r.kind === 'subtotal' || r.kind === 'grandtotal';
    const lblCls = ['lbl', r.kind === 'section' || r.kind === 'grandtotal' || r.kind === 'subtotal' ? 'b' : ''].filter(Boolean).join(' ');
    if (r.amount == null) {
      return `<tr class="${r.kind}"><td class="${lblCls}" style="padding-left:${indentPx(r.depth)}px">${esc(r.label)}</td><td class="m"></td><td class="m"></td><td class="m"></td><td class="m"></td></tr>`;
    }
    const rule = r.kind === 'grandtotal' ? ' dul' : (isTot ? ' ul' : '');
    return `<tr class="${r.kind}"><td class="${lblCls}" style="padding-left:${indentPx(r.depth)}px">${esc(r.label)}</td>`
      + `<td class="m${rule}">${money(r.amount)}</td>`
      + `<td class="m${rule}">${r.cmpAmount == null ? '' : money(r.cmpAmount)}</td>`
      + `<td class="m${rule}">${r.variance == null ? '' : money(r.variance)}</td>`
      + `<td class="m${rule}">${r.variancePct == null ? '' : pct(r.variancePct)}</td></tr>`;
  }).join('');
  return `<table class="fs">${head}${body}</table>`;
}

const CSS = `
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color:#000; font-size:10px; margin:0; }
  .page { padding: 24px 30px; }
  .hdr { display:flex; align-items:flex-start; border-bottom:2.5px solid #000; padding-bottom:6px; margin-bottom:14px; }
  .hdr .tl { font-size:9px; line-height:1.5; width:120px; }
  .hdr .ctr { flex:1; text-align:center; }
  .hdr .co { font-size:14px; font-weight:bold; }
  .hdr .rt { font-size:15px; font-weight:bold; }
  .hdr .ac { font-size:11px; font-weight:bold; }
  table.fs { border-collapse:collapse; width:100%; }
  table.fs td { padding:1.3px 0; vertical-align:bottom; font-size:10px; white-space:nowrap; }
  table.fs td.lbl { text-align:left; padding-right:16px; width:auto; }
  table.fs td.b { font-weight:bold; }
  table.fs td.m { text-align:right; font-variant-numeric:tabular-nums; width:104px; padding-left:10px; }
  table.fs td.pcol { font-weight:bold; border-bottom:1px solid #000; padding-bottom:2px; }
  table.fs td.m.ul { border-top:1px solid #000; }
  table.fs td.m.dul { border-top:1px solid #000; border-bottom:3px double #000; }
  tr.section td { padding-top:5px; }
  tr.grandtotal td { padding-top:2px; }
  .foot { margin-top:18px; text-align:right; font-size:9px; font-weight:bold; }
`;

export function buildStatementHtml(statement, { compare = false } = {}) {
  const table = compare ? compareTable(statement) : singleTable(statement);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
  <body><div class="page">${headerHtml(statement)}${table}<div class="foot">Page 1</div></div></body></html>`;
}

export async function renderFinancialStatementPdf(statement, { compare = false } = {}) {
  const html = buildStatementHtml(statement, { compare });
  await ensurePlaywrightBrowsers();
  const { chromium } = await loadPlaywright();
  const executablePath = chromium.executablePath();
  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new Error(`Playwright Chromium not installed (expected under ${getPlaywrightBrowsersPath()}). Redeploy the app on Render.`);
  }
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 120000 });
    return await page.pdf({ format: 'Letter', printBackground: true, margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' } });
  } finally {
    await browser.close();
  }
}
