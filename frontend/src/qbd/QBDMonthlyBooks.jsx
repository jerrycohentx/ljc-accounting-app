import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountingAPI } from '../services/api';
import { statementDateForMonth } from './reconDeepLink';

const MONTHS_2026 = [
  { value: 1, label: 'January 2026' },
  { value: 2, label: 'February 2026' },
  { value: 3, label: 'March 2026' },
  { value: 4, label: 'April 2026' },
  { value: 5, label: 'May 2026' },
  { value: 6, label: 'June 2026' },
  { value: 7, label: 'July 2026' },
  { value: 8, label: 'August 2026' },
  { value: 9, label: 'September 2026' },
  { value: 10, label: 'October 2026' },
  { value: 11, label: 'November 2026' },
  { value: 12, label: 'December 2026' },
];

const STATUS_STYLE = {
  automatic: { bg: '#e8f4ea', color: '#1b5e20', label: 'Automatic' },
  done: { bg: '#e8f4ea', color: '#1b5e20', label: 'Done' },
  optional: { bg: '#eef2f7', color: '#455a64', label: 'Optional' },
  needs_review: { bg: '#fff3e0', color: '#e65100', label: 'Review' },
  ready: { bg: '#e3f2fd', color: '#0d47a1', label: 'Ready' },
  in_progress: { bg: '#fff3e0', color: '#e65100', label: 'In progress' },
  waiting: { bg: '#eef2f7', color: '#546e7a', label: 'Waiting' },
  not_ready: { bg: '#eef2f7', color: '#546e7a', label: 'Not yet' },
  no_statement: { bg: '#eef2f7', color: '#78909c', label: '—' },
  closed: { bg: '#e8f4ea', color: '#1b5e20', label: 'Done' },
  not_started: { bg: '#e3f2fd', color: '#0d47a1', label: 'Start' },
  needs_fix: { bg: '#ffebee', color: '#b71c1c', label: 'Fix' },
};

function StatusPill({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.waiting;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 600,
        background: s.bg,
        color: s.color,
      }}
    >
      {s.label}
    </span>
  );
}

