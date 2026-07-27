/** Statement ending dates for 2026 — mirrors config/bank-import-targets.js */
const RECON_TARGETS = {
  'ent-ljc': {
    '1000': [
      { statementDate: '2026-02-01', label: 'January 2026' },
      { statementDate: '2026-03-01', label: 'February 2026' },
      { statementDate: '2026-03-31', label: 'March 2026' },
      { statementDate: '2026-04-30', label: 'April 2026' },
      { statementDate: '2026-05-31', label: 'May 2026' },
      { statementDate: '2026-06-26', label: 'June 2026 (OFX)' },
    ],
    '1001': [
      { statementDate: '2026-01-31', label: 'January 2026' },
      { statementDate: '2026-02-28', label: 'February 2026' },
      { statementDate: '2026-03-31', label: 'March 2026' },
      { statementDate: '2026-04-30', label: 'April 2026' },
      { statementDate: '2026-05-31', label: 'May 2026' },
    ],
    '1002': [
      { statementDate: '2026-01-13', label: 'January 2026 — CSB 1385 closed' },
    ],
    '2010': [
      { statementDate: '2026-01-09', label: 'January 2026 (88007)' },
      { statementDate: '2026-02-06', label: 'February 2026 (88007)' },
      { statementDate: '2026-03-09', label: 'March 2026 (88007)' },
      { statementDate: '2026-04-08', label: 'April 2026 (88007)' },
      { statementDate: '2026-05-08', label: 'May 2026 (88007)' },
      { statementDate: '2026-06-08', label: 'June 2026 (88007)' },
    ],
  },
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function accountFromSearchParams(searchParams) {
  return searchParams.get('account') || searchParams.get('accountId') || '';
}

export function statementDateForMonth(entityId, accountNumber, year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!entityId || !accountNumber || !Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    return null;
  }
  const label = `${MONTH_NAMES[m - 1]} ${y}`;
  const list = (RECON_TARGETS[entityId] || {})[String(accountNumber)] || [];
  const hit = list.find((t) => {
    const l = String(t.label || '').trim();
    return l === label || l.startsWith(`${label} `) || l.startsWith(`${label}—`);
  });
  return hit?.statementDate || null;
}

/** Resolve account id from URL token (uuid or account number) once COA rows are loaded. */
export function resolveAccountId(accounts, urlToken) {
  const want = String(urlToken || '').trim();
  if (!want || !accounts?.length) return '';
  const match = accounts.find(
    (a) => a.id === want || String(a.account_number) === want || String(a.number) === want
  );
  return match?.id || (want.startsWith('acc-') ? want : '');
}

export function resolveDeepLinkDate(searchParams, entityId, accountNumber) {
  const direct = searchParams.get('date') || searchParams.get('asOf');
  if (direct && /^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  const year = searchParams.get('year');
  const month = searchParams.get('month');
  if (year && month && accountNumber) {
    return statementDateForMonth(entityId, accountNumber, year, month);
  }
  return null;
}

export function shouldAutoOpenRecon(searchParams, resolvedDate) {
  if (!accountFromSearchParams(searchParams)) return false;
  if (searchParams.get('go') === '1') return !!resolvedDate;
  if (resolvedDate && searchParams.get('month') && searchParams.get('year')) return true;
  return false;
}
