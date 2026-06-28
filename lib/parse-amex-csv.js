import fs from 'fs';
import { createHash } from 'crypto';

function parseAmount(raw) {
  return Math.round(parseFloat(String(raw || '0').replace(/,/g, '')) * 100) / 100;
}

function normalizeDate(mdyyyy) {
  const parts = String(mdyyyy).trim().split('/');
  if (parts.length !== 3) return mdyyyy;
  const [m, d, y] = parts;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function fitid(reference, date, amount, description) {
  const ref = String(reference || '').replace(/'/g, '').trim();
  if (ref) return `amex-ref-${ref}`;
  const key = `${date}|${amount}|${description.slice(0, 80)}`;
  return `amex-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

/** Parse Amex "Download CSV" export (Activity export). */
export function parseAmexCsv(content, { closingDate = null, previousBalance = null, newBalance = null, file = '' } = {}) {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error('Empty CSV');

  const header = lines[0].split(',').map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const transactions = [];
  let row = 1;
  while (row < lines.length) {
    let line = lines[row];
    // Handle multiline quoted CSV fields
    while ((line.match(/"/g) || []).length % 2 !== 0 && row + 1 < lines.length) {
      row += 1;
      line += `\n${lines[row]}`;
    }
    const cols = splitCsvLine(line);
    row += 1;
    if (!cols.length || cols.length < 6) continue;

    const date = normalizeDate(cols[idx.Date] || cols[0]);
    const description = (cols[idx.Description] || cols[2] || '').trim();
    const amount = parseAmount(cols[idx.Amount] ?? cols[5]);
    const category = (cols[idx.Category] || cols[13] || '').trim();
    const reference = cols[idx.Reference] || cols[12] || '';

    if (!description || Number.isNaN(amount)) continue;

    transactions.push({
      date,
      amount,
      description,
      category,
      fitid: fitid(reference, date, amount, description),
      isPayment: amount < 0,
    });
  }

  const netChange = Math.round(transactions.reduce((s, t) => s + t.amount, 0) * 100) / 100;

  return {
    file,
    meta: {
      closingDate,
      previousBalance,
      newBalance,
      accountLast4: '88007',
      cardName: 'Amex Marriott Bonvoy Business 88007',
      source: 'csv',
    },
    transactionCount: transactions.length,
    netChange,
    transactions,
    expectedNet: previousBalance != null && newBalance != null
      ? Math.round((newBalance - previousBalance) * 100) / 100
      : null,
    netVariance: previousBalance != null && newBalance != null
      ? Math.round((netChange - (newBalance - previousBalance)) * 100) / 100
      : null,
  };
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseAmexCsvFile(filePath, meta = {}) {
  const content = fs.readFileSync(filePath, 'utf8');
  return parseAmexCsv(content, { ...meta, file: filePath.split(/[/\\]/).pop() });
}
