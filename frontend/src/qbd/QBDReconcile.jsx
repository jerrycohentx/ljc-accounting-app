import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, bankReconAPI, journalAPI } from '../services/api';
import { useBackupStatus } from './QBDBackupDialog';
import {
  fmt,
  leafLabel,
  todayISO,
  fmtReconDate,
  isCreditCardAccount,
  reconColumnLabels,
  registerDisplayAmounts,
  reconRegisterAmount,
  computeReconcileTotals,
  entrySide,
} from './helpers';

const REGISTER_SPLIT_STORAGE_KEY = 'qbd-recon-register-split-pct';
const HIDE_AFTER_END_KEY = 'qbd-recon-hide-after-end';
const DEFAULT_REGISTER_SPLIT = 50;
// Persist how the reconcile screen is sized so the user never re-does it:
// the statement-vs-register split width and the statement zoom level.
const STMT_SPLIT_STORAGE_KEY = 'qbd-recon-stmt-split-pct';
const STMT_ZOOM_STORAGE_KEY = 'qbd-recon-stmt-zoom';
const STMT_SHOW_STORAGE_KEY = 'qbd-recon-stmt-show';
const DEFAULT_STMT_SPLIT = 38; // statement pane width, % of the split
const DEFAULT_STMT_ZOOM = 100; // percent; 0 means "fit width"

/** Turn a base64 payload from the API into an object URL for an <iframe>. */
function base64ToObjectUrl(b64, mime = 'application/pdf') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function isAfterStatementEnd(postingDate, statementEndDate) {
  if (!postingDate || !statementEndDate) return false;
  return String(postingDate).slice(0, 10) > String(statementEndDate).slice(0, 10);
}

function flat(nodes, out) {
  (nodes || []).forEach((n) => { if (n.is_active) out.push(n); if (n.children) flat(n.children, out); });
  return out;
}

function periodLabel(statementDate) {
  if (!statementDate) return '';
  return String(statementDate).slice(0, 7);
}

/**
 * Best-effort QuickBooks-style transaction type label (CHK / DEP / CHRG / PMT).
 * The ledger does not store a QBD transaction type, so this is derived from the
 * money direction for the account.
 */
function txnType(side, isCard) {
  if (isCard) return side === 'deposit' ? 'CHRG' : 'PMT';
  return side === 'deposit' ? 'DEP' : 'CHK';
}

/**
 * QuickBooks Desktop reconcile register table.
 * Every posted line for the account is shown. A check mark means the line has
 * been matched/cleared. Single-click selects + toggles the check mark;
 * double-click (or Go To) drills into the underlying transaction.
 */
