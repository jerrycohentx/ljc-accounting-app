/**
 * Render an archived reconciliation report (from `reconciliation_reports`) to a
 * QuickBooks-style Summary and/or Detail PDF.
 *
 * `buildReportHtml()` is a pure function (no browser) so it can be unit-tested;
 * `renderReconciliationReportPdf()` wraps it in a headless Chromium print via the
 * Playwright browser already bundled for this app (see lib/playwright-browsers.js).
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

function money(n) {
  const v = Number(n || 0);
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Postgres hands back DATE/TIMESTAMP columns as JS Date objects, while dates
// inside the archived summary/detail JSON are already ISO strings -- handle both.
function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

/** One QBD-style "Label .......... amount" summary line. */
function sumRow(label, amount, opts = {}) {
  const cls = ['sum-row'];
  if (opts.total) cls.push('sum-total');
  if (opts.indent) cls.push('indent');
  const amt = amount == null ? '' : money(amount);
  return `<div class="${cls.join(' ')}"><span>${esc(label)}</span><span class="amt">${amt}</span></div>`;
}

// The reconciliation difference is Cleared Balance - Statement Ending Balance
// (0.00 for a clean close). Post-statement "new transactions" are intentionally
// excluded -- they are not part of a reconciliation and mirror what the app's
// on-screen reconciliation report shows (cleared + outstanding only).
function reconDifference(s) {
  if (s.statementEndingBalance == null) return null;
  return round2((Number(s.clearedBalance) || 0) - Number(s.statementEndingBalance));
}

function summaryHtml(report) {
  const s = report.summary || {};
  const paymentsLabel = s.paymentsLabel || 'Checks and Payments';
  const depositsLabel = s.depositsLabel || 'Deposits and Credits';
  const cleared = s.cleared || {};
  const uncleared = s.uncleared || {};

  const rows = [];
  rows.push(sumRow('Beginning Balance', s.beginningBalance, { total: true }));
  rows.push('<div class="sum-group">Cleared Transactions</div>');
  rows.push(sumRow(`${paymentsLabel} (${cleared.paymentsCount || 0})`, cleared.paymentsTotal, { indent: true }));
  rows.push(sumRow(`${depositsLabel} (${cleared.depositsCount || 0})`, cleared.depositsTotal, { indent: true }));
  rows.push(sumRow('Total Cleared', cleared.total, { indent: true, total: true }));
  rows.push(sumRow('Cleared Balance', s.clearedBalance, { total: true }));

  const diff = reconDifference(s);
  if (diff != null) {
    rows.push(sumRow('Statement Ending Balance', s.statementEndingBalance));
    rows.push(sumRow('Difference (Cleared − Statement)', diff, { total: true }));
  }

  const hasUncleared = (uncleared.paymentsCount || 0) + (uncleared.depositsCount || 0) > 0;
  if (hasUncleared) {
    rows.push('<div class="sum-group">Outstanding (uncleared) as of statement date</div>');
    rows.push(sumRow(`${paymentsLabel} (${uncleared.paymentsCount || 0})`, uncleared.paymentsTotal, { indent: true }));
    rows.push(sumRow(`${depositsLabel} (${uncleared.depositsCount || 0})`, uncleared.depositsTotal, { indent: true }));
  }

  return `<section class="block">
    <h2>Reconciliation Summary</h2>
    <div class="summary">${rows.join('')}</div>
  </section>`;
}

function detailTable(title, lines, total, balance) {
  const list = Array.isArray(lines) ? lines : [];
  const body = list.length
    ? list.map((r) => `<tr>
        <td class="c-date">${esc(fmtDate(r.date))}</td>
        <td class="c-num">${esc(r.num || '')}</td>
        <td class="c-type">${esc(r.type || '')}</td>
        <td class="c-desc">${esc(r.name || r.description || '')}</td>
        <td class="c-amt">${money(r.amount)}</td>
        <td class="c-amt">${r.runningBalance == null ? '' : money(r.runningBalance)}</td>
      </tr>`).join('')
    : `<tr><td class="none" colspan="6">None</td></tr>`;
  const foot = `<tr class="ttl">
      <td colspan="4">Total ${esc(title)}${list.length ? ` (${list.length})` : ''}</td>
      <td class="c-amt">${money(total)}</td>
      <td class="c-amt">${balance == null ? '' : money(balance)}</td>
    </tr>`;
  return `<div class="dt">
    <div class="dt-h">${esc(title)}</div>
    <table>
      <thead><tr>
        <th class="c-date">Date</th><th class="c-num">Num</th><th class="c-type">Type</th>
        <th class="c-desc">Payee / Memo</th><th class="c-amt">Amount</th><th class="c-amt">Balance</th>
      </tr></thead>
      <tbody>${body}${foot}</tbody>
    </table>
  </div>`;
}

