import React, { useCallback, useEffect, useState } from 'react';
import { useOutletContext, useSearchParams, useNavigate } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { journalAPI } from '../services/api';
import { fmt, leafLabel } from './helpers';

/** Bank-feed / loan-event drafts are reviewed in Bank Feeds, not here. */
const isAutoDraft = (j) => /^(IMP|LN)-/i.test(String(j.je_number || ''));
const dateOf = (j) => String(j.posting_date || '').slice(0, 10);
const sumLines = (lines, k) => (lines || []).reduce((s, l) => s + (Number(l[k]) || 0), 0);

export default function QBDDraftJournals() {
  const { entityId } = useEntity();
  const { showToast } = useOutletContext() || {};
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = (m) => (showToast ? showToast(m) : null);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Date limiter -- blank = no limit. Pre-set from ?through=YYYY-MM-DD when arriving
  // from the Reconcile window, so you land on exactly the statement period's drafts.
  const [through, setThrough] = useState(() => searchParams.get('through') || '');
  // ?all=1 (set by the Reconcile window's "Review drafts" link) includes bank-feed
  // drafts, so the count you land on matches the count the reconcile warned about.
  const [includeAuto, setIncludeAuto] = useState(() => searchParams.get('all') === '1');
  const [sel, setSel] = useState(() => new Set());
  const [openId, setOpenId] = useState(null);
  const [linesById, setLinesById] = useState({});

  const load = useCallback(() => {
    if (!entityId) return;
    setLoading(true);
    journalAPI.list(entityId, { status: 'DRAFT', limit: 1000 })
      .then((r) => {
        const all = (r.data && r.data.data) || (Array.isArray(r.data) ? r.data : []);
        setRows(all.filter((j) => j.status === 'DRAFT'));
      })
      .catch(() => toast('Could not load draft journal entries'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

  useEffect(() => { setSel(new Set()); setOpenId(null); load(); }, [load]);

  const inScope = rows.filter((j) => (includeAuto ? true : !isAutoDraft(j)));
  const visible = inScope
    .filter((j) => (through ? dateOf(j) <= through : true))
    .sort((a, b) => {
      const da = dateOf(a); const db = dateOf(b);
      if (da !== db) return da < db ? -1 : 1;
      return String(a.je_number || '').localeCompare(String(b.je_number || ''));
    });
  const hiddenByDate = inScope.length - visible.length;

  const toggle = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSel = visible.length > 0 && visible.every((j) => sel.has(j.id));
  const toggleAll = () => setSel(allSel ? new Set() : new Set(visible.map((j) => j.id)));
  const selected = visible.filter((j) => sel.has(j.id));

  const openLines = (id) => {
    setOpenId((cur) => (cur === id ? null : id));
    if (linesById[id] !== undefined) return;
    journalAPI.get(entityId, id)
      .then((r) => setLinesById((m) => ({ ...m, [id]: (r.data && r.data.lines) || [] })))
      .catch(() => setLinesById((m) => ({ ...m, [id]: null })));
  };

  const postSelected = async () => {
    if (!selected.length) { toast('Select at least one entry to post'); return; }
    const msg = `Post ${selected.length} journal ${selected.length === 1 ? 'entry' : 'entries'} to the ledger?`
      + (through ? `\n\nOnly entries dated on or before ${through} are shown.` : '');
    if (!window.confirm(msg)) return;
    setBusy(true);
    let ok = 0;
    const errs = [];
    for (const j of selected) {
      try {
        await journalAPI.approve(entityId, j.id);
        await journalAPI.post(entityId, j.id);
        ok += 1;
      } catch (e) {
        errs.push(`${j.je_number}: ${(e.response && e.response.data && e.response.data.error) || e.message}`);
      }
    }
    setBusy(false);
    setSel(new Set());
    toast(errs.length ? `Posted ${ok}; ${errs.length} failed — ${errs[0]}` : `Posted ${ok} ${ok === 1 ? 'entry' : 'entries'} to the ledger`);
    load();
  };

  return (
    <div className="qbd-form qbd-wide">
      <div className="fhd">Review Journal Entry Drafts <span style={{ fontWeight: 'normal', opacity: 0.85 }}>— drag the bottom-right corner to resize</span></div>

      <div className="frow">
        <label>Show entries through</label>
        <input type="date" value={through} onChange={(e) => setThrough(e.target.value)} />
        <button className="qbd-btn" onClick={() => setThrough('')} disabled={!through}>Clear</button>
        <span className="qbd-muted" style={{ marginLeft: 10 }}>
          {through ? `Hiding drafts dated after ${through}` : 'No date limit — showing all drafts'}
        </span>
        <span className="sp" style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={includeAuto} onChange={(e) => setIncludeAuto(e.target.checked)} />
          Include bank-feed drafts
        </label>
      </div>

      <div className="qbd-wbody">
        <table className="qbd-coa">
          <thead>
            <tr>
              <th style={{ width: 28 }}><input type="checkbox" checked={allSel} onChange={toggleAll} /></th>
              <th style={{ width: 90 }}>DATE</th>
              <th style={{ width: 175 }}>ENTRY #</th>
              <th>MEMO</th>
              <th className="qbd-bal" style={{ width: 110 }}>AMOUNT</th>
              <th style={{ width: 100 }} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6}><div className="qbd-empty">Loading…</div></td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={6}><div className="qbd-empty">No draft journal entries{through ? ` dated on or before ${through}` : ''}.</div></td></tr>
            ) : visible.map((j) => {
              const lines = linesById[j.id];
              const open = openId === j.id;
              return (
                <React.Fragment key={j.id}>
                  <tr>
                    <td><input type="checkbox" checked={sel.has(j.id)} onChange={() => toggle(j.id)} /></td>
                    <td className="qbd-num">{dateOf(j)}</td>
                    <td>{j.je_number}</td>
                    <td style={{ maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis' }} title={j.description}>{j.description}</td>
                    <td className="qbd-bal">{fmt(+j.total_debit)}</td>
                    <td><button className="qbd-btn" onClick={() => openLines(j.id)}>{open ? 'Hide' : 'Both sides'}</button></td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={6} style={{ background: '#f7f9fc', padding: '6px 10px' }}>
                        {lines === undefined ? (
                          <span className="qbd-muted">Loading lines…</span>
                        ) : lines === null ? (
                          <span style={{ color: '#b3261e' }}>Could not load the journal entry lines.</span>
                        ) : lines.length === 0 ? (
                          <span className="qbd-muted">No lines on this entry.</span>
                        ) : (
                          <table className="qbd-jt" style={{ width: '100%' }}>
                            <thead>
                              <tr>
                                <th style={{ width: 300 }}>Account</th>
                                <th>Memo</th>
                                <th style={{ width: 110, textAlign: 'right' }}>Debit</th>
                                <th style={{ width: 110, textAlign: 'right' }}>Credit</th>
                              </tr>
                            </thead>
                            <tbody>
                              {lines.map((l) => (
                                <tr key={l.id}>
                                  <td>{l.account_number} · {leafLabel(l.account_name)}</td>
                                  <td>{l.description || '—'}</td>
                                  <td style={{ textAlign: 'right' }}>{+l.debit ? fmt(+l.debit) : ''}</td>
                                  <td style={{ textAlign: 'right' }}>{+l.credit ? fmt(+l.credit) : ''}</td>
                                </tr>
                              ))}
                              <tr style={{ fontWeight: 'bold', background: '#eef4fb' }}>
                                <td style={{ textAlign: 'right' }} colSpan={2}>Totals</td>
                                <td style={{ textAlign: 'right' }}>{fmt(sumLines(lines, 'debit'))}</td>
                                <td style={{ textAlign: 'right' }}>{fmt(sumLines(lines, 'credit'))}</td>
                              </tr>
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="qbd-botbar">
        <span className="qbd-muted">
          {visible.length} draft{visible.length === 1 ? '' : 's'} shown
          {hiddenByDate > 0 ? ` · ${hiddenByDate} hidden by the date limit` : ''}
          {selected.length ? ` · ${selected.length} selected` : ''}
        </span>
        <span className="sp" />
        <button className="qbd-btn" onClick={() => navigate('/')} disabled={busy}>Close</button>
        <button className="qbd-btn" onClick={load} disabled={busy}>Refresh</button>
        <button className="qbd-btn" style={{ fontWeight: 'bold' }} disabled={busy || !selected.length} onClick={postSelected}>
          {busy ? 'Posting…' : `Approve & Post${selected.length ? ` (${selected.length})` : ''}`}
        </button>
      </div>
    </div>
  );
}
