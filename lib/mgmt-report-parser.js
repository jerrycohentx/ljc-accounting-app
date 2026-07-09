/**
 * Property Management Report Parser
 * ==================================
 *
 * Turns the text of a 3rd-party property manager's monthly report into a
 * structured shape that lib/mgmt-report-je.js can turn into a balanced,
 * draft journal entry.
 *
 * Two known vendor formats today:
 *  - WESTSIDE  : WestSide Realty "Monthly Income Statement" (text-native PDF)
 *  - MANAGE_RH : MANAGErenthouses.com "Owner Statement" (sometimes scanned —
 *                 when scanned there is no text layer at all; see needsReview)
 *
 * Unknown/unparseable documents (including scanned images with no text
 * layer) come back with needsReview = true and empty line arrays rather than
 * guessing — a human confirms the figures via the review screen before any
 * journal entry is created. Money is always integer cents.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function toCents(str) {
  if (str == null) return null;
  let s = String(str).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  s = s.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number.parseFloat(s) * 100);
  return neg ? -cents : cents;
}

function longDateToIso(str) {
  // "June 30, 2026"
  const m = String(str).trim().match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

function shortDateToIso(str) {
  // "06/14/26"
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, mo, d, y] = m;
  if (y.length === 2) y = `20${y}`;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const MONEY_RE = /\(?-?\$?[\d,]+\.\d{2}\)?/;

/**
 * Parse a "Label 123.45" (or YTD-style "Label 123.45 456.78") line into
 * { label, cents } using the FIRST money amount found on the line — the
 * "Current"/this-period figure when a YTD column follows. Deliberately
 * tolerant of zero whitespace between label and amount: pdf-parse (unlike
 * the `pdftotext -layout` CLI used while prototyping this parser) often
 * emits "Rent2,200.00" with no separating space at all.
 */
function parseLabeledLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const match = MONEY_RE.exec(trimmed);
  if (!match) return null;
  const label = trimmed.slice(0, match.index).trim();
  if (!label) return null; // pure numeric row (section subtotal), no label
  const cents = toCents(match[0]);
  if (cents == null) return null;
  return { label, cents };
}

function isMoneyToken(tok) {
  return new RegExp(`^${MONEY_RE.source}$`).test(String(tok || '').trim());
}

function detectFormat(text) {
  if (/WestSide Realty/i.test(text) && /Monthly Income Statement/i.test(text)) return 'WESTSIDE';
  if (/Owner Statement/i.test(text) && /Beginning Cash Balance/i.test(text)) return 'MANAGE_RH';
  return 'UNKNOWN';
}

function parseWestside(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  const result = {
    format: 'WESTSIDE',
    managementCompany: 'WestSide Realty',
    propertyRaw: null,
    periodStart: null,
    periodEnd: null,
    incomeLines: [],
    expenseLines: [],
    otherLines: [],
    totals: {},
    notes: [],
  };

  const dateMatch = text.match(/Monthly Income Statement\s*\n+\s*([A-Za-z]+ \d{1,2},? \d{4})/);
  if (dateMatch) {
    const iso = longDateToIso(dateMatch[1].replace(',', ''));
    if (iso) { result.periodEnd = iso; result.periodStart = `${iso.slice(0, 8)}01`; }
  }

  let state = 'NONE';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (state === 'NONE' && !result.propertyRaw && /^Property/i.test(line)) {
      result.propertyRaw = line.replace(/^Property/i, '').trim();
      continue;
    }
    if (/^Income$/i.test(line)) { state = 'INCOME'; continue; }
    if (/^Expense$/i.test(line)) { state = 'EXPENSE'; continue; }
    if (/^Total Income/i.test(line)) {
      const parsed = parseLabeledLine(line);
      if (parsed) result.totals.totalIncomeCents = parsed.cents;
      state = 'NONE';
      continue;
    }
    if (/^Total Expenses?/i.test(line)) {
      const parsed = parseLabeledLine(line);
      if (parsed) result.totals.totalExpenseCents = parsed.cents;
      state = 'NONE';
      continue;
    }
    if (/^Net Income/i.test(line)) {
      const parsed = parseLabeledLine(line);
      if (parsed) result.totals.netIncomeCents = parsed.cents;
      continue;
    }
    if (state === 'INCOME') {
      const parsed = parseLabeledLine(line);
      if (parsed) result.incomeLines.push(parsed);
      continue;
    }
    if (state === 'EXPENSE') {
      const parsed = parseLabeledLine(line);
      if (parsed) result.expenseLines.push(parsed);
      continue;
    }
    // Freeform notes (tenant deposit remarks etc.) — kept for the record, not booked.
    if (/deposit|tenant/i.test(line) && !isMoneyToken(line)) {
      result.otherLines.push(line);
    }
  }

  return result;
}

