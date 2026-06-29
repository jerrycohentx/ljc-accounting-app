import React, { useEffect, useState, useCallback } from 'react';
import {
  Box, Divider, Typography, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, CircularProgress, Alert,
} from '@mui/material';
import { backupAPI } from '../services/api';
import { fmtDateTime } from './AppStatusPanel';

function fmtShort(iso) {
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

function MetaRow({ label, value, warn }) {
  return (
    <Box sx={{ display: 'flex', gap: 1, py: 0.35, fontSize: 13, lineHeight: 1.4 }}>
      <Typography component="span" variant="body2" color="text.secondary" sx={{ minWidth: 108, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography
        component="span"
        variant="body2"
        sx={{ fontWeight: 600, color: warn ? 'warning.dark' : 'text.primary', wordBreak: 'break-word' }}
      >
        {value ?? '—'}
      </Typography>
    </Box>
  );
}

export default function LoginStatusPanel() {
  const [status, setStatus] = useState(null);
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    Promise.all([
      backupAPI.status().then((r) => r.data).catch(() =>
        fetch('/health').then((r) => r.json())
      ),
      backupAPI.list(15).then((r) => r.data).catch(() => ({ backups: [] })),
    ])
      .then(([statusData, listData]) => {
        setStatus(statusData);
        setBackups(listData.backups || []);
      })
      .catch(() => setError('Could not load system status'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);

  const app = status?.app || {};
  const backup = status?.backup || {};
  const db = typeof status?.database === 'string'
    ? { label: status.database === 'postgres' ? 'PostgreSQL (cloud)' : 'SQLite (local)' }
    : status?.database || {};
  const versionLabel = app.buildLabel || `v${app.version || status?.version || '0.1.0'}`;
  const buildSha = app.gitSha || status?.gitSha || 'local';
  const lastBackupAt = backup.lastBackupAt || status?.lastBackupAt;

  return (
    <Box sx={{ mt: 3 }}>
      <Divider sx={{ mb: 2 }} />
      <Typography variant="subtitle2" sx={{ fontWeight: 700, letterSpacing: 0.4, mb: 1.5 }}>
        System version &amp; backup history
      </Typography>

      {loading && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1 }}>
          <CircularProgress size={18} />
          <Typography variant="body2" color="text.secondary">Loading status…</Typography>
        </Box>
      )}

      {error && <Alert severity="warning" sx={{ mb: 1.5 }}>{error}</Alert>}

      {!loading && status && (
        <>
          <Box sx={{ mb: 2 }}>
            <MetaRow label="Version" value={versionLabel} />
            <MetaRow label="Build" value={buildSha} />
            <MetaRow label="Environment" value={app.nodeEnv || 'production'} />
            <MetaRow label="Database" value={db.label || '—'} />
            <MetaRow
              label="Last backup"
              value={fmtDateTime(lastBackupAt)}
              warn={!lastBackupAt}
            />
            <MetaRow
              label="Auto backup"
              value={`Every ${backup.intervalMinutes ?? 60} min · keep ${backup.retentionCount ?? 30}`}
            />
            {backup.lastBackup?.filename && (
              <MetaRow
                label="Latest file"
                value={`${backup.lastBackup.filename}${backup.lastBackup.sizeLabel ? ` (${backup.lastBackup.sizeLabel})` : ''}`}
              />
            )}
            {backup.lastBackupError && (
              <MetaRow label="Alert" value={backup.lastBackupError} warn />
            )}
          </Box>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
            Recent backups
          </Typography>
          <TableContainer sx={{ maxHeight: 220, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700, py: 0.75 }}>When</TableCell>
                  <TableCell sx={{ fontWeight: 700, py: 0.75 }}>Type</TableCell>
                  <TableCell sx={{ fontWeight: 700, py: 0.75 }}>File</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, py: 0.75 }}>Size</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {backups.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} sx={{ py: 2, color: 'text.secondary', fontSize: 13 }}>
                      No backups yet — auto backup runs after startup and hourly.
                    </TableCell>
                  </TableRow>
                ) : (
                  backups.map((b) => (
                    <TableRow key={b.id || b.filename} hover>
                      <TableCell sx={{ py: 0.6, fontSize: 12, whiteSpace: 'nowrap' }}>
                        {fmtShort(b.createdAt)}
                      </TableCell>
                      <TableCell sx={{ py: 0.6, fontSize: 12 }}>
                        {b.reason === 'auto' ? 'Auto' : 'Manual'}
                      </TableCell>
                      <TableCell sx={{ py: 0.6, fontSize: 11, wordBreak: 'break-all' }}>
                        {b.filename}
                      </TableCell>
                      <TableCell align="right" sx={{ py: 0.6, fontSize: 12, whiteSpace: 'nowrap' }}>
                        {b.sizeLabel || '—'}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}
    </Box>
  );
}
