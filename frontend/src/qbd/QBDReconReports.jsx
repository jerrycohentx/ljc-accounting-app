import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { reconReportAPI } from '../services/api';
import { fmt, leafLabel, fmtReconDate } from './helpers';

/**
 * Browse archived reconciliations like Jerry's bank folders:
 *   Bank → Year → reconciliations
 */
export default function QBDReconReports() {
  const { entityId, current } = useEntity();
  const { showToast } = useOutletContext() || {};
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState(null);
  const [bankKey, setBankKey] = useState('');
  const [yearKey, setYearKey] = useState('');

  const load = useCallback(() => {
    if (!entityId) return;
    setLoading(true);
    reconReportAPI.list(entityId)
      .then((r) => setReports(Array.isArray(r.data?.reports) ? r.data.reports : []))
      .catch(() => setReports([]))
      .finally(() => setLoading(false));
  }, [entityId]);

  useEffect(() => { load(); }, [load]);

  const banks = useMemo(() => {
    const map = new Map();
    for (const r of reports) {
      const key = r.bankLabel || r.bankFolder || `${r.account_number} · ${leafLabel(r.account_name)}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          label: key,
          accountNumber: r.account_number,
          years: new Map(),
        });
      }
      const bank = map.get(key);
      const year = String(r.year || String(r.statement_date).slice(0, 4));
      if (!bank.years.has(year)) bank.years.set(year, []);
      bank.years.get(year).push(r);
    }
    return [...map.values()].sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }, [reports]);

  useEffect(() => {
    if (!banks.length) {
      setBankKey('');
      setYearKey('');
      return;
    }
    if (!bankKey || !banks.some((b) => b.key === bankKey)) {
      setBankKey(banks[0].key);
    }
  }, [banks, bankKey]);

  const selectedBank = banks.find((b) => b.key === bankKey) || null;
  const years = selectedBank
    ? [...selectedBank.years.keys()].sort((a, b) => b.localeCompare(a))
    : [];

  useEffect(() => {
    if (!years.length) {
      setYearKey('');
      return;
    }
    if (!yearKey || !years.includes(yearKey)) {
      setYearKey(years[0]);
    }
  }, [years, yearKey]);

  const yearReports = selectedBank && yearKey
    ? (selectedBank.years.get(yearKey) || []).slice().sort((a, b) =>
      String(b.statement_date).localeCompare(String(a.statement_date))
    )
    : [];

  const download = async (report, mode) => {
    const key = `${report.id}:${mode}`;
    setBusyKey(key);
    const bank = (report.bankLabel || report.account_name || 'account').replace(/[^A-Za-z0-9]+/g, '_');
    const sd = String(report.statement_date).slice(0, 10);
    const fname = `Reconciliation_${bank}_${sd}_${mode}.pdf`;
    try {
      await reconReportAPI.downloadPdf(report.id, mode, fname);
    } catch (e) {
      showToast && showToast('Could not generate the PDF — try again in a moment.');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="qbd-window">
      <div className="qbd-wtitle">📄 Reconciliation Reports{current ? ` — ${current.name}` : ''}</div>
      <div className="qbd-wbody">
        <div style={{ color: '#5a6a7a', marginBottom: 12, fontSize: 13 }}>
          Organized like your bank folders: <strong>Bank → Year → reconciliations</strong>.
          One report per statement period (drafts and duplicates are cleaned up).
        </div>

        {loading ? (
          <div className="qbd-loading">Loading reconciliations…</div>
        ) : banks.length === 0 ? (
          <div className="qbd-muted" style={{ padding: '20px 6px' }}>
            No archived reconciliations yet. They appear here when a bank/card recon is closed.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '220px 120px 1fr', gap: 12, minHeight: 360 }}>
            <div style={{ border: '1px solid #c5d0da', background: '#f7f9fb', padding: 8 }}>
              <div style={{ fontWeight: 'bold', marginBottom: 6, fontSize: 12, color: '#3a4a5a' }}>BANKS</div>
              {banks.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  className="qbd-btn"
                  onClick={() => setBankKey(b.key)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    marginBottom: 4,
                    background: b.key === bankKey ? '#dce8f5' : undefined,
                    fontWeight: b.key === bankKey ? 'bold' : 'normal',
                  }}
                >
                  📁 {b.label}
                </button>
              ))}
            </div>

            <div style={{ border: '1px solid #c5d0da', background: '#f7f9fb', padding: 8 }}>
              <div style={{ fontWeight: 'bold', marginBottom: 6, fontSize: 12, color: '#3a4a5a' }}>YEAR</div>
              {years.map((y) => (
                <button
                  key={y}
                  type="button"
                  className="qbd-btn"
                  onClick={() => setYearKey(y)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    marginBottom: 4,
                    background: y === yearKey ? '#dce8f5' : undefined,
                    fontWeight: y === yearKey ? 'bold' : 'normal',
                  }}
                >
                  📁 {y}
                </button>
              ))}
            </div>

            <div style={{ border: '1px solid #c5d0da', padding: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontWeight: 'bold', fontSize: 13 }}>
                  {selectedBank?.label} · {yearKey} · reconciliations
                </div>
                <button type="button" className="qbd-btn" onClick={load}>Refresh</button>
              </div>
              <table className="qbd-coa">
                <thead>
                  <tr>
                    <th>STATEMENT DATE</th>
                    <th>ACCOUNT</th>
                    <th className="qbd-bal">BEGINNING</th>
                    <th className="qbd-bal">STATEMENT ENDING</th>
                    <th>STATUS</th>
                    <th>PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {yearReports.map((r) => (
                    <tr key={r.id}>
                      <td>{fmtReconDate(r.statement_date)}</td>
                      <td>{r.account_number} · {leafLabel(r.account_name)}</td>
                      <td className="qbd-bal">{fmt(r.beginning_balance)}</td>
                      <td className="qbd-bal">{fmt(r.ending_balance)}</td>
                      <td>{r.is_closed ? '✅ Closed' : 'Open'}</td>
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
                  {yearReports.length === 0 && (
                    <tr>
                      <td colSpan={6} className="qbd-muted">No reconciliations in this year folder yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
