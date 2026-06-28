import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { reportAPI, accountAPI } from '../services/api';
import { fmt, leafLabel, todayISO } from './helpers';

function flatNums(nodes, map) {
  (nodes || []).forEach((n) => { map[n.account_number] = n.id; if (n.children) flatNums(n.children, map); });
  return map;
}
const eomPrev = (ds) => { const d = new Date(ds + 'T00:00:00'); return new Date(d.getFullYear(), d.getMonth(), 0).toISOString().slice(0, 10); };
const somCur = (ds) => ds.slice(0, 8) + '01';

const TABS = [['bs', 'Balance Sheet'], ['pl', 'Profit & Loss'], ['tb', 'Trial Balance'], ['gl', 'General Ledger']];

export default function QBDReports() {
  const { entityId } = useEntity();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const rtype = (TABS.find((t) => t[0] === sp.get('r')) || TABS[0])[0];
  const today = todayISO();

  const [numMap, setNumMap] = useState({});
  const [asOf, setAsOf] = useState(today);
  const [from, setFrom] = useState(today.slice(0, 4) + '-01-01');
  const [to, setTo] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!entityId) return;
    accountAPI.list(entityId).then((r) => setNumMap(flatNums(Array.isArray(r.data) ? r.data : (r.data?.data || []), {}))).catch(() => {});
  }, [entityId]);

  const fetchReport = useCallback(() => {
    if (!entityId) return;
    setLoading(true);
    let p;
    if (rtype === 'bs') p = reportAPI.balanceSheet(entityId, asOf);
    else if (rtype === 'pl') p = reportAPI.incomeStatement(entityId, from, to);
    else if (rtype === 'tb') p = reportAPI.trialBalance(entityId, asOf);
    else p = reportAPI.ledgerAll(entityId, from, to);
    p.then((r) => setData(r.data)).catch(() => setData(null)).finally(() => setLoading(false));
  }, [entityId, rtype, asOf, from, to]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  const zoomByNumber = (accountNumber, range) => { const id = numMap[accountNumber]; if (id) nav('/register/' + id + (range ? `?from=${from}&to=${to}` : `?to=${asOf}`)); };
  const zoomById = (id, range) => { if (id) nav('/register/' + id + (range ? `?from=${from}&to=${to}` : `?to=${asOf}`)); };

  const usesAsOf = rtype === 'bs' || rtype === 'tb';
  const title = { bs: '📊 Balance Sheet', pl: '📈 Profit & Loss', tb: '⚖️ Trial Balance', gl: '📒 General Ledger' }[rtype];

  return (
    <div className="qbd-window">
      <div className="qbd-wtitle">{title}</div>
      <div className="qbd-tools">
        {TABS.map(([id, label]) => (
          <button key={id} className="qbd-btn" style={rtype === id ? { background: '#cfe2fb', fontWeight: 'bold' } : {}} onClick={() => setSp({ r: id })}>{label}</button>
        ))}
        <span style={{ width: 12 }} />
        {usesAsOf ? (
          <>
            <span className="qbd-muted">Dates</span>
            <select onChange={(e) => { const v = e.target.value; if (v === 'today') setAsOf(today); else if (v === 'eolm') setAsOf(eomPrev(today)); else if (v === 'eoly') setAsOf((+today.slice(0, 4) - 1) + '-12-31'); }}>
              <option value="today">Today ({today})</option>
              <option value="eolm">End of last month</option>
              <option value="eoly">End of last year</option>
              <option value="custom">Custom…</option>
            </select>
            <span className="qbd-muted">As of</span>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </>
        ) : (
          <>
            <span className="qbd-muted">Dates</span>
            <select onChange={(e) => { const v = e.target.value; if (v === 'fy') { setFrom(today.slice(0, 4) + '-01-01'); setTo(today); } else if (v === 'lm') { setFrom(somCur(eomPrev(today))); setTo(eomPrev(today)); } else if (v === 'all') { setFrom('2000-01-01'); setTo(today); } }}>
              <option value="fy">This Fiscal Year</option>
              <option value="lm">Last Month</option>
              <option value="all">All Dates</option>
              <option value="custom">Custom…</option>
            </select>
            <span className="qbd-muted">From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span className="qbd-muted">To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </>
        )}
      </div>
      <div className="qbd-wbody">
        {loading ? <div className="qbd-loading">Loading…</div> : !data ? <div className="qbd-empty">No data.</div> : (
          <>
            <div className="qbd-rpt-hint">Click any account name or amount to open its register.</div>
            {rtype === 'bs' ? <BS data={data} zoom={zoomByNumber} />
              : rtype === 'pl' ? <PL data={data} zoom={zoomByNumber} />
                : rtype === 'tb' ? <TB data={data} zoom={zoomById} />
                  : <GL data={data} zoom={zoomById} from={from} to={to} />}
          </>
        )}
      </div>
    </div>
  );
}

