#!/usr/bin/env node
/**
 * Definition-of-done verifier before claiming books are clean / closed / openings rebuilt.
 *
 * Usage:
 *   node scripts/verify-books-clean.mjs --entity ent-ljc --asOf 2026-01-31
 *   node scripts/verify-books-clean.mjs --entity ent-ljc --asOf 2026-01-31 --requireClosed
 *
 * Exit 0 only when every gate passes.
 */
const BASE = process.env.LJC_API_BASE || 'https://ljc-accounting-app.onrender.com';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const entityId = arg('--entity', 'ent-ljc');
const asOf = arg('--asOf', new Date().toISOString().slice(0, 10));
const requireClosed = process.argv.includes('--requireClosed');
const yearStart = `${asOf.slice(0, 4)}-01-01`;
const year = Number(asOf.slice(0, 4));
const month = Number(asOf.slice(5, 7));

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function pick(bs, section, n) {
  return bs[section]?.find((a) => a.accountNumber === n)?.amount ?? 0;
}

async function main() {
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@ljcfinancial.com', password: 'demo123' }),
  }).then((r) => r.json());
  if (!login.token) throw new Error(`login failed: ${JSON.stringify(login)}`);
  const h = { Authorization: `Bearer ${login.token}` };

  const [bs, pnl, tb, integrity] = await Promise.all([
    fetch(`${BASE}/api/entities/${entityId}/reports/balance-sheet?asOfDate=${asOf}`, { headers: h }).then((r) => r.json()),
    fetch(
      `${BASE}/api/entities/${entityId}/reports/income-statement?startDate=${yearStart}&endDate=${asOf}`,
      { headers: h }
    ).then((r) => r.json()),
    fetch(`${BASE}/api/entities/${entityId}/ledger/reports/trial-balance?asOfDate=${asOf}`, { headers: h }).then((r) =>
      r.json()
    ),
    fetch(
      `${BASE}/api/entities/${entityId}/accounting/periods/integrity?year=${year}&month=${month}`,
      { headers: h }
    ).then((r) => r.json()),
  ]);

  const gap = round2(Number(bs.totalAssets) - Number(bs.totalLiabilitiesAndEquity));
  const bsNi = round2(bs.netIncome);
  const pnlNi = round2(pnl.netIncome);
  const niDiff = round2(bsNi - pnlNi);

  const plugs = ['1999', '2999', '3020', '3900', '3995', '1100', '1020', '1021'];
  const all = [...(bs.assets || []), ...(bs.liabilities || []), ...(bs.equity || [])];
  const plugBalances = Object.fromEntries(
    plugs.map((n) => [n, round2(all.find((a) => a.accountNumber === n)?.amount ?? 0)])
  );
  const plugsClean = Object.values(plugBalances).every((v) => Math.abs(v) < 0.005);

  const gates = [
    { id: 'tb_balanced', pass: tb.isBalanced === true, detail: `debit=${tb.totals?.debit} credit=${tb.totals?.credit}` },
    { id: 'bs_equation', pass: Math.abs(gap) < 0.005, detail: `gap=${gap}` },
    {
      id: 'net_income_tieout',
      pass: Math.abs(niDiff) < 0.005,
      detail: `bsNi=${bsNi} pnlYtd=${pnlNi} diff=${niDiff} window=${yearStart}..${asOf}`,
    },
    {
      id: 'prior_year_pl_closed',
      pass: integrity.netIncomeTieoutOk !== false,
      detail: `netIncomeTieoutOk=${integrity.netIncomeTieoutOk} priorYearPnl=${integrity.netIncomeTieout?.priorYearPnl}`,
    },
    { id: 'plugs_zero', pass: plugsClean, detail: JSON.stringify(plugBalances) },
    {
      id: 'plugs_or_rollups_ok',
      pass: integrity.plugsOrRollupsOk !== false,
      detail: `plugsOrRollupsOk=${integrity.plugsOrRollupsOk}`,
    },
    {
      id: 'books_eq_statement',
      pass: !(integrity.accounts || []).some((a) => a.issue?.code === 'BOOK_NE_STATEMENT'),
      detail:
        (integrity.accounts || [])
          .filter((a) => a.issue)
          .map((a) => `${a.accountNumber}:${a.issue.code}`)
          .join(',') || 'ok',
    },
    {
      id: 'integrity',
      pass: requireClosed ? integrity.isClosed === true : integrity.canClose !== false,
      detail: `isClosed=${integrity.isClosed} canClose=${integrity.canClose} blockers=${JSON.stringify(integrity.blockers || [])}`,
    },
  ];

  const failed = gates.filter((g) => !g.pass);
  const report = {
    entityId,
    asOf,
    yearStart,
    requireClosed,
    gates,
    pass: failed.length === 0,
    failed: failed.map((g) => g.id),
    cash: {
      1000: pick(bs, 'assets', '1000'),
      1001: pick(bs, 'assets', '1001'),
      1002: pick(bs, 'assets', '1002'),
    },
  };

  console.log(JSON.stringify(report, null, 2));
  if (failed.length) {
    console.error(`FAIL: ${failed.map((g) => g.id).join(', ')}`);
    process.exit(1);
  }
  console.error('PASS: books-clean definition of done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
