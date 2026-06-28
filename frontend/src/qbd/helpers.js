export function fmt(n) {
  if (n === null || n === undefined || n === 0 || isNaN(n)) return n === 0 ? '0.00' : '';
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? '(' + s + ')' : s;
}

// QuickBooks-style account type label
export function typeLabel(a) {
  const name = a.account_name || '';
  if (a.account_type === 'ASSET' && /^Cash/.test(name)) return 'Bank';
  if (a.account_type === 'ASSET' && /Notes-Receivable|Accounts-Receivable/.test(name)) return 'Accounts Receivable';
  if (a.account_type === 'ASSET' && /Real-Estate|REO|Fixed-Assets|Furniture/.test(name)) return 'Fixed Asset';
  if (a.account_type === 'LIABILITY' && /Credit-Cards/.test(name)) return 'Credit Card';
  if (a.account_type === 'LIABILITY' && /Notes-Payable|Lines-Of-Credit/.test(name)) return 'Long Term Liability';
  const m = { ASSET: 'Other Current Asset', LIABILITY: 'Other Current Liability', EQUITY: 'Equity', REVENUE: 'Income', EXPENSE: 'Expense', CONTRA: 'Fixed Asset' };
  return m[a.account_type] || a.account_type;
}

export function leafLabel(name) {
  return (name || '').split(':').pop();
}

// parse a "loan:B1011" style tag out of a GL/line description ("tag | narration")
const TAGKEYS = ['loan', 'property', 'vendor', 'bank', 'type', 'detail', 'counterparty', 'owner', 'partner', 'affiliate', 'security', 'lender'];
export function parseTag(desc) {
  if (!desc) return '';
  const seg = String(desc).split('|')[0].trim();
  if (seg.includes(':') && TAGKEYS.some((k) => seg.startsWith(k + ':'))) return seg;
  return '';
}
export function tagClass(tag) {
  const k = (tag || '').split(':')[0];
  return ['loan', 'property', 'vendor'].includes(k) ? k : '';
}

// flatten a nested account tree (children arrays) into ordered rows with depth
export function flattenTree(nodes, depth = 0, out = []) {
  (nodes || []).forEach((n) => {
    out.push({ ...n, _depth: depth });
    if (n.children && n.children.length) flattenTree(n.children, depth + 1, out);
  });
  return out;
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
