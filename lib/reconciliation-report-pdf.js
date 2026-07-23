/**
 * Render an archived reconciliation report (from `reconciliation_reports`) to a
 * QuickBooks-Desktop-style Summary and/or Detail PDF.
 *
 * `buildReportHtml()` is a pure function (no browser) so it can be unit-tested;
 * `renderReconciliationReportPdf()` wraps it in a headless Chromium print via the
 * Playwright browser already bundled for this app (see lib/playwright-browsers.js).
 *
 * The layout mirrors QuickBooks Desktop's "Reconciliation Summary" and
 * "Reconciliation Detail" reports: a centered company/report/account header,
 * a Beginning Balance → Cleared Transactions → Cleared Balance → Uncleared
 * → Register Balance → New Transactions → Ending Balance roll-forward, and a
 * Type / Date / Num / Name / Clr / Amount / Balance detail grid with running
 * balances and per-group subtotals.
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
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

// QuickBooks money format: thousands-separated, 2 decimals, negatives with a
// leading minus (e.g. -526,020.82). Blank when the amount is intentionally null.
function money(n) {
  if (n == null) return '';
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-${s}` : s;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Postgres hands DATE columns back as JS Date objects; ISO strings normalize to
// MM/DD/YYYY (QuickBooks style). Any other pre-formatted label is shown verbatim.
function mdY(d) {
  if (!d) return '';
  let iso = '';
  if (d instanceof Date) {
    iso = Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  } else {
    const m = String(d).match(/^\d{4}-\d{2}-\d{2}/);
    if (!m) return String(d);
    iso = m[0];
  }
  const [y, mo, da] = iso.split('-');
  return `${mo}/${da}/${y}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 2026-03-31 -> "Mar 31, 26" (the QuickBooks period column header).
function shortDate(d) {
  const s = mdY(d); // MM/DD/YYYY
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return String(d || '');
  return `${MONTHS[Number(m[1]) - 1]} ${Number(m[2])}, ${m[3].slice(2)}`;
}

function itemsLabel(n) {
  return `${n} ${n === 1 ? 'item' : 'items'}`;
}

/** One QuickBooks summary line. amtL = the indented (sub) amount column; amtR = the balance column. */
function sRow(label, amtL, amtR, { bold, indent, ulL, dulR } = {}) {
  const lblCls = ['lbl', bold ? 'b' : '', indent === 1 ? 'i1' : (indent === 2 ? 'i2' : '')].filter(Boolean).join(' ');
  const mLCls = ['m', ulL ? 'ul' : ''].filter(Boolean).join(' ');
  const mRCls = ['m2', dulR ? 'dul' : ''].filter(Boolean).join(' ');
  return `<tr><td class="${lblCls}">${esc(label)}</td>`
    + `<td class="${mLCls}">${amtL == null ? '' : money(amtL)}</td>`
    + `<td class="${mRCls}">${amtR == null ? '' : money(amtR)}</td></tr>`;
}

function summaryHtml(report) {
  const s = report.summary || {};
  const pl = s.paymentsLabel || 'Checks and Payments';
  const dl = s.depositsLabel || 'Deposits and Credits';
  const cl = s.cleared || {};
  const un = s.uncleared || {};
  const nw = s.newTransactions || {};
  const asOf = s.registerBalanceAsOf || report.statement_date;

  const rows = [];
  rows.push(`<tr><td></td><td></td><td class="pcol">${esc(shortDate(asOf))}</td></tr>`);
  rows.push(sRow('Beginning Balance', null, s.beginningBalance, { bold: true }));
  rows.push(sRow('Cleared Transactions', null, null, { bold: true, indent: 1 }));
  rows.push(sRow(`${pl} - ${itemsLabel(cl.paymentsCount || 0)}`, cl.paymentsTotal, null, { indent: 2 }));
  rows.push(sRow(`${dl} - ${itemsLabel(cl.depositsCount || 0)}`, cl.depositsTotal, null, { indent: 2 }));
  rows.push(sRow('Total Cleared Transactions', cl.total, null, { bold: true, indent: 1, ulL: true }));
  rows.push(sRow('Cleared Balance', null, s.clearedBalance, { bold: true, dulR: true }));

  const hasUncleared = (un.paymentsCount || 0) + (un.depositsCount || 0) > 0;
  if (hasUncleared) {
    rows.push('<tr class="spacer"><td></td><td></td><td></td></tr>');
    rows.push(sRow('Uncleared Transactions', null, null, { bold: true, indent: 1 }));
    if (un.paymentsCount) rows.push(sRow(`${pl} - ${itemsLabel(un.paymentsCount)}`, un.paymentsTotal, null, { indent: 2 }));
    if (un.depositsCount) rows.push(sRow(`${dl} - ${itemsLabel(un.depositsCount)}`, un.depositsTotal, null, { indent: 2 }));
    rows.push(sRow('Total Uncleared Transactions', un.total, null, { bold: true, indent: 1, ulL: true }));
    rows.push(sRow(`Register Balance as of ${mdY(asOf)}`, null, s.registerBalance, { bold: true, dulR: true }));
  }

  const hasNew = (nw.paymentsCount || 0) + (nw.depositsCount || 0) > 0;
  if (hasNew) {
    rows.push('<tr class="spacer"><td></td><td></td><td></td></tr>');
    rows.push(sRow('New Transactions', null, null, { bold: true, indent: 1 }));
    if (nw.paymentsCount) rows.push(sRow(`${pl} - ${itemsLabel(nw.paymentsCount)}`, nw.paymentsTotal, null, { indent: 2 }));
    if (nw.depositsCount) rows.push(sRow(`${dl} - ${itemsLabel(nw.depositsCount)}`, nw.depositsTotal, null, { indent: 2 }));
    rows.push(sRow('Total New Transactions', nw.total, null, { bold: true, indent: 1, ulL: true }));
  }
  rows.push(sRow('Ending Balance', null, s.endingBalance, { bold: true, dulR: true }));

  return `${headerHtml(report, 'Summary')}<div class="s"><table>${rows.join('')}</table></div>`;
}

