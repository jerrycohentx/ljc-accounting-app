/** Client-side vendor pattern helpers (mirrors lib/vendor-category-rule.js). */

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

export function deriveVendorPatternClient(description) {
  let text = String(description || '')
    .replace(/^Amex(?:\s+stmt\s+\d{4}-\d{2}-\d{2})?:\s*/i, '')
    .replace(/^Categorize\s+\d{4}→\d{4}:\s*/i, '')
    .replace(/^OFX Import:\s*/i, '')
    .replace(/\s+-\s+FITID:.*$/i, '')
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, ' ')
    .replace(/\b\d{3,}(?:-\d+)*\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const first = text.split(/\s{2,}/)[0].trim() || text;
  const tokens = first
    .toUpperCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^A-Z0-9*]+|[^A-Z0-9*.]+$/g, ''))
    .filter(Boolean)
    .filter((t) => !US_STATE_CODES.has(t))
    .filter((t) => !/^\d+$/.test(t));
  if (!tokens.length) return '';
  const domain = tokens.find((t) => /\.[A-Z]{2,}/.test(t) || /^WEB\*[A-Z0-9*.]+$/i.test(t));
  if (domain) {
    const bare = domain.replace(/^WEB\*/i, '');
    const pick = bare.length >= 4 ? bare : domain;
    return pick.length >= 3 ? pick : '';
  }
  const words = tokens.filter((t) => /[A-Z]/.test(t) && t.length >= 3).slice(0, 3);
  let cleaned = (words.length ? words : tokens.slice(0, 3)).join(' ').trim();
  if (cleaned.length > 36) {
    const cut = cleaned.slice(0, 36);
    const lastSpace = cut.lastIndexOf(' ');
    cleaned = (lastSpace > 8 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return cleaned.length >= 3 ? cleaned : '';
}

export function vendorPatternMatchesClient(text, pattern, matchType = 'contains') {
  const hay = String(text || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const pat = String(pattern || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!hay || pat.length < 3) return false;
  if (matchType === 'exact') return hay === pat;
  if (matchType === 'starts_with') return hay.startsWith(pat);
  return hay.includes(pat);
}

export function countVendorPatternMatches(items, getText, pattern, matchType = 'contains') {
  const pat = String(pattern || '').trim();
  if (pat.length < 3) return 0;
  return (items || []).filter((it) => vendorPatternMatchesClient(getText(it), pat, matchType)).length;
}
