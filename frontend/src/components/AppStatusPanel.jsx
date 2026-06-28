import React, { useEffect, useState, useCallback } from 'react';
import './AppStatusPanel.css';

export function fmtDateTime(iso) {
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
    return 'Never';
  }
}

function fmtShortDate(iso) {
  if (!iso) return 'Never';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return 'Never';
  }
}

function normalizeStatus(raw) {
  if (!raw) return null;
  const app = typeof raw.app === 'string'
    ? { buildLabel: raw.app, version: raw.version, gitSha: raw.gitSha }
    : raw.app || {};
  const backup = raw.backup || {
    lastBackupAt: raw.lastBackupAt,
    intervalMinutes: 60,
    retentionCount: 30,
    backupCount: 0,
    lastBackup: null,
    lastBackupError: null,
  };
  const email = raw.statementEmailIngest || {};
  const db = typeof raw.database === 'string'
    ? { label: raw.database === 'postgres' ? 'PostgreSQL (cloud)' : 'SQLite (local)' }
    : raw.database || {};

  return { app, backup, email, db };
}

function StatusCell({ label, value, warn, onClick }) {
  const cls = ['ljc-status-cell', warn ? 'warn' : '', onClick ? 'clickable' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} onClick={onClick} role={onClick ? 'button' : undefined}>
      <span className="lbl">{label}</span>
      <span className="val">{value ?? '—'}</span>
    </div>
  );
}

export default function AppStatusPanel({ data, onBackupClick, onEmailClick, compact }) {
  const s = normalizeStatus(data);
  if (!s) {
    return (
      <div className={`ljc-status-panel${compact ? ' compact' : ''}`}>
        <div className="ljc-status-title">System Status</div>
        <div className="ljc-status-loading">Loading…</div>
      </div>
    );
  }

  const { app, backup, email, db } = s;
  const backupFile = backup.lastBackup?.filename;
  const backupSize = backup.lastBackup?.sizeLabel;
  const emailLabel = email.lastRunAt ? fmtShortDate(email.lastRunAt) : 'Not scanned yet';

  return (
    <div className={`ljc-status-panel${compact ? ' compact' : ''}`}>
      <div className="ljc-status-title">System Status</div>
      <div className="ljc-status-grid">
        <StatusCell label="Version" value={app.buildLabel || `v${app.version || '0.1.0'}`} />
        <StatusCell label="Build" value={app.gitSha || 'local'} />
        <StatusCell label="Environment" value={app.nodeEnv || 'production'} />
        <StatusCell label="Database" value={db.label || '—'} />

        <StatusCell
          label="Last Backup"
          value={fmtDateTime(backup.lastBackupAt)}
          warn={!backup.lastBackupAt}
          onClick={onBackupClick}
        />
        <StatusCell
          label="Latest Backup File"
          value={backupFile ? `${backupFile}${backupSize ? ` (${backupSize})` : ''}` : 'None yet'}
        />
        <StatusCell
          label="Backups Stored"
          value={`${backup.backupCount ?? 0} (keep ${backup.retentionCount ?? 30})`}
        />
        <StatusCell
          label="Auto Backup"
          value={`Every ${backup.intervalMinutes ?? 60} minutes`}
        />

        <StatusCell
          label="Email Last Scan"
          value={emailLabel}
          warn={!email.lastRunAt}
          onClick={onEmailClick}
        />
        <StatusCell
          label="Email Auto Scan"
          value={`Every ${email.intervalHours ?? 6} hours`}
        />
        <StatusCell
          label="Server Started"
          value={fmtDateTime(app.startedAt)}
        />
        {backup.lastBackupError ? (
          <StatusCell label="Backup Alert" value={backup.lastBackupError} warn />
        ) : (
          <StatusCell label="Status" value="OK" />
        )}
      </div>
    </div>
  );
}

export function useServerStatus(pollMs = 60000) {
  const [data, setData] = useState(null);

  const refresh = useCallback(() => {
    const token = localStorage.getItem('token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    fetch('/api/backup/status', { headers })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => {
        fetch('/health')
          .then((r) => r.json())
          .then(setData)
          .catch(() => {});
      });
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  return { data, refresh };
}
