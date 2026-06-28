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

function ConnectRow({ acc, busy, gmailConfigured, onOAuth, onImap, showToast }) {
  const [showPassword, setShowPassword] = useState(false);
  const [appPassword, setAppPassword] = useState('');
  const isGmail = /@gmail\.com$|@googlemail\.com$/i.test(acc.user);

  if (acc.connected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 11 }}>
        <span style={{ flex: 1 }}>{acc.user}</span>
        {acc.graphManaged && <span className="qbd-muted">Microsoft (auto)</span>}
        <span className="qbd-pill">Connected ✓</span>
      </div>
    );
  }

  if (acc.graphManaged) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 11 }}>
        <span style={{ flex: 1 }}>{acc.user}</span>
        <span className="qbd-muted">Microsoft — connecting on server</span>
      </div>
    );
  }

  const submitPassword = () => {
    if (!appPassword.trim()) {
      showToast && showToast('Paste the app password');
      return;
    }
    onImap(acc, appPassword.trim());
    setShowPassword(false);
    setAppPassword('');
  };

  const passwordHint = isGmail
    ? 'Google Account → Security → App passwords → create “Mail” → paste below.'
    : 'Microsoft 365 → Security → App password (or use your mailbox app password) → paste below.';

  return (
    <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid #e8ecf0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
        <span style={{ flex: 1 }}>{acc.user}</span>
        <span className="qbd-muted">Not connected</span>
        {gmailConfigured && (
          <button type="button" className="qbd-btn" disabled={busy} onClick={() => onOAuth(acc)}>
            Connect with Google
          </button>
        )}
        <button
          type="button"
          className="qbd-btn qbd-btn-import"
          disabled={busy}
          onClick={() => setShowPassword((v) => !v)}
        >
          Connect
        </button>
      </div>
      {showPassword && (
        <div style={{ marginTop: 8, fontSize: 11 }}>
          <div className="qbd-muted" style={{ marginBottom: 6, lineHeight: 1.4 }}>
            {passwordHint}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="password"
              value={appPassword}
              onChange={(e) => setAppPassword(e.target.value)}
              placeholder="xxxx xxxx xxxx xxxx"
              style={{ flex: 1, fontSize: 11, padding: '4px 6px' }}
            />
            <button type="button" className="qbd-btn" disabled={busy} onClick={submitPassword}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function QBEmailIngestDialog({ open, onClose, showToast, onStatusChange }) {
  const [busy, setBusy] = useState(false);
  const [gmail, setGmail] = useState(null);
  const [ingest, setIngest] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newEmail, setNewEmail] = useState('');

  const load = useCallback(() => {
    if (!open) return;
    Promise.all([gmailAPI.status(), emailIngestAPI.status()])
      .then(([g, i]) => { setGmail(g.data); setIngest(i.data); })
      .catch((e) => showToast && showToast('Could not load email status: ' + (e.response?.data?.error || e.message)));
  }, [open, showToast]);

  useEffect(() => { load(); }, [load]);

  if (!open) return null;

  const connectOAuth = (acc) => {
    setBusy(true);
    gmailAPI.authUrl(acc.user, acc.label)
      .then((r) => {
        window.open(r.data.authUrl, '_blank', 'width=520,height=640');
        showToast && showToast(`Sign in to ${acc.user} in the new window, then click Refresh`);
      })
      .catch((e) => showToast && showToast(e.response?.data?.error || e.message))
      .finally(() => setBusy(false));
  };

  const connectImap = (acc, password) => {
    setBusy(true);
    gmailAPI.imapConnect({ user: acc.user, password, label: acc.label })
      .then((r) => {
        showToast && showToast(r.data.message || 'Email connected ✓');
        load();
        onStatusChange && onStatusChange();
        emailIngestAPI.run().catch(() => {});
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
        </div>

        <div className="qbd-modal-body" style={{ padding: '8px 12px' }}>
          <div className="fhd" style={{ fontSize: 11, marginBottom: 8 }}>Click Connect for each Gmail account (one time)</div>
          {(gmail?.accounts || []).map((acc) => (
            <ConnectRow
              key={acc.user}
              acc={acc}
              busy={busy}
              gmailConfigured={!!gmail?.configured}
              onOAuth={connectOAuth}
              onImap={connectImap}
              showToast={showToast}
            />
          ))}

          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #c9d3df' }}>
            {!showAdd ? (
              <button type="button" className="qbd-btn" onClick={() => setShowAdd(true)}>+ Add email address</button>
            ) : (
              <div style={{ fontSize: 11 }}>
                <div className="fhd" style={{ fontSize: 11, marginBottom: 6 }}>Add another mailbox</div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="name@company.com"
                    style={{ flex: 1, fontSize: 11, padding: '4px 6px' }}
                  />
                  <button
                    type="button"
                    className="qbd-btn qbd-btn-import"
                    disabled={busy || !newEmail.includes('@')}
                    onClick={() => {
                      const user = newEmail.trim().toLowerCase();
                      if (!user.includes('@')) return;
                      const exists = (gmail?.accounts || []).some((a) => a.user === user);
                      if (exists) {
                        showToast && showToast('That email is already in the list — click Connect next to it');
                        return;
                      }
                      setGmail((g) => ({
                        ...g,
                        accounts: [...(g?.accounts || []), { user, label: user.split('@')[0], connected: false }],
                      }));
                      setNewEmail('');
                      setShowAdd(false);
                    }}
                  >
                    Add
                  </button>
                  <button type="button" className="qbd-btn" onClick={() => { setShowAdd(false); setNewEmail(''); }}>Cancel</button>
                </div>
                <div className="qbd-muted">Then click Connect and paste the app password for that mailbox.</div>
              </div>
            )}
          </div>

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
