import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useOutletContext, useSearchParams, useNavigate } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, accountingAPI, bankReconAPI, journalAPI, reconReportAPI, mgmtReportAPI } from '../services/api';
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
import { ReconHtmlPreviewModal } from './QBDReconReports';
import AccountCombobox from './AccountCombobox';
import CreateAccountModal from './CreateAccountModal';
import {
  accountFromSearchParams,
  resolveAccountId,
  resolveDeepLinkDate,
  shouldAutoOpenRecon,
  workingPeriodFromContext,
  monthlyBooksPath,
} from './reconDeepLink';

const REGISTER_SPLIT_STORAGE_KEY = 'qbd-recon-register-split-pct';
const HIDE_AFTER_END_KEY = 'qbd-recon-hide-after-end';
const DEFAULT_REGISTER_SPLIT = 50;
// Persist how the reconcile screen is sized so the user never re-does it:
// the statement-vs-register split width and the statement zoom level.
const STMT_SPLIT_STORAGE_KEY = 'qbd-recon-stmt-split-pct';
const STMT_ZOOM_STORAGE_KEY = 'qbd-recon-stmt-zoom';
const STMT_SHOW_STORAGE_KEY = 'qbd-recon-stmt-show';
// The in-progress reconciliation (entity/account/date). URL params only survive
// browser Back; this survives FULL round trips — review drafts, approve, come
// back via Banking → Reconcile — which land on a bare /reconcile.
const RECON_IN_PROGRESS_KEY = 'qbd-recon-in-progress';
/** Cleared checkmarks for an in-progress worksheet — survive category fixes + reloads. */
const RECON_CHECKED_PREFIX = 'qbd-recon-checked:';
const DEFAULT_STMT_SPLIT = 38; // statement pane width, % of the split
const DEFAULT_STMT_ZOOM = 100; // percent; 0 means "fit width"

function reconCheckedStorageKey(entityId, accountToken, periodKey) {
  return `${RECON_CHECKED_PREFIX}${entityId || ''}:${accountToken || ''}:${periodKey || ''}`;
}

/** Stabilize across statement-date drift (e.g. 2026-02-01 vs month-end). */
function reconPeriodKey(statementDate) {
  const d = isoDateOnly(statementDate) || String(statementDate || '').slice(0, 10);
  return d ? d.slice(0, 7) : '';
}

function readSavedCheckedIds(entityId, accountId, statementDate, accountNumber = '') {
  const period = reconPeriodKey(statementDate);
  const day = isoDateOnly(statementDate);
  const tokens = [accountId, accountNumber].filter(Boolean);
  const periods = [period, day].filter(Boolean);
  const ids = new Set();
  for (const token of tokens) {
    for (const p of periods) {
      try {
        const raw = JSON.parse(localStorage.getItem(reconCheckedStorageKey(entityId, token, p)) || 'null');
        if (Array.isArray(raw)) raw.forEach((id) => ids.add(String(id)));
      } catch { /* ignore */ }
    }
  }
  return [...ids];
}

function writeSavedCheckedIds(entityId, accountId, statementDate, checkedMap, accountNumber = '') {
  const period = reconPeriodKey(statementDate);
  const day = isoDateOnly(statementDate);
  const ids = Object.keys(checkedMap || {}).filter((id) => checkedMap[id]).map(String);
  const tokens = [accountId, accountNumber].filter(Boolean);
  const periods = [period, day].filter(Boolean);
  for (const token of tokens) {
    for (const p of periods) {
      const key = reconCheckedStorageKey(entityId, token, p);
      try {
        if (!ids.length) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(ids));
      } catch { /* storage full/blocked */ }
    }
  }
}

function clearSavedCheckedIds(entityId, accountId, statementDate, accountNumber = '') {
  const period = reconPeriodKey(statementDate);
  const day = isoDateOnly(statementDate);
  const tokens = [accountId, accountNumber].filter(Boolean);
  const periods = [period, day].filter(Boolean);
  for (const token of tokens) {
    for (const p of periods) {
      try { localStorage.removeItem(reconCheckedStorageKey(entityId, token, p)); } catch { /* ignore */ }
    }
  }
}

