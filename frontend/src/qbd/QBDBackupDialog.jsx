import React, { useEffect, useState, useCallback } from 'react';
import { backupAPI } from '../services/api';

function fmtWhen(iso) {
  if (!iso) return 'Never';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function QBDBackupDialog({ open, onClose, showToast, onStatusChange }) {
  const [busy, setBusy] = useState(false);
  const [backups, setBackups] = useState([]);
  const [status, setStatus] = useState(null);

  const load = useCallback(() => {
    if (!open) return;
    backupAPI.list(30)
      .then((r) => {
        setBackups(r.data.backups || []);
        setStatus(r.data);
      })
      .catch((e) => showToast && showToast('Could not load backups: ' + (e.response?.data?.error || e.message)));
  }, [open, showToast]);

  useEffect(() => { load(); }, [load]);

  if (!open) return null;

  const runBackup = () => {
    setBusy(true);
    backupAPI.run()
      .then((r) => {
        showToast && showToast(r.data.message || 'Backup complete ✓');
        load();
        onStatusChange && onStatusChange();
      })
      .catch((e) => showToast && showToast('Backup failed: ' + (e.response?.data?.error || e.message)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="qbd-modal-backdrop" onClick={onClose}>
      <div className="qbd-modal qbd-backup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qbd-wtitle">
          Company Backups
          <span className="x" onClick={onClose}>✕</span>
        </div>
        <div className="qbd-backup-meta">
          <div><span className="lbl">Auto backup</span> every {status?.intervalMinutes || 60} min</div>
          <div><span className="lbl">Last backup</span> {fmtWhen(status?.lastBackupAt)}</div>
          <div><span className="lbl">Stored</span> {status?.backupCount ?? 0} (keep {status?.retentionCount ?? 30})</div>
        </div>
        <div className="qbd-backup-actions">
          <button className="qbd-btn" disabled={busy} onClick={runBackup} style={{ fontWeight: 'bold' }}>
            {busy ? 'Backing up…' : 'Back Up Now'}
          </button>
          <button className="qbd-btn" onClick={load}>Refresh</button>
        </div>
        <div className="qbd-modal-body">
          {backups.length === 0 ? (
            <div className="qbd-empty">No backups yet — auto backup runs after startup and hourly.</div>
          ) : (
            <table className="qbd-reg">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>File</th>
                  <th className="qbd-amt">Size</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.id || b.filename}>
                    <td className="qbd-d">{fmtWhen(b.createdAt)}</td>
                    <td>{b.reason === 'auto' ? 'Auto' : 'Manual'}</td>
                    <td style={{ fontSize: 11 }}>{b.filename}</td>
                    <td className="qbd-amt">{b.sizeLabel || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="qbd-foot">
          <span className="qbd-muted">Backups saved server-side in db/backups/</span>
          <span className="sp" />
          <button className="qbd-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export function formatBackupShort(iso) {
  if (!iso) return 'No backup yet';
  try {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return 'No backup yet';
  }
}

export function useBackupStatus() {
  const [info, setInfo] = useState(null);

  const refresh = useCallback(() => {
    backupAPI.status()
      .then((r) => setInfo(r.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60000);
    return () => clearInterval(id);
  }, [refresh]);

  return { info, refresh };
}
