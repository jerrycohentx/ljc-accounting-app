import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useOutletContext, useSearchParams, useNavigate } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, bankReconAPI } from '../services/api';
import { useBackupStatus } from './QBDBackupDialog';
import {
  fmt,
  leafLabel,
  todayISO,
  fmtReconDate,
  isCreditCardAccount,
  reconColumnLabels,
  signedGlDelta,
  registerDisplayAmounts,
  reconRegisterAmount,
  statementDisplayAmounts,
  computeReconcileTotals,
  entrySide,
  matchStatusChip,
} from './helpers';

const SPLIT_STORAGE_KEY = 'qbd-recon-split-pct';
const HIDE_AFTER_END_KEY = 'qbd-recon-hide-after-end';
const SHOW_STMT_KEY = 'qbd-recon-show-statement';
const DEFAULT_SPLIT = 48;

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

function roundAmt(n) {
  return Math.round(Number(n) * 100) / 100;
}

function StmtTable({ lines, account, labels, highlightGlId, onSelect, onHover }) {
  if (!lines.length) {
    return <div className="qbd-empty">No statement lines for this period.</div>;
  }
  return (
    <table className="qbd-reg qbd-recon-stmt">
      <colgroup>
        <col style={{ width: 72 }} />
        <col style={{ width: 52 }} />
        <col />
        <col style={{ width: 88 }} />
        <col style={{ width: 88 }} />
      </colgroup>
      <thead>
        <tr>
          <th style={{ width: 72 }}>STATUS</th>
          <th className="qbd-d">DATE</th>
          <th>MEMO</th>
          <th className="qbd-amt">{labels.col1}</th>
          <th className="qbd-amt">{labels.col2}</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => {
          const hl = highlightGlId && line.matchedGlId === highlightGlId;
          const matched = !!line.matchedGlId;
          const chip = matchStatusChip(line.matchStatus || (matched ? 'matched' : 'unmatched'));
          const { col1, col2 } = statementDisplayAmounts(line, account);
          return (
            <tr
              key={line.id}
              data-gl-id={line.matchedGlId || undefined}
              className={[hl ? 'hl' : '', matched ? 'matched' : '', chip.cls].filter(Boolean).join(' ') || undefined}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => onHover && onHover(line.matchedGlId || null)}
              onMouseLeave={() => onHover && onHover(null)}
              onClick={() => onSelect && onSelect(line)}
            >
              <td><span className={`qbd-match-chip ${chip.cls}`}>{chip.label}</span></td>
              <td className="qbd-d">{fmtReconDate(line.date)}</td>
              <td>{line.description}</td>
              <td className="qbd-amt">{col1 ? fmt(col1) : ''}</td>
              <td className="qbd-amt">{col2 ? fmt(col2) : ''}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RegisterTable({
  entries, account, labels, checked, confirmed, highlightGlId, onToggle, onHover, onEntryDblClick, compact, amountSide,
}) {
  if (!entries.length) {
    return <div className="qbd-empty">{compact ? 'None' : 'No uncleared register items.'}</div>;
  }
  const compactAmtLabel = amountSide === 'deposit'
    ? (isCreditCardAccount(account) ? 'Charge' : 'Deposit')
    : 'Payment';
  return (
    <table className="qbd-reg qbd-recon-reg">
      <colgroup>
        <col style={{ width: 28 }} />
        <col style={{ width: 52 }} />
        {!compact && <col style={{ width: 88 }} />}
        <col />
        <col style={{ width: 92 }} />
      </colgroup>
      <thead>
        <tr>
          <th style={{ width: 30 }}>✓</th>
          <th className="qbd-d">DATE</th>
          {!compact && <th className="qbd-je">ENTRY</th>}
          <th>MEMO</th>
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
          const isPending = isChecked && !confirmed[e.id];
          const hl = highlightGlId === e.id;
          const { col1, col2 } = registerDisplayAmounts(e, account);
          const compactAmount = compact ? reconRegisterAmount(e, account) : null;
          return (
            <tr
              key={e.id}
              data-gl-id={e.id}
              className={[hl ? 'hl' : '', isChecked ? 'cleared' : '', isPending ? 'auto-pending' : ''].filter(Boolean).join(' ') || undefined}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => onHover && onHover(e.id)}
              onMouseLeave={() => onHover && onHover(null)}
              onClick={() => onToggle(e.id, true)}
              onDoubleClick={() => onEntryDblClick && onEntryDblClick(e)}
              title={onEntryDblClick ? 'Double-click to open in register' : undefined}
            >
              <td style={{ textAlign: 'center' }}>
                <input
                  type="checkbox"
                  className={isPending ? 'qbd-chk-pending' : ''}
                  checked={isChecked}
                  onChange={() => onToggle(e.id, true)}
                  onClick={(ev) => ev.stopPropagation()}
                />
              </td>
              <td className="qbd-d">{fmtReconDate(e.posting_date)}</td>
              {!compact && <td className="qbd-je">{e.je_number}</td>}
              <td>{e.je_description || e.description || ''}</td>
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

function useSplitResize(splitRef, setSplitPct) {
  const dragging = useRef(false);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current || !splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.min(75, Math.max(25, pct)));
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
  }, [splitRef, setSplitPct]);

  return useCallback(() => {
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);
}

function useSyncScroll(enabled, stmtRef, regRef) {
  const lock = useRef(null);

  const sync = useCallback((source, target) => {
    if (!enabled || !source || !target || lock.current === target) return;
    lock.current = source;
    const max = source.scrollHeight - source.clientHeight;
    const ratio = max > 0 ? source.scrollTop / max : 0;
    const tMax = target.scrollHeight - target.clientHeight;
    target.scrollTop = ratio * tMax;
    requestAnimationFrame(() => {
      if (lock.current === source) lock.current = null;
    });
  }, [enabled]);

  const onStmtScroll = useCallback(() => {
    sync(stmtRef.current, regRef.current);
  }, [sync, stmtRef, regRef]);

  const onRegScroll = useCallback(() => {
    sync(regRef.current, stmtRef.current);
  }, [sync, stmtRef, regRef]);

  return { onStmtScroll, onRegScroll };
}

export default function QBDReconcile() {
  const { entityId } = useEntity();
  const navigate = useNavigate();
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
  const [confirmed, setConfirmed] = useState({});
  const [serviceCharge, setServiceCharge] = useState('0');
  const [interestEarned, setInterestEarned] = useState('0');
  const [showModify, setShowModify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [highlightGlId, setHighlightGlId] = useState(null);
  const { info: buildInfo } = useBackupStatus();
  const [syncScroll, setSyncScroll] = useState(true);
  const [splitPct, setSplitPct] = useState(() => {
    const saved = parseFloat(localStorage.getItem(SPLIT_STORAGE_KEY) || '');
    return Number.isFinite(saved) ? saved : DEFAULT_SPLIT;
  });

  const splitRef = useRef(null);
  const stmtScrollRef = useRef(null);
  const regScrollRef = useRef(null);
  const importFileRef = useRef(null);
  const prepareTimerRef = useRef(null);
  const prepareRequestRef = useRef(0);
  const dateInputFocusedRef = useRef(false);
  const [dateDraft, setDateDraft] = useState(stmtDate);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState(null);
  const [importFileName, setImportFileName] = useState('');
  const [showUnmatchedOnly, setShowUnmatchedOnly] = useState(false);
  const [hideAfterEndDate, setHideAfterEndDate] = useState(() => {
    const saved = localStorage.getItem(HIDE_AFTER_END_KEY);
    return saved !== 'false';
  });
  const [showStatementPanel, setShowStatementPanel] = useState(() => {
    return localStorage.getItem(SHOW_STMT_KEY) === 'true';
  });
  const [beginningOverride, setBeginningOverride] = useState('');
  const [reportModal, setReportModal] = useState(null);
  const startResize = useSplitResize(splitRef, setSplitPct);
  const { onStmtScroll, onRegScroll } = useSyncScroll(syncScroll, stmtScrollRef, regScrollRef);

  useEffect(() => {
    localStorage.setItem(SPLIT_STORAGE_KEY, String(Math.round(splitPct)));
  }, [splitPct]);

  useEffect(() => {
    localStorage.setItem(HIDE_AFTER_END_KEY, hideAfterEndDate ? 'true' : 'false');
  }, [hideAfterEndDate]);

  useEffect(() => {
    localStorage.setItem(SHOW_STMT_KEY, showStatementPanel ? 'true' : 'false');
  }, [showStatementPanel]);

  useEffect(() => () => {
    if (pdfPreviewUrl) URL.revokeObjectURL(pdfPreviewUrl);
  }, [pdfPreviewUrl]);

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

  const refreshPrepare = useCallback(
    (dateForPrepare) => runPrepare(dateForPrepare),
    [runPrepare]
  );

  const handleImportStatement = async (file) => {
    if (!file || !accountId) return;
    setBusy(true);
    const isPdf = /\.pdf$/i.test(file.name);
    const isOfx = /\.(ofx|qfx)$/i.test(file.name);
    if (!isPdf && !isOfx) {
      showToast && showToast('Use .ofx, .qfx, or .pdf bank statement');
      setBusy(false);
      return;
    }

    try {
      let payload = { entityId, accountId, fileName: file.name, autoPost: true };
      if (isPdf) {
        if (pdfPreviewUrl) URL.revokeObjectURL(pdfPreviewUrl);
        setPdfPreviewUrl(URL.createObjectURL(file));
        setImportFileName(file.name);
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
        payload.pdfBase64 = btoa(binary);
      } else {
        payload.ofxContent = await file.text();
      }

      const res = await bankReconAPI.importStatement(payload);
      if (res.data.endingBalance != null) {
        setEndBal(String(res.data.endingBalance));
      }
      if (res.data.meta?.previousBalance != null) {
        setBeginBal(String(res.data.meta.previousBalance));
      }
      if (res.data.statementDate) {
        setStmtDate(res.data.statementDate);
      }
      showToast && showToast(res.data.message || 'Statement imported');
      if (started) {
        await loadWorksheet();
      } else {
        await refreshPrepare();
      }
    } catch (e) {
      showToast && showToast('Import failed: ' + (e.response?.data?.error || e.message));
    } finally {
      setBusy(false);
      if (importFileRef.current) importFileRef.current.value = '';
    }
  };

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
      runPrepare(stmtDate || undefined);
    }, 500);
    return () => {
      if (prepareTimerRef.current) clearTimeout(prepareTimerRef.current);
    };
  }, [entityId, accountId, stmtDate, runPrepare]);

  const applyAutoChecked = useCallback((worksheet) => {
    const ids = worksheet?.suggestedCheckedGlIds || [];
    const next = {};
    ids.forEach((id) => { next[id] = true; });
    setChecked(next);
    setConfirmed({});
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
        if (r.data.feeSuggestions?.serviceCharge?.amount != null) {
          setServiceCharge(String(r.data.feeSuggestions.serviceCharge.amount));
        }
        if (r.data.feeSuggestions?.interestEarned?.amount != null) {
          setInterestEarned(String(r.data.feeSuggestions.interestEarned.amount));
        }
        const am = r.data.autoMatch;
        if (am && showToast) {
          showToast(`Auto-matched ${am.matchedStmtCount} of ${am.totalStmtLines} statement lines — review ${am.unmatchedRegisterCount} register item(s)`);
        }
      })
      .catch((e) => showToast && showToast('Failed to load: ' + (e.response?.data?.error || e.message)))
      .finally(() => setBusy(false));
  }, [entityId, accountId, stmtDate, showToast, applyAutoChecked]);

  const start = () => {
    if (!accountId) { showToast && showToast('Pick an account'); return; }
    loadWorksheet();
  };

  const toggle = (id, userAction = false) => {
    setChecked((c) => {
      const next = { ...c, [id]: !c[id] };
      if (userAction) {
        setConfirmed((conf) => {
          const n = { ...conf };
          if (next[id]) n[id] = true;
          else delete n[id];
          return n;
        });
      }
      return next;
    });
  };

  const markAll = () => {
    const next = {};
    entries.forEach((e) => { next[e.id] = true; });
    setChecked(next);
  };

  const unmarkAll = () => {
    setChecked({});
    setConfirmed({});
  };

  const acceptAllMatches = () => {
    setConfirmed((conf) => {
      const n = { ...conf };
      Object.keys(checked).forEach((id) => { if (checked[id]) n[id] = true; });
      return n;
    });
    showToast && showToast('All pending matches accepted for review');
  };

  /** QBD bank feeds: Matched — check off all downloaded/auto-matched transactions */
  const runMatched = () => {
    const next = { ...checked };
    (data?.suggestedCheckedGlIds || []).forEach((id) => { next[id] = true; });
    setChecked(next);
    const conf = {};
    Object.keys(next).forEach((id) => { if (next[id]) conf[id] = true; });
    setConfirmed(conf);
    showToast && showToast(`Matched ${(data?.suggestedCheckedGlIds || []).length} transaction(s) for ${stmtDate || data?.statementDate}`);
  };

  const openRegisterEntry = (entry) => {
    if (!accountId || !entry?.id) return;
    navigate(`/register/${accountId}?from=${entry.posting_date}&to=${entry.posting_date}`);
    showToast && showToast('Open register to edit — double-click entry row');
  };

  const rerunAutoMatch = () => loadWorksheet();

  const account = data?.account;
  const labels = useMemo(() => reconColumnLabels(account), [account]);
  const isCard = isCreditCardAccount(account);

  const entries = data?.entries || [];
  const statementLines = data?.statementLines || [];
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

  const glByAmountDate = useMemo(() => {
    const map = new Map();
    for (const e of entries) {
      const amt = roundAmt(signedGlDelta(e, account));
      const key = `${e.posting_date}|${amt}`;
      if (!map.has(key)) map.set(key, e.id);
    }
    return map;
  }, [entries, account]);

  const scrollRowIntoView = useCallback((glId) => {
    if (!glId) return;
    [stmtScrollRef, regScrollRef].forEach((ref) => {
      const row = ref.current?.querySelector(`[data-gl-id="${glId}"]`);
      row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, []);

  useEffect(() => {
    if (highlightGlId) scrollRowIntoView(highlightGlId);
  }, [highlightGlId, scrollRowIntoView]);

  const onStatementSelect = (line) => {
    if (line.matchedGlId && entries.some((e) => e.id === line.matchedGlId)) {
      toggle(line.matchedGlId);
      setHighlightGlId(line.matchedGlId);
      return;
    }
    const amt = roundAmt(line.amount);
    const key = `${line.date}|${amt}`;
    const glId = glByAmountDate.get(key);
    if (glId) {
      toggle(glId);
      setHighlightGlId(glId);
    }
  };

  const periodSession = data?.periodSession || data?.priorSession;
  const needsReopen = periodSession && !periodSession.balanced;
  const stmtMeta = data?.statementMeta || {};
  const stmtPeriod = data?.statementPeriod || {};
  const autoMatchInfo = data?.autoMatch;

  const visibleEntries = useMemo(() => {
    let list = entries;
    if (hideAfterEndDate && stmtDate) {
      list = list.filter((e) => !isAfterStatementEnd(e.posting_date, stmtDate));
    }
    if (!showUnmatchedOnly) return list;
    return list.filter((e) => !matchedGlSet.has(e.id) && !checked[e.id]);
  }, [entries, hideAfterEndDate, stmtDate, showUnmatchedOnly, matchedGlSet, checked]);

  const paymentEntries = useMemo(() => visibleEntries.filter((e) => entrySide(e, account) === 'payment'), [visibleEntries, account]);
  const depositEntries = useMemo(() => visibleEntries.filter((e) => entrySide(e, account) === 'deposit'), [visibleEntries, account]);
  const reviewSummary = autoMatchInfo?.reviewSummary;

  const visibleStatementLines = useMemo(() => {
    if (!showUnmatchedOnly) return statementLines;
    return statementLines.filter((l) => !l.matchedGlId || !matchedGlSet.has(l.matchedGlId));
  }, [statementLines, showUnmatchedOnly, matchedGlSet]);

  const reopenPeriod = () => {
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
        setReportModal({
          reconciledCount: r.data.reconciledCount,
          beginningBalance: r.data.beginningBalance,
          endingBalance: r.data.endingBalance,
          statementDate: stmtDate,
          accountLabel: `${data.account.account_number} · ${leafLabel(data.account.account_name)}`,
        });
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

  if (!started) {
    return (
      <>
        <input
          ref={importFileRef}
          type="file"
          accept=".ofx,.qfx,.pdf,application/pdf"
          style={{ display: 'none' }}
          onChange={(e) => handleImportStatement(e.target.files?.[0])}
        />
        <div className="qbd-form">
          <div className="fhd">Begin Reconciliation</div>
          <div className="qbd-muted" style={{ padding: '0 12px 10px', fontSize: 11, lineHeight: 1.45 }}>
            Get your monthly statement from your bank, then <strong>Banking → Reconcile</strong>.
            Enter the <strong>statement ending date</strong> and verify the <strong>beginning balance</strong> matches your statement.
            Enter the <strong>ending balance</strong> and any <strong>service charge</strong> or <strong>interest</strong> not already in QuickBooks.
            If you use bank feeds, you can usually leave service charge and interest blank.
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
                    if (v) setStmtDate(v);
                    else setDateDraft(stmtDate);
                  }}
                  onChange={(e) => setDateDraft(e.target.value)}
                />
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
              <div className="frow" style={{ alignItems: 'center', gap: 8 }}>
                <label>Statement file</label>
                <button
                  type="button"
                  className="qbd-btn qbd-btn-import"
                  disabled={busy || prepareBusy}
                  onClick={() => importFileRef.current?.click()}
                  title="Upload OFX/QFX or PDF bank statement"
                >
                  Import statement (PDF / OFX)
                </button>
                {importFileName && <span className="qbd-muted" style={{ fontSize: 11 }}>{importFileName}</span>}
              </div>
            </>
          )}
          <div className="qbd-botbar">
            <span className="qbd-muted" style={{ maxWidth: 420, lineHeight: 1.4 }}>
              Auto: bundled statements in <code>data/bank-imports/</code> and email/portal downloads.
              Manual: use <strong>Import statement</strong> above.
            </span>
            <span className="sp" />
            <button className="qbd-btn" disabled={busy || prepareBusy || !accountId} onClick={start} style={{ fontWeight: 'bold' }}>Continue →</button>
          </div>
        </div>
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
      {needsReopen && (
        <button className="qbd-btn" disabled={busy} onClick={reopenPeriod} style={{ marginLeft: 'auto' }}>
          Reopen period
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="qbd-window qbd-recon-window">
      <input
        ref={importFileRef}
        type="file"
        accept=".ofx,.qfx,.pdf,application/pdf"
        style={{ display: 'none' }}
        onChange={(e) => handleImportStatement(e.target.files?.[0])}
      />
      <div className="qbd-wtitle">Reconcile — {data.account.account_number} · {leafLabel(data.account.account_name)}
        {isCard && <span style={{ fontWeight: 'normal', fontSize: 11, marginLeft: 8 }}>(Credit card)</span>}
        <span className="x" onClick={() => { setStarted(false); setData(null); if (pdfPreviewUrl) URL.revokeObjectURL(pdfPreviewUrl); setPdfPreviewUrl(null); }}>✕</span>
      </div>
      {sessionBanner}
      {autoMatchInfo && (
        <div className="qbd-recon-banner" style={{ background: '#e8f4fc', color: '#1f3550', borderBottom: '1px solid #c9d3df' }}>
          Review summary: {reviewSummary?.autoMatched ?? autoMatchInfo.matchedStmtCount} auto-matched · {reviewSummary?.needsReview ?? 0} need review · {reviewSummary?.onStatementOnly ?? autoMatchInfo.unmatchedStmtCount} on statement only
          {autoMatchInfo.unmatchedRegisterCount > 0 && ` · ${autoMatchInfo.unmatchedRegisterCount} register item(s) unmatched`}
        </div>
      )}
      <div className="qbd-recon-header">
        <div className="qbd-recon-header-main">
          <span className="hdr-item"><span className="hdr-lbl">Account</span><span className="hdr-val">{data.account.account_number} · {leafLabel(data.account.account_name)}</span></span>
          <span className="hdr-item"><span className="hdr-lbl">Statement ending</span><span className="hdr-val">{data.statementDate || stmtDate}</span></span>
          <span className="hdr-item"><span className="hdr-lbl">Beginning balance</span><span className="hdr-val">{fmt(beginning)}</span></span>
          <span className="hdr-item">
            <span className="hdr-lbl">Ending balance</span>
            <input
              type="number"
              step="0.01"
              className="qbd-recon-end-input"
              value={endBal}
              onChange={(e) => setEndBal(e.target.value)}
              title="Ending balance from bank statement"
            />
          </span>
          <span className="hdr-item">
            <span className="hdr-lbl">Service charge</span>
            <input type="number" step="0.01" className="qbd-recon-fee-input" value={serviceCharge} onChange={(e) => setServiceCharge(e.target.value)} />
          </span>
          <span className="hdr-item">
            <span className="hdr-lbl">Interest earned</span>
            <input type="number" step="0.01" className="qbd-recon-fee-input" value={interestEarned} onChange={(e) => setInterestEarned(e.target.value)} />
          </span>
        </div>
      </div>
      <div className="qbd-tools qbd-recon-tools" style={{ gap: 8 }}>
        <button className="qbd-btn" onClick={() => { setStarted(false); setData(null); }}>← Change</button>
        <button type="button" className="qbd-btn" disabled={busy} onClick={markAll}>Mark All</button>
        <button type="button" className="qbd-btn" disabled={busy} onClick={unmarkAll}>Unmark All</button>
        <button type="button" className="qbd-btn" disabled={busy} onClick={rerunAutoMatch}>Auto-Match</button>
        <button
          type="button"
          className="qbd-btn"
          disabled={busy}
          onClick={runMatched}
          style={{ fontWeight: 'bold' }}
          title="Bank feeds: check off all downloaded transactions that match your statement"
        >
          Matched
        </button>
        <button type="button" className="qbd-btn" disabled={busy} onClick={acceptAllMatches}>Accept matches</button>
        <button type="button" className="qbd-btn" disabled={busy} onClick={() => setShowModify((v) => !v)}>Modify</button>
        <button type="button" className="qbd-btn" disabled={busy} onClick={() => navigate('/write-checks')}>Write Checks</button>
        <button type="button" className="qbd-btn" disabled={busy} onClick={() => navigate('/make-deposits')}>Make Deposits</button>
        <button
          type="button"
          className="qbd-btn qbd-btn-import"
          disabled={busy}
          onClick={() => importFileRef.current?.click()}
          title="Import OFX/QFX or PDF bank statement"
        >
          📄 Import bank statement
        </button>
        <span className="qbd-muted">{statementLines.length} stmt · {entries.length} reg</span>
        {(importFileName || stmtMeta.statementLabel) && (
          <span className="qbd-muted" title={importFileName || stmtMeta.statementLabel}>
            {(importFileName || stmtMeta.statementLabel).slice(0, 36)}
          </span>
        )}
        <label className="qbd-recon-tools-chk" title="Show imported bank statement beside register (optional)">
          <input type="checkbox" checked={showStatementPanel} onChange={(e) => setShowStatementPanel(e.target.checked)} />
          Show bank statement
        </label>
        <label className="qbd-recon-tools-chk" title="QuickBooks Desktop: hide future-dated register items">
          <input type="checkbox" checked={hideAfterEndDate} onChange={(e) => setHideAfterEndDate(e.target.checked)} />
          Hide after statement end date
        </label>
        <label className="qbd-recon-tools-chk">
          <input type="checkbox" checked={showUnmatchedOnly} onChange={(e) => setShowUnmatchedOnly(e.target.checked)} />
          Unmatched only
        </label>
        <label className="qbd-recon-tools-chk">
          <input type="checkbox" checked={syncScroll} onChange={(e) => setSyncScroll(e.target.checked)} />
          Sync scroll
        </label>
        <button type="button" className="qbd-btn" style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => setSplitPct(DEFAULT_SPLIT)}>Reset split</button>
        <span className="sp" />
        {buildInfo?.app?.buildLabel && <span className="qbd-muted">{buildInfo.app.buildLabel}</span>}
      </div>
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
      <div className={`qbd-recon-split${showStatementPanel ? '' : ' register-only'}`} ref={splitRef}>
        {showStatementPanel && (
        <div className="qbd-recon-pane" style={{ width: `${splitPct}%` }}>
          <div className="qbd-recon-panehead">
            {isCard ? 'Card statement' : 'Bank statement'}
            <span className="qbd-muted">{stmtMeta.bankName || stmtMeta.cardName || 'Import or loaded'}</span>
            {pdfPreviewUrl && <span className="qbd-pill">PDF</span>}
          </div>
          <div className={`qbd-recon-panebody${pdfPreviewUrl ? ' stmt-with-pdf' : ''}`} ref={stmtScrollRef} onScroll={onStmtScroll}>
            {pdfPreviewUrl && (
              <div className="qbd-stmt-pdf">
                <iframe title="Bank statement PDF" src={pdfPreviewUrl} />
              </div>
            )}
            <div className="qbd-stmt-lines">
              <StmtTable
                lines={visibleStatementLines}
                account={account}
                labels={labels}
                highlightGlId={highlightGlId}
                onSelect={onStatementSelect}
                onHover={setHighlightGlId}
              />
            </div>
          </div>
        </div>
        )}
        {showStatementPanel && (
        <div
          className="qbd-recon-gutter"
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={Math.round(splitPct)}
          title="Drag to resize panes"
          onMouseDown={startResize}
        />
        )}
        <div className="qbd-recon-pane qbd-recon-dual" style={{ width: showStatementPanel ? `${100 - splitPct}%` : '100%' }}>
          {!isCard ? (
            <div className="qbd-recon-register-split">
              <div className="qbd-recon-subpane">
                <div className="qbd-recon-panehead">Checks and Payments <span className="qbd-muted">{paymentCount} cleared · {fmt(markedPayments)}</span></div>
                <div className="qbd-recon-panebody" ref={regScrollRef} onScroll={onRegScroll}>
                  <RegisterTable entries={paymentEntries} account={account} labels={labels} checked={checked} confirmed={confirmed} highlightGlId={highlightGlId} onToggle={toggle} onHover={setHighlightGlId} onEntryDblClick={openRegisterEntry} compact amountSide="payment" />
                </div>
              </div>
              <div className="qbd-recon-subpane">
                <div className="qbd-recon-panehead">Deposits and Other Credits <span className="qbd-muted">{depositCount} cleared · {fmt(markedDeposits)}</span></div>
                <div className="qbd-recon-panebody">
                  <RegisterTable entries={depositEntries} account={account} labels={labels} checked={checked} confirmed={confirmed} highlightGlId={highlightGlId} onToggle={toggle} onHover={setHighlightGlId} onEntryDblClick={openRegisterEntry} compact amountSide="deposit" />
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="qbd-recon-panehead">
                Register — mark cleared
                <span className="qbd-muted">{checkedIds.length} marked</span>
              </div>
              <div className="qbd-recon-panebody" ref={regScrollRef} onScroll={onRegScroll}>
                <RegisterTable entries={visibleEntries} account={account} labels={labels} checked={checked} confirmed={confirmed} highlightGlId={highlightGlId} onToggle={toggle} onHover={setHighlightGlId} onEntryDblClick={openRegisterEntry} />
              </div>
            </>
          )}
        </div>
      </div>
      <div className="qbd-recon-footer-totals">
        <span className="tot-item"><span className="tot-lbl">Total deposits</span><span className="tot-val">{depositCount} · {fmt(markedDeposits)}</span></span>
        <span className="tot-item"><span className="tot-lbl">Total checks &amp; payments</span><span className="tot-val">{paymentCount} · {fmt(markedPayments)}</span></span>
        <span className="tot-item"><span className="tot-lbl">Cleared balance</span><span className="tot-val">{fmt(calc.clearedBalance)}</span></span>
        <span className="tot-item"><span className="tot-lbl">Ending balance</span><span className="tot-val">{fmt(target) || '0.00'}</span></span>
        <span className={`tot-item tot-diff ${balanced ? 'diff-ok' : 'diff-bad'}`}>
          <span className="tot-lbl">Difference</span>
          <span className="tot-val">{fmt(difference) || '0.00'} {balanced ? '✓' : ''}</span>
        </span>
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
      {reportModal && (
        <div className="qbd-modal-backdrop" onClick={() => setReportModal(null)}>
          <div className="qbd-modal" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <div className="qbd-wtitle">
              Reconciliation complete
              <span className="x" onClick={() => setReportModal(null)}>✕</span>
            </div>
            <div className="qbd-modal-body" style={{ fontSize: 12, lineHeight: 1.55 }}>
              <p><strong>{reportModal.accountLabel}</strong></p>
              <p>Statement ending: <strong>{reportModal.statementDate}</strong></p>
              <p>{reportModal.reconciledCount} transaction(s) reconciled.</p>
              <p>Beginning balance: <strong>{fmt(reportModal.beginningBalance)}</strong></p>
              <p>Ending balance: <strong>{fmt(reportModal.endingBalance)}</strong></p>
              <p className="qbd-muted" style={{ marginTop: 8 }}>You can view previous reconciliations under Reports → Banking.</p>
            </div>
            <div className="qbd-foot">
              <button type="button" className="qbd-btn" onClick={() => { setReportModal(null); navigate('/reports'); }}>View Reports</button>
              <span className="sp" />
              <button type="button" className="qbd-btn" style={{ fontWeight: 'bold' }} onClick={() => setReportModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