/** Turn a base64 payload from the API into an object URL for an <iframe>. */
function base64ToObjectUrl(b64, mime = 'application/pdf') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function isoDateOnly(value) {
  if (value == null || value === '') return '';
  const m = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function isAfterStatementEnd(postingDate, statementEndDate) {
  const post = isoDateOnly(postingDate);
  const end = isoDateOnly(statementEndDate);
  if (!post || !end) return false;
  return post > end;
}

function flat(nodes, out) {
  (nodes || []).forEach((n) => { if (n.is_active) out.push(n); if (n.children) flat(n.children, out); });
  return out;
}

// Internal plumbing — real balances, but no external statement to reconcile against.
// Checked first so "Cash Clearing" can't sneak in on the leading "Cash".
const INTERNAL_ACCOUNT = /clearing|in transit|undeposited|holdback|due from|due to|suspense/i;

// Authoritative bank/card accounts that receive monthly statements — see
// config/bank-import-targets.js and config/recon-bank-folders.js. Number-based
// matching avoids dropping Lone Star when the COA name is "Lone Star Bank ckg-7367"
// instead of "Cash - Lone Star Bank".
const RECON_ACCOUNT_NUMBERS = {
  'ent-ljc': ['1000', '1001', '1002', '2010'],
};

function reconcilableNumbersForEntity(entityId) {
  return new Set((RECON_ACCOUNT_NUMBERS[entityId] || []).map(String));
}

/**
 * Reconcilable = an account with a real statement from a bank or card issuer.
 */
function isReconcilableAccount(a, entityId) {
  const num = String(a?.account_number || '');
  const allowed = reconcilableNumbersForEntity(entityId);
  if (allowed.size && num && allowed.has(num)) return true;

  const name = String(a?.account_name || '');
  if (INTERNAL_ACCOUNT.test(name)) return false;
  if (a?.account_type === 'ASSET') return /^cash\b/i.test(name);
  if (a?.account_type === 'LIABILITY') return /^credit card\b/i.test(name);
  return false;
}

function periodLabel(statementDate) {
  if (!statementDate) return '';
  return String(statementDate).slice(0, 7);
}

// Next month's period-end date, for "Close & Advance". Bank statements are
// month-end dated, so return the last day of the following month; the Begin
// screen's prepare step refines it if the real statement date differs.
function nextStatementDate(statementDate) {
  if (!statementDate || !/^\d{4}-\d{2}-\d{2}$/.test(statementDate)) return '';
  const [y, m] = statementDate.split('-').map(Number);
  const nextMonth = m === 12 ? 1 : m + 1;
  const nextYear = m === 12 ? y + 1 : y;
  const lastDay = new Date(nextYear, nextMonth, 0).getDate();
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

/**
 * QuickBooks Desktop reconcile register table.
 * Every posted line for the account is shown. A check mark means the line has
 * been matched/cleared. Single-click selects + toggles the check mark;
 * double-click (or Go To) drills into the underlying transaction.
 * Column headers are sortable (date, payee, category, amount).
 * Type is omitted — Payments/Charges (or Checks/Deposits) panes already separate sides.
 */
function categoryLabel(entry) {
  if (!entry) return '';
  if (entry.category_label) return entry.category_label;
  const num = entry.category_account_number;
  const name = entry.category_account_name;
  if (!num && !name) return '';
  const leaf = String(name || '').includes(':')
    ? String(name).split(':').pop().trim()
    : String(name || '').trim();
  return leaf ? `${num} ${leaf}` : String(num || '');
}

/** Strip statement-period noise from register Payee (period is already in the worksheet header). */
function formatReconPayee(text) {
  return String(text || '')
    .replace(/^Amex(?:\s+stmt\s+\d{4}-\d{2}-\d{2})?:\s*/i, '')
    .replace(/^Categorize\s+\d{4}\s*→\s*\d{4}:\s*/i, '')
    .replace(/^OFX Import:\s*/i, '')
    .trim();
}

function RegisterTable({
  entries, account, labels, checked, matchedSet, highlightGlId, selectedId, highlightMarked,
  showNum, showDate = true, showPayee = true, showCategory = true,
  onToggle, onSelect, onHover, onDrill, compact, amountSide,
}) {
  const [sortKey, setSortKey] = useState('date');
  const [sortDir, setSortDir] = useState('asc');

  const isCard = isCreditCardAccount(account);
  const compactAmtLabel = amountSide === 'deposit'
    ? (isCard ? 'Charge' : 'Deposit')
    : 'Payment';

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'date' ? 'asc' : 'asc');
    }
  };

  const sortMark = (key) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const sortedEntries = useMemo(() => {
    const rows = [...(entries || [])];
    const dir = sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'date') {
        cmp = String(a.posting_date || '').localeCompare(String(b.posting_date || ''));
      } else if (sortKey === 'payee') {
        cmp = formatReconPayee(a.je_description || a.description || '')
          .localeCompare(formatReconPayee(b.je_description || b.description || ''), undefined, { sensitivity: 'base' });
      } else if (sortKey === 'num') {
        cmp = String(a.je_number || '').localeCompare(String(b.je_number || ''), undefined, { numeric: true });
      } else if (sortKey === 'category') {
        cmp = categoryLabel(a).localeCompare(categoryLabel(b), undefined, { sensitivity: 'base' });
      } else if (sortKey === 'amount') {
        const aa = Math.abs(Number(reconRegisterAmount(a, account)) || 0);
        const bb = Math.abs(Number(reconRegisterAmount(b, account)) || 0);
        cmp = aa - bb;
      }
      if (cmp === 0) {
        cmp = String(a.posting_date || '').localeCompare(String(b.posting_date || ''))
          || String(a.id).localeCompare(String(b.id));
      }
      return cmp * dir;
    });
    return rows;
  }, [entries, sortKey, sortDir, account]);

  const SortTh = ({ colKey, className, children, style }) => (
    <th
      className={className}
      style={{ ...style, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      onClick={() => toggleSort(colKey)}
      title={`Sort by ${children}`}
    >
      {children}{sortMark(colKey)}
    </th>
  );

  if (!entries.length) {
    return <div className="qbd-empty">{compact ? 'None' : 'No transactions for this account.'}</div>;
  }

  return (
    <table className="qbd-reg qbd-recon-reg">
      <thead>
        <tr>
          <th style={{ width: 26 }}>✓</th>
          {showDate && <SortTh colKey="date" className="qbd-d">DATE</SortTh>}
          {showNum && <SortTh colKey="num" className="qbd-je">CHK #</SortTh>}
          {showPayee && <SortTh colKey="payee">PAYEE</SortTh>}
          {showCategory && <SortTh colKey="category" className="qbd-cat">CATEGORY</SortTh>}
          {compact ? (
            <SortTh colKey="amount" className="qbd-amt qbd-recon-amt">{compactAmtLabel}</SortTh>
          ) : (
            <>
              <SortTh colKey="amount" className="qbd-amt qbd-recon-amt">{labels.col2}</SortTh>
              <SortTh colKey="amount" className="qbd-amt qbd-recon-amt">{labels.col1}</SortTh>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        {sortedEntries.map((e) => {
          const isChecked = !!checked[e.id];
          const isMatched = matchedSet.has(e.id);
          const hl = highlightGlId === e.id;
          const isSelected = selectedId === e.id;
          const { col1, col2 } = registerDisplayAmounts(e, account);
          const compactAmount = compact ? reconRegisterAmount(e, account) : null;
          const cat = categoryLabel(e);
          const rawPayee = e.je_description || e.description || '';
          const payee = formatReconPayee(rawPayee);
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
              title="Click to check/uncheck · double-click to open transaction detail"
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
              {showPayee && <td title={rawPayee !== payee ? rawPayee : undefined}>{payee}</td>}
              {showCategory && (
                <td className="qbd-cat" title={e.category_is_split ? 'Split transaction — double-click for full detail' : (e.category_account_name || cat)}>
                  {cat || <span className="qbd-muted">—</span>}
                </td>
              )}
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

/** Short vendor label for "Create rule" checkbox (Amex / bank memo → payee words). */
function vendorRuleHint(description) {
  let t = String(description || '')
    .replace(/^Amex\s+merchant\s+credit:\s*/i, '')
    .replace(/^Amex(?:\s+stmt\s+\d{4}-\d{2}-\d{2})?:\s*/i, '')
    .replace(/\s*\(corrected[^)]*\)\s*$/i, '')
    .replace(/\s+-\s+FITID:.*$/i, '')
    .trim();
  if (!t) return 'this vendor';
  const words = t
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z0-9*]+|[^A-Za-z0-9*.]+$/g, ''))
    .filter((w) => /[A-Za-z]/.test(w) && w.length >= 2)
    .slice(0, 4);
  return (words.join(' ') || t).slice(0, 40);
}

/** Drill-down: shows the full double-entry behind a register line; allows reclass + reverse during recon. */
function applyReclassHistoryToLines(lines, reclassHistory = []) {
  if (!Array.isArray(lines) || !lines.length) return lines || [];
  if (!Array.isArray(reclassHistory) || !reclassHistory.length) return lines;

  // Latest unreverted reclass per original line wins (supports chained Fix category).
  const latestByLine = new Map();
  for (const r of reclassHistory) {
    if (!r?.lineId || !r?.toAccount) continue;
    latestByLine.set(String(r.lineId), r);
  }
  if (!latestByLine.size) return lines;

  return lines.map((l) => {
    const r = latestByLine.get(String(l.id));
    if (!r) {
      return {
        ...l,
        debit: Number(l.debit) || 0,
        credit: Number(l.credit) || 0,
        _reclassed: false,
      };
    }
    return {
      ...l,
      account_id: r.toAccount.id,
      account_number: r.toAccount.account_number,
      account_name: r.toAccount.account_name,
      debit: Number(l.debit) || 0,
      credit: Number(l.credit) || 0,
      _reclassed: true,
      _sourceLineId: l.id,
    };
  }).filter((l) => (Number(l.debit) || 0) > 0.00001 || (Number(l.credit) || 0) > 0.00001);
}

function TxnDetailModal({
  entry,
  entityId,
  reconcileAccountId,
  accounts = [],
  onClose,
  onUpdated,
  onReversed,
  onAccountCreated,
  onVendorRuleApplied,
  showToast,
}) {
  const [liveEntry, setLiveEntry] = useState(entry);
  useEffect(() => { setLiveEntry(entry); }, [entry]);

  const rawLines = liveEntry.lines || [];
  const reclassHistory = liveEntry.reclassHistory || [];
  const lines = useMemo(
    () => applyReclassHistoryToLines(rawLines, reclassHistory),
    [rawLines, reclassHistory]
  );
  const [busy, setBusy] = useState(false);
  const [reclassLineId, setReclassLineId] = useState(null);
  const [reclassAccountId, setReclassAccountId] = useState('');
  /** After a category fix: offer Create rule without racing the account picker. */
  const [ruleOffer, setRuleOffer] = useState(null); // { accountId, accountLabel, vendorHint }
  const [createOpen, setCreateOpen] = useState(false);
  const [localAccounts, setLocalAccounts] = useState(accounts);
  const attachInputRef = useRef(null);
  useEffect(() => { setLocalAccounts(accounts); }, [accounts]);
  const canReverse = liveEntry.status === 'POSTED' && !liveEntry.reversed_by_je_id && !liveEntry.reverses_je_id;
  const canEditDraft = liveEntry.status === 'DRAFT';
  const vendorHint = useMemo(() => vendorRuleHint(liveEntry.description), [liveEntry.description]);
  let td = 0;
  let tc = 0;

  const refreshEntry = () => journalAPI.get(entityId, liveEntry.id)
    .then((res) => {
      setLiveEntry(res.data);
      onUpdated && onUpdated(res.data);
      return res.data;
    });

  const attachSupportingDoc = (file) => {
    if (!file) return;
    setBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const fileData = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      journalAPI.attachDocument(entityId, liveEntry.id, {
        fileName: file.name,
        fileMime: file.type || 'application/pdf',
        fileData,
      })
        .then(() => {
          showToast && showToast(`Saved supporting document: ${file.name}`);
          return refreshEntry();
        })
        .catch((e) => window.alert(e.response?.data?.error || e.message))
        .finally(() => {
          setBusy(false);
          if (attachInputRef.current) attachInputRef.current.value = '';
        });
    };
    reader.onerror = () => {
      setBusy(false);
      window.alert('Could not read that file');
    };
    reader.readAsDataURL(file);
  };

  const doReverse = () => {
    const label = liveEntry.je_number || 'this transaction';
    if (!window.confirm(
      `Delete ${label} from the books?\n\n` +
      `This removes it from the reconcile register by posting an offsetting entry (the original stays in the audit trail).`
    )) return;
    setBusy(true);
    journalAPI.reverse(entityId, liveEntry.id)
      .then((r) => {
        showToast && showToast(`Deleted — ${r.data?.reversalJeNumber || 'offset posted'}`);
        if (typeof onReversed === 'function') {
          onReversed(r.data);
          return null;
        }
        return refreshEntry();
      })
      .catch((e) => window.alert(e.response?.data?.error || e.message))
      .finally(() => setBusy(false));
  };

  const startReclass = (line) => {
    // Map display line back to the original JE line id (chained reclass keeps source id).
    const raw = rawLines.find((l) => String(l.id) === String(line._sourceLineId || line.id))
      || rawLines.find((l) => String(l.id) === String(line.id))
      || rawLines.find((l) => String(l.account_id) === String(line.account_id)
        && Math.abs((Number(l.debit) || 0) - (Number(line.debit) || 0)) < 0.005
        && Math.abs((Number(l.credit) || 0) - (Number(line.credit) || 0)) < 0.005)
      || rawLines.find((l) => String(l.account_id) === String(line.account_id));
    setReclassLineId(raw?.id || line._sourceLineId || line.id);
    setReclassAccountId('');
    setRuleOffer(null);
  };

  const saveVendorRule = async (accountId, accountLabel) => {
    if (!accountId) return null;
    const ruleRes = await accountingAPI.createVendorRule(entityId, {
      accountId,
      description: liveEntry.description || '',
      label: accountLabel ? `Vendor → ${accountLabel}` : undefined,
      applyToOpenDrafts: false,
      postMatchingDrafts: false,
      applyToPendingImports: true,
      postMatchingPendingImports: false,
      // Also reclass other posted charges from this vendor (e.g. 2nd Sam's Club Fuel).
      applyToPostedJournals: true,
      bankAccountIds: reconcileAccountId ? [reconcileAccountId] : [],
      excludeJournalIds: liveEntry.id ? [liveEntry.id] : [],
    });
    return ruleRes?.data || {};
  };

  const applyReclass = (accountIdOverride, accountsOverride) => {
    const targetId = accountIdOverride || reclassAccountId;
    const acctList = accountsOverride || localAccounts;
    if (!reclassLineId || !targetId) {
      showToast && showToast('Pick the account for this category');
      return Promise.resolve();
    }
    const target = acctList.find((a) => a.id === targetId);
    const toNum = target?.account_number || target?.number || '';
    const toName = leafLabel(target?.account_name || target?.name || '');
    const toLabel = target ? `${toNum} · ${toName}` : 'the new account';
    setBusy(true);
    return journalAPI.reclassOffset(entityId, liveEntry.id, {
      lineId: reclassLineId,
      accountId: targetId,
      // Do not auto-learn here — Create rule is an explicit next step after the category sticks.
      learnRule: false,
      bankAccountIds: reconcileAccountId ? [reconcileAccountId] : [],
    })
      .then((r) => {
        showToast && showToast(r.data?.message || `Category → ${toLabel}`);
        setReclassLineId(null);
        setReclassAccountId('');
        // Keep the modal focused on Create rule so it isn't missed.
        setRuleOffer({
          accountId: targetId,
          accountLabel: toLabel,
          vendorHint,
        });
        return refreshEntry();
      })
      .catch((e) => window.alert(e.response?.data?.error || e.message))
      .finally(() => setBusy(false));
  };

  const onPickReclassAccount = (accountId) => {
    if (!accountId) {
      setReclassAccountId('');
      return;
    }
    setReclassAccountId(accountId);
    // Selecting an account applies the category immediately — no separate Save click.
    applyReclass(accountId);
  };

  const confirmCreateVendorRule = async () => {
    if (!ruleOffer?.accountId) return;
    setBusy(true);
    try {
      const payload = await saveVendorRule(ruleOffer.accountId, ruleOffer.accountLabel);
      const pat = payload?.rule?.pattern || vendorHint;
      const posted = payload?.postedUpdate || {};
      const n = Number(posted.reclassed) || 0;
      const matched = Number(posted.matched) || 0;
      showToast && showToast(
        n > 0
          ? `Rule saved — “${pat}” → ${ruleOffer.accountLabel}. Updated ${n} other charge${n === 1 ? '' : 's'}.`
          : matched > 0
            ? `Rule saved — “${pat}” → ${ruleOffer.accountLabel}. Other matches already on that category.`
            : `Rule saved — “${pat}” → ${ruleOffer.accountLabel} (applies to matching charges going forward).`
      );
      setRuleOffer(null);
      if (typeof onVendorRuleApplied === 'function') {
        onVendorRuleApplied({
          pattern: pat,
          accountId: ruleOffer.accountId,
          accountLabel: ruleOffer.accountLabel,
          postedUpdate: posted,
        });
      }
    } catch (err) {
      window.alert(err.response?.data?.error || err.message || 'Could not create vendor rule');
    } finally {
      setBusy(false);
    }
  };

  const offerRuleFromLatestReclass = () => {
    const latest = reclassHistory[reclassHistory.length - 1];
    const accountId = latest?.toAccount?.id || latest?.toAccountId;
    if (!accountId) {
      showToast && showToast('No corrected category found to build a rule from');
      return;
    }
    const toNum = latest?.toAccount?.account_number || '';
    const toName = leafLabel(latest?.toAccount?.account_name || '');
    setRuleOffer({
      accountId,
      accountLabel: (toNum || toName) ? `${toNum}${toNum && toName ? ' · ' : ''}${toName}` : 'this category',
      vendorHint,
    });
  };

  const handleCreatedAccount = async (entry) => {
    const next = [...localAccounts.filter((a) => a.id !== entry.id), entry]
      .sort((a, b) => String(a.account_number || a.number || '').localeCompare(String(b.account_number || b.number || ''), undefined, { numeric: true }));
    setLocalAccounts(next);
    onAccountCreated && onAccountCreated(entry);
    setReclassAccountId(entry.id);
    setCreateOpen(false);
    showToast && showToast(`Created ${entry.account_number || entry.number} · ${leafLabel(entry.account_name || entry.name)}`);
    await applyReclass(entry.id, next);
  };

  return (
    <div className="qbd-modal-backdrop" onClick={onClose}>
      <div className="qbd-window" style={{ width: 720, maxHeight: '85vh', margin: 0 }} onClick={(e) => e.stopPropagation()}>
        <div className="qbd-wtitle">🧾 Transaction Detail — {liveEntry.je_number} <span className="x" onClick={onClose}>✕</span></div>
        <div className="qbd-tools">
          <span className="qbd-muted">Date</span><b>{fmtReconDate(liveEntry.posting_date)}</b>
          <span className="qbd-muted" style={{ marginLeft: 14 }}>Memo</span><span>{liveEntry.description || ''}</span>
          <span className="qbd-muted" style={{ marginLeft: 'auto' }}>Status: {liveEntry.status}</span>
          {liveEntry.reversed_by_je_id && <span className="qbd-muted" style={{ marginLeft: 8 }}>(reversed)</span>}
          {liveEntry.sourceDocument?.hasFile && (
            <button
              type="button"
              className="qbd-btn"
              style={{ marginLeft: 12 }}
              title={liveEntry.sourceDocument.fileName || 'Source document'}
              onClick={() => (liveEntry.sourceDocument.documentId
                ? journalAPI.viewDocument(entityId, liveEntry.id)
                : mgmtReportAPI.viewFile(liveEntry.sourceDocument.mgmtReportId, liveEntry.sourceDocument.fileName)
              ).catch((e) => window.alert(e.message))}
            >
              View source document
            </button>
          )}
          <input
            ref={attachInputRef}
            type="file"
            accept="application/pdf,image/*"
            style={{ display: 'none' }}
            onChange={(e) => attachSupportingDoc(e.target.files && e.target.files[0])}
          />
          <button
            type="button"
            className="qbd-btn"
            style={{ marginLeft: 12 }}
            disabled={busy}
            title="Save a PDF or image explaining this charge for later review"
            onClick={() => attachInputRef.current && attachInputRef.current.click()}
          >
            {liveEntry.sourceDocument?.hasFile ? 'Replace supporting doc' : 'Attach supporting doc'}
          </button>
          {canEditDraft && (
            <a className="qbd-btn" style={{ marginLeft: 12, textDecoration: 'none' }} href={`/journal?je=${liveEntry.id}`}>Edit draft</a>
          )}
          {canReverse && (
            <button
              type="button"
              className="qbd-btn"
              disabled={busy}
              onClick={doReverse}
              style={{ marginLeft: 12, color: '#b3261e', fontWeight: 'bold' }}
              title="Remove this transaction from the books (posts an offsetting entry)"
            >
              Delete transaction
            </button>
          )}
        </div>
        <div className="qbd-wbody">
          <p className="qbd-muted" style={{ margin: '0 0 8px', fontSize: 12 }}>
            {liveEntry.status === 'POSTED' && !liveEntry.reversed_by_je_id
              ? 'Click Fix category, pick the account (applies immediately), then Create rule if this vendor should always use that category.'
              : null}
          </p>
          {reclassHistory.length > 0 && (
            <p style={{ margin: '0 0 8px', fontSize: 12, color: '#1a5a2a' }}>
              Category already corrected{reclassHistory.length === 1 ? '' : ` (${reclassHistory.length} fixes)`}
              {reclassHistory.map((r) => {
                const fromN = r.fromAccount?.account_number || '?';
                const toN = r.toAccount?.account_number || '?';
                return ` — ${fromN} → ${toN}`;
              }).join('')}
              .
              {!ruleOffer && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="qbd-btn qbd-pane-btn"
                    disabled={busy}
                    onClick={offerRuleFromLatestReclass}
                    style={{ marginLeft: 6 }}
                  >
                    Create rule for {vendorHint}
                  </button>
                </>
              )}
            </p>
          )}
          <table className="qbd-reg">
            <thead><tr><th>ACCOUNT</th><th className="qbd-amt">DEBIT</th><th className="qbd-amt">CREDIT</th><th style={{ width: 88 }} /></tr></thead>
            <tbody>
              {lines.map((l) => {
                td += +l.debit || 0;
                tc += +l.credit || 0;
                const isBankLine = reconcileAccountId && String(l.account_id) === String(reconcileAccountId);
                const canReclassLine = liveEntry.status === 'POSTED' && !liveEntry.reversed_by_je_id && !isBankLine && !l._synthetic;
                return (
                  <tr key={l.id} style={l._reclassed ? { background: '#f3faf4' } : undefined}>
                    <td>
                      {l.account_number} · {(l.account_name || '').split(':').pop()}
                      {l._reclassed ? <span className="qbd-muted" style={{ marginLeft: 6, fontSize: 11 }}>(updated)</span> : null}
                    </td>
                    <td className="qbd-amt">{(+l.debit) ? fmt(+l.debit) : ''}</td>
                    <td className="qbd-amt">{(+l.credit) ? fmt(+l.credit) : ''}</td>
                    <td>
                      {canReclassLine && (
                        <button
                          type="button"
                          className="qbd-btn qbd-pane-btn"
                          disabled={busy}
                          onClick={() => startReclass(l)}
                        >
                          Fix category
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr style={{ fontWeight: 'bold', background: '#eef4fb' }}>
                <td>TOTAL</td>
                <td className="qbd-amt">{fmt(td)}</td>
                <td className="qbd-amt">{fmt(tc)}</td>
                <td />
              </tr>
            </tbody>
          </table>
          {reclassLineId && (
            <div className="qbd-form" style={{ marginTop: 12, padding: 10, border: '1px solid #c5d4e8' }}>
              <div className="fhd">Fix category</div>
              <div className="frow">
                <label>New account</label>
                <AccountCombobox
                  accounts={localAccounts}
                  value={reclassAccountId}
                  onChange={onPickReclassAccount}
                  placeholder="Search GL account… (applies on select)"
                  style={{ minWidth: 320 }}
                  allowCreate
                  onCreateRequest={() => setCreateOpen(true)}
                  disabled={busy}
                />
              </div>
              <p className="qbd-muted" style={{ margin: '6px 0 0', fontSize: 11 }}>
                Pick an account — category updates immediately. You&apos;ll get a Create rule step next for <strong>{vendorHint}</strong>.
              </p>
              <div className="qbd-botbar">
                <button type="button" className="qbd-btn" disabled={busy} onClick={() => { setReclassLineId(null); setReclassAccountId(''); }}>Cancel</button>
                <span className="sp" />
                {busy ? <span className="qbd-muted" style={{ fontSize: 12 }}>Updating…</span> : null}
              </div>
            </div>
          )}
          {ruleOffer && (
            <div className="qbd-form" style={{ marginTop: 12, padding: 12, border: '2px solid #1a5a2a', background: '#f3faf4' }}>
              <div className="fhd" style={{ color: '#1a5a2a' }}>Create vendor rule?</div>
              <p style={{ margin: '6px 0 10px', fontSize: 13, lineHeight: 1.45 }}>
                Category is now <strong>{ruleOffer.accountLabel}</strong>.
                Create a rule for <strong>{ruleOffer.vendorHint}</strong> — it will also find and update
                other matching posted charges on the books (not only future imports).
              </p>
              <div className="qbd-botbar">
                <button type="button" className="qbd-btn" disabled={busy} onClick={() => setRuleOffer(null)}>Not now</button>
                <span className="sp" />
                <button type="button" className="qbd-btn qbd-primary" disabled={busy} onClick={confirmCreateVendorRule}>
                  Create rule
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="qbd-foot">
          <span className="sp" />
          <button type="button" className="qbd-btn" style={{ fontWeight: 'bold' }} onClick={onClose}>Close</button>
        </div>
      </div>
      <CreateAccountModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        entityId={entityId}
        accounts={localAccounts}
        defaultType="EXPENSE"
        applyLabel="Create & apply"
        onCreated={handleCreatedAccount}
      />
    </div>
  );
}

/** Record a bank/card transaction that appears on the statement but is missing from the books. */
function newSplitRow() {
  return { key: `split-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, accountId: '', amount: '' };
}

function moneyCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function RecordMissingTxnModal({
  open,
  onClose,
  entityId,
  bankAccount,
  accounts = [],
  defaultDate,
  onAccountCreated,
  onPosted,
  showToast,
}) {
  const isCard = isCreditCardAccount(bankAccount);
  const [localAccounts, setLocalAccounts] = useState(accounts);
  useEffect(() => { setLocalAccounts(accounts); }, [accounts]);

  const [side, setSide] = useState(isCard ? 'charge' : 'payment');
  const [date, setDate] = useState(defaultDate || todayISO());
  const [amount, setAmount] = useState('');
  const [splits, setSplits] = useState([newSplitRow()]);
  const [party, setParty] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForKey, setCreateForKey] = useState(null);
  const [attachFile, setAttachFile] = useState(null);
  const attachInputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setSide(isCard ? 'charge' : 'payment');
    setDate(defaultDate || todayISO());
    setAmount('');
    setSplits([newSplitRow()]);
    setParty('');
    setMemo('');
    setAttachFile(null);
    setCreateForKey(null);
    if (attachInputRef.current) attachInputRef.current.value = '';
  }, [open, isCard, defaultDate]);

  if (!open || !bankAccount) return null;

  const bankId = bankAccount.id;
  const categoryAccounts = localAccounts.filter((a) => a.id !== bankId);
  const sideOptions = isCard
    ? [
      { value: 'charge', label: 'Charge / purchase (increases card balance)' },
      { value: 'payment', label: 'Payment or credit (decreases card balance)' },
    ]
    : [
      { value: 'payment', label: 'Check / payment (money out)' },
      { value: 'deposit', label: 'Deposit / other credit (money in)' },
    ];

  const totalCents = moneyCents(amount);
  const splitCents = splits.reduce((sum, row, idx) => {
    if (splits.length === 1 && !String(row.amount || '').trim()) return totalCents;
    return sum + moneyCents(row.amount);
  }, 0);
  const remainingCents = totalCents - splitCents;
  const splitsReady = splits.length > 0
    && splits.every((row) => row.accountId && (splits.length === 1 || moneyCents(row.amount) > 0))
    && totalCents > 0
    && remainingCents === 0;

  const updateSplit = (key, patch) => {
    setSplits((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      resolve(dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl);
    };
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });

  const submit = async () => {
    if (!splitsReady) {
      showToast && showToast(
        remainingCents !== 0
          ? `Split amounts must equal the total (off by ${fmt(Math.abs(remainingCents) / 100)})`
          : 'Enter amount, pick each category, and fill split amounts'
      );
      return;
    }
    const amt = totalCents / 100;
    const bankLabel = `${bankAccount.account_number || ''} · ${leafLabel(bankAccount.account_name || '')}`.trim();
    const resolvedSplits = splits.map((row) => ({
      accountId: row.accountId,
      amount: (splits.length === 1 && !String(row.amount || '').trim() ? totalCents : moneyCents(row.amount)) / 100,
    }));
    // Bank: payment credits cash; deposit debits cash.
    // Card: charge credits liability; payment/credit debits liability.
    const bankGetsCredit = isCard ? (side === 'charge') : (side === 'payment');
    const offsetLines = resolvedSplits.map((row) => (
      bankGetsCredit
        ? { accountId: row.accountId, debit: row.amount, credit: 0, description: party || '' }
        : { accountId: row.accountId, debit: 0, credit: row.amount, description: party || '' }
    ));
    const bankLine = bankGetsCredit
      ? { accountId: bankId, debit: 0, credit: amt, description: party || '' }
      : { accountId: bankId, debit: amt, credit: 0, description: party || '' };
    const lines = [...offsetLines, bankLine];
    const kind = isCard
      ? (side === 'charge' ? 'Card charge' : 'Card payment/credit')
      : (side === 'payment' ? 'Check/payment' : 'Deposit');
    const desc = `${kind}${party ? ` — ${party}` : ''}${memo ? ` (${memo})` : ''} · ${bankLabel}`;
    const catLabels = resolvedSplits.map((row) => {
      const cat = categoryAccounts.find((a) => a.id === row.accountId);
      return cat
        ? `${cat.account_number || cat.number} · ${leafLabel(cat.account_name || cat.name)} ${fmt(row.amount)}`
        : fmt(row.amount);
    }).join(' + ');
    setBusy(true);
    try {
      const r = await journalAPI.create(entityId, {
        description: desc,
        postingDate: date,
        memo: memo || party || '',
        lines,
        source: 'reconcile-missing-txn',
      });
      const id = r.data?.id;
      if (!id) throw new Error('No journal id returned');
      try {
        await journalAPI.approve(entityId, id);
        await journalAPI.post(entityId, id);
      } catch (postErr) {
        showToast && showToast('Saved as draft — open Journal to approve/post, then refresh reconcile');
        onClose && onClose();
        return;
      }
      if (attachFile) {
        try {
          const fileData = await fileToBase64(attachFile);
          await journalAPI.attachDocument(entityId, id, {
            fileName: attachFile.name,
            fileMime: attachFile.type || 'application/pdf',
            fileData,
          });
        } catch (attachErr) {
          showToast && showToast('Posted, but could not attach document: ' + (attachErr.response?.data?.error || attachErr.message));
        }
      }
      showToast && showToast(`Posted ${r.data.jeNumber || 'entry'} — ${fmt(amt)} → ${catLabels}`);
      onClose && onClose();
      if (typeof onPosted === 'function') await onPosted({ journalEntryId: id, amount: amt, side });
    } catch (err) {
      showToast && showToast('Could not record transaction: ' + (err.response?.data?.error || err.message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qbd-modal-backdrop" style={{ zIndex: 400 }} onClick={() => !busy && onClose && onClose()}>
      <div className="qbd-window" style={{ width: 620, maxHeight: '90vh', margin: 0 }} onClick={(e) => e.stopPropagation()}>
        <div className="qbd-wtitle">
          Record missing transaction
          <span className="x" onClick={() => !busy && onClose && onClose()}>✕</span>
        </div>
        <div className="qbd-wbody" style={{ padding: 12 }}>
          <p className="qbd-muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
            Use this when the statement shows an item that is not in the register for{' '}
            <strong>{bankAccount.account_number} · {leafLabel(bankAccount.account_name)}</strong>.
          </p>
          <div className="frow" style={{ marginBottom: 8 }}>
            <label style={{ width: 110 }}>Type</label>
            <select value={side} onChange={(e) => setSide(e.target.value)} style={{ flex: 1 }}>
              {sideOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="frow" style={{ marginBottom: 8 }}>
            <label style={{ width: 110 }}>Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <label style={{ width: 70, marginLeft: 12 }}>Amount</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={{ width: 120, textAlign: 'right' }}
            />
          </div>
          <div className="frow" style={{ marginBottom: 8 }}>
            <label style={{ width: 110 }}>{isCard ? 'Payee' : (side === 'payment' ? 'Pay to' : 'Received from')}</label>
            <input
              style={{ flex: 1 }}
              value={party}
              onChange={(e) => setParty(e.target.value)}
              placeholder={isCard ? 'Merchant / payee' : (side === 'payment' ? 'Payee' : 'Source')}
            />
          </div>
          <div style={{ marginBottom: 8 }}>
            <div className="frow" style={{ marginBottom: 6, alignItems: 'center' }}>
              <label style={{ width: 110 }}>Categories</label>
              <span className="qbd-muted" style={{ fontSize: 11, flex: 1 }}>
                Split across more than one account when the charge covers multiple expenses
              </span>
              <button
                type="button"
                className="qbd-btn qbd-pane-btn"
                disabled={busy}
                onClick={() => setSplits((prev) => [...prev, newSplitRow()])}
              >
                + Add category
              </button>
            </div>
            {splits.map((row, idx) => (
              <div key={row.key} className="frow" style={{ marginBottom: 6, gap: 8, alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <AccountCombobox
                    accounts={categoryAccounts}
                    value={row.accountId}
                    onChange={(id) => updateSplit(row.key, { accountId: id })}
                    placeholder={`Category ${idx + 1}…`}
                    allowCreate
                    onCreateRequest={() => {
                      setCreateForKey(row.key);
                      setCreateOpen(true);
                    }}
                  />
                </div>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={row.amount}
                  onChange={(e) => updateSplit(row.key, { amount: e.target.value })}
                  placeholder={splits.length === 1 ? amount || 'Amount' : 'Split amt'}
                  style={{ width: 110, textAlign: 'right' }}
                  title={splits.length === 1 ? 'Leave blank to use the full amount' : 'Amount for this category'}
                />
                {splits.length > 1 && (
                  <button
                    type="button"
                    className="qbd-btn"
                    disabled={busy}
                    title="Remove this category line"
                    onClick={() => setSplits((prev) => prev.filter((r) => r.key !== row.key))}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            {totalCents > 0 && splits.length > 1 && (
              <p
                className="qbd-muted"
                style={{
                  margin: '0 0 0 110px',
                  fontSize: 12,
                  color: remainingCents === 0 ? '#1a5a2a' : '#b3261e',
                }}
              >
                {remainingCents === 0
                  ? `Splits total ${fmt(totalCents / 100)} — balanced`
                  : `Remaining to assign: ${fmt(remainingCents / 100)}`}
              </p>
            )}
          </div>
          <div className="frow" style={{ marginBottom: 8 }}>
            <label style={{ width: 110 }}>Memo</label>
            <input
              style={{ flex: 1 }}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <div className="frow" style={{ marginBottom: 4, alignItems: 'center' }}>
            <label style={{ width: 110 }}>Supporting doc</label>
            <input
              ref={attachInputRef}
              type="file"
              accept="application/pdf,image/*"
              style={{ display: 'none' }}
              onChange={(e) => setAttachFile((e.target.files && e.target.files[0]) || null)}
            />
            <button
              type="button"
              className="qbd-btn"
              disabled={busy}
              onClick={() => attachInputRef.current && attachInputRef.current.click()}
            >
              {attachFile ? 'Change file…' : 'Attach PDF / image…'}
            </button>
            <span className="qbd-muted" style={{ marginLeft: 10, fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {attachFile ? attachFile.name : 'Optional — saved on the posted entry'}
            </span>
          </div>
        </div>
        <div className="qbd-foot">
          <button type="button" className="qbd-btn" disabled={busy} onClick={() => onClose && onClose()}>Cancel</button>
          <span className="sp" />
          <button
            type="button"
            className="qbd-btn qbd-primary"
            disabled={busy || !splitsReady}
            onClick={submit}
            style={{ fontWeight: 'bold' }}
          >
            {busy ? 'Posting…' : 'Save & Post'}
          </button>
        </div>
      </div>
      <CreateAccountModal
        open={createOpen}
        onClose={() => { setCreateOpen(false); setCreateForKey(null); }}
        entityId={entityId}
        accounts={localAccounts}
        defaultType={side === 'deposit' ? 'REVENUE' : 'EXPENSE'}
        applyLabel="Create & use"
        onCreated={(entry) => {
          const next = [...localAccounts.filter((a) => a.id !== entry.id), entry]
            .sort((a, b) => String(a.account_number || a.number || '').localeCompare(String(b.account_number || b.number || ''), undefined, { numeric: true }));
          setLocalAccounts(next);
          onAccountCreated && onAccountCreated(entry);
          if (createForKey) {
            updateSplit(createForKey, { accountId: entry.id });
          } else {
            setSplits((prev) => {
              if (!prev.length) return [{ ...newSplitRow(), accountId: entry.id }];
              const [first, ...rest] = prev;
              return [{ ...first, accountId: entry.id }, ...rest];
            });
          }
          setCreateOpen(false);
          setCreateForKey(null);
          showToast && showToast(`Created ${entry.account_number || entry.number} · ${leafLabel(entry.account_name || entry.name)}`);
        }}
      />
    </div>
  );
}

export default function QBDReconcile() {
  const { entityId } = useEntity();
  const { showToast } = useOutletContext() || {};
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const urlAccountToken = accountFromSearchParams(searchParams);
  const urlResolvedDate = resolveDeepLinkDate(searchParams, entityId, urlAccountToken);
  const autoOpenRequested = shouldAutoOpenRecon(searchParams, urlResolvedDate);
  const [accounts, setAccounts] = useState([]);
  const [allAccounts, setAllAccounts] = useState([]);
  const [expenseAccounts, setExpenseAccounts] = useState([]);
  const [incomeAccounts, setIncomeAccounts] = useState([]);
  const [cashAccounts, setCashAccounts] = useState([]);
  const [accountId, setAccountId] = useState(() => (
    urlAccountToken.startsWith('acc-') ? urlAccountToken : ''
  ));
  // QuickBooks Begin-Reconciliation service-charge / interest date + posting account.
  const [scDate, setScDate] = useState('');
  const [scAccountId, setScAccountId] = useState('');
  const [intDate, setIntDate] = useState('');
  const [intAccountId, setIntAccountId] = useState('');
  // Credit-card payment due → scheduled draft on the selected cash register.
  const [paymentDueDate, setPaymentDueDate] = useState('');
  const [paymentDate, setPaymentDate] = useState(''); // when cash actually leaves (may differ from due)
  const [paymentDueAmount, setPaymentDueAmount] = useState('');
  const [payFromAccountId, setPayFromAccountId] = useState(() => {
    try { return localStorage.getItem('qbd-cc-pay-from') || ''; } catch { return ''; }
  });
  const [paymentDueSyncMsg, setPaymentDueSyncMsg] = useState('');
  const paymentDueAmountTouchedRef = useRef(false);
  const paymentDateTouchedRef = useRef(false);
  const paymentDueSyncTimerRef = useRef(null);
  const paymentDueHydrateKeyRef = useRef('');
  const [stmtDate, setStmtDate] = useState(() => (
    urlResolvedDate || todayISO()
  ));
  const [beginBal, setBeginBal] = useState('');
  const [endBal, setEndBal] = useState('');
  const [prepareMsg, setPrepareMsg] = useState('');
  const [lastReconciledDate, setLastReconciledDate] = useState('');
  const [prepareBusy, setPrepareBusy] = useState(false);
  const [started, setStarted] = useState(false);
  // Unposted draft journal entries dated on or before the statement date. Drafts
  // never reach the general ledger, so the reconcile cannot see them -- surface
  // the count before you commit, so you don't tie out to incomplete books.
  const [pendingDrafts, setPendingDrafts] = useState(0);
  const [data, setData] = useState(null);
  const [checked, setChecked] = useState({});
  // Mirror of checked — survives stale closures when Fix category / worksheet reload runs.
  const checkedRef = useRef({});
  useEffect(() => { checkedRef.current = checked; }, [checked]);
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
  const stmtLoadedForRef = useRef(null);
  const regScrollRef = useRef(null);
  const prepareTimerRef = useRef(null);
  const prepareRequestRef = useRef(0);
  const dateInputFocusedRef = useRef(false);
  // True once the user (or a URL param / uploaded statement) has chosen an explicit
  // statement date, so we stop auto-suggesting the next period after that.
  const userPickedDateRef = useRef(!!urlResolvedDate);
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
  const [showMissingTxn, setShowMissingTxn] = useState(false);
  const [highlightMarked, setHighlightMarked] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [showColsMenu, setShowColsMenu] = useState(false);
  // QuickBooks-style "Reconciliation Report" print picker (Summary / Detail / Both).
  const [showReportPicker, setShowReportPicker] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const [pdfPreview, setPdfPreview] = useState(null); // { url, mode }
  const [showNum, setShowNum] = useState(() => localStorage.getItem('qbd-recon-col-num') !== 'false');
  const [showDate, setShowDate] = useState(() => localStorage.getItem('qbd-recon-col-date') !== 'false');
  const [showPayee, setShowPayee] = useState(() => localStorage.getItem('qbd-recon-col-payee') !== 'false');
  const [showCategory, setShowCategory] = useState(() => localStorage.getItem('qbd-recon-col-category') !== 'false');
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

  // Count unposted drafts on THIS account dated on or before the statement date.
  // These are not in the general ledger yet, so this reconcile cannot include them.
  // Do not count Amex categorization drafts or other accounts' drafts.
  useEffect(() => {
    if (!entityId || !started || !stmtDate || !accountId) { setPendingDrafts(0); return undefined; }
    let alive = true;
    journalAPI.list(entityId, { status: 'DRAFT', endDate: stmtDate, accountId, limit: 1000 })
      .then((r) => {
        const all = (r.data && r.data.data) || (Array.isArray(r.data) ? r.data : []);
        if (alive) setPendingDrafts(all.length);
      })
      .catch(() => { if (alive) setPendingDrafts(0); });
    return () => { alive = false; };
  }, [entityId, started, stmtDate, accountId]);

  // Remember which columns the user wants displayed.
  useEffect(() => { localStorage.setItem('qbd-recon-col-num', showNum ? 'true' : 'false'); }, [showNum]);
  useEffect(() => { localStorage.setItem('qbd-recon-col-date', showDate ? 'true' : 'false'); }, [showDate]);
  useEffect(() => { localStorage.setItem('qbd-recon-col-payee', showPayee ? 'true' : 'false'); }, [showPayee]);
  useEffect(() => { localStorage.setItem('qbd-recon-col-category', showCategory ? 'true' : 'false'); }, [showCategory]);

  // Release the object URL for the statement PDF when it changes or on unmount.
  useEffect(() => () => { if (statementPdfUrl) URL.revokeObjectURL(statementPdfUrl); }, [statementPdfUrl]);

  // Switching accounts drops any statement carried over from the previous one.
  useEffect(() => {
    setStatementPdfUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    stmtAutoLoadKeyRef.current = null;
    stmtLoadedForRef.current = null;
  }, [accountId]);

  // Load the stored (or folder-discovered) statement PDF for this account/period.
  const attachStoredStatement = useCallback(async (dateOverride) => {
    if (!entityId || !accountId) return false;
    const date = isoDateOnly(dateOverride) || isoDateOnly(data?.statementDate) || isoDateOnly(stmtDate);
    if (!date) return false;
    const key = `${entityId}|${accountId}|${date}`;
    if (stmtLoadedForRef.current === key) return true;
    if (stmtAutoLoadKeyRef.current === key) return false;

    stmtAutoLoadKeyRef.current = key;
    const tryDates = [
      date,
      data?.statementPeriod?.periodEnd,
      data?.periodSession?.statementDate && String(data.periodSession.statementDate).slice(0, 10),
    ].filter((d, i, arr) => d && /^\d{4}-\d{2}-\d{2}$/.test(String(d).slice(0, 10)) && arr.indexOf(d) === i);

    for (const d0 of tryDates) {
      try {
        const r = await bankReconAPI.statementFile(entityId, accountId, String(d0).slice(0, 10));
        const d = r.data || {};
        if (!d.found || !d.dataBase64) continue;
        const url = base64ToObjectUrl(d.dataBase64, d.mime || 'application/pdf');
        setStatementPdfUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        setShowStmt(true);
        stmtLoadedForRef.current = key;
        return true;
      } catch {
        /* try next date */
      }
    }
    stmtAutoLoadKeyRef.current = null;
    return false;
  }, [entityId, accountId, stmtDate, data]);

  // Auto-attach on Begin Reconciliation and on the open worksheet until closed.
  useEffect(() => {
    if (!accountId || !stmtDate) return undefined;
    attachStoredStatement();
    return undefined;
  }, [accountId, stmtDate, started, attachStoredStatement]);

  useEffect(() => {
    stmtAutoLoadKeyRef.current = null;
    const date = isoDateOnly(stmtDate);
    if (stmtLoadedForRef.current && date && !stmtLoadedForRef.current.endsWith(`|${date}`)) {
      setStatementPdfUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      stmtLoadedForRef.current = null;
    }
  }, [stmtDate]);

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
      setLastReconciledDate('');
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
        setLastReconciledDate(p.lastReconciledDate || '');
        // Default to the month after the last completed reconciliation, unless the
        // user has explicitly chosen a date.
        let nextDate = null;
        if (!userPickedDateRef.current && p.suggestedStatementDate
            && /^\d{4}-\d{2}-\d{2}$/.test(p.suggestedStatementDate)) {
          nextDate = p.suggestedStatementDate;
          setStmtDate((prev) => (prev === p.suggestedStatementDate ? prev : p.suggestedStatementDate));
          setDateDraft(p.suggestedStatementDate);
        } else if (userPickedDateRef.current) {
          nextDate = isoDateOnly(stmtDate) || isoDateOnly(p.suggestedStatementDate);
        } else if (p.suggestedStatementDate) {
          nextDate = p.suggestedStatementDate;
          setStmtDate(p.suggestedStatementDate);
          setDateDraft(p.suggestedStatementDate);
        }
        if (p.endingBalance != null) setEndBal(String(p.endingBalance));
        else setEndBal('');
        if (p.beginningBalance != null) setBeginBal(String(p.beginningBalance));
        else setBeginBal('');
        setPrepareMsg(p.message || '');
        if (nextDate) attachStoredStatement(nextDate);
        // Entity-agnostic: if this account already has an OPEN recon, skip Begin
        // and open the main check-off screen immediately.
        if (p.resumeOpen && (nextDate || p.suggestedStatementDate || p.openSession?.statementDate)) {
          const openDate = p.openSession?.statementDate || nextDate || p.suggestedStatementDate;
          userPickedDateRef.current = true;
          if (openDate) {
            setStmtDate(openDate);
            setDateDraft(openDate);
          }
          // loadWorksheet is defined later — trigger via URL so the go=1 effect runs.
          const acctNo = accounts.find((a) => a.id === accountId)?.account_number || accountId;
          if (acctNo && openDate) {
            setSearchParams({
              account: String(acctNo),
              date: openDate,
              go: '1',
              year: String((openDate || '').slice(0, 4) || 2026),
            }, { replace: true });
          }
        }
      })
      .catch((e) => {
        if (prepareRequestRef.current !== requestId) return;
        setPrepareMsg(e.response?.data?.error || 'Could not load statement');
        setBeginBal('');
        setEndBal('');
        setLastReconciledDate('');
      })
      .finally(() => {
        if (prepareRequestRef.current === requestId) setPrepareBusy(false);
      });
  }, [entityId, accountId, stmtDate, attachStoredStatement, accounts, setSearchParams]);

  useEffect(() => {
    if (!entityId) return;
    let cancelled = false;

    async function loadReconcileAccounts() {
      let bankAccounts = [];
      let all = [];

      try {
        const reconRes = await bankReconAPI.reconcilableAccounts(entityId);
        bankAccounts = Array.isArray(reconRes.data?.accounts) ? reconRes.data.accounts : [];
      } catch (err) {
        console.error('reconcilableAccounts failed', err);
      }

      try {
        const acctRes = await accountAPI.list(entityId);
        all = flat(Array.isArray(acctRes.data) ? acctRes.data : (acctRes.data?.data || []), []);
      } catch (err) {
        console.error('accountAPI.list failed', err);
      }

      if (cancelled) return;

      const allowed = reconcilableNumbersForEntity(entityId);
      const merged = new Map();
      for (const a of bankAccounts) {
        const num = String(a.account_number || '');
        if (num && (!allowed.size || allowed.has(num))) merged.set(num, a);
      }
      for (const a of all) {
        const num = String(a.account_number || '');
        if (num && allowed.has(num) && !merged.has(num)) merged.set(num, a);
      }
      if (!merged.size) {
        for (const a of all) {
          if (isReconcilableAccount(a, entityId)) {
            const num = String(a.account_number || '');
            if (num) merged.set(num, a);
          }
        }
      }

      const list = Array.from(merged.values()).sort((a, b) =>
        String(a.account_number).localeCompare(String(b.account_number), undefined, { numeric: true })
      );

      if (all.length) {
        setAllAccounts(all);
        const bankNums = reconcilableNumbersForEntity(entityId);
        const cashOnly = all.filter((a) => {
          const name = String(a.account_name || '');
          if (INTERNAL_ACCOUNT.test(name)) return false;
          const num = String(a.account_number || '');
          if (a.account_type === 'ASSET' && bankNums.has(num)) return true;
          return a.account_type === 'ASSET' && /^cash\b/i.test(name);
        });
        setCashAccounts(cashOnly);
        setExpenseAccounts(all.filter((a) => a.account_type === 'EXPENSE'));
        setIncomeAccounts(all.filter((a) => a.account_type === 'REVENUE'));
        setPayFromAccountId((prev) => {
          if (prev && cashOnly.some((a) => a.id === prev)) return prev;
          const simmons = cashOnly.find((a) => a.account_number === '1000');
          const loneStar = cashOnly.find((a) => a.account_number === '1001');
          return (simmons || loneStar || cashOnly[0])?.id || prev || '';
        });
      }

      if (list.length) {
        setAccounts(list);
        const want = accountFromSearchParams(searchParams);
        const resolved = resolveAccountId(list, want);
        if (resolved) setAccountId(resolved);
      } else {
        showToast && showToast('Could not load bank accounts for reconciliation');
      }
    }

    loadReconcileAccounts();
    return () => { cancelled = true; };
  }, [entityId, searchParams]);

  // Keep account + statement date aligned when Monthly Books changes the URL.
  useEffect(() => {
    if (!accounts.length) return;
    const want = accountFromSearchParams(searchParams);
    const resolved = resolveAccountId(accounts, want);
    if (resolved && resolved !== accountId) setAccountId(resolved);
    const deepDate = resolveDeepLinkDate(searchParams, entityId, want);
    if (deepDate && deepDate !== stmtDate) {
      userPickedDateRef.current = true;
      setStmtDate(deepDate);
      setDateDraft(deepDate);
    }
  }, [searchParams, accounts, entityId, accountId, stmtDate]);

  const onAccountChange = useCallback((id) => {
    const urlDate = searchParams.get('date') || searchParams.get('asOf');
    const urlAccount = accountFromSearchParams(searchParams);
    const picked = accounts.find((a) => String(a.id) === String(id));
    const urlMatchesAccount = !!(urlAccount && picked && (
      urlAccount === picked.id || urlAccount === picked.account_number
    ));

    if (!urlDate || !urlMatchesAccount) {
      userPickedDateRef.current = false;
      setStmtDate('');
      setDateDraft('');
      setBeginBal('');
      setEndBal('');
      setLastReconciledDate('');
      setPrepareMsg('');
    }

    try { localStorage.removeItem(RECON_IN_PROGRESS_KEY); } catch { /* ignore */ }

    if (urlDate && !urlMatchesAccount) {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('date');
        next.delete('asOf');
        next.delete('go');
        if (picked?.account_number) next.set('account', picked.account_number);
        else if (id) next.set('account', id);
        return next;
      }, { replace: true });
    }

    stmtAutoLoadKeyRef.current = null;
    stmtLoadedForRef.current = null;
    setStatementPdfUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setAccountId(id);
  }, [searchParams, accounts, setSearchParams]);

  // Suggest due date (~25 days) once per card/statement; hydrate amount/date from existing draft.
  const suggestedDueKeyRef = useRef('');
  useEffect(() => {
    const selected = accounts.find((a) => a.id === accountId);
    if (!isCreditCardAccount(selected) || !stmtDate || !entityId) return undefined;
    const key = `${accountId}|${stmtDate}`;
    if (suggestedDueKeyRef.current !== key) {
      suggestedDueKeyRef.current = key;
      paymentDueHydrateKeyRef.current = '';
      paymentDueAmountTouchedRef.current = false;
      paymentDateTouchedRef.current = false;
      const base = Date.parse(`${stmtDate}T00:00:00`);
      if (Number.isFinite(base)) {
        const due = new Date(base + 25 * 86400000);
        const yyyy = due.getFullYear();
        const mm = String(due.getMonth() + 1).padStart(2, '0');
        const dd = String(due.getDate()).padStart(2, '0');
        const iso = `${yyyy}-${mm}-${dd}`;
        setPaymentDueDate(iso);
        setPaymentDate(iso);
      }
    }

    if (paymentDueHydrateKeyRef.current === key) return undefined;
    paymentDueHydrateKeyRef.current = key;
    let alive = true;
    bankReconAPI.getPaymentDue(entityId, accountId, stmtDate)
      .then((r) => {
        const pd = r.data?.paymentDue;
        if (!alive || !pd) return;
        if (pd.paymentDueDate) setPaymentDueDate(pd.paymentDueDate);
        if (pd.paymentDate) {
          setPaymentDate(pd.paymentDate);
          paymentDateTouchedRef.current = true;
        } else if (pd.paymentDueDate) {
          setPaymentDate(pd.paymentDueDate);
        }
        if (pd.amount != null) {
          setPaymentDueAmount(String(pd.amount));
          paymentDueAmountTouchedRef.current = true;
        }
        if (pd.payFromAccountId) setPayFromAccountId(pd.payFromAccountId);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [accountId, accounts, stmtDate, entityId]);

  // Keep payment date aligned with due date until Jerry picks a different pay day.
  useEffect(() => {
    const selected = accounts.find((a) => a.id === accountId);
    if (!isCreditCardAccount(selected)) return;
    if (paymentDateTouchedRef.current) return;
    if (!paymentDueDate) return;
    setPaymentDate(paymentDueDate);
  }, [paymentDueDate, accountId, accounts]);

  // Keep payment amount in sync with statement ending balance until Jerry edits it.
  useEffect(() => {
    const selected = accounts.find((a) => a.id === accountId);
    if (!isCreditCardAccount(selected)) return;
    if (paymentDueAmountTouchedRef.current) return;
    if (endBal === '' || endBal == null) return;
    setPaymentDueAmount(String(endBal));
  }, [endBal, accountId, accounts]);

  // Live-sync editable due date / amount / pay-from into the cash register draft.
  useEffect(() => {
    const selected = accounts.find((a) => a.id === accountId);
    if (!isCreditCardAccount(selected) || !entityId || !accountId || !stmtDate) return undefined;
    const payDay = paymentDate || paymentDueDate;
    if (!payDay || !payFromAccountId) return undefined;
    const amt = parseFloat(paymentDueAmount || '0') || 0;
    if (!(amt > 0.005)) return undefined;

    if (paymentDueSyncTimerRef.current) clearTimeout(paymentDueSyncTimerRef.current);
    paymentDueSyncTimerRef.current = setTimeout(() => {
      try { localStorage.setItem('qbd-cc-pay-from', payFromAccountId); } catch { /* ignore */ }
      bankReconAPI.paymentDue({
        entityId,
        accountId,
        payFromAccountId,
        statementDate: stmtDate,
        paymentDueDate: paymentDueDate || payDay,
        paymentDate: payDay,
        amount: amt,
      }).then((r) => {
        if (r.data?.skipped || r.data?.removed) return;
        const cashName = cashAccounts.find((a) => a.id === payFromAccountId);
        const label = cashName ? `${cashName.account_number}` : 'cash';
        const dueNote = paymentDueDate && paymentDueDate !== payDay ? ` (statement due ${paymentDueDate})` : '';
        setPaymentDueSyncMsg(`Synced to ${label} register: ${fmt(amt)} on ${payDay}${dueNote}`);
      }).catch((e) => {
        setPaymentDueSyncMsg(e.response?.data?.error || e.message || 'Sync failed');
      });
    }, 600);
    return () => {
      if (paymentDueSyncTimerRef.current) clearTimeout(paymentDueSyncTimerRef.current);
    };
  }, [entityId, accountId, accounts, stmtDate, paymentDueDate, paymentDate, paymentDueAmount, payFromAccountId, cashAccounts]);

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
      // autoPost:false — during reconciliation the register already holds these
      // transactions (bank feed / rebuilt books). Uploading the statement must only
      // read the dates/balances and show the PDF for matching; posting them again
      // creates duplicate journal entries (the importer only dedups on bank fitid,
      // which rebuilt/Beancount entries don't carry).
      const payload = { entityId, accountId, fileName: file.name, autoPost: false };
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
            stmtLoadedForRef.current = `${entityId}|${accountId}|${d.statementDate}`;
          }
          if (d.endingBalance != null) setEndBal(String(d.endingBalance));
          if (d.beginningBalance != null) setBeginBal(String(d.beginningBalance));
          showToast && showToast(d.message || 'Statement imported — dates and balances read from your statement');
          if (d.redirected && d.redirected.accountId) {
            // The statement identified a different account and the server imported
            // it THERE. Follow it: switching accountId re-runs prepare for the
            // right account automatically (the account/date effect).
            setAccountId(d.redirected.accountId);
          } else if (d.statementDate) {
            runPrepare(d.statementDate);
          }
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

  const accountNumberForChecked = useMemo(() => {
    const fromAccounts = accounts.find((a) => a.id === accountId)?.account_number;
    const fromData = data?.account?.account_number;
    return String(fromAccounts || fromData || '');
  }, [accounts, accountId, data?.account?.account_number]);

  const applyAutoChecked = useCallback((worksheet, { preserveChecked = true } = {}) => {
    const dateKey = isoDateOnly(worksheet?.statementDate || stmtDate);
    const acctNo = String(
      worksheet?.account?.account_number
      || accounts.find((a) => a.id === accountId)?.account_number
      || ''
    );
    const entryIds = new Set((worksheet?.entries || []).map((e) => String(e.id)));
    setChecked((prev) => {
      const next = {};
      // 1) Server auto-match suggestions (statement ↔ register)
      (worksheet?.suggestedCheckedGlIds || []).forEach((id) => { next[String(id)] = true; });
      // 2) Lines already locked in a closed/reopened recon for this period
      (worksheet?.entries || []).forEach((e) => {
        if (e.alreadyReconciled || e.clearState === 'reconciled' || e.reconciliation_status === 'RECONCILED') {
          next[String(e.id)] = true;
        }
      });
      // 3) Keep marks the user already checked — from React state, ref, and disk.
      //    Fix category must never wipe these.
      if (preserveChecked) {
        const fromPrev = prev || {};
        const fromRef = checkedRef.current || {};
        Object.keys(fromPrev).forEach((id) => { if (fromPrev[id]) next[String(id)] = true; });
        Object.keys(fromRef).forEach((id) => { if (fromRef[id]) next[String(id)] = true; });
        readSavedCheckedIds(entityId, accountId, dateKey, acctNo).forEach((id) => {
          next[String(id)] = true;
        });
        // Also try current stmtDate period in case worksheet date drifted
        if (stmtDate && isoDateOnly(stmtDate) !== dateKey) {
          readSavedCheckedIds(entityId, accountId, stmtDate, acctNo).forEach((id) => {
            next[String(id)] = true;
          });
        }
      }
      // Drop ids that are no longer on the worksheet
      Object.keys(next).forEach((id) => {
        if (!entryIds.has(id)) delete next[id];
      });
      checkedRef.current = next;
      writeSavedCheckedIds(entityId, accountId, dateKey, next, acctNo);
      if (stmtDate && isoDateOnly(stmtDate) !== dateKey) {
        writeSavedCheckedIds(entityId, accountId, stmtDate, next, acctNo);
      }
      return next;
    });
  }, [entityId, accountId, stmtDate, accounts]);

  const persistChecked = useCallback((nextMap) => {
    checkedRef.current = nextMap;
    writeSavedCheckedIds(entityId, accountId, isoDateOnly(stmtDate), nextMap, accountNumberForChecked);
  }, [entityId, accountId, stmtDate, accountNumberForChecked]);

  const loadWorksheet = useCallback((dateOverride, opts = {}) => {
    if (!accountId) return Promise.resolve();
    const dateForLoad = isoDateOnly(dateOverride) || stmtDate;
    if (!dateForLoad) return Promise.resolve();
    setBusy(true);
    return bankReconAPI.worksheet(entityId, accountId, dateForLoad, { autoMatch: true })
      .then((r) => {
        // Already closed & balanced — don't trap Jerry on an empty closed worksheet
        // (common after Save & Close / Close & Advance left ?go=1 in the URL).
        const closedBalanced = r.data?.periodSession?.status === 'CLOSED' && r.data?.periodSession?.balanced;
        // Leftover ?go=1 after Save & Close — return to the month quietly (no toast).
        if (closedBalanced && searchParams.get('go') === '1') {
          const acctNo = accounts.find((a) => a.id === accountId)?.account_number || accountId;
          const period = workingPeriodFromContext({
            searchParams,
            entityId,
            accountNumber: acctNo,
            statementDate: isoDateOnly(r.data.statementDate || dateForLoad),
          });
          try { localStorage.removeItem(RECON_IN_PROGRESS_KEY); } catch { /* ignore */ }
          setStarted(false);
          setData(null);
          if (period) navigate(monthlyBooksPath(period.year, period.month));
          else navigate('/');
          return r.data;
        }

        setData(r.data);
        applyAutoChecked(r.data, { preserveChecked: opts.preserveChecked !== false });
        setHighlightGlId(null);
        setStarted(true);
        // Never keep a stale Modify-panel override across worksheet loads — that
        // can flip Beginning negative and hide a balanced close behind a fake difference.
        setBeginningOverride('');
        {
          const resolvedDate = isoDateOnly(r.data.statementDate || dateForLoad);
          if (resolvedDate) setStmtDate(resolvedDate);
          // Reflect the running reconciliation in the URL so browser Back (e.g.
          // returning from the draft-review screen) lands on THIS reconciliation,
          // not a blank default screen. Before this, account/date/session lived
          // only in component state and navigating away destroyed them.
          const acctNo = accounts.find((a) => a.id === accountId)?.account_number || accountId;
          if (resolvedDate) {
            const period = workingPeriodFromContext({
              searchParams,
              entityId,
              accountNumber: acctNo,
              statementDate: resolvedDate,
            });
            const nextParams = { account: String(acctNo), date: resolvedDate, go: '1' };
            if (period) {
              nextParams.year = String(period.year);
              nextParams.month = String(period.month);
              nextParams.return = 'month';
            } else if (searchParams.get('return') === 'month') {
              nextParams.return = 'month';
            }
            setSearchParams(nextParams, { replace: true });
          }
          // Also persist it: the URL only survives browser Back, not a fresh
          // visit to /reconcile after a draft-review round trip.
          try {
            const period = workingPeriodFromContext({
              searchParams,
              entityId,
              accountNumber: acctNo,
              statementDate: resolvedDate,
            });
            localStorage.setItem(RECON_IN_PROGRESS_KEY, JSON.stringify({
              entity: entityId,
              account: String(acctNo),
              date: resolvedDate,
              year: period?.year,
              month: period?.month,
              at: Date.now(),
            }));
          } catch { /* storage full/blocked — resume just won't persist */ }
        }
        if (r.data.suggestedEndingBalance != null) {
          setEndBal(String(r.data.suggestedEndingBalance));
        } else if (r.data.endingBalance != null) {
          setEndBal(String(r.data.endingBalance));
        }
        {
          const beginSrc = r.data.periodSession?.beginningBalance ?? r.data.displayBeginning ?? r.data.beginningBalance;
          if (beginSrc != null) setBeginBal(String(beginSrc));
        }
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
        setFeeNote(notes.length ? `Read from the statement (not yet in your books): ${notes.join(', ')}. Review below — it posts when you Save & Close.` : '');
        return r.data;
      })
      .catch((e) => {
        showToast && showToast('Failed to load: ' + (e.response?.data?.error || e.message));
        // Unstick "Opening reconciliation…" if deep-link load fails.
        if (searchParams.get('go') === '1') {
          try { localStorage.removeItem(RECON_IN_PROGRESS_KEY); } catch { /* ignore */ }
          setSearchParams({}, { replace: true });
        }
        return null;
      })
      .finally(() => setBusy(false));
  }, [entityId, accountId, stmtDate, showToast, applyAutoChecked, accounts, setSearchParams, searchParams, navigate]);

  const handleMissingTxnPosted = useCallback(async ({ journalEntryId }) => {
    if (!journalEntryId) return;
    const sheet = await loadWorksheet();
    const rows = sheet?.entries || [];
    const ids = rows
      .filter((e) => String(e.journal_entry_id || e.journalEntryId || '') === String(journalEntryId))
      .map((e) => e.id)
      .filter(Boolean);
    if (!ids.length) return;
    setChecked((c) => {
      const next = { ...c };
      ids.forEach((id) => { next[id] = true; });
      persistChecked(next);
      return next;
    });
    showToast && showToast(`Recorded and marked cleared on the register`);
  }, [loadWorksheet, persistChecked, showToast]);

  const start = () => {
    if (!accountId) { showToast && showToast('Pick an account'); return; }
    loadWorksheet();
  };

  // Auto-resume a reconciliation carried in the URL — this is what makes browser
  // Back work: ?account=…&date=…&go=1 re-opens the same account/date and loads
  // the worksheet without another click. Guarded by a ref so it fires once.
  const autoResumedRef = useRef(false);
  useEffect(() => {
    if (autoResumedRef.current || started) return;
    if (!autoOpenRequested || !accountId || !stmtDate) return;
    autoResumedRef.current = true;
    loadWorksheet().catch(() => {
      autoResumedRef.current = false;
    });
  }, [autoOpenRequested, accountId, stmtDate, started, loadWorksheet]);

  // Resume across FULL navigations AND any entity with an OPEN recon.
  // Priority (entity-agnostic — LJC / OMC / GM / Justin / 4J&L / QOF):
  //   1. URL deep link (?account=&date=&go=1)
  //   2. Server earliest OPEN session for this entity + year
  //   3. localStorage in-progress pointer for this entity
  // Never leave Jerry on Begin Reconciliation when an OPEN worksheet exists.
  const storeResumedRef = useRef(false);
  useEffect(() => {
    if (storeResumedRef.current || started || accountId) return;
    if (searchParams.get('go') === '1' || accountFromSearchParams(searchParams)) return;
    let cancelled = false;
    storeResumedRef.current = true;

    const yearFromUrl = Number(searchParams.get('year'));
    const year = (Number.isFinite(yearFromUrl) && yearFromUrl >= 2000) ? yearFromUrl : 2026;

    (async () => {
      let open = null;
      try {
        const r = await bankReconAPI.resumeOpen(entityId, { year });
        open = r.data?.found ? r.data : null;
      } catch {
        open = null;
      }
      if (cancelled) return;

      if (open?.accountNumber && open?.statementDate) {
        userPickedDateRef.current = true;
        setStmtDate(open.statementDate);
        setDateDraft(open.statementDate);
        setSearchParams({
          account: String(open.accountNumber),
          date: open.statementDate,
          go: '1',
          year: String(year),
        }, { replace: true });
        return;
      }

      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(RECON_IN_PROGRESS_KEY) || 'null'); } catch { saved = null; }
      if (!saved || saved.entity !== entityId || !saved.account || !/^\d{4}-\d{2}-\d{2}$/.test(String(saved.date))) {
        storeResumedRef.current = false;
        return;
      }
      userPickedDateRef.current = true;
      setStmtDate(saved.date);
      setSearchParams({ account: String(saved.account), date: saved.date, go: '1' }, { replace: true });
    })();

    return () => { cancelled = true; };
  }, [entityId, started, accountId, searchParams, setSearchParams]);

  // Deep link from Monthly Books — keep statement date in sync with URL.
  useEffect(() => {
    const deepDate = resolveDeepLinkDate(searchParams, entityId, accountFromSearchParams(searchParams));
    if (!deepDate) return;
    userPickedDateRef.current = true;
    setStmtDate(deepDate);
    setDateDraft(deepDate);
  }, [searchParams, entityId]);

  const toggle = (id) => {
    setChecked((c) => {
      const next = { ...c, [id]: !c[id] };
      persistChecked(next);
      return next;
    });
  };

  const markAll = () => {
    const next = {};
    entries.forEach((e) => { next[e.id] = true; });
    setChecked(next);
    persistChecked(next);
  };

  const unmarkAll = () => {
    setChecked({});
    checkedRef.current = {};
    clearSavedCheckedIds(entityId, accountId, isoDateOnly(stmtDate), accountNumberForChecked);
  };

  /** Clear cleared checkmarks for one register side only (checks or deposits). */
  const unmarkSide = (side) => {
    setChecked((c) => {
      const next = { ...c };
      entries.forEach((e) => {
        if (entrySide(e, account) === side) delete next[e.id];
      });
      persistChecked(next);
      return next;
    });
  };

  /** QBD "Matched": check off every line the system matched to the statement. */
  const matched = () => {
    const ids = data?.suggestedCheckedGlIds || [];
    setChecked((c) => {
      const next = { ...c };
      ids.forEach((id) => { next[id] = true; });
      persistChecked(next);
      return next;
    });
    showToast && showToast(`Matched ${ids.length} transaction(s) to the statement`);
  };

  const addCreatedAccount = useCallback((entry) => {
    if (!entry?.id) return;
    setAllAccounts((prev) => {
      if (prev.some((a) => a.id === entry.id)) return prev;
      return [...prev, entry].sort((a, b) =>
        String(a.account_number || a.number || '').localeCompare(String(b.account_number || b.number || ''), undefined, { numeric: true })
      );
    });
  }, []);

  const drillEntryOpen = (entry) => {
    // Always open the JE distribution (TxnDetailModal). Supporting docs are
    // viewed from the button inside that modal — not as the double-click target.
    const jeId = entry?.journal_entry_id || entry?.journalEntryId;
    const glId = entry?.id || entry?.glId || null;
    if (!jeId && !glId) {
      showToast && showToast('No transaction detail available for this line');
      return;
    }
    const openJe = (id) => journalAPI.get(entityId, id)
      .then((res) => setDrillEntry(res.data))
      .catch((e) => showToast && showToast('Could not open transaction: ' + (e.response?.data?.error || e.message)));

    if (jeId) {
      openJe(jeId);
      return;
    }
    bankReconAPI.resolveGl(entityId, glId)
      .then((resolved) => {
        const resolvedId = resolved.data?.journalEntryId;
        if (!resolvedId) {
          showToast && showToast('No transaction detail available for this line');
          return null;
        }
        return openJe(resolvedId);
      })
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

  /** Delete (= reverse) the selected register line so flawed leftovers leave the worksheet. */
  const deleteSelectedTransaction = () => {
    const id = selectedId || highlightGlId;
    const entry = entries.find((e) => e.id === id);
    if (!entry) {
      showToast && showToast('Click a transaction first, then Delete Transaction');
      return;
    }
    const jeId = entry.journal_entry_id || entry.journalEntryId;
    if (!jeId) {
      showToast && showToast('This line has no journal entry to delete');
      return;
    }
    const amt = reconRegisterAmount(entry, account) || 0;
    const desc = entry.je_description || entry.description || entry.je_number || 'this transaction';
    const short = String(desc).length > 80 ? `${String(desc).slice(0, 77)}…` : desc;
    if (!window.confirm(
      `Delete this transaction from the books?\n\n` +
      `${fmtReconDate(entry.posting_date)} · ${fmt(amt)} · ${short}\n\n` +
      `It will disappear from this reconcile screen. An offsetting entry is posted for the audit trail.`
    )) return;
    setBusy(true);
    journalAPI.reverse(entityId, jeId)
      .then((r) => {
        showToast && showToast(`Deleted — ${r.data?.reversalJeNumber || 'offset posted'}`);
        setSelectedId(null);
        setHighlightGlId(null);
        setDrillEntry(null);
        setChecked((c) => {
          const next = { ...c };
          delete next[entry.id];
          persistChecked(next);
          return next;
        });
        return loadWorksheet();
      })
      .catch((e) => window.alert(e.response?.data?.error || e.message))
      .finally(() => setBusy(false));
  };

  const account = data?.account;
  const labels = useMemo(() => reconColumnLabels(account), [account]);
  const isCard = isCreditCardAccount(account);

  const entries = data?.entries || [];
  const matchedGlSet = useMemo(() => new Set(data?.suggestedCheckedGlIds || []), [data?.suggestedCheckedGlIds]);
  const beginning = +(beginningOverride !== ''
    ? beginningOverride
    : (data?.periodSession?.beginningBalance ?? data?.displayBeginning ?? data?.beginningBalance ?? beginBal ?? 0));
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
  const statementPreviousBalance = stmtMeta.previousBalance != null ? +stmtMeta.previousBalance : null;
  const beginningMismatch = statementPreviousBalance != null && Math.abs(beginning - statementPreviousBalance) >= 0.01;

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

  // QuickBooks "Undo Last Reconciliation": reopen the account's most recent
  // CLOSED period (e.g. January), not the statement date on screen (February).
  // Then open that period's worksheet so you can rework until ending = statement.
  const undoLastReconciliation = () => {
    if (!accountId) { showToast && showToast('Pick an account first'); return; }
    if (!window.confirm(
      'Undo the last completed reconciliation for this account?\n\n'
      + 'This reopens the most recent closed month (for example January when you are starting February), '
      + 'clears its checkmarks, and lets you rework it until the ending balance matches that month\'s bank statement. '
      + 'No transactions are deleted.'
    )) return;
    setBusy(true);
    bankReconAPI.undoLast({ entityId, accountId })
      .then((res) => {
        const data = res?.data || res || {};
        const undone = data.undoneStatementDate || stmtDate;
        const label = periodLabel(undone);
        showToast && showToast(
          `Undid ${label} reconciliation — rework that month until ending matches the statement`
        );
        setStmtDate(undone);
        return loadWorksheet(undone);
      })
      .catch((e) => showToast && showToast(
        e.response?.data?.error || e.message || 'Nothing to undo for this account'
      ))
      .finally(() => setBusy(false));
  };

  const enterAdjustment = () => {
    showToast && showToast(
      'Hard rule: plug adjustments are permanently disabled. Resolve the difference to $0.00 with real transactions.'
    );
  };

  const returnToWorkingMonth = useCallback((toastMsg) => {
    const acctNo = accounts.find((a) => a.id === accountId)?.account_number || accountNumberForChecked;
    const period = workingPeriodFromContext({
      searchParams,
      entityId,
      accountNumber: acctNo,
      statementDate: stmtDate,
    });
    try { localStorage.removeItem(RECON_IN_PROGRESS_KEY); } catch { /* ignore */ }
    setStarted(false);
    setData(null);
    setSearchParams({}, { replace: true });
    if (toastMsg) showToast && showToast(toastMsg);
    if (period) {
      navigate(monthlyBooksPath(period.year, period.month));
    } else {
      navigate('/');
    }
  }, [accounts, accountId, accountNumberForChecked, searchParams, entityId, stmtDate, setSearchParams, showToast, navigate]);

  /** @param {'month'|'advance'|'stay'} mode */
  const finish = (mode = 'month') => {
    if (!balanced) { showToast && showToast('Difference must be $0.00 to reconcile'); return; }
    if (checkedIds.length === 0) { showToast && showToast('Mark the cleared transactions first'); return; }
    setBusy(true);
    bankReconAPI.reconcile({
      entityId,
      accountId,
      glIds: checkedIds,
      statementDate: stmtDate,
      statementEndingBalance: target,
      beginningBalance: beginning,
      serviceCharge: svc,
      interestEarned: int,
      serviceChargeAccountId: scAccountId || null,
      interestAccountId: intAccountId || null,
      serviceChargeDate: (svc > 0 ? (scDate || stmtDate) : null),
      interestDate: (int > 0 ? (intDate || stmtDate) : null),
      paymentDueDate: isCard && paymentDueDate ? paymentDueDate : null,
      paymentDate: isCard && (paymentDate || paymentDueDate) ? (paymentDate || paymentDueDate) : null,
      payFromAccountId: isCard && payFromAccountId ? payFromAccountId : null,
      paymentDueAmount: isCard && paymentDueAmount !== '' ? (parseFloat(paymentDueAmount) || 0) : null,
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
        clearSavedCheckedIds(entityId, accountId, isoDateOnly(stmtDate), accountNumberForChecked);
        setChecked({});
        checkedRef.current = {};
        setEndBal('');
        setBeginningOverride('');

        // Default: Save & Close → back to Monthly Books for this working month
        // so other accounts can be reconciled before the month is closed.
        if (mode === 'month' || (mode !== 'advance' && searchParams.get('return') === 'month')) {
          const acctLabel = `${data.account.account_number} · ${leafLabel(data.account.account_name)}`;
          returnToWorkingMonth(
            `Saved & closed ${acctLabel} (${r.data.reconciledCount || checkedIds.length} cleared). Pick the next account for this month.`
          );
          return;
        }

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
        try { localStorage.removeItem(RECON_IN_PROGRESS_KEY); } catch { /* ignore */ }

        // Close & Advance: same account, next statement period.
        if (mode === 'advance') {
          const next = nextStatementDate(stmtDate);
          if (next) {
            setStmtDate(next);
            userPickedDateRef.current = true;
            showToast && showToast(`Reconciled. Advanced to ${periodLabel(next)} — beginning balance carries from this close.`);
          }
        }
      })
      .catch((e) => {
        const msg = e.response?.data?.error || e.message;
        showToast && showToast(msg);
        if (e.response?.status === 422) loadWorksheet();
      })
      .finally(() => setBusy(false));
  };

  // Instant HTML preview from live report JSON (PDF export remains available).
  const openReconPdf = (mode) => {
    if (!accountId || !stmtDate) { showToast && showToast('Pick an account and statement date first'); return; }
    setReportBusy(true);
    reconReportAPI.generate({ entityId, accountId, statementDate: stmtDate })
      .then((r) => {
        const built = r.data?.report;
        if (!built) throw new Error('Empty report');
        setPdfPreview({
          mode,
          full: {
            account_id: accountId,
            account_number: built.header?.accountNumber,
            account_name: built.header?.accountName,
            statement_date: built.header?.statementDate || stmtDate,
            is_closed: !!built.meta?.isClosed,
            summary: built.summary,
            detail: built.detail,
          },
        });
        setShowReportPicker(false);
        setReportModal(null);
      })
      .catch((e) => showToast && showToast('Report failed: ' + (e.response?.data?.error || e.message || e)))
      .finally(() => setReportBusy(false));
  };

  const exportReconPdf = async () => {
    if (!accountId || !stmtDate || !pdfPreview) return;
    setReportBusy(true);
    try {
      await reconReportAPI.renderPdf({
        entityId,
        accountId,
        statementDate: stmtDate,
        mode: pdfPreview.mode || 'both',
      });
    } catch (e) {
      showToast && showToast('PDF export failed: ' + (e.message || e));
    } finally {
      setReportBusy(false);
    }
  };

  const reportOverlay = (
    <>
      {showReportPicker && (
        <div className="qbd-modal-backdrop" onClick={() => !reportBusy && setShowReportPicker(false)}>
          <div className="qbd-modal" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <div className="qbd-wtitle">
              Select Reconciliation Report
              <span className="x" onClick={() => !reportBusy && setShowReportPicker(false)}>✕</span>
            </div>
            <div className="qbd-modal-body" style={{ fontSize: 12, lineHeight: 1.55 }}>
              <p><strong>{data?.account ? `${data.account.account_number} · ${leafLabel(data.account.account_name)}` : (accountId ? 'Selected account' : 'Pick an account')}</strong>{stmtDate ? <> — statement ending <strong>{stmtDate}</strong></> : null}</p>
              <p>Preview the reconciliation on screen (Summary, Detail, or Both). You can export the PDF from the preview.</p>
            </div>
            <div className="qbd-foot" style={{ flexWrap: 'wrap', gap: 6 }}>
              <button type="button" className="qbd-btn" disabled={reportBusy} onClick={() => openReconPdf('summary')}>Summary</button>
              <button type="button" className="qbd-btn" disabled={reportBusy} onClick={() => openReconPdf('detail')}>Detail</button>
              <button type="button" className="qbd-btn" style={{ fontWeight: 'bold' }} disabled={reportBusy} onClick={() => openReconPdf('both')}>Both</button>
              <span className="sp" />
              <button type="button" className="qbd-btn" disabled={reportBusy} onClick={() => setShowReportPicker(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
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
              <p>{reportModal.reconciledCount} transaction(s) reconciled. Preview the report on screen, or cancel.</p>
            </div>
            <div className="qbd-foot" style={{ flexWrap: 'wrap', gap: 6 }}>
              <button type="button" className="qbd-btn" disabled={reportBusy} onClick={() => openReconPdf('summary')}>Summary</button>
              <button type="button" className="qbd-btn" disabled={reportBusy} onClick={() => openReconPdf('detail')}>Detail</button>
              <button type="button" className="qbd-btn" style={{ fontWeight: 'bold' }} disabled={reportBusy} onClick={() => openReconPdf('both')}>Both</button>
              <span className="sp" />
              <button type="button" className="qbd-btn" disabled={reportBusy} onClick={() => setReportModal(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {pdfPreview?.full && (
        <ReconHtmlPreviewModal
          title={`Reconciliation Preview — ${stmtDate}`}
          full={pdfPreview.full}
          mode={pdfPreview.mode || 'both'}
          busy={reportBusy}
          exportBusy={reportBusy}
          entityId={entityId}
          statementPdfUrl={statementPdfUrl}
          onClose={() => setPdfPreview(null)}
          onModeChange={(m) => setPdfPreview((p) => (p ? { ...p, mode: m } : p))}
          onExport={exportReconPdf}
          onDrillLine={(line) => drillEntryOpen({
            journal_entry_id: line.journalEntryId || line.journal_entry_id,
            journalEntryId: line.journalEntryId || line.journal_entry_id,
            glId: line.glId,
          })}
        />
      )}
    </>
  );

  const deepLinkPending = autoOpenRequested && !started;

  if (!started && deepLinkPending) {
    const acct = accounts.find((a) => a.id === accountId);
    const urlDate = resolveDeepLinkDate(searchParams, entityId, accountFromSearchParams(searchParams)) || stmtDate;
    return (
      <>
        <div className="qbd-form qbd-recon-begin">
          <div className="fhd">Opening reconciliation…</div>
          <div className="qbd-muted" style={{ padding: '12px 16px', fontSize: 12, lineHeight: 1.5 }}>
            {acct ? <><strong>{leafLabel(acct.account_name)}</strong> — </> : 'Loading account… '}
            statement ending <strong>{urlDate}</strong>
          </div>
        </div>
      </>
    );
  }

  if (!started) {
    return (
      <>
      <div className="qbd-form qbd-recon-begin">
        <div className="fhd">Begin Reconciliation</div>
        <div className="qbd-muted" style={{ padding: '0 12px 10px', fontSize: 11, lineHeight: 1.45 }}>
          Get your monthly statement from your bank, then <strong>Banking → Reconcile</strong>.
          Pick an account — the app finds the <strong>next period</strong> after your last completed reconciliation, fills in balances, and attaches the statement PDF when it can find it.
          Verify the <strong>beginning balance</strong> matches your statement before you continue.
          <br />
          Every posted transaction for the account is then shown — checks and payments on the left, deposits and credits on the right.
          Lines that match your statement are pre-checked; check off the rest as you find them.
        </div>
        <div className="frow"><label>Account</label>
          <div style={{ minWidth: 320, flex: 1, maxWidth: 480 }}>
            <AccountCombobox
              accounts={accounts}
              value={accountId}
              onChange={onAccountChange}
              placeholder="— select bank / card account —"
            />
          </div>
        </div>
        {accountId && (
          <>
            {(lastReconciledDate || prepareBusy) && (
              <div className="qbd-muted" style={{ padding: '0 12px 8px', fontSize: 11 }}>
                {prepareBusy && !stmtDate ? 'Finding the next period after your last reconciliation…'
                  : lastReconciledDate
                    ? <>Last reconciled: <strong>{fmtReconDate(lastReconciledDate)}</strong>
                      {stmtDate ? <> — loading <strong>{periodLabel(stmtDate)}</strong></> : null}
                    </>
                    : stmtDate ? <>Loading <strong>{periodLabel(stmtDate)}</strong> statement…</> : null}
              </div>
            )}
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
            <div className="frow"><label>Beginning balance</label>
              <input type="text" readOnly value={prepareBusy && !beginBal ? '…' : (beginBal ? fmt(+beginBal) : '—')} style={{ textAlign: 'right', width: 150, background: '#f5f7fa' }} />
              <span
                className="qbd-link"
                onClick={() => showToast && showToast('The beginning balance is the ending balance from your last completed reconciliation. If it does not match your statement, a prior period was changed or not reconciled — reconcile the earlier period first, or use Undo / Reopen on it.')}
              >
                What if my beginning balance doesn&apos;t match?
              </span>
            </div>
            <div className="frow"><label>Ending balance</label>
              <input type="number" step="0.01" value={endBal} onChange={(e) => setEndBal(e.target.value)} placeholder="From bank statement" style={{ textAlign: 'right', width: 150 }} />
            </div>
            {isCreditCardAccount(accounts.find((a) => a.id === accountId)) && (
              <>
                <div className="fsec">Credit card payment due</div>
                <div className="fsec-sub">
                  Statement due date is for reference. Payment date and amount go on the cash register (change payment date if you will pay early or late).
                </div>
                <div className="frow"><label>Statement due date</label>
                  <input
                    type="date"
                    value={paymentDueDate}
                    onChange={(e) => setPaymentDueDate(e.target.value)}
                  />
                  <span className="fsub">Payment date</span>
                  <input
                    type="date"
                    value={paymentDate || paymentDueDate}
                    onChange={(e) => {
                      paymentDateTouchedRef.current = true;
                      setPaymentDate(e.target.value);
                    }}
                  />
                  <span className="fsub">Amount</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={paymentDueAmount}
                    onChange={(e) => {
                      paymentDueAmountTouchedRef.current = true;
                      setPaymentDueAmount(e.target.value);
                    }}
                    placeholder="Payment amount"
                    style={{ textAlign: 'right', width: 120 }}
                  />
                </div>
                <div className="frow"><label>Pay from register</label>
                  <div style={{ minWidth: 280, flex: 1, maxWidth: 420 }}>
                    <AccountCombobox
                      accounts={cashAccounts}
                      value={payFromAccountId}
                      onChange={(id) => {
                        setPayFromAccountId(id);
                        try { localStorage.setItem('qbd-cc-pay-from', id || ''); } catch { /* ignore */ }
                      }}
                      placeholder="— select cash account —"
                    />
                  </div>
                </div>
                {paymentDueSyncMsg && (
                  <div className="qbd-muted" style={{ padding: '0 12px 8px', fontSize: 11 }}>
                    {paymentDueSyncMsg}
                  </div>
                )}
              </>
            )}
            <div className="fsec">Enter any service charge or interest earned.</div>
            <div className="fsec-sub">Only enter amounts that are not already in your register — the reconcile screen also reads these off the statement.</div>
            <div className="frow"><label>Service charge</label>
              <input type="number" step="0.01" min="0" value={serviceCharge} onChange={(e) => setServiceCharge(e.target.value)} placeholder="0.00" style={{ textAlign: 'right', width: 90 }} />
              <span className="fsub">Date</span>
              <input type="date" value={scDate || stmtDate} onChange={(e) => setScDate(e.target.value)} />
              <span className="fsub">Account</span>
              <div style={{ minWidth: 220, flex: 1, maxWidth: 360 }}>
                <AccountCombobox
                  accounts={expenseAccounts}
                  value={scAccountId}
                  onChange={setScAccountId}
                  placeholder="Auto — Bank Service Charges"
                />
              </div>
            </div>
            <div className="frow"><label>Interest earned</label>
              <input type="number" step="0.01" min="0" value={interestEarned} onChange={(e) => setInterestEarned(e.target.value)} placeholder="0.00" style={{ textAlign: 'right', width: 90 }} />
              <span className="fsub">Date</span>
              <input type="date" value={intDate || stmtDate} onChange={(e) => setIntDate(e.target.value)} />
              <span className="fsub">Account</span>
              <div style={{ minWidth: 220, flex: 1, maxWidth: 360 }}>
                <AccountCombobox
                  accounts={incomeAccounts}
                  value={intAccountId}
                  onChange={setIntAccountId}
                  placeholder="Auto — Interest Income"
                />
              </div>
            </div>
            <div className="frow"><label>Bank statement</label>
              <div style={{ flex: 1, maxWidth: 560 }}>
                {statementPdfUrl ? (
                  <div style={{ border: '1px solid #c9d3df', borderRadius: 4, overflow: 'hidden', background: '#525659' }}>
                    <div className="qbd-muted" style={{ padding: '4px 8px', fontSize: 10, background: '#eef4fb', color: '#2a5596' }}>
                      Statement attached for {periodLabel(stmtDate)}
                    </div>
                    <iframe
                      title="Bank statement preview"
                      src={`${statementPdfUrl}#toolbar=0&navpanes=0&view=FitH`}
                      style={{ width: '100%', height: 220, border: 0, display: 'block' }}
                    />
                  </div>
                ) : (
                  <>
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
                      disabled={uploadBusy || !accountId || prepareBusy}
                      onClick={() => statementFileRef.current && statementFileRef.current.click()}
                      style={{ fontWeight: 'bold' }}
                    >
                      {uploadBusy ? 'Reading statement…' : prepareBusy ? 'Looking for statement…' : '⬆ Upload statement (PDF / OFX)'}
                    </button>
                    <div className="qbd-muted" style={{ fontSize: 10, marginTop: 4 }}>
                      The next period after your last close is chosen automatically. The statement PDF is attached when found in your bank folders or from a prior upload.
                    </div>
                  </>
                )}
              </div>
            </div>
            {prepareMsg && (
              <div className="qbd-muted" style={{ padding: '0 12px 8px', fontSize: 11, color: /invalid|failed|error|not found/i.test(prepareMsg) ? '#b3261e' : undefined }}>
                {prepareMsg}
              </div>
            )}
          </>
        )}
        <div className="qbd-botbar">
          <button type="button" className="qbd-btn" disabled={busy || prepareBusy || !accountId} onClick={start} title="Open the reconcile worksheet to find unmatched items and the difference">Locate Discrepancies</button>
          <button type="button" className="qbd-btn" disabled={busy || prepareBusy || !accountId} onClick={undoLastReconciliation} title="Undo the most recent closed month for this account (e.g. January when starting February) so you can rework it until ending matches that statement">Undo Last Reconciliation</button>
          <span className="sp" />
          <button className="qbd-btn" disabled={busy || prepareBusy || !accountId} onClick={start} style={{ fontWeight: 'bold', background: 'linear-gradient(#dff3e2,#bfe6c8)' }}>Continue →</button>
          <button type="button" className="qbd-btn" disabled={busy || prepareBusy} onClick={() => navigate('/')}>Cancel</button>
        </div>
      </div>
      {reportOverlay}
      </>
    );
  }

  // Hard rule: never show green CLOSED if the live worksheet difference is not $0.00.
  const sessionBannerBalanced = !!(periodSession?.balanced && balanced);
  const sessionBannerCompromised = !!(periodSession?.balanced && !balanced);
  const sessionBanner = periodSession ? (
    <div className="qbd-recon-banner" style={{
      background: sessionBannerBalanced ? '#eaf6ec' : '#fdecea',
      color: sessionBannerBalanced ? '#2f6b3a' : '#b3261e',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
      borderBottom: '1px solid #c9d3df',
    }}>
      <span>
        {sessionBannerBalanced ? '✓' : '⚠'} Reconcile {periodLabel(periodSession.statementDate)} (
          {sessionBannerCompromised ? 'CLOSED — worksheet out of balance' : periodSession.status}
        )
        {periodSession.clearedCount != null ? ` — ${periodSession.clearedCount} cleared lines` : ''}
        {!sessionBannerBalanced && difference != null ? ` — difference ${fmt(difference)}` : ''}
      </span>
      {sessionBannerCompromised && (
        <span className="qbd-muted" style={{ color: '#b3261e' }}>
          Hard rule: Cleared must equal statement. Do not treat this as reconciled until Difference is $0.00.
        </span>
      )}
      {periodSession.message && <span className="qbd-muted">{periodSession.message}</span>}
      {canReopen && (
        <button className="qbd-btn" disabled={busy} onClick={reopenPeriod} style={{ marginLeft: 'auto' }} title="Undo this reconciliation and reopen the period so you can re-do it">
          {needsReopen || sessionBannerCompromised ? 'Reopen period' : 'Undo / Reopen'}
        </button>
      )}
      {!isCard && (
        <button
          type="button"
          className="qbd-btn"
          disabled={busy}
          onClick={undoLastReconciliation}
          style={canReopen ? undefined : { marginLeft: 'auto' }}
          title="Reopen the most recent closed month for this account so you can rework it until its ending balance matches that month's bank statement"
        >
          Redo Previous Reconciliation
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="qbd-window qbd-recon-window">
      <div className="qbd-wtitle">Reconcile — {data.account.account_number} · {leafLabel(data.account.account_name)}
        {isCard && <span style={{ fontWeight: 'normal', fontSize: 11, marginLeft: 8 }}>(Credit card)</span>}
        <span className="x" onClick={() => {
          // Same as Leave: an explicit exit clears the auto-resume pointer and
          // the ?go=1 params so neither a refresh nor the next /reconcile visit
          // drags the user back into a worksheet they closed.
          try { localStorage.removeItem(RECON_IN_PROGRESS_KEY); } catch { /* ignore */ }
          setSearchParams({}, { replace: true });
          setStarted(false); setData(null);
        }}>✕</span>
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
          <div className="qbd-recon-register-split" ref={registerSplitRef}>
            <div className="qbd-recon-subpane" style={{ width: `calc(${registerSplitPct}% - 3px)` }}>
              <div className="qbd-recon-panehead">
                {isCard ? 'Payments' : 'Checks and Payments'}{' '}
                <span className="qbd-muted">{paymentCount} cleared · {fmt(markedPayments)}</span>
                <span className="sp" />
                <button type="button" className="qbd-btn qbd-pane-btn" disabled={busy || !paymentCount} onClick={() => unmarkSide('payment')} title="Clear all cleared checkmarks in this pane">Unmark</button>
              </div>
              <div className="qbd-recon-panebody" ref={regScrollRef}>
                <RegisterTable
                  entries={paymentEntries}
                  account={account}
                  labels={labels}
                  checked={checked}
                  matchedSet={matchedGlSet}
                  highlightGlId={highlightGlId}
                  selectedId={selectedId}
                  highlightMarked={highlightMarked}
                  showNum={showNum}
                  showDate={showDate}
                  showPayee={showPayee}
                  showCategory={showCategory}
                  onToggle={toggle}
                  onSelect={setSelectedId}
                  onHover={setHighlightGlId}
                  onDrill={drillEntryOpen}
                  compact
                  amountSide="payment"
                />
              </div>
            </div>
            <div
              className="qbd-recon-gutter qbd-recon-gutter-inner"
              role="separator"
              aria-orientation="vertical"
              aria-valuenow={Math.round(registerSplitPct)}
              title={isCard ? 'Drag to resize payments vs charges' : 'Drag to resize checks vs deposits'}
              onMouseDown={startRegisterResize}
            />
            <div className="qbd-recon-subpane" style={{ width: `calc(${100 - registerSplitPct}% - 3px)` }}>
              <div className="qbd-recon-panehead">
                {isCard ? 'Charges' : 'Deposits and Other Credits'}{' '}
                <span className="qbd-muted">{depositCount} cleared · {fmt(markedDeposits)}</span>
                <span className="sp" />
                <button type="button" className="qbd-btn qbd-pane-btn" disabled={busy || !depositCount} onClick={() => unmarkSide('deposit')} title="Clear all cleared checkmarks in this pane">Unmark</button>
              </div>
              <div className="qbd-recon-panebody">
                <RegisterTable
                  entries={depositEntries}
                  account={account}
                  labels={labels}
                  checked={checked}
                  matchedSet={matchedGlSet}
                  highlightGlId={highlightGlId}
                  selectedId={selectedId}
                  highlightMarked={highlightMarked}
                  showNum={showNum}
                  showDate={showDate}
                  showPayee={showPayee}
                  showCategory={showCategory}
                  onToggle={toggle}
                  onSelect={setSelectedId}
                  onHover={setHighlightGlId}
                  onDrill={drillEntryOpen}
                  compact
                  amountSide="deposit"
                />
              </div>
            </div>
          </div>
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
        <button
          type="button"
          className="qbd-btn"
          disabled={busy}
          onClick={() => setShowMissingTxn(true)}
          title="Post a payment, deposit, or charge that is on the statement but missing from this account"
          style={{ fontWeight: 'bold', background: 'linear-gradient(#fff6e0,#ffe6a8)' }}
        >
          + Missing Transaction
        </button>
        <button
          type="button"
          className="qbd-btn"
          disabled={busy || !(selectedId || highlightGlId)}
          onClick={deleteSelectedTransaction}
          title="Delete the highlighted transaction (posts an offsetting entry; removes it from this register)"
          style={{ fontWeight: 'bold', color: '#b3261e', background: 'linear-gradient(#fdecea,#f5c6c2)' }}
        >
          − Delete Transaction
        </button>
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
              <label><input type="checkbox" checked={showCategory} onChange={(e) => setShowCategory(e.target.checked)} /> Category</label>
              <button type="button" className="qbd-btn" style={{ fontSize: 10 }} onClick={() => { setRegisterSplitPct(DEFAULT_REGISTER_SPLIT); setShowColsMenu(false); }}>Reset pane width</button>
              <button type="button" className="qbd-btn" style={{ fontSize: 10 }} onClick={() => { setStmtSplitPct(DEFAULT_STMT_SPLIT); setStmtZoom(DEFAULT_STMT_ZOOM); setShowColsMenu(false); }}>Reset statement size &amp; zoom</button>
            </div>
          )}
        </div>
        <button type="button" className="qbd-btn" disabled={busy || reportBusy} onClick={() => setShowReportPicker(true)} title="Preview a QuickBooks-style reconciliation report on screen">
          {reportBusy ? 'Preparing…' : '🖨 Reconciliation Report'}
        </button>
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
          {isCard && (
            <>
              <label style={{ marginLeft: 12 }}>Statement due
                <input type="date" value={paymentDueDate} onChange={(e) => setPaymentDueDate(e.target.value)} style={{ marginLeft: 6 }} />
              </label>
              <label style={{ marginLeft: 12 }}>Payment date
                <input
                  type="date"
                  value={paymentDate || paymentDueDate}
                  onChange={(e) => {
                    paymentDateTouchedRef.current = true;
                    setPaymentDate(e.target.value);
                  }}
                  style={{ marginLeft: 6 }}
                />
              </label>
              <label style={{ marginLeft: 12 }}>Pay amount
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={paymentDueAmount}
                  onChange={(e) => {
                    paymentDueAmountTouchedRef.current = true;
                    setPaymentDueAmount(e.target.value);
                  }}
                  style={{ width: 100, marginLeft: 6, textAlign: 'right' }}
                />
              </label>
              <label style={{ marginLeft: 12, minWidth: 220 }}>Pay from
                <div style={{ display: 'inline-block', minWidth: 200, marginLeft: 6, verticalAlign: 'middle' }}>
                  <AccountCombobox
                    accounts={cashAccounts}
                    value={payFromAccountId}
                    onChange={(id) => {
                      setPayFromAccountId(id);
                      try { localStorage.setItem('qbd-cc-pay-from', id || ''); } catch { /* ignore */ }
                    }}
                    placeholder="Cash account"
                  />
                </div>
              </label>
            </>
          )}
          <span className="qbd-muted" style={{ marginLeft: 12 }}>
            {isCard && paymentDueSyncMsg ? paymentDueSyncMsg : 'Verify these match your statement if Difference ≠ $0.00'}
          </span>
        </div>
      )}
      <div className="qbd-recon-summary-bar">
        <div className="sum-block">
          <div className="sum-row"><span className="sum-lbl">Beginning Balance</span><span className="sum-val" style={beginningMismatch ? { color: '#b3261e', fontWeight: 'bold' } : undefined}>{fmt(beginning)}</span></div>
          {beginningMismatch && (
            <div className="sum-sub" style={{ color: '#b3261e', maxWidth: 420 }}>
              Statement previous balance is {fmt(statementPreviousBalance)}. A prior month was likely closed with the wrong ending balance.
              Use <strong>Redo Previous Reconciliation</strong> to reopen and rework that month first.
            </div>
          )}
          <div className="sum-sub">Items you have marked cleared</div>
          <div className="sum-row"><span className="sum-lbl">{depositCount} {isCard ? 'Charges and Cash Advances' : 'Deposits and Other Credits'}</span><span className="sum-val">{fmt(markedDeposits)}</span></div>
          <div className="sum-row"><span className="sum-lbl">{paymentCount} {isCard ? 'Payments and Credits' : 'Checks and Payments'}</span><span className="sum-val">{fmt(markedPayments)}</span></div>
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
        {pendingDrafts > 0 && (
          <span className="qbd-muted" style={{ color: '#8a6d00', marginLeft: 12 }}>
            ⚠ {pendingDrafts} unposted draft {pendingDrafts === 1 ? 'entry' : 'entries'} on this account dated on or before {fmtReconDate(stmtDate)} — not included in this reconciliation.{' '}
            <a
              href="/journal"
              onClick={(e) => {
                e.preventDefault();
                navigate(`/journal?status=DRAFT&accountId=${encodeURIComponent(accountId)}&through=${encodeURIComponent(stmtDate)}&from=recon`);
              }}
              style={{ color: '#1a56a8' }}
            >
              Review drafts
            </a>
          </span>
        )}
        <span className="sp" />
        {!isCard && (
          <button
            type="button"
            className="qbd-btn"
            disabled={busy}
            onClick={undoLastReconciliation}
            title="Reopen the most recent closed month (e.g. January when reconciling February) and rework until ending matches that statement"
          >
            Redo Previous Reconciliation
          </button>
        )}
        {!balanced && (
          <button
            type="button"
            className="qbd-btn"
            disabled
            title="Permanently disabled — plug / force-balance entries are prohibited"
            onClick={enterAdjustment}
          >
            Enter Adjustment… (blocked)
          </button>
        )}
        <button
          className="qbd-btn"
          disabled={busy}
          title="Leave without closing this reconciliation — checkmarks stay saved"
          onClick={() => {
            // Prefer return to the working month (other accounts still need reconciling).
            const acctNo = accounts.find((a) => a.id === accountId)?.account_number || accountNumberForChecked;
            const period = workingPeriodFromContext({
              searchParams,
              entityId,
              accountNumber: acctNo,
              statementDate: stmtDate,
            });
            // Keep RECON_IN_PROGRESS so Banking → Reconcile can resume this worksheet.
            setSearchParams({}, { replace: true });
            setStarted(false);
            if (period || searchParams.get('return') === 'month') {
              showToast && showToast('Back to the month — this account’s checkmarks are saved if you return.');
              navigate(period ? monthlyBooksPath(period.year, period.month) : '/');
            } else {
              showToast && showToast('Left the reconciliation — nothing posted to the ledger');
            }
          }}
        >
          Back to month
        </button>
        <button
          className="qbd-btn qbd-primary"
          disabled={busy || !balanced || checkedIds.length === 0}
          onClick={() => finish('month')}
          title="Close this account’s reconciliation at $0.00 difference, then return to the month so you can reconcile the other accounts"
          style={{ fontWeight: 'bold', background: balanced ? 'linear-gradient(#dff3e2,#bfe6c8)' : undefined }}
        >
          Save &amp; Close
        </button>
        <button
          className="qbd-btn"
          disabled={busy || !balanced || checkedIds.length === 0}
          onClick={() => finish('advance')}
          title="Close this statement and open the next period for the same account (skip when you still have other accounts to reconcile this month)"
        >
          Close &amp; Advance →
        </button>
      </div>
      {drillEntry && (
        <TxnDetailModal
          entry={drillEntry}
          entityId={entityId}
          reconcileAccountId={accountId}
          accounts={allAccounts}
          showToast={showToast}
          onClose={() => setDrillEntry(null)}
          onAccountCreated={addCreatedAccount}
          onVendorRuleApplied={({ accountId: catId, accountLabel, postedUpdate }) => {
            // Patch Category on the register for every JE the rule just reclassed
            // (plus keep cleared checkmarks).
            persistChecked(checkedRef.current || checked);
            const acct = allAccounts.find((a) => a.id === catId);
            const num = acct?.account_number || acct?.number || String(accountLabel || '').split(/[·\s]/)[0] || '';
            const name = acct?.account_name || acct?.name || String(accountLabel || '').replace(/^\d+\s*[·-]?\s*/, '');
            const leaf = String(name || '').includes(':')
              ? String(name).split(':').pop().trim()
              : String(name || '').trim();
            const label = leaf && num ? `${num} ${leaf}` : (accountLabel || num);
            const jeIds = new Set(
              (postedUpdate?.results || [])
                .filter((r) => r?.journalId && !r.skipped)
                .map((r) => r.journalId)
            );
            if (!jeIds.size || !num) return;
            setData((prev) => {
              if (!prev?.entries) return prev;
              return {
                ...prev,
                entries: prev.entries.map((e) => (
                  jeIds.has(e.journal_entry_id)
                    ? {
                      ...e,
                      category_account_number: num,
                      category_account_name: name,
                      category_label: label,
                      category_is_split: false,
                    }
                    : e
                )),
              };
            });
          }}
          onUpdated={(updated) => {
            // Category fix must NOT reload the worksheet — that was wiping every
            // cleared checkmark. Refresh the open detail and patch Category in-register
            // from the same overlay the detail modal uses (rules + Fix category).
            setDrillEntry(updated);
            persistChecked(checkedRef.current || checked);
            if (!updated?.id) return;
            const overlay = applyReclassHistoryToLines(updated.lines || [], updated.reclassHistory || []);
            const cats = overlay.filter((l) =>
              !l._synthetic
              && String(l.account_id) !== String(accountId)
              && ((Number(l.debit) || 0) > 0.005 || (Number(l.credit) || 0) > 0.005)
            );
            if (!cats.length) return;
            const primary = cats[0];
            const isSplit = cats.length > 1;
            const leaf = String(primary.account_name || '').includes(':')
              ? String(primary.account_name).split(':').pop().trim()
              : String(primary.account_name || '').trim();
            const base = leaf ? `${primary.account_number} ${leaf}` : String(primary.account_number || '');
            const label = isSplit ? `${base} +${cats.length - 1}` : base;
            setData((prev) => {
              if (!prev?.entries) return prev;
              return {
                ...prev,
                entries: prev.entries.map((e) => (
                  e.journal_entry_id === updated.id
                    ? {
                      ...e,
                      category_account_number: primary.account_number,
                      category_account_name: primary.account_name,
                      category_label: label,
                      category_is_split: isSplit,
                    }
                    : e
                )),
              };
            });
          }}
          onReversed={() => {
            setDrillEntry(null);
            setSelectedId(null);
            setHighlightGlId(null);
            loadWorksheet();
          }}
        />
      )}
      <RecordMissingTxnModal
        open={showMissingTxn}
        onClose={() => setShowMissingTxn(false)}
        entityId={entityId}
        bankAccount={account || accounts.find((a) => a.id === accountId)}
        accounts={allAccounts}
        defaultDate={stmtDate}
        showToast={showToast}
        onAccountCreated={addCreatedAccount}
        onPosted={handleMissingTxnPosted}
      />
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
