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

/** Pull payee / amount / check # from an already-posted JE for print-only export. */
function printRowFromJournal(je) {
  const lines = je.lines || [];
  const creditBank = lines.find((l) => Number(l.credit) > 0);
  const debitExp = lines.find((l) => Number(l.debit) > 0);
  const amount = Number(creditBank?.credit || debitExp?.debit || je.total_debit || 0);
  const desc = String(je.description || '');
  const memo = String(je.memo || '');
  let payee = String(creditBank?.description || debitExp?.description || '').trim();
  if (!payee) {
    const m = desc.match(/Check(?:\s*#\S+)?\s*[—\-–:]\s*(.+?)(?:\s*\(|$)/i);
    payee = (m?.[1] || desc).trim();
  }
  let checkNo = '';
  const fromDesc = desc.match(/Check\s*#\s*([A-Za-z0-9-]+)/i);
  const fromMemo = memo.match(/Check\s*#?\s*([A-Za-z0-9-]+)/i);
  if (fromDesc) checkNo = fromDesc[1];
  else if (fromMemo) checkNo = fromMemo[1];
  let checkDate = je.posting_date || '';
  if (checkDate.includes('T')) checkDate = checkDate.slice(0, 10);
  return {
    payee,
    amount,
    checkDate,
    checkNo,
    memo: memo.replace(/\s*·\s*Check\s+\S+/i, '').trim() || memo,
    address1: '',
    address2: '',
    address3: '',
    address4: '',
    jeNumber: je.je_number || '',
    jeId: je.id,
  };
}

function looksLikeCheck(je) {
  const d = String(je.description || '').toLowerCase();
  const s = String(je.source || '').toLowerCase();
  return d.startsWith('check') || s === 'write-check' || /\bcheck\b/.test(d);
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
    journalAPI.list(entityId, { limit: 20 }).then((r) => setRecent(r.data?.data || [])).catch(() => {});
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
    showToast && showToast(`Print file ready for ${ezCompany} — does not post to the books`);
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
      source: isCheck ? 'write-check' : 'make-deposit',
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

  /** Print path — never posts. */
  const exportForPrint = () => {
    const row = currentPrintRow();
    if (!row.payee || !(row.amount > 0)) {
      showToast && showToast('Payee and amount required to print');
      return;
    }
    if (exportRows([row])) {
      setPrintQueue((q) => [...q, { ...row, queuedAt: Date.now(), books: 'print-only' }]);
    }
  };

  /** Books + print — confirm so it cannot double-post by accident. */
  const submitAndExport = async () => {
    const row = currentPrintRow();
    if (isCheck && (!row.payee || !(row.amount > 0))) {
      showToast && showToast('Payee and amount required');
      return;
    }
    const ok = window.confirm(
      'This will POST a new journal entry to the books, then download a print CSV.\n\n'
      + 'If this check is already booked, click Cancel and use “Export for print” instead.'
    );
    if (!ok) return;
    setBusy(true);
    try {
      await postCheck();
      exportRows([row]);
      setPrintQueue((q) => [...q, { ...row, queuedAt: Date.now(), books: 'posted' }]);
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
    setPrintQueue((q) => [...q, { ...row, queuedAt: Date.now(), books: 'print-only' }]);
    showToast && showToast('Queued for print only — books unchanged');
  };

  const exportQueue = () => {
    if (!printQueue.length) {
      showToast && showToast('Print queue is empty');
      return;
    }
    exportRows(printQueue);
  };

  const exportPostedJe = async (jeSummary) => {
    setBusy(true);
    try {
      const r = await journalAPI.get(entityId, jeSummary.id);
      const je = r.data;
      const row = printRowFromJournal(je);
      if (!row.payee || !(row.amount > 0)) {
        showToast && showToast('Could not read payee/amount from that entry');
        return;
      }
      if (exportRows([row])) {
        setPrintQueue((q) => [...q, { ...row, queuedAt: Date.now(), books: 'already-posted' }]);
      }
    } catch (err) {
      showToast && showToast('Failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setBusy(false);
    }
  };

  const queuePostedJe = async (jeSummary) => {
    setBusy(true);
    try {
      const r = await journalAPI.get(entityId, jeSummary.id);
      const row = printRowFromJournal(r.data);
      if (!row.payee || !(row.amount > 0)) {
        showToast && showToast('Could not read payee/amount from that entry');
        return;
      }
      setPrintQueue((q) => [...q, { ...row, queuedAt: Date.now(), books: 'already-posted' }]);
      showToast && showToast(`Queued ${row.jeNumber || 'entry'} for print — books unchanged`);
    } catch (err) {
      showToast && showToast('Failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="qbd-form">
        <div className="fhd">{isCheck ? 'Write Checks' : 'Make Deposits'}</div>
        {isCheck && (
          <div className="qbd-muted" style={{ marginBottom: 8, lineHeight: 1.45 }}>
            <b>Printing never posts.</b> Use <b>Export for print</b> (or Print on a recent entry) when the
            check is already in the books. Use <b>Save &amp; Post</b> only for a new check that is not booked yet.
            Then in ezCheckPrinting (<code>{ezCompany}</code>): <b>Import/Export → Import Checks → PRINT</b>.
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
              <button
                className="qbd-btn"
                disabled={busy}
                type="button"
                onClick={exportForPrint}
                style={{ fontWeight: 'bold' }}
                title="Downloads CSV for ezCheckPrinting. Does not post a journal entry."
              >
                Export for print
              </button>
              <button
                className="qbd-btn"
                disabled={busy}
                type="button"
                onClick={submitAndExport}
                title="Posts a NEW journal entry, then exports CSV. Confirm first."
              >
                Post new + export…
              </button>
            </>
          )}
          <button className="qbd-btn" disabled={busy} onClick={submit} style={{ fontWeight: isCheck ? 'normal' : 'bold' }}>
            {isCheck ? 'Save & Post (books only)' : 'Save & Post Deposit'}
          </button>
        </div>
      </div>

      {isCheck && (
        <div className="qbd-form">
          <div className="fhd">ezCheckPrinting queue ({printQueue.length})</div>
          <div className="qbd-muted" style={{ marginBottom: 6 }}>
            Queue is print-only. Exporting it never creates or duplicates book entries.
          </div>
          <div className="qbd-wbody">
            <table className="qbd-coa">
              <thead>
                <tr>
                  <th>DATE</th>
                  <th>CHECK #</th>
                  <th>PAYEE</th>
                  <th>MEMO</th>
                  <th>BOOKS</th>
                  <th className="qbd-bal">AMOUNT</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {printQueue.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
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
                      <td className="qbd-muted">
                        {r.books === 'already-posted' ? 'Already posted' : r.books === 'posted' ? 'Just posted' : 'Print only'}
                      </td>
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
        <div className="fhd">{isCheck ? 'Recent entries — print without re-posting' : 'Recent Entries'}</div>
        <div className="qbd-wbody">
          <table className="qbd-coa">
            <thead>
              <tr>
                <th>DATE</th>
                <th>ENTRY #</th>
                <th>DESCRIPTION</th>
                <th>STATUS</th>
                <th className="qbd-bal">AMOUNT</th>
                {isCheck && <th />}
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={isCheck ? 6 : 5}>
                    <div className="qbd-empty">No entries yet.</div>
                  </td>
                </tr>
              ) : (
                recent.map((j) => (
                  <tr key={j.id}>
                    <td className="qbd-num">{fmtShortDate(j.posting_date)}</td>
                    <td>{j.je_number}</td>
                    <td>{j.description}</td>
                    <td>{j.status}</td>
                    <td className="qbd-bal">{fmt(+j.total_debit)}</td>
                    {isCheck && (
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {j.status === 'POSTED' && looksLikeCheck(j) && (
                          <>
                            <button
                              type="button"
                              className="qbd-btn"
                              disabled={busy}
                              onClick={() => exportPostedJe(j)}
                              title="Download ezCheck CSV only — does not post"
                            >
                              Print
                            </button>{' '}
                            <button
                              type="button"
                              className="qbd-btn"
                              disabled={busy}
                              onClick={() => queuePostedJe(j)}
                              title="Add to print queue — does not post"
                            >
                              Queue
                            </button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
