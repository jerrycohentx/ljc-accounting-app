import React, { useEffect, useState, useCallback } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, journalAPI } from '../services/api';
import { fmt, todayISO, fmtShortDate, leafLabel } from './helpers';
import AccountCombobox, { flattenAccounts } from './AccountCombobox';

const blankLine = () => ({ accountId: '', debit: '', credit: '', description: '' });

export default function QBDJournalEntry() {
  const { entityId } = useEntity();
  const { showToast } = useOutletContext() || {};
  const [searchParams] = useSearchParams();
  const [accounts, setAccounts] = useState([]);
  const [date, setDate] = useState(todayISO());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([blankLine(), blankLine()]);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState([]);
  const [reconDrafts, setReconDrafts] = useState([]);
  const [reconDraftAccount, setReconDraftAccount] = useState(null);

  const reconFilterAccountId = searchParams.get('accountId') || '';
  const reconFilterThrough = searchParams.get('through') || searchParams.get('endDate') || '';
  const reconFilterActive = searchParams.get('from') === 'recon'
    && searchParams.get('status') === 'DRAFT'
    && !!reconFilterAccountId;

  const loadRecent = useCallback(() => {
    if (!entityId) return;
    journalAPI.list(entityId, { limit: 8 }).then((r) => setRecent(r.data?.data || [])).catch(() => {});
  }, [entityId]);

  const loadReconDrafts = useCallback(() => {
    if (!entityId || !reconFilterActive) {
      setReconDrafts([]);
      setReconDraftAccount(null);
      return;
    }
    Promise.all([
      accountAPI.get(entityId, reconFilterAccountId).catch(() => null),
      journalAPI.list(entityId, {
        status: 'DRAFT',
        accountId: reconFilterAccountId,
        endDate: reconFilterThrough || undefined,
        limit: 1000,
      }),
    ]).then(([acctRes, draftRes]) => {
      setReconDraftAccount(acctRes?.data || null);
      setReconDrafts(draftRes.data?.data || []);
    }).catch(() => {
      setReconDrafts([]);
      setReconDraftAccount(null);
    });
  }, [entityId, reconFilterActive, reconFilterAccountId, reconFilterThrough]);

  useEffect(() => {
    if (!entityId) return;
    accountAPI.list(entityId).then((r) => setAccounts(flattenAccounts(Array.isArray(r.data) ? r.data : (r.data?.data || [])))).catch(() => {});
    loadRecent();
    loadReconDrafts();
  }, [entityId, loadRecent, loadReconDrafts]);

  const setLine = (i, k, v) => setLines((ls) => ls.map((l, j) => j === i ? { ...l, [k]: v } : l));
  const addLine = () => setLines((ls) => [...ls, blankLine()]);
  const delLine = (i) => setLines((ls) => ls.length > 2 ? ls.filter((_, j) => j !== i) : ls);

  const totDeb = lines.reduce((s, l) => s + (+l.debit || 0), 0);
  const totCred = lines.reduce((s, l) => s + (+l.credit || 0), 0);
  const balanced = Math.abs(totDeb - totCred) < 0.01 && totDeb > 0;
  const validLines = lines.filter((l) => l.accountId && ((+l.debit) || (+l.credit)));

  const buildBody = () => ({
    description: memo || 'Journal Entry',
    postingDate: date,
    memo,
    lines: validLines.map((l) => ({ accountId: l.accountId, debit: +l.debit || 0, credit: +l.credit || 0, description: l.description || '' })),
  });

  const reset = () => { setLines([blankLine(), blankLine()]); setMemo(''); };

  const save = async (post) => {
    if (validLines.length < 2) { showToast && showToast('Need at least two lines'); return; }
    if (!balanced) { showToast && showToast('Debits must equal credits'); return; }
    setBusy(true);
    try {
      const r = await journalAPI.create(entityId, buildBody());
      const id = r.data?.id;
      if (post && id) {
        try {
          await journalAPI.approve(entityId, id);
          await journalAPI.post(entityId, id);
          showToast && showToast(`Posted ${r.data.jeNumber || ''} to the ledger`);
        } catch (err) {
          showToast && showToast('Saved as draft — posting needs admin role');
        }
      } else {
        showToast && showToast(`Saved draft ${r.data?.jeNumber || ''}`);
      }
      reset(); loadRecent();
    } catch (err) {
      showToast && showToast('Save failed: ' + (err.response?.data?.error || err.message));
    } finally { setBusy(false); }
  };

  return (
    <div>
      {reconFilterActive && (
        <div className="qbd-form" style={{ marginBottom: 12 }}>
          <div className="fhd">
            Draft journal entries for{' '}
            {reconDraftAccount
              ? `${reconDraftAccount.account_number} · ${leafLabel(reconDraftAccount.account_name)}`
              : 'this account'}
            {reconFilterThrough ? ` through ${fmtShortDate(reconFilterThrough)}` : ''}
          </div>
          <div className="qbd-wbody">
            <div className="qbd-muted" style={{ padding: '8px 12px', fontSize: 11, lineHeight: 1.45 }}>
              These drafts are not in the bank register yet. Post or delete them before you finish reconciling this account.
              Amex charge categorization lives under <strong>Company → Review &amp; Approve Charges</strong>, not here.
            </div>
            <table className="qbd-coa">
              <thead><tr><th>DATE</th><th>ENTRY #</th><th>MEMO</th><th className="qbd-bal">AMOUNT</th></tr></thead>
              <tbody>
                {reconDrafts.length === 0 ? (
                  <tr><td colSpan={4}><div className="qbd-empty">No draft journal entries on this account for that period.</div></td></tr>
                ) : reconDrafts.map((j) => (
                  <tr key={j.id}>
                    <td className="qbd-num">{fmtShortDate(j.posting_date)}</td>
                    <td>{j.je_number}</td>
                    <td>{j.description}</td>
                    <td className="qbd-bal">{fmt(+j.total_debit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="qbd-form">
        <div className="fhd">Make General Journal Entries</div>
        <div className="frow">
          <label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <label style={{ width: 60 }}>Memo</label><input style={{ flex: 1 }} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Entry memo" />
        </div>
        <div style={{ padding: '0 12px 12px' }}>
          <table className="qbd-jt">
            <thead><tr><th style={{ width: 280 }}>Account</th><th style={{ width: 120 }}>Debit</th><th style={{ width: 120 }}>Credit</th><th>Memo</th><th style={{ width: 30 }} /></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <AccountCombobox
                      accounts={accounts}
                      value={l.accountId}
                      onChange={(id) => setLine(i, 'accountId', id)}
                      placeholder="— select account —"
                    />
                  </td>
                  <td><input type="number" step="0.01" value={l.debit} onChange={(e) => setLine(i, 'debit', e.target.value)} style={{ textAlign: 'right' }} /></td>
                  <td><input type="number" step="0.01" value={l.credit} onChange={(e) => setLine(i, 'credit', e.target.value)} style={{ textAlign: 'right' }} /></td>
                  <td><input value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} /></td>
                  <td><span style={{ cursor: 'pointer', color: '#b3261e' }} onClick={() => delLine(i)}>✕</span></td>
                </tr>
              ))}
              <tr style={{ fontWeight: 'bold', background: '#eef4fb' }}>
                <td style={{ textAlign: 'right' }}>Totals</td>
                <td style={{ textAlign: 'right' }}>{fmt(totDeb)}</td>
                <td style={{ textAlign: 'right' }}>{fmt(totCred)}</td>
                <td colSpan={2} style={{ color: balanced ? '#2f6b3a' : '#b3261e' }}>{balanced ? 'In balance' : `Out of balance ${fmt(totDeb - totCred)}`}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="qbd-botbar">
          <button className="qbd-btn" onClick={addLine}>+ Add Line</button>
          <span className="sp" />
          <button className="qbd-btn" disabled={busy} onClick={() => save(false)}>Save Draft</button>
          <button className="qbd-btn" disabled={busy} onClick={() => save(true)} style={{ fontWeight: 'bold' }}>Save &amp; Post</button>
        </div>
      </div>

      <div className="qbd-form">
        <div className="fhd">Recent Journal Entries</div>
        <div className="qbd-wbody">
          <table className="qbd-coa">
            <thead><tr><th>DATE</th><th>ENTRY #</th><th>MEMO</th><th>STATUS</th><th className="qbd-bal">AMOUNT</th></tr></thead>
            <tbody>
              {recent.length === 0 ? <tr><td colSpan={5}><div className="qbd-empty">No journal entries yet.</div></td></tr> :
                recent.map((j) => (
                  <tr key={j.id}><td className="qbd-num">{fmtShortDate(j.posting_date)}</td><td>{j.je_number}</td><td>{j.description}</td><td>{j.status}</td><td className="qbd-bal">{fmt(+j.total_debit)}</td></tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