function detailGroup(title, items, cleared) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '';
  const label = title; // e.g. "Checks and Payments"
  const rows = list.map((r) => `<tr class="row">`
    + `<td class="first">${esc(r.type || '')}</td>`
    + `<td>${esc(mdY(r.date))}</td>`
    + `<td>${esc(r.num || '')}</td>`
    + `<td>${esc((r.name || r.description || ''))}</td>`
    + `<td class="clr">${cleared ? 'X' : ''}</td>`
    + `<td class="r">${money(r.amount)}</td>`
    + `<td class="r">${money(r.runningBalance)}</td></tr>`).join('');
  const total = round2(list.reduce((a, r) => a + (Number(r.amount) || 0), 0));
  const endBal = list.length ? list[list.length - 1].runningBalance : null;
  return `<tr class="sgrp"><td colspan="7">${esc(label)} - ${itemsLabel(list.length)}</td></tr>`
    + rows
    + `<tr class="ttl"><td colspan="5">Total ${esc(label)}</td><td class="r">${money(total)}</td><td class="r">${money(endBal)}</td></tr>`;
}

function detailHtml(report) {
  const d = report.detail || {};
  const s = report.summary || {};
  const pl = d.paymentsLabel || 'Checks and Payments';
  const dl = d.depositsLabel || 'Deposits and Credits';
  const cl = d.cleared || {};
  const un = d.uncleared || {};
  const nw = d.newTransactions || {};
  const asOf = s.registerBalanceAsOf || report.statement_date;

  const body = [];
  body.push(`<tr class="bbal"><td colspan="6">Beginning Balance</td><td class="r">${money(d.beginningBalance)}</td></tr>`);

  // Cleared Transactions
  body.push('<tr class="grp"><td colspan="7">Cleared Transactions</td></tr>');
  body.push(detailGroup(pl, cl.payments, true));
  body.push(detailGroup(dl, cl.deposits, true));
  body.push(`<tr class="ttl2"><td colspan="5">Total Cleared Transactions</td><td class="r">${money(cl.total)}</td><td class="r">${money(cl.total)}</td></tr>`);
  body.push(`<tr class="cbal"><td colspan="5">Cleared Balance</td><td class="r">${money(cl.total)}</td><td class="r">${money(s.clearedBalance)}</td></tr>`);

  // Uncleared Transactions
  const hasUncleared = (un.payments || []).length + (un.deposits || []).length > 0;
  if (hasUncleared) {
    body.push('<tr class="grp"><td colspan="7">Uncleared Transactions</td></tr>');
    body.push(detailGroup(pl, un.payments, false));
    body.push(detailGroup(dl, un.deposits, false));
    body.push(`<tr class="ttl2"><td colspan="5">Total Uncleared Transactions</td><td class="r">${money(un.total)}</td><td class="r">${money(un.total)}</td></tr>`);
    body.push(`<tr class="cbal"><td colspan="6">Register Balance as of ${esc(mdY(asOf))}</td><td class="r">${money(s.registerBalance)}</td></tr>`);
  }

  // New Transactions
  const hasNew = (nw.payments || []).length + (nw.deposits || []).length > 0;
  if (hasNew) {
    body.push('<tr class="grp"><td colspan="7">New Transactions</td></tr>');
    body.push(detailGroup(pl, nw.payments, false));
    body.push(detailGroup(dl, nw.deposits, false));
    body.push(`<tr class="ttl2"><td colspan="5">Total New Transactions</td><td class="r">${money(nw.total)}</td><td class="r">${money(nw.total)}</td></tr>`);
  }
  body.push(`<tr class="cbal"><td colspan="6">Ending Balance</td><td class="r">${money(d.endingBalance)}</td></tr>`);

  const thead = '<tr><th>Type</th><th>Date</th><th>Num</th><th>Name</th><th class="clr">Clr</th>'
    + '<th class="r">Amount</th><th class="r">Balance</th></tr>';
  return `${headerHtml(report, 'Detail')}<div class="d"><table><thead>${thead}</thead><tbody>${body.join('')}</tbody></table></div>`;
}

