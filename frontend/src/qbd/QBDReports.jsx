import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { reportAPI, accountAPI } from '../services/api';
import { fmt, leafLabel, todayISO, fmtVariance, fmtVariancePct, fmtShortDate } from './helpers';
import { DATE_PRESETS, computeRange } from './dateRangePresets';

function flatNums(nodes, map) {
  (nodes || []).forEach((n) => { map[n.account_number] = n.id; if (n.children) flatNums(n.children, map); });
  return map;
}

const eomPrev = (ds) => { const d = new Date(ds + 'T00:00:00'); return new Date(d.getFullYear(), d.getMonth(), 0).toISOString().slice(0, 10); };
const somCur = (ds) => ds.slice(0, 8) + '01';

const TABS = [
  ['bs', 'Balance Sheet'],
  ['pl', 'Profit & Loss'],
  ['kpi', 'KPI Dashboard'],
  ['tb', 'Trial Balance'],
  ['gl', 'General Ledger'],
];

const COMPARE_MODES = [
  ['none', 'None'],
  ['prior_period', 'Prior period'],
  ['prior_year', 'Same period last year'],
  ['custom', 'Custom range'],
];

function varClass(polarity, variance) {
  if (variance == null || polarity === 'neutral' || Math.abs(variance) < 0.005) return '';
  const favorable = polarity === 'higher_is_better' ? variance > 0 : polarity === 'lower_is_better' ? variance < 0 : false;
  return favorable ? 'qbd-var-fav' : 'qbd-var-unfav';
}

function CompareRow({ label, current, comparison, variance, variancePct, variancePp, polarity, onClick, bold }) {
  const isPct = variancePp != null;
  const v = variancePp ?? variance;
  return (
    <tr className={['qbd-rpt-row', bold ? 'tot' : ''].filter(Boolean).join(' ')} onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>
      <td className="ind">{label}</td>
      <td className={'ramt qbd-drill' + (current < 0 ? ' qbd-neg' : '')}>{fmt(current)}</td>
      <td className="ramt">{comparison != null ? fmt(comparison) : '—'}</td>
      <td className={`ramt ${varClass(polarity, v)}`}>{isPct ? fmtVariance(v, true) : fmtVariance(v)}</td>
      <td className={`ramt ${varClass(polarity, variancePct)}`}>{fmtVariancePct(variancePct)}</td>
    </tr>
  );
}

function KpiRow({ row }) {
  const isPct = row.format === 'percent' || row.format === 'pp';
  const fmtVal = (v) => {
    if (v == null) return row.needsData ? 'needs data' : '—';
    if (isPct) return `${v.toFixed(1)}%`;
    if (row.format === 'ratio') return v.toFixed(2);
    return fmt(v);
  };
  const gap = row.benchmarkGap;
  const gapLabel = gap != null
    ? `${gap >= 0 ? '▲' : '▼'} ${isPct ? fmtVariance(gap, true) : fmtVariance(gap)}`
    : '—';
  return (
    <tr>
      <td>{row.label}</td>
      <td className="ramt">{fmtVal(row.current)}</td>
      <td className="ramt">{fmtVal(row.comparison)}</td>
      <td className={`ramt ${varClass(row.polarity, row.variancePp ?? row.variance)}`}>
        {isPct ? fmtVariance(row.variancePp ?? row.variance, true) : fmtVariance(row.variance)}
      </td>
      <td className="ramt">
        {row.benchmarkValue != null ? (
          <>
            {fmtVal(row.benchmarkValue)}
            <span className="qbd-muted" style={{ marginLeft: 6, fontSize: 10 }}>
              ({row.benchmarkSource === 'custom' ? 'target' : 'industry'})
            </span>
          </>
        ) : '—'}
      </td>
      <td className={`ramt ${varClass(row.polarity, gap)}`}>{gapLabel}</td>
    </tr>
  );
}

