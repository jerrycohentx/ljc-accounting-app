import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { reconReportAPI } from '../services/api';
import { fmt, leafLabel, fmtReconDate } from './helpers';

/** Full-screen in-app PDF preview (view without downloading). */
function ReconPdfPreviewModal({ title, pdfUrl, busy, onClose, onDownload, onModeChange, mode }) {
  return (
    <div className="qbd-modal-backdrop" onClick={onClose}>
      <div
        className="qbd-window"
        style={{
          width: 'min(1100px, 96vw)',
          height: 'min(90vh, 920px)',
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="qbd-wtitle">
          {title}
          <span className="x" onClick={onClose}>✕</span>
        </div>
        <div className="qbd-tools" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span className="qbd-muted">View</span>
          {['summary', 'detail', 'both'].map((m) => (
            <button
              key={m}
              type="button"
              className="qbd-btn"
              disabled={busy || mode === m}
              style={{ fontWeight: mode === m ? 'bold' : 'normal', background: mode === m ? '#dce8f5' : undefined }}
              onClick={() => onModeChange(m)}
            >
              {m === 'both' ? 'Both' : m === 'summary' ? 'Summary' : 'Detail'}
            </button>
          ))}
          <span className="sp" />
          <button type="button" className="qbd-btn" disabled={busy || !pdfUrl} onClick={onDownload}>
            Export PDF
          </button>
          <button type="button" className="qbd-btn" style={{ fontWeight: 'bold' }} onClick={onClose}>
            Close
          </button>
        </div>
        <div className="qbd-wbody" style={{ flex: 1, minHeight: 0, padding: 0, background: '#525659' }}>
          {busy && !pdfUrl ? (
            <div className="qbd-loading" style={{ color: '#fff', padding: 40 }}>Preparing reconciliation preview…</div>
          ) : pdfUrl ? (
            <iframe
              title="Reconciliation preview"
              src={pdfUrl}
              style={{ width: '100%', height: '100%', border: 0, background: '#525659' }}
            />
          ) : (
            <div className="qbd-muted" style={{ color: '#fff', padding: 40 }}>No preview available.</div>
          )}
        </div>
      </div>
    </div>
  );
}

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
  const [preview, setPreview] = useState(null); // { report, mode, url }

  const load = useCallback(() => {
    if (!entityId) return;
    setLoading(true);
    reconReportAPI.list(entityId)
      .then((r) => setReports(Array.isArray(r.data?.reports) ? r.data.reports : []))
      .catch(() => setReports([]))
      .finally(() => setLoading(false));
  }, [entityId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
  }, [preview?.url]);

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

  const fileNameFor = (report, mode) => {
    const bank = (report.bankLabel || report.account_name || 'account').replace(/[^A-Za-z0-9]+/g, '_');
    const sd = String(report.statement_date).slice(0, 10);
    return `Reconciliation_${bank}_${sd}_${mode}.pdf`;
  };

  const openPreview = async (report, mode = 'both') => {
    const key = `${report.id}:preview:${mode}`;
    setBusyKey(key);
    setPreview({ report, mode, url: null });
    try {
      const blob = await reconReportAPI.fetchPdfBlob(report.id, mode);
      const url = URL.createObjectURL(blob);
      setPreview((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url);
        return { report, mode, url };
      });
    } catch (e) {
      setPreview(null);
      showToast && showToast('Could not open the preview — try again in a moment.');
    } finally {
      setBusyKey(null);
    }
  };

  const changePreviewMode = async (mode) => {
    if (!preview?.report || preview.mode === mode) return;
    await openPreview(preview.report, mode);
  };

  const download = async (report, mode) => {
    const key = `${report.id}:dl:${mode}`;
    setBusyKey(key);
    try {
      await reconReportAPI.downloadPdf(report.id, mode, fileNameFor(report, mode));
    } catch (e) {
      showToast && showToast('Could not generate the PDF — try again in a moment.');
    } finally {
      setBusyKey(null);
    }
  };

  const closePreview = () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview(null);
  };

  return (
    <div className="qbd-window">
      <div className="qbd-wtitle">📄 Reconciliation Reports{current ? ` — ${current.name}` : ''}</div>
      <div className="qbd-wbody">
        <div style={{ color: '#5a6a7a', marginBottom: 12, fontSize: 13 }}>
          Organized like your bank folders: <strong>Bank → Year → reconciliations</strong>.
          Click <strong>Preview</strong> to view on screen, or Export to download the PDF.
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
                    <th>ACTIONS</th>
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
                        <button
                          type="button"
                          className="qbd-btn"
                          style={{ fontWeight: 'bold' }}
                          disabled={!!busyKey}
                          onClick={() => openPreview(r, 'both')}
                        >
                          {busyKey === `${r.id}:preview:both` || busyKey === `${r.id}:preview:summary` || busyKey === `${r.id}:preview:detail`
                            ? '…'
                            : 'Preview'}
                        </button>{' '}
                        <button type="button" className="qbd-btn" disabled={!!busyKey} onClick={() => download(r, 'both')}>
                          {busyKey === `${r.id}:dl:both` ? '…' : 'Export'}
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

      {preview && (
        <ReconPdfPreviewModal
          title={`Reconciliation Preview — ${preview.report.account_number} · ${fmtReconDate(preview.report.statement_date)}`}
          pdfUrl={preview.url}
          busy={!!busyKey}
          mode={preview.mode}
          onClose={closePreview}
          onModeChange={changePreviewMode}
          onDownload={() => download(preview.report, preview.mode)}
        />
      )}
    </div>
  );
}
