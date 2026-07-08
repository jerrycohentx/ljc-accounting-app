import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, importAPI } from '../services/api';
import { leafLabel, todayISO, fmtShortDate } from './helpers';

function flat(nodes, out) {
  (nodes || []).forEach((n) => { if (n.is_active) out.push(n); if (n.children) flat(n.children, out); });
  return out;
}

const SOURCE_LABELS = {
  plaid: 'Plaid',
  ofx: 'OFX',
  email: 'Email',
  import: 'Import',
};

function effectiveCategoryId(row) {
  return row.offsetAccountId || row.suggestedCategoryId || '';
}

function ReviewDetail({ row, onClose }) {
  if (!row) return null;
  return (
    <div className="qbd-review-detail-backdrop" onClick={onClose} role="presentation">
      <div className="qbd-review-detail" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Transaction detail">
        <div className="qbd-review-detail-hd">
          <b>Transaction Detail</b>
          <button type="button" className="qbd-review-detail-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <dl className="qbd-review-detail-body">
          <dt>Date</dt><dd>{fmtShortDate(row.date)}</dd>
          <dt>Entity</dt><dd>{row.entityName}</dd>
          <dt>Bank account</dt><dd>{row.accountNumber} — {leafLabel(row.accountName)}</dd>
          <dt>Payee</dt><dd className="qbd-review-detail-full">{row.payee || row.description}</dd>
          <dt>Memo</dt><dd className="qbd-review-detail-full">{row.memo || '—'}</dd>
          <dt>Description</dt><dd className="qbd-review-detail-full">{row.rawDescription || row.description}</dd>
          <dt>Journal entry</dt><dd>{row.jeNumber}</dd>
          <dt>JE description</dt><dd className="qbd-review-detail-full">{row.jeDescription || '—'}</dd>
          <dt>Amount</dt><dd>{row.payment ? `Payment $${row.payment}` : row.deposit ? `Deposit $${row.deposit}` : '—'}</dd>
          <dt>Source</dt><dd>{SOURCE_LABELS[row.source] || row.source}</dd>
          <dt>Status</dt><dd>{row.status}</dd>
          <dt>Downloaded</dt><dd>{row.downloadedAt ? fmtShortDate(row.downloadedAt) : '—'}</dd>
          <dt>FITID</dt><dd className="qbd-review-detail-mono">{row.fitid}</dd>
        </dl>
      </div>
    </div>
  );
}

