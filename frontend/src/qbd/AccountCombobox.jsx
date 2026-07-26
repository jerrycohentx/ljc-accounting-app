import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { leafLabel } from './helpers';

export const CREATE_NEW_VALUE = '__create_new__';

const TYPE_ORDER = ['EXPENSE', 'REVENUE', 'ASSET', 'LIABILITY', 'EQUITY', 'CONTRA'];
const TYPE_LABELS = {
  EXPENSE: 'Expenses',
  REVENUE: 'Income',
  ASSET: 'Assets',
  LIABILITY: 'Liabilities',
  EQUITY: 'Equity',
  CONTRA: 'Contra',
};

/** Normalize COA rows that use number/name/type or account_number/account_name/account_type. */
export function normalizeAccount(a) {
  if (!a) return null;
  const number = a.number ?? a.account_number ?? a.accountNumber ?? '';
  const name = a.name ?? a.account_name ?? a.accountName ?? '';
  const type = a.type ?? a.account_type ?? a.accountType ?? '';
  const parentAccountId = a.parentAccountId ?? a.parent_account_id ?? null;
  return {
    id: a.id,
    number: String(number || ''),
    name: String(name || ''),
    type: String(type || ''),
    parentAccountId: parentAccountId || null,
  };
}

/** Flatten nested account trees (children arrays) into normalized rows. */
export function flattenAccounts(nodes, { activeOnly = true } = {}) {
  const out = [];
  const walk = (list) => {
    (list || []).forEach((n) => {
      // Match prior helpers: when activeOnly, require truthy is_active (or missing field → include).
      const include = !activeOnly || n.is_active || n.is_active === undefined;
      if (include) out.push(normalizeAccount(n));
      if (n.children) walk(n.children);
    });
  };
  walk(nodes);
  return out.filter(Boolean);
}

function accountLabel(a, { indent = false } = {}) {
  if (!a) return '';
  const num = a.number || '';
  const name = leafLabel(a.name);
  const core = num && name ? `${num} · ${name}` : (num || name || '');
  if (indent && a.parentAccountId) return ` ${core}`;
  return core;
}

function matchesQuery(account, q) {
  if (!q) return true;
  const hay = `${account.number || ''} ${account.name || ''} ${leafLabel(account.name)}`.toLowerCase();
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => hay.includes(w));
}

/**
 * Reusable type-ahead account / category picker.
 *
 * Props:
 * - accounts: array of {id, number|account_number, name|account_name, type|account_type}
 * - value: selected account id
 * - onChange(accountId)
 * - disabled, placeholder
 * - allowCreate: show "＋ Create new account…"
 * - onCreateRequest: optional callback when create is chosen (else onChange(CREATE_NEW_VALUE))
 */
export default function AccountCombobox({
  accounts = [],
  value = '',
  onChange,
  disabled = false,
  placeholder = '— pick account —',
  allowCreate = false,
  onCreateRequest,
  createNewValue = CREATE_NEW_VALUE,
  title,
  style,
  inputStyle,
}) {
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [menuStyle, setMenuStyle] = useState(null);

  const updateMenuPos = useCallback(() => {
    if (!rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    setMenuStyle({
      position: 'fixed',
      left: rect.left,
      top: rect.bottom + 2,
      width: rect.width,
      zIndex: 500,
    });
  }, []);

  const normalized = useMemo(
    () => (accounts || []).map(normalizeAccount).filter((a) => a && a.id != null),
    [accounts]
  );

  const selected = useMemo(
    () => normalized.find((a) => String(a.id) === String(value)) || null,
    [normalized, value]
  );

  const filtered = useMemo(() => {
    const q = query.trim();
    const list = normalized.filter((a) => matchesQuery(a, q));
    list.sort((a, b) => {
      const ta = TYPE_ORDER.indexOf(a.type);
      const tb = TYPE_ORDER.indexOf(b.type);
      const oa = ta === -1 ? 99 : ta;
      const ob = tb === -1 ? 99 : tb;
      if (oa !== ob) return oa - ob;
      return String(a.number).localeCompare(String(b.number), undefined, { numeric: true });
    });
    return list;
  }, [normalized, query]);

  const options = useMemo(() => {
    const rows = [];
    if (allowCreate) {
      rows.push({ kind: 'action', id: createNewValue, label: '＋ Create new account…' });
    }
    let lastType = null;
    for (const a of filtered) {
      const t = a.type || '';
      if (t && t !== lastType) {
        rows.push({ kind: 'header', id: `hdr-${t}`, label: TYPE_LABELS[t] || t });
        lastType = t;
      }
      rows.push({
        kind: 'account',
        id: a.id,
        label: accountLabel(a, { indent: true }),
        typeLabel: TYPE_LABELS[a.type] || a.type || '',
        account: a,
      });
    }
    return rows;
  }, [filtered, allowCreate, createNewValue]);

  const selectable = useMemo(
    () => options.filter((o) => o.kind === 'account' || o.kind === 'action'),
    [options]
  );

  useEffect(() => {
    if (!open) {
      setMenuStyle(null);
      return undefined;
    }
    updateMenuPos();
    const onReposition = () => updateMenuPos();
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    const onDoc = (e) => {
      const target = e.target;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
      setQuery('');
    };
    document.addEventListener('mousedown', onDoc);
    return () => {
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [open, updateMenuPos]);

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
    if (allowCreate && id === createNewValue) {
      if (typeof onCreateRequest === 'function') {
        onCreateRequest();
        return;
      }
    }
    if (onChange) onChange(id);
  };

  const onKeyDown = (e) => {
    if (disabled) return;
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

  const menu = open && !disabled && menuStyle ? (() => {
    selIdx = -1;
    return (
      <div
        ref={(node) => {
          listRef.current = node;
          menuRef.current = node;
        }}
        style={{ ...styles.menu, ...menuStyle }}
        role="listbox"
      >
        {!filtered.length && (
          <div style={styles.empty}>
            {query.trim() ? `No accounts match “${query.trim()}”` : 'No accounts'}
          </div>
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
              key={String(opt.id)}
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
              <span style={styles.optionLabel}>{opt.label}</span>
              {opt.kind === 'account' && opt.typeLabel ? (
                <span style={styles.typeTag}>{opt.typeLabel}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  })() : null;

  return (
    <div ref={rootRef} style={{ ...styles.wrap, ...style }} title={title}>
      <input
        type="text"
        style={{ ...styles.input, ...inputStyle, ...(disabled ? styles.inputDisabled : null) }}
        value={displayValue}
        placeholder={selected ? accountLabel(selected) : placeholder}
        disabled={disabled}
        onFocus={() => {
          if (disabled) return;
          setOpen(true);
          setQuery('');
          updateMenuPos();
        }}
        onChange={(e) => {
          if (disabled) return;
          setOpen(true);
          setQuery(e.target.value);
          updateMenuPos();
        }}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
        aria-autocomplete="list"
        aria-expanded={open}
      />
      {menu && typeof document !== 'undefined' ? createPortal(menu, document.body) : null}
    </div>
  );
}

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
  inputDisabled: {
    background: '#f3f3f3',
    color: '#777',
    cursor: 'not-allowed',
  },
  menu: {
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
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    width: '100%',
    textAlign: 'left',
    border: 'none',
    background: 'transparent',
    padding: '5px 8px',
    fontSize: 12,
    cursor: 'pointer',
    color: '#111',
  },
  optionLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  typeTag: {
    flexShrink: 0,
    fontSize: 10,
    color: '#888',
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
