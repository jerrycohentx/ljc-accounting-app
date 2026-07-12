/**
 * Extract bank statement PDF → JSON (Node/pdf-parse — works on Render without Python).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const SKIP_PREFIXES = [
  'Date ', 'Primary Account', 'Commercial Checking', 'CHECKING',
  'Deposits and Additions', 'Checks and Withdrawals', 'CHECKS IN NUMBER',
  'Daily Balance', 'Thank you', 'END OF STATEMENT', 'Deposit Date',
  'Check Date', 'STATE ', 'RECONCILEMENT', 'Previous Balance',
  'Enclosures', 'Ljc Financial', 'PO Box', 'Houston', 'Commercial Checking TM',
  '* Denotes', 'Page ', 'MAY 2026', 'P O Box', 'OFFICER:',
];

function parseAmount(s) {
  return parseFloat(String(s).replace(/,/g, '').trim().replace(/-$/, ''));
}

function normalizeDate(mdyy) {
  const parts = mdyy.trim().split('/');
  if (parts.length !== 3) return mdyy;
  let [m, d, y] = parts.map((p) => parseInt(p, 10));
  if (y < 100) y += 2000;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseMetadata(text) {
  const meta = {};
  let m = text.match(/Statement Dates\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+thru\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (m) {
    meta.periodStart = normalizeDate(m[1]);
    meta.periodEnd = normalizeDate(m[2]);
  }
  m = text.match(/Previous Balance\s+([\d,]+\.\d{2})/);
  if (m) meta.previousBalance = parseAmount(m[1]);
  m = text.match(/Current Balance\s+([\d,]+\.\d{2})/);
  if (m) meta.currentBalance = parseAmount(m[1]);
  m = text.match(/Ending Balance\s+([\d,]+\.\d{2})/);
  if (m && meta.currentBalance == null) meta.currentBalance = parseAmount(m[1]);
  m = text.match(/Account Number X+(\d{4})/);
  if (m) meta.accountLast4 = m[1];
  m = text.match(/Account Number\s+Ending\s+(\d{4})/i);
  if (m && !meta.accountLast4) meta.accountLast4 = m[1];
  if (meta.accountLast4 === '7367') meta.bankName = 'Lone Star Bank';
  else if (meta.accountLast4 === '0260') meta.bankName = 'Simmons Bank';
  return meta;
}

// Transaction lines on these statements carry only M/D (no year). A statement
// can span a year boundary (e.g. Statement Dates 12/26/25 thru 01/25/26), so a
// single period-start year would mis-date every January row to the prior year.
// Resolve the year by choosing whichever candidate lands the date INSIDE the
// statement window [periodStart, periodEnd]; fall back to splitting at the
// start month, then to periodStart's year, then to the current close year.
function resolveTxnYear(meta, monthNum, dayNum) {
  const ps = meta.periodStart;
  const pe = meta.periodEnd;
  if (!ps) return 2026;
  const psY = parseInt(ps.slice(0, 4), 10);
  const peY = pe ? parseInt(pe.slice(0, 4), 10) : psY;
  const mm = String(monthNum).padStart(2, '0');
  const dd = String(dayNum).padStart(2, '0');
  if (psY !== peY) {
    for (const y of [psY, peY]) {
      const iso = `${y}-${mm}-${dd}`;
      if (iso >= ps && (!pe || iso <= pe)) return y;
    }
    // Neither lands cleanly in-window (e.g. day-of-month edge): split at the
    // start month — high months belong to the start year, low months roll over.
    return monthNum >= parseInt(ps.slice(5, 7), 10) ? psY : peY;
  }
  return psY;
}

function inferYear(text) {
  const meta = parseMetadata(text);
  return meta.periodStart ? meta.periodStart.slice(0, 4) : '2026';
}

function mdToIso(text, md) {
  const meta = parseMetadata(text);
  const [m, d] = md.split('/').map((p) => parseInt(p, 10));
  const year = resolveTxnYear(meta, m, d);
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function fitid(date, amount, desc) {
  const key = `${date}|${amount.toFixed(2)}|${desc.slice(0, 80)}`;
  return `pdf-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function makeTxn(date, amount, description) {
  return {
    date,
    amount: Math.round(amount * 100) / 100,
    description,
    fitid: fitid(date, amount, description),
    isCredit: amount > 0,
  };
}

function shouldSkip(line) {
  const t = line.trim();
  if (!t || t.length < 5) return true;
  if (SKIP_PREFIXES.some((p) => t.startsWith(p))) return true;
  if (/^[\d/]+\s+[\d,]+\.\d{2}\s+[\d/]/.test(t)) return true;
  return false;
}

function parseCheckGridLine(text, line) {
  const txns = [];
  const re = /(\d{1,2}\/\d{1,2})\s+(?:(\d{5,7})\*?\s+)?([\d,]+\.\d{2})(-?)/g;
  for (const m of line.matchAll(re)) {
    let amt = parseAmount(m[3]);
    if (m[4] === '-') amt = -amt;
    else amt = -Math.abs(amt);
    const desc = m[2] ? `Check #${m[2]}` : 'Check';
    txns.push(makeTxn(mdToIso(text, m[1]), amt, desc));
  }
  return txns;
}

function parseTransactions(text) {
  const txns = [];
  let inDeposits = false;
  let inWithdrawals = false;
  let inChecks = false;
  const txnLine = /^(\d{1,2}\/\d{1,2})\s+(.+?)\s+([\d,]+\.\d{2})(-?)\s*$/;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.includes('Deposits and Additions')) {
      inDeposits = true; inWithdrawals = false; inChecks = false;
      continue;
    }
    if (line.includes('Checks and Withdrawals')) {
      inWithdrawals = true; inDeposits = false; inChecks = false;
      continue;
    }
    if (line.includes('CHECKS IN NUMBER ORDER')) {
      inChecks = true; inDeposits = false; inWithdrawals = false;
      continue;
    }
    if (line.includes('Daily Balance Information')) {
      inDeposits = false; inWithdrawals = false; inChecks = false;
      continue;
    }
    if (shouldSkip(line) && !inChecks) continue;
    if (/^(Deposit|Check)\s+Date:/i.test(line)) continue;

    if (inChecks) {
      const grid = parseCheckGridLine(text, line);
      if (grid.length) { txns.push(...grid); continue; }
    }

    const m = line.match(txnLine);
    if (!m) continue;
    const date = mdToIso(text, m[1]);
    const desc = m[2].trim();
    let amt = parseAmount(m[3]);
    const isDebit = m[4] === '-' || inWithdrawals;
    if (inDeposits && !isDebit) amt = Math.abs(amt);
    else if (inWithdrawals || isDebit) amt = -Math.abs(amt);
    else if (/Credit|Deposit|Transfer CH|LeanneRent|Rent |ACH BATCH|ACH Pmt|PAYMENT|Wire Transfer Credit/.test(desc)) {
      amt = Math.abs(amt);
    } else if (/Debit|Chargeback|ACH PMT|Wire Transfer Debit/.test(desc)) {
      amt = -Math.abs(amt);
    } else if (inDeposits) amt = Math.abs(amt);
    else amt = -Math.abs(amt);

    if (desc.toLowerCase().startsWith('date ')) continue;
    txns.push(makeTxn(date, amt, desc));
  }

  const seen = {};
  return txns.map((t) => {
    let fid = t.fitid;
    if (seen[fid]) {
      seen[fid] += 1;
      fid = `${fid}-${seen[fid]}`;
    } else {
      seen[fid] = 1;
    }
    return { ...t, fitid: fid };
  });
}

export async function extractPdfStatementFromFile(pdfPath) {
  const buf = fs.readFileSync(pdfPath);
  const parsed = await pdfParse(buf);
  const text = parsed.text || '';
  if (!text.includes('CHECKING ACCOUNTS') && !text.includes('Current Balance') && !text.includes('Ending Balance')) {
    throw new Error('not a supported checking statement');
  }
  const meta = parseMetadata(text);
  const transactions = parseTransactions(text);
  const netChange = transactions.reduce((s, t) => s + t.amount, 0);
  const result = {
    file: path.basename(pdfPath),
    meta,
    transactionCount: transactions.length,
    netChange: Math.round(netChange * 100) / 100,
    transactions,
  };
  if (meta.previousBalance != null && meta.currentBalance != null) {
    result.expectedNet = Math.round((meta.currentBalance - meta.previousBalance) * 100) / 100;
    result.netVariance = Math.round((netChange - result.expectedNet) * 100) / 100;
  }
  return result;
}