export default function QBDReports() {
  const { entityId } = useEntity();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const rtype = (TABS.find((t) => t[0] === sp.get('r')) || TABS[0])[0];
  const today = todayISO();

  const [numMap, setNumMap] = useState({});
  const [segments, setSegments] = useState([]);
  const [segment, setSegment] = useState('all');
  const [compareMode, setCompareMode] = useState('none');
  const [compareFrom, setCompareFrom] = useState('');
  const [compareTo, setCompareTo] = useState('');
  const [asOf, setAsOf] = useState(today);
  const [from, setFrom] = useState(today.slice(0, 4) + '-01-01');
  const [to, setTo] = useState(today);
  const [datePreset, setDatePreset] = useState('custom');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [printBusy, setPrintBusy] = useState(false);

  useEffect(() => {
    if (!entityId) return;
    accountAPI.list(entityId).then((r) => setNumMap(flatNums(Array.isArray(r.data) ? r.data : (r.data?.data || []), {}))).catch(() => {});
    reportAPI.segments(entityId).then((r) => {
      const segs = r.data.segments || [];
      setSegments(segs);
      if (segs.length === 1) setSegment(segs[0].key);
    }).catch(() => setSegments([]));
  }, [entityId]);

  const fetchReport = useCallback(() => {
    if (!entityId) return;
    setLoading(true);
    let p;
    if (rtype === 'kpi') {
      p = reportAPI.kpiDashboard(entityId, {
        startDate: from,
        endDate: to,
        segment,
        compareMode,
        compareStart: compareMode === 'custom' ? compareFrom : undefined,
        compareEnd: compareMode === 'custom' ? compareTo : undefined,
        benchmarkMode: 'both',
      });
    } else if (rtype === 'bs' || rtype === 'pl') {
      p = reportAPI.financialStatement(entityId, {
        reportType: rtype === 'bs' ? 'balance_sheet' : 'pnl',
        asOfDate: asOf,
        startDate: from,
        endDate: to,
        compareMode,
        compareStart: compareMode === 'custom' ? compareFrom : undefined,
        compareEnd: compareMode === 'custom' ? compareTo : undefined,
      });
    } else if (rtype === 'tb') p = reportAPI.trialBalance(entityId, asOf);
    else p = reportAPI.ledgerAll(entityId, from, to);
    p.then((r) => setData(r.data)).catch(() => setData(null)).finally(() => setLoading(false));
  }, [entityId, rtype, asOf, from, to, segment, compareMode, compareFrom, compareTo]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  const zoomByNumber = (accountNumber, range) => {
    const id = numMap[accountNumber];
    if (id) nav('/register/' + id + (range ? `?from=${from}&to=${to}` : `?to=${asOf}`));
  };
  const zoomById = (id, range) => { if (id) nav('/register/' + id + (range ? `?from=${from}&to=${to}` : `?to=${asOf}`)); };

  const applyPreset = (key) => {
    setDatePreset(key);
    if (key === 'custom') return;
    const r = computeRange(key, today);
    if (!r) return;
    setFrom(r.from);
    setTo(r.to);
    setAsOf(r.to);
  };
  const markManual = (setter) => (e) => { setDatePreset('custom'); setter(e.target.value); };

  const openStatementPdf = () => {
    if (!entityId) return;
    setPrintBusy(true);
    reportAPI.financialStatementPdf(entityId, {
      reportType: rtype === 'bs' ? 'balance_sheet' : 'pnl',
      asOfDate: asOf,
      startDate: from,
      endDate: to,
      compareMode,
      compareStart: compareMode === 'custom' ? compareFrom : undefined,
      compareEnd: compareMode === 'custom' ? compareTo : undefined,
    }).catch((e) => alert('Could not open the statement PDF: ' + (e.message || e)))
      .finally(() => setPrintBusy(false));
  };

  const usesAsOf = rtype === 'bs' || rtype === 'tb';
  const showCompare = (rtype === 'bs' || rtype === 'pl' || rtype === 'kpi') && compareMode !== 'none';
  const title = {
    bs: '📊 Balance Sheet',
    pl: '📈 Profit & Loss',
    kpi: '📉 KPI Dashboard',
    tb: '⚖️ Trial Balance',
    gl: '📒 General Ledger',
  }[rtype];

  const showSegmentPicker = segments.length > 1;

  return (
    <div className="qbd-window">
      <div className="qbd-wtitle">{title}</div>
      <div className="qbd-tools" style={{ flexWrap: 'wrap', gap: 6 }}>
        {TABS.map(([id, label]) => (
          <button key={id} className="qbd-btn" style={rtype === id ? { background: '#cfe2fb', fontWeight: 'bold' } : {}} onClick={() => setSp({ r: id })}>{label}</button>
        ))}
        <span style={{ width: 8 }} />
        {showSegmentPicker && (
          <>
            <span className="qbd-muted">Segment</span>
            <select value={segment} onChange={(e) => setSegment(e.target.value)}>
              {segments.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </>
        )}
        {(rtype === 'bs' || rtype === 'pl' || rtype === 'kpi') && (
          <>
            <span className="qbd-muted">Compare to</span>
            <select value={compareMode} onChange={(e) => setCompareMode(e.target.value)}>
              {COMPARE_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {compareMode === 'custom' && (
              <>
                <input type="date" value={compareFrom} onChange={(e) => setCompareFrom(e.target.value)} />
                <input type="date" value={compareTo} onChange={(e) => setCompareTo(e.target.value)} />
              </>
            )}
          </>
        )}
        <span className="qbd-muted">Date range</span>
        <select value={datePreset} onChange={(e) => applyPreset(e.target.value)}>
          {DATE_PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {usesAsOf ? (
          <>
            <span className="qbd-muted">As of</span>
            <input type="date" value={asOf} onChange={markManual(setAsOf)} />
          </>
        ) : (
          <>
            <span className="qbd-muted">From</span><input type="date" value={from} onChange={markManual(setFrom)} />
            <span className="qbd-muted">To</span><input type="date" value={to} onChange={markManual(setTo)} />
          </>
        )}
        <button className="qbd-btn" onClick={fetchReport}>Run</button>
        {(rtype === 'bs' || rtype === 'pl') && (
          <button className="qbd-btn" disabled={printBusy} onClick={openStatementPdf} title="Open a QuickBooks-format PDF you can print or save">
            {printBusy ? 'Preparing…' : '🖨 Print (QuickBooks format)'}
          </button>
        )}
      </div>
      <div className="qbd-wbody">
        {loading ? <div className="qbd-loading">Loading…</div> : !data ? <div className="qbd-empty">No data.</div> : (
          <>
            <div className="qbd-rpt-hint">{(rtype === 'bs' || rtype === 'pl')
              ? 'Click any number to drill into the transactions behind it. Use “Print (QuickBooks format)” for a printable statement.'
              : 'Click account rows to open register. Green/red variances follow line polarity (revenue up = good, expense up = bad).'}</div>
            {(rtype === 'bs' || rtype === 'pl') ? <StatementView data={data} nav={nav} showCompare={showCompare} />
              : rtype === 'kpi' ? <KpiDashboard data={data} showCompare={showCompare} />
                : rtype === 'tb' ? <TB data={data} zoom={zoomById} />
                  : <GL data={data} zoom={zoomById} from={from} to={to} />}
          </>
        )}
      </div>
    </div>
  );
}

function compareHead(showCompare) {
  return (
    <thead>
      <tr>
        <th>Account</th>
        <th className="ramt">Current</th>
        {showCompare && <><th className="ramt">Comparison</th><th className="ramt">Variance $</th><th className="ramt">Variance %</th></>}
        {!showCompare && <th className="ramt">Amount</th>}
      </tr>
    </thead>
  );
}

function BSCompare({ data, zoom, showCompare }) {
  const cur = data.primary;
  const cmp = data.comparison;
  const section = (title, lines, cmpLines) => (
    <>
      <tr><td className="sec">{title}</td><td colSpan={showCompare ? 4 : 1} /></tr>
      {(lines || []).map((line, i) => {
        const c = cmpLines?.[i];
        if (showCompare && c) {
          return (
            <CompareRow
              key={line.accountNumber}
              label={leafLabel(line.accountName)}
              current={line.amount}
              comparison={c.comparisonAmount}
              variance={c.variance}
              variancePct={c.variancePct}
              polarity="neutral"
              onClick={() => zoom(line.accountNumber, false)}
            />
          );
        }
        return (
          <tr key={line.accountNumber} className="qbd-rpt-row" onClick={() => zoom(line.accountNumber, false)}>
            <td className="ind">{leafLabel(line.accountName)}</td>
            <td className="ramt qbd-drill">{fmt(line.amount)}</td>
          </tr>
        );
      })}
    </>
  );
  return (
    <div className="qbd-rpt">
      <h2>Balance Sheet</h2>
      <div className="sub">As of {cur.asOfDate}{data.segmentLabel ? ` · ${data.segmentLabel}` : ''}</div>
      <table>
        {compareHead(showCompare)}
        <tbody>
          {section('ASSETS', cur.assets, cmp?.assets)}
          <CompareRow label="Total Assets" current={cur.totalAssets} comparison={cmp?.totalAssets?.comparison} variance={cmp?.totalAssets?.variance} variancePct={cmp?.totalAssets?.variancePct} polarity="neutral" bold />
          {section('LIABILITIES', cur.liabilities, cmp?.liabilities)}
          <CompareRow label="Total Liabilities" current={cur.totalLiabilities} comparison={cmp?.totalLiabilities?.comparison} variance={cmp?.totalLiabilities?.variance} variancePct={cmp?.totalLiabilities?.variancePct} polarity="neutral" bold />
          {section('EQUITY', cur.equity, cmp?.equity)}
          <CompareRow label="Total Equity" current={cur.totalEquity} comparison={cmp?.totalEquity?.comparison} variance={cmp?.totalEquity?.variance} variancePct={cmp?.totalEquity?.variancePct} polarity="neutral" bold />
        </tbody>
      </table>
    </div>
  );
}

function PLCompare({ data, zoom, showCompare }) {
  const cur = data.primary;
  const cmp = data.comparison;
  const rows = (title, lines, cmpLines, polarityDefault) => (
    <>
      <tr><td className="sec">{title}</td><td colSpan={showCompare ? 4 : 1} /></tr>
      {(lines || []).map((line) => {
        const c = (cmpLines || []).find((x) => x.accountNumber === line.accountNumber);
        if (showCompare) {
          return (
            <CompareRow
              key={line.accountNumber}
              label={leafLabel(line.accountName)}
              current={line.amount}
              comparison={c?.comparisonAmount}
              variance={c?.variance}
              variancePct={c?.variancePct}
              polarity={line.polarity || polarityDefault}
              onClick={() => zoom(line.accountNumber, true)}
            />
          );
        }
        return (
          <tr key={line.accountNumber} className="qbd-rpt-row" onClick={() => zoom(line.accountNumber, true)}>
            <td className="ind">{leafLabel(line.accountName)}</td>
            <td className="ramt qbd-drill">{fmt(line.amount)}</td>
          </tr>
        );
      })}
    </>
  );
  return (
    <div className="qbd-rpt">
      <h2>Profit &amp; Loss</h2>
      <div className="sub">{cur.period?.startDate} to {cur.period?.endDate}{data.segmentLabel ? ` · ${data.segmentLabel}` : ''}</div>
      <table>
        {compareHead(showCompare)}
        <tbody>
          {rows('INCOME', cur.revenues, cmp?.revenues, 'higher_is_better')}
          <CompareRow label="Total Income" current={cur.totalRevenue} comparison={cmp?.totalRevenue?.comparison} variance={cmp?.totalRevenue?.variance} variancePct={cmp?.totalRevenue?.variancePct} polarity="higher_is_better" bold />
          {rows('EXPENSES', cur.expenses, cmp?.expenses, 'lower_is_better')}
          <CompareRow label="Total Expenses" current={cur.totalExpense} comparison={cmp?.totalExpense?.comparison} variance={cmp?.totalExpense?.variance} variancePct={cmp?.totalExpense?.variancePct} polarity="lower_is_better" bold />
          <CompareRow label="Net Income" current={cur.netIncome} comparison={cmp?.netIncome?.comparison} variance={cmp?.netIncome?.variance} variancePct={cmp?.netIncome?.variancePct} polarity="higher_is_better" bold />
        </tbody>
      </table>
    </div>
  );
}

function KpiDashboard({ data, showCompare }) {
  return (
    <div className="qbd-rpt">
      <h2>KPI Dashboard</h2>
      <div className="sub">{data.period?.start} to {data.period?.end}</div>
      {(data.groups || []).map((g) => (
        <div key={g.packKey} style={{ marginBottom: 16 }}>
          <div className="sec" style={{ padding: '8px 0 4px' }}>{g.packLabel}{g.naics ? ` (NAICS ${g.naics})` : ''}</div>
          <table>
            <thead>
              <tr>
                <th>KPI</th>
                <th className="ramt">Current</th>
                {showCompare && <th className="ramt">Comparison</th>}
                {showCompare && <th className="ramt">Variance</th>}
                <th className="ramt">Benchmark</th>
                <th className="ramt">Gap</th>
              </tr>
            </thead>
            <tbody>
              {(g.rows || []).map((row) => <KpiRow key={row.key} row={row} />)}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function TB({ data, zoom }) {
  const rows = data.entries || data.rows || [];
  const totalDebit = data.totals?.debit ?? data.totalDebit;
  const totalCredit = data.totals?.credit ?? data.totalCredit;
  return (
    <div className="qbd-rpt" style={{ maxWidth: 640 }}>
      <h2>Trial Balance</h2><div className="sub">As of {data.asOfDate}</div>
      <table className="qbd-coa">
        <thead><tr><th>ACCOUNT</th><th className="qbd-bal">DEBIT</th><th className="qbd-bal">CREDIT</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id || r.accountNumber} style={{ cursor: 'pointer' }} onClick={() => zoom(r.id, false)}>
              <td>{r.accountNumber} · {leafLabel(r.accountName)}</td>
              <td className="qbd-bal">{r.debit ? fmt(r.debit) : ''}</td>
              <td className="qbd-bal">{r.credit ? fmt(r.credit) : ''}</td>
            </tr>
          ))}
          <tr style={{ fontWeight: 'bold', borderTop: '2px solid #36506f' }}>
            <td style={{ textAlign: 'right' }}>TOTAL</td>
            <td className="qbd-bal">{fmt(totalDebit)}</td>
            <td className="qbd-bal">{fmt(totalCredit)}</td>
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
                <td className="qbd-d">{fmtShortDate(e.posting_date)}</td>
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

// "2025-03-31" -> "Mar 31, 25" (QuickBooks period-column style).
function shortCol(d) {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(d || '');
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1];
  return `${mo} ${Number(m[3])}, ${m[1].slice(2)}`;
}

// Turn a row's drill descriptor into a navigation URL. A leaf account opens its
// register; an aggregate (subtotal/total/net income) opens Transaction Detail.
// `cmp` drills the comparison column, using the comparison period's dates.
function drillHref(drill, { cmp, comparePeriodDates, label } = {}) {
  if (!drill) return null;
  const dates = (cmp && comparePeriodDates) ? comparePeriodDates : drill;
  const dateQ = () => (dates.mode === 'asof'
    ? `to=${encodeURIComponent(dates.asOfDate)}`
    : `from=${encodeURIComponent(dates.startDate)}&to=${encodeURIComponent(dates.endDate)}`);
  if (drill.kind === 'account') {
    return `/register/${drill.accountId}?${dateQ()}`;
  }
  const p = new URLSearchParams();
  if (drill.accountNumbers) p.set('accountNumbers', drill.accountNumbers.join(','));
  if (drill.accountTypes) p.set('accountTypes', drill.accountTypes.join(','));
  if (drill.net) p.set('net', '1');
  if (label) p.set('title', label);
  p.set('mode', dates.mode);
  if (dates.mode === 'asof') p.set('asOfDate', dates.asOfDate);
  else { p.set('startDate', dates.startDate); p.set('endDate', dates.endDate); }
  return `/transaction-detail?${p.toString()}`;
}

// QuickBooks-style nested Balance Sheet / P&L. Every number is drillable.
function StatementView({ data, nav, showCompare }) {
  const st = data.statement;
  if (!st || !st.rows) return <div className="qbd-empty">No data.</div>;
  const h = st.header;
  const cpd = st.comparePeriodDates;
  const go = (drill, cmp, label) => { const href = drillHref(drill, { cmp, comparePeriodDates: cpd, label }); if (href) nav(href); };
  const curColLabel = h.reportType === 'balance_sheet' ? shortCol(h.asOfDate) : 'Amount';
  const periodText = h.reportType === 'balance_sheet'
    ? `As of ${shortCol(h.asOfDate)}`
    : `${h.startDate} through ${h.endDate}`;

  const amtCell = (row, cmp) => {
    const val = cmp ? row.cmpAmount : row.amount;
    if (val == null) return <td className="ramt" />;
    const drillable = !!row.drill;
    const style = {};
    if (row.kind === 'subtotal') style.borderTop = '1px solid #000';
    if (row.kind === 'grandtotal') { style.borderTop = '1px solid #000'; style.borderBottom = '3px double #000'; }
    if (drillable) style.cursor = 'pointer';
    const cls = ['ramt', val < 0 ? 'qbd-neg' : '', drillable ? 'qbd-drill' : ''].filter(Boolean).join(' ');
    return <td className={cls} style={style} title={drillable ? 'Drill into transactions' : undefined} onClick={drillable ? () => go(row.drill, cmp, row.label) : undefined}>{fmt(val)}</td>;
  };

  return (
    <div className="qbd-rpt">
      <h2>{h.title}</h2>
      <div className="sub">{h.companyName} · {periodText}</div>
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th className="ramt">{curColLabel}</th>
            {showCompare && <><th className="ramt">{st.comparison?.period || 'Prior'}</th><th className="ramt">$ Change</th><th className="ramt">% Change</th></>}
          </tr>
        </thead>
        <tbody>
          {st.rows.map((row, i) => {
            const bold = row.kind === 'section' || row.kind === 'header' || row.kind === 'subtotal' || row.kind === 'grandtotal';
            return (
              <tr key={i}>
                <td className="ind" style={{ paddingLeft: 8 + row.depth * 16, fontWeight: bold ? 'bold' : 'normal' }}>{row.label}</td>
                {amtCell(row, false)}
                {showCompare && (
                  <>
                    {amtCell(row, true)}
                    <td className="ramt">{row.variance == null ? '' : fmtVariance(row.variance)}</td>
                    <td className="ramt">{row.variancePct == null ? '' : fmtVariancePct(row.variancePct)}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
