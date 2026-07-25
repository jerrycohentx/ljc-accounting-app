import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext, useNavigate } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountingAPI, accountAPI, bankReconAPI, journalAPI } from '../services/api';
import { leafLabel } from './helpers';
import { fetchStatementObjectUrl } from './reconSourceDrill';
import AccountCombobox, { CREATE_NEW_VALUE } from './AccountCombobox';

const ACCOUNT_TYPE_LABELS = {
  EXPENSE: 'Expenses',
  REVENUE: 'Income',
  ASSET: 'Assets',
  LIABILITY: 'Liabilities',
  EQUITY: 'Equity',
  CONTRA: 'Contra',
};

function suggestAccountNumber(accounts, type) {
  const ranges = {
    ASSET: [1000, 1999],
    LIABILITY: [2000, 2999],
    EQUITY: [3000, 3999],
    REVENUE: [4000, 4999],
    // Keep new expenses in the main OpEx band; 62xx is used by property sub-accounts.
    EXPENSE: [5000, 5999],
    CONTRA: [7000, 7999],
  };
  const [lo, hi] = ranges[type] || [9000, 9999];
  // Numbers must be unique across the whole COA (asset 6253 blocked expense 6253).
  const used = new Set(
    (accounts || [])
      .map((a) => parseInt(a.number, 10))
      .filter((n) => Number.isFinite(n))
  );
  const sameType = (accounts || [])
    .filter((a) => a.type === type)
    .map((a) => parseInt(a.number, 10))
    .filter((n) => Number.isFinite(n) && n >= lo && n <= hi);
  let next = (sameType.length ? Math.max(...sameType) : lo - 10) + 10;
  if (next < lo) next = lo;
  while (next <= hi && used.has(next)) next += 1;
  if (next > hi) {
    next = lo;
    while (next <= hi && used.has(next)) next += 1;
  }
  return next <= hi ? String(next) : '';
}

function accountUsingNumber(accounts, number) {
  const n = String(number || '').trim();
  return (accounts || []).find((a) => String(a.number) === n) || null;
}

