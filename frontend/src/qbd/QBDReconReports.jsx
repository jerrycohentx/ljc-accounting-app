import React, { useEffect, useState, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, reconReportAPI } from '../services/api';
import { fmt, leafLabel, fmtReconDate } from './helpers';

function flattenAccounts(nodes, out) {
  (nodes || []).forEach((n) => {
    out.push(n);
    if (n.children && n.children.length) flattenAccounts(n.children, out);
  });
  return out;
}

/** Browse and download archived (closed) bank reconciliations as PDF. */
export default function QBDReconReports() {
  const { entityId, current } = useEntity();
  const { showToast } = useOutletContext() || {};
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState(null);

  useEffect(() => {
    if (!entityId) return;
    accountAPI.list(entityId)
      .then((r) => (Array.isArray(r.data) ? r.data : (r.data?.data || [])))
      .then((tree) => setAccounts(flattenAccounts(tree, []).filter((a) => a.is_active)))
      .catch(() => setAccounts([]));
  }, [entityId]);

  const load = useCallback(() => {
    if (!entityId) return;
    setLoading(true);
    reconReportAPI.list(entityId, accountId || undefined)
      .then((r) => setReports(Array.isArray(r.data?.reports) ? r.data.reports : []))
      .catch(() => setReports([]))
      .finally(() => setLoading(false));
  }, [entityId, accountId]);

  useEffect(() => { load(); }, [load]);

  const download = async (report, mode) => {
    const key = `${report.id}:${mode}`;
    setBusyKey(key);
    const fname = `Reconciliation_${(report.account_name || 'account').replace(/[^A-Za-z0-9]+/g, '_')}_${String(report.statement_date).slice(0, 10)}_${mode}.pdf`;
    try {
      await reconReportAPI.downloadPdf(report.id, mode, fname);
    } catch (e) {
      showToast && showToast('Could not generate the PDF — the report may be too large or the server is busy. Try again.');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="qbd-window">
      <div className="qbd-wtitle">📄 Reconciliation Reports{current ? ` — ${current.name}` : ''}</div>
      <div className="qbd-wbody">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <label style={{ fontWeight: 'bold' }}>Account</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} style={{ minWidth: 260, padding: '3px 6px' }}>
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.account_number} · {leafLabel(a.account_name)}</option>
            ))}
          </select>
          <button type="button" className="qbd-btn" onClick={load}>Refresh</button>
          <span style={{ color: '#5a6a7a' }}>Closed reconciliations are archived here automatically each time you finish one.</span>
        </div>

        {loading ? (
          <div className="qbd-loading">Loading reconciliations…</div>
        ) : reports.length === 0 ? (
          <div className="qbd-muted" style={{ padding: '20px 6px' }}>
            No archived reconciliations found for this {accountId ? 'account' : 'entity'} yet.
          </div>
        ) : (
          <table className="qbd-coa">
            <thead>
              <tr>
                <th>STATEMENT DATE</th>
                <th>ACCOUNT</th>
                <th className="qbd-bal">BEGINNING</th>
                <th className="qbd-bal">ENDING</th>
                <th>STATUS</th>
                <th>GENERATED</th>
                <th>PDF</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td>{fmtReconDate(r.statement_date)}</td>
                  <td>{r.account_number} · {leafLabel(r.account_name)}</td>
                  <td className="qbd-bal">{fmt(r.beginning_balance)}</td>
                  <td className="qbd-bal">{fmt(r.ending_balance)}</td>
                  <td>{r.is_closed ? '✅ Closed' : 'Open'}</td>
                  <td>{r.generated_at ? String(r.generated_at).replace('T', ' ').slice(0, 16) : ''}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button type="button" className="qbd-btn" disabled={busyKey === `${r.id}:summary`} onClick={() => download(r, 'summary')}>
                      {busyKey === `${r.id}:summary` ? '…' : 'Summary'}
                    </button>{' '}
                    <button type="button" className="qbd-btn" disabled={busyKey === `${r.id}:detail`} onClick={() => download(r, 'detail')}>
                      {busyKey === `${r.id}:detail` ? '…' : 'Detail'}
                    </button>{' '}
                    <button type="button" className="qbd-btn" disabled={busyKey === `${r.id}:both`} onClick={() => download(r, 'both')}>
                      {busyKey === `${r.id}:both` ? '…' : 'Both'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
