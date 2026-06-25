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

  const toggleActive = () => {
    if (!selAcct) return;
    accountAPI.update(entityId, selAcct.id, { isActive: selAcct.is_active ? 0 : 1 })
      .then(() => { showToast && showToast(`${selAcct.account_number} is now ${selAcct.is_active ? 'Inactive' : 'Active'}`); load(); })
      .catch(() => showToast && showToast('Update failed (permission?)'));
    setMenu(null);
  };

  const botMenu = (name) => {
    const a = selAcct;
    if (name === 'Account') return [['Use Register', a ? () => nav('/register/' + a.id) : null], a ? [`Make ${a.is_active ? 'Inactive' : 'Active'}`, toggleActive] : ['Make Inactive', null], ['New Account…', () => nav('/journal')]];
    if (name === 'Activities') return [['Use Register', a ? () => nav('/register/' + a.id) : null], ['Make General Journal Entries…', () => nav('/journal')]];
    return [['QuickReport', a ? () => nav('/register/' + a.id) : null], ['Balance Sheet', () => nav('/reports?r=bs')], ['Profit & Loss', () => nav('/reports?r=pl')]];
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
    </div>
  );
}
