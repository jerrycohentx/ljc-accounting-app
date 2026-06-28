import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { reportAPI } from '../services/api';
import { fmt, leafLabel } from './helpers';

const VLANE = [['🧾', 'Enter Bills'], ['→'], ['💵', 'Pay Bills']];
const CLANE = [['🧾', 'Sales Receipts'], ['💳', 'Online Payments'], ['📑', 'Create Invoices'], ['→'], ['📈', 'Finance Charges'], ['📃', 'Statements'], ['→'], ['💵', 'Receive Payments'], ['↩️', 'Refunds & Credits']];
const ELANE = [['⏱️', 'Enter Time']];

export default function QBDHome() {
  const { entityId, current } = useEntity();
  const nav = useNavigate();
  const [bals, setBals] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!entityId) return;
    setLoading(true);
    reportAPI.accountBalances(entityId)
      .then((r) => setBals(Array.isArray(r.data) ? r.data : (r.data?.data || [])))
      .catch(() => setBals([]))
      .finally(() => setLoading(false));
  }, [entityId]);

  const g = (re, type) => bals.filter((a) => (type ? a.accountType === type : true) && re.test(a.accountName || ''));
  const cash = g(/^Cash/);
  const brk = g(/Marketable-Securities|Fidelity/);
  const cc = g(/Credit-Cards/, 'LIABILITY');
  const ar = g(/Accounts-Receivable|Notes-Receivable/);

  const COMPANY = [['📋', 'Chart of Accounts', () => nav('/accounts')], ['📦', 'Items & Services', null], ['🧾', 'Order Checks', null], ['📅', 'Calendar', null]];
  const BANKING = [['🏦', 'Bank Feeds', () => nav('/bank-feeds')], ['💰', 'Record Deposits', () => nav('/make-deposits')], ['✓', 'Reconcile', () => nav('/reconcile')], ['✍️', 'Write Checks', () => nav('/write-checks')], ['💳', 'Credit Card Charges', null], ['📒', 'Use Register', () => nav('/accounts')]];

  const abRow = (a) => (
    <div key={a.id} className="ab" onClick={() => nav('/register/' + a.id)}>
      <span>{leafLabel(a.accountName)}</span>
      <b className={a.balance < 0 ? 'qbd-neg' : ''}>{fmt(a.balance) || '0.00'}</b>
    </div>
  );
  const grp = (title, arr) => arr.length ? <React.Fragment key={title}><div className="grp">{title}</div>{arr.map(abRow)}</React.Fragment> : null;
  const flow = (ic, label, fn, key) => (
    <div key={key} className="qbd-flow" onClick={fn || (() => {})} style={fn ? {} : { opacity: 0.85 }}>
      <div className="ic">{ic}</div>{label}
    </div>
  );

  return (
    <div>
      <div style={{ background: 'linear-gradient(#3f6cb0,#2a5596)', color: '#fff', fontWeight: 'bold', padding: '5px 12px', fontSize: 13 }}>Home</div>
      <div className="qbd-canvas">
        <div className="qbd-lanes">
          <div className="qbd-lane"><div className="qbd-lanehead">VENDORS</div><div className="qbd-lanebody">{VLANE.map((it, i) => it[0] === '→' ? <span key={i} className="qbd-arrow">▶</span> : flow(it[0], it[1], null, i))}</div></div>
          <div className="qbd-lane"><div className="qbd-lanehead">CUSTOMERS</div><div className="qbd-lanebody">{CLANE.map((it, i) => it[0] === '→' ? <span key={i} className="qbd-arrow">▶</span> : flow(it[0], it[1], null, i))}</div></div>
          <div className="qbd-lane"><div className="qbd-lanehead">EMPLOYEES</div><div className="qbd-lanebody">{ELANE.map((it, i) => flow(it[0], it[1], null, i))}</div></div>
        </div>
        <div className="qbd-cols">
          <div className="qbd-col"><div className="qbd-colhead">COMPANY</div>{COMPANY.map((c, i) => flow(c[0], c[1], c[2], i))}</div>
          <div className="qbd-col"><div className="qbd-colhead">BANKING</div>{BANKING.map((c, i) => flow(c[0], c[1], c[2], i))}</div>
        </div>
        <div className="qbd-rightcol">
          <div className="qbd-rp">
            <h4>ACCOUNT BALANCES</h4>
            {loading ? <div className="info">Loading…</div> : (
              <>{grp('Bank', cash)}{grp('Brokerage', brk)}{grp('Credit Cards', cc)}{grp('Accounts Receivable', ar)}
                {!cash.length && !cc.length && !ar.length && <div className="info">No balance-sheet accounts with activity yet.</div>}</>
            )}
          </div>
          <div className="qbd-rp"><h4>DO MORE WITH QUICKBOOKS</h4><div className="info">{current ? current.name : ''}</div></div>
        </div>
      </div>
    </div>
  );
}
