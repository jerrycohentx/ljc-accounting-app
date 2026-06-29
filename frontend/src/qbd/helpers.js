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

/** Reconcile tables: m/d/yr only (e.g. 1/5/26) — no timestamps. */
export function fmtReconDate(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getMonth() + 1}/${value.getDate()}/${String(value.getFullYear()).slice(-2)}`;
  }
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const m = +iso[2];
    const day = +iso[3];
    const yr = iso[1].slice(-2);
    return `${m}/${day}/${yr}`;
  }
  const d = raw.includes('T') ? new Date(raw) : new Date(`${raw.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
}

/** Single amount column for compact reconcile panes (always positive). */
export function reconRegisterAmount(entry, account) {
  const signed = signedGlDelta(entry, account);
  return Math.abs(signed) < 0.005 ? null : Math.abs(signed);
}

/** Credit card / liability accounts use Charge + Payment columns (QBD style). */
export function isCreditCardAccount(account) {
  if (!account) return false;
  if (account.account_type === 'LIABILITY') return true;
  if (account.normal_balance === 'CREDIT') return true;
  return /Credit-Cards|Credit Card/i.test(account.account_name || '');
}

export function reconColumnLabels(account) {
  return isCreditCardAccount(account)
    ? { col1: 'Charge', col2: 'Payment', cleared1: 'Cleared charges', cleared2: 'Cleared payments' }
    : { col1: 'Deposit', col2: 'Payment', cleared1: 'Cleared deposits', cleared2: 'Cleared payments' };
}

/** Signed register delta for reconcile math (matches backend normal_balance). */
export function signedGlDelta(entry, account) {
  const d = +(entry.debit || 0);
  const c = +(entry.credit || 0);
  return isCreditCardAccount(account) ? c - d : d - c;
}

/** QBD column amounts for register row display. */
export function registerDisplayAmounts(entry, account) {
  const d = +(entry.debit || 0);
  const c = +(entry.credit || 0);
  if (isCreditCardAccount(account)) return { col1: c || null, col2: d || null };
  return { col1: d || null, col2: c || null };
}

/** Statement line columns (+ = charge/deposit, − = payment). */
export function statementDisplayAmounts(line, account) {
  const amt = +(line.amount || 0);
  if (isCreditCardAccount(account)) {
    return { col1: amt > 0 ? amt : null, col2: amt < 0 ? Math.abs(amt) : null };
  }
  return { col1: line.deposit ?? (amt > 0 ? amt : null), col2: line.payment ?? (amt < 0 ? Math.abs(amt) : null) };
}

/** QBD reconcile totals (spec §5). */
export function computeReconcileTotals({
  beginningBalance,
  serviceCharge = 0,
  interestEarned = 0,
  markedDeposits = 0,
  markedPayments = 0,
  endingBalance,
}) {
  const clearedBalance = beginningBalance - serviceCharge + interestEarned + markedDeposits - markedPayments;
  const difference = endingBalance - clearedBalance;
  return { clearedBalance, difference, balanced: Math.abs(difference) < 0.005 };
}

export function entrySide(entry, account) {
  const signed = signedGlDelta(entry, account);
  if (Math.abs(signed) < 0.005) return null;
  return signed < 0 ? 'payment' : 'deposit';
}

export function fmtVariance(n, isPct = false) {
  if (n == null || Number.isNaN(n)) return '—';
  if (isPct) return `${n >= 0 ? '+' : ''}${n.toFixed(1)}pp`;
  return fmt(n);
}

export function fmtVariancePct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

export function matchStatusChip(status) {
  if (status === 'matched') return { label: '● matched', cls: 'match-ok' };
  if (status === 'needs_review') return { label: '◐ review', cls: 'match-warn' };
  return { label: '○ not in books', cls: 'match-none' };
}
