/** Detect Lone Star Bank eStatement notification emails (no PDF attachment). */

const NOTIFY_FROM = /lsbtexas\.com|info@lsbtexas/i;
const NOTIFY_SUBJECT = /estatement|e[\-\s]?statement|statement.*ready|ready to view/i;
const ACCOUNT_LAST4 = /7367|\*\*7367|ending\s*(?:in\s*)?7367/i;

const MONTH_NAMES = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};

export function getLonestarPortalConfig() {
  const user = process.env.LONESTAR_ONLINE_USER || process.env.LONESTAR_NETTELLER_USER || '';
  const password = process.env.LONESTAR_ONLINE_PASSWORD || process.env.LONESTAR_NETTELLER_PASSWORD || '';
  return {
    enabled: !!(user && password),
    user,
    password,
    portalUrl: process.env.LONESTAR_PORTAL_URL || 'https://my.lsbtexas.com',
    accountLast4: process.env.LONESTAR_ACCOUNT_LAST4 || '7367',
  };
}

export function isLonestarEStatementNotification({
  subject = '',
  from = '',
  text = '',
  html = '',
  attachments = [],
} = {}) {
  const hasStatementFile = (attachments || []).some((a) => /\.(pdf|ofx|qfx)$/i.test(a.filename || ''));
  if (hasStatementFile) return false;

  const hay = `${subject} ${from} ${text}`.toLowerCase();
  const fromMatch = NOTIFY_FROM.test(from) || /info@lsbtexas/i.test(from);
  const bankMatch = /lone\s*star/i.test(hay);
  if (!fromMatch && !bankMatch) return false;

  return NOTIFY_SUBJECT.test(subject) || NOTIFY_SUBJECT.test(hay) || ACCOUNT_LAST4.test(hay);
}

export function parseLonestarNotificationMeta({ subject = '', text = '', html = '' } = {}) {
  const combined = `${subject}\n${text}\n${stripHtml(html)}`;
  const accountLast4 = (combined.match(/(?:ending\s*(?:in\s*)?|\*{2,}|x{4,}|\.{3,})(\d{4})/i)
    || combined.match(/\b7367\b/)
    || ['', process.env.LONESTAR_ACCOUNT_LAST4 || '7367'])[1];

  let periodEnd = null;
  let periodStart = null;

  const isoRange = combined.match(/(\d{4}-\d{2}-\d{2})\s*(?:to|through|thru|-)\s*(\d{4}-\d{2}-\d{2})/i);
  if (isoRange) {
    periodStart = isoRange[1];
    periodEnd = isoRange[2];
  }

  const mdRange = combined.match(
    /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(?:to|through|thru|-)\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i
  );
  if (mdRange) {
    periodStart = normalizeMdDate(mdRange[1]);
    periodEnd = normalizeMdDate(mdRange[2]);
  }

  const monthYear = combined.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i
  );
  if (monthYear && !periodEnd) {
    const month = MONTH_NAMES[monthYear[1].toLowerCase()];
    const year = monthYear[2];
    periodStart = `${year}-${month}-01`;
    periodEnd = lastDayOfMonth(year, month);
  }

  const stmtDate = combined.match(/\bstatement\s+date\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\b/i);
  if (stmtDate && !periodEnd) {
    periodEnd = normalizeMdDate(stmtDate[1]);
  }

  return { accountLast4, periodStart, periodEnd };
}

export function extractCandidateUrls({ text = '', html = '' } = {}) {
  const urls = new Set();
  const raw = `${text}\n${html}`;
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  for (const match of raw.match(re) || []) {
    const cleaned = match.replace(/[.,;]+$/, '');
    if (/\.(png|gif|jpg|jpeg|svg)(\?|$)/i.test(cleaned)) continue;
    urls.add(cleaned);
  }
  return [...urls];
}

export function pickStatementDownloadUrl(urls = []) {
  return urls.find((u) => {
    const lower = u.toLowerCase();
    if (/\.pdf(\?|$)/i.test(lower)) return true;
    if (/lsbtexas\.com/i.test(lower) && /statement|document|estatement|edocument/i.test(lower)) return true;
    if (/statement|estatement|edocument/i.test(lower) && /download|view|doc/i.test(lower)) return true;
    return false;
  }) || null;
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

function normalizeMdDate(mdyy) {
  const parts = mdyy.trim().split('/');
  if (parts.length !== 3) return null;
  let [m, d, y] = parts.map((p) => parseInt(p, 10));
  if (y < 100) y += 2000;
  return `${y.toString().padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function lastDayOfMonth(year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = new Date(y, m, 0).getDate();
  return `${y.toString().padStart(4, '0')}-${month}-${String(d).padStart(2, '0')}`;
}
