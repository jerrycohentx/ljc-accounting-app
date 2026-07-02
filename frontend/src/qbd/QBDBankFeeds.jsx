import React, { useEffect, useState, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, plaidAPI, importAPI } from '../services/api';
import { fmt, leafLabel, todayISO } from './helpers';

function flat(nodes, out) {
  (nodes || []).forEach((n) => { if (n.is_active) out.push(n); if (n.children) flat(n.children, out); });
  return out;
}

// QuickBooks Desktop "Bank Feeds Center": download (date range) + review-before-post.
export default function QBDBankFeeds() {
  const { entityId } = useEntity();
  const { showToast } = useOutletContext() || {};
  const toast = (m) => (showToast ? showToast(m) : null);

  const [items, setItems] = useState([]);
  const [itemId, setItemId] = useState('');
  const [mode, setMode] = useState('since'); // since | all | custom
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState(todayISO());

  const [accounts, setAccounts] = useState([]);
  const [pending, setPending] = useState([]);
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [applying, setApplying] = useState(false);

  const loadAccounts = useCallback(() => {
    if (!entityId) return;
    accountAPI.list(entityId)
      .then((r) => setAccounts(flat(Array.isArray(r.data) ? r.data : (r.data?.data || []), [])))
      .catch(() => {});
  }, [entityId]);

  const loadPending = useCallback(() => {
    if (!entityId) return;
    importAPI.pending(entityId)
      .then((r) => { setPending(r.data?.pending || []); setSel(new Set()); })
      .catch(() => setPending([]));
  }, [entityId]);

  const loadItems = useCallback(() => {
    if (!entityId) return;
    plaidAPI.listItems(entityId)
      .then((r) => {
        const list = r.data?.items || [];
        setItems(list);
        if (list.length && !list.find((i) => i.item_id === itemId)) setItemId(list[0].item_id);
      })
      .catch(() => setItems([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

  useEffect(() => { loadAccounts(); loadPending(); loadItems(); }, [loadAccounts, loadPending, loadItems]);

  const download = async () => {
    if (!itemId) { toast('Connect a bank first (Bank Feeds → connect).'); return; }
    if (mode === 'custom' && (!startDate || !endDate)) { toast('Pick a start and end date.'); return; }
    const opts = mode === 'custom' ? { startDate, endDate } : mode === 'all' ? { mode: 'all' } : {};
    setDownloading(true);
    try {
      const sres = await plaidAPI.sync(entityId, itemId, opts);
      const importId = sres.data?.importId;
      const newCount = sres.data?.summary?.newTransactions ?? 0;
      if (!importId) { toast('Download failed — no session returned.'); return; }
      if (newCount === 0) { toast('No new transactions in that range.'); loadPending(); return; }
      const ires = await plaidAPI.import(importId, true); // draft=true → held for review
      const sweepCount = ires.data?.reapply?.updated || 0;
      const sweepNote = sweepCount
        ? ` ${sweepCount} older pending transaction${sweepCount === 1 ? '' : 's'} also auto-categorized.`
        : '';
      toast(`Downloaded ${newCount} transaction(s) — review below before posting.${sweepNote}`);
      loadPending();
    } catch (err) {
      toast('Download failed: ' + (err.response?.data?.details || err.response?.data?.error || err.message));
    } finally { setDownloading(false); }
  };

  const changeAccount = async (row, offsetAccountId) => {
    setPending((p) => p.map((r) => (r.fitid === row.fitid ? { ...r, offsetAccountId } : r)));
    try { await importAPI.setAccount(row.fitid, entityId, offsetAccountId); }
    catch (err) { toast('Could not change account: ' + (err.response?.data?.error || err.message)); loadPending(); }
  };

  const toggle = (fitid) => setSel((s) => { const n = new Set(s); n.has(fitid) ? n.delete(fitid) : n.add(fitid); return n; });
  const allChecked = pending.length > 0 && sel.size === pending.length;
  const toggleAll = () => setSel(allChecked ? new Set() : new Set(pending.map((r) => r.fitid)));

  const selectedRows = pending.filter((r) => sel.has(r.fitid));

  const postSelected = async () => {
    if (!selectedRows.length) { toast('Check the transactions to add first.'); return; }
    const jeIds = selectedRows.map((r) => r.jeId).filter(Boolean);
    setBusy(true);
    try {
      const r = await importAPI.postSelected(entityId, jeIds);
      toast(r.data?.message || `${r.data?.posted || 0} added to the register.`);
      loadPending();
    } catch (err) {
      toast('Post failed: ' + (err.response?.data?.details || err.response?.data?.error || err.message));
    } finally { setBusy(false); }
  };

  const reapplyRulesNow = async () => {
    setApplying(true);
    try {
      const r = await importAPI.reapplyRules(entityId);
      const n = r.data?.updated || 0;
      toast(n ? `${n} transaction(s) auto-categorized from current rules.` : 'No changes — nothing pending matches a rule right now.');
      loadPending();
    } catch (err) {
      toast('Re-apply rules failed: ' + (err.response?.data?.error || err.message));
    } finally { setApplying(false); }
  };

  const discardSelected = async () => {
    if (!selectedRows.length) { toast('Check the transactions to discard first.'); return; }
    setBusy(true);
    try {
      const r = await importAPI.reject(entityId, selectedRows.map((r) => r.fitid));
      toast(r.data?.message || `${r.data?.rejected || 0} discarded.`);
      loadPending();
    } catch (err) {
      toast('Discard failed: ' + (err.response?.data?.error || err.message));
    } finally { setBusy(false); }
  };

  return (
    <div>
      <div style={{ background: 'linear-gradient(#3f6cb0,#2a5596)', color: '#fff', fontWeight: 'bold', padding: '5px 12px', fontSize: 13 }}>Bank Feeds Center</div>

      <div className="qbd-form">
        <div className="fhd">Download Transactions</div>
        <div className="frow">
          <label>Account</label>
          <select value={itemId} onChange={(e) => setItemId(e.target.value)} style={{ minWidth: 280 }}>
            {items.length === 0 ? <option value="">— no bank connected —</option> :
              items.map((i) => <option key={i.item_id} value={i.item_id}>{i.institution_display_name || i.institution_name || i.item_id}</option>)}
          </select>
        </div>
        <div className="frow">
          <label>Get</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ width: 220 }}>
            <option value="since">New since last download</option>
            <option value="all">All available activity</option>
            <option value="custom">Custom date range…</option>
          </select>
          {mode === 'custom' && (
            <>
              <label style={{ width: 40 }}>From</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              <label style={{ width: 24 }}>To</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </>
          )}
        </div>
        <div className="qbd-botbar">
          <span className="qbd-muted">Downloaded transactions are held for your review — nothing posts until you add it to the register.</span>
          <span className="sp" />
          <button className="qbd-btn" disabled={downloading || !itemId} onClick={download} style={{ fontWeight: 'bold' }}>
            {downloading ? 'Downloading…' : 'Download'}
          </button>
        </div>
      </div>

      <div className="qbd-form">
        <div className="fhd">Transactions to Review {pending.length ? `(${pending.length})` : ''}</div>
        <div className="qbd-wbody">
          <table className="qbd-coa">
            <thead>
              <tr>
                <th style={{ width: 28 }}><input type="checkbox" checked={allChecked} onChange={toggleAll} /></th>
                <th style={{ width: 90 }}>DATE</th>
                <th>DESCRIPTION</th>
                <th className="qbd-bal" style={{ width: 110 }}>PAYMENT</th>
                <th className="qbd-bal" style={{ width: 110 }}>DEPOSIT</th>
                <th style={{ width: 260 }}>ACCOUNT</th>
              </tr>
            </thead>
            <tbody>
              {pending.length === 0 ? (
                <tr><td colSpan={6}><div className="qbd-empty">No transactions waiting for review. Download from a connected bank above.</div></td></tr>
              ) : pending.map((r) => (
                <tr key={r.fitid}>
                  <td><input type="checkbox" checked={sel.has(r.fitid)} onChange={() => toggle(r.fitid)} /></td>
                  <td className="qbd-num">{r.date}</td>
                  <td>{r.description}</td>
                  <td className="qbd-bal">{r.payment ? fmt(+r.payment) : ''}</td>
                  <td className="qbd-bal">{r.deposit ? fmt(+r.deposit) : ''}</td>
                  <td>
                    <select value={r.offsetAccountId || ''} onChange={(e) => changeAccount(r, e.target.value)} style={{ width: '100%' }}>
                      <option value="">— uncategorized —</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {leafLabel(a.account_name)}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="qbd-botbar">
          <span className="qbd-muted">{sel.size} selected</span>
          <span className="sp" />
          <button className="qbd-btn" disabled={applying || !pending.length} onClick={reapplyRulesNow}>
            {applying ? 'Applying…' : 'Re-apply Rules Now'}
          </button>
          <button className="qbd-btn" disabled={busy || !sel.size} onClick={discardSelected} style={{ marginLeft: 8 }}>Discard</button>
          <button className="qbd-btn" disabled={busy || !sel.size} onClick={postSelected} style={{ fontWeight: 'bold', marginLeft: 8 }}>Add to Register</button>
        </div>
      </div>
    </div>
  );
}
