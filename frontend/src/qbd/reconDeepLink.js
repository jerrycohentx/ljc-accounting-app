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
  'ent-omc': {
    '1000': [
      { statementDate: '2026-01-31', label: 'January 2026' },
    ],
    '2011': [
      { statementDate: '2026-01-18', label: 'January 2026 Chase …6508' },
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

/** Calendar year/month the user is working in (Monthly Books), for return navigation. */
export function workingPeriodFromContext({
  searchParams,
  entityId,
  accountNumber,
  statementDate,
} = {}) {
  const yParam = Number(searchParams?.get?.('year'));
  const mParam = Number(searchParams?.get?.('month'));
  if (Number.isFinite(yParam) && yParam >= 2000 && Number.isFinite(mParam) && mParam >= 1 && mParam <= 12) {
    return { year: yParam, month: mParam };
  }
  const sd = String(statementDate || '').slice(0, 10);
  const acct = String(accountNumber || '');
  if (entityId && acct && /^\d{4}-\d{2}-\d{2}$/.test(sd)) {
    const list = (RECON_TARGETS[entityId] || {})[acct] || [];
    const hit = list.find((t) => String(t.statementDate).slice(0, 10) === sd);
    const label = String(hit?.label || '');
    const m = label.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
    if (m) {
      const month = MONTH_NAMES.findIndex((n) => n.toLowerCase() === m[1].toLowerCase()) + 1;
      const year = Number(m[2]);
      if (month >= 1 && year) return { year, month };
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(sd)) {
    // Statement cycles that spill into the next calendar day (Simmons Jan → 02-01)
    // still belong to the prior month when day is the 1st.
    const [ys, ms, ds] = sd.split('-').map(Number);
    if (ds === 1 && ms >= 1) {
      const month = ms === 1 ? 12 : ms - 1;
      const year = ms === 1 ? ys - 1 : ys;
      return { year, month };
    }
    return { year: ys, month: ms };
  }
  return null;
}

export function monthlyBooksPath(year, month) {
  const y = Number(year) || 2026;
  const m = Number(month);
  if (!Number.isFinite(m) || m < 1 || m > 12) return '/';
  return `/?year=${y}&month=${m}`;
}
