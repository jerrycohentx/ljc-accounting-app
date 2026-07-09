import React, { useEffect, useState, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, journalAPI } from '../services/api';
import { fmt, leafLabel, todayISO, fmtShortDate } from './helpers';

function flat(nodes, out) {
  (nodes || []).forEach((n) => { if (n.is_active) out.push(n); if (n.children) flat(n.children, out); });
  return out;
}
const blankLine = () => ({ accountId: '', debit: '', credit: '', description: '' });

export default function QBDJournalEntry() {
  const { entityId } = useEntity();
  const { showToast } = useOutletContext() || {};
  const [accounts, setAccounts] = useState([]);
  const [date, setDate] = useState(todayISO());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([blankLine(), blankLine()]);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState([]);

  const loadRecent = useCallback(() => {
    if (!entityId) return;
    journalAPI.list(entityId, { limit: 8 }).then((r) => setRecent(r.data?.data || [])).catch(() => {});
  }, [entityId]);

  useEffect(() => {
    if (!entityId) return;
    accountAPI.list(entityId).then((r) => setAccounts(flat(Array.isArray(r.data) ? r.data : (r.data?.data || []), []))).catch(() => {});
    loadRecent();
  }, [entityId, loadRecent]);

  const setLine = (i, k, v) => setLines((ls) => ls.map((l, j) => j === i ? { ...l, [k]: v } : l));
  const addLine = () => setLines((ls) => [...ls, blankLine()]);
  const delLine = (i) => setLines((ls) => ls.length > 2 ? ls.filter((_, j) => j !== i) : ls);

  const totDeb = lines.reduce((s, l) => s + (+l.debit || 0), 0);
  const totCred = lines.reduce((s, l) => s + (+l.credit || 0), 0);
  const balanced = Math.abs(totDeb - totCred) < 0.01 && totDeb > 0;
  const validLines = lines.filter((l) => l.accountId && ((+l.debit) || (+l.credit)));

  const buildBody = () => ({
    description: memo || 'Journal Entry',
    postingDate: date,
    memo,
    lines: validLines.map((l) => ({ accountId: l.accountId, debit: +l.debit || 0, credit: +l.credit || 0, description: l.description || '' })),
  });

  const reset = () => { setLines([blankLine(), blankLine()]); setMemo(''); };

  const save = async (post) => {
    if (validLines.length < 2) { showToast && showToast('Need at least two lines'); return; }
    if (!balanced) { showToast && showToast('Debits must equal credits'); return; }
    setBusy(true);
    try {
      const r = await journalAPI.create(entityId, buildBody());
      const id = r.data?.id;
      if (post && id) {
        try {
          await journalAPI.approve(entityId, id);
          await journalAPI.post(entityId, id);
          showToast && showToast(`Posted ${r.data.jeNumber || ''} to the ledger`);
        } catch (err) {
          showToast && showToast('Saved as draft — posting needs admin role');
        }
      } else {
        showToast && showToast(`Saved draft ${r.data?.jeNumber || ''}`);
      }
      reset(); loadRecent();
    } catch (err) {
      showToast && showToast('Save failed: ' + (err.response?.data?.error || err.message));
    } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="qbd-form">
        <div className="fhd">Make General Journal Entries</div>
        <div className="frow">
          <label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <label style={{ width: 60 }}>Memo</label><input style={{ flex: 1 }} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Entry memo" />
        </div>
        <div style={{ padding: '0 12px 12px' }}>
          <table className="qbd-jt">
            <thead><tr><th style={{ width: 280 }}>Account</th><th style={{ width: 120 }}>Debit</th><th style={{ width: 120 }}>Credit</th><th>Memo</th><th style={{ width: 30 }} /></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <select value={l.accountId} onChange={(e) => setLine(i, 'accountId', e.target.value)}>
                      <option value="">— select account —</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {leafLabel(a.account_name)}</option>)}
                    </select>
                  </td>
                  <td><input type="number" step="0.01" value={l.debit} onChange={(e) => setLine(i, 'debit', e.target.value)} style={{ textAlign: 'right' }} /></td>
                  <td><input type="number" step="0.01" value={l.credit} onChange={(e) => setLine(i, 'credit', e.target.value)} style={{ textAlign: 'right' }} /></td>
                  <td><input value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} /></td>
                  <td><span style={{ cursor: 'pointer', color: '#b3261e' }} onClick={() => delLine(i)}>✕</span></td>
                </tr>
              ))}
              <tr style={{ fontWeight: 'bold', background: '#eef4fb' }}>
                <td style={{ textAlign: 'right' }}>Totals</td>
                <td style={{ textAlign: 'right' }}>{fmt(totDeb)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(totCred)}</td>
                <td colSpan={2} style={{ color: balanced ? '#2f6b3a' : '#b3261e' }}>{balanced ? 'In balance' : `Out of balance ${fmt(totDeb - totCred)}`}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="qbd-botbar">
          <button className="qbd-btn" onClick={addLine}>+ Add Line</button>
          <span className="sp" />
          <button className="qbd-btn" disabled={busy} onClick={() => save(false)}>Save Draft</button>
          <button className="qbd-btn" disabled={busy} onClick={() => save(true)} style={{ fontWeight: 'bold' }}>Save &amp; Post</button>
        </div>
      </div>

      <div className="qbd-form">
        <div className="fhd">Recent Journal Entries</div>
        <div className="qbd-wbody">
          <table className="qbd-coa">
            <thead><tr><th>DATE</th><th>ENTRY #</th><th>MEMO</th><th>STATUS</th><th className="qbd-bal">AMOUNT</th></tr></thead>
            <tbody>
              {recent.length === 0 ? <tr><td colSpan={5}><div className="qbd-empty">No journal entries yet.</div></td></tr> :
                recent.map((j) => (
                  <tr key={j.id}><td className="qbd-num">{fmtShortDate(j.posting_date)}</td><td>{j.je_number}</td><td>{j.description}</td><td>{j.status}</td><td className="qbd-bal">{fmt(+j.total_debit)}</td></tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
