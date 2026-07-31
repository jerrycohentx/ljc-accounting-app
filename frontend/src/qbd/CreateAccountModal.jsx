import React, { useEffect, useMemo, useState } from 'react';
import { accountAPI } from '../services/api';
import { leafLabel } from './helpers';
import { normalizeAccount } from './AccountCombobox';

export function suggestAccountNumber(accounts, type) {
  const ranges = {
    ASSET: [1000, 1999],
    LIABILITY: [2000, 2999],
    EQUITY: [3000, 3999],
    REVENUE: [4000, 4999],
    EXPENSE: [5000, 5999],
    CONTRA: [7000, 7999],
  };
  const [lo, hi] = ranges[type] || [9000, 9999];
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

/** Next free number near a parent (5410 → 5411, 5412, …). */
export function suggestSubAccountNumber(accounts, parentNumber) {
  const parent = parseInt(parentNumber, 10);
  if (!Number.isFinite(parent)) return '';
  const used = new Set(
    (accounts || [])
      .map((a) => parseInt(a.number, 10))
      .filter((n) => Number.isFinite(n))
  );
  let next = parent + 1;
  const hi = parent + 99;
  while (next <= hi && used.has(next)) next += 1;
  return next <= hi ? String(next) : '';
}

function accountUsingNumber(accounts, number) {
  const n = String(number || '').trim();
  return (accounts || []).find((a) => String(a.number) === n) || null;
}

/**
 * Modal to create any GL account type and return the new account to the caller.
 *
 * Props:
 * - open, onClose
 * - entityId
 * - accounts: COA rows (any shape normalizeAccount accepts)
 * - defaultType: EXPENSE | REVENUE | ASSET | LIABILITY | EQUITY
 * - applyLabel: primary button text (default "Create & apply")
 * - onCreated(accountEntry): called with { id, number, name, type, account_number, account_name, account_type, parentAccountId }
 */
export default function CreateAccountModal({
  open,
  onClose,
  entityId,
  accounts = [],
  defaultType = 'EXPENSE',
  applyLabel = 'Create & apply',
  onCreated,
}) {
  const normalized = useMemo(
    () => (accounts || []).map(normalizeAccount).filter((a) => a && a.id != null),
    [accounts]
  );

  const [form, setForm] = useState(() => ({
    accountType: defaultType,
    isSubAccount: false,
    parentAccountId: '',
    accountNumber: suggestAccountNumber(normalized, defaultType),
    accountName: '',
    description: '',
  }));
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({
      accountType: defaultType,
      isSubAccount: false,
      parentAccountId: '',
      accountNumber: suggestAccountNumber(normalized, defaultType),
      accountName: '',
      description: '',
    });
  }, [open, defaultType, normalized]);

  if (!open) return null;

  const save = async () => {
    const number = String(form.accountNumber || '').trim();
    const name = String(form.accountName || '').trim();
    const accountType = form.accountType || 'EXPENSE';
    const parentAccountId = form.isSubAccount ? (form.parentAccountId || null) : null;
    if (!number || !name) {
      window.alert('Enter an account number and name');
      return;
    }
    const clash = accountUsingNumber(normalized, number);
    if (clash) {
      window.alert(`Account number ${number} is already used by ${clash.number} · ${leafLabel(clash.name)}`);
      return;
    }
    if (form.isSubAccount && !parentAccountId) {
      window.alert('Pick the parent account for this sub-account');
      return;
    }
    setCreating(true);
    try {
      const created = await accountAPI.create(entityId, {
        accountNumber: number,
        accountName: name,
        accountType,
        description: form.description || '',
        parentAccountId: parentAccountId || null,
      });
      const body = created.data || created;
      const entry = {
        id: body.id,
        number: body.accountNumber || number,
        name: body.accountName || name,
        type: body.accountType || accountType,
        account_number: body.accountNumber || number,
        account_name: body.accountName || name,
        account_type: body.accountType || accountType,
        parentAccountId: body.parentAccountId || parentAccountId || null,
        parent_account_id: body.parentAccountId || parentAccountId || null,
        is_active: true,
      };
      if (typeof onCreated === 'function') await onCreated(entry);
      if (typeof onClose === 'function') onClose();
    } catch (e) {
      window.alert('Could not create account: ' + ((e.response && e.response.data && e.response.data.error) || e.message));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="qbd-modal-backdrop"
      style={{ zIndex: 11000 }}
      onClick={(e) => {
        e.stopPropagation();
        if (!creating && onClose) onClose();
      }}
    >
      <div
        className="qbd-window"
        style={{ width: 440, maxHeight: '90vh', margin: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="qbd-wtitle">
          Create new account
          <span className="x" onClick={() => !creating && onClose && onClose()}>✕</span>
        </div>
        <div className="qbd-wbody" style={{ padding: 12 }}>
          <div className="frow" style={{ marginBottom: 10 }}>
            <label style={{ width: 120 }}>Type</label>
            <select
              value={form.accountType}
              onChange={(e) => {
                const accountType = e.target.value;
                setForm((f) => {
                  const parent = normalized.find((a) => a.id === f.parentAccountId && a.type === accountType);
                  return {
                    ...f,
                    accountType,
                    parentAccountId: parent ? parent.id : '',
                    isSubAccount: parent ? f.isSubAccount : false,
                    accountNumber: parent
                      ? (suggestSubAccountNumber(normalized, parent.number) || suggestAccountNumber(normalized, accountType))
                      : suggestAccountNumber(normalized, accountType),
                  };
                });
              }}
              style={{ flex: 1 }}
            >
              <option value="EXPENSE">Expense</option>
              <option value="REVENUE">Income</option>
              <option value="ASSET">Asset</option>
              <option value="LIABILITY">Liability</option>
              <option value="EQUITY">Equity</option>
            </select>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={!!form.isSubAccount}
              onChange={(e) => {
                const on = e.target.checked;
                setForm((f) => {
                  if (!on) {
                    return {
                      ...f,
                      isSubAccount: false,
                      parentAccountId: '',
                      accountNumber: suggestAccountNumber(normalized, f.accountType || 'EXPENSE'),
                    };
                  }
                  const parent = normalized.find((a) => a.id === f.parentAccountId && a.type === f.accountType)
                    || normalized.find((a) => a.type === f.accountType);
                  return {
                    ...f,
                    isSubAccount: true,
                    parentAccountId: parent?.id || '',
                    accountNumber: parent
                      ? (suggestSubAccountNumber(normalized, parent.number) || suggestAccountNumber(normalized, f.accountType))
                      : f.accountNumber,
                  };
                });
              }}
            />
            <span>This is a sub-account</span>
          </label>
          {form.isSubAccount && (
            <div className="frow" style={{ marginBottom: 10 }}>
              <label style={{ width: 120 }}>Sub-account of</label>
              <select
                value={form.parentAccountId || ''}
                onChange={(e) => {
                  const parentId = e.target.value;
                  const parent = normalized.find((a) => a.id === parentId);
                  setForm((f) => ({
                    ...f,
                    parentAccountId: parentId,
                    accountNumber: parent
                      ? (suggestSubAccountNumber(normalized, parent.number) || f.accountNumber)
                      : f.accountNumber,
                  }));
                }}
                style={{ flex: 1 }}
              >
                <option value="">— pick parent account —</option>
                {normalized
                  .filter((a) => a.type === (form.accountType || 'EXPENSE'))
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.number} · {leafLabel(a.name)}
                    </option>
                  ))}
              </select>
            </div>
          )}
          <div className="frow" style={{ marginBottom: 10 }}>
            <label style={{ width: 120 }}>Account number</label>
            <input
              value={form.accountNumber}
              onChange={(e) => setForm((f) => ({ ...f, accountNumber: e.target.value }))}
              style={{ flex: 1 }}
            />
          </div>
          <div className="frow" style={{ marginBottom: 10 }}>
            <label style={{ width: 120 }}>
              {form.isSubAccount ? 'Sub-account name' : 'Account name'}
            </label>
            <input
              value={form.accountName}
              onChange={(e) => setForm((f) => ({ ...f, accountName: e.target.value }))}
              placeholder={form.isSubAccount ? 'e.g. Doctor Charges' : 'e.g. Meals & Entertainment'}
              style={{ flex: 1 }}
              autoFocus
            />
          </div>
          {form.isSubAccount && form.parentAccountId ? (
            <p className="qbd-muted" style={{ margin: '0 0 10px 120px', fontSize: 11 }}>
              Will show as{' '}
              {leafLabel(normalized.find((a) => a.id === form.parentAccountId)?.name || 'Parent')}
              :{form.accountName || '…'}
            </p>
          ) : null}
          <div className="frow" style={{ marginBottom: 10 }}>
            <label style={{ width: 120 }}>Description</label>
            <input
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Optional"
              style={{ flex: 1 }}
            />
          </div>
        </div>
        <div className="qbd-foot">
          <button type="button" className="qbd-btn" disabled={creating} onClick={() => onClose && onClose()}>
            Cancel
          </button>
          <span className="sp" />
          <button type="button" className="qbd-btn qbd-primary" disabled={creating} onClick={save} style={{ fontWeight: 'bold' }}>
            {creating ? 'Creating…' : applyLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
