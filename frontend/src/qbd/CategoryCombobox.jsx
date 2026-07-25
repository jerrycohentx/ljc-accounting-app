import React, { useEffect, useMemo, useRef, useState } from 'react';
import { leafLabel } from './helpers';

const CREATE_NEW_VALUE = '__create_new__';

const TYPE_ORDER = ['EXPENSE', 'REVENUE', 'ASSET', 'LIABILITY', 'EQUITY', 'CONTRA'];
const TYPE_LABELS = {
  EXPENSE: 'Expenses',
  REVENUE: 'Income',
  ASSET: 'Assets',
  LIABILITY: 'Liabilities',
  EQUITY: 'Equity',
  CONTRA: 'Contra',
};

function accountLabel(a) {
  if (!a) return '';
  return `${a.number} · ${leafLabel(a.name)}`;
}

function matchesQuery(account, q) {
  if (!q) return true;
  const hay = `${account.number || ''} ${account.name || ''} ${leafLabel(account.name)}`.toLowerCase();
  return hay.includes(q);
}

/**
 * Type-ahead category picker for charge review.
 * value: selected account id (string) or ''
 * onChange(accountId): called with account id or CREATE_NEW_VALUE
 */
export default function CategoryCombobox({
  accounts = [],
  value = '',
  onChange,
  createNewValue = CREATE_NEW_VALUE,
  placeholder = '— pick account —',
  title,
}) {
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);

  const selected = useMemo(
    () => (accounts || []).find((a) => String(a.id) === String(value)) || null,
    [accounts, value]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (accounts || []).filter((a) => matchesQuery(a, q));
    list.sort((a, b) => {
      const ta = TYPE_ORDER.indexOf(a.type);
      const tb = TYPE_ORDER.indexOf(b.type);
      const oa = ta === -1 ? 99 : ta;
      const ob = tb === -1 ? 99 : tb;
      if (oa !== ob) return oa - ob;
      return String(a.number).localeCompare(String(b.number), undefined, { numeric: true });
    });
    return list;
  }, [accounts, query]);

  const options = useMemo(() => {
    const rows = [];
    rows.push({ kind: 'action', id: createNewValue, label: '＋ Create new account…' });
    let lastType = null;
    for (const a of filtered) {
      const t = a.type || 'EXPENSE';
      if (t !== lastType) {
        rows.push({ kind: 'header', id: `hdr-${t}`, label: TYPE_LABELS[t] || t });
        lastType = t;
      }
      rows.push({ kind: 'account', id: a.id, label: accountLabel(a), account: a });
    }
    return rows;
  }, [filtered, createNewValue]);

  const selectable = useMemo(
    () => options.filter((o) => o.kind === 'account' || o.kind === 'action'),
    [options]
  );

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setHighlight(0);
  }, [open, query]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-opt-idx="${highlight}"]`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [highlight, open]);

  const displayValue = open ? query : (selected ? accountLabel(selected) : '');

  const pick = (id) => {
    setOpen(false);
    setQuery('');
    if (onChange) onChange(id);
  };

  const onKeyDown = (e) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      setQuery('');
      e.preventDefault();
      return;
    }
    if (!open) return;
    if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      setHighlight((h) => Math.min(h + 1, Math.max(0, selectable.length - 1)));
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp') {
      setHighlight((h) => Math.max(h - 1, 0));
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      const opt = selectable[highlight];
      if (opt) pick(opt.id);
      e.preventDefault();
    }
  };

  let selIdx = -1;

  return (
    <div ref={rootRef} style={styles.wrap} title={title}>
      <input
        ref={inputRef}
        type="text"
        style={styles.input}
        value={displayValue}
        placeholder={selected ? accountLabel(selected) : placeholder}
        onFocus={() => {
          setOpen(true);
          setQuery('');
        }}
        onChange={(e) => {
          setOpen(true);
          setQuery(e.target.value);
        }}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
        aria-autocomplete="list"
        aria-expanded={open}
      />
      {open && (
        <div ref={listRef} style={styles.menu} role="listbox">
          {!filtered.length && (
            <div style={styles.empty}>No accounts match “{query.trim()}”</div>
          )}
          {options.map((opt) => {
            if (opt.kind === 'header') {
              return (
                <div key={opt.id} style={styles.header}>
                  {opt.label}
                </div>
              );
            }
            selIdx += 1;
            const idx = selIdx;
            const active = idx === highlight;
            return (
              <button
                key={opt.id}
                type="button"
                role="option"
                data-opt-idx={idx}
                aria-selected={active}
                style={{
                  ...styles.option,
                  ...(opt.kind === 'action' ? styles.action : null),
                  ...(active ? styles.optionActive : null),
                }}
                onMouseEnter={() => setHighlight(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(opt.id);
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export { CREATE_NEW_VALUE };

const styles = {
  wrap: {
    position: 'relative',
    width: '100%',
    minWidth: 0,
  },
  input: {
    width: '100%',
    fontSize: 12,
    padding: '4px 6px',
    border: '1px solid #aaa',
    borderRadius: 2,
    boxSizing: 'border-box',
    background: '#fff',
  },
  menu: {
    position: 'absolute',
    zIndex: 40,
    left: 0,
    right: 0,
    top: '100%',
    marginTop: 2,
    maxHeight: 260,
    overflowY: 'auto',
    background: '#fff',
    border: '1px solid #999',
    borderRadius: 2,
    boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
  },
  header: {
    padding: '5px 8px 3px',
    fontSize: 11,
    fontWeight: 700,
    color: '#555',
    background: '#f3f3f1',
    borderBottom: '1px solid #e5e5e5',
    position: 'sticky',
    top: 0,
  },
  option: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    border: 'none',
    background: 'transparent',
    padding: '5px 8px',
    fontSize: 12,
    cursor: 'pointer',
    color: '#111',
  },
  optionActive: {
    background: '#e8f1fa',
  },
  action: {
    fontWeight: 650,
    color: '#1a6fb5',
    borderBottom: '1px solid #e5e5e5',
  },
  empty: {
    padding: '10px 8px',
    fontSize: 12,
    color: '#666',
  },
};
