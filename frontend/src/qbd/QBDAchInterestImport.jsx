import React, { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { achJeAPI } from '../services/api';
import { fmt } from './helpers';

/**
 * Import the monthly "interest due" JE that the loan-servicing app exports as a
 * QBO-style CSV (QBO_ACH_JE_<YYYY-MM>.csv). Upload -> preview the balanced JE ->
 * post to the GL. Idempotent: re-importing the same month never duplicates.
 */
export default function QBDAchInterestImport() {
  const { entityId } = useEntity();
  const { showToast } = useOutletContext() || {};
  const [fileName, setFileName] = useState('');
  const [csvContent, setCsvContent] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => { setPreview(null); setResult(null); setError(''); };

  const onFile = (e) => {
    const f = e.target.files?.[0];
    reset();
    setCsvContent('');
    setFileName('');
    if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => setCsvContent(String(reader.result || ''));
    reader.onerror = () => setError('Could not read the file.');
    reader.readAsText(f);
  };

  const doPreview = async () => {
    if (!csvContent) { setError('Choose a QBO_ACH_JE CSV file first.'); return; }
    setBusy(true); setError(''); setResult(null);
    try {
      const r = await achJeAPI.preview({ csvContent, fileName, entityId });
      setPreview(r.data);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const doPost = async () => {
    setBusy(true); setError('');
    try {
      const r = await achJeAPI.commit({ csvContent, fileName, entityId });
      setResult(r.data);
      if (r.data.skipped) showToast?.('Already imported — no duplicate created ✓');
      else showToast?.(`Posted ${r.data.jeNumber} ✓`);
      const pr = await achJeAPI.preview({ csvContent, fileName, entityId });
      setPreview(pr.data);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const badge = (text, color) => (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 12,
      fontWeight: 600, color: '#fff', background: color, marginLeft: 8,
    }}>{text}</span>
  );

  return (
    <div className="qbd-wbody" style={{ padding: 16, overflowX: 'hidden', maxWidth: '100%' }}>
      <h2 style={{ margin: '0 0 4px' }}>Import Monthly ACH Interest JE</h2>
      <div style={{ color: '#555', marginBottom: 14, fontSize: 13 }}>
        Upload the loan-servicing export <code>QBO_ACH_JE_&lt;YYYY-MM&gt;.csv</code>, review the
        balanced journal entry, then post it to {entityId}. Re-importing the same month is safe —
        it will not create a duplicate.
      </div>

      <div style={{
        display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        background: '#f3f6fb', border: '1px solid #d6e0ee', borderRadius: 6, padding: 12,
      }}>
        <input type="file" accept=".csv,text/csv" onChange={onFile} />
        <button type="button" onClick={doPreview} disabled={busy || !csvContent}>
          {busy ? 'Working…' : 'Preview'}
        </button>
        {preview && (
          <button
            type="button"
            onClick={doPost}
            disabled={busy || !preview.canPost}
            style={{ fontWeight: 600 }}
            title={preview.canPost ? 'Post the balanced JE to the GL' : 'Cannot post — see status below'}
          >
            Post to GL
          </button>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 14, padding: 10, background: '#fdecea', border: '1px solid #f5c2c0', borderRadius: 6, color: '#a3261d' }}>
          {error}
        </div>
      )}

      {preview && (
        <div style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 8, fontSize: 14 }}>
            <strong>JE {preview.jeNumber}</strong> · {preview.postingDate || preview.yearMonth}
            {preview.balanced
              ? badge('Balanced', '#2e7d32')
              : badge('Out of balance', '#c62828')}
            {preview.alreadyImported && (
              preview.existingStatus === 'POSTED'
                ? badge('Already posted', '#6a1b9a')
                : badge('Prior draft will be replaced', '#ef6c00')
            )}
            {preview.unmapped?.length > 0 && badge(`${preview.unmapped.length} unmapped`, '#c62828')}
          </div>

          <table className="qbd-jt" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', maxWidth: '100%' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '2px solid #ccc' }}>
                <th style={{ padding: '6px 8px' }}>Source account (CSV)</th>
                <th style={{ padding: '6px 8px' }}>Mapped GL account</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', width: 120, whiteSpace: 'nowrap' }}>Debit</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', width: 120, whiteSpace: 'nowrap' }}>Credit</th>
              </tr>
            </thead>
            <tbody>
              {preview.lines.map((l, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #eee', background: l.accountId ? 'transparent' : '#fff6f6' }}>
                  <td style={{ padding: '6px 8px', overflowWrap: 'anywhere' }}>{l.sourceAccountName}</td>
                  <td style={{ padding: '6px 8px', overflowWrap: 'anywhere' }}>
                    {l.accountId
                      ? `${l.mappedAccountNumber} · ${l.mappedAccountName}`
                      : <span style={{ color: '#c62828', fontWeight: 600 }}>UNMAPPED — needs review</span>}
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>{Number(l.debit) ? fmt(l.debit) : ''}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>{Number(l.credit) ? fmt(l.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid #ccc', fontWeight: 700 }}>
                <td style={{ padding: '6px 8px' }} colSpan={2}>Totals</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>{fmt(preview.totalDebit)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>{fmt(preview.totalCredit)}</td>
              </tr>
            </tfoot>
          </table>

          {preview.unmapped?.length > 0 && (
            <div style={{ marginTop: 12, padding: 10, background: '#fff8e1', border: '1px solid #ffe0a3', borderRadius: 6, fontSize: 13 }}>
              <strong>Cannot post yet.</strong> These CSV accounts aren’t mapped to the chart of
              accounts (they will not be plugged to a catch-all): {preview.unmapped.map((u) => u.sourceAccountName).join('; ')}.
              Add a mapping in <code>lib/ach-je-import.js</code> and re-preview.
            </div>
          )}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 14, padding: 10, background: '#e8f5e9', border: '1px solid #b6dcb9', borderRadius: 6, fontSize: 13 }}>
          {result.posted
            ? <>Posted <strong>{result.jeNumber}</strong> (JE id <code>{result.jeId}</code>) — {result.lineCount} lines, {fmt(result.totalDebit)} dated {result.postingDate}.</>
            : <>Already imported — <strong>{result.jeNumber}</strong> was found posted, so no duplicate was created.</>}
        </div>
      )}
    </div>
  );
}
