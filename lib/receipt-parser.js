/**
 * Receipt / Invoice AI Parsing Engine
 * ====================================
 *
 * Extracts structured data (vendor, date, totals, tax) from raw receipt or
 * invoice text. Follows the automated-bookkeeping rules:
 *
 *  - Deterministic fallback: a rules-based extractor always runs and produces a
 *    structured result, so the pipeline never blocks on an external LLM.
 *  - Structured output: always returns the same JSON shape.
 *  - Confidence scoring: every parse returns confidence_score in [0, 1]. Callers
 *    flag anything below CONFIDENCE_THRESHOLD for human-in-the-loop review.
 *  - Strict PII masking: card numbers, SSNs, phone numbers and emails are
 *    stripped from raw text BEFORE it is stored or sent to any external AI API.
 *
 * Money is returned as integer minor units (cents) — never floats.
 */

export const CONFIDENCE_THRESHOLD = 0.85;

const CARD_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;
const PHONE_REGEX = /(\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const AMOUNT_REGEX = /(?:[$£€]\s?)?(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})/g;
const DATE_PATTERNS = [
  /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, // 2024-01-31
  /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/, // 01/31/2024
  /\b(\d{1,2})-(\d{1,2})-(\d{2,4})\b/, // 01-31-2024
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i,
];

const CARD_BRANDS = /\b(visa|mastercard|amex|american express|discover)\b/i;

/**
 * Remove personally identifiable / sensitive data from raw text.
 * Card numbers, SSNs, phone numbers and emails are replaced with redaction
 * tokens. Run this before persisting raw_text or calling any external AI API.
 */
export function maskPII(text) {
  if (!text) return '';
  return String(text)
    .replace(SSN_REGEX, '[REDACTED_SSN]')
    .replace(CARD_REGEX, (match) => {
      const digits = match.replace(/\D/g, '');
      if (digits.length < 13 || digits.length > 19) return match; // not a card
      const last4 = digits.slice(-4);
      return `[REDACTED_CARD_****${last4}]`;
    })
    .replace(EMAIL_REGEX, '[REDACTED_EMAIL]')
    .replace(PHONE_REGEX, (match) => {
      const digits = match.replace(/\D/g, '');
      if (digits.length < 10) return match; // avoid masking ordinary numbers
      return '[REDACTED_PHONE]';
    });
}

