import React, { useEffect, useState, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, journalAPI } from '../services/api';
import { fmt, leafLabel, todayISO, fmtShortDate } from './helpers';

function flat(nodes, out) {
  (nodes || []).forEach((n) => { if (n.is_active) out.push(n); if (n.children) flat(n.children, out); });
  return out;
}

// mode: 'check' = money out of a bank account; 'deposit' = money into a bank account
export default function QBDCashEntry({ mode = 'check' }) {
  const isCheck = mode === 'check';
  const { entityId } = useEntity();
  const { showToast } = useOutletContext() || {};
  const [accounts, setAccounts] = useState([]);
  const [bankId, setBankId] = useState('');
  const [otherId, setOtherId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayISO());
  const [party, setParty] = useState('');
  const [memo, setMemo] = useState('');
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

  const banks = accounts.filter((a) => a.account_type === 'ASSET' && /^Cash/.test(a.account_name));
  const others = accounts.filter((a) => a.id !== bankId);

  const reset = () => { setAmount(''); setParty(''); setMemo(''); setOtherId(''); };

  const submit = async () => {
    const amt = +amount || 0;
    if (!bankId || !otherId || amt <= 0) { showToast && showToast('Pick both accounts and a positive amount'); return; }
    const desc = `${isCheck ? 'Check' : 'Deposit'}${party ? ' — ' + party : ''}${memo ? ' (' + memo + ')' : ''}`;
    // check: debit category, credit bank.  deposit: debit bank, credit source.
    const lines = isCheck
      ? [{ accountId: otherId, debit: amt, credit: 0, description: party }, { accountId: bankId, debit: 0, credit: amt, description: party }]
      : [{ accountId: bankId, debit: amt, credit: 0, description: party }, { accountId: otherId, debit: 0, credit: amt, description: party }];
    setBusy(true);
    try {
      const r = await journalAPI.create(entityId, { description: desc, postingDate: date, memo, lines });
      const id = r.data?.id;
      if (id) {
        try { await journalAPI.approve(entityId, id); await journalAPI.post(entityId, id); showToast && showToast(`Posted ${r.data.jeNumber || ''}`); }
        catch { showToast && showToast('Saved as draft — posting needs admin role'); }
      }
      reset(); loadRecent();
    } catch (err) {
      showToast && showToast('Failed: ' + (err.response?.data?.error || err.message));
    } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="qbd-form">
        <div className="fhd">{isCheck ? 'Write Checks' : 'Make Deposits'}</div>
        <div className="frow">
          <label>{isCheck ? 'Bank Account' : 'Deposit To'}</label>
          <select value={bankId} onChange={(e) => setBankId(e.target.value)}>
            <option value="">— bank account —</option>
            {banks.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {leafLabel(a.account_name)}</option>)}
          </select>
          <label style={{ width: 70 }}>Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="frow">
          <label>{isCheck ? 'Pay to' : 'Received from'}</label>
          <input style={{ width: 240 }} value={party} onChange={(e) => setParty(e.target.value)} placeholder={isCheck ? 'Payee' : 'Source'} />
          <label style={{ width: 70 }}>Amount</label>
          <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ textAlign: 'right', width: 140 }} />
        </div>
        <div className="frow">
          <label>{isCheck ? 'Expense / Account' : 'From Account'}</label>
          <select value={otherId} onChange={(e) => setOtherId(e.target.value)}>
            <option value="">— account —</option>
            {others.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {leafLabel(a.account_name)}</option>)}
          </select>
        </div>
        <div className="frow">
          <label>Memo</label>
          <input style={{ flex: 1 }} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Memo (optional)" />
        </div>
        <div className="qbd-botbar">
          <span className="qbd-muted">{isCheck ? 'Reduces' : 'Increases'} the bank balance by {fmt(+amount || 0) || '0.00'}</span>
          <span className="sp" />
          <button className="qbd-btn" disabled={busy} onClick={submit} style={{ fontWeight: 'bold' }}>{isCheck ? 'Save & Post Check' : 'Save & Post Deposit'}</button>
        </div>
      </div>

      <div className="qbd-form">
        <div className="fhd">Recent Entries</div>
        <div className="qbd-wbody">
          <table className="qbd-coa">
            <thead><tr><th>DATE</th><th>ENTRY #</th><th>DESCRIPTION</th><th>STATUS</th><th className="qbd-bal">AMOUNT</th></tr></thead>
            <tbody>
              {recent.length === 0 ? <tr><td colSpan={5}><div className="qbd-empty">No entries yet.</div></td></tr> :
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