function RegisterTable({
  entries, account, labels, checked, matchedSet, highlightGlId, selectedId, highlightMarked,
  showNum, showType, showDate = true, showPayee = true, onToggle, onSelect, onHover, onDrill, compact, amountSide,
}) {
  if (!entries.length) {
    return <div className="qbd-empty">{compact ? 'None' : 'No transactions for this account.'}</div>;
  }
  const isCard = isCreditCardAccount(account);
  const compactAmtLabel = amountSide === 'deposit'
    ? (isCard ? 'Charge' : 'Deposit')
    : 'Payment';
  return (
    <table className="qbd-reg qbd-recon-reg">
      <thead>
        <tr>
          <th style={{ width: 26 }}>✓</th>
          {showDate && <th className="qbd-d">DATE</th>}
          {showNum && <th className="qbd-je">CHK #</th>}
          {showPayee && <th>PAYEE</th>}
          {showType && <th className="qbd-type">TYPE</th>}
          {compact ? (
            <th className="qbd-amt qbd-recon-amt">{compactAmtLabel}</th>
          ) : (
            <>
              <th className="qbd-amt qbd-recon-amt">{labels.col2}</th>
              <th className="qbd-amt qbd-recon-amt">{labels.col1}</th>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          const isChecked = !!checked[e.id];
          const isMatched = matchedSet.has(e.id);
          const hl = highlightGlId === e.id;
          const isSelected = selectedId === e.id;
          const side = entrySide(e, account);
          const { col1, col2 } = registerDisplayAmounts(e, account);
          const compactAmount = compact ? reconRegisterAmount(e, account) : null;
          return (
            <tr
              key={e.id}
              data-gl-id={e.id}
              className={[hl ? 'hl' : '', isSelected ? 'selected' : '', (highlightMarked && isChecked) ? 'cleared' : '', isMatched ? 'matched' : ''].filter(Boolean).join(' ') || undefined}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => onHover && onHover(e.id)}
              onMouseLeave={() => onHover && onHover(null)}
              onClick={() => { onSelect && onSelect(e.id); onToggle(e.id); }}
              onDoubleClick={() => onDrill && onDrill(e)}
              title="Click to check/uncheck · double-click to open transaction"
            >
              <td style={{ textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => onToggle(e.id)}
                  onClick={(ev) => ev.stopPropagation()}
                  title={isMatched ? 'Matched to statement' : 'Mark cleared'}
                />
              </td>
              {showDate && <td className="qbd-d">{fmtReconDate(e.posting_date)}</td>}
              {showNum && <td className="qbd-je">{e.je_number}</td>}
              {showPayee && <td>{e.je_description || e.description || ''}</td>}
              {showType && <td className="qbd-type">{txnType(side, isCard)}</td>}
              {compact ? (
                <td className="qbd-amt qbd-recon-amt">{compactAmount ? fmt(compactAmount) : ''}</td>
              ) : (
                <>
                  <td className="qbd-amt qbd-recon-amt">{col2 ? fmt(col2) : ''}</td>
                  <td className="qbd-amt qbd-recon-amt">{col1 ? fmt(col1) : ''}</td>
                </>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function useSplitResize(splitRef, setSplitPct, minPct = 18, maxPct = 82) {
  const dragging = useRef(false);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current || !splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.min(maxPct, Math.max(minPct, pct)));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [maxPct, minPct, splitRef, setSplitPct]);

  return useCallback(() => {
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);
}

/** Drill-down: shows the full double-entry behind a register line. */
function TxnDetailModal({ entry, entityId, onClose }) {
  const lines = entry.lines || [];
  let td = 0;
  let tc = 0;
  return (
    <div className="qbd-modal-backdrop" onClick={onClose}>
      <div className="qbd-window" style={{ width: 680, maxHeight: '80vh', margin: 0 }} onClick={(e) => e.stopPropagation()}>
        <div className="qbd-wtitle">🧾 Transaction Detail — {entry.je_number} <span className="x" onClick={onClose}>✕</span></div>
        <div className="qbd-tools">
          <span className="qbd-muted">Date</span><b>{fmtReconDate(entry.posting_date)}</b>
          <span className="qbd-muted" style={{ marginLeft: 14 }}>Memo</span><span>{entry.description || ''}</span>
          <span className="qbd-muted" style={{ marginLeft: 'auto' }}>Status: {entry.status}</span>
        </div>
        <div className="qbd-wbody">
          <table className="qbd-reg">
            <thead><tr><th>ACCOUNT</th><th className="qbd-amt">DEBIT</th><th className="qbd-amt">CREDIT</th></tr></thead>
            <tbody>
              {lines.map((l) => {
                td += +l.debit || 0;
                tc += +l.credit || 0;
                return (
                  <tr key={l.id}>
                    <td>{l.account_number} · {(l.account_name || '').split(':').pop()}</td>
                    <td className="qbd-amt">{(+l.debit) ? fmt(+l.debit) : ''}</td>
                    <td className="qbd-amt">{(+l.credit) ? fmt(+l.credit) : ''}</td>
                  </tr>
                );
              })}
              <tr style={{ fontWeight: 'bold', background: '#eef4fb' }}>
                <td>TOTAL</td>
                <td className="qbd-amt">{fmt(td)}</td>
                <td className="qbd-amt">{fmt(tc)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="qbd-foot">
          <span className="sp" />
          <button type="button" className="qbd-btn" style={{ fontWeight: 'bold' }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export default function QBDReconcile() {
  const { entityId } = useEntity();
  const { showToast } = useOutletContext() || {};
  const [searchParams] = useSearchParams();
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [stmtDate, setStmtDate] = useState(() => {
    const d = searchParams.get('date') || searchParams.get('asOf');
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayISO();
  });
  const [beginBal, setBeginBal] = useState('');
  const [endBal, setEndBal] = useState('');
  const [prepareMsg, setPrepareMsg] = useState('');
  const [prepareBusy, setPrepareBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [data, setData] = useState(null);
  const [checked, setChecked] = useState({});
  const [serviceCharge, setServiceCharge] = useState('0');
  const [interestEarned, setInterestEarned] = useState('0');
  // Note shown when interest / service charge was read off the statement and
  // pre-filled here (because it was not already a booked transaction).
  const [feeNote, setFeeNote] = useState('');
  const [showModify, setShowModify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [highlightGlId, setHighlightGlId] = useState(null);
  const { info: buildInfo } = useBackupStatus();
  const [registerSplitPct, setRegisterSplitPct] = useState(() => {
    const saved = parseFloat(localStorage.getItem(REGISTER_SPLIT_STORAGE_KEY) || '');
    return Number.isFinite(saved) ? saved : DEFAULT_REGISTER_SPLIT;
  });
  // Side-by-side bank statement pane (shows the uploaded PDF next to the register).
  const [statementPdfUrl, setStatementPdfUrl] = useState(null);
  const [showStmt, setShowStmt] = useState(() => localStorage.getItem(STMT_SHOW_STORAGE_KEY) !== 'false');
  const [stmtSplitPct, setStmtSplitPct] = useState(() => {
    const saved = parseFloat(localStorage.getItem(STMT_SPLIT_STORAGE_KEY) || '');
    return Number.isFinite(saved) ? saved : DEFAULT_STMT_SPLIT;
  });
  const [stmtZoom, setStmtZoom] = useState(() => {
    const saved = parseInt(localStorage.getItem(STMT_ZOOM_STORAGE_KEY) || '', 10);
    return Number.isFinite(saved) ? saved : DEFAULT_STMT_ZOOM;
  });

  const registerSplitRef = useRef(null);
  const outerSplitRef = useRef(null);
  const reconStmtFileRef = useRef(null);
  const stmtAutoLoadKeyRef = useRef(null);
  const regScrollRef = useRef(null);
  const prepareTimerRef = useRef(null);
  const prepareRequestRef = useRef(0);
  const dateInputFocusedRef = useRef(false);
  // True once the user (or a URL param / uploaded statement) has chosen an explicit
  // statement date, so we stop auto-suggesting the next period after that.
  const userPickedDateRef = useRef(!!(searchParams.get('date') || searchParams.get('asOf')));
  const statementFileRef = useRef(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [dateDraft, setDateDraft] = useState(stmtDate);
  const [hideAfterEndDate, setHideAfterEndDate] = useState(() => {
    const saved = localStorage.getItem(HIDE_AFTER_END_KEY);
    return saved !== 'false';
  });
  const [beginningOverride, setBeginningOverride] = useState('');
  const [reportModal, setReportModal] = useState(null);
  const [reportMode, setReportMode] = useState('select');
  const [drillEntry, setDrillEntry] = useState(null);
  const [highlightMarked, setHighlightMarked] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [showColsMenu, setShowColsMenu] = useState(false);
  const [showNum, setShowNum] = useState(() => localStorage.getItem('qbd-recon-col-num') !== 'false');
  const [showType, setShowType] = useState(() => localStorage.getItem('qbd-recon-col-type') !== 'false');
  const [showDate, setShowDate] = useState(() => localStorage.getItem('qbd-recon-col-date') !== 'false');
  const [showPayee, setShowPayee] = useState(() => localStorage.getItem('qbd-recon-col-payee') !== 'false');
  const startRegisterResize = useSplitResize(registerSplitRef, setRegisterSplitPct, 18, 82);
  const startStmtResize = useSplitResize(outerSplitRef, setStmtSplitPct, 15, 72);

  useEffect(() => {
    localStorage.setItem(REGISTER_SPLIT_STORAGE_KEY, String(Math.round(registerSplitPct)));
  }, [registerSplitPct]);

  useEffect(() => {
    localStorage.setItem(HIDE_AFTER_END_KEY, hideAfterEndDate ? 'true' : 'false');
  }, [hideAfterEndDate]);

  // Remember the reconcile screen sizing between sessions.
  useEffect(() => {
    localStorage.setItem(STMT_SPLIT_STORAGE_KEY, String(Math.round(stmtSplitPct)));
  }, [stmtSplitPct]);
  useEffect(() => {
    localStorage.setItem(STMT_ZOOM_STORAGE_KEY, String(stmtZoom));
  }, [stmtZoom]);
  useEffect(() => {
    localStorage.setItem(STMT_SHOW_STORAGE_KEY, showStmt ? 'true' : 'false');
  }, [showStmt]);

  // Remember which columns the user wants displayed.
  useEffect(() => { localStorage.setItem('qbd-recon-col-num', showNum ? 'true' : 'false'); }, [showNum]);
  useEffect(() => { localStorage.setItem('qbd-recon-col-type', showType ? 'true' : 'false'); }, [showType]);
  useEffect(() => { localStorage.setItem('qbd-recon-col-date', showDate ? 'true' : 'false'); }, [showDate]);
  useEffect(() => { localStorage.setItem('qbd-recon-col-payee', showPayee ? 'true' : 'false'); }, [showPayee]);

  // Release the object URL for the statement PDF when it changes or on unmount.
  useEffect(() => () => { if (statementPdfUrl) URL.revokeObjectURL(statementPdfUrl); }, [statementPdfUrl]);

  // Switching accounts drops any statement carried over from the previous one.
  useEffect(() => {
    setStatementPdfUrl(null);
    stmtAutoLoadKeyRef.current = null;
  }, [accountId]);

  // Automatically show the statement being reconciled: once a session is open,
  // fetch the stored PDF for this period (if one was uploaded before) and load
  // it into the side-by-side pane — no re-upload needed.
  useEffect(() => {
    if (!started || !entityId || !accountId || statementPdfUrl) return undefined;
    const date = (data && data.statementDate) || stmtDate;
    if (!date) return undefined;
    const key = `${entityId}|${accountId}|${date}`;
    if (stmtAutoLoadKeyRef.current === key) return undefined; // try once per period
    stmtAutoLoadKeyRef.current = key;
    let cancelled = false;
    bankReconAPI.statementFile(entityId, accountId, date)
      .then((r) => {
        const d = r.data || {};
        if (cancelled || !d.found || !d.dataBase64) return;
        const url = base64ToObjectUrl(d.dataBase64, d.mime || 'application/pdf');
        setStatementPdfUrl((prev) => { if (prev) { URL.revokeObjectURL(url); return prev; } return url; });
      })
      .catch(() => { /* no stored statement for this period — fine */ });
    return () => { cancelled = true; };
  }, [started, entityId, accountId, stmtDate, data, statementPdfUrl]);

  const zoomIn = useCallback(() => setStmtZoom((z) => Math.min(250, (z > 0 ? z : 100) + 15)), []);
  const zoomOut = useCallback(() => setStmtZoom((z) => Math.max(40, (z > 0 ? z : 100) - 15)), []);
  const zoomFit = useCallback(() => setStmtZoom(0), []);

  useEffect(() => {
    if (!dateInputFocusedRef.current) setDateDraft(stmtDate);
  }, [stmtDate]);

  const runPrepare = useCallback((dateForPrepare) => {
    if (!entityId || !accountId) {
      setPrepareMsg('');
      setBeginBal('');
      setEndBal('');
      return Promise.resolve();
    }
    const requestId = prepareRequestRef.current + 1;
    prepareRequestRef.current = requestId;
    setPrepareBusy(true);
    const requestedDate = dateForPrepare || undefined;
    return bankReconAPI.prepare(entityId, accountId, requestedDate)
      .then((r) => {
        if (prepareRequestRef.current !== requestId) return;
        const p = r.data;
        // Default to the month after the last completed reconciliation, unless the
        // user has explicitly chosen a date.
        if (!userPickedDateRef.current && p.suggestedStatementDate
            && /^\d{4}-\d{2}-\d{2}$/.test(p.suggestedStatementDate)) {
          setStmtDate((prev) => (prev === p.suggestedStatementDate ? prev : p.suggestedStatementDate));
          setDateDraft(p.suggestedStatementDate);
        }
        if (p.endingBalance != null) setEndBal(String(p.endingBalance));
        else setEndBal('');
        if (p.beginningBalance != null) setBeginBal(String(p.beginningBalance));
        else setBeginBal('');
        setPrepareMsg(p.message || '');
      })
      .catch((e) => {
        if (prepareRequestRef.current !== requestId) return;
        setPrepareMsg(e.response?.data?.error || 'Could not load statement');
        setBeginBal('');
        setEndBal('');
      })
      .finally(() => {
        if (prepareRequestRef.current === requestId) setPrepareBusy(false);
      });
  }, [entityId, accountId]);

  useEffect(() => {
    if (!entityId) return;
    accountAPI.list(entityId).then((r) => {
      const all = flat(Array.isArray(r.data) ? r.data : (r.data?.data || []), []);
      const bankAccounts = all.filter(
        (a) => (a.account_type === 'ASSET' && /^Cash|Bank/.test(a.account_name))
          || (a.account_type === 'LIABILITY' && /Credit-Cards/.test(a.account_name))
      );
      setAccounts(bankAccounts);
      setAccountId((prev) => {
        if (prev) return prev;
        const want = searchParams.get('account');
        const match = want
          ? bankAccounts.find((a) => a.id === want || a.account_number === want)
          : null;
        if (match) return match.id;
        if (entityId === 'ent-ljc') {
          const loneStar = bankAccounts.find((a) => a.account_number === '1001');
          if (loneStar) return loneStar.id;
        }
        return prev;
      });
    }).catch(() => {});
  }, [entityId, searchParams]);

  useEffect(() => {
    if (!entityId || !accountId) {
      setPrepareMsg('');
      return undefined;
    }
    if (prepareTimerRef.current) clearTimeout(prepareTimerRef.current);
    prepareTimerRef.current = setTimeout(() => {
      // Until the user picks a date, ask the server for the suggested next period
      // (month after the last completed reconciliation).
      runPrepare(userPickedDateRef.current ? (stmtDate || undefined) : undefined);
    }, 500);
    return () => {
      if (prepareTimerRef.current) clearTimeout(prepareTimerRef.current);
    };
  }, [entityId, accountId, stmtDate, runPrepare]);

  // Upload a bank statement (PDF or OFX). The server parses it and returns the
  // statement date plus beginning / ending balances, which auto-fill the form.
  const handleStatementUpload = useCallback((file) => {
    if (!file || !entityId || !accountId) return;
    const isPdf = /\.pdf$/i.test(file.name);
    // Keep the PDF so it can be shown side-by-side with the register.
    if (isPdf) {
      const url = URL.createObjectURL(file);
      setStatementPdfUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
      setShowStmt(true);
    }
    const reader = new FileReader();
    setUploadBusy(true);
    reader.onload = () => {
      const payload = { entityId, accountId, fileName: file.name, autoPost: true };
      if (isPdf) {
        const res = String(reader.result || '');
        payload.pdfBase64 = res.includes(',') ? res.split(',')[1] : res;
      } else {
        payload.ofxContent = String(reader.result || '');
      }
      bankReconAPI.importStatement(payload)
        .then((r) => {
          const d = r.data || {};
          if (d.statementDate && /^\d{4}-\d{2}-\d{2}$/.test(d.statementDate)) {
            userPickedDateRef.current = true;
            setStmtDate(d.statementDate);
            setDateDraft(d.statementDate);
          }
          if (d.endingBalance != null) setEndBal(String(d.endingBalance));
          if (d.beginningBalance != null) setBeginBal(String(d.beginningBalance));
          showToast && showToast(d.message || 'Statement imported — dates and balances read from your statement');
          if (d.statementDate) runPrepare(d.statementDate);
        })
        .catch((e) => showToast && showToast('Statement upload failed: ' + (e.response?.data?.error || e.message)))
        .finally(() => {
          setUploadBusy(false);
          if (statementFileRef.current) statementFileRef.current.value = '';
        });
    };
    reader.onerror = () => {
      setUploadBusy(false);
      showToast && showToast('Could not read file');
    };
    if (isPdf) reader.readAsDataURL(file);
    else reader.readAsText(file);
  }, [entityId, accountId, showToast, runPrepare]);

  const applyAutoChecked = useCallback((worksheet) => {
    const ids = worksheet?.suggestedCheckedGlIds || [];
    const next = {};
    ids.forEach((id) => { next[id] = true; });
    // Always pre-check lines already reconciled in this period so a closed/reopened
    // reconciliation loads balanced ($0.00) with its cleared items checked (QBD behavior).
    (worksheet?.entries || []).forEach((e) => {
      if (e.alreadyReconciled || e.clearState === 'reconciled' || e.reconciliation_status === 'RECONCILED') {
        next[e.id] = true;
      }
    });
    setChecked(next);
  }, []);

  const loadWorksheet = useCallback(() => {
    if (!accountId) return Promise.resolve();
    setBusy(true);
    return bankReconAPI.worksheet(entityId, accountId, stmtDate, { autoMatch: true })
      .then((r) => {
        setData(r.data);
        applyAutoChecked(r.data);
        setHighlightGlId(null);
        setStarted(true);
        if (r.data.statementDate) setStmtDate(r.data.statementDate);
        if (r.data.suggestedEndingBalance != null) {
          setEndBal(String(r.data.suggestedEndingBalance));
        } else if (r.data.endingBalance != null) {
          setEndBal(String(r.data.endingBalance));
        }
        if (r.data.displayBeginning != null) setBeginBal(String(r.data.displayBeginning));
        // Pull interest / service charge off the statement — but ONLY when the
        // amount is not already a booked transaction (alreadyRecorded). Statement
        // lines are normally auto-imported, so an interest line that is already a
        // txn stays here at 0 to avoid double-counting. When it is genuinely not
        // in the books, pre-fill it as a reviewable suggestion (posted only when
        // the user clicks Reconcile Now).
        const fee = r.data.feeSuggestions || {};
        const notes = [];
        if (fee.interestEarned && !fee.interestEarned.alreadyRecorded && fee.interestEarned.amount > 0) {
          setInterestEarned((prev) => ((parseFloat(prev || '0') || 0) === 0 ? String(fee.interestEarned.amount) : prev));
          notes.push(`interest ${fmt(fee.interestEarned.amount)}`);
        }
        if (fee.serviceCharge && !fee.serviceCharge.alreadyRecorded && fee.serviceCharge.amount > 0) {
          setServiceCharge((prev) => ((parseFloat(prev || '0') || 0) === 0 ? String(fee.serviceCharge.amount) : prev));
          notes.push(`service charge ${fmt(fee.serviceCharge.amount)}`);
        }
        setFeeNote(notes.length ? `Read from the statement (not yet in your books): ${notes.join(', ')}. Review below — it posts when you Reconcile Now.` : '');
      })
      .catch((e) => showToast && showToast('Failed to load: ' + (e.response?.data?.error || e.message)))
      .finally(() => setBusy(false));
  }, [entityId, accountId, stmtDate, showToast, applyAutoChecked]);

  const start = () => {
    if (!accountId) { showToast && showToast('Pick an account'); return; }
    loadWorksheet();
  };

  const toggle = (id) => {
    setChecked((c) => ({ ...c, [id]: !c[id] }));
  };

  const markAll = () => {
    const next = {};
    entries.forEach((e) => { next[e.id] = true; });
    setChecked(next);
  };

  const unmarkAll = () => {
    setChecked({});
  };

  /** QBD "Matched": check off every line the system matched to the statement. */
  const matched = () => {
    const ids = data?.suggestedCheckedGlIds || [];
    setChecked((c) => {
      const next = { ...c };
      ids.forEach((id) => { next[id] = true; });
      return next;
    });
    showToast && showToast(`Matched ${ids.length} transaction(s) to the statement`);
  };

  const drillEntryOpen = (entry) => {
    if (!entry?.journal_entry_id) {
      showToast && showToast('No transaction detail available for this line');
      return;
    }
    journalAPI.get(entityId, entry.journal_entry_id)
      .then((r) => setDrillEntry(r.data))
      .catch((e) => showToast && showToast('Could not open transaction: ' + (e.response?.data?.error || e.message)));
  };

  /** QBD "Go To": open the currently selected transaction. */
  const goTo = () => {
    const id = selectedId || highlightGlId;
    const entry = entries.find((e) => e.id === id);
    if (!entry) {
      showToast && showToast('Select a transaction first, then Go To');
      return;
    }
    drillEntryOpen(entry);
  };

  const account = data?.account;
  const labels = useMemo(() => reconColumnLabels(account), [account]);
  const isCard = isCreditCardAccount(account);

  const entries = data?.entries || [];
  const matchedGlSet = useMemo(() => new Set(data?.suggestedCheckedGlIds || []), [data?.suggestedCheckedGlIds]);
  const beginning = +(beginningOverride !== '' ? beginningOverride : (data?.displayBeginning ?? data?.beginningBalance ?? beginBal ?? 0));
  const svc = parseFloat(serviceCharge || '0') || 0;
  const int = parseFloat(interestEarned || '0') || 0;
  let markedDeposits = 0;
  let markedPayments = 0;
  let depositCount = 0;
  let paymentCount = 0;
  entries.filter((e) => checked[e.id]).forEach((e) => {
    const side = entrySide(e, account);
    const amt = reconRegisterAmount(e, account) || 0;
    if (side === 'deposit') {
      markedDeposits += amt;
      depositCount += 1;
    } else if (side === 'payment') {
      markedPayments += amt;
      paymentCount += 1;
    }
  });
  const target = parseFloat(endBal || data?.endingBalance || data?.statementMeta?.currentBalance || '0') || 0;
  const calc = computeReconcileTotals({
    beginningBalance: beginning,
    serviceCharge: svc,
    interestEarned: int,
    markedDeposits,
    markedPayments,
    endingBalance: target,
  });
  const difference = calc.difference;
  const balanced = calc.balanced;
  const checkedIds = entries.filter((e) => checked[e.id]).map((e) => e.id);
  const matchedCount = entries.filter((e) => matchedGlSet.has(e.id)).length;

  const scrollRowIntoView = useCallback((glId) => {
    if (!glId) return;
    const row = regScrollRef.current?.querySelector(`[data-gl-id="${glId}"]`);
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (highlightGlId) scrollRowIntoView(highlightGlId);
  }, [highlightGlId, scrollRowIntoView]);

  const periodSession = data?.periodSession || data?.priorSession;
  const needsReopen = periodSession && !periodSession.balanced;
  // A balanced, closed period has no difference to fix but can still be undone
  // (QuickBooks-style "Undo Last Reconciliation") to re-do it.
  const canReopen = !!periodSession && (needsReopen || periodSession.status === 'CLOSED');
  const stmtMeta = data?.statementMeta || {};

  const visibleEntries = useMemo(() => {
    let list = entries;
    if (hideAfterEndDate && stmtDate) {
      list = list.filter((e) => !isAfterStatementEnd(e.posting_date, stmtDate));
    }
    return list;
  }, [entries, hideAfterEndDate, stmtDate]);

  const paymentEntries = useMemo(() => visibleEntries.filter((e) => entrySide(e, account) === 'payment'), [visibleEntries, account]);
  const depositEntries = useMemo(() => visibleEntries.filter((e) => entrySide(e, account) === 'deposit'), [visibleEntries, account]);

  const reopenPeriod = () => {
    if (periodSession?.balanced && !window.confirm(
      'Undo this completed reconciliation? The cleared checkmarks are removed and the period reopens so you can re-do it. '
      + 'No transactions are deleted, and the service charge / interest already posted are kept.'
    )) return;
    setBusy(true);
    bankReconAPI.reopen({ entityId, accountId, statementDate: stmtDate })
      .then(() => { showToast && showToast('Reconciliation reopened — cleared lines restored'); return loadWorksheet(); })
      .catch((e) => showToast && showToast('Reopen failed: ' + (e.response?.data?.error || e.message)))
      .finally(() => setBusy(false));
  };

  const enterAdjustment = () => {
    if (balanced) {
      showToast && showToast('Difference is already zero');
      return;
    }
    if (!window.confirm(
      'Enter Adjustment posts a journal entry for the current difference. Intuit recommends resolving differences manually and consulting your accountant before using this. Continue?'
    )) return;
    setBusy(true);
    bankReconAPI.adjustment({
      entityId,
      accountId,
      statementDate: stmtDate,
      difference,
      glIds: checkedIds,
      serviceCharge: svc,
      interestEarned: int,
      statementEndingBalance: target,
    })
      .then((r) => {
        showToast && showToast(r.data.message || 'Adjustment posted');
        return loadWorksheet();
      })
      .catch((e) => showToast && showToast('Adjustment failed: ' + (e.response?.data?.error || e.message)))
      .finally(() => setBusy(false));
  };

  const finish = () => {
    if (!balanced) { showToast && showToast('Difference must be $0.00 to reconcile'); return; }
    if (checkedIds.length === 0) { showToast && showToast('Mark the cleared transactions first'); return; }
    setBusy(true);
    bankReconAPI.reconcile({
      entityId,
      accountId,
      glIds: checkedIds,
      statementDate: stmtDate,
      statementEndingBalance: target,
      serviceCharge: svc,
      interestEarned: int,
    })
      .then((r) => {
        const toRow = (e) => ({
          id: e.id,
          date: e.posting_date,
          num: e.je_number,
          memo: e.je_description || e.description || '',
          amount: reconRegisterAmount(e, account) || 0,
        });
        const allPayments = entries.filter((e) => entrySide(e, account) === 'payment');
        const allDeposits = entries.filter((e) => entrySide(e, account) === 'deposit');
        setReportModal({
          reconciledCount: r.data.reconciledCount,
          beginningBalance: r.data.beginningBalance,
          endingBalance: r.data.endingBalance,
          serviceCharge: svc,
          interestEarned: int,
          clearedBalance: calc.clearedBalance,
          statementDate: stmtDate,
          accountLabel: `${data.account.account_number} · ${leafLabel(data.account.account_name)}`,
          clearedDeposits: allDeposits.filter((e) => checked[e.id]).map(toRow),
          clearedPayments: allPayments.filter((e) => checked[e.id]).map(toRow),
          unclearedDeposits: allDeposits.filter((e) => !checked[e.id]).map(toRow),
          unclearedPayments: allPayments.filter((e) => !checked[e.id]).map(toRow),
          clearedDepositTotal: markedDeposits,
          clearedPaymentTotal: markedPayments,
        });
        setReportMode('select');
        setStarted(false);
        setData(null);
        setEndBal('');
        setBeginningOverride('');
      })
      .catch((e) => {
        const msg = e.response?.data?.error || e.message;
        showToast && showToast(msg);
        if (e.response?.status === 422) loadWorksheet();
      })
      .finally(() => setBusy(false));
  };

  const reportOverlay = (
    <>
      {reportModal && reportMode === 'select' && (
        <div className="qbd-modal-backdrop" onClick={() => setReportModal(null)}>
          <div className="qbd-modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <div className="qbd-wtitle">
              Select Reconciliation Report
              <span className="x" onClick={() => setReportModal(null)}>✕</span>
            </div>
            <div className="qbd-modal-body" style={{ fontSize: 12, lineHeight: 1.55 }}>
              <p style={{ color: '#2f6b3a', fontWeight: 'bold' }}>✓ Congratulations! Your account is balanced.</p>
              <p><strong>{reportModal.accountLabel}</strong> — statement ending <strong>{reportModal.statementDate}</strong></p>
              <p>{reportModal.reconciledCount} transaction(s) reconciled. Select the type of reconciliation report you would like to see.</p>
            </div>
            <div className="qbd-foot" style={{ flexWrap: 'wrap', gap: 6 }}>
              <button type="button" className="qbd-btn" onClick={() => setReportMode('summary')}>Summary</button>
              <button type="button" className="qbd-btn" onClick={() => setReportMode('detail')}>Detail</button>
              <button type="button" className="qbd-btn" style={{ fontWeight: 'bold' }} onClick={() => setReportMode('both')}>Both</button>
              <span className="sp" />
              <button type="button" className="qbd-btn" onClick={() => setReportModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {reportModal && reportMode !== 'select' && (
        <ReconcileReport
          report={reportModal}
          mode={reportMode}
          onBack={() => setReportMode('select')}
          onClose={() => setReportModal(null)}
        />
      )}
    </>
  );

  if (!started) {
    return (
      <>
      <div className="qbd-form">
        <div className="fhd">Begin Reconciliation</div>
        <div className="qbd-muted" style={{ padding: '0 12px 10px', fontSize: 11, lineHeight: 1.45 }}>
          Get your monthly statement from your bank, then <strong>Banking → Reconcile</strong>.
          Enter the <strong>statement ending date</strong> and verify the <strong>beginning balance</strong> matches your statement.
          Enter the <strong>ending balance</strong> and any <strong>service charge</strong> or <strong>interest</strong> not already recorded.
          <br />
          Every posted transaction for the account is then shown — checks and payments on the left, deposits and credits on the right.
          Lines that match your statement are pre-checked; check off the rest as you find them.
        </div>
        <div className="frow"><label>Account</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">— select bank / card account —</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {leafLabel(a.account_name)}</option>)}
          </select>
        </div>
        {accountId && (
          <>
            <div className="frow"><label>Statement ending date</label>
              <input
                type="date"
                value={dateDraft}
                onFocus={() => { dateInputFocusedRef.current = true; }}
                onBlur={(e) => {
                  dateInputFocusedRef.current = false;
                  const v = e.target.value;
                  if (v) { userPickedDateRef.current = true; setStmtDate(v); }
                  else setDateDraft(stmtDate);
                }}
                onChange={(e) => setDateDraft(e.target.value)}
              />
            </div>
            <div className="frow"><label>Bank statement</label>
              <div>
                <input
                  ref={statementFileRef}
                  type="file"
                  accept=".pdf,.ofx,.qfx"
                  style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) handleStatementUpload(f); }}
                />
                <button
                  type="button"
                  className="qbd-btn"
                  disabled={uploadBusy || !accountId}
                  onClick={() => statementFileRef.current && statementFileRef.current.click()}
                  style={{ fontWeight: 'bold' }}
                >
                  {uploadBusy ? 'Reading statement…' : '⬆ Upload statement (PDF / OFX)'}
                </button>
                <div className="qbd-muted" style={{ fontSize: 10, marginTop: 4 }}>
                  Reads the statement date and beginning / ending balances automatically.
                </div>
              </div>
            </div>
            <div className="frow"><label>Beginning balance</label>
              <input type="text" readOnly value={prepareBusy && !beginBal ? '…' : (beginBal ? fmt(+beginBal) : '—')} style={{ textAlign: 'right', width: 180, background: '#f5f7fa' }} />
            </div>
            <div className="frow"><label>Ending balance</label>
              <input type="number" step="0.01" value={endBal} onChange={(e) => setEndBal(e.target.value)} placeholder="From bank statement" style={{ textAlign: 'right', width: 180 }} />
            </div>
            <div className="frow"><label>Service charge</label>
              <input type="number" step="0.01" min="0" value={serviceCharge} onChange={(e) => setServiceCharge(e.target.value)} placeholder="0.00" style={{ textAlign: 'right', width: 180 }} />
            </div>
            <div className="frow"><label>Interest earned</label>
              <input type="number" step="0.01" min="0" value={interestEarned} onChange={(e) => setInterestEarned(e.target.value)} placeholder="0.00" style={{ textAlign: 'right', width: 180 }} />
            </div>
            {prepareMsg && (
              <div className="qbd-muted" style={{ padding: '0 12px 8px', fontSize: 11, color: /invalid|failed|error|not found/i.test(prepareMsg) ? '#b3261e' : undefined }}>
                {prepareMsg}
              </div>
            )}
          </>
        )}
        <div className="qbd-botbar">
          <span className="sp" />
          <button className="qbd-btn" disabled={busy || prepareBusy || !accountId} onClick={start} style={{ fontWeight: 'bold' }}>Continue →</button>
        </div>
      </div>
      {reportOverlay}
      </>
    );
  }

  const sessionBanner = periodSession ? (
    <div className="qbd-recon-banner" style={{
      background: periodSession.balanced ? '#eaf6ec' : '#fdecea',
      color: periodSession.balanced ? '#2f6b3a' : '#b3261e',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
      borderBottom: '1px solid #c9d3df',
    }}>
      <span>
        {periodSession.balanced ? '✓' : '⚠'} Reconcile {periodLabel(periodSession.statementDate)} ({periodSession.status})
        {periodSession.clearedCount != null ? ` — ${periodSession.clearedCount} cleared lines` : ''}
        {!periodSession.balanced && periodSession.difference != null ? ` — difference ${fmt(periodSession.difference)}` : ''}
      </span>
      {periodSession.message && <span className="qbd-muted">{periodSession.message}</span>}
      {canReopen && (
        <button className="qbd-btn" disabled={busy} onClick={reopenPeriod} style={{ marginLeft: 'auto' }} title="Undo this reconciliation and reopen the period so you can re-do it">
          {needsReopen ? 'Reopen period' : 'Undo / Reopen'}
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="qbd-window qbd-recon-window">
      <div className="qbd-wtitle">Reconcile — {data.account.account_number} · {leafLabel(data.account.account_name)}
        {isCard && <span style={{ fontWeight: 'normal', fontSize: 11, marginLeft: 8 }}>(Credit card)</span>}
        <span className="x" onClick={() => { setStarted(false); setData(null); }}>✕</span>
      </div>
      {sessionBanner}
      <div className="qbd-recon-period">
        <span className="qbd-recon-period-lbl">For period: <b>{data.statementDate || stmtDate}</b></span>
        <span className="qbd-muted">{data.account.account_number} · {leafLabel(data.account.account_name)}</span>
        <span className="qbd-muted">{entries.length} transaction(s) · {matchedCount} matched</span>
        <span className="sp" />
        <label className="qbd-recon-tools-chk" title="QuickBooks Desktop: hide future-dated register items">
          <input type="checkbox" checked={hideAfterEndDate} onChange={(e) => setHideAfterEndDate(e.target.checked)} />
          Hide transactions after the statement&apos;s end date
        </label>
      </div>
      <div className={`qbd-recon-split${statementPdfUrl && showStmt ? '' : ' register-only'}`} ref={outerSplitRef}>
        {statementPdfUrl && showStmt && (
          <>
            <div className="qbd-recon-pane qbd-recon-stmt" style={{ width: `calc(${stmtSplitPct}% - 4px)` }}>
              <div className="qbd-recon-panehead">
                Statement
                <span className="qbd-muted">bank PDF</span>
                <span className="sp" style={{ flex: 1 }} />
                <button type="button" className="qbd-btn qbd-zoom-btn" title="Zoom out" onClick={zoomOut}>−</button>
                <span className="qbd-muted qbd-zoom-lbl">{stmtZoom > 0 ? `${stmtZoom}%` : 'Fit'}</span>
                <button type="button" className="qbd-btn qbd-zoom-btn" title="Zoom in" onClick={zoomIn}>+</button>
                <button type="button" className="qbd-btn qbd-zoom-btn" title="Fit width" onClick={zoomFit}>⤢</button>
                <button type="button" className="qbd-btn qbd-zoom-btn" title="Hide statement" onClick={() => setShowStmt(false)}>✕</button>
              </div>
              <div className="qbd-recon-panebody stmt-with-pdf">
                <div className="qbd-stmt-pdf qbd-stmt-pdf-full">
                  <iframe
                    title="Bank statement"
                    key={stmtZoom}
                    src={`${statementPdfUrl}#toolbar=1&navpanes=0&${stmtZoom > 0 ? `zoom=${stmtZoom}` : 'view=FitH'}`}
                  />
                </div>
              </div>
            </div>
            <div
              className="qbd-recon-gutter"
              role="separator"
              aria-orientation="vertical"
              aria-valuenow={Math.round(stmtSplitPct)}
              title="Drag to resize the statement vs the register"
              onMouseDown={startStmtResize}
            />
          </>
        )}
        <div className="qbd-recon-pane qbd-recon-dual" style={{ width: statementPdfUrl && showStmt ? `calc(${100 - stmtSplitPct}% - 4px)` : '100%' }}>
          {!isCard ? (
            <div className="qbd-recon-register-split" ref={registerSplitRef}>
              <div className="qbd-recon-subpane" style={{ width: `calc(${registerSplitPct}% - 3px)` }}>
                <div className="qbd-recon-panehead">Checks and Payments <span className="qbd-muted">{paymentCount} cleared · {fmt(markedPayments)}</span></div>
                <div className="qbd-recon-panebody" ref={regScrollRef}>
                  <RegisterTable entries={paymentEntries} account={account} labels={labels} checked={checked} matchedSet={matchedGlSet} highlightGlId={highlightGlId} selectedId={selectedId} highlightMarked={highlightMarked} showNum={showNum} showType={showType} showDate={showDate} showPayee={showPayee} onToggle={toggle} onSelect={setSelectedId} onHover={setHighlightGlId} onDrill={drillEntryOpen} compact amountSide="payment" />
                </div>
              </div>
              <div
                className="qbd-recon-gutter qbd-recon-gutter-inner"
                role="separator"
                aria-orientation="vertical"
                aria-valuenow={Math.round(registerSplitPct)}
                title="Drag to resize checks vs deposits"
                onMouseDown={startRegisterResize}
              />
              <div className="qbd-recon-subpane" style={{ width: `calc(${100 - registerSplitPct}% - 3px)` }}>
                <div className="qbd-recon-panehead">Deposits and Other Credits <span className="qbd-muted">{depositCount} cleared · {fmt(markedDeposits)}</span></div>
                <div className="qbd-recon-panebody">
                  <RegisterTable entries={depositEntries} account={account} labels={labels} checked={checked} matchedSet={matchedGlSet} highlightGlId={highlightGlId} selectedId={selectedId} highlightMarked={highlightMarked} showNum={showNum} showType={showType} showDate={showDate} showPayee={showPayee} onToggle={toggle} onSelect={setSelectedId} onHover={setHighlightGlId} onDrill={drillEntryOpen} compact amountSide="deposit" />
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="qbd-recon-panehead">
                Register — mark cleared
                <span className="qbd-muted">{checkedIds.length} marked</span>
              </div>
              <div className="qbd-recon-panebody" ref={regScrollRef}>
                <RegisterTable entries={visibleEntries} account={account} labels={labels} checked={checked} matchedSet={matchedGlSet} highlightGlId={highlightGlId} selectedId={selectedId} highlightMarked={highlightMarked} showNum={showNum} showType={showType} showDate={showDate} showPayee={showPayee} onToggle={toggle} onSelect={setSelectedId} onHover={setHighlightGlId} onDrill={drillEntryOpen} />
              </div>
            </>
          )}
        </div>
      </div>
      <div className="qbd-recon-actionbar">
        <label className="qbd-recon-tools-chk" title="Highlight the transactions you have marked cleared">
          <input type="checkbox" checked={highlightMarked} onChange={(e) => setHighlightMarked(e.target.checked)} />
          Highlight Marked
        </label>
        <span className="sp" />
        <button type="button" className="qbd-btn" disabled={busy} onClick={markAll}>Mark All</button>
        <button type="button" className="qbd-btn" disabled={busy} onClick={unmarkAll}>Unmark All</button>
        <button type="button" className="qbd-btn" disabled={busy} onClick={goTo}>Go To</button>
        <button type="button" className="qbd-btn" disabled={busy} onClick={matched} title="Check off everything matched to the statement">Matched</button>
        <input ref={reconStmtFileRef} type="file" accept=".pdf,.ofx,.qfx" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) handleStatementUpload(f); }} />
        {statementPdfUrl ? (
          <button type="button" className="qbd-btn" disabled={busy} onClick={() => setShowStmt((v) => !v)} title="Show or hide the bank statement next to the register">
            {showStmt ? 'Hide Statement' : 'Show Statement'}
          </button>
        ) : (
          <button type="button" className="qbd-btn" disabled={busy || uploadBusy} onClick={() => reconStmtFileRef.current && reconStmtFileRef.current.click()} title="Attach the bank statement PDF to view it side-by-side">
            {uploadBusy ? 'Reading…' : '⬆ Statement'}
          </button>
        )}
        <div className="qbd-cols-wrap">
          <button type="button" className="qbd-btn" disabled={busy} onClick={() => setShowColsMenu((v) => !v)}>Columns to Display…</button>
          {showColsMenu && (
            <div className="qbd-cols-menu" onMouseLeave={() => setShowColsMenu(false)}>
              <label><input type="checkbox" checked={showDate} onChange={(e) => setShowDate(e.target.checked)} /> Date</label>
              <label><input type="checkbox" checked={showNum} onChange={(e) => setShowNum(e.target.checked)} /> Chk # / Num</label>
              <label><input type="checkbox" checked={showPayee} onChange={(e) => setShowPayee(e.target.checked)} /> Payee / Memo</label>
              <label><input type="checkbox" checked={showType} onChange={(e) => setShowType(e.target.checked)} /> Type</label>
              {!isCard && (
                <button type="button" className="qbd-btn" style={{ fontSize: 10 }} onClick={() => { setRegisterSplitPct(DEFAULT_REGISTER_SPLIT); setShowColsMenu(false); }}>Reset column width</button>
              )}
              <button type="button" className="qbd-btn" style={{ fontSize: 10 }} onClick={() => { setStmtSplitPct(DEFAULT_STMT_SPLIT); setStmtZoom(DEFAULT_STMT_ZOOM); setShowColsMenu(false); }}>Reset statement size &amp; zoom</button>
            </div>
          )}
        </div>
        <span className="sp" />
        {buildInfo?.app?.buildLabel && <span className="qbd-muted">{buildInfo.app.buildLabel}</span>}
      </div>
      {feeNote && (
        <div className="qbd-recon-feenote">
          <span>💡 {feeNote}</span>
          <button type="button" className="qbd-btn" style={{ fontSize: 10, marginLeft: 'auto' }} onClick={() => { setInterestEarned('0'); setServiceCharge('0'); setFeeNote(''); }} title="Discard — the amount is already recorded elsewhere">
            Dismiss
          </button>
        </div>
      )}
      {showModify && (
        <div className="qbd-recon-modify">
          <label>Statement ending
            <input type="date" value={stmtDate} onChange={(e) => setStmtDate(e.target.value)} style={{ marginLeft: 6 }} />
          </label>
          <label style={{ marginLeft: 12 }}>Beginning
            <input type="number" step="0.01" value={beginningOverride !== '' ? beginningOverride : beginning} onChange={(e) => setBeginningOverride(e.target.value)} style={{ width: 100, marginLeft: 6, textAlign: 'right' }} />
          </label>
          <label style={{ marginLeft: 12 }}>Ending
            <input type="number" step="0.01" value={endBal} onChange={(e) => setEndBal(e.target.value)} style={{ width: 100, marginLeft: 6, textAlign: 'right' }} />
          </label>
          <label style={{ marginLeft: 12 }}>Service charge
            <input type="number" step="0.01" value={serviceCharge} onChange={(e) => setServiceCharge(e.target.value)} style={{ width: 80, marginLeft: 6, textAlign: 'right' }} />
          </label>
          <label style={{ marginLeft: 12 }}>Interest
            <input type="number" step="0.01" value={interestEarned} onChange={(e) => setInterestEarned(e.target.value)} style={{ width: 80, marginLeft: 6, textAlign: 'right' }} />
          </label>
          <span className="qbd-muted" style={{ marginLeft: 12 }}>Verify these match your statement if Difference ≠ $0.00</span>
        </div>
      )}
      <div className="qbd-recon-summary-bar">
        <div className="sum-block">
          <div className="sum-row"><span className="sum-lbl">Beginning Balance</span><span className="sum-val">{fmt(beginning)}</span></div>
          <div className="sum-sub">Items you have marked cleared</div>
          <div className="sum-row"><span className="sum-lbl">{depositCount} Deposits and Other Credits</span><span className="sum-val">{fmt(markedDeposits)}</span></div>
          <div className="sum-row"><span className="sum-lbl">{paymentCount} Checks and Payments</span><span className="sum-val">{fmt(markedPayments)}</span></div>
        </div>
        <div className="sum-mid">
          <button type="button" className="qbd-btn" disabled={busy} onClick={() => setShowModify((v) => !v)}>Modify</button>
        </div>
        <div className="sum-block sum-block-right">
          <div className="sum-row"><span className="sum-lbl">Service Charge</span><span className="sum-val">{fmt(svc)}</span></div>
          <div className="sum-row"><span className="sum-lbl">Interest Earned</span><span className="sum-val">{fmt(int)}</span></div>
          <div className="sum-row"><span className="sum-lbl">Ending Balance</span><span className="sum-val">{fmt(target)}</span></div>
          <div className="sum-row"><span className="sum-lbl">Cleared Balance</span><span className="sum-val">{fmt(calc.clearedBalance)}</span></div>
          <div className={`sum-row sum-diff ${balanced ? 'ok' : 'bad'}`}><span className="sum-lbl">Difference</span><span className="sum-val">{fmt(difference)} {balanced ? '✓' : ''}</span></div>
        </div>
      </div>
      <div className="qbd-foot">
        <span className="qbd-muted">{checkedIds.length} transaction(s) marked cleared</span>
        {!balanced && <span className="qbd-muted" style={{ color: '#b3261e', marginLeft: 12 }}>Difference must be $0.00 to reconcile</span>}
        {balanced && <span className="qbd-muted" style={{ color: '#2f6b3a', marginLeft: 12 }}>Ready to reconcile</span>}
        <span className="sp" />
        {!balanced && (
          <button type="button" className="qbd-btn" disabled={busy} onClick={enterAdjustment} title="Last resort — posts a journal entry for the difference">
            Enter Adjustment…
          </button>
        )}
        <button className="qbd-btn" disabled={busy} onClick={() => { setStarted(false); showToast && showToast('Progress saved — nothing posted to the ledger'); }}>Leave</button>
        <button className="qbd-btn" disabled={busy || !balanced || checkedIds.length === 0} onClick={finish} style={{ fontWeight: 'bold', background: balanced ? 'linear-gradient(#dff3e2,#bfe6c8)' : undefined }}>Reconcile Now</button>
      </div>
      {drillEntry && (
        <TxnDetailModal entry={drillEntry} entityId={entityId} onClose={() => setDrillEntry(null)} />
      )}
      {reportOverlay}
    </div>
  );
}

/** QuickBooks-style reconciliation report (Summary / Detail / Both). */
function ReconcileReport({ report, mode, onBack, onClose }) {
  const showSummary = mode === 'summary' || mode === 'both';
  const showDetail = mode === 'detail' || mode === 'both';

  const Section = ({ title, rows, total }) => (
    <div className="qbd-recon-rep-section">
      <div className="qbd-recon-rep-h">{title}{rows.length ? ` (${rows.length})` : ''}</div>
      {rows.length ? (
        <table className="qbd-reg">
          <thead>
            <tr><th className="qbd-d">DATE</th><th className="qbd-je">NUM</th><th>PAYEE / MEMO</th><th className="qbd-amt">AMOUNT</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="qbd-d">{fmtReconDate(r.date)}</td>
                <td className="qbd-je">{r.num}</td>
                <td>{r.memo}</td>
                <td className="qbd-amt">{r.amount ? fmt(r.amount) : ''}</td>
              </tr>
            ))}
            <tr style={{ fontWeight: 'bold', background: '#eef4fb' }}>
              <td colSpan={3}>Total {title}</td>
              <td className="qbd-amt">{fmt(total)}</td>
            </tr>
          </tbody>
        </table>
      ) : <div className="qbd-muted" style={{ padding: '4px 6px' }}>None</div>}
    </div>
  );

  return (
    <div className="qbd-modal-backdrop" onClick={onClose}>
      <div className="qbd-window" style={{ width: 760, maxHeight: '86vh', margin: 0, display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div className="qbd-wtitle">
          Reconciliation Report — {mode === 'both' ? 'Summary + Detail' : (mode === 'summary' ? 'Summary' : 'Detail')}
          <span className="x" onClick={onClose}>✕</span>
        </div>
        <div className="qbd-recon-rep-body">
          <div className="qbd-recon-rep-title">
            <div><strong>{report.accountLabel}</strong></div>
            <div className="qbd-muted">Reconciliation as of statement ending {report.statementDate}</div>
          </div>
          {showSummary && (
            <div className="qbd-recon-rep-summary">
              <div className="sum-row"><span>Beginning Balance</span><span>{fmt(report.beginningBalance)}</span></div>
              <div className="sum-row"><span>Checks and Payments cleared ({report.clearedPayments.length})</span><span>{fmt(-report.clearedPaymentTotal)}</span></div>
              <div className="sum-row"><span>Deposits and Credits cleared ({report.clearedDeposits.length})</span><span>{fmt(report.clearedDepositTotal)}</span></div>
              {report.serviceCharge > 0 && <div className="sum-row"><span>Service Charge</span><span>{fmt(-report.serviceCharge)}</span></div>}
              {report.interestEarned > 0 && <div className="sum-row"><span>Interest Earned</span><span>{fmt(report.interestEarned)}</span></div>}
              <div className="sum-row sum-total"><span>Cleared Balance</span><span>{fmt(report.clearedBalance)}</span></div>
              <div className="sum-row sum-total"><span>Statement Ending Balance</span><span>{fmt(report.endingBalance)}</span></div>
              <div className="sum-row"><span>Difference</span><span>{fmt(report.endingBalance - report.clearedBalance) || '0.00'}</span></div>
            </div>
          )}
          {showDetail && (
            <>
              <Section title="Cleared Checks and Payments" rows={report.clearedPayments} total={report.clearedPaymentTotal} />
              <Section title="Cleared Deposits and Credits" rows={report.clearedDeposits} total={report.clearedDepositTotal} />
              <Section title="Uncleared Checks and Payments" rows={report.unclearedPayments} total={report.unclearedPayments.reduce((s, r) => s + r.amount, 0)} />
              <Section title="Uncleared Deposits and Credits" rows={report.unclearedDeposits} total={report.unclearedDeposits.reduce((s, r) => s + r.amount, 0)} />
            </>
          )}
        </div>
        <div className="qbd-foot">
          <button type="button" className="qbd-btn" onClick={onBack}>← Report type</button>
          <span className="sp" />
          <button type="button" className="qbd-btn" onClick={() => window.print()}>Print</button>
          <button type="button" className="qbd-btn" style={{ fontWeight: 'bold' }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
