import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, importAPI } from '../services/api';
import { leafLabel, todayISO } from './helpers';

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

  const selectedRows = useMemo(() => items.filter((r) => sel.has(r.fitid)), [items, sel]);
  const allChecked = items.length > 0 && sel.size === items.length;
  const toggle = (fitid) => setSel((s) => { const n = new Set(s); n.has(fitid) ? n.delete(fitid) : n.add(fitid); return n; });
  const toggleAll = () => setSel(allChecked ? new Set() : new Set(items.map((r) => r.fitid)));

  const changeAccount = async (row, offsetAccountId) => {
    setItems((p) => p.map((r) => (r.fitid === row.fitid ? { ...r, offsetAccountId } : r)));
    try {
      await importAPI.setAccount(row.fitid, row.entityId, offsetAccountId);
    } catch (err) {
      toast('Could not change account: ' + (err.response?.data?.error || err.message));
      loadQueue();
    }
  };

  const postSelected = async () => {
    if (!selectedRows.length) { toast('Check transactions to approve first.'); return; }
    const byEntity = new Map();
    for (const row of selectedRows) {
      if (!byEntity.has(row.entityId)) byEntity.set(row.entityId, []);
      byEntity.get(row.entityId).push(row.jeId);
    }
    setBusy(true);
    try {
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
                  <th className="qbd-d">Date</th>
                  <th style={{ width: 90 }}>Entity</th>
                  <th style={{ width: 100 }}>Account</th>
                  <th>Payee / Memo</th>
                  <th className="qbd-amt">Payment</th>
                  <th className="qbd-amt">Deposit</th>
                  <th style={{ width: 72 }}>Source</th>
                  <th style={{ width: 140 }}>Category</th>
                  <th style={{ width: 56 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={`${row.entityId}-${row.fitid}`}>
                    <td><input type="checkbox" checked={sel.has(row.fitid)} onChange={() => toggle(row.fitid)} /></td>
                    <td className="qbd-d">{row.date}</td>
                    <td>{row.entityName}</td>
                    <td>{row.accountNumber}</td>
                    <td className="desc" title={row.description}>{row.description}</td>
                    <td className="qbd-amt">{row.payment || ''}</td>
                    <td className="qbd-amt">{row.deposit || ''}</td>
                    <td><span className="qbd-pill">{SOURCE_LABELS[row.source] || row.source}</span></td>
                    <td>
                      <select
                        value={row.offsetAccountId || ''}
                        onChange={(e) => changeAccount(row, e.target.value)}
                        style={{ width: '100%', fontSize: 11 }}
                      >
                        <option value="">— categorize —</option>
                        {(accountsByEntity[row.entityId] || []).map((a) => (
                          <option key={a.id} value={a.id}>{leafLabel(a.account_name)}</option>
                        ))}
                      </select>
                    </td>
                    <td><span className="qbd-pill">{row.status}</span></td>
                  </tr>
                ))}
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
    </div>
  );
}
