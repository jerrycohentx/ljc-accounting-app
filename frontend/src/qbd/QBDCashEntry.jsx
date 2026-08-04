import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, journalAPI } from '../services/api';
import { fmt, todayISO, fmtShortDate } from './helpers';
import AccountCombobox, { flattenAccounts } from './AccountCombobox';
import {
  buildEzCheckCsv,
  downloadEzCheckCsv,
  printCheckViaEzCheck,
  suggestEzCheckCompany,
  EZCHECK_DEFAULT_COMPANY,
} from './ezCheckPrinting';

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Pull payee / amount / check # from a JE for print export. */
function printRowFromJournal(je, address = {}) {
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
    address1: address.address1 || '',
    address2: address.address2 || '',
    address3: address.address3 || '',
    address4: address.address4 || '',
    jeNumber: je.je_number || '',
    jeId: je.id,
  };
}

/**
 * True only for entries meant to be cut/printed as a physical check
 * (Write Checks → ezCheckPrinting). Excludes bank OFX deductions, wires,
 * CC schedules, IC no-cash, warehouse advances, reversals, etc.
 */
function isPrintableCheck(je) {
  const s = String(je.source || '').toLowerCase();
  const d = String(je.description || '');
  const dl = d.toLowerCase();
  const m = String(je.memo || '').toLowerCase();
  const num = String(je.je_number || '').toUpperCase();

  if (s === 'write-check') return true;
  // Canonical Write Checks description: "Check — Payee" or "Check #123 — Payee"
  if (/^check(?:\s*#\S+)?\s*[—\-–:]/i.test(d.trim())) return true;

  // Explicit non-check sources / number prefixes
  if (
    s === 'cc-payment-due'
    || s.startsWith('cc-')
    || num.startsWith('CC-PMT')
    || num.startsWith('REV-')
    || num.startsWith('IC-')
    || num.startsWith('TRUEUP')
    || num.startsWith('RECON-')
  ) {
    return false;
  }

  // Bank-posted / non-check cash movements (even if OFX memo says "CHECK")
  if (
    /bank posted|bank fees|ofx|warehouse|dloc|advance|holdback|related-party|prepaid interest|no cash|wire|title wire|phone\/in-person|e-?payment|scheduled payment|credit card|american express|reversal of|tie-out|duplicate amex|net bank fund|seller-financed|mobilization/i.test(dl)
    || /bank-ofx|simmons-advance|wentworth-|loan-event|auto-reversal|cc-payment|amex/i.test(m)
  ) {
    return false;
  }

  return false;
}

function splitCheckLines(je, bankAccounts) {
  const lines = je.lines || [];
  const bankIds = new Set((bankAccounts || []).map((a) => a.id));
  const creditBank =
    lines.find((l) => Number(l.credit) > 0 && bankIds.has(l.account_id))
    || lines.find((l) => Number(l.credit) > 0);
  const debitExp =
    lines.find((l) => Number(l.debit) > 0 && l.account_id !== creditBank?.account_id)
    || lines.find((l) => Number(l.debit) > 0);
  return { creditBank, debitExp };
}

// mode: 'check' = money out of a bank account; 'deposit' = money into a bank account
export default function QBDCashEntry({ mode = 'check' }) {
  const isCheck = mode === 'check';
  const { entityId } = useEntity();
  const { showToast } = useOutletContext() || {};
  const attachInputRef = useRef(null);

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
  const [drafts, setDrafts] = useState([]);
  const [printQueue, setPrintQueue] = useState([]);
  const [linkedJe, setLinkedJe] = useState(null); // { id, jeNumber, status, sourceDocument }
  const [pendingFile, setPendingFile] = useState(null);

  const banks = accounts.filter((a) => a.type === 'ASSET' && /^Cash/.test(a.name));
  const others = accounts.filter((a) => a.id !== bankId);
  const bankAcct = accounts.find((a) => a.id === bankId);
  const ezCompany = bankAcct ? suggestEzCheckCompany(bankAcct) : EZCHECK_DEFAULT_COMPANY;
  const linked = !!linkedJe;
  const linkedPosted = linkedJe?.status === 'POSTED';
  const linkedDraft = linkedJe?.status === 'DRAFT' || linkedJe?.status === 'APPROVED';

  const loadLists = useCallback(() => {
    if (!entityId) return;
    journalAPI.list(entityId, { limit: 25 }).then((r) => setRecent(r.data?.data || [])).catch(() => {});
    journalAPI.list(entityId, { status: 'DRAFT', limit: 40 }).then((r) => setDrafts(r.data?.data || [])).catch(() => {});
  }, [entityId]);

  useEffect(() => {
    if (!entityId) return;
    accountAPI.list(entityId).then((r) => setAccounts(flattenAccounts(Array.isArray(r.data) ? r.data : (r.data?.data || [])))).catch(() => {});
    loadLists();
  }, [entityId, loadLists]);

  const resetFormFields = () => {
    setAmount('');
    setParty('');
    setMemo('');
    setOtherId('');
    setCheckNo('');
    setAddress1('');
    setAddress2('');
    setAddress3('');
    setAddress4('');
    setPendingFile(null);
    if (attachInputRef.current) attachInputRef.current.value = '';
  };

  const clearLinked = () => {
    setLinkedJe(null);
    resetFormFields();
    setDate(todayISO());
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
    jeNumber: linkedJe?.jeNumber || '',
    jeId: linkedJe?.id || '',
  });

  const buildCsvOrToast = (rows) => {
    const csv = buildEzCheckCsv(rows);
    if (!csv.split(/\r?\n/).filter(Boolean).length || csv.split(/\r?\n/).filter(Boolean).length < 2) {
      showToast && showToast('Nothing to print — need payee and amount');
      return null;
    }
    return csv;
  };

  /** CSV only (no local helper). */
  const exportRows = (rows) => {
    const csv = buildCsvOrToast(rows);
    if (!csv) return false;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadEzCheckCsv(`ezcheck-${stamp}.csv`, csv);
    showToast && showToast(`CSV downloaded for ${ezCompany}`);
    return true;
  };

  /** Download + open local ezCheckPrinting helper (actual check printing). */
  const printRows = (rows) => {
    const csv = buildCsvOrToast(rows);
    if (!csv) return false;
    printCheckViaEzCheck(csv);
    showToast && showToast('Opening ezCheckPrinting — Import print_now.csv → PRINT');
    window.setTimeout(() => {
      window.alert(
        'Check sent to ezCheckPrinting.\n\n'
        + '1) Save the CSV if the browser asks (ezcheck-print-now.csv)\n'
        + '2) In the helper popup: Import/Export → Import Checks → print_now.csv\n'
        + '3) Select the check → PRINT\n\n'
        + 'One-time setup if nothing opens: run\n'
        + 'C:\\LJC-LoanTracker\\tools\\Install_ezCheck_Print_Protocol.ps1\n'
        + 'Or double-click Launch_Print_ezCheck.vbs after the CSV downloads.\n\n'
        + `Company: ${ezCompany}`
      );
    }, 900);
    return true;
  };

  const applyJournalToForm = (je) => {
    const { creditBank, debitExp } = splitCheckLines(je, banks);
    const row = printRowFromJournal(je);
    if (creditBank?.account_id) setBankId(creditBank.account_id);
    if (debitExp?.account_id) setOtherId(debitExp.account_id);
    setAmount(String(row.amount || ''));
    setParty(row.payee || '');
    setMemo(row.memo || '');
    setCheckNo(row.checkNo || '');
    if (row.checkDate) setDate(row.checkDate);
    setLinkedJe({
      id: je.id,
      jeNumber: je.je_number,
      status: je.status,
      sourceDocument: je.sourceDocument || null,
      description: je.description,
    });
    setPendingFile(null);
    if (attachInputRef.current) attachInputRef.current.value = '';
  };

  const openJournal = async (jeSummary) => {
    setBusy(true);
    try {
      const r = await journalAPI.get(entityId, jeSummary.id);
      applyJournalToForm(r.data);
      showToast && showToast(
        `Loaded ${r.data.je_number || 'entry'} (${r.data.status}) — print/attach without re-entering`
      );
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      showToast && showToast('Failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setBusy(false);
    }
  };

  const attachToJe = async (jeId, file) => {
    const fileData = await fileToBase64(file);
    await journalAPI.attachDocument(entityId, jeId, {
      fileName: file.name,
      fileMime: file.type || 'application/pdf',
      fileData,
    });
    const refreshed = await journalAPI.get(entityId, jeId);
    setLinkedJe((prev) => (prev && prev.id === jeId
      ? { ...prev, sourceDocument: refreshed.data.sourceDocument || null }
      : prev));
    return refreshed.data;
  };

  const onPickSourceDoc = async (file) => {
    if (!file) return;
    if (linkedJe?.id) {
      setBusy(true);
      try {
        await attachToJe(linkedJe.id, file);
        setPendingFile(null);
        if (attachInputRef.current) attachInputRef.current.value = '';
        showToast && showToast(`Attached ${file.name} to ${linkedJe.jeNumber || 'entry'}`);
      } catch (err) {
        showToast && showToast('Attach failed: ' + (err.response?.data?.error || err.message));
      } finally {
        setBusy(false);
      }
      return;
    }
    setPendingFile(file);
    showToast && showToast(`Will attach ${file.name} when this check is posted`);
  };

  const viewSourceDoc = async () => {
    if (!linkedJe?.id) return;
    try {
      await journalAPI.viewDocument(entityId, linkedJe.id);
    } catch (err) {
      showToast && showToast(err.message || 'No document attached');
    }
  };

  const postNewCheck = async () => {
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
        showToast && showToast('Saved as draft — open it below to review / print / attach');
      }
      if (pendingFile) {
        try {
          await attachToJe(id, pendingFile);
          showToast && showToast(`Attached ${pendingFile.name}`);
        } catch (attachErr) {
          showToast && showToast('Posted, but attach failed: ' + (attachErr.response?.data?.error || attachErr.message));
        }
      }
    }
    return r.data;
  };

  const postLinkedDraft = async () => {
    if (!linkedJe?.id || linkedPosted) return;
    setBusy(true);
    try {
      try {
        await journalAPI.approve(entityId, linkedJe.id);
      } catch {
        /* already approved */
      }
      await journalAPI.post(entityId, linkedJe.id);
      if (pendingFile) {
        await attachToJe(linkedJe.id, pendingFile);
      }
      const refreshed = await journalAPI.get(entityId, linkedJe.id);
      setLinkedJe({
        id: refreshed.data.id,
        jeNumber: refreshed.data.je_number,
        status: refreshed.data.status,
        sourceDocument: refreshed.data.sourceDocument || null,
        description: refreshed.data.description,
      });
      setPendingFile(null);
      showToast && showToast(`Posted ${refreshed.data.je_number || 'entry'} — ready to print`);
      loadLists();
    } catch (err) {
      showToast && showToast('Post failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (linked) {
      if (linkedDraft) return postLinkedDraft();
      showToast && showToast('This entry is already posted — use Print check');
      return;
    }
    setBusy(true);
    try {
      await postNewCheck();
      resetFormFields();
      loadLists();
    } catch (err) {
      showToast && showToast('Failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setBusy(false);
    }
  };

  /** Print path — never posts; opens local ezCheckPrinting. */
  const printCurrentCheck = () => {
    const row = currentPrintRow();
    if (!row.payee || !(row.amount > 0)) {
      showToast && showToast('Payee and amount required to print');
      return;
    }
    if (printRows([row])) {
      setPrintQueue((q) => [...q, {
        ...row,
        queuedAt: Date.now(),
        books: linkedPosted ? 'already-posted' : linkedDraft ? 'draft' : 'print-only',
      }]);
    }
  };

  /** CSV-only download (no printer helper). */
  const exportForPrint = () => {
    const row = currentPrintRow();
    if (!row.payee || !(row.amount > 0)) {
      showToast && showToast('Payee and amount required');
      return;
    }
    exportRows([row]);
  };

  const submitAndExport = async () => {
    if (linked) {
      showToast && showToast('This form is linked to an existing entry — use Print check (won’t double-post)');
      return;
    }
    const row = currentPrintRow();
    if (isCheck && (!row.payee || !(row.amount > 0))) {
      showToast && showToast('Payee and amount required');
      return;
    }
    const ok = window.confirm(
      'This will POST a new journal entry, then download a print CSV.\n\n'
      + 'If a draft/posted entry already exists, Cancel and click Open on that entry instead.'
    );
    if (!ok) return;
    setBusy(true);
    try {
      await postNewCheck();
      exportRows([row]);
      setPrintQueue((q) => [...q, { ...row, queuedAt: Date.now(), books: 'posted' }]);
      resetFormFields();
      loadLists();
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
    setPrintQueue((q) => [...q, {
      ...row,
      queuedAt: Date.now(),
      books: linkedPosted ? 'already-posted' : linkedDraft ? 'draft' : 'print-only',
    }]);
    showToast && showToast('Queued for print — books unchanged');
  };

  const exportQueue = () => {
    if (!printQueue.length) {
      showToast && showToast('Print queue is empty');
      return;
    }
    printRows(printQueue);
  };

  const printFromList = async (jeSummary) => {
    setBusy(true);
    try {
      const r = await journalAPI.get(entityId, jeSummary.id);
      const row = printRowFromJournal(r.data, {
        address1, address2, address3, address4,
      });
      if (!row.payee || !(row.amount > 0)) {
        showToast && showToast('Could not read payee/amount from that entry');
        return;
      }
      if (printRows([row])) {
        setPrintQueue((q) => [...q, {
          ...row,
          queuedAt: Date.now(),
          books: r.data.status === 'POSTED' ? 'already-posted' : 'draft',
        }]);
      }
    } catch (err) {
      showToast && showToast('Failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setBusy(false);
    }
  };

  const pendingChecks = drafts.filter(isPrintableCheck);
  const recentChecks = recent.filter(isPrintableCheck);

  const booksLabel = (b) => {
    if (b === 'already-posted') return 'Already posted';
    if (b === 'posted') return 'Just posted';
    if (b === 'draft') return 'Draft';
    return 'Print only';
  };

  return (
    <div className="qbd-write-checks">
      <div className="qbd-form">
        <div className="fhd">{isCheck ? 'Write Checks' : 'Make Deposits'}</div>
        {isCheck && (
          <div className="qbd-muted" style={{ marginBottom: 8, lineHeight: 1.45 }}>
            Open a <b>printable check</b> below, then <b>Print check</b> to open ezCheckPrinting
            (MICR printing is on your PC — the cloud app cannot drive the printer alone).
            Attachments never create a second journal entry. Company: <code>{ezCompany}</code>.
          </div>
        )}

        {linked && (
          <div
            style={{
              marginBottom: 10,
              padding: '8px 10px',
              background: '#eef6ff',
              border: '1px solid #9db7d8',
              borderRadius: 4,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              alignItems: 'center',
            }}
          >
            <span>
              Linked to <b>{linkedJe.jeNumber || linkedJe.id}</b>
              {' · '}
              {linkedJe.status}
              {linkedJe.description ? ` — ${linkedJe.description}` : ''}
            </span>
            <span className="sp" />
            <button type="button" className="qbd-btn" disabled={busy} onClick={clearLinked}>
              Clear / new check
            </button>
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

        {isCheck && (
          <div className="frow" style={{ alignItems: 'center' }}>
            <label>Source doc</label>
            <input
              ref={attachInputRef}
              type="file"
              accept=".pdf,image/*,.png,.jpg,.jpeg"
              style={{ display: 'none' }}
              onChange={(e) => onPickSourceDoc(e.target.files && e.target.files[0])}
            />
            <button
              type="button"
              className="qbd-btn"
              disabled={busy}
              onClick={() => attachInputRef.current && attachInputRef.current.click()}
            >
              {linkedJe?.sourceDocument?.hasFile || pendingFile ? 'Replace file…' : 'Attach PDF / image…'}
            </button>
            <span className="qbd-muted" style={{ marginLeft: 8 }}>
              {pendingFile
                ? pendingFile.name
                : linkedJe?.sourceDocument?.fileName
                  ? linkedJe.sourceDocument.fileName
                  : linked
                    ? 'Optional — saved on this journal entry'
                    : 'Optional — saved when posted'}
            </span>
            {linkedJe?.sourceDocument?.hasFile && (
              <button type="button" className="qbd-btn" disabled={busy} onClick={viewSourceDoc} style={{ marginLeft: 6 }}>
                View
              </button>
            )}
          </div>
        )}

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
                onClick={printCurrentCheck}
                style={{ fontWeight: 'bold' }}
                title="Downloads check file and opens ezCheckPrinting to print on blank stock. Never posts."
              >
                Print check
              </button>
              <button
                className="qbd-btn"
                disabled={busy}
                type="button"
                onClick={exportForPrint}
                title="Download CSV only — does not open the printer app."
              >
                Download CSV
              </button>
              {!linked && (
                <button
                  className="qbd-btn"
                  disabled={busy}
                  type="button"
                  onClick={submitAndExport}
                  title="Posts a NEW journal entry, then exports CSV."
                >
                  Post new + export…
                </button>
              )}
            </>
          )}
          <button
            className="qbd-btn"
            disabled={busy || (linked && linkedPosted)}
            onClick={submit}
            style={{ fontWeight: isCheck && !linked ? 'normal' : 'bold' }}
          >
            {linkedDraft
              ? 'Post this draft'
              : linkedPosted
                ? 'Already posted'
                : isCheck
                  ? 'Save & Post (new)'
                  : 'Save & Post Deposit'}
          </button>
        </div>
      </div>

      {isCheck && (
        <div className="qbd-form qbd-write-checks-panel">
          <div className="fhd">Checks waiting to print ({pendingChecks.length})</div>
          <div className="qbd-muted qbd-write-checks-hint">
            Only entries created from <b>Write Checks</b> (or description starting with “Check —”).
            Bank fees, wires, CC payments, warehouse advances, and IC drafts are excluded — review those under Journal.
          </div>
          <div className="qbd-wbody">
            <table className="qbd-coa qbd-write-checks-table">
              <thead>
                <tr>
                  <th className="col-date">DATE</th>
                  <th className="col-je">ENTRY #</th>
                  <th className="col-desc">DESCRIPTION</th>
                  <th className="col-status">STATUS</th>
                  <th className="col-amt qbd-bal">AMOUNT</th>
                  <th className="col-actions" />
                </tr>
              </thead>
              <tbody>
                {pendingChecks.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="qbd-empty">
                        No printable check drafts. Use Recent below for already-posted checks (e.g. State Comptroller), or fill the form for a new check.
                      </div>
                    </td>
                  </tr>
                ) : (
                  pendingChecks.map((j) => (
                    <tr key={j.id} style={linkedJe?.id === j.id ? { background: '#eef6ff' } : undefined}>
                      <td className="col-date qbd-num">{fmtShortDate(j.posting_date)}</td>
                      <td className="col-je">{j.je_number}</td>
                      <td className="col-desc" title={j.description}>{j.description}</td>
                      <td className="col-status">{j.status}</td>
                      <td className="col-amt qbd-bal">{fmt(+j.total_debit)}</td>
                      <td className="col-actions">
                        <button type="button" className="qbd-btn" disabled={busy} onClick={() => openJournal(j)} style={{ fontWeight: 'bold' }}>
                          Open
                        </button>{' '}
                        <button type="button" className="qbd-btn" disabled={busy} onClick={() => printFromList(j)}>
                          Print check
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {isCheck && (
        <div className="qbd-form qbd-write-checks-panel">
          <div className="fhd">ezCheckPrinting queue ({printQueue.length})</div>
          <div className="qbd-muted qbd-write-checks-hint">
            Print queue never posts or duplicates books.
          </div>
          <div className="qbd-wbody">
            <table className="qbd-coa qbd-write-checks-table">
              <thead>
                <tr>
                  <th className="col-date">DATE</th>
                  <th className="col-check">CHECK #</th>
                  <th className="col-payee">PAYEE</th>
                  <th className="col-desc">MEMO</th>
                  <th className="col-books">BOOKS</th>
                  <th className="col-amt qbd-bal">AMOUNT</th>
                  <th className="col-actions" />
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
                      <td className="col-date qbd-num">{r.checkDate}</td>
                      <td className="col-check">{r.checkNo || '—'}</td>
                      <td className="col-payee" title={r.payee}>{r.payee}</td>
                      <td className="col-desc" title={r.memo}>{r.memo}</td>
                      <td className="col-books qbd-muted">{booksLabel(r.books)}</td>
                      <td className="col-amt qbd-bal">{fmt(+r.amount)}</td>
                      <td className="col-actions">
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
              Print queue
            </button>
          </div>
        </div>
      )}

      <div className="qbd-form qbd-write-checks-panel">
        <div className="fhd">{isCheck ? `Recent printable checks (${recentChecks.length})` : 'Recent Entries'}</div>
        {isCheck && (
          <div className="qbd-muted qbd-write-checks-hint">
            Posted Write Checks only — Open / Print without re-posting. Other journals stay on the Journal screen.
          </div>
        )}
        <div className="qbd-wbody">
          <table className="qbd-coa qbd-write-checks-table">
            <thead>
              <tr>
                <th className="col-date">DATE</th>
                <th className="col-je">ENTRY #</th>
                <th className="col-desc">DESCRIPTION</th>
                <th className="col-status">STATUS</th>
                <th className="col-amt qbd-bal">AMOUNT</th>
                {isCheck && <th className="col-actions" />}
              </tr>
            </thead>
            <tbody>
              {(isCheck ? recentChecks : recent).length === 0 ? (
                <tr>
                  <td colSpan={isCheck ? 6 : 5}>
                    <div className="qbd-empty">{isCheck ? 'No printable checks in recent entries yet.' : 'No entries yet.'}</div>
                  </td>
                </tr>
              ) : (
                (isCheck ? recentChecks : recent).map((j) => (
                  <tr key={j.id} style={linkedJe?.id === j.id ? { background: '#eef6ff' } : undefined}>
                    <td className="col-date qbd-num">{fmtShortDate(j.posting_date)}</td>
                    <td className="col-je">{j.je_number}</td>
                    <td className="col-desc" title={j.description}>{j.description}</td>
                    <td className="col-status">{j.status}</td>
                    <td className="col-amt qbd-bal">{fmt(+j.total_debit)}</td>
                    {isCheck && (
                      <td className="col-actions">
                        <button
                          type="button"
                          className="qbd-btn"
                          disabled={busy}
                          onClick={() => openJournal(j)}
                          style={{ fontWeight: 'bold' }}
                        >
                          Open
                        </button>{' '}
                        <button type="button" className="qbd-btn" disabled={busy} onClick={() => printFromList(j)}>
                          Print check
                        </button>
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