function fmtMoney(n) {
  const v = Number(n) || 0;
  return `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

/** Client-side vendor pattern — strips order #s/zips so Contains matches all variants. */
function deriveVendorPatternClient(description) {
  let text = String(description || '')
    .replace(/^Amex(?:\s+stmt\s+\d{4}-\d{2}-\d{2})?:\s*/i, '')
    .replace(/^Categorize\s+\d{4}→\d{4}:\s*/i, '')
    .replace(/\s+-\s+FITID:.*$/i, '')
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, ' ')
    .replace(/\b\d{3,}(?:-\d+)*\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const first = text.split(/\s{2,}/)[0].trim() || text;
  const tokens = first
    .toUpperCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^A-Z0-9*]+|[^A-Z0-9*.]+$/g, ''))
    .filter(Boolean)
    .filter((t) => !US_STATE_CODES.has(t))
    .filter((t) => !/^\d+$/.test(t));
  if (!tokens.length) return '';
  const domain = tokens.find((t) => /\.[A-Z]{2,}/.test(t) || /^WEB\*[A-Z0-9*.]+$/i.test(t));
  if (domain) {
    const bare = domain.replace(/^WEB\*/i, '');
    const pick = bare.length >= 4 ? bare : domain;
    return pick.length >= 3 ? pick : '';
  }
  const words = tokens.filter((t) => /[A-Z]/.test(t) && t.length >= 3).slice(0, 3);
  let cleaned = (words.length ? words : tokens.slice(0, 3)).join(' ').trim();
  if (cleaned.length > 36) {
    const cut = cleaned.slice(0, 36);
    const lastSpace = cut.lastIndexOf(' ');
    cleaned = (lastSpace > 8 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return cleaned.length >= 3 ? cleaned : '';
}

function vendorPatternMatchesClient(text, pattern, matchType = 'contains') {
  const hay = String(text || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const pat = String(pattern || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!hay || pat.length < 3) return false;
  if (matchType === 'exact') return hay === pat;
  if (matchType === 'starts_with') return hay.startsWith(pat);
  return hay.includes(pat);
}

function fmtStmtDate(iso) {
  const d = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  const [y, m, day] = d.split('-');
  return `${m}/${day}/${y.slice(2)}`;
}

function base64ToObjectUrl(b64, mime = 'application/pdf') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

const FOLDER_W_KEY = 'qbd-review-folder-w';
const LIST_SPLIT_KEY = 'qbd-review-list-split';
const DOC_ZOOM_KEY = 'qbd-review-doc-zoom';
const DOC_SHOW_KEY = 'qbd-review-doc-show';
const SORT_BY_KEY = 'qbd-review-sort-by';
const SORT_DIR_KEY = 'qbd-review-sort-dir';

const SORT_COLUMNS = [
  { key: 'date', label: 'Date' },
  { key: 'merchant', label: 'Merchant' },
  { key: 'amount', label: 'Amount' },
  { key: 'category', label: 'Category' },
];

function itemMerchant(it) {
  return String((it.descLines && it.descLines[0]) || it.sourceDescription || '').trim().toUpperCase();
}

function itemCategoryLabel(it) {
  const num = String(it.categoryAccountNumber || '');
  const name = leafLabel(it.categoryAccountName || '');
  return `${num} ${name}`.trim().toUpperCase();
}

function compareReviewItems(a, b, sortBy, sortDir) {
  let cmp = 0;
  if (sortBy === 'date') {
    cmp = String(a.postingDate || '').localeCompare(String(b.postingDate || ''));
  } else if (sortBy === 'merchant') {
    cmp = itemMerchant(a).localeCompare(itemMerchant(b));
  } else if (sortBy === 'amount') {
    cmp = (Number(a.amount) || 0) - (Number(b.amount) || 0);
  } else if (sortBy === 'category') {
    cmp = itemCategoryLabel(a).localeCompare(itemCategoryLabel(b));
  }
  if (cmp === 0) {
    cmp = String(a.id || '').localeCompare(String(b.id || ''));
  }
  return sortDir === 'desc' ? -cmp : cmp;
}

/** Drag gutter: percent of a horizontal split container. */
function useSplitResize(splitRef, setSplitPct, minPct = 25, maxPct = 80) {
  const dragging = useRef(false);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current || !splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      if (rect.width < 40) return;
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

/** Drag gutter: pixel width for the folder sidebar. */
function useFolderWidthResize(setWidthPx, { min = 140, max = 420 } = {}) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(220);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return;
      const next = startW.current + (e.clientX - startX.current);
      setWidthPx(Math.min(max, Math.max(min, Math.round(next))));
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
  }, [max, min, setWidthPx]);

  return useCallback((e, currentWidth) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = currentWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);
}

const styles = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    height: '100%',
    background: '#fff',
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    color: '#1a1a1a',
    overflow: 'hidden',
  },
  head: {
    padding: '8px 14px 6px',
    borderBottom: '1px solid #ddd',
    display: 'flex',
    alignItems: 'baseline',
    gap: 12,
    flexShrink: 0,
  },
  title: { fontSize: 16, fontWeight: 650, margin: 0 },
  sub: { fontSize: 12, color: '#555' },
  body: { display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' },
  folders: {
    flexShrink: 0,
    overflowY: 'auto',
    background: '#f7f7f5',
    padding: '8px 0',
    minHeight: 0,
  },
  feedBtn: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    border: 'none',
    background: 'transparent',
    padding: '7px 14px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 650,
  },
  monthBtn: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    border: 'none',
    background: 'transparent',
    padding: '6px 14px 6px 28px',
    cursor: 'pointer',
    fontSize: 13,
  },
  main: { flex: 1, display: 'flex', minWidth: 0, minHeight: 0, overflow: 'hidden' },
  listPane: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    minWidth: 280,
    overflow: 'hidden',
  },
  listHead: {
    padding: '8px 12px',
    borderBottom: '1px solid #e5e5e5',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexShrink: 0,
    background: '#fafafa',
  },
  list: { flex: 1, overflowY: 'auto', overflowX: 'auto', padding: '0 6px 16px', minHeight: 0 },
  colHead: {
    display: 'grid',
    gridTemplateColumns: '24px 64px minmax(120px, 1fr) 88px minmax(180px, 280px)',
    gap: 8,
    alignItems: 'center',
    padding: '4px 6px 6px',
    borderBottom: '1px solid #d0d0d0',
    background: '#f3f5f8',
    position: 'sticky',
    top: 0,
    zIndex: 1,
  },
  sortBtn: {
    border: 'none',
    background: 'transparent',
    padding: '2px 0',
    margin: 0,
    fontSize: 11,
    fontWeight: 650,
    color: '#35557a',
    cursor: 'pointer',
    textAlign: 'left',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    userSelect: 'none',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '24px 64px minmax(120px, 1fr) 88px minmax(180px, 280px)',
    gap: 8,
    alignItems: 'start',
    padding: '8px 6px',
    borderBottom: '1px solid #e0e0e0',
  },
  alwaysLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    marginTop: 4,
    fontSize: 11,
    color: '#1a6fb5',
    cursor: 'pointer',
    lineHeight: 1.25,
    userSelect: 'none',
  },
  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.35)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: '#fff',
    border: '1px solid #999',
    borderRadius: 4,
    width: 420,
    maxWidth: '92vw',
    padding: 16,
    boxShadow: '0 8px 28px rgba(0,0,0,0.25)',
  },
  modalTitle: { margin: '0 0 12px', fontSize: 16, fontWeight: 650 },
  field: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 },
  label: { fontSize: 12, color: '#444' },
  input: { fontSize: 13, padding: '6px 8px', border: '1px solid #aaa', borderRadius: 2 },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
  date: { fontSize: 12, paddingTop: 2, color: '#222' },
  desc: { fontSize: 12, lineHeight: 1.3, minWidth: 0 },
  descLine: { whiteSpace: 'normal', wordBreak: 'break-word' },
  amount: { fontSize: 12, textAlign: 'right', paddingTop: 2, fontVariantNumeric: 'tabular-nums' },
  catSelect: { width: '100%', minWidth: 0 },
  docPane: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    background: '#525659',
    minHeight: 0,
    minWidth: 200,
    overflow: 'hidden',
  },
  docBar: {
    padding: '6px 10px',
    background: '#3d4043',
    color: '#eee',
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
    flexWrap: 'wrap',
  },
  zoomBtn: {
    border: '1px solid #777',
    background: '#4a4e52',
    color: '#fff',
    padding: '0 7px',
    minWidth: 24,
    height: 22,
    fontSize: 14,
    fontWeight: 700,
    lineHeight: 1,
    cursor: 'pointer',
    borderRadius: 2,
  },
  iframe: { flex: 1, width: '100%', border: 'none', background: '#525659', minHeight: 0 },
  bot: {
    borderTop: '1px solid #ddd',
    padding: '6px 14px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
    background: '#f5f5f5',
  },
  btn: {
    border: '1px solid #aaa',
    background: '#fff',
    padding: '5px 12px',
    fontSize: 13,
    cursor: 'pointer',
    borderRadius: 2,
  },
  btnPrimary: {
    border: '1px solid #1a5f9e',
    background: '#1a6fb5',
    color: '#fff',
    padding: '5px 14px',
    fontSize: 13,
    cursor: 'pointer',
    borderRadius: 2,
    fontWeight: 650,
  },
  empty: { padding: 32, color: '#666', fontSize: 14 },
};

export default function QBDDraftJournals() {
  const { entityId } = useEntity();
  const { showToast } = useOutletContext() || {};
  const navigate = useNavigate();
  const toast = (m) => (showToast ? showToast(m) : null);

  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [feedKey, setFeedKey] = useState(null);
  const [monthKey, setMonthKey] = useState(null);
  const [openFeeds, setOpenFeeds] = useState(() => new Set(['amex', 'bank', 'other']));
  const [docUrl, setDocUrl] = useState(null);
  const [docLabel, setDocLabel] = useState('');
  const [docBusy, setDocBusy] = useState(false);
  const docUrlRef = useRef(null);
  const [createForItem, setCreateForItem] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newAcct, setNewAcct] = useState({
    accountNumber: '',
    accountName: '',
    accountType: 'EXPENSE',
    description: '',
  });
  const [ruleForItem, setRuleForItem] = useState(null);
  const [rulePattern, setRulePattern] = useState('');
  const [ruleMatchType, setRuleMatchType] = useState('contains');
  const [savingRule, setSavingRule] = useState(false);

  const [folderW, setFolderW] = useState(() => {
    const saved = parseInt(localStorage.getItem(FOLDER_W_KEY) || '', 10);
    return Number.isFinite(saved) && saved >= 140 && saved <= 420 ? saved : 200;
  });
  const [listSplitPct, setListSplitPct] = useState(() => {
    const saved = parseFloat(localStorage.getItem(LIST_SPLIT_KEY) || '');
    return Number.isFinite(saved) && saved >= 25 && saved <= 80 ? saved : 55;
  });
  const [docZoom, setDocZoom] = useState(() => {
    const saved = parseInt(localStorage.getItem(DOC_ZOOM_KEY) || '', 10);
    if (saved === 0) return 0;
    return Number.isFinite(saved) && saved >= 40 && saved <= 250 ? saved : 100;
  });
  const [showDoc, setShowDoc] = useState(() => localStorage.getItem(DOC_SHOW_KEY) !== 'false');
  const [sortBy, setSortBy] = useState(() => {
    const saved = localStorage.getItem(SORT_BY_KEY);
    return SORT_COLUMNS.some((c) => c.key === saved) ? saved : 'date';
  });
  const [sortDir, setSortDir] = useState(() => (
    localStorage.getItem(SORT_DIR_KEY) === 'desc' ? 'desc' : 'asc'
  ));

  const mainSplitRef = useRef(null);
  const startFolderResize = useFolderWidthResize(setFolderW);
  const startListResize = useSplitResize(mainSplitRef, setListSplitPct, 28, 78);

  useEffect(() => {
    localStorage.setItem(FOLDER_W_KEY, String(folderW));
  }, [folderW]);
  useEffect(() => {
    localStorage.setItem(LIST_SPLIT_KEY, String(Math.round(listSplitPct)));
  }, [listSplitPct]);
  useEffect(() => {
    localStorage.setItem(DOC_ZOOM_KEY, String(docZoom));
  }, [docZoom]);
  useEffect(() => {
    localStorage.setItem(DOC_SHOW_KEY, showDoc ? 'true' : 'false');
  }, [showDoc]);
  useEffect(() => {
    localStorage.setItem(SORT_BY_KEY, sortBy);
  }, [sortBy]);
  useEffect(() => {
    localStorage.setItem(SORT_DIR_KEY, sortDir);
  }, [sortDir]);

  const zoomIn = useCallback(() => setDocZoom((z) => Math.min(250, (z > 0 ? z : 100) + 15)), []);
  const zoomOut = useCallback(() => setDocZoom((z) => Math.max(40, (z > 0 ? z : 100) - 15)), []);
  const zoomFit = useCallback(() => setDocZoom(0), []);

  const revokeDoc = () => {
    if (docUrlRef.current) {
      URL.revokeObjectURL(docUrlRef.current);
      docUrlRef.current = null;
    }
    setDocUrl(null);
  };

  const load = useCallback(() => {
    if (!entityId) return;
    setLoading(true);
    accountingAPI.categorizationReview(entityId, { limit: 1000 })
      .then((r) => {
        const data = r.data || r;
        setPayload(data);
        const feeds = data.feeds || [];
        if (feeds.length) {
          const first = feeds[0];
          setFeedKey((prev) => prev || first.key);
          const m0 = (first.months || [])[0];
          setMonthKey((prev) => prev || (m0 && m0.key) || null);
          setOpenFeeds((s) => {
            const n = new Set(s);
            feeds.forEach((f) => n.add(f.key));
            return n;
          });
        }
      })
      .catch(() => toast('Could not load charges to review'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

  useEffect(() => { setSel(new Set()); load(); }, [load]);

  useEffect(() => () => revokeDoc(), []);

  const feeds = payload?.feeds || [];
  const accounts = payload?.accounts || payload?.expenseAccounts || [];
  const activeFeed = feeds.find((f) => f.key === feedKey) || feeds[0] || null;
  const activeMonth = (activeFeed?.months || []).find((m) => m.key === monthKey)
    || (activeFeed?.months || [])[0]
    || null;
  const items = activeMonth?.items || [];
  const sortedItems = useMemo(
    () => items.slice().sort((a, b) => compareReviewItems(a, b, sortBy, sortDir)),
    [items, sortBy, sortDir]
  );

  const allSelected = sortedItems.length > 0 && sortedItems.every((it) => sel.has(it.id));
  const selectedItems = useMemo(
    () => sortedItems.filter((it) => sel.has(it.id)),
    [sortedItems, sel]
  );

  const toggleSort = (key) => {
    if (sortBy === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir(key === 'amount' ? 'desc' : 'asc');
    }
  };

  const toggle = (id) => setSel((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const toggleAll = () => setSel(allSelected ? new Set() : new Set(sortedItems.map((it) => it.id)));

  const selectMonth = (fk, mk) => {
    setFeedKey(fk);
    setMonthKey(mk);
    setSel(new Set());
  };

  // Load source statement / PDF for the open month folder
  useEffect(() => {
    let cancelled = false;
    async function loadDoc() {
      revokeDoc();
      if (!entityId || !activeFeed || !activeMonth) return;
      setDocBusy(true);
      setDocLabel('');
      try {
        // Prefer an attached PDF on any charge in this month
        const withDoc = (activeMonth.items || []).find((it) => it.documentJournalId);
        if (withDoc?.documentJournalId) {
          const url = await journalAPI.getDocumentObjectUrl(entityId, withDoc.documentJournalId);
          if (cancelled) { URL.revokeObjectURL(url); return; }
          docUrlRef.current = url;
          setDocUrl(url);
          setDocLabel('Statement / source document for this group');
          return;
        }
        // Fall back to bank/card statement file for the cycle
        if (activeFeed.accountId && activeMonth.statementDate) {
          const url = await fetchStatementObjectUrl(
            entityId,
            activeFeed.accountId,
            activeMonth.statementDate
          );
          if (url) {
            if (cancelled) { URL.revokeObjectURL(url); return; }
            docUrlRef.current = url;
            setDocUrl(url);
            setDocLabel(`Statement ${activeMonth.statementDate}`);
            return;
          }
        }
        // Last resort: try statement-file for each unique statementDate on items
        const dates = [...new Set((activeMonth.items || []).map((it) => it.statementDate).filter(Boolean))];
        for (const d of dates) {
          if (!activeFeed.accountId) break;
          try {
            const r = await bankReconAPI.statementFile(entityId, activeFeed.accountId, d);
            const data = r.data || {};
            if (data.found && data.dataBase64) {
              const url = base64ToObjectUrl(data.dataBase64, data.mime || 'application/pdf');
              if (cancelled) { URL.revokeObjectURL(url); return; }
              docUrlRef.current = url;
              setDocUrl(url);
              setDocLabel(`Statement ${data.matchedStatementDate || d}`);
              return;
            }
          } catch { /* try next */ }
        }
        if (!cancelled) setDocLabel('No source PDF on file for this month yet');
      } catch {
        if (!cancelled) setDocLabel('Could not open the source document');
      } finally {
        if (!cancelled) setDocBusy(false);
      }
    }
    loadDoc();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, activeFeed?.key, activeMonth?.key, activeMonth?.statementDate]);

  const applyCategoryToItem = (itemId, d) => {
    setPayload((prev) => {
      if (!prev) return prev;
      const feedsNext = (prev.feeds || []).map((f) => ({
        ...f,
        months: (f.months || []).map((m) => ({
          ...m,
          items: (m.items || []).map((it) => (
            it.id === itemId
              ? {
                ...it,
                categoryAccountId: d.categoryAccountId,
                categoryAccountNumber: d.categoryAccountNumber,
                categoryAccountName: d.categoryAccountName,
              }
              : it
          )),
        })),
      }));
      return { ...prev, feeds: feedsNext };
    });
  };

  const changeCategory = async (item, accountId) => {
    if (!accountId) return;
    if (accountId === CREATE_NEW_VALUE) {
      setCreateForItem(item);
      setNewAcct({
        accountNumber: suggestAccountNumber(accounts, 'EXPENSE'),
        accountName: '',
        accountType: 'EXPENSE',
        description: (item.descLines && item.descLines[0]) || '',
      });
      return;
    }
    if (accountId === item.categoryAccountId) return;
    try {
      const r = await accountingAPI.setCategorizationCategory(entityId, item.id, accountId);
      const d = r.data || r;
      applyCategoryToItem(item.id, d);
      toast(`Saved — future ${item.descLines[0] || 'similar'} charges will use this category`);
    } catch (e) {
      toast('Could not save category: ' + ((e.response && e.response.data && e.response.data.error) || e.message));
    }
  };

  const openAlwaysRule = (item) => {
    if (!item.categoryAccountId) {
      toast('Pick a category first, then save the vendor rule');
      return;
    }
    const raw = (item.descLines && item.descLines[0]) || item.sourceDescription || '';
    const suggested = deriveVendorPatternClient(raw);
    setRulePattern(suggested);
    setRuleMatchType('contains');
    setRuleForItem(item);
  };

  const allReviewItems = useMemo(() => {
    const out = [];
    for (const f of feeds || []) {
      for (const m of f.months || []) {
        for (const it of m.items || []) out.push(it);
      }
    }
    return out;
  }, [feeds]);

  const ruleMatchPreviewCount = useMemo(() => {
    const pat = String(rulePattern || '').trim();
    if (!ruleForItem || pat.length < 3) return 0;
    return allReviewItems.filter((it) => {
      const text = [(it.descLines && it.descLines[0]) || '', it.sourceDescription || ''].join(' ');
      return vendorPatternMatchesClient(text, pat, ruleMatchType);
    }).length;
  }, [allReviewItems, ruleForItem, rulePattern, ruleMatchType]);

  const saveVendorRule = async () => {
    if (!ruleForItem) return;
    const pattern = String(rulePattern || '').trim();
    if (pattern.length < 3) {
      toast('Pattern needs at least 3 characters');
      return;
    }
    const acct = accounts.find((a) => a.id === ruleForItem.categoryAccountId);
    const matchCount = ruleMatchPreviewCount;
    if (
      matchCount > 1
      && !window.confirm(
        `Save rule and post all ${matchCount} matching charges now? They will leave Review & Approve.`
      )
    ) {
      return;
    }
    setSavingRule(true);
    try {
      const res = await accountingAPI.createVendorRule(entityId, {
        pattern,
        accountId: ruleForItem.categoryAccountId,
        label: acct
          ? `${acct.number} · ${leafLabel(acct.name)}`
          : `Vendor: ${pattern.slice(0, 28)}`,
        description: (ruleForItem.descLines && ruleForItem.descLines[0]) || '',
        matchType: ruleMatchType,
        applyToOpenDrafts: true,
        postMatchingDrafts: true,
      });
      const body = res?.data || res || {};
      const matched = Number(body.draftUpdate?.matched || 0);
      const posted = Number(body.postResult?.posted || 0);
      const failed = Number(body.postResult?.failed || 0);
      toast(
        failed
          ? `Posted ${posted} of ${matched}; ${failed} failed — ${(body.postResult?.errors?.[0]?.error) || 'see logs'}`
          : posted > 0
            ? `Done — posted ${posted} matching charge${posted === 1 ? '' : 's'} and removed them from the list`
            : matched > 0
              ? 'Rule saved — matching charges were already posted'
              : 'Rule saved — future matching charges will use this category'
      );
      setRuleForItem(null);
      setSel(new Set());
      load();
    } catch (e) {
      toast('Could not save rule: ' + ((e.response && e.response.data && e.response.data.error) || e.message));
    } finally {
      setSavingRule(false);
    }
  };

  const saveNewAccount = async () => {
    const number = String(newAcct.accountNumber || '').trim();
    const name = String(newAcct.accountName || '').trim();
    const accountType = newAcct.accountType || 'EXPENSE';
    if (!number || !name) {
      toast('Enter an account number and name');
      return;
    }
    const clash = accountUsingNumber(accounts, number);
    if (clash) {
      toast(
        `${number} is already “${leafLabel(clash.name)}” (${ACCOUNT_TYPE_LABELS[clash.type] || clash.type}). `
        + 'Pick a free number, or choose that account from the dropdown if it’s the right one.'
      );
      setNewAcct((f) => ({ ...f, accountNumber: suggestAccountNumber(accounts, accountType) }));
      return;
    }
    setCreating(true);
    try {
      const created = await accountAPI.create(entityId, {
        accountNumber: number,
        accountName: name,
        accountType,
        description: newAcct.description || '',
      });
      const body = created.data || created;
      const newId = body.id;
      const entry = {
        id: newId,
        number: body.accountNumber || number,
        name: body.accountName || name,
        type: body.accountType || accountType,
      };
      setPayload((prev) => {
        if (!prev) return prev;
        const list = [...(prev.accounts || prev.expenseAccounts || []), entry]
          .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
        return {
          ...prev,
          accounts: list,
          expenseAccounts: list.filter((a) => a.type === 'EXPENSE'),
        };
      });
      if (createForItem) {
        const r = await accountingAPI.setCategorizationCategory(entityId, createForItem.id, newId);
        applyCategoryToItem(createForItem.id, r.data || r);
        toast(`Created ${entry.number} · ${entry.name} and applied to this charge`);
      } else {
        toast(`Created ${entry.number} · ${entry.name}`);
      }
      setCreateForItem(null);
    } catch (e) {
      toast('Could not create account: ' + ((e.response && e.response.data && e.response.data.error) || e.message));
    } finally {
      setCreating(false);
    }
  };

  const postSelected = async () => {
    if (!selectedItems.length) { toast('Select at least one charge to approve'); return; }

    // Expand: same vendor pattern + same category as any selected charge.
    const expandIds = new Set(selectedItems.map((it) => it.id));
    for (const sel of selectedItems) {
      const pat = deriveVendorPatternClient(
        (sel.descLines && sel.descLines[0]) || sel.sourceDescription || ''
      );
      if (!pat || !sel.categoryAccountId) continue;
      for (const it of allReviewItems) {
        if (it.categoryAccountId !== sel.categoryAccountId) continue;
        const text = [(it.descLines && it.descLines[0]) || '', it.sourceDescription || ''].join(' ');
        if (vendorPatternMatchesClient(text, pat, 'contains')) expandIds.add(it.id);
      }
    }
    const toPost = allReviewItems.filter((it) => expandIds.has(it.id));
    const extra = toPost.length - selectedItems.length;
    const msg = extra > 0
      ? `Approve and post ${toPost.length} charges (${selectedItems.length} selected + ${extra} same vendor)?`
      : `Approve and post ${toPost.length} charge${toPost.length === 1 ? '' : 's'}?`;
    if (!window.confirm(msg)) return;

    setBusy(true);
    let ok = 0;
    const errs = [];
    for (const it of toPost) {
      try {
        await journalAPI.approve(entityId, it.id);
        await journalAPI.post(entityId, it.id);
        ok += 1;
      } catch (e) {
        errs.push((e.response && e.response.data && e.response.data.error) || e.message);
      }
    }
    setBusy(false);
    setSel(new Set());
    toast(errs.length ? `Posted ${ok}; ${errs.length} failed — ${errs[0]}` : `Posted ${ok} charge${ok === 1 ? '' : 's'}`);
    load();
  };

  const docSrc = docUrl
    ? `${docUrl}#toolbar=1&navpanes=0&${docZoom > 0 ? `zoom=${docZoom}` : 'view=FitH'}`
    : null;

  return (
    <div className="qbd-review-window" style={styles.wrap}>
      <div style={styles.head}>
        <h1 style={styles.title}>Review &amp; approve charges</h1>
        <span style={styles.sub}>
          Drag the blue bars to resize panes. Zoom the statement with − / + / Fit.
        </span>
        <span style={{ flex: 1 }} />
        {!showDoc && (
          <button type="button" style={styles.btn} onClick={() => setShowDoc(true)}>
            Show statement
          </button>
        )}
        <span style={styles.sub}>{payload ? `${payload.total} waiting` : ''}</span>
      </div>

      <div style={styles.body}>
        <aside style={{ ...styles.folders, width: folderW }}>
          {loading && <div style={styles.empty}>Loading…</div>}
          {!loading && !feeds.length && <div style={styles.empty}>Nothing waiting for approval.</div>}
          {feeds.map((feed) => {
            const open = openFeeds.has(feed.key);
            return (
              <div key={feed.key}>
                <button
                  type="button"
                  style={{
                    ...styles.feedBtn,
                    background: feedKey === feed.key ? '#e8eef5' : 'transparent',
                  }}
                  onClick={() => setOpenFeeds((s) => {
                    const n = new Set(s);
                    if (n.has(feed.key)) n.delete(feed.key); else n.add(feed.key);
                    return n;
                  })}
                >
                  {open ? '▾' : '▸'} {feed.label}
                  <span style={{ float: 'right', color: '#666', fontWeight: 500 }}>{feed.count}</span>
                </button>
                {open && (feed.months || []).map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    style={{
                      ...styles.monthBtn,
                      background: feedKey === feed.key && monthKey === m.key ? '#dce8f5' : 'transparent',
                      fontWeight: feedKey === feed.key && monthKey === m.key ? 650 : 400,
                    }}
                    onClick={() => selectMonth(feed.key, m.key)}
                  >
                    {m.label}
                    <span style={{ float: 'right', color: '#666' }}>{m.count}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </aside>

        <div
          className="qbd-review-gutter"
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={folderW}
          title="Drag to resize folders"
          onMouseDown={(e) => startFolderResize(e, folderW)}
        />

        <div style={styles.main} ref={mainSplitRef}>
          <section
            style={{
              ...styles.listPane,
              width: showDoc ? `calc(${listSplitPct}% - 4px)` : '100%',
            }}
          >
            <div style={styles.listHead}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!sortedItems.length} />
                Select all
              </label>
              <strong style={{ fontSize: 14 }}>
                {activeFeed ? activeFeed.label : ''}{activeMonth ? ` · ${activeMonth.label}` : ''}
              </strong>
              <span style={{ flex: 1 }} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#444' }}>
                Sort by
                <select
                  value={`${sortBy}:${sortDir}`}
                  onChange={(e) => {
                    const [by, dir] = String(e.target.value).split(':');
                    if (SORT_COLUMNS.some((c) => c.key === by)) setSortBy(by);
                    if (dir === 'asc' || dir === 'desc') setSortDir(dir);
                  }}
                  style={{ fontSize: 12, padding: '2px 6px', border: '1px solid #aaa', borderRadius: 2 }}
                  title="Sort charges in this folder"
                >
                  {SORT_COLUMNS.flatMap((c) => ([
                    <option key={`${c.key}:asc`} value={`${c.key}:asc`}>{c.label} ↑</option>,
                    <option key={`${c.key}:desc`} value={`${c.key}:desc`}>{c.label} ↓</option>,
                  ]))}
                </select>
              </label>
              <span style={{ fontSize: 12, color: '#666' }}>{sortedItems.length} charges</span>
            </div>
            <div style={styles.list}>
              {loading ? (
                <div style={styles.empty}>Loading charges…</div>
              ) : !sortedItems.length ? (
                <div style={styles.empty}>No charges in this folder.</div>
              ) : (
                <>
                  <div style={styles.colHead}>
                    <span />
                    {SORT_COLUMNS.map((col) => {
                      const active = sortBy === col.key;
                      const arrow = active ? (sortDir === 'asc' ? '▲' : '▼') : '';
                      return (
                        <button
                          key={col.key}
                          type="button"
                          style={{
                            ...styles.sortBtn,
                            justifyContent: col.key === 'amount' ? 'flex-end' : 'flex-start',
                            width: '100%',
                            color: active ? '#0d3d6e' : '#35557a',
                          }}
                          onClick={() => toggleSort(col.key)}
                          title={`Sort by ${col.label}`}
                        >
                          {col.label}{arrow ? ` ${arrow}` : ''}
                        </button>
                      );
                    })}
                  </div>
                  {sortedItems.map((it) => (
                <div key={it.id} style={styles.row}>
                  <input
                    type="checkbox"
                    checked={sel.has(it.id)}
                    onChange={() => toggle(it.id)}
                    style={{ marginTop: 3 }}
                  />
                  <div style={styles.date}>{fmtStmtDate(it.postingDate)}</div>
                  <div style={styles.desc}>
                    {(it.descLines || []).map((line, i) => (
                      <div
                        key={i}
                        style={{
                          ...styles.descLine,
                          fontWeight: i === 0 ? 600 : 400,
                          color: i === 0 ? '#111' : '#444',
                          fontSize: i === 0 ? 12 : 11,
                          marginTop: i ? 2 : 0,
                        }}
                      >
                        {line}
                      </div>
                    ))}
                  </div>
                  <div style={styles.amount}>{fmtMoney(it.amount)}</div>
                  <div style={styles.catSelect}>
                    <AccountCombobox
                      accounts={accounts}
                      value={it.categoryAccountId || ''}
                      onChange={(accountId) => changeCategory(it, accountId)}
                      allowCreate
                      onCreateRequest={() => changeCategory(it, CREATE_NEW_VALUE)}
                      title="Type to search the chart of accounts — change teaches the app for next time"
                    />
                    <label style={styles.alwaysLabel}>
                      <input
                        type="checkbox"
                        checked={false}
                        disabled={!it.categoryAccountId}
                        onChange={(e) => {
                          if (e.target.checked) openAlwaysRule(it);
                        }}
                      />
                      <span>Always for this vendor</span>
                    </label>
                  </div>
                </div>
                  ))}
                </>
              )}
            </div>
          </section>

          {showDoc && (
            <>
              <div
                className="qbd-review-gutter"
                role="separator"
                aria-orientation="vertical"
                aria-valuenow={Math.round(listSplitPct)}
                title="Drag to resize charges vs statement"
                onMouseDown={startListResize}
              />
              <section
                style={{
                  ...styles.docPane,
                  width: `calc(${100 - listSplitPct}% - 4px)`,
                }}
              >
                <div style={styles.docBar}>
                  <span style={{ fontWeight: 650 }}>Source document</span>
                  <span style={{ opacity: 0.85 }}>{docBusy ? 'Loading…' : docLabel}</span>
                  <span style={{ flex: 1 }} />
                  <button type="button" style={styles.zoomBtn} title="Zoom out" onClick={zoomOut}>−</button>
                  <span style={{ minWidth: 36, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                    {docZoom > 0 ? `${docZoom}%` : 'Fit'}
                  </span>
                  <button type="button" style={styles.zoomBtn} title="Zoom in" onClick={zoomIn}>+</button>
                  <button type="button" style={styles.zoomBtn} title="Fit width" onClick={zoomFit}>⤢</button>
                  <button type="button" style={styles.zoomBtn} title="Hide statement" onClick={() => setShowDoc(false)}>✕</button>
                </div>
                {docSrc ? (
                  <iframe
                    key={docZoom}
                    title="Source document"
                    src={docSrc}
                    style={styles.iframe}
                  />
                ) : (
                  <div style={{ ...styles.empty, color: '#ddd', textAlign: 'center', marginTop: 48 }}>
                    {docBusy
                      ? 'Loading statement…'
                      : 'Open a month on the left. When a statement PDF is on file, it appears here next to the charges.'}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      <div style={styles.bot}>
        <span style={{ fontSize: 13, color: '#555' }}>
          {selectedItems.length ? `${selectedItems.length} selected` : 'Select charges to approve'}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" style={styles.btn} onClick={() => navigate('/')} disabled={busy}>Close</button>
        <button type="button" style={styles.btn} onClick={load} disabled={busy || loading}>Refresh</button>
        <button
          type="button"
          style={styles.btnPrimary}
          disabled={busy || !selectedItems.length}
          onClick={postSelected}
        >
          {busy ? 'Posting…' : `Approve & Post${selectedItems.length ? ` (${selectedItems.length})` : ''}`}
        </button>
      </div>

      {ruleForItem && (
        <div style={styles.modalBackdrop} onClick={() => !savingRule && setRuleForItem(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 style={styles.modalTitle}>Always use this category for this vendor</h2>
            <p style={{ margin: '0 0 12px', fontSize: 13, color: '#444', lineHeight: 1.4 }}>
              {(() => {
                const a = accounts.find((x) => x.id === ruleForItem.categoryAccountId);
                const cat = a ? `${a.number} · ${leafLabel(a.name)}` : 'selected category';
                const how = ruleMatchType === 'exact'
                  ? 'exactly matching'
                  : ruleMatchType === 'starts_with'
                    ? 'starting with'
                    : 'containing';
                return (
                  <>
                    Charges {how} <strong>[{rulePattern || '…'}]</strong> → {cat}.
                    {' '}Saves the rule, posts every matching charge now, and removes them from this list.
                  </>
                );
              })()}
            </p>
            <div style={styles.field}>
              <label style={styles.label}>Match text (editable — keep it short, e.g. BLUEHOST.COM)</label>
              <input
                style={styles.input}
                value={rulePattern}
                onChange={(e) => setRulePattern(e.target.value.toUpperCase())}
                autoFocus
              />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Match type</label>
              <select
                style={styles.input}
                value={ruleMatchType}
                onChange={(e) => setRuleMatchType(e.target.value)}
              >
                <option value="contains">Contains (recommended) — matches any charge with this text</option>
                <option value="starts_with">Starts with — description begins with this text</option>
                <option value="exact">Exact — whole description must match</option>
              </select>
            </div>
            <p style={{ margin: '0 0 8px', fontSize: 12, color: ruleMatchPreviewCount ? '#1a5f3a' : '#666' }}>
              {rulePattern.trim().length < 3
                ? 'Enter at least 3 characters to preview matches.'
                : `${ruleMatchPreviewCount} charge${ruleMatchPreviewCount === 1 ? '' : 's'} in Review & Approve match this rule.`}
            </p>
            <div style={styles.modalActions}>
              <button type="button" style={styles.btn} disabled={savingRule} onClick={() => setRuleForItem(null)}>
                Cancel
              </button>
              <button type="button" style={styles.btnPrimary} disabled={savingRule} onClick={saveVendorRule}>
                {savingRule
                  ? 'Posting…'
                  : `Save, post all${ruleMatchPreviewCount ? ` (${ruleMatchPreviewCount})` : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {createForItem && (
        <div style={styles.modalBackdrop} onClick={() => !creating && setCreateForItem(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 style={styles.modalTitle}>Create new account</h2>
            <div style={styles.field}>
              <label style={styles.label}>Type</label>
              <select
                style={styles.input}
                value={newAcct.accountType}
                onChange={(e) => {
                  const accountType = e.target.value;
                  setNewAcct((f) => ({
                    ...f,
                    accountType,
                    accountNumber: suggestAccountNumber(accounts, accountType),
                  }));
                }}
              >
                <option value="EXPENSE">Expense</option>
                <option value="REVENUE">Income</option>
                <option value="ASSET">Asset</option>
                <option value="LIABILITY">Liability</option>
                <option value="EQUITY">Equity</option>
              </select>
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Account number</label>
              <input
                style={styles.input}
                value={newAcct.accountNumber}
                onChange={(e) => setNewAcct((f) => ({ ...f, accountNumber: e.target.value }))}
              />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Account name</label>
              <input
                style={styles.input}
                value={newAcct.accountName}
                onChange={(e) => setNewAcct((f) => ({ ...f, accountName: e.target.value }))}
                placeholder="e.g. Meals & Entertainment"
                autoFocus
              />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Description (optional)</label>
              <input
                style={styles.input}
                value={newAcct.description}
                onChange={(e) => setNewAcct((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div style={styles.modalActions}>
              <button type="button" style={styles.btn} disabled={creating} onClick={() => setCreateForItem(null)}>
                Cancel
              </button>
              <button type="button" style={styles.btnPrimary} disabled={creating} onClick={saveNewAccount}>
                {creating ? 'Creating…' : 'Create & apply'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
