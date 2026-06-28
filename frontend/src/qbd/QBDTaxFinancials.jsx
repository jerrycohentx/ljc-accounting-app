import React, { useEffect, useState } from 'react';
import { useEntity } from './EntityContext';
import { taxAPI } from '../services/api';
import { fmt } from './helpers';

export default function QBDTaxFinancials() {
  const { entityId, entities } = useEntity();
  const [scope, setScope] = useState('all');
  const [taxYear, setTaxYear] = useState(2025);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const req = scope === 'all'
      ? taxAPI.allEntities(taxYear)
      : taxAPI.entity(entityId, taxYear);
    req.then((r) => setData(r.data)).catch(() => setData(null)).finally(() => setLoading(false));
  }, [scope, entityId, taxYear]);

  const handleExport = () => {
    const url = scope === 'all'
      ? taxAPI.exportAllUrl(taxYear)
      : taxAPI.exportEntityUrl(entityId, taxYear);
    const filename = scope === 'all'
      ? `tax-financials-${taxYear}.csv`
      : `${entityId}-tax-${taxYear}.csv`;
    taxAPI.downloadCsv(url, filename).catch(() => alert('Unable to export tax package.'));
  };

  const packages = scope === 'all' ? (data?.entities || []) : data ? [data] : [];
  const ready = scope === 'all' ? data?.allTaxReturnReady : data?.taxReturnReady;

  return (
    <div className="qbd-window">
      <div className="qbd-wtitle">📋 Tax Year Financials</div>
      <div className="qbd-tools">
        <span className="qbd-muted">Tax year</span>
        <select value={taxYear} onChange={(e) => setTaxYear(+e.target.value)}>
          <option value={2025}>2025</option>
          <option value={2024}>2024</option>
        </select>
        <span className="qbd-muted">Scope</span>
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">All Cohen Entities</option>
          <option value="entity">Current entity only</option>
        </select>
        <button type="button" className="qbd-btn" onClick={handleExport}>Export CSV for CPA</button>
      </div>
      <div className="qbd-wbody">
        {loading ? <div className="qbd-loading">Loading tax package…</div> : !data ? (
          <div className="qbd-empty">Unable to load tax financials.</div>
        ) : (
          <>
            <div style={{ marginBottom: 16, padding: 12, background: ready ? '#e8f5e9' : '#fff3e0', borderRadius: 4 }}>
              <strong>{ready ? 'Tax-return ready' : 'Review required'}</strong>
              <span className="qbd-muted" style={{ marginLeft: 12 }}>Cash basis · Statements for CPA · Does not file returns</span>
            </div>
            {scope === 'all' && data.intercompany && (
              <p className="qbd-muted">Intercompany: {data.intercompany.allTied ? 'All pairs tied ✓' : 'Variances exist — see Period Close'}</p>
            )}
            {packages.map((pkg) => (
              <div key={pkg.entityId} style={{ marginBottom: 24 }}>
                <h3 style={{ margin: '0 0 8px' }}>{pkg.entityName}</h3>
                {!pkg.taxReturnReady && (
                  <ul>{pkg.readiness.checks.filter((c) => !c.pass).map((c) => <li key={c.id} className="qbd-neg">{c.label}</li>)}</ul>
                )}
                <table className="qbd-reg">
                  <tbody>
                    <tr><td>Net income ({pkg.taxYear})</td><td className="qbd-amt">{fmt(pkg.incomeStatement.netIncome)}</td></tr>
                    <tr><td>Total revenue</td><td className="qbd-amt">{fmt(pkg.incomeStatement.totalRevenue)}</td></tr>
                    <tr><td>Total expenses</td><td className="qbd-amt">{fmt(pkg.incomeStatement.totalExpense)}</td></tr>
                    <tr><td>Total assets (12/31)</td><td className="qbd-amt">{fmt(pkg.balanceSheet.totalAssets)}</td></tr>
                    <tr><td>Trial balance</td><td>{pkg.trialBalance.isBalanced ? 'Balanced ✓' : 'Out of balance'}</td></tr>
                  </tbody>
                </table>
                {pkg.payrollSummary?.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <strong>Payroll (Graceful Meadows)</strong>
                    <table className="qbd-reg"><tbody>
                      {pkg.payrollSummary.map((p) => (
                        <tr key={p.accountNumber}><td>{p.accountName}</td><td className="qbd-amt">{fmt(p.amount)}</td></tr>
                      ))}
                    </tbody></table>
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
