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

function SummaryChip({ children, warn, onClick }) {
  const cls = ['ljc-status-chip', warn ? 'warn' : '', onClick ? 'clickable' : ''].filter(Boolean).join(' ');
  return (
    <span
      className={cls}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(e); } : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {children}
    </span>
  );
}

export default function AppStatusPanel({
  data,
  onBackupClick,
  onEmailClick,
  defaultCollapsed = true,
}) {
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const s = normalizeStatus(data);

  const stop = (fn) => (e) => {
    e.stopPropagation();
    fn?.(e);
  };

  if (!s) {
    return (
      <div className="ljc-status-panel collapsed">
        <div className="ljc-status-head">
          <div className="ljc-status-title">System Status</div>
          <div className="ljc-status-loading">Loading…</div>
        </div>
      </div>
    );
  }

  const { app, backup, email, db } = s;
  const backupFile = backup.lastBackup?.filename;
  const backupSize = backup.lastBackup?.sizeLabel;
  const emailLabel = email.lastRunAt ? fmtShortDate(email.lastRunAt) : 'Not scanned yet';
  const versionLabel = app.buildLabel || `v${app.version || '0.1.0'}`;
  const ok = !backup.lastBackupError;

  return (
    <div className={`ljc-status-panel${expanded ? ' expanded' : ' collapsed'}`}>
      <div
        className="ljc-status-head expandable"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? 'Collapse system status' : 'Expand system status'}
      >
        <div className="ljc-status-title">System Status</div>
        {!expanded && (
          <div className="ljc-status-bar">
            <SummaryChip>{versionLabel}</SummaryChip>
            <SummaryChip>{app.nodeEnv || 'production'}</SummaryChip>
            <SummaryChip>{db.label || '—'}</SummaryChip>
            <SummaryChip warn={!backup.lastBackupAt} onClick={stop(onBackupClick)}>
              Backup: {fmtShortDate(backup.lastBackupAt)}
            </SummaryChip>
            <SummaryChip warn={!email.lastRunAt} onClick={stop(onEmailClick)}>
              Email: {emailLabel}
            </SummaryChip>
            <SummaryChip warn={!ok}>{ok ? 'OK' : 'Alert'}</SummaryChip>
          </div>
        )}
        <span className="ljc-status-chevron" aria-hidden>{expanded ? '▾' : '▴'}</span>
      </div>

      {expanded && (
        <div className="ljc-status-grid">
          <StatusCell label="Version" value={versionLabel} />
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
            label="Latest File"
            value={backupFile ? `${backupFile}${backupSize ? ` (${backupSize})` : ''}` : 'None yet'}
          />
          <StatusCell
            label="Stored"
            value={`${backup.backupCount ?? 0} (keep ${backup.retentionCount ?? 30})`}
          />
          <StatusCell
            label="Auto Backup"
            value={`Every ${backup.intervalMinutes ?? 60} min`}
          />

          <StatusCell
            label="Email Scan"
            value={emailLabel}
            warn={!email.lastRunAt}
            onClick={onEmailClick}
          />
          <StatusCell
            label="Email Auto"
            value={`Every ${email.intervalHours ?? 6} h`}
          />
          <StatusCell
            label="Server"
            value={fmtDateTime(app.startedAt)}
          />
          {backup.lastBackupError ? (
            <StatusCell label="Alert" value={backup.lastBackupError} warn />
          ) : (
            <StatusCell label="Status" value="OK" />
          )}
        </div>
      )}
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
