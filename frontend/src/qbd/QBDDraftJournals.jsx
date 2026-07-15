import React, { useCallback, useEffect, useState } from 'react';
import { useOutletContext, useSearchParams, useNavigate } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { accountAPI, journalAPI } from '../services/api';
import { fmt, leafLabel } from './helpers';

/** Bank-feed / loan-event drafts are reviewed in Bank Feeds, not here. */
const isAutoDraft = (j) => /^(IMP|LN)-/i.test(String(j.je_number || ''));
const dateOf = (j) => String(j.posting_date || '').slice(0, 10);
const sumLines = (lines, k) => (lines || []).reduce((s, l) => s + (Number(l[k]) || 0), 0);
const flatAccts = (nodes, out) => {
  (nodes || []).forEach((n) => { if (n.is_active) out.push(n); if (n.children) flatAccts(n.children, out); });
  return out;
};
const blankEditLine = () => ({ accountId: '', debit: '', credit: '', description: '' });

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
  // Multiple rows can be expanded at once, so a whole cycle can be compared side by side.
  const [openIds, setOpenIds] = useState(() => new Set());
  const [jeById, setJeById] = useState({});
  // Inline correction of a DRAFT entry's lines (accounts / amounts / line memo).
  const [accounts, setAccounts] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editLines, setEditLines] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!entityId) return;
    accountAPI.list(entityId)
      .then((r) => setAccounts(flatAccts(Array.isArray(r.data) ? r.data : (r.data && r.data.data) || [], [])))
      .catch(() => setAccounts([]));
  }, [entityId]);

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

  useEffect(() => { setSel(new Set()); setOpenIds(new Set()); load(); }, [load]);

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

  const fetchJe = (id) => {
    if (jeById[id] !== undefined) return;
    journalAPI.get(entityId, id)
      .then((r) => setJeById((m) => ({ ...m, [id]: r.data || null })))
      .catch(() => setJeById((m) => ({ ...m, [id]: null })));
  };

  const toggleOpen = (id) => {
    setOpenIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    fetchJe(id);
  };

  // Open every visible entry at once, so a whole cycle can be read together.
  const expandAll = () => { visible.forEach((j) => fetchJe(j.id)); setOpenIds(new Set(visible.map((j) => j.id))); };
  const collapseAll = () => setOpenIds(new Set());

  // ---- Inline editing of a DRAFT entry's lines -----------------------------
  const startEdit = (id, lines) => {
    setEditingId(id);
    setEditLines((lines || []).map((l) => ({
      accountId: l.account_id,
      debit: +l.debit ? String(+l.debit) : '',
      credit: +l.credit ? String(+l.credit) : '',
      description: l.description || '',
    })));
  };
  const cancelEdit = () => { setEditingId(null); setEditLines([]); };
  const setEditLine = (i, k, v) => setEditLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const addEditLine = () => setEditLines((ls) => [...ls, blankEditLine()]);
  const delEditLine = (i) => setEditLines((ls) => (ls.length > 2 ? ls.filter((_, j) => j !== i) : ls));

  const editDebit = sumLines(editLines.map((l) => ({ debit: +l.debit || 0 })), 'debit');
  const editCredit = sumLines(editLines.map((l) => ({ credit: +l.credit || 0 })), 'credit');
  const editBalanced = Math.abs(editDebit - editCredit) < 0.005 && editDebit > 0;

  const saveEdit = async (id) => {
    const valid = editLines.filter((l) => l.accountId && ((+l.debit) || (+l.credit)));
    if (valid.length < 2) { toast('An entry needs at least two lines with an account and an amount'); return; }
    if (!editBalanced) { toast(`Debits must equal credits — currently out of balance by ${fmt(editDebit - editCredit)}`); return; }
    setSaving(true);
    try {
      await journalAPI.update(entityId, id, {
        lines: valid.map((l) => ({
          accountId: l.accountId,
          debit: +l.debit || 0,
          credit: +l.credit || 0,
          description: l.description || '',
        })),
      });
      setJeById((m) => ({ ...m, [id]: undefined }));   // force a re-fetch of the corrected entry
      const r = await journalAPI.get(entityId, id);
      setJeById((m) => ({ ...m, [id]: r.data || null }));
      cancelEdit();
      load();
      toast('Entry corrected — still a draft, nothing posted');
    } catch (e) {
      toast('Could not save: ' + ((e.response && e.response.data && e.response.data.error) || e.message));
    } finally { setSaving(false); }
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
        {/* width:auto overrides .qbd-form label{width:118px}, which would clip this text. */}
        <label style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', textAlign: 'left' }}>
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
              <th>DESCRIPTION</th>
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
              const je = jeById[j.id];
              const lines = je === undefined ? undefined : (je === null ? null : (je.lines || []));
              const open = openIds.has(j.id);
              return (
                <React.Fragment key={j.id}>
                  <tr>
                    <td><input type="checkbox" checked={sel.has(j.id)} onChange={() => toggle(j.id)} /></td>
                    <td className="qbd-num">{dateOf(j)}</td>
                    <td>{j.je_number}</td>
                    <td style={{ maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis' }} title={j.description}>{j.description}</td>
                    <td className="qbd-bal">{fmt(+j.total_debit)}</td>
                    <td><button className="qbd-btn" onClick={() => toggleOpen(j.id)}>{open ? 'Hide' : 'Both sides'}</button></td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={6} style={{ background: '#f7f9fc', padding: '6px 10px' }}>
                        {je && je.memo && (
                          <div style={{ marginBottom: 8, padding: '7px 9px', background: '#fffbe8', border: '1px solid #e3d9a3', borderRadius: 3, fontSize: 12, lineHeight: 1.55, whiteSpace: 'normal' }}>
                            <b>Why this entry exists:</b> {je.memo}
                          </div>
                        )}
                        {lines === undefined ? (
                          <span className="qbd-muted">Loading lines…</span>
                        ) : lines === null ? (
                          <span style={{ color: '#b3261e' }}>Could not load the journal entry lines.</span>
                        ) : lines.length === 0 ? (
                          <span className="qbd-muted">No lines on this entry.</span>
                        ) : editingId === j.id ? (
                          <>
                            <table className="qbd-jt" style={{ width: '100%' }}>
                              <thead>
                                <tr>
                                  <th style={{ width: 300 }}>Account</th>
                                  <th>Memo</th>
                                  <th style={{ width: 110, textAlign: 'right' }}>Debit</th>
                                  <th style={{ width: 110, textAlign: 'right' }}>Credit</th>
                                  <th style={{ width: 26 }} />
                                </tr>
                              </thead>
                              <tbody>
                                {editLines.map((l, i) => (
                                  <tr key={i}>
                                    <td>
                                      <select value={l.accountId} onChange={(e) => setEditLine(i, 'accountId', e.target.value)}>
                                        <option value="">— select account —</option>
                                        {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {leafLabel(a.account_name)}</option>)}
                                      </select>
                                    </td>
                                    <td><input value={l.description} onChange={(e) => setEditLine(i, 'description', e.target.value)} /></td>
                                    <td><input type="number" step="0.01" value={l.debit} onChange={(e) => setEditLine(i, 'debit', e.target.value)} style={{ textAlign: 'right' }} /></td>
                                    <td><input type="number" step="0.01" value={l.credit} onChange={(e) => setEditLine(i, 'credit', e.target.value)} style={{ textAlign: 'right' }} /></td>
                                    <td><span style={{ cursor: 'pointer', color: '#b3261e' }} onClick={() => delEditLine(i)}>✕</span></td>
                                  </tr>
                                ))}
                                <tr style={{ fontWeight: 'bold', background: '#eef4fb' }}>
                                  <td style={{ textAlign: 'right' }} colSpan={2}>Totals</td>
                                  <td style={{ textAlign: 'right' }}>{fmt(editDebit)}</td>
                                  <td style={{ textAlign: 'right' }}>{fmt(editCredit)}</td>
                                  <td />
                                </tr>
                              </tbody>
                            </table>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7 }}>
                              <button className="qbd-btn" onClick={addEditLine} disabled={saving}>+ Add Line</button>
                              <span style={{ fontSize: 11, color: editBalanced ? '#2f6b3a' : '#b3261e' }}>
                                {editBalanced ? 'In balance' : `Out of balance ${fmt(editDebit - editCredit)} — debits must equal credits`}
                              </span>
                              <span style={{ flex: 1 }} />
                              <button className="qbd-btn" onClick={cancelEdit} disabled={saving}>Cancel</button>
                              <button className="qbd-btn" style={{ fontWeight: 'bold' }} disabled={saving || !editBalanced} onClick={() => saveEdit(j.id)}>
                                {saving ? 'Saving…' : 'Save corrections'}
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
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
                            <div style={{ marginTop: 7 }}>
                              <button className="qbd-btn" onClick={() => startEdit(j.id, lines)} disabled={busy || saving}>Edit lines…</button>
                              <span className="qbd-muted" style={{ marginLeft: 8, fontSize: 11 }}>Corrects this draft before it posts — accounts, amounts and line memos.</span>
                            </div>
                          </>
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
        <button className="qbd-btn" onClick={expandAll} disabled={busy || !visible.length}>Expand all</button>
        <button className="qbd-btn" onClick={collapseAll} disabled={busy || !openIds.size}>Collapse all</button>
        <button className="qbd-btn" onClick={() => navigate('/')} disabled={busy}>Close</button>
        <button className="qbd-btn" onClick={load} disabled={busy}>Refresh</button>
        <button className="qbd-btn" style={{ fontWeight: 'bold' }} disabled={busy || !selected.length} onClick={postSelected}>
          {busy ? 'Posting…' : `Approve & Post${selected.length ? ` (${selected.length})` : ''}`}
        </button>
      </div>
    </div>
  );
}
