import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, reportAPI } from '../services/api';
import { fmt, typeLabel, leafLabel } from './helpers';

function flatten(nodes, depth, out) {
  (nodes || []).forEach((n) => {
    out.push({ ...n, _depth: depth });
    if (n.children && n.children.length) flatten(n.children, depth + 1, out);
  });
  return out;
}

const BLANK_FORM = {
  accountNumber: '',
  accountName: '',
  accountType: 'REVENUE',
  parentAccountId: '',
  description: '',
};

export default function QBDChartOfAccounts() {
  const { entityId } = useEntity();
  const nav = useNavigate();
  const { showToast } = useOutletContext() || {};
  const [rows, setRows] = useState([]);
  const [balMap, setBalMap] = useState({});
  const [includeInactive, setIncludeInactive] = useState(false);
  const [sel, setSel] = useState(null);
  const [menu, setMenu] = useState(null);
  const [loading, setLoading] = useState(true);
  const [acctDialog, setAcctDialog] = useState(null); // null | 'new' | 'edit'
  const [form, setForm] = useState(BLANK_FORM);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!entityId) return;
    setLoading(true);
    Promise.all([
      accountAPI.list(entityId).then((r) => Array.isArray(r.data) ? r.data : (r.data?.data || [])),
      reportAPI.accountBalances(entityId).then((r) => Array.isArray(r.data) ? r.data : (r.data?.data || [])).catch(() => []),
    ]).then(([tree, bals]) => {
      setRows(flatten(tree, 0, []));
      const m = {};
      bals.forEach((b) => { m[b.id] = b.balance; });
      setBalMap(m);
    }).finally(() => setLoading(false));
  }, [entityId]);

  useEffect(() => { load(); }, [load]);

  const visible = rows.filter((a) => includeInactive || a.is_active);
  const selAcct = rows.find((a) => a.id === sel);

  const openNew = () => {
    setForm({
      ...BLANK_FORM,
      parentAccountId: selAcct?.id || '',
      accountType: selAcct?.account_type || 'REVENUE',
    });
    setAcctDialog('new');
    setMenu(null);
  };

  const openEdit = () => {
    if (!selAcct) return;
    setForm({
      accountNumber: selAcct.account_number || '',
      accountName: selAcct.account_name || '',
      accountType: selAcct.account_type || 'ASSET',
      parentAccountId: selAcct.parent_account_id || '',
      description: selAcct.description || '',
    });
    setAcctDialog('edit');
    setMenu(null);
  };

  const saveAccount = async () => {
    if (!form.accountNumber.trim() || !form.accountName.trim() || !form.accountType) {
      showToast && showToast('Number, name, and type are required');
      return;
    }
    setBusy(true);
    try {
      if (acctDialog === 'edit' && selAcct) {
        await accountAPI.update(entityId, selAcct.id, {
          accountName: form.accountName.trim(),
          description: form.description,
          parentAccountId: form.parentAccountId || null,
        });
        showToast && showToast(`Updated ${form.accountNumber}`);
      } else {
        await accountAPI.create(entityId, {
          accountNumber: form.accountNumber.trim(),
          accountName: form.accountName.trim(),
          accountType: form.accountType,
          parentAccountId: form.parentAccountId || null,
          description: form.description || '',
        });
        showToast && showToast(`Created ${form.accountNumber} · ${form.accountName}`);
      }
      setAcctDialog(null);
      load();
    } catch (err) {
      showToast && showToast(err.response?.data?.error || err.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = () => {
    if (!selAcct) return;
    accountAPI.update(entityId, selAcct.id, { isActive: selAcct.is_active ? 0 : 1 })
      .then(() => { showToast && showToast(`${selAcct.account_number} is now ${selAcct.is_active ? 'Inactive' : 'Active'}`); load(); })
      .catch(() => showToast && showToast('Update failed (permission?)'));
    setMenu(null);
  };

  const botMenu = (name) => {
    const a = selAcct;
    if (name === 'Account') {
      return [
        ['Use Register', a ? () => nav('/register/' + a.id) : null],
        a ? [`Make ${a.is_active ? 'Inactive' : 'Active'}`, toggleActive] : ['Make Inactive', null],
        ['New Account…', openNew],
        a ? ['Edit Account…', openEdit] : ['Edit Account…', null],
      ];
    }
    if (name === 'Activities') {
      return [
        ['Use Register', a ? () => nav('/register/' + a.id) : null],
        ['Make General Journal Entries…', () => nav('/journal')],
      ];
    }
    return [
      ['QuickReport', a ? () => nav('/register/' + a.id) : null],
      ['Balance Sheet', () => nav('/reports?r=bs')],
      ['Profit & Loss', () => nav('/reports?r=pl')],
    ];
  };

  return (
    <div className="qbd-window" onClick={(e) => { if (!e.target.closest('.qbd-btn') && !e.target.closest('.qbd-topmenu')) setMenu(null); }}>
      <div className="qbd-wtitle">📋 Chart of Accounts</div>
      <div className="qbd-wbody">
        {loading ? <div className="qbd-loading">Loading accounts…</div> : (
          <table className="qbd-coa">
            <thead><tr><th>NAME</th><th>TYPE</th><th className="qbd-bal">BALANCE TOTAL</th></tr></thead>
            <tbody>
              {visible.map((a) => {
                const bal = balMap[a.id];
                return (
                  <tr key={a.id} className={(a.is_active ? '' : 'inactive') + (a.id === sel ? ' sel' : '')}
                      onClick={() => setSel(a.id)} onDoubleClick={() => nav('/register/' + a.id)}
                      title="Click to select, double-click to open register">
                    <td className={'qbd-i' + Math.min(a._depth, 3)}><span className="qbd-diamond">◆</span><span className="nm">{a.account_number} · {leafLabel(a.account_name)}</span></td>
                    <td className="qbd-typ">{typeLabel(a)}</td>
                    <td className={'qbd-bal' + (bal < 0 ? ' qbd-neg' : '')}>{fmt(bal)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="qbd-botbar">
        {['Account', 'Activities', 'Reports'].map((n) => (
          <button key={n} className="qbd-btn" onClick={(e) => { e.stopPropagation(); setMenu(menu === n ? null : { name: n, left: e.target.offsetLeft }); }}>{n} ▾</button>
        ))}
        <button type="button" className="qbd-btn" onClick={openNew} style={{ fontWeight: 'bold' }}>New Account</button>
        <span className="sp" />
        <label className="qbd-chk"><input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Include inactive</label>
        {menu && (
          <div className="qbd-topmenu" style={{ left: menu.left, bottom: 36, top: 'auto', position: 'absolute' }}>
            {botMenu(menu.name).map((it, i) => (
              <div key={i} className={it[1] ? '' : 'hd'} onClick={() => { if (it[1]) { setMenu(null); it[1](); } }}>{it[0]}</div>
            ))}
          </div>
        )}
      </div>

      {acctDialog && (
        <div className="qbd-modal-backdrop" onClick={() => !busy && setAcctDialog(null)}>
          <div className="qbd-window" style={{ width: 480, margin: 0 }} onClick={(e) => e.stopPropagation()}>
            <div className="qbd-wtitle">{acctDialog === 'edit' ? 'Edit Account' : 'New Account'} <span className="x" onClick={() => !busy && setAcctDialog(null)}>✕</span></div>
            <div className="qbd-wbody" style={{ padding: 16 }}>
              <div className="frow" style={{ marginBottom: 10 }}>
                <label style={{ width: 110 }}>Number</label>
                <input
                  value={form.accountNumber}
                  disabled={acctDialog === 'edit' || busy}
                  onChange={(e) => setForm((f) => ({ ...f, accountNumber: e.target.value }))}
                  style={{ width: 120 }}
                  placeholder="4100"
                />
              </div>
              <div className="frow" style={{ marginBottom: 10 }}>
                <label style={{ width: 110 }}>Name</label>
                <input
                  value={form.accountName}
                  disabled={busy}
                  onChange={(e) => setForm((f) => ({ ...f, accountName: e.target.value }))}
                  style={{ flex: 1 }}
                  placeholder="Rental Income"
                />
              </div>
              <div className="frow" style={{ marginBottom: 10 }}>
                <label style={{ width: 110 }}>Type</label>
                <select
                  value={form.accountType}
                  disabled={acctDialog === 'edit' || busy}
                  onChange={(e) => setForm((f) => ({ ...f, accountType: e.target.value }))}
                >
                  <option value="ASSET">Asset</option>
                  <option value="LIABILITY">Liability</option>
                  <option value="EQUITY">Equity</option>
                  <option value="REVENUE">Income</option>
                  <option value="EXPENSE">Expense</option>
                </select>
              </div>
              <div className="frow" style={{ marginBottom: 10 }}>
                <label style={{ width: 110 }}>Subaccount of</label>
                <select
                  value={form.parentAccountId}
                  disabled={busy}
                  onChange={(e) => setForm((f) => ({ ...f, parentAccountId: e.target.value }))}
                  style={{ flex: 1 }}
                >
                  <option value="">— none —</option>
                  {rows.filter((a) => a.is_active && a.id !== selAcct?.id).map((a) => (
                    <option key={a.id} value={a.id}>{a.account_number} · {leafLabel(a.account_name)}</option>
                  ))}
                </select>
              </div>
              <div className="frow">
                <label style={{ width: 110 }}>Description</label>
                <input
                  value={form.description}
                  disabled={busy}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  style={{ flex: 1 }}
                />
              </div>
            </div>
            <div className="qbd-foot">
              <span className="sp" />
              <button type="button" className="qbd-btn" disabled={busy} onClick={() => setAcctDialog(null)}>Cancel</button>
              <button type="button" className="qbd-btn" disabled={busy} onClick={saveAccount} style={{ fontWeight: 'bold' }}>
                {busy ? 'Saving…' : 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
