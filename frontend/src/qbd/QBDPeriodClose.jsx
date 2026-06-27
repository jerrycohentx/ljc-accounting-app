import React, { useEffect, useState, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountingAPI } from '../services/api';
import { fmt, todayISO } from './helpers';

const SAMPLE_CSV = `account_number,balance
1000,11450.19
2010,0
3100,0`;

export default function QBDPeriodClose() {
  const { entityId } = useEntity();
  const { showToast } = useOutletContext() || {};
  const [tab, setTab] = useState('periods');
  const [periods, setPeriods] = useState([]);
  const [closeMonth, setCloseMonth] = useState(todayISO().slice(0, 7));
  const [obDate, setObDate] = useState('2026-01-01');
  const [obCsv, setObCsv] = useState(SAMPLE_CSV);
  const [obPreview, setObPreview] = useState(null);
  const [yecDate, setYecDate] = useState(`${new Date().getFullYear()}-12-31`);
  const [yecPreview, setYecPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadPeriods = useCallback(() => {
    if (!entityId) return;
    accountingAPI.listPeriods(entityId).then((r) => setPeriods(r.data.data || [])).catch(() => setPeriods([]));
  }, [entityId]);

  useEffect(() => { loadPeriods(); }, [loadPeriods]);

  const closePeriodForMonth = () => {
    const postingDate = `${closeMonth}-01`;
    setBusy(true);
    accountingAPI.closePeriod(entityId, { postingDate })
      .then(() => { showToast && showToast('Period closed'); loadPeriods(); })
      .catch((e) => showToast && showToast(e.response?.data?.error || e.message))
      .finally(() => setBusy(false));
  };

  const reopen = (p) => {
    setBusy(true);
    accountingAPI.reopenPeriod(entityId, { periodStart: p.period_start, periodEnd: p.period_end })
      .then(() => { showToast && showToast('Period reopened'); loadPeriods(); })
      .catch((e) => showToast && showToast(e.response?.data?.error || e.message))
      .finally(() => setBusy(false));
  };

  const previewOb = () => {
    setBusy(true);
    accountingAPI.previewOpeningBalances(entityId, { asOfDate: obDate, csv: obCsv })
      .then((r) => setObPreview(r.data))
      .catch((e) => showToast && showToast(e.response?.data?.error || e.message))
      .finally(() => setBusy(false));
  };

  const postOb = () => {
    if (!obPreview?.balanced) { showToast && showToast('Preview must balance first'); return; }
    setBusy(true);
    accountingAPI.postOpeningBalances(entityId, { asOfDate: obDate, csv: obCsv })
      .then((r) => { showToast && showToast(`Posted ${r.data.jeNumber}`); setObPreview(null); })
      .catch((e) => showToast && showToast(e.response?.data?.error || e.message))
      .finally(() => setBusy(false));
  };

  const previewYec = () => {
    setBusy(true);
    accountingAPI.previewYearEnd(entityId, yecDate)
      .then((r) => setYecPreview(r.data))
      .catch((e) => showToast && showToast(e.response?.data?.error || e.message))
      .finally(() => setBusy(false));
  };

  const postYec = () => {
    setBusy(true);
    accountingAPI.postYearEnd(entityId, { asOfDate: yecDate })
      .then((r) => { showToast && showToast(r.data.posted ? `Posted ${r.data.jeNumber}` : r.data.message); setYecPreview(null); })
      .catch((e) => showToast && showToast(e.response?.data?.error || e.message))
      .finally(() => setBusy(false));
  };

  const tabs = [
    ['periods', 'Period Close'],
    ['opening', 'Opening Balances'],
    ['yearend', 'Year-End Close'],
  ];

  return (
    <div className="qbd-window">
      <div className="qbd-wtitle">🔒 Closing &amp; Opening Balances</div>
      <div className="qbd-tools">
        {tabs.map(([k, label]) => (
          <button key={k} className={'qbd-btn' + (tab === k ? ' active' : '')} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      <div className="qbd-wbody">
        {tab === 'periods' && (
          <>
            <p className="qbd-muted">Close a month to block new postings into that period. Reopen requires ADMIN role.</p>
            <div className="frow" style={{ marginTop: 12 }}>
              <label>Close month</label>
              <input type="month" value={closeMonth} onChange={(e) => setCloseMonth(e.target.value)} />
              <button className="qbd-btn" disabled={busy} onClick={closePeriodForMonth} style={{ marginLeft: 12 }}>Close period</button>
            </div>
            {periods.length === 0 ? (
              <div className="qbd-empty" style={{ marginTop: 24 }}>No closed periods yet.</div>
            ) : (
              <table className="qbd-reg" style={{ marginTop: 16 }}>
                <thead><tr><th>START</th><th>END</th><th>STATUS</th><th>CLOSED</th><th /></tr></thead>
                <tbody>
                  {periods.map((p) => (
                    <tr key={p.id}>
                      <td>{p.period_start}</td>
                      <td>{p.period_end}</td>
                      <td>{p.status}</td>
                      <td>{p.closed_at ? p.closed_at.slice(0, 10) : '—'}</td>
                      <td>{p.status === 'CLOSED' && <button className="qbd-btn" disabled={busy} onClick={() => reopen(p)}>Reopen</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {tab === 'opening' && (
          <>
            <p className="qbd-muted">One-time QBO migration: paste trial balance CSV (account_number,balance). Offset posts to 3900 Opening Balance Equity.</p>
            <div className="frow"><label>As-of date</label><input type="date" value={obDate} onChange={(e) => setObDate(e.target.value)} /></div>
            <textarea rows={8} style={{ width: '100%', fontFamily: 'monospace', marginTop: 8 }} value={obCsv} onChange={(e) => setObCsv(e.target.value)} />
            <div style={{ marginTop: 12 }}>
              <button className="qbd-btn" disabled={busy} onClick={previewOb}>Preview</button>
              <button className="qbd-btn" disabled={busy || !obPreview?.balanced} onClick={postOb} style={{ marginLeft: 8 }}>Post opening balances</button>
            </div>
            {obPreview && (
              <div style={{ marginTop: 16 }}>
                {obPreview.warnings?.length > 0 && <p className="qbd-muted">{obPreview.warnings.join('; ')}</p>}
                <table className="qbd-reg">
                  <thead><tr><th>ACCOUNT</th><th className="qbd-amt">DEBIT</th><th className="qbd-amt">CREDIT</th></tr></thead>
                  <tbody>
                    {obPreview.lines.map((l, i) => (
                      <tr key={i}><td>{l.accountNumber} · {l.accountName}</td><td className="qbd-amt">{l.debit ? fmt(+l.debit) : ''}</td><td className="qbd-amt">{l.credit ? fmt(+l.credit) : ''}</td></tr>
                    ))}
                    <tr style={{ fontWeight: 'bold' }}><td>TOTAL</td><td className="qbd-amt">{fmt(+obPreview.totalDebit)}</td><td className="qbd-amt">{fmt(+obPreview.totalCredit)}</td></tr>
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {tab === 'yearend' && (
          <>
            <p className="qbd-muted">Zero revenue and expense accounts into Retained Earnings (3100) as of year-end date.</p>
            <div className="frow"><label>As-of date</label><input type="date" value={yecDate} onChange={(e) => setYecDate(e.target.value)} /></div>
            <div style={{ marginTop: 12 }}>
              <button className="qbd-btn" disabled={busy} onClick={previewYec}>Preview close</button>
              <button className="qbd-btn" disabled={busy || !yecPreview?.balanced} onClick={postYec} style={{ marginLeft: 8 }}>Post year-end close</button>
            </div>
            {yecPreview && (
              <div style={{ marginTop: 16 }}>
                <p>Net income to retained earnings: <b>{fmt(+yecPreview.netIncome)}</b> ({yecPreview.accountCount} P&amp;L accounts)</p>
                {yecPreview.closingLines.length > 0 && (
                  <table className="qbd-reg">
                    <thead><tr><th>ACCOUNT</th><th className="qbd-amt">DEBIT</th><th className="qbd-amt">CREDIT</th></tr></thead>
                    <tbody>
                      {yecPreview.closingLines.map((l, i) => (
                        <tr key={i}><td>{l.accountNumber} · {l.accountName}</td><td className="qbd-amt">{l.debit ? fmt(+l.debit) : ''}</td><td className="qbd-amt">{l.credit ? fmt(+l.credit) : ''}</td></tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