function detailHtml(report) {
  const d = report.detail || {};
  const s = report.summary || {};
  const paymentsLabel = d.paymentsLabel || 'Checks and Payments';
  const depositsLabel = d.depositsLabel || 'Deposits and Credits';
  const cleared = d.cleared || {};
  const uncleared = d.uncleared || {};
  const parts = [];

  parts.push(sumRow('Beginning Balance', d.beginningBalance, { total: true }));
  parts.push(detailTable(`Cleared ${paymentsLabel}`, cleared.payments, cleared.total != null ? cleared.total : null));
  parts.push(detailTable(`Cleared ${depositsLabel}`, cleared.deposits, null, cleared.balance));

  const hasUncleared = (uncleared.payments || []).length + (uncleared.deposits || []).length > 0;
  if (hasUncleared) {
    parts.push(detailTable(`Outstanding ${paymentsLabel}`, uncleared.payments, uncleared.total != null ? uncleared.total : null));
    parts.push(detailTable(`Outstanding ${depositsLabel}`, uncleared.deposits, null, uncleared.balance));
  }

  // Close with the reconciliation math (post-statement "new" activity omitted,
  // matching the app's on-screen reconciliation report).
  parts.push(sumRow('Cleared Balance', s.clearedBalance, { total: true }));
  const diff = reconDifference(s);
  if (diff != null) {
    parts.push(sumRow('Statement Ending Balance', s.statementEndingBalance));
    parts.push(sumRow('Difference (Cleared − Statement)', diff, { total: true }));
  }

  return `<section class="block">
    <h2>Reconciliation Detail</h2>
    <div class="detail">${parts.join('')}</div>
  </section>`;
}

const CSS = `
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #16202c; font-size: 11px; margin: 0; }
  .page { padding: 28px 34px; }
  header { border-bottom: 2px solid #16202c; padding-bottom: 8px; margin-bottom: 14px; }
  header .co { font-size: 16px; font-weight: bold; }
  header .acct { font-size: 13px; font-weight: bold; margin-top: 2px; }
  header .sub { color: #5a6a7a; margin-top: 2px; }
  header .status { display: inline-block; margin-top: 6px; padding: 1px 8px; border-radius: 10px; font-size: 10px; font-weight: bold; }
  header .status.closed { background: #e3f5e8; color: #1c7a3c; }
  header .status.open { background: #fdecea; color: #b23b2e; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #34506e;
       border-bottom: 1px solid #cdd8e4; padding-bottom: 3px; margin: 18px 0 8px; }
  .block { break-inside: avoid; }
  .summary { max-width: 460px; }
  .sum-row { display: flex; justify-content: space-between; padding: 2px 0; }
  .sum-row.indent span:first-child { padding-left: 14px; }
  .sum-row.sum-total { font-weight: bold; border-top: 1px solid #cdd8e4; }
  .sum-group { font-weight: bold; margin-top: 8px; color: #34506e; }
  .sum-row .amt { font-variant-numeric: tabular-nums; }
  .dt { margin: 10px 0 6px; break-inside: avoid; }
  .dt-h { font-weight: bold; margin-bottom: 3px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; background: #eef4fb; border-bottom: 1px solid #cdd8e4; padding: 3px 5px; font-size: 10px; }
  td { padding: 2px 5px; border-bottom: 1px solid #eef2f6; }
  .c-amt { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .c-date { width: 68px; } .c-num { width: 58px; } .c-type { width: 60px; }
  tr.ttl td { font-weight: bold; background: #f4f8fc; border-top: 1px solid #cdd8e4; }
  td.none { color: #8a97a5; font-style: italic; }
  footer { margin-top: 20px; padding-top: 8px; border-top: 1px solid #cdd8e4; color: #8a97a5; font-size: 9px; }
`;

/**
 * @param {object} report row from getReconciliationReport (has account_name,
 *   account_number, statement_date, report_label, is_closed, generated_at,
 *   and parsed `summary` / `detail` objects).
 * @param {{mode?: 'summary'|'detail'|'both'}} opts
 * @returns {string} full HTML document
 */
export function buildReportHtml(report, { mode = 'both' } = {}) {
  const showSummary = mode === 'summary' || mode === 'both';
  const showDetail = mode === 'detail' || mode === 'both';
  const acctLabel = `${report.account_name || 'Account'}${report.account_number ? ` — ${report.account_number}` : ''}`;
  const closed = !!report.is_closed;
  let generated = '';
  if (report.generated_at) {
    const gd = report.generated_at instanceof Date ? report.generated_at : new Date(report.generated_at);
    generated = Number.isNaN(gd.getTime())
      ? String(report.generated_at)
      : `${gd.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  }

  const sections = [];
  if (showSummary) sections.push(summaryHtml(report));
  if (showDetail) sections.push(detailHtml(report));

  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
  <body><div class="page">
    <header>
      <div class="co">LJC Financial</div>
      <div class="acct">${esc(acctLabel)}</div>
      <div class="sub">Reconciliation as of statement ending ${esc(fmtDate(report.statement_date))}</div>
      <span class="status ${closed ? 'closed' : 'open'}">${closed ? 'RECONCILED / CLOSED' : 'OPEN'}</span>
    </header>
    ${sections.join('')}
    <footer>Generated ${esc(generated)} · Reconciliation report id ${esc(report.id || '')}</footer>
  </div></body></html>`;
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

  // Flags for the memory-constrained Render instance: /dev/shm is tiny in the
  // container (--disable-dev-shm-usage), and sandboxing/GPU aren't available.
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    // HTML is fully self-contained (inline CSS, no external assets), so
    // 'domcontentloaded' is sufficient -- waiting for 'load' can stall under
    // CPU contention even though there are no subresources to fetch.
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60000 });
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
