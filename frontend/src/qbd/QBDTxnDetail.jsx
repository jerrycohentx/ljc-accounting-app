import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { reportAPI } from '../services/api';
import { fmt, leafLabel, fmtShortDate } from './helpers';

/**
 * QuickBooks "Transaction Detail By Account" — opened by drilling any aggregate
 * number on the Balance Sheet or Profit & Loss (a section total, a subtotal, or
 * Net Income). Shows the posted transactions behind the figure, grouped by
 * account with a running balance and per-account subtotal, and a grand total
 * that foots to the number that was clicked.
 */
export default function QBDTxnDetail() {
  const { entityId } = useEntity();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const params = {
    accountNumbers: sp.get('accountNumbers') || undefined,
    accountTypes: sp.get('accountTypes') || undefined,
    net: sp.get('net') || undefined,
    mode: sp.get('mode') || 'range',
    asOfDate: sp.get('asOfDate') || undefined,
    startDate: sp.get('startDate') || undefined,
    endDate: sp.get('endDate') || undefined,
    title: sp.get('title') || undefined,
  };

  useEffect(() => {
    if (!entityId) return;
    setLoading(true);
    reportAPI.transactionDetail(entityId, params)
      .then((r) => setData(r.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, sp]);

  const periodText = params.mode === 'asof'
    ? `As of ${params.asOfDate}`
    : `${params.startDate} through ${params.endDate}`;

  const openAcct = (accountId) => {
    const q = params.mode === 'asof' ? `?to=${params.asOfDate}` : `?from=${params.startDate}&to=${params.endDate}`;
    nav(`/register/${accountId}${q}`);
  };

  return (
    <div className="qbd-window">
      <div className="qbd-wtitle">{params.title || 'Transaction Detail'}</div>
      <div className="qbd-tools">
        <button className="qbd-btn" onClick={() => nav(-1)}>← Back</button>
        <span className="qbd-muted" style={{ marginLeft: 8 }}>{periodText}</span>
      </div>
      <div className="qbd-wbody">
        {loading ? <div className="qbd-loading">Loading…</div>
          : !data ? <div className="qbd-empty">No data.</div>
            : (data.groups || []).length === 0 ? <div className="qbd-empty">No transactions behind this number.</div>
              : (
                <div className="qbd-rpt">
                  <h2>{data.title}</h2>
                  <div className="sub">{periodText} · {data.count} transaction(s)</div>
                  <table className="qbd-reg">
                    <thead>
                      <tr>
                        <th className="qbd-d">DATE</th>
                        <th className="qbd-je">ENTRY</th>
                        <th>NAME / MEMO</th>
                        <th className="qbd-amt">AMOUNT</th>
                        <th className="qbd-amt">BALANCE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data.groups || []).map((g) => (
                        <React.Fragment key={g.accountId}>
                          <tr className="qbd-txd-acct" style={{ cursor: 'pointer' }} onClick={() => openAcct(g.accountId)} title="Open account register">
                            <td colSpan={5} style={{ fontWeight: 'bold', paddingTop: 8 }}>{g.accountNumber} · {leafLabel(g.accountName)}</td>
                          </tr>
                          {g.lines.map((l, i) => (
                            <tr key={i}>
                              <td className="qbd-d">{fmtShortDate(l.date)}</td>
                              <td className="qbd-je">{l.jeNumber}</td>
                              <td>{l.name}</td>
                              <td className={'qbd-amt' + (l.amount < 0 ? ' qbd-neg' : '')}>{fmt(l.amount)}</td>
                              <td className={'qbd-amt' + (l.balance < 0 ? ' qbd-neg' : '')}>{fmt(l.balance)}</td>
                            </tr>
                          ))}
                          <tr style={{ fontWeight: 'bold' }}>
                            <td colSpan={3} style={{ textAlign: 'right', borderTop: '1px solid #000' }}>Total {leafLabel(g.accountName)}</td>
                            <td className={'qbd-amt' + (g.total < 0 ? ' qbd-neg' : '')} style={{ borderTop: '1px solid #000' }}>{fmt(g.total)}</td>
                            <td style={{ borderTop: '1px solid #000' }} />
                          </tr>
                        </React.Fragment>
                      ))}
                      <tr style={{ fontWeight: 'bold' }}>
                        <td colSpan={3} style={{ textAlign: 'right', borderTop: '1px solid #000', borderBottom: '3px double #000' }}>TOTAL</td>
                        <td className={'qbd-amt' + (data.grandTotal < 0 ? ' qbd-neg' : '')} style={{ borderTop: '1px solid #000', borderBottom: '3px double #000' }}>{fmt(data.grandTotal)}</td>
                        <td style={{ borderTop: '1px solid #000', borderBottom: '3px double #000' }} />
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
      </div>
    </div>
  );
}