function StepCard({ step, number, onAction, actionLabel, children }) {
  return (
    <div className="mb-step">
      <div className="mb-step-num">{number}</div>
      <div className="mb-step-body">
        <div className="mb-step-head">
          <h3>{step.title}</h3>
          <StatusPill status={step.status} />
        </div>
        <p className="mb-step-detail">{step.statusLabel}</p>
        {step.detail && <p className="mb-step-sub">{step.detail}</p>}
        {children}
        {onAction && actionLabel && (
          <button type="button" className="qbd-btn qbd-btn-primary mb-step-btn" onClick={onAction}>
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

export default function QBDMonthlyBooks() {
  const { entityId, current } = useEntity();
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const now = new Date();
  const defaultMonth = now.getFullYear() === 2026 ? now.getMonth() + 1 : 7;
  const urlMonth = Number(searchParams.get('month'));
  const urlYear = Number(searchParams.get('year'));
  const initialMonth = (Number.isFinite(urlMonth) && urlMonth >= 1 && urlMonth <= 12) ? urlMonth : defaultMonth;
  const [month, setMonth] = useState(initialMonth);
  const [year] = useState((Number.isFinite(urlYear) && urlYear >= 2000) ? urlYear : 2026);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (Number.isFinite(urlMonth) && urlMonth >= 1 && urlMonth <= 12 && urlMonth !== month) {
      setMonth(urlMonth);
    }
  }, [urlMonth]); // eslint-disable-line react-hooks/exhaustive-deps -- sync URL → picker only

  const load = useCallback(() => {
    if (!entityId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr('');
    accountingAPI.monthlyBooks(entityId, { year, month })
      .then((r) => setData(r.data))
      .catch((e) => {
        setData(null);
        setErr((e.response && e.response.data && e.response.data.error) || e.message);
      })
      .finally(() => setLoading(false));
  }, [entityId, year, month]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const y = searchParams.get('year');
    const m = searchParams.get('month');
    if (y === String(year) && m === String(month)) return;
    setSearchParams({ year: String(year), month: String(month) }, { replace: true });
  }, [year, month, searchParams, setSearchParams]);

  const steps = data?.steps;
  const monthLabel = useMemo(
    () => MONTHS_2026.find((m) => m.value === month)?.label || `Month ${month}`,
    [month]
  );

  const goCategories = () => nav('/check-categories');
  const goReconcile = (acct) => {
    if (!acct?.accountId && !acct?.accountNumber) {
      // Open first actionable account for this month, or bare Reconcile
      // (server resume-open will pick the earliest OPEN for this entity).
      const first = steps?.reconcile?.accounts?.find((a) =>
        a.status === 'in_progress' || a.status === 'needs_fix' || a.status === 'not_started'
      );
      if (first) {
        goReconcile(first);
        return;
      }
      nav('/reconcile');
      return;
    }
    const accountNumber = acct.accountNumber || acct.accountId;
    const statementDate = acct.statementDate
      || statementDateForMonth(entityId, accountNumber, year, month);
    const params = new URLSearchParams();
    params.set('account', String(accountNumber));
    params.set('year', String(year));
    params.set('month', String(month));
    if (statementDate) params.set('date', statementDate);
    params.set('go', '1');
    params.set('return', 'month');
    nav(`/reconcile?${params.toString()}`);
  };

  return (
    <div className="mb-page">
      <div className="mb-banner">
        <div>
          <h1>2026 Monthly Books</h1>
          <p className="mb-tagline">
            {current?.name || 'Your company'} — download, review, reconcile, close.
          </p>
        </div>
        <label className="mb-month-picker">
          <span>Working on</span>
          <select
            value={month}
            onChange={(e) => {
              const m = Number(e.target.value);
              setMonth(m);
              setSearchParams({ year: String(year), month: String(m) }, { replace: true });
            }}
          >
            {MONTHS_2026.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="mb-intro">
        <strong>{monthLabel}</strong> — bank and card activity downloads automatically.
        Check categories when you have a few minutes. Reconcile each account when its statement arrives.
        Fix anything that looks wrong during reconciliation, then close the reconciliation when the difference is zero.
      </div>

      {loading && <div className="mb-loading">Loading status…</div>}
      {err && <div className="mb-error">{err}</div>}

      {!loading && steps && (
        <div className="mb-steps">
          <StepCard step={steps.downloads} number="1" />

          <StepCard
            step={steps.categories}
            number="2"
            onAction={
              (steps.categories.waitingTotal > 0 || steps.categories.waitingThisMonth > 0)
                ? goCategories
                : null
            }
            actionLabel={
              steps.categories.waitingThisMonth > 0
                ? `Review ${steps.categories.waitingThisMonth} for ${monthLabel.split(' ')[0]}`
                : steps.categories.waitingTotal > 0
                  ? `Review ${steps.categories.waitingTotal} waiting`
                  : null
            }
          >
            {steps.categories.waitingTotal > 0 && steps.categories.waitingThisMonth === 0 && (
              <p className="mb-step-sub">Nothing for this month, but other months have items waiting.</p>
            )}
          </StepCard>

          <StepCard
            step={steps.reconcile}
            number="3"
            onAction={
              steps.reconcile.accounts?.some((a) => a.status !== 'closed' && a.status !== 'no_statement')
                ? () => goReconcile()
                : null
            }
            actionLabel="Open reconcile"
          >
            {steps.reconcile.accounts?.length > 0 && (
              <ul className="mb-recon-list">
                {steps.reconcile.accounts.map((a) => (
                  <li key={a.accountId}>
                    <span>{a.name}</span>
                    <StatusPill status={a.status} />
                    {(a.status === 'not_started' || a.status === 'in_progress' || a.status === 'needs_fix') && (
                      <button
                        type="button"
                        className="mb-link-btn"
                        onClick={() => goReconcile(a)}
                      >
                        Reconcile
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </StepCard>

          <StepCard step={steps.verified} number="4">
            {steps.verified.isClosed ? (
              <p className="mb-step-sub mb-done">{monthLabel} is closed and verified.</p>
            ) : (
              <>
                <p className="mb-step-sub">
                  The month is verified when every account is reconciled with a $0.00 difference
                  and the books pass integrity checks.
                </p>
                {steps.verified.blockers?.length > 0 && (
                  <ul className="mb-blockers">
                    {steps.verified.blockers.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </StepCard>
        </div>
      )}

      <div className="mb-footer-note">
        Adjustments (missing transactions or wrong categories) are made during reconciliation —
        not with forced balance entries.
      </div>
    </div>
  );
}
