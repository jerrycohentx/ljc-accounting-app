import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { reconReportAPI } from '../services/api';
import { fmt, leafLabel, fmtReconDate } from './helpers';

function LineTable({ title, rows, paymentsLabel }) {
  const list = rows || [];
  if (!list.length) return null;
  const total = list.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return (
    <div className="qbd-recon-rep-section">
      <div className="qbd-recon-rep-h">{title} ({list.length})</div>
      <table className="qbd-reg">
        <thead>
          <tr>
            <th className="qbd-d">DATE</th>
            <th>TYPE</th>
            <th>MEMO</th>
            <th className="qbd-amt">AMOUNT</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.glId || `${r.date}-${r.amount}-${r.description}`}>
              <td className="qbd-d">{fmtReconDate(r.date)}</td>
              <td>{r.type || ''}</td>
              <td>{r.description || r.name || ''}</td>
              <td className="qbd-amt">{fmt(r.amount)}</td>
            </tr>
          ))}
          <tr style={{ fontWeight: 'bold', background: '#eef4fb' }}>
            <td colSpan={3}>Total {paymentsLabel || title}</td>
            <td className="qbd-amt">{fmt(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Instant HTML preview from archived report JSON (no Playwright wait). */
function ReconHtmlPreviewModal({ title, full, mode, busy, exportBusy, onClose, onModeChange, onExport }) {
  const summary = full?.summary || {};
  const detail = full?.detail || {};
  const pl = summary.paymentsLabel || detail.paymentsLabel || 'Checks and Payments';
  const dl = summary.depositsLabel || detail.depositsLabel || 'Deposits and Credits';
  const showSummary = mode === 'summary' || mode === 'both';
  const showDetail = mode === 'detail' || mode === 'both';
  const cleared = detail.cleared || {};
  const uncleared = detail.uncleared || {};

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
              disabled={busy}
              style={{ fontWeight: mode === m ? 'bold' : 'normal', background: mode === m ? '#dce8f5' : undefined }}
              onClick={() => onModeChange(m)}
            >
              {m === 'both' ? 'Both' : m === 'summary' ? 'Summary' : 'Detail'}
            </button>
          ))}
          <span className="sp" />
          <button type="button" className="qbd-btn" disabled={exportBusy || !full} onClick={onExport}>
            {exportBusy ? 'Building PDF…' : 'Export PDF'}
          </button>
          <button type="button" className="qbd-btn" style={{ fontWeight: 'bold' }} onClick={onClose}>
            Close
          </button>
        </div>
        <div className="qbd-recon-rep-body" style={{ flex: 1, minHeight: 0 }}>
          {busy && !full ? (
            <div className="qbd-loading">Loading reconciliation…</div>
          ) : !full ? (
            <div className="qbd-muted">No preview available.</div>
          ) : (
            <>
              <div className="qbd-recon-rep-title">
                <div>
                  <strong>
                    {full.account_number} · {leafLabel(full.account_name)}
                  </strong>
                </div>
                <div className="qbd-muted">
                  Period ending {fmtReconDate(full.statement_date)}
                  {full.is_closed ? ' · Closed' : ' · Open'}
                </div>
              </div>

              {showSummary && (
                <div className="qbd-recon-rep-summary">
                  <div className="sum-row"><span>Beginning Balance</span><span>{fmt(summary.beginningBalance)}</span></div>
                  <div className="sum-row">
                    <span>{pl} cleared ({summary.cleared?.paymentsCount || 0})</span>
                    <span>{fmt(summary.cleared?.paymentsTotal)}</span>
                  </div>
                  <div className="sum-row">
                    <span>{dl} cleared ({summary.cleared?.depositsCount || 0})</span>
                    <span>{fmt(summary.cleared?.depositsTotal)}</span>
                  </div>
                  <div className="sum-row sum-total"><span>Cleared Balance</span><span>{fmt(summary.clearedBalance)}</span></div>
                  {(summary.uncleared?.paymentsCount || 0) + (summary.uncleared?.depositsCount || 0) > 0 && (
                    <>
                      <div className="sum-row">
                        <span>Uncleared {pl} ({summary.uncleared?.paymentsCount || 0})</span>
                        <span>{fmt(summary.uncleared?.paymentsTotal)}</span>
                      </div>
                      <div className="sum-row">
                        <span>Uncleared {dl} ({summary.uncleared?.depositsCount || 0})</span>
                        <span>{fmt(summary.uncleared?.depositsTotal)}</span>
                      </div>
                      <div className="sum-row sum-total">
                        <span>Register as of statement</span>
                        <span>{fmt(summary.registerBalance)}</span>
                      </div>
                    </>
                  )}
                  <div className="sum-row sum-total"><span>Ending Balance</span><span>{fmt(summary.endingBalance)}</span></div>
                  {summary.statementEndingBalance != null && (
                    <div className="sum-row">
                      <span>Statement Ending</span>
                      <span>{fmt(summary.statementEndingBalance)}</span>
                    </div>
                  )}
                </div>
              )}

              {showDetail && (
                <>
                  <div className="qbd-recon-rep-h">Cleared Transactions</div>
                  <LineTable title={pl} rows={cleared.payments} paymentsLabel={pl} />
                  <LineTable title={dl} rows={cleared.deposits} paymentsLabel={dl} />
                  <div className="qbd-recon-rep-h" style={{ marginTop: 12 }}>Uncleared Transactions</div>
                  <LineTable title={pl} rows={uncleared.payments} paymentsLabel={pl} />
                  <LineTable title={dl} rows={uncleared.deposits} paymentsLabel={dl} />
                  {!(uncleared.payments || []).length && !(uncleared.deposits || []).length && (
                    <div className="qbd-muted" style={{ padding: '4px 0' }}>None</div>
                  )}
                </>
              )}
            </>
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
  const [preview, setPreview] = useState(null); // { report, mode, full }
  const [exportBusy, setExportBusy] = useState(false);

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

  const fileNameFor = (report, mode) => {
    const bank = (report.bankLabel || report.account_name || 'account').replace(/[^A-Za-z0-9]+/g, '_');
    const sd = String(report.statement_date).slice(0, 10);
    return `Reconciliation_${bank}_${sd}_${mode}.pdf`;
  };

  const openPreview = async (report, mode = 'both') => {
    setBusyKey(`${report.id}:preview`);
    setPreview({ report, mode, full: null });
    try {
      const r = await reconReportAPI.get(report.id);
      const full = r.data?.report || r.data;
      if (!full) throw new Error('Report not found');
      setPreview({ report, mode, full });
    } catch (e) {
      setPreview(null);
      showToast && showToast('Could not open the preview — try again in a moment.');
    } finally {
      setBusyKey(null);
    }
  };

  const download = async (report, mode) => {
    setExportBusy(true);
    setBusyKey(`${report.id}:dl:${mode}`);
    try {
      await reconReportAPI.downloadPdf(report.id, mode, fileNameFor(report, mode));
      showToast && showToast('PDF downloaded.');
    } catch (e) {
      showToast && showToast('Could not generate the PDF — try again in a moment.');
    } finally {
      setExportBusy(false);
      setBusyKey(null);
    }
  };

  return (
    <div className="qbd-window">
      <div className="qbd-wtitle">📄 Reconciliation Reports{current ? ` — ${current.name}` : ''}</div>
      <div className="qbd-wbody">
        <div style={{ color: '#5a6a7a', marginBottom: 12, fontSize: 13 }}>
          Organized like your bank folders: <strong>Bank → Year → reconciliations</strong>.
          <strong> Preview</strong> opens instantly on screen; <strong>Export</strong> builds the PDF file.
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
                          {busyKey === `${r.id}:preview` ? '…' : 'Preview'}
                        </button>{' '}
                        <button type="button" className="qbd-btn" disabled={!!busyKey || exportBusy} onClick={() => download(r, 'both')}>
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
        <ReconHtmlPreviewModal
          title={`Reconciliation Preview — ${preview.report.account_number} · ${fmtReconDate(preview.report.statement_date)}`}
          full={preview.full}
          mode={preview.mode}
          busy={!!busyKey}
          exportBusy={exportBusy}
          onClose={() => setPreview(null)}
          onModeChange={(m) => setPreview((p) => (p ? { ...p, mode: m } : p))}
          onExport={() => download(preview.report, preview.mode)}
        />
      )}
    </div>
  );
}