function toCents(amountStr) {
  if (amountStr == null) return null;
  const normalized = String(amountStr).replace(/[$£€,\s]/g, '');
  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function detectCurrency(text) {
  if (/€|eur\b/i.test(text)) return 'EUR';
  if (/£|gbp\b/i.test(text)) return 'GBP';
  if (/\bcad\b/i.test(text)) return 'CAD';
  return 'USD';
}

function parseDate(text) {
  for (const pattern of DATE_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    try {
      if (pattern === DATE_PATTERNS[0]) {
        const [, y, mo, d] = m;
        return iso(y, mo, d);
      }
      if (pattern === DATE_PATTERNS[1] || pattern === DATE_PATTERNS[2]) {
        let [, mo, d, y] = m;
        if (y.length === 2) y = `20${y}`;
        return iso(y, mo, d);
      }
      // Month name pattern
      const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      const mo = months.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
      return iso(m[3], mo, m[2]);
    } catch {
      // try next pattern
    }
  }
  return null;
}

function iso(y, m, d) {
  const yy = String(y).padStart(4, '0');
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  const date = new Date(`${yy}-${mm}-${dd}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error('invalid date');
  return `${yy}-${mm}-${dd}`;
}

function findLabeledAmount(text, labels) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (labels.test(line)) {
      const matches = [...line.matchAll(AMOUNT_REGEX)];
      if (matches.length) {
        return toCents(matches[matches.length - 1][1]);
      }
    }
  }
  return null;
}

function guessVendor(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    // Skip lines that are obviously not a vendor name
    if (/receipt|invoice|tax\s*invoice|order\s*#|statement/i.test(line) && line.length < 25) continue;
    if (AMOUNT_REGEX.test(line)) {
      AMOUNT_REGEX.lastIndex = 0;
      continue;
    }
    if (/^\d+$/.test(line)) continue;
    if (line.length >= 2 && line.length <= 60) return line;
  }
  return lines[0] || null;
}

function suggestCategory(vendor, text) {
  const hay = `${vendor || ''} ${text}`.toLowerCase();
  const rules = [
    [/aws|amazon\s*web\s*services|google\s*cloud|azure|github|saas|subscription|adobe|slack|zoom/, 'Software & Subscriptions'],
    [/uber|lyft|taxi|airline|flight|hotel|marriott|hilton|airbnb/, 'Travel'],
    [/restaurant|cafe|coffee|starbucks|grill|pizza|diner|bar\b/, 'Meals & Entertainment'],
    [/amazon|staples|office\s*depot|supplies|paper/, 'Office Supplies'],
    [/shell|chevron|exxon|gas|fuel|parking/, 'Auto & Fuel'],
    [/electric|water|utility|internet|comcast|at&t|verizon/, 'Utilities'],
    [/fedex|ups|usps|postage|shipping/, 'Shipping & Postage'],
  ];
  for (const [re, cat] of rules) {
    if (re.test(hay)) return cat;
  }
  return 'Uncategorized';
}

/**
 * Deterministic, rules-based parser. Always returns a structured result.
 */
export function parseReceiptDeterministic(rawText) {
  const masked = maskPII(rawText || '');
  const currency = detectCurrency(masked);

  const total = findLabeledAmount(masked, /\b(grand\s*total|total\s*due|amount\s*due|total)\b/i);
  const subtotal = findLabeledAmount(masked, /\b(sub\s*-?\s*total)\b/i);
  const tax = findLabeledAmount(masked, /\b(tax|vat|gst|hst)\b/i);

  // Fallback total: largest amount found in document.
  let totalCents = total;
  if (totalCents == null) {
    const all = [...masked.matchAll(AMOUNT_REGEX)].map((m) => toCents(m[1])).filter((c) => c != null);
    if (all.length) totalCents = Math.max(...all);
  }

  const vendor = guessVendor(masked);
  const receiptDate = parseDate(masked);
  const category = suggestCategory(vendor, masked);

  // Confidence: weighted presence of key fields + internal consistency.
  let score = 0;
  if (vendor) score += 0.25;
  if (receiptDate) score += 0.2;
  if (totalCents != null) score += 0.3;
  if (tax != null) score += 0.1;
  if (subtotal != null) score += 0.05;
  if (CARD_BRANDS.test(masked) || /receipt|invoice/i.test(masked)) score += 0.05;
  // Consistency bonus: subtotal + tax ≈ total
  if (subtotal != null && tax != null && totalCents != null) {
    if (Math.abs(subtotal + tax - totalCents) <= 2) score += 0.05;
  }
  score = Math.min(1, Number(score.toFixed(2)));

  return {
    vendor,
    receiptDate,
    currency,
    subtotalCents: subtotal ?? (totalCents != null && tax != null ? totalCents - tax : null),
    taxCents: tax,
    totalCents: totalCents ?? null,
    category,
    confidenceScore: score,
    needsReview: score < CONFIDENCE_THRESHOLD,
    maskedText: masked,
    extractor: 'deterministic',
  };
}

/**
 * Public entrypoint. Runs the deterministic extractor. If an external LLM is
 * configured (OPENAI_API_KEY) and the deterministic confidence is low, callers
 * may layer an LLM pass on top — but the deterministic result is always the
 * safe fallback and is what is returned here to avoid blocking the pipeline.
 */
export function parseReceipt(rawText) {
  return parseReceiptDeterministic(rawText);
}
