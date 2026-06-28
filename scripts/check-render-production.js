#!/usr/bin/env node
/**
 * Probe Render production API health and LJC 2026 book status.
 * Usage: node scripts/check-render-production.js [baseUrl]
 */
const BASE = process.argv[2] || 'https://ljc-accounting-app.onrender.com';

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@ljcfinancial.com', password: 'demo123' }),
  });
  const data = await res.json();
  if (!data.token) throw new Error(data.error || 'Login failed');
  return data.token;
}

async function get(path, token) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!ct.includes('application/json')) {
    return { _html: true, status: res.status, snippet: text.slice(0, 80) };
  }
  return JSON.parse(text);
}

async function main() {
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  const token = await login();
  const entities = await get('/api/entities', token);
  const accounts = await get('/api/entities/ent-ljc/accounts', token);
  const journals = await get('/api/entities/ent-ljc/journals', token);
  const dashboard = await get('/api/entities/ent-ljc/reports/dashboard', token);
  const tax = await get('/api/tax-financials/2025', token);
  const pending = await get('/api/import/pending?entityId=ent-ljc', token);

  const journalList = journals?.data || journals || [];
  const j2026 = journalList.filter((j) => String(j.posting_date).slice(0, 4) === '2026');

  const acct1000 = Array.isArray(accounts)
    ? accounts.find((a) => a.account_number === '1000')
    : null;

  let ledger1000 = null;
  if (acct1000?.id) {
    ledger1000 = await get(
      `/api/entities/ent-ljc/ledger/account/${acct1000.id}?startDate=2026-01-01&endDate=2026-06-30&limit=500`,
      token
    );
  }

  const report = {
    baseUrl: BASE,
    checkedAt: new Date().toISOString(),
    health,
    entityCount: Array.isArray(entities) ? entities.length : 0,
    accountCount: Array.isArray(accounts) ? accounts.length : 0,
    account1000Name: acct1000?.account_name,
    journals2026: j2026.length,
    recent2026Journals: j2026.slice(0, 5).map((j) => ({
      date: j.posting_date,
      number: j.je_number,
      description: j.description,
    })),
    dashboardKpis: dashboard?.kpis,
    ledger1000Entries2026: Array.isArray(ledger1000) ? ledger1000.length : 0,
    features: {
      taxFinancials2025: tax._html ? 'not deployed (SPA HTML)' : Boolean(tax.allTaxReturnReady),
      bankImportPending: pending._html ? 'not deployed' : pending?.count ?? 0,
    },
    productionGap: {
      hasOpeningBalances: j2026.some((j) => String(j.description || '').includes('Opening balances')),
      hasJanMayBankImport: j2026.length > 10,
      expectedMayBalance1000: 19977.13,
      note: 'Local dev has Jan–May 2026 Simmons import; Render Postgres does not unless migrated.',
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
