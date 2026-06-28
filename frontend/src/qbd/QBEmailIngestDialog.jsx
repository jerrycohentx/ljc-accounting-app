import React, { useEffect, useState, useCallback } from 'react';
import { gmailAPI, emailIngestAPI } from '../services/api';

function fmtWhen(iso) {
  if (!iso) return 'Never';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function QBEmailIngestDialog({ open, onClose, showToast, onStatusChange }) {
  const [busy, setBusy] = useState(false);
  const [gmail, setGmail] = useState(null);
  const [ingest, setIngest] = useState(null);

  const load = useCallback(() => {
    if (!open) return;
    Promise.all([gmailAPI.status(), emailIngestAPI.status()])
      .then(([g, i]) => { setGmail(g.data); setIngest(i.data); })
      .catch((e) => showToast && showToast('Could not load email status: ' + (e.response?.data?.error || e.message)));
  }, [open, showToast]);

  useEffect(() => { load(); }, [load]);

  if (!open) return null;

  const connect = (user, label) => {
    setBusy(true);
    gmailAPI.authUrl(user, label)
      .then((r) => {
        window.open(r.data.authUrl, '_blank', 'width=520,height=640');
        showToast && showToast(`Sign in to ${user} in the new window`);
      })
      .catch((e) => showToast && showToast(e.response?.data?.error || e.message))
      .finally(() => setBusy(false));
  };

  const scanNow = () => {
    setBusy(true);
    emailIngestAPI.run()
      .then((r) => {
        showToast && showToast(r.data.message || 'Email scan complete ✓');
        load();
        onStatusChange && onStatusChange();
      })
      .catch((e) => showToast && showToast('Scan failed: ' + (e.response?.data?.error || e.message)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="qbd-modal-backdrop" onClick={onClose}>
      <div className="qbd-modal qbd-backup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qbd-wtitle">
          Bank statement email
          <span className="x" onClick={onClose}>✕</span>
        </div>
        <div className="qbd-backup-meta">
          <div><span className="lbl">Auto scan</span> every {ingest?.intervalHours || 6} hours</div>
          <div><span className="lbl">Last scan</span> {fmtWhen(ingest?.lastRunAt)}</div>
          {ingest?.graphConfigured && (
            <div><span className="lbl">jerry@ mailbox</span> {ingest.graphMailbox} (Microsoft — server configured)</div>
          )}
        </div>

        <div className="qbd-modal-body" style={{ padding: '8px 12px' }}>
          <div className="fhd" style={{ fontSize: 11, marginBottom: 8 }}>Gmail — click Connect once per account</div>
          {!gmail?.configured && (
            <div className="qbd-muted" style={{ marginBottom: 8, fontSize: 11 }}>
              Gmail OAuth keys not on server yet — your agent will add them on Render.
            </div>
          )}
          {(gmail?.accounts || []).map((acc) => (
            <div key={acc.user} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 11 }}>
              <span style={{ flex: 1 }}>{acc.user}</span>
              <span className={acc.connected ? 'qbd-pill' : 'qbd-muted'}>
                {acc.connected ? 'Connected ✓' : 'Not connected'}
              </span>
              {!acc.connected && gmail?.configured && (
                <button className="qbd-btn" disabled={busy} onClick={() => connect(acc.user, acc.label)}>Connect</button>
              )}
            </div>
          ))}

          {(ingest?.recentImports || []).length > 0 && (
            <>
              <div className="fhd" style={{ fontSize: 11, margin: '12px 0 6px' }}>Recent imports</div>
              <table className="qbd-reg">
                <thead>
                  <tr><th>When</th><th>Subject</th><th>Result</th></tr>
                </thead>
                <tbody>
                  {ingest.recentImports.slice(0, 5).map((row) => (
                    <tr key={row.message_id}>
                      <td className="qbd-d">{fmtWhen(row.processed_at)}</td>
                      <td style={{ fontSize: 10 }}>{(row.subject || '').slice(0, 40)}</td>
                      <td style={{ fontSize: 10 }}>{row.result_summary || row.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        <div className="qbd-backup-actions">
          <button className="qbd-btn" disabled={busy} onClick={scanNow} style={{ fontWeight: 'bold' }}>
            {busy ? 'Scanning…' : 'Scan email now'}
          </button>
          <button className="qbd-btn" onClick={load}>Refresh</button>
        </div>

        <div className="qbd-foot">
          <span className="qbd-muted">Statements import automatically → Reconcile</span>
          <span className="sp" />
          <button className="qbd-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export function formatEmailScanShort(iso) {
  if (!iso) return 'Not scanned yet';
  try {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return 'Not scanned yet';
  }
}

export function useEmailIngestStatus() {
  const [info, setInfo] = useState(null);
  const refresh = useCallback(() => {
    emailIngestAPI.status().then((r) => setInfo(r.data)).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 120000);
    return () => clearInterval(id);
  }, [refresh]);
  return { info, refresh };
}
