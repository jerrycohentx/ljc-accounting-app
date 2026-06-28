import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, bankReconAPI } from '../services/api';
import {
  fmt,
  leafLabel,
  todayISO,
  isCreditCardAccount,
  reconColumnLabels,
  signedGlDelta,
  registerDisplayAmounts,
  statementDisplayAmounts,
} from './helpers';

const SPLIT_STORAGE_KEY = 'qbd-recon-split-pct';
const DEFAULT_SPLIT = 48;

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
      <thead>
        <tr>
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
          const { col1, col2 } = statementDisplayAmounts(line, account);
          return (
            <tr
              key={line.id}
              data-gl-id={line.matchedGlId || undefined}
              className={[hl ? 'hl' : '', matched ? 'matched' : ''].filter(Boolean).join(' ') || undefined}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => onHover && onHover(line.matchedGlId || null)}
              onMouseLeave={() => onHover && onHover(null)}
              onClick={() => onSelect && onSelect(line)}
            >
              <td className="qbd-d">{line.date}</td>
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

function RegisterTable({ entries, account, labels, checked, highlightGlId, onToggle, onHover }) {
  if (!entries.length) {
    return <div className="qbd-empty">No uncleared register items.</div>;
  }
  return (
    <table className="qbd-reg qbd-recon-reg">
      <thead>
        <tr>
          <th style={{ width: 30 }}>✓</th>
          <th className="qbd-d">DATE</th>
          <th className="qbd-je">ENTRY</th>
          <th>MEMO</th>
          <th className="qbd-amt">{labels.col1}</th>
          <th className="qbd-amt">{labels.col2}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          const isChecked = !!checked[e.id];
          const hl = highlightGlId === e.id;
          const { col1, col2 } = registerDisplayAmounts(e, account);
          return (
            <tr
              key={e.id}
              data-gl-id={e.id}
              className={[hl ? 'hl' : '', isChecked ? 'cleared' : ''].filter(Boolean).join(' ') || undefined}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => onHover && onHover(e.id)}
              onMouseLeave={() => onHover && onHover(null)}
              onClick={() => onToggle(e.id)}
            >
              <td style={{ textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => onToggle(e.id)}
                  onClick={(ev) => ev.stopPropagation()}
                />
              </td>
              <td className="qbd-d">{e.posting_date}</td>
              <td className="qbd-je">{e.je_number}</td>
              <td>{e.je_description || e.description || ''}</td>
              <td className="qbd-amt">{col1 ? fmt(col1) : ''}</td>
              <td className="qbd-amt">{col2 ? fmt(col2) : ''}</td>
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
  const { showToast } = useOutletContext() || {};
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [stmtDate, setStmtDate] = useState(todayISO());
  const [endBal, setEndBal] = useState('');
  const [started, setStarted] = useState(false);
  const [data, setData] = useState(null);
  const [checked, setChecked] = useState({});
  const [busy, setBusy] = useState(false);
  const [highlightGlId, setHighlightGlId] = useState(null);
  const [syncScroll, setSyncScroll] = useState(true);
  const [splitPct, setSplitPct] = useState(() => {
    const saved = parseFloat(localStorage.getItem(SPLIT_STORAGE_KEY) || '');
    return Number.isFinite(saved) ? saved : DEFAULT_SPLIT;
  });

  const splitRef = useRef(null);
  const stmtScrollRef = useRef(null);
  const regScrollRef = useRef(null);
  const startResize = useSplitResize(splitRef, setSplitPct);
  const { onStmtScroll, onRegScroll } = useSyncScroll(syncScroll, stmtScrollRef, regScrollRef);

  useEffect(() => {
    localStorage.setItem(SPLIT_STORAGE_KEY, String(Math.round(splitPct)));
  }, [splitPct]);

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
      .then((r) => {
        setData(r.data);
        setChecked({});
        setHighlightGlId(null);
        setStarted(true);
        setEndBal((prev) => {
          if (prev) return prev;
          if (r.data?.statementMeta?.currentBalance != null) return String(r.data.statementMeta.currentBalance);
          if (r.data?.endingBalance != null) return String(r.data.endingBalance);
          return prev;
        });
      })
      .catch((e) => showToast && showToast('Failed to load: ' + (e.response?.data?.error || e.message)))
      .finally(() => setBusy(false));
  }, [entityId, accountId, stmtDate, showToast]);

  const start = () => {
    if (!accountId) { showToast && showToast('Pick an account'); return; }
    loadWorksheet();
  };

  const toggle = (id) => setChecked((c) => ({ ...c, [id]: !c[id] }));

  const account = data?.account;
  const labels = useMemo(() => reconColumnLabels(account), [account]);
  const isCard = isCreditCardAccount(account);

  const entries = data?.entries || [];
  const statementLines = data?.statementLines || [];
  const beginning = +(data?.beginningBalance || 0);
  const clearedSigned = entries
    .filter((e) => checked[e.id])
    .reduce((s, e) => s + signedGlDelta(e, account), 0);
  const clearedCol1 = entries.filter((e) => checked[e.id]).reduce((s, e) => {
    const { col1 } = registerDisplayAmounts(e, account);
    return s + (+col1 || 0);
  }, 0);
  const clearedCol2 = entries.filter((e) => checked[e.id]).reduce((s, e) => {
    const { col2 } = registerDisplayAmounts(e, account);
    return s + (+col2 || 0);
  }, 0);
  const target = parseFloat(endBal || data?.endingBalance || data?.statementMeta?.currentBalance || '0') || 0;
  const difference = Math.round((target - (beginning + clearedSigned)) * 100) / 100;
  const balanced = Math.abs(difference) < 0.005;
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

  const reopenPeriod = () => {
    setBusy(true);
    bankReconAPI.reopen({ entityId, accountId, statementDate: stmtDate })
      .then(() => { showToast && showToast('Reconciliation reopened — cleared lines restored'); return loadWorksheet(); })
      .catch((e) => showToast && showToast('Reopen failed: ' + (e.response?.data?.error || e.message)))
      .finally(() => setBusy(false));
  };

  const finish = () => {
    if (!balanced) { showToast && showToast('Difference must be $0.00 to reconcile'); return; }
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
        <div className="qbd-botbar"><span className="qbd-muted">QuickBooks-style reconcile: mark cleared register items until difference is zero. Statement appears beside the register — drag the center bar to resize.</span><span className="sp" /><button className="qbd-btn" disabled={busy} onClick={start} style={{ fontWeight: 'bold' }}>Start reconciling →</button></div>
      </div>
    );
  }

  const sessionBanner = periodSession ? (
    <div style={{
      padding: '8px 12px',
      marginBottom: 0,
      borderRadius: 0,
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
    <div className="qbd-window" style={{ maxHeight: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column' }}>
      <div className="qbd-wtitle">Reconcile — {data.account.account_number} · {leafLabel(data.account.account_name)}
        {isCard && <span style={{ fontWeight: 'normal', fontSize: 11, marginLeft: 8 }}>(Credit card)</span>}
        <span className="x" onClick={() => { setStarted(false); setData(null); }}>✕</span>
      </div>
      {sessionBanner}
      <div className="qbd-recon-summary">
        <div><span className="lbl">Statement period</span><span className="val">{stmtPeriod.periodStart || '—'} → {stmtPeriod.periodEnd || data.statementDate}</span></div>
        <div><span className="lbl">Stmt beginning</span><span className="val">{stmtMeta.previousBalance != null ? fmt(stmtMeta.previousBalance) : fmt(beginning)}</span></div>
        <div><span className="lbl">Books beginning</span><span className="val">{fmt(beginning)}</span></div>
        <div><span className="lbl">{labels.cleared1}</span><span className="val">{fmt(clearedCol1) || '0.00'}</span></div>
        <div><span className="lbl">{labels.cleared2}</span><span className="val">{fmt(clearedCol2) || '0.00'}</span></div>
        <div><span className="lbl">Statement ending</span><span className="val">{fmt(target) || '0.00'}</span></div>
        <div>
          <span className="lbl">Difference</span>
          <span className={`val ${balanced ? 'diff-ok' : 'diff-bad'}`}>{fmt(difference) || '0.00'} {balanced ? '✓' : ''}</span>
        </div>
      </div>
      <div className="qbd-tools" style={{ gap: 12 }}>
        <button className="qbd-btn" onClick={() => { setStarted(false); setData(null); }}>← Change</button>
        <span className="qbd-muted">{statementLines.length} statement · {entries.length} register</span>
        {stmtMeta.statementLabel && <span className="qbd-muted">{stmtMeta.statementLabel}</span>}
        <label className="qbd-recon-tools-chk">
          <input type="checkbox" checked={syncScroll} onChange={(e) => setSyncScroll(e.target.checked)} />
          Sync scroll
        </label>
        <button type="button" className="qbd-btn" style={{ fontSize: 10, padding: '2px 8px' }} onClick={() => setSplitPct(DEFAULT_SPLIT)} title="Reset pane width">
          Reset split
        </button>
        <span className="sp" />
        <span className="qbd-muted">Drag center bar to resize · click statement line to toggle register match</span>
      </div>
      <div className="qbd-recon-split" ref={splitRef}>
        <div className="qbd-recon-pane" style={{ width: `${splitPct}%` }}>
          <div className="qbd-recon-panehead">
            {isCard ? 'Card statement' : 'Bank statement'}
            <span className="qbd-muted">{stmtMeta.bankName || stmtMeta.cardName || 'Imported / PDF'}</span>
          </div>
          <div className="qbd-recon-panebody" ref={stmtScrollRef} onScroll={onStmtScroll}>
            <StmtTable
              lines={statementLines}
              account={account}
              labels={labels}
              highlightGlId={highlightGlId}
              onSelect={onStatementSelect}
              onHover={setHighlightGlId}
            />
          </div>
        </div>
        <div
          className="qbd-recon-gutter"
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={Math.round(splitPct)}
          title="Drag to resize panes"
          onMouseDown={startResize}
        />
        <div className="qbd-recon-pane" style={{ width: `${100 - splitPct}%` }}>
          <div className="qbd-recon-panehead">
            Register — mark cleared
            <span className="qbd-muted">{checkedIds.length} marked</span>
          </div>
          <div className="qbd-recon-panebody" ref={regScrollRef} onScroll={onRegScroll}>
            <RegisterTable
              entries={entries}
              account={account}
              labels={labels}
              checked={checked}
              highlightGlId={highlightGlId}
              onToggle={toggle}
              onHover={setHighlightGlId}
            />
          </div>
        </div>
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