function lineRow(item, zoom, range) {
  const openRegister = () => zoom(item.accountNumber, range);
  return (
    <tr key={item.accountNumber} className="qbd-rpt-row" onClick={openRegister} title="Click to open account register">
      <td className="ind">{leafLabel(item.accountName)}</td>
      <td className={'ramt qbd-drill' + (item.amount < 0 ? ' qbd-neg' : '')}>{fmt(item.amount)}</td>
    </tr>
  );
}

function BS({ data, zoom }) {
  return (
    <div className="qbd-rpt"><h2>Balance Sheet</h2><div className="sub">As of {data.asOfDate}</div>
      <table><tbody>
        <tr><td className="sec">ASSETS</td><td /></tr>{(data.assets || []).map((a) => lineRow(a, zoom, false))}
        <tr className="tot"><td>Total Assets</td><td className="ramt">{fmt(data.totalAssets)}</td></tr>
        <tr><td className="sec">LIABILITIES</td><td /></tr>{(data.liabilities || []).map((a) => lineRow(a, zoom, false))}
        <tr className="tot"><td>Total Liabilities</td><td className="ramt">{fmt(data.totalLiabilities)}</td></tr>
        <tr><td className="sec">EQUITY</td><td /></tr>{(data.equity || []).map((a) => lineRow(a, zoom, false))}
        <tr className="tot"><td>Total Equity</td><td className="ramt">{fmt(data.totalEquity)}</td></tr>
        <tr className="grand"><td>Total Liabilities &amp; Equity</td><td className="ramt">{fmt(data.totalLiabilitiesAndEquity)}</td></tr>
      </tbody></table>
    </div>
  );
}

function PL({ data, zoom }) {
  return (
    <div className="qbd-rpt"><h2>Profit &amp; Loss</h2><div className="sub">{data.period?.startDate} to {data.period?.endDate}</div>
      <table><tbody>
        <tr><td className="sec">INCOME</td><td /></tr>{(data.revenues || []).map((a) => lineRow(a, zoom, true))}
        <tr className="tot"><td>Total Income</td><td className="ramt">{fmt(data.totalRevenue)}</td></tr>
        <tr><td className="sec">EXPENSES</td><td /></tr>{(data.expenses || []).map((a) => lineRow(a, zoom, true))}
        <tr className="tot"><td>Total Expenses</td><td className="ramt">{fmt(data.totalExpense)}</td></tr>
        <tr className="grand"><td>Net Income</td><td className={'ramt' + (data.netIncome < 0 ? ' qbd-neg' : '')}>{fmt(data.netIncome)}</td></tr>
      </tbody></table>
    </div>
  );
}

function TB({ data, zoom }) {
  return (
    <div className="qbd-rpt" style={{ maxWidth: 640 }}><h2>Trial Balance</h2><div className="sub">As of {data.asOfDate}</div>
      <table className="qbd-coa"><thead><tr><th>ACCOUNT</th><th className="qbd-bal">DEBIT</th><th className="qbd-bal">CREDIT</th></tr></thead>
        <tbody>
          {(data.rows || []).map((r) => (
            <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => zoom(r.id, false)}>
              <td>{r.accountNumber} · {leafLabel(r.accountName)}</td>
              <td className="qbd-bal">{r.debit ? fmt(r.debit) : ''}</td>
              <td className="qbd-bal">{r.credit ? fmt(r.credit) : ''}</td>
            </tr>
          ))}
          <tr style={{ fontWeight: 'bold', borderTop: '2px solid #36506f' }}>
            <td style={{ textAlign: 'right' }}>TOTAL</td>
            <td className="qbd-bal">{fmt(data.totalDebit)}</td>
            <td className="qbd-bal">{fmt(data.totalCredit)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function GL({ data, zoom, from, to }) {
  const rows = data.data || [];
  return (
    <div style={{ padding: 4 }}>
      <div className="sub" style={{ textAlign: 'center', color: '#6a7889', padding: '8px 0' }}>General Ledger · {from} to {to} · {rows.length} lines</div>
      <table className="qbd-reg">
        <thead><tr><th className="qbd-d">DATE</th><th className="qbd-je">ENTRY</th><th>ACCOUNT</th><th>MEMO</th><th className="qbd-amt">DEBIT</th><th className="qbd-amt">CREDIT</th></tr></thead>
        <tbody>
          {rows.length === 0 ? <tr><td colSpan={6}><div className="qbd-empty">No transactions in this period.</div></td></tr> :
            rows.map((e) => (
              <tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => zoom(e.account_id, true)} title="Open account register">
                <td className="qbd-d">{e.posting_date}</td>
                <td className="qbd-je">{e.je_number}</td>
                <td>{e.account_number} · {leafLabel(e.account_name)}</td>
                <td>{e.je_description || e.description || ''}</td>
                <td className="qbd-amt">{(+e.debit) ? fmt(+e.debit) : ''}</td>
                <td className="qbd-amt">{(+e.credit) ? fmt(+e.credit) : ''}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
