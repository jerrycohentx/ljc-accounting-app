import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, accountingAPI } from '../services/api';
import AccountCombobox, { flattenAccounts } from './AccountCombobox';
import { leafLabel } from './helpers';

const MONTHS = [
  { value: '2026-01', label: 'January 2026' },
  { value: '2026-02', label: 'February 2026' },
  { value: '2026-03', label: 'March 2026' },
  { value: '2026-04', label: 'April 2026' },
  { value: '2026-05', label: 'May 2026' },
  { value: '2026-06', label: 'June 2026' },
];

function money(n) {
  return (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function QBDVendorDefaults() {
  const { entityId, current } = useEntity();
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const month = searchParams.get('month') || '2026-01';

  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [meta, setMeta] = useState(null);
  const [rows, setRows] = useState([]);
  const [dirty, setDirty] = useState({});

  const expenseAccounts = useMemo(
    () =>
      flattenAccounts(accounts).filter((a) =>
        /EXPENSE|REVENUE|COST OF GOODS/i.test(String(a.type || ''))
      ),
    [accounts]
  );

  const load = useCallback(async () => {
    if (!entityId) return;
    setLoading(true);
    setError('');
    try {
      const [coa, vd] = await Promise.all([
        accountAPI.list(entityId),
        accountingAPI.vendorDefaults(entityId, { month }),
      ]);
      setAccounts(Array.isArray(coa.data) ? coa.data : (coa.data?.data || coa.data?.accounts || []));
      setMeta(vd.data);
      const initial = (vd.data?.vendors || []).map((v) => ({
        ...v,
        selectedAccountId: v.defaultAccountId || '',
      }));
      setRows(initial);
      setDirty({});
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Could not load vendor list');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [entityId, month]);

  useEffect(() => {
    load();
  }, [load]);

  const onMonthChange = (e) => {
    const v = e.target.value;
    setSearchParams(v === '2026-01' ? {} : { month: v });
  };

  const setRowAccount = (pattern, accountId) => {
    setRows((prev) =>
      prev.map((r) =>
        r.pattern === pattern ? { ...r, selectedAccountId: accountId } : r
      )
    );
    setDirty((d) => ({ ...d, [pattern]: true }));
  };

  const saveAll = async () => {
    const toSave = rows.filter((r) => r.selectedAccountId && dirty[r.pattern]);
    if (!toSave.length) {
      setToast('No category changes to save.');
      return;
    }
    setSaving(true);
    setToast('');
    try {
      const payload = {
        vendors: toSave.map((r) => ({
          pattern: r.pattern,
          accountId: r.selectedAccountId,
          label: `Vendor: ${r.pattern.slice(0, 28)}`,
          sampleDescription: r.sampleDescription || r.displayName || r.pattern,
        })),
      };
      const r = await accountingAPI.saveVendorDefaults(entityId, payload);
      setToast(`Saved ${r.data?.savedCount ?? toSave.length} vendor default${toSave.length === 1 ? '' : 's'}. Future imports will use these.`);
      setDirty({});
      await load();
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const saveRow = async (row) => {
    if (!row.selectedAccountId) return;
    setSaving(true);
    try {
      await accountingAPI.saveVendorDefaults(entityId, {
        vendors: [{
          pattern: row.pattern,
          accountId: row.selectedAccountId,
          label: `Vendor: ${row.pattern.slice(0, 28)}`,
          sampleDescription: row.sampleDescription || row.displayName || row.pattern,
        }],
      });
      setDirty((d) => {
        const next = { ...d };
        delete next[row.pattern];
        return next;
      });
      setToast(`Saved default for ${row.pattern}`);
      await load();
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const changedCount = Object.keys(dirty).length;

  return (
    <div className="qbd-page" style={{ padding: '12px 16px 24px', maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Vendor default categories</h2>
        <span style={{ color: '#546e7a', fontSize: 13 }}>{current?.name}</span>
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: 13 }}>
          Month{' '}
          <select value={month} onChange={onMonthChange} className="qbd-select">
            {MONTHS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </label>
        <button type="button" className="qbd-btn" onClick={load} disabled={loading}>
          Refresh
        </button>
        <button
          type="button"
          className="qbd-btn qbd-btn-primary"
          onClick={saveAll}
          disabled={saving || changedCount === 0}
        >
          {saving ? 'Saving…' : `Save ${changedCount || ''} change${changedCount === 1 ? '' : 's'}`}
        </button>
        <button type="button" className="qbd-btn" onClick={() => nav('/reconcile')}>
          Back to Reconcile
        </button>
      </div>

      <div
        style={{
          background: '#e8f4ea',
          border: '1px solid #a5d6a7',
          borderRadius: 6,
          padding: '10px 14px',
          fontSize: 13,
          marginBottom: 14,
          lineHeight: 1.45,
        }}
      >
        <strong>How this works:</strong> Pick a default expense account for each vendor (from Chase / bank activity).
        Saving creates a durable rule — future imports auto-suggest that category.
        For a one-off charge, use <strong>Fix category</strong> in Reconcile instead; that still teaches the app when you choose <strong>Create rule</strong>.
      </div>

      {error && (
        <div style={{ color: '#b00020', marginBottom: 10, fontSize: 13 }}>{error}</div>
      )}
      {toast && (
        <div style={{ color: '#1b5e20', marginBottom: 10, fontSize: 13 }}>{toast}</div>
      )}

      {meta?.statementPaths?.length > 0 && (
        <div style={{ fontSize: 12, color: '#546e7a', marginBottom: 8 }}>
          Statement sources:{' '}
          {meta.statementPaths.map((s, i) => (
            <span key={i}>
              {i > 0 ? ' · ' : ''}
              {s.path?.includes('!') ? s.path.split('!').pop() : s.path}
              {s.parseNote ? ` (${s.parseNote})` : s.vendorCount ? ` — ${s.vendorCount} lines` : ''}
            </span>
          ))}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 24, opacity: 0.7 }}>Loading vendors…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 24, opacity: 0.7 }}>
          No vendors found for {month}. Post bank/CC activity first, or check that Chase statements are in Downloads.
        </div>
      ) : (
        <table className="qbd-grid" style={{ width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', width: '22%' }}>Vendor</th>
              <th style={{ textAlign: 'left', width: '28%' }}>Sample description</th>
              <th style={{ textAlign: 'right', width: '8%' }}># Tx</th>
              <th style={{ textAlign: 'right', width: '10%' }}>Amount</th>
              <th style={{ textAlign: 'left', width: '28%' }}>Default category</th>
              <th style={{ width: '4%' }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.pattern} style={dirty[row.pattern] ? { background: '#fffde7' } : undefined}>
                <td style={{ verticalAlign: 'middle' }}>
                  <div style={{ fontWeight: 600 }}>{row.pattern}</div>
                  <div style={{ fontSize: 11, color: '#78909c' }}>
                    {(row.sources || []).join(', ')}
                    {row.hasRule ? ' · saved rule' : ''}
                  </div>
                </td>
                <td style={{ verticalAlign: 'middle', fontSize: 12 }}>
                  {leafLabel(row.sampleDescription || row.displayName || '—')}
                </td>
                <td style={{ textAlign: 'right', verticalAlign: 'middle' }}>{row.transactionCount || '—'}</td>
                <td style={{ textAlign: 'right', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
                  ${money(row.totalAmount)}
                </td>
                <td style={{ verticalAlign: 'middle' }}>
                  <AccountCombobox
                    accounts={expenseAccounts}
                    value={row.selectedAccountId || ''}
                    onChange={(id) => setRowAccount(row.pattern, id)}
                    placeholder="— choose default category —"
                    disabled={saving}
                  />
                  {row.defaultAccountNumber && !dirty[row.pattern] && (
                    <div style={{ fontSize: 11, color: '#546e7a', marginTop: 2 }}>
                      Current: {row.defaultAccountNumber} · {leafLabel(row.defaultAccountName)}
                    </div>
                  )}
                </td>
                <td style={{ verticalAlign: 'middle' }}>
                  <button
                    type="button"
                    className="qbd-btn"
                    style={{ fontSize: 11, padding: '2px 6px' }}
                    disabled={saving || !row.selectedAccountId || !dirty[row.pattern]}
                    onClick={() => saveRow(row)}
                    title="Save this vendor only"
                  >
                    Save
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p style={{ fontSize: 12, color: '#78909c', marginTop: 16 }}>
        After you set defaults here, continue in{' '}
        <Link to="/reconcile">Reconcile</Link> to fix any one-off categories before closing the month.
      </p>
    </div>
  );
}
