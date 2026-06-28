import React, { useEffect, useState, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, bankReconAPI } from '../services/api';
import { fmt, leafLabel, todayISO } from './helpers';

function flat(nodes, out) {
  (nodes || []).forEach((n) => { if (n.is_active) out.push(n); if (n.children) flat(n.children, out); });
  return out;
}

function periodLabel(statementDate) {
  if (!statementDate) return '';
  return String(statementDate).slice(0, 7);
}

export default function QBDReconcile() {
  const { entityId } = useEntity();
  const { showToast } = useOutletContext() || {};
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [stmtDate, setStmtDate] = useState(todayISO());
  const [endBal, setEndBal] = useState('');
  const [started, setStarted] = useState(false);
  const [data, setData] = useState(null);
  const [checked, setChecked] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!entityId) return;
    accountAPI.list(entityId).then((r) => {
      const all = flat(Array.isArray(r.data) ? r.data : (r.data?.data || []), []);
      setAccounts(all.filter((a) => a.account_type === 'ASSET' && /^Cash|Bank/.test(a.account_name) || (a.account_type === 'LIABILITY' && /Credit-Cards/.test(a.account_name))));
    }).catch(() => {});
  }, [entityId]);

  const loadWorksheet = useCallback(() => {
    if (!accountId) return Promise.resolve();
    setBusy(true);
    return bankReconAPI.worksheet(entityId, accountId, stmtDate)
      .then((r) => { setData(r.data); setChecked({}); setStarted(true); })
      .catch((e) => showToast && showToast('Failed to load: ' + (e.response?.data?.error || e.message)))
      .finally(() => setBusy(false));
  }, [entityId, accountId, stmtDate, showToast]);

  const start = () => {
    if (!accountId) { showToast && showToast('Pick an account'); return; }
    loadWorksheet();
  };

  const toggle = (id) => setChecked((c) => ({ ...c, [id]: !c[id] }));

  const entries = data?.entries || [];
  const beginning = +(data?.beginningBalance || 0);
  const clearedSigned = entries.filter((e) => checked[e.id]).reduce((s, e) => s + ((+e.debit || 0) - (+e.credit || 0)), 0);
  const clearedDep = entries.filter((e) => checked[e.id]).reduce((s, e) => s + (+e.debit || 0), 0);
  const clearedPay = entries.filter((e) => checked[e.id]).reduce((s, e) => s + (+e.credit || 0), 0);
  const target = parseFloat(endBal || data?.endingBalance || '0') || 0;
  const difference = Math.round((target - (beginning + clearedSigned)) * 100) / 100;
  const balanced = Math.abs(difference) < 0.005;
  const checkedIds = entries.filter((e) => checked[e.id]).map((e) => e.id);

  const periodSession = data?.periodSession || data?.priorSession;
  const needsReopen = periodSession && !periodSession.balanced;

  const reopenPeriod = () => {
    setBusy(true);
    bankReconAPI.reopen({ entityId, accountId, statementDate: stmtDate })
      .then(() => { showToast && showToast('Reconciliation reopened — cleared lines restored'); return loadWorksheet(); })
      .catch((e) => showToast && showToast('Reopen failed: ' + (e.response?.data?.error || e.message)))
      .finally(() => setBusy(false));
  };

  const finish = () => {
    if (!balanced) { showToast && showToast('Difference must be $0.00 to close reconciliation'); return; }
    if (checkedIds.length === 0) { showToast && showToast('Mark the cleared transactions first'); return; }
    setBusy(true);
    bankReconAPI.reconcile({ entityId, accountId, glIds: checkedIds, statementDate: stmtDate, statementEndingBalance: target })
      .then(() => { showToast && showToast(`Reconciled ${checkedIds.length} transactions ✓`); setStarted(false); setData(null); setEndBal(''); })
      .catch((e) => {
        const msg = e.response?.data?.error || e.message;
        showToast && showToast(msg);
        if (e.response?.status === 422) loadWorksheet();
      })
      .finally(() => setBusy(false));
  };

  if (!started) {
    return (
      <div className="qbd-form">
        <div className="fhd">Begin Reconciliation</div>
        <div className="frow"><label>Account</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">— select bank / card account —</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {leafLabel(a.account_name)}</option>)}
          </select>
        </div>
        <div className="frow"><label>Statement date</label><input type="date" value={stmtDate} onChange={(e) => setStmtDate(e.target.value)} /></div>
        <div className="frow"><label>Ending balance</label><input type="number" step="0.01" value={endBal} onChange={(e) => setEndBal(e.target.value)} placeholder="From your bank statement" style={{ textAlign: 'right', width: 180 }} /></div>
        <div className="qbd-botbar"><span className="qbd-muted">Enter your statement's ending balance and date, then start.</span><span className="sp" /><button className="qbd-btn" disabled={busy} onClick={start} style={{ fontWeight: 'bold' }}>Start reconciling →</button></div>
      </div>
    );
  }

  const sessionBanner = periodSession ? (
    <div style={{
      padding: '8px 12px',
      marginBottom: 8,
      borderRadius: 4,
      background: periodSession.balanced ? '#eaf6ec' : '#fdecea',
      color: periodSession.balanced ? '#2f6b3a' : '#b3261e',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
    }}>
      <span>
        {periodSession.balanced ? '✓' : '⚠'} Reconcile {periodLabel(periodSession.statementDate)} ({periodSession.status})
        {periodSession.clearedCount != null ? ` — ${periodSession.clearedCount} cleared lines` : ''}
        {!periodSession.balanced && periodSession.difference != null ? ` — difference ${fmt(periodSession.difference)}` : ''}
      </span>
      {periodSession.message && <span className="qbd-muted">{periodSession.message}</span>}
      {needsReopen && (
        <button className="qbd-btn" disabled={busy} onClick={reopenPeriod} style={{ marginLeft: 'auto' }}>
          Reopen period
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="qbd-window">
      <div className="qbd-wtitle">✓ Reconcile — {data.account.account_number} · {data.account.account_name}
        <span className="x" onClick={() => { setStarted(false); setData(null); }}>✕</span>
      </div>
      {sessionBanner}
      <div className="qbd-tools" style={{ gap: 18 }}>
        <button className="qbd-btn" onClick={() => { setStarted(false); setData(null); }}>← Change</button>
        <span><span className="qbd-muted">Beginning</span> <b>{fmt(beginning) || '0.00'}</b></span>
        <span><span className="qbd-muted">Cleared deposits</span> <b>{fmt(clearedDep) || '0.00'}</b></span>
        <span><span className="qbd-muted">Cleared payments</span> <b>{fmt(clearedPay) || '0.00'}</b></span>
        <span><span className="qbd-muted">Statement ending</span> <b>{fmt(target) || '0.00'}</b></span>
        <span style={{ marginLeft: 'auto', fontWeight: 'bold', color: balanced ? '#2f6b3a' : '#b3261e' }}>
          Difference: {fmt(difference) || '0.00'} {balanced ? '✓' : ''}
        </span>
      </div>
      <div className="qbd-wbody">
        {entries.length === 0 ? <div className="qbd-empty">No uncleared transactions up to {data.statementDate}.</div> : (
          <table className="qbd-reg">
            <thead><tr><th style={{ width: 30 }}>✓</th><th className="qbd-d">DATE</th><th className="qbd-je">ENTRY</th><th>MEMO</th><th className="qbd-amt">Deposit</th><th className="qbd-amt">Payment</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} onClick={() => toggle(e.id)} style={{ cursor: 'pointer', background: checked[e.id] ? '#eaf6ec' : undefined }}>
                  <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!checked[e.id]} onChange={() => toggle(e.id)} onClick={(ev) => ev.stopPropagation()} /></td>
                  <td className="qbd-d">{e.posting_date}</td>
                  <td className="qbd-je">{e.je_number}</td>
                  <td>{e.je_description || e.description || ''}</td>
                  <td className="qbd-amt">{(+e.debit) ? fmt(+e.debit) : ''}</td>
                  <td className="qbd-amt">{(+e.credit) ? fmt(+e.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="qbd-foot">
        <span className="qbd-muted">{checkedIds.length} marked cleared</span>
        {!balanced && <span className="qbd-muted" style={{ color: '#b3261e', marginLeft: 12 }}>Reconciliation stays open until difference is $0.00</span>}
        <span className="sp" />
        <button className="qbd-btn" disabled={busy || !balanced || checkedIds.length === 0} onClick={finish} style={{ fontWeight: 'bold', background: balanced ? 'linear-gradient(#dff3e2,#bfe6c8)' : undefined }}>Reconcile Now</button>
      </div>
    </div>
  );
}