function headerHtml(report, kind) {
  const acctName = report.account_name || 'Account';
  const acctNum = report.account_number ? ` ${report.account_number}` : '';
  let gen = '';
  if (report.generated_at) {
    const gd = report.generated_at instanceof Date ? report.generated_at : new Date(report.generated_at);
    if (!Number.isNaN(gd.getTime())) {
      let h = gd.getHours();
      const ap = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      const mm = String(gd.getMinutes()).padStart(2, '0');
      const dd = `${String(gd.getMonth() + 1).padStart(2, '0')}/${String(gd.getDate()).padStart(2, '0')}/${String(gd.getFullYear()).slice(2)}`;
      gen = `${h}:${mm} ${ap}<br>${dd}`;
    }
  }
  return `<div class="hdr">
    <div class="tl">${gen}</div>
    <div class="ctr">
      <div class="co">${esc(report.company_name || 'LJC Financial, LLC')}</div>
      <div class="rt">Reconciliation ${kind}</div>
      <div class="ac">${esc(acctName)}${esc(acctNum)}, Period Ending ${esc(mdY(report.statement_date))}</div>
    </div>
  </div>`;
}

const CSS = `
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color:#000; font-size:10px; margin:0; }
  .page { padding: 24px 30px; }
  .hdr { display:flex; align-items:flex-start; border-bottom:2.5px solid #000; padding-bottom:6px; margin-bottom:14px; }
  .hdr .tl { font-size:9px; line-height:1.5; width:110px; }
  .hdr .ctr { flex:1; text-align:center; }
  .hdr .co { font-size:14px; font-weight:bold; }
  .hdr .rt { font-size:15px; font-weight:bold; }
  .hdr .ac { font-size:11px; font-weight:bold; }
  .pcol { text-align:right; font-weight:bold; border-bottom:1px solid #000; padding-bottom:2px; white-space:nowrap; }
  .s table { border-collapse:collapse; width:100%; }
  .s td { padding:1.5px 0; vertical-align:bottom; }
  .s .b { font-weight:bold; }
  .s .i1 { padding-left:20px; }
  .s .i2 { padding-left:38px; }
  .s .m { text-align:right; font-variant-numeric:tabular-nums; width:130px; white-space:nowrap; }
  .s .m2 { text-align:right; font-variant-numeric:tabular-nums; width:120px; white-space:nowrap; }
  .s .m.ul { border-top:1px solid #000; }
  .s .m2.dul { border-top:1px solid #000; border-bottom:3px double #000; }
  .s .spacer td { height:7px; }
  .d { margin-top:2px; }
  .d table { border-collapse:collapse; width:100%; }
  .d th { text-align:left; font-size:9px; border-bottom:1px solid #000; padding:2px 4px; white-space:nowrap; }
  .d th.r, .d td.r { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .d th.clr, .d td.clr { text-align:center; width:26px; }
  .d td { padding:1.5px 4px; font-size:9px; }
  .d .grp td { font-weight:bold; padding-top:7px; }
  .d .sgrp td { font-weight:bold; padding-left:12px; }
  .d .row td.first { padding-left:20px; }
  .d .row td:nth-child(4) { max-width:270px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .d .ttl td, .d .ttl2 td { border-top:1px solid #000; font-weight:bold; }
  .d .bbal td, .d .cbal td { font-weight:bold; }
  .d .cbal td { border-top:1px solid #000; }
  .foot { margin-top:20px; text-align:right; font-size:9px; font-weight:bold; }
`;

/**
 * @param {object} report row from getReconciliationReport (has account_name,
 *   account_number, statement_date, is_closed, generated_at, company_name, and
 *   parsed `summary` / `detail` objects).
 * @param {{mode?: 'summary'|'detail'|'both'}} opts
 * @returns {string} full HTML document
 */
export function buildReportHtml(report, { mode = 'both' } = {}) {
  const showSummary = mode === 'summary' || mode === 'both';
  const showDetail = mode === 'detail' || mode === 'both';
  const sections = [];
  if (showSummary) sections.push(summaryHtml(report));
  if (showSummary && showDetail) sections.push('<div style="page-break-before:always"></div>');
  if (showDetail) sections.push(detailHtml(report));
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
  <body><div class="page">${sections.join('')}<div class="foot">Page 1</div></div></body></html>`;
}

/**
 * Render the report to a PDF Buffer via headless Chromium.
 * @returns {Promise<Buffer>}
 */
export async function renderReconciliationReportPdf(report, { mode = 'both' } = {}) {
  const html = buildReportHtml(report, { mode });

  await ensurePlaywrightBrowsers();
  const { chromium } = await loadPlaywright();
  const executablePath = chromium.executablePath();
  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new Error(`Playwright Chromium not installed (expected under ${getPlaywrightBrowsersPath()}). Redeploy the app on Render.`);
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' },
    });
    return pdf;
  } finally {
    await browser.close();
  }
}
