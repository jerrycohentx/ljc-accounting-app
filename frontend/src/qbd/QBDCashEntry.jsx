import React, { useEffect, useState, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, journalAPI } from '../services/api';
import { fmt, todayISO, fmtShortDate } from './helpers';
import AccountCombobox, { flattenAccounts } from './AccountCombobox';
import {
  buildEzCheckCsv,
  downloadEzCheckCsv,
  suggestEzCheckCompany,
  EZCHECK_DEFAULT_COMPANY,
} from './ezCheckPrinting';

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
  const [checkNo, setCheckNo] = useState('');
  const [address1, setAddress1] = useState('');
  const [address2, setAddress2] = useState('');
  const [address3, setAddress3] = useState('');
  const [address4, setAddress4] = useState('');
  const [showAddress, setShowAddress] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState([]);
  const [printQueue, setPrintQueue] = useState([]);

  const loadRecent = useCallback(() => {
    if (!entityId) return;
    journalAPI.list(entityId, { limit: 8 }).then((r) => setRecent(r.data?.data || [])).catch(() => {});
  }, [entityId]);

  useEffect(() => {
    if (!entityId) return;
    accountAPI.list(entityId).then((r) => setAccounts(flattenAccounts(Array.isArray(r.data) ? r.data : (r.data?.data || [])))).catch(() => {});
    loadRecent();
  }, [entityId, loadRecent]);

  const banks = accounts.filter((a) => a.type === 'ASSET' && /^Cash/.test(a.name));
  const others = accounts.filter((a) => a.id !== bankId);
  const bankAcct = accounts.find((a) => a.id === bankId);
  const ezCompany = bankAcct ? suggestEzCheckCompany(bankAcct) : EZCHECK_DEFAULT_COMPANY;

  const reset = () => {
    setAmount('');
    setParty('');
    setMemo('');
    setOtherId('');
    setCheckNo('');
    setAddress1('');
    setAddress2('');
    setAddress3('');
    setAddress4('');
  };

  const currentPrintRow = () => ({
    payee: party.trim(),
    amount: +amount || 0,
    checkDate: date,
    checkNo: checkNo.trim(),
    memo: memo.trim(),
    address1: address1.trim(),
    address2: address2.trim(),
    address3: address3.trim(),
    address4: address4.trim(),
  });

  const exportRows = (rows) => {
    const csv = buildEzCheckCsv(rows);
    if (!csv.split(/\r?\n/).filter(Boolean).length || csv.split(/\r?\n/).filter(Boolean).length < 2) {
      showToast && showToast('Nothing to export — need payee and amount');
      return false;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadEzCheckCsv(`ezcheck-${stamp}.csv`, csv);
    showToast && showToast(`Downloaded CSV for ${ezCompany} — Import/Export → Import Checks in ezCheckPrinting`);
    return true;
  };

  const postCheck = async () => {
    const amt = +amount || 0;
    if (!bankId || !otherId || amt <= 0) {
      showToast && showToast('Pick both accounts and a positive amount');
      return null;
    }
    if (isCheck && !party.trim()) {
      showToast && showToast('Payee is required for checks');
      return null;
    }
    const checkLabel = isCheck && checkNo.trim() ? ` #${checkNo.trim()}` : '';
    const desc = `${isCheck ? 'Check' : 'Deposit'}${checkLabel}${party ? ' — ' + party : ''}${memo ? ' (' + memo + ')' : ''}`;
    const lines = isCheck
      ? [
          { accountId: otherId, debit: amt, credit: 0, description: party },
          { accountId: bankId, debit: 0, credit: amt, description: party },
        ]
      : [
          { accountId: bankId, debit: amt, credit: 0, description: party },
          { accountId: otherId, debit: 0, credit: amt, description: party },
        ];
    const jeMemo = isCheck && checkNo.trim()
      ? `${memo || ''}${memo ? ' · ' : ''}Check ${checkNo.trim()}`.trim()
      : memo;
    const r = await journalAPI.create(entityId, {
      description: desc,
      postingDate: date,
      memo: jeMemo,
      lines,
    });
    const id = r.data?.id;
    if (id) {
      try {
        await journalAPI.approve(entityId, id);
        await journalAPI.post(entityId, id);
        showToast && showToast(`Posted ${r.data.jeNumber || ''}`);
      } catch {
        showToast && showToast('Saved as draft — posting needs admin role');
      }
    }
    return r.data;
  };

  const submit = async () => {
    setBusy(true);
    try {
      await postCheck();
      reset();
      loadRecent();
    } catch (err) {
      showToast && showToast('Failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setBusy(false);
    }
  };

  const submitAndExport = async () => {
    const row = currentPrintRow();
    if (isCheck && (!row.payee || !(row.amount > 0))) {
      showToast && showToast('Payee and amount required');
      return;
    }
    setBusy(true);
    try {
      await postCheck();
      exportRows([row]);
      setPrintQueue((q) => [...q, { ...row, queuedAt: Date.now() }]);
      reset();
      loadRecent();
    } catch (err) {
      showToast && showToast('Failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setBusy(false);
    }
  };

  const addToPrintQueue = () => {
    const row = currentPrintRow();
    if (!row.payee || !(row.amount > 0)) {
      showToast && showToast('Payee and amount required');
      return;
    }
    setPrintQueue((q) => [...q, { ...row, queuedAt: Date.now() }]);
    showToast && showToast('Added to print queue (not posted yet)');
  };

  const exportQueue = () => {
    if (!printQueue.length) {
      showToast && showToast('Print queue is empty');
      return;
    }
    exportRows(printQueue);
  };

  const exportCurrentOnly = () => {
    exportRows([currentPrintRow()]);
  };

  return (
    <div>
      <div className="qbd-form">
        <div className="fhd">{isCheck ? 'Write Checks' : 'Make Deposits'}</div>
        {isCheck && (
          <div className="qbd-muted" style={{ marginBottom: 8, lineHeight: 1.4 }}>
            Print on blank stock via <b>ezCheckPrinting</b> (company: <code>{ezCompany}</code>).
            After export: open ezCheckPrinting → <b>Import/Export → Import Checks</b> → map Payee/Amount
            (save the map once) → select checks → <b>PRINT</b>.
          </div>
        )}
        <div className="frow">
          <label>{isCheck ? 'Bank Account' : 'Deposit To'}</label>
          <div style={{ minWidth: 280, flex: 1 }}>
            <AccountCombobox
              accounts={banks}
              value={bankId}
              onChange={setBankId}
              placeholder="— bank account —"
            />
          </div>
          <label style={{ width: 70 }}>Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="frow">
          <label>{isCheck ? 'Pay to' : 'Received from'}</label>
          <input style={{ width: 240 }} value={party} onChange={(e) => setParty(e.target.value)} placeholder={isCheck ? 'Payee' : 'Source'} />
          <label style={{ width: 70 }}>Amount</label>
          <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ textAlign: 'right', width: 140 }} />
        </div>
        {isCheck && (
          <div className="frow">
            <label>Check #</label>
            <input
              style={{ width: 120 }}
              value={checkNo}
              onChange={(e) => setCheckNo(e.target.value)}
              placeholder="optional"
            />
            <button type="button" className="qbd-btn" onClick={() => setShowAddress((v) => !v)}>
              {showAddress ? 'Hide address' : 'Payee address…'}
            </button>
          </div>
        )}
        {isCheck && showAddress && (
          <>
            <div className="frow">
              <label>Address 1</label>
              <input style={{ flex: 1 }} value={address1} onChange={(e) => setAddress1(e.target.value)} />
            </div>
            <div className="frow">
              <label>Address 2</label>
              <input style={{ flex: 1 }} value={address2} onChange={(e) => setAddress2(e.target.value)} />
            </div>
            <div className="frow">
              <label>Address 3</label>
              <input style={{ flex: 1 }} value={address3} onChange={(e) => setAddress3(e.target.value)} placeholder="City, ST ZIP" />
            </div>
            <div className="frow">
              <label>Address 4</label>
              <input style={{ flex: 1 }} value={address4} onChange={(e) => setAddress4(e.target.value)} />
            </div>
          </>
        )}
        <div className="frow">
          <label>{isCheck ? 'Expense / Account' : 'From Account'}</label>
          <div style={{ minWidth: 280, flex: 1 }}>
            <AccountCombobox
              accounts={others}
              value={otherId}
              onChange={setOtherId}
              placeholder="— account —"
            />
          </div>
        </div>
        <div className="frow">
          <label>Memo</label>
          <input style={{ flex: 1 }} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Memo (optional)" />
        </div>
        <div className="qbd-botbar" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span className="qbd-muted">{isCheck ? 'Reduces' : 'Increases'} the bank balance by {fmt(+amount || 0) || '0.00'}</span>
          <span className="sp" />
          {isCheck && (
            <>
              <button className="qbd-btn" disabled={busy} type="button" onClick={addToPrintQueue}>
                Queue for print
              </button>
              <button className="qbd-btn" disabled={busy} type="button" onClick={exportCurrentOnly}>
                Export CSV only
              </button>
              <button className="qbd-btn" disabled={busy} type="button" onClick={submitAndExport} style={{ fontWeight: 'bold' }}>
                Post &amp; export to ezCheck
              </button>
            </>
          )}
          <button className="qbd-btn" disabled={busy} onClick={submit} style={{ fontWeight: isCheck ? 'normal' : 'bold' }}>
            {isCheck ? 'Save & Post Check' : 'Save & Post Deposit'}
          </button>
        </div>
      </div>

      {isCheck && (
        <div className="qbd-form">
          <div className="fhd">ezCheckPrinting queue ({printQueue.length})</div>
          <div className="qbd-wbody">
            <table className="qbd-coa">
              <thead>
                <tr>
                  <th>DATE</th>
                  <th>CHECK #</th>
                  <th>PAYEE</th>
                  <th>MEMO</th>
                  <th className="qbd-bal">AMOUNT</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {printQueue.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="qbd-empty">
                        Queue checks here, then export one CSV for batch import into {ezCompany}.
                      </div>
                    </td>
                  </tr>
                ) : (
                  printQueue.map((r, i) => (
                    <tr key={`${r.queuedAt}-${i}`}>
                      <td className="qbd-num">{r.checkDate}</td>
                      <td>{r.checkNo || '—'}</td>
                      <td>{r.payee}</td>
                      <td>{r.memo}</td>
                      <td className="qbd-bal">{fmt(+r.amount)}</td>
                      <td>
                        <button
                          type="button"
                          className="qbd-btn"
                          onClick={() => setPrintQueue((q) => q.filter((_, j) => j !== i))}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="qbd-botbar">
            <span className="qbd-muted">Target company file: {ezCompany}</span>
            <span className="sp" />
            <button className="qbd-btn" type="button" disabled={!printQueue.length} onClick={() => setPrintQueue([])}>
              Clear queue
            </button>
            <button className="qbd-btn" type="button" disabled={!printQueue.length} onClick={exportQueue} style={{ fontWeight: 'bold' }}>
              Export queue CSV
            </button>
          </div>
        </div>
      )}

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
