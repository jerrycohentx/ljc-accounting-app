/**
 * Extract American Express business card statement PDF → JSON (Node/pdf-parse).
 * Mirrors scripts/extract-amex-pdf.py so Render does not need Python/pypdf.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parsePdfBuffer } from './pdf-parse-compat.js';

function parseAmount(s) {
  return parseFloat(String(s).replace(/[$,]/g, '').trim());
}

function normalizeDate(mdyy) {
  const [m, d, yRaw] = String(mdyy).split('/');
  let y = parseInt(yRaw, 10);
  if (y < 100) y += 2000;
  return `${String(y).padStart(4, '0')}-${String(parseInt(m, 10)).padStart(2, '0')}-${String(parseInt(d, 10)).padStart(2, '0')}`;
}

function fitid(date, amount, desc) {
  const key = `${date}|${Number(amount).toFixed(2)}|${String(desc).slice(0, 80)}`;
  return `amex-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function makeTxn(date, amount, description) {
  // Merchant credits use "Credit: …" and must NOT be treated as bank payoffs.
  const amt = Math.round(Number(amount) * 100) / 100;
  const desc = String(description || '').trim();
  const isMerchantCredit = /^Credit:/i.test(desc);
  return {
    date,
    amount: amt,
    description: desc,
    fitid: fitid(date, amt, description),
    isMerchantCredit,
    // Payments reduce the card balance from bank ACH; credits are refunds.
    isPayment: amt < 0 && !isMerchantCredit,
  };
}

export function looksLikeAmexStatement(text) {
  const t = String(text || '');
  return /americanexpress\.com/i.test(t) || /AMERICAN EXPRESS/i.test(t) || /Account Ending\s+\d{5}/i.test(t);
}

function parseMetadata(text) {
  const meta = {};
  let m = text.match(/Closing Date\s+(\d{2}\/\d{2}\/\d{2})/i);
  if (m) meta.closingDate = normalizeDate(m[1]);
  m = text.match(/New Balance\s+\$([\d,]+\.\d{2})/i);
  if (m) meta.newBalance = parseAmount(m[1]);
  m = text.match(
    /Previous Balance\s+Payments\/Credits\s+New Charges\s+Fees\s+Interest Charged[\s\S]*?\$([\d,]+\.\d{2})\s+(-?\$[\d,]+\.\d{2})\s+\+\$([\d,]+\.\d{2})\s+\+\$([\d,]+\.\d{2})\s+\+\$([\d,]+\.\d{2})/i
  );
  if (m) {
    meta.previousBalance = parseAmount(m[1]);
    meta.paymentsCredits = parseAmount(m[2]);
    meta.newCharges = parseAmount(m[3]);
    meta.fees = parseAmount(m[4]);
    meta.interestCharged = parseAmount(m[5]);
  }
  m = text.match(/Account Ending\s+(?:\d-)?(\d{5})/i);
  // Match bank-import-targets ofxAccountId last-4 (88007 → 8007).
  if (m) meta.accountLast4 = m[1].slice(-4);
  else meta.accountLast4 = '8007';
  meta.cardName = 'Amex Marriott Bonvoy Business';
  // Reconcile UI / bank import expect these checking-statement field names.
  if (meta.closingDate) meta.periodEnd = meta.closingDate;
  if (meta.newBalance != null) meta.currentBalance = meta.newBalance;
  meta.bankName = 'American Express';
  return meta;
}

function parseCredits(text) {
  const txns = [];
  const lines = text.split(/\r?\n/);
  let inCredits = false;
  let pending = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'Credits Amount') {
      inCredits = true;
      continue;
    }
    if (inCredits && line.startsWith('New Charges')) break;
    if (!inCredits) continue;
    const cm = line.match(/^(\d{2}\/\d{2}\/\d{2})\s+JEREMY S COHEN\s+(.+)$/);
    if (cm) {
      pending = { date: normalizeDate(cm[1]), desc: cm[2].trim() };
      continue;
    }
    const am = line.match(/^(-?\$[\d,]+\.\d{2})$/);
    if (am && pending) {
      txns.push(makeTxn(pending.date, parseAmount(am[1]), `Credit: ${pending.desc}`));
      pending = null;
    }
  }
  return txns;
}

function parsePayments(text) {
  const txns = [];
  const re = /^(\d{2}\/\d{2}\/\d{2})\*?\s+JEREMY S COHEN\s+(.+?)\s+(-?\$[\d,]+\.\d{2})\s*$/;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const pm = line.match(re);
    if (pm) txns.push(makeTxn(normalizeDate(pm[1]), parseAmount(pm[3]), pm[2].trim()));
  }
  return txns;
}

function parseCharges(text) {
  const txns = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    i += 1;
    if (!line) continue;

    const im = line.match(/^(\d{2}\/\d{2}\/\d{2})\s+(Interest Charge on Purchases)\s+\$([\d,]+\.\d{2})\s*$/);
    if (im) {
      txns.push(makeTxn(normalizeDate(im[1]), parseAmount(im[3]), im[2]));
      continue;
    }

    const cm = line.match(/^(\d{2}\/\d{2}\/\d{2})\s+(.+)$/);
    if (!cm) continue;
    const dateRaw = cm[1];
    const rest = cm[2];
    if (rest.includes('Closing Date') || rest.includes('Account Ending') || rest.startsWith('JEREMY S COHEN')) continue;
    if (/PAYMENT/i.test(rest) && rest.includes('$')) continue;
    if (['Amount', 'Detail', 'Detail Continued', 'Credits Amount', 'Payments Amount'].includes(rest)) continue;

    let amount = null;
    const descParts = [rest];
    let j = i;
    while (j < lines.length && j < i + 4) {
      const nxt = lines[j].trim();
      const am = nxt.match(/^\$([\d,]+\.\d{2})$/);
      if (am) {
        amount = parseAmount(am[1]);
        i = j + 1;
        break;
      }
      if (/^\d{2}\/\d{2}\/\d{2}\s+/.test(nxt) || /JEREMY S COHEN/.test(nxt) || /^Interest Charge/.test(nxt)) break;
      if (nxt && !nxt.startsWith('p. ') && nxt !== 'Continued on reverse') descParts.push(nxt);
      j += 1;
    }
    if (amount == null) continue;
    const desc = descParts.join(' ');
    if (desc.includes('Interest Charge')) continue;
    txns.push(makeTxn(normalizeDate(dateRaw), amount, desc));
  }
  return txns;
}

function dedupe(txns) {
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

export async function extractAmexPdfFromFile(pdfPath) {
  const buf = fs.readFileSync(pdfPath);
  const text = await parsePdfBuffer(buf);
  if (!looksLikeAmexStatement(text)) {
    throw new Error('not an Amex statement');
  }
  const meta = parseMetadata(text);
  const transactions = dedupe([
    ...parsePayments(text),
    ...parseCredits(text),
    ...parseCharges(text),
  ]);
  const netChange = Math.round(transactions.reduce((s, t) => s + t.amount, 0) * 100) / 100;
  const result = {
    file: path.basename(pdfPath),
    meta,
    transactionCount: transactions.length,
    netChange,
    transactions,
    statementType: 'credit_card',
  };
  if (meta.previousBalance != null && meta.newBalance != null) {
    result.expectedNet = Math.round((meta.newBalance - meta.previousBalance) * 100) / 100;
    result.netVariance = Math.round((netChange - result.expectedNet) * 100) / 100;
    result.expectedClosing = meta.newBalance;
  }
  return result;
}
