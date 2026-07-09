import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { reportAPI, journalAPI, mgmtReportAPI } from '../services/api';
import { fmt, typeLabel, parseTag, tagClass } from './helpers';

export default function QBDRegister() {
  const { accountId } = useParams();
  const { entityId } = useEntity();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const from = sp.get('from') || '';
  const to = sp.get('to') || '';

  const [account, setAccount] = useState(null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tagFilter, setTagFilter] = useState('');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('date');
  const [sortDir, setSortDir] = useState('desc'); // newest first by default
  const [entry, setEntry] = useState(null);

  useEffect(() => {
    if (!entityId || !accountId) return;
    setLoading(true);
    reportAPI.generalLedger(entityId, accountId, from || undefined, to || undefined)
      .then((r) => { setAccount(r.data.account); setEntries(r.data.entries || []); })
      .catch(() => { setAccount(null); setEntries([]); })
      .finally(() => setLoading(false));
  }, [entityId, accountId, from, to]);

  const openEntry = useCallback((jeId) => {
    journalAPI.get(entityId, jeId).then((r) => setEntry(r.data)).catch(() => setEntry(null));
  }, [entityId]);

  const debitNormal = account?.normal_balance === 'DEBIT';

  // Compute running balance in chronological order, then we can display in any sort order.
  const { balById, endingBalance } = useMemo(() => {
    const chrono = [...entries].sort((a, b) => ((a.posting_date + (a.je_number || '')) < (b.posting_date + (b.je_number || '')) ? -1 : 1));
    let run = 0; const map = {};
    chrono.forEach((e) => { run += (debitNormal ? 1 : -1) * ((+e.debit || 0) - (+e.credit || 0)); map[e.id] = run; });
    return { balById: map, endingBalance: run };
  }, [entries, debitNormal]);

  const memoOf = (e) => e.je_description || (e.description || '').split('|').slice(1).join('|').trim() || (e.description || '');
  const incOf = (e) => debitNormal ? (+e.debit || 0) : (+e.credit || 0);
  const decOf = (e) => debitNormal ? (+e.credit || 0) : (+e.debit || 0);

  const onSort = (k) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir(k === 'memo' || k === 'tag' ? 'asc' : 'desc'); }
  };

  const view = useMemo(() => {
    let rows = entries.filter((e) => {
      const tag = parseTag(e.description);
      if (tagFilter && tag !== tagFilter) return false;
      if (search && !memoOf(e).toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
    const val = (e) => {
      switch (sortKey) {
        case 'date': return e.posting_date + (e.je_number || '');
        case 'entry': return e.je_number || '';
        case 'memo': return memoOf(e).toLowerCase();
        case 'tag': return parseTag(e.description);
        case 'increase': return incOf(e);
        case 'decrease': return decOf(e);
        case 'balance': return balById[e.id] || 0;
        default: return 0;
      }
    };
    rows.sort((a, b) => { const va = val(a), vb = val(b); if (va < vb) return sortDir === 'asc' ? -1 : 1; if (va > vb) return sortDir === 'asc' ? 1 : -1; return 0; });
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, tagFilter, search, sortKey, sortDir, balById, debitNormal]);

  if (loading) return <div className="qbd-window"><div className="qbd-wtitle">Register</div><div className="qbd-loading">Loading register…</div></div>;
  if (!account) return <div className="qbd-window"><div className="qbd-wtitle">Register</div><div className="qbd-empty">Account not found.</div></div>;

  const incL = debitNormal ? 'Increase' : 'Decrease';
  const decL = debitNormal ? 'Decrease' : 'Increase';
  const tags = [...new Set(entries.map((e) => parseTag(e.description)).filter(Boolean))].sort();
  const arrow = (k) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const Th = ({ k, label, cls }) => (
    <th className={cls} onClick={() => onSort(k)} style={{ cursor: 'pointer', userSelect: 'none' }} title="Click to sort">{label}{arrow(k)}</th>
  );

  return (
    <div className="qbd-window">
      <div className="qbd-wtitle">📒 Register — {account.account_number} · {account.account_name}
        <span className="x" onClick={() => nav('/accounts')}>✕</span>
      </div>
      <div className="qbd-tools">
        <button className="qbd-btn" onClick={() => nav('/accounts')}>← Chart of Accounts</button>
        <span className="qbd-muted">Filter by tag:</span>
        <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
          <option value="">All ({entries.length})</option>
          {tags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input placeholder="Search memo…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="qbd-btn" onClick={() => { setSortKey('date'); setSortDir('desc'); }} title="Reset to newest first">↧ Newest first</button>
        <span className="qbd-muted" style={{ marginLeft: 'auto' }}>Type: {typeLabel(account)} · {account.is_active ? 'Active' : 'Inactive'}</span>
      </div>
      <div className="qbd-wbody">
        {view.length === 0 ? <div className="qbd-empty">No transactions{tagFilter ? ` for tag “${tagFilter}”` : ''}.</div> : (
          <table className="qbd-reg">
            <thead><tr>
              <Th k="date" label="DATE" cls="qbd-d" />
              <Th k="entry" label="ENTRY" cls="qbd-je" />
              <Th k="memo" label="MEMO" />
              <Th k="tag" label="TAG" cls="qbd-tag" />
              <Th k="increase" label={incL} cls="qbd-amt" />
              <Th k="decrease" label={decL} cls="qbd-amt" />
              <Th k="balance" label="BALANCE" cls="qbd-rbal" />
            </tr></thead>
            <tbody>
              {view.map((e) => {
                const tag = parseTag(e.description);
                const inc = incOf(e), dec = decOf(e);
                return (
                  <tr key={e.id} onClick={() => openEntry(e.journal_entry_id)} title="Open transaction detail">
                    <td className="qbd-d">{e.posting_date}</td>
                    <td className="qbd-je">{e.je_number}</td>
                    <td>{memoOf(e)}</td>
                    <td className="qbd-tag">{tag && <span className={'qbd-pill ' + tagClass(tag)}>{tag}</span>}</td>
                    <td className="qbd-amt">{inc ? fmt(inc) : ''}</td>
                    <td className="qbd-amt">{dec ? fmt(dec) : ''}</td>
                    <td className="qbd-rbal">{fmt(balById[e.id])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="qbd-foot"><span>Ending balance</span><span className="sp" /><span className={endingBalance < 0 ? 'qbd-neg' : ''}>{fmt(endingBalance) || '0.00'}</span></div>

      {entry && (
        <TxnDetail
          entry={entry}
          entityId={entityId}
          onClose={() => setEntry(null)}
          onReversed={(rev) => {
            setEntry(null);
            reportAPI.generalLedger(entityId, accountId, from || undefined, to || undefined)
              .then((r) => { setAccount(r.data.account); setEntries(r.data.entries || []); })
              .catch(() => {});
            if (rev?.reversalJeNumber) window.alert(`Reversed — ${rev.reversalJeNumber}`);
          }}
        />
      )}
    </div>
  );
}

function TxnDetail({ entry, entityId, onClose, onReversed }) {
  const lines = entry.lines || [];
  const [busy, setBusy] = useState(false);
  const canReverse = entry.status === 'POSTED' && !entry.reversed_by_je_id && !entry.reverses_je_id;

  const doReverse = () => {
    if (!window.confirm(`Reverse ${entry.je_number}? This creates an offsetting posted entry.`)) return;
    setBusy(true);
    journalAPI.reverse(entityId, entry.id)
      .then((r) => onReversed && onReversed(r.data))
      .catch((e) => window.alert(e.response?.data?.error || e.message))
      .finally(() => setBusy(false));
  };

  let td = 0, tc = 0;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(20,40,70,.35)', zIndex: 350, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div className="qbd-window" style={{ width: 680, maxHeight: '80vh', margin: 0 }} onClick={(e) => e.stopPropagation()}>
        <div className="qbd-wtitle">🧾 Transaction Detail — {entry.je_number} <span className="x" onClick={onClose}>✕</span></div>
        <div className="qbd-tools">
          <span className="qbd-muted">Date</span><b>{entry.posting_date}</b>
          <span className="qbd-muted" style={{ marginLeft: 14 }}>Memo</span><span>{entry.description || ''}</span>
          <span className="qbd-muted" style={{ marginLeft: 'auto' }}>Status: {entry.status}</span>
          {entry.reversed_by_je_id && <span className="qbd-muted" style={{ marginLeft: 8 }}>(reversed)</span>}
          {entry.sourceDocument?.hasFile && (
            <button
              className="qbd-btn"
              style={{ marginLeft: 12 }}
              title={entry.sourceDocument.fileName || 'Source report'}
              onClick={() => mgmtReportAPI.viewFile(entry.sourceDocument.mgmtReportId, entry.sourceDocument.fileName).catch((e) => window.alert(e.message))}
            >
              📎 View source report
            </button>
          )}
          {canReverse && (
            <button className="qbd-btn" disabled={busy} onClick={doReverse} style={{ marginLeft: 12 }}>Reverse entry</button>
          )}
        </div>
        <div className="qbd-wbody">
          <table className="qbd-reg">
            <thead><tr><th>ACCOUNT</th><th className="qbd-amt">DEBIT</th><th className="qbd-amt">CREDIT</th></tr></thead>
            <tbody>
              {lines.map((l) => { td += +l.debit || 0; tc += +l.credit || 0; return (
                <tr key={l.id}><td>{l.account_number} · {(l.account_name || '').split(':').pop()}</td><td className="qbd-amt">{(+l.debit) ? fmt(+l.debit) : ''}</td><td className="qbd-amt">{(+l.credit) ? fmt(+l.credit) : ''}</td></tr>
              ); })}
              <tr style={{ fontWeight: 'bold', background: '#eef4fb' }}><td>TOTAL</td><td className="qbd-amt">{fmt(td)}</td><td className="qbd-amt">{fmt(tc)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
