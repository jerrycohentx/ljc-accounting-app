/**
 * Chase business credit card statement PDF → JSON (OMC …6508, GM …5068, etc.).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parsePdfBuffer } from './pdf-parse-compat.js';

function parseAmount(s) {
  return parseFloat(String(s).replace(/,/g, '').trim());
}

function normalizeDate(mdyy, closeYear, closeMonth) {
  const parts = String(mdyy).trim().split('/');
  if (parts.length !== 2) return null;
  const m = parseInt(parts[0], 10);
  const d = parseInt(parts[1], 10);
  if (!Number.isFinite(m) || !Number.isFinite(d)) return null;
  let y = closeYear;
  if (Number.isFinite(closeMonth) && m > closeMonth + 2) y -= 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function fitid(date, amount, desc) {
  const key = `${date}|${Number(amount).toFixed(2)}|${String(desc).slice(0, 80)}`;
  return `chase-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

export function looksLikeChaseCcStatement(text, last4 = null) {
  const t = String(text || '');
  const hint = last4 ? String(last4) : '\\d{4}';
  return (
    /CHASE\.COM|JPMorgan Chase Bank|ACCOUNT ACTIVITY/i.test(t)
    && new RegExp(`Account Number.*${hint}|XXXX XXXX XXXX ${hint}`, 'i').test(t)
  );
}

export function parseChaseCcMetadata(text, { last4 = '6508' } = {}) {
  const meta = { bankName: 'Chase', cardName: 'Chase Credit Card' };
  let m = text.match(/Account Number\s+Ending\s+(\d{4})/i);
  if (m) meta.accountLast4 = m[1];
  m = text.match(/XXXX XXXX XXXX (\d{4})/);
  if (m && !meta.accountLast4) meta.accountLast4 = m[1];
  if (last4 && !meta.accountLast4) meta.accountLast4 = String(last4);

  m = text.match(/Previous Balance\s+\$?\s*([\d,]+\.\d{2})/i);
  if (m) meta.previousBalance = parseAmount(m[1]);
  m = text.match(/(?:New Balance|Current Balance)\s+\$?\s*([\d,]+\.\d{2})/i);
  if (m) meta.currentBalance = parseAmount(m[1]);

  m = text.match(/Opening\/Closing Date\s+(\d{2}\/\d{2}\/\d{2,4})\s*[-–]\s*(\d{2}\/\d{2}\/\d{2,4})/i);
  if (m) {
    const y1 = m[1].split('/').pop();
    const y2 = m[2].split('/').pop();
    const closeY = parseInt(String(y2).length === 2 ? `20${y2}` : y2, 10);
    meta.periodEnd = normalizeDate(m[2].slice(0, 5), closeY, parseInt(m[2].split('/')[0], 10));
    meta.periodStart = normalizeDate(m[1].slice(0, 5), closeY, parseInt(m[2].split('/')[0], 10));
  }
  m = text.match(/Closing Date\s+(\d{2}\/\d{2}\/\d{2,4})/i);
  if (m && !meta.periodEnd) {
    const parts = m[1].split('/');
    const y = parseInt(parts[2].length === 2 ? `20${parts[2]}` : parts[2], 10);
    meta.periodEnd = normalizeDate(`${parts[0]}/${parts[1]}`, y, parseInt(parts[0], 10));
  }
  return meta;
}

const SKIP_DESC = /^(PAYMENTS AND OTHER CREDITS|ACCOUNT ACTIVITY|PURCHASE|FEES CHARGED|INTEREST CHARGED|Total fees|TOTAL|Page \d)/i;

export function parseChaseCcTransactions(text, meta = {}) {
  const closeIso = meta.periodEnd || '2026-01-18';
  const closeY = parseInt(closeIso.slice(0, 4), 10);
  const closeM = parseInt(closeIso.slice(5, 7), 10);
  const activityIdx = text.indexOf('ACCOUNT ACTIVITY');
  const slice = activityIdx >= 0 ? text.slice(activityIdx) : text;
  const txns = [];
  const lineRe = /^(\d{2}\/\d{2})\s+(.+)$/gm;
  let m;
  while ((m = lineRe.exec(slice)) !== null) {
    const tail = m[2].trim();
    const amtMatch = tail.match(/(-?\$?\s*[\d,]+\.\d{2})\s*$/);
    if (!amtMatch) continue;
    const rawAmt = parseAmount(amtMatch[1].replace('$', ''));
    let desc = tail.slice(0, tail.length - amtMatch[0].length).replace(/\s+[A-Z]{2}\s*$/, '').trim();
    if (!desc || desc.length < 4 || SKIP_DESC.test(desc)) continue;
    const date = normalizeDate(m[1], closeY, closeM);
    if (!date) continue;
    // Liability import: charges positive; payments/credits negative (Amex convention).
    let amount = rawAmt;
    if (/payment|thank you|autopay|credit/i.test(desc) && rawAmt > 0) amount = -Math.abs(rawAmt);
    else if (rawAmt > 0) amount = Math.abs(rawAmt);
    else amount = rawAmt;
    txns.push({
      date,
      amount: Math.round(amount * 100) / 100,
      description: desc.replace(/\s+/g, ' '),
      fitid: fitid(date, amount, desc),
    });
  }
  return txns;
}

export async function extractChaseCcPdfFromBuffer(buf, { last4 = '6508', text = null } = {}) {
  const body = text || await parsePdfBuffer(buf);
  if (!looksLikeChaseCcStatement(body, last4)) {
    throw new Error('not a Chase credit card statement');
  }
  const meta = parseChaseCcMetadata(body, { last4 });
  const transactions = parseChaseCcTransactions(body, meta);
  return {
    file: 'chase-cc-statement.pdf',
    meta,
    transactionCount: transactions.length,
    transactions,
  };
}

export async function extractChaseCcPdfFromFile(pdfPath, { last4 = null } = {}) {
  const buf = fs.readFileSync(pdfPath);
  const hint = last4 || (pdfPath.match(/(\d{4})/) || [])[1] || '6508';
  return extractChaseCcPdfFromBuffer(buf, { last4: hint });
}