function parseManageRh(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  const result = {
    format: 'MANAGE_RH',
    managementCompany: 'MANAGErenthouses.com',
    propertyRaw: null,
    periodStart: null,
    periodEnd: null,
    incomeLines: [],
    expenseLines: [],
    otherLines: [],
    totals: {},
    notes: [],
  };

  const ownM = text.match(/Ownerships:\s*(.+)/);
  if (ownM) result.propertyRaw = ownM[1].trim();

  const rangeM = text.match(/Date Range:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (rangeM) {
    result.periodStart = shortDateToIso(rangeM[1]);
    result.periodEnd = shortDateToIso(rangeM[2]);
  }

  let state = 'NONE';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Beginning Cash Balance/i.test(line)) {
      const p = parseLabeledLine(line);
      if (p) result.totals.beginningCashCents = p.cents;
      continue;
    }
    if (/^Income$/i.test(line)) { state = 'INCOME'; continue; }
    if (/^Expense$/i.test(line)) { state = 'EXPENSE'; continue; }
    if (/^Net Income\/Loss/i.test(line)) {
      const p = parseLabeledLine(line);
      if (p) result.totals.netIncomeCents = p.cents;
      state = 'NONE';
      continue;
    }
    if (/^Other Transactions/i.test(line)) { state = 'OTHER'; continue; }
    if (/^Ending Cash Balance/i.test(line)) {
      const p = parseLabeledLine(line);
      if (p) result.totals.endingCashCents = p.cents;
      state = 'NONE';
      continue;
    }
    if (/^Comments?$/i.test(line)) { state = 'NONE'; continue; }

    if (state === 'INCOME') {
      const p = parseLabeledLine(line);
      // Skip the section subtotal line (repeats the same figure with no distinct label)
      if (p) result.incomeLines.push(p);
      continue;
    }
    if (state === 'EXPENSE') {
      const p = parseLabeledLine(line);
      if (p) result.expenseLines.push(p);
      continue;
    }
    if (state === 'OTHER') {
      const p = parseLabeledLine(line);
      if (p) result.otherLines.push(p);
      continue;
    }
  }

  // Pure label-less subtotal rows (e.g. "2,307.00   13,527.00") are already
  // rejected by parseLabeledLine (isMoneyToken(cols[0])), so no further
  // de-duping is needed here.
  result.totals.totalIncomeCents = result.incomeLines.reduce((s, l) => s + l.cents, 0);
  result.totals.totalExpenseCents = result.expenseLines.reduce((s, l) => s + l.cents, 0);

  return result;
}

/**
 * Public entrypoint. `text` is the extracted text layer of the uploaded PDF
 * (empty string for a scanned/image-only PDF — pdf-parse returns '' or
 * near-empty in that case, which routes straight to needsReview).
 */
export function parseManagementReport(text) {
  const raw = text || '';
  const format = detectFormat(raw);

  if (format === 'UNKNOWN' || raw.trim().length < 40) {
    return {
      format: raw.trim().length < 40 ? 'SCANNED_NO_TEXT' : 'UNKNOWN',
      managementCompany: null,
      propertyRaw: null,
      periodStart: null,
      periodEnd: null,
      incomeLines: [],
      expenseLines: [],
      otherLines: [],
      totals: {},
      confidenceScore: 0,
      needsReview: true,
      notes: raw.trim().length < 40
        ? ['No text layer found (scanned/image PDF). Enter the figures manually below.']
        : ['Unrecognized report format. Enter the figures manually below.'],
    };
  }

  const parsed = format === 'WESTSIDE' ? parseWestside(raw) : parseManageRh(raw);

  const incomeSum = parsed.incomeLines.reduce((s, l) => s + l.cents, 0);
  const expenseSum = parsed.expenseLines.reduce((s, l) => s + l.cents, 0);
  const totalIncomeCents = parsed.totals.totalIncomeCents ?? incomeSum;
  const totalExpenseCents = parsed.totals.totalExpenseCents ?? expenseSum;

  const notes = [...parsed.notes];
  let confidence = 0.5;
  if (parsed.propertyRaw) confidence += 0.15;
  if (parsed.periodEnd) confidence += 0.15;
  if (parsed.incomeLines.length || parsed.expenseLines.length) confidence += 0.1;
  if (incomeSum === totalIncomeCents) confidence += 0.05; else notes.push(`Income lines sum to ${(incomeSum / 100).toFixed(2)} but report states Total Income ${(totalIncomeCents / 100).toFixed(2)}.`);
  if (expenseSum === totalExpenseCents) confidence += 0.05; else notes.push(`Expense lines sum to ${(expenseSum / 100).toFixed(2)} but report states Total Expenses ${(totalExpenseCents / 100).toFixed(2)}.`);
  confidence = Math.min(1, Number(confidence.toFixed(2)));

  const needsReview = confidence < 0.85 || !parsed.propertyRaw || (totalIncomeCents === 0 && totalExpenseCents === 0);
  if (!parsed.propertyRaw) notes.push('Could not determine which property this report is for.');
  if (totalIncomeCents === 0 && totalExpenseCents === 0) notes.push('No income or expense activity found for this period — nothing to book.');

  return {
    format: parsed.format,
    managementCompany: parsed.managementCompany,
    propertyRaw: parsed.propertyRaw,
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    incomeLines: parsed.incomeLines,
    expenseLines: parsed.expenseLines,
    otherLines: parsed.otherLines,
    totalIncomeCents,
    totalExpenseCents,
    netIncomeCents: parsed.totals.netIncomeCents ?? (totalIncomeCents - totalExpenseCents),
    confidenceScore: confidence,
    needsReview,
    notes,
  };
}

export { toCents, longDateToIso, shortDateToIso };
