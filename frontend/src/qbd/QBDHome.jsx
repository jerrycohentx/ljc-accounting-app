import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { reportAPI } from '../services/api';
import { fmt, leafLabel } from './helpers';

// QuickBooks Desktop-style Home: workflow swim-lanes + quick-access columns +
// an Account Balances panel. Populated only with this app's real, working
// features — no QuickBooks marketing, add-ons, or dead links.
const A = ['→']; // connector arrow between workflow steps

const LANES = [
  ['BANK ACTIVITY', [
    ['🏦', 'Bank Feeds', '/bank-feeds'], A, ['🔍', 'Review', '/feed-review'], A,
    ['🔗', 'Bank Import', '/bank-import'], A, ['✓', 'Reconcile', '/reconcile'],
  ]],
  ['GENERAL LEDGER', [
    ['📋', 'Chart of Accounts', '/accounts'], A, ['📝', 'Journal Entry', '/journal'], A,
    ['✍️', 'Write Checks', '/write-checks'], A, ['💰', 'Make Deposits', '/make-deposits'],
  ]],
  ['CLOSE & REPORT', [
    ['📥', 'Receipt Inbox', '/receipts'], A, ['🔒', 'Period Close', '/period-close'], A,
    ['📊', 'Reports', '/reports'], A, ['🧾', 'Tax Financials', '/tax-financials'],
  ]],
];

const COMPANY = [
  ['📋', 'Chart of Accounts', '/accounts'],
  ['📝', 'Make Journal Entry', '/journal'],
  ['📒', 'Registers', '/accounts'],
  ['🔒', 'Period Close', '/period-close'],
  ['📈', 'Dashboard', '/dashboard'],
];

const BANKING = [
  ['🏦', 'Bank Feeds', '/bank-feeds'],
  ['🔗', 'Bank Import', '/bank-import'],
  ['✓', 'Reconcile', '/reconcile'],
  ['✍️', 'Write Checks', '/write-checks'],
  ['💰', 'Make Deposits', '/make-deposits'],
  ['⚡', 'ACH / Interest Import', '/ach-interest-import'],
  ['📥', 'Receipt Inbox', '/receipts'],
  ['📄', 'Reconciliation Reports', '/reconciliation-reports'],
];

const SHORTCUTS = [
  ['Reconcile an account', '/reconcile'],
  ['Enter a journal entry', '/journal'],
  ['Run reports', '/reports'],
  ['Close a period', '/period-close'],
];

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

  const abRow = (a) => (
    <div key={a.id} className="ab" onClick={() => nav('/register/' + a.id)}>
      <span>{leafLabel(a.accountName)}</span>
      <b className={a.balance < 0 ? 'qbd-neg' : ''}>{fmt(a.balance) || '0.00'}</b>
    </div>
  );
  const grp = (title, arr) => (arr.length ? (
    <React.Fragment key={title}>
      <div className="grp">{title}</div>
      {arr.map(abRow)}
    </React.Fragment>
  ) : null);

  const flow = (ic, label, path, key) => (
    <div key={key} className="qbd-flow" onClick={() => path && nav(path)} title={label}>
      <div className="ic">{ic}</div>{label}
    </div>
  );

  return (
    <div>
      <div style={{ background: 'linear-gradient(#3f6cb0,#2a5596)', color: '#fff', fontWeight: 'bold', padding: '5px 12px', fontSize: 13 }}>
        Home{current ? ` — ${current.name}` : ''}
      </div>
      <div className="qbd-canvas">
        <div className="qbd-lanes">
          {LANES.map(([head, steps]) => (
            <div className="qbd-lane" key={head}>
              <div className="qbd-lanehead">{head}</div>
              <div className="qbd-lanebody">
                {steps.map((it, i) => (it[0] === '→'
                  ? <span key={i} className="qbd-arrow">▶</span>
                  : flow(it[0], it[1], it[2], i)))}
              </div>
            </div>
          ))}
        </div>
        <div className="qbd-cols">
          <div className="qbd-col"><div className="qbd-colhead">COMPANY</div>{COMPANY.map((c, i) => flow(c[0], c[1], c[2], i))}</div>
          <div className="qbd-col"><div className="qbd-colhead">BANKING</div>{BANKING.map((c, i) => flow(c[0], c[1], c[2], i))}</div>
        </div>
        <div className="qbd-rightcol">
          <div className="qbd-rp">
            <h4>ACCOUNT BALANCES</h4>
            {loading ? <div className="info">Loading…</div> : (
              <>
                {grp('Bank', cash)}
                {grp('Brokerage', brk)}
                {grp('Credit Cards', cc)}
                {grp('Receivables', ar)}
                {!cash.length && !cc.length && !ar.length && !brk.length && (
                  <div className="info">No balance-sheet accounts with activity yet.</div>
                )}
              </>
            )}
          </div>
          <div className="qbd-rp">
            <h4>SHORTCUTS</h4>
            {SHORTCUTS.map(([label, path]) => (
              <div key={path} className="ab" onClick={() => nav(path)}>
                <span>{label}</span><span style={{ color: '#7c97b2' }}>›</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