export default function QBDFeedReview() {
  const { entities } = useEntity();
  const { showToast } = useOutletContext() || {};
  const toast = (m) => (showToast ? showToast(m) : null);

  const [items, setItems] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [accountsByEntity, setAccountsByEntity] = useState({});
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filterEntity, setFilterEntity] = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [filterAccount, setFilterAccount] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState(todayISO());
  const [sortKey, setSortKey] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [detailRow, setDetailRow] = useState(null);

  const loadAllAccounts = useCallback(() => {
    if (!entities.length) return;
    Promise.all(
      entities.map((e) =>
        accountAPI.list(e.id)
          .then((r) => ({
            entityId: e.id,
            accounts: flat(Array.isArray(r.data) ? r.data : (r.data?.data || []), []),
          }))
          .catch(() => ({ entityId: e.id, accounts: [] }))
      )
    ).then((rows) => {
      const map = {};
      for (const row of rows) map[row.entityId] = row.accounts;
      setAccountsByEntity(map);
      const filterAccounts = filterEntity ? (map[filterEntity] || []) : [];
      setAccounts(filterAccounts);
    });
  }, [entities, filterEntity]);

  const loadQueue = useCallback(() => {
    setLoading(true);
    importAPI.reviewQueue({
      entityId: filterEntity || undefined,
      source: filterSource || undefined,
      accountId: filterAccount || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    })
      .then((r) => { setItems(r.data?.items || []); setSel(new Set()); })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [filterEntity, filterSource, filterAccount, startDate, endDate]);

  useEffect(() => { loadAllAccounts(); }, [loadAllAccounts]);
  useEffect(() => {
    setAccounts(filterEntity ? (accountsByEntity[filterEntity] || []) : []);
  }, [filterEntity, accountsByEntity]);
  useEffect(() => { loadQueue(); }, [loadQueue]);

  const onSort = (k) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir(k === 'date' ? 'desc' : 'asc'); }
  };

  const sortedItems = useMemo(() => {
    const val = (row) => {
      switch (sortKey) {
        case 'date': return row.date || '';
        case 'entity': return (row.entityName || '').toLowerCase();
        case 'account': return (row.accountNumber || '').toLowerCase();
        case 'payee': return (row.description || '').toLowerCase();
        case 'payment': return row.payment ? +row.payment : 0;
        case 'deposit': return row.deposit ? +row.deposit : 0;
        case 'source': return row.source || '';
        case 'category': return (row.offsetAccountName || row.suggestedCategoryLabel || '').toLowerCase();
        case 'status': return row.status || '';
        default: return '';
      }
    };
    return [...items].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [items, sortKey, sortDir]);

  const selectedRows = useMemo(() => items.filter((r) => sel.has(r.fitid)), [items, sel]);
  const allChecked = items.length > 0 && sel.size === items.length;
  const toggle = (fitid) => setSel((s) => { const n = new Set(s); n.has(fitid) ? n.delete(fitid) : n.add(fitid); return n; });
  const toggleAll = () => setSel(allChecked ? new Set() : new Set(items.map((r) => r.fitid)));

  const arrow = (k) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const Th = ({ k, label, cls, style }) => (
    <th
      className={cls}
      style={{ ...style, cursor: 'pointer', userSelect: 'none' }}
      onClick={() => onSort(k)}
      title="Click to sort"
    >
      {label}{arrow(k)}
    </th>
  );

  const changeAccount = async (row, offsetAccountId) => {
    setItems((p) => p.map((r) => (r.fitid === row.fitid ? { ...r, offsetAccountId, suggestedCategoryId: null } : r)));
    try {
      await importAPI.setAccount(row.fitid, row.entityId, offsetAccountId);
    } catch (err) {
      toast('Could not change account: ' + (err.response?.data?.error || err.message));
      loadQueue();
    }
  };

  const postSelected = async () => {
    if (!selectedRows.length) { toast('Check transactions to approve first.'); return; }
    const uncategorized = selectedRows.filter((r) => !effectiveCategoryId(r));
    if (uncategorized.length) {
      toast(`${uncategorized.length} selected item(s) need a category before approval.`);
      return;
    }
    const byEntity = new Map();
    for (const row of selectedRows) {
      if (!byEntity.has(row.entityId)) byEntity.set(row.entityId, []);
      byEntity.get(row.entityId).push(row.jeId);
    }
    setBusy(true);
    try {
      for (const row of selectedRows) {
        if (!row.offsetAccountId && row.suggestedCategoryId) {
          await importAPI.setAccount(row.fitid, row.entityId, row.suggestedCategoryId);
        }
      }
      let posted = 0;
      for (const [entityId, jeIds] of byEntity) {
        const r = await importAPI.postSelected(entityId, jeIds);
        posted += r.data?.posted || 0;
      }
      toast(`${posted} transaction(s) posted to the register.`);
      loadQueue();
    } catch (err) {
      toast('Approve failed: ' + (err.response?.data?.details || err.response?.data?.error || err.message));
    } finally { setBusy(false); }
  };

  const rejectSelected = async () => {
    if (!selectedRows.length) { toast('Check transactions to reject first.'); return; }
    setBusy(true);
    try {
      const byEntity = new Map();
      for (const row of selectedRows) {
        if (!byEntity.has(row.entityId)) byEntity.set(row.entityId, []);
        byEntity.get(row.entityId).push(row.fitid);
      }
      let rejected = 0;
      for (const [entityId, fitids] of byEntity) {
        const r = await importAPI.reject(entityId, fitids);
        rejected += r.data?.rejected || 0;
      }
      toast(`${rejected} transaction(s) dismissed.`);
      loadQueue();
    } catch (err) {
      toast('Reject failed: ' + (err.response?.data?.error || err.message));
    } finally { setBusy(false); }
  };

  return (
    <div className="qbd-review-window">
      <div style={{ background: 'linear-gradient(#3f6cb0,#2a5596)', color: '#fff', fontWeight: 'bold', padding: '5px 12px', fontSize: 13 }}>
        Activity Review &amp; Approval
        <span style={{ fontWeight: 'normal', marginLeft: 10, fontSize: 11, color: '#d0e4ff' }}>
          Downloaded activity — approve before posting to the ledger
        </span>
      </div>

      <div className="qbd-tools">
        <label>Entity</label>
        <select value={filterEntity} onChange={(e) => setFilterEntity(e.target.value)}>
          <option value="">All entities</option>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <label>Source</label>
        <select value={filterSource} onChange={(e) => setFilterSource(e.target.value)}>
          <option value="">All sources</option>
          <option value="plaid">Plaid</option>
          <option value="ofx">OFX</option>
          <option value="email">Email</option>
          <option value="import">Other</option>
        </select>
        <label>Account</label>
        <select value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)} style={{ minWidth: 160 }}>
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_number} — {leafLabel(a.account_name)}</option>)}
        </select>
        <label>From</label>
        <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        <label>To</label>
        <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        <button type="button" className="qbd-btn" onClick={loadQueue}>Apply filters</button>
      </div>

      <div className="qbd-window" style={{ margin: '8px 10px', maxHeight: 'none', flex: 1 }}>
        <div className="qbd-wbody">
          {loading ? (
            <div className="qbd-empty">Loading review queue…</div>
          ) : items.length === 0 ? (
            <div className="qbd-empty">No downloaded activity awaiting approval.</div>
          ) : (
            <table className="qbd-reg qbd-review-table">
              <thead>
                <tr>
                  <th style={{ width: 28 }}><input type="checkbox" checked={allChecked} onChange={toggleAll} /></th>
                  <Th k="date" label="Date" cls="qbd-d" />
                  <Th k="entity" label="Entity" style={{ width: 90 }} />
                  <Th k="account" label="Account" style={{ width: 100 }} />
                  <Th k="payee" label="Payee / Memo" />
                  <Th k="payment" label="Payment" cls="qbd-amt" />
                  <Th k="deposit" label="Deposit" cls="qbd-amt" />
                  <Th k="source" label="Source" style={{ width: 72 }} />
                  <Th k="category" label="Category" style={{ width: 140 }} />
                  <Th k="status" label="Status" style={{ width: 56 }} />
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((row) => {
                  const catId = effectiveCategoryId(row);
                  const isSuggested = !row.offsetAccountId && row.suggestedCategoryId;
                  const conf = row.categoryConfidence || 0;
                  return (
                    <tr key={`${row.entityId}-${row.fitid}`}>
                      <td><input type="checkbox" checked={sel.has(row.fitid)} onChange={() => toggle(row.fitid)} /></td>
                      <td className="qbd-d">{fmtShortDate(row.date)}</td>
                      <td>{row.entityName}</td>
                      <td>{row.accountNumber}</td>
                      <td
                        className="desc qbd-review-desc"
                        title="Click for full detail"
                        onClick={() => setDetailRow(row)}
                      >
                        {row.description}
                      </td>
                      <td className="qbd-amt">{row.payment || ''}</td>
                      <td className="qbd-amt">{row.deposit || ''}</td>
                      <td><span className="qbd-pill">{SOURCE_LABELS[row.source] || row.source}</span></td>
                      <td>
                        <div className="qbd-review-cat-cell">
                          <select
                            value={catId}
                            onChange={(e) => changeAccount(row, e.target.value)}
                            className={isSuggested ? 'qbd-review-cat-suggested' : ''}
                            style={{ width: '100%', fontSize: 11 }}
                          >
                            <option value="">— categorize —</option>
                            {(accountsByEntity[row.entityId] || []).map((a) => (
                              <option key={a.id} value={a.id}>{leafLabel(a.account_name)}</option>
                            ))}
                          </select>
                          {isSuggested && conf >= 0.75 && (
                            <span
                              className={`qbd-cat-conf qbd-cat-conf-${conf >= 0.9 ? 'high' : 'med'}`}
                              title={`Suggested (${row.categorySource || 'rule'}, ${Math.round(conf * 100)}%)`}
                            />
                          )}
                          {row.propertyHint && (
                            <span className="qbd-review-prop-hint" title="Property match">
                              {row.propertyHint}
                            </span>
                          )}
                        </div>
                      </td>
                      <td><span className="qbd-pill">{row.status}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="qbd-foot">
          <span>{items.length} item(s)</span>
          <span className="sp" style={{ flex: 1 }} />
          <span className="qbd-muted">{selectedRows.length} selected</span>
        </div>
      </div>

      <div className="qbd-botbar">
        <button type="button" className="qbd-btn" onClick={postSelected} disabled={busy || !selectedRows.length}>
          Approve selected
        </button>
        <button type="button" className="qbd-btn" onClick={rejectSelected} disabled={busy || !selectedRows.length}>
          Reject / dismiss
        </button>
        <span className="sp" />
        <span className="qbd-muted">Approving posts to the general ledger</span>
      </div>

      {detailRow && <ReviewDetail row={detailRow} onClose={() => setDetailRow(null)} />}
    </div>
  );
}
