import React, { useEffect, useState, useCallback } from 'react';
import {
  Box, Grid, Paper, Typography, Card, CardContent, Button, Select, MenuItem,
  FormControl, InputLabel, Table, TableBody, TableCell, TableContainer, TableHead,
  TableRow, Chip, CircularProgress, Alert, Dialog, DialogTitle, DialogContent,
  DialogActions, TextField, Stack, Divider, Tooltip, LinearProgress, IconButton
} from '@mui/material';
import {
  CloudSync, Email, UploadFile, ReceiptLong, FileDownload, Link as LinkIcon,
  CheckCircle, Edit, Delete, PostAdd, AddLink
} from '@mui/icons-material';
import { entityAPI, receiptAPI } from '../services/api';

const STATUS_COLORS = {
  PENDING_REVIEW: 'warning',
  REVIEWED: 'info',
  POSTED: 'success',
  EXPORTED: 'secondary',
  REJECTED: 'default',
};

const money = (cents) =>
  (Number(cents || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function Receipts() {
  const [entities, setEntities] = useState([]);
  const [entityId, setEntityId] = useState('ent-ljc');
  const [stats, setStats] = useState(null);
  const [receipts, setReceipts] = useState([]);
  const [connections, setConnections] = useState([]);
  const [providers, setProviders] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const [connectOpen, setConnectOpen] = useState(false);
  const [connectProvider, setConnectProvider] = useState('GMAIL');
  const [connectLabel, setConnectLabel] = useState('');

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadText, setUploadText] = useState('');
  const [uploadName, setUploadName] = useState('');

  const [editReceipt, setEditReceipt] = useState(null);

  const showError = (e) => setError(e?.response?.data?.error || e.message || 'Something went wrong');

  const loadAll = useCallback(async () => {
    if (!entityId) return;
    setLoading(true);
    try {
      const [s, r, c] = await Promise.all([
        receiptAPI.stats(entityId),
        receiptAPI.list(entityId, statusFilter || undefined),
        receiptAPI.listConnections(entityId),
      ]);
      setStats(s.data);
      setReceipts(r.data);
      setConnections(c.data);
    } catch (e) {
      showError(e);
    } finally {
      setLoading(false);
    }
  }, [entityId, statusFilter]);

  useEffect(() => {
    entityAPI.list().then((res) => setEntities(res.data)).catch(() => {});
    receiptAPI.providers().then((res) => setProviders(res.data)).catch(() => {});
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const handleScan = async () => {
    setBusy(true); setError(null); setSuccess(null);
    try {
      const res = await receiptAPI.scan(entityId);
      setSuccess(res.data.message);
      await loadAll();
    } catch (e) { showError(e); } finally { setBusy(false); }
  };

  const handleConnect = async () => {
    setBusy(true); setError(null);
    try {
      await receiptAPI.connect({ entityId, provider: connectProvider, accountLabel: connectLabel || undefined });
      setSuccess(`Connected ${connectProvider}`);
      setConnectOpen(false); setConnectLabel('');
      await loadAll();
    } catch (e) { showError(e); } finally { setBusy(false); }
  };

  const handleDisconnect = async (id) => {
    setBusy(true);
    try { await receiptAPI.disconnect(id); await loadAll(); }
    catch (e) { showError(e); } finally { setBusy(false); }
  };

  const handleUpload = async () => {
    setBusy(true); setError(null);
    try {
      const res = await receiptAPI.upload({ entityId, rawText: uploadText, fileName: uploadName || 'manual-receipt' });
      setSuccess(res.data.status === 'duplicate' ? 'Already imported (duplicate)' : 'Receipt captured and parsed');
      setUploadOpen(false); setUploadText(''); setUploadName('');
      await loadAll();
    } catch (e) { showError(e); } finally { setBusy(false); }
  };

  const handleApprove = async (id) => {
    setBusy(true);
    try { await receiptAPI.approve(id); await loadAll(); }
    catch (e) { showError(e); } finally { setBusy(false); }
  };

  const handleReject = async (id) => {
    setBusy(true);
    try { await receiptAPI.reject(id); await loadAll(); }
    catch (e) { showError(e); } finally { setBusy(false); }
  };

  const handlePost = async (id) => {
    setBusy(true); setError(null);
    try {
      const res = await receiptAPI.post(id);
      setSuccess(`Posted ${res.data.jeNumber} (${res.data.amount}) as draft journal entry`);
      await loadAll();
    } catch (e) { showError(e); } finally { setBusy(false); }
  };

  const handleSaveEdit = async () => {
    setBusy(true); setError(null);
    try {
      await receiptAPI.update(editReceipt.id, {
        vendor: editReceipt.vendor,
        receiptDate: editReceipt.receipt_date,
        category: editReceipt.category,
        subtotalCents: Math.round(Number(editReceipt._subtotal) * 100),
        taxCents: Math.round(Number(editReceipt._tax) * 100),
        totalCents: Math.round(Number(editReceipt._total) * 100),
      });
      setSuccess('Receipt updated and marked reviewed');
      setEditReceipt(null);
      await loadAll();
    } catch (e) { showError(e); } finally { setBusy(false); }
  };

  const handleExport = () => {
    const token = localStorage.getItem('token');
    const url = receiptAPI.exportUrl(entityId, statusFilter || undefined);
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `receipts-${entityId}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(showError);
  };

  const accountingConnections = connections.filter((c) => ['QUICKBOOKS', 'XERO'].includes(c.provider));

  const kpis = [
    { label: 'Total Receipts', value: stats?.total ?? 0, color: '#1976d2' },
    { label: 'Needs Review', value: stats?.pendingReview ?? 0, color: '#f57c00' },
    { label: 'Posted to Ledger', value: stats?.posted ?? 0, color: '#388e3c' },
    { label: 'Total Captured', value: money(stats?.totalCents), color: '#5e35b1', isMoney: true },
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4">Receipt &amp; Invoice Inbox</Typography>
          <Typography color="textSecondary" sx={{ mt: 0.5 }}>
            Automatically collect, parse, and book receipts &amp; invoices for Cohen entities.
          </Typography>
        </Box>
        <FormControl size="small" sx={{ minWidth: 220 }}>
          <InputLabel>Entity</InputLabel>
          <Select label="Entity" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
            {entities.map((e) => (
              <MenuItem key={e.id} value={e.id}>{e.name} ({e.code})</MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      {(busy || loading) && <LinearProgress sx={{ mb: 2 }} />}
      {error && <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 2 }}>{error}</Alert>}
      {success && <Alert severity="success" onClose={() => setSuccess(null)} sx={{ mb: 2 }}>{success}</Alert>}

      {/* KPIs */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        {kpis.map((k) => (
          <Grid item xs={6} md={3} key={k.label}>
            <Card>
              <CardContent>
                <Typography color="textSecondary" gutterBottom variant="body2">{k.label}</Typography>
                <Typography variant="h5" sx={{ color: k.color, fontWeight: 'bold' }}>
                  {k.isMoney ? k.value : k.value}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* Actions */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
          <Button variant="contained" startIcon={<CloudSync />} onClick={handleScan} disabled={busy}>
            Scan Inboxes
          </Button>
          <Button variant="outlined" startIcon={<AddLink />} onClick={() => setConnectOpen(true)} disabled={busy}>
            Connect Account
          </Button>
          <Button variant="outlined" startIcon={<UploadFile />} onClick={() => setUploadOpen(true)} disabled={busy}>
            Upload / Paper Receipt
          </Button>
          <Button variant="outlined" startIcon={<FileDownload />} onClick={handleExport} disabled={busy}>
            Export CSV
          </Button>
        </Stack>
      </Paper>

      {/* Connections */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="h6" sx={{ mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
          <Email fontSize="small" /> Connected Accounts
        </Typography>
        {connections.length === 0 ? (
          <Typography color="textSecondary" variant="body2">
            No connected accounts. Connect Gmail, Outlook, Google Drive, Dropbox, QuickBooks, Xero, or a WhatsApp bot to auto-collect receipts.
          </Typography>
        ) : (
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {connections.map((c) => (
              <Chip
                key={c.id}
                icon={<LinkIcon />}
                label={`${c.providerLabel}${c.account_label ? ` — ${c.account_label}` : ''}`}
                onDelete={() => handleDisconnect(c.id)}
                variant="outlined"
              />
            ))}
          </Stack>
        )}
      </Paper>

      {/* Receipts table */}
      <Paper sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5, gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="h6" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ReceiptLong fontSize="small" /> Collected Receipts
          </Typography>
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel>Status</InputLabel>
            <Select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <MenuItem value="">All</MenuItem>
              <MenuItem value="PENDING_REVIEW">Needs Review</MenuItem>
              <MenuItem value="REVIEWED">Reviewed</MenuItem>
              <MenuItem value="POSTED">Posted</MenuItem>
              <MenuItem value="EXPORTED">Exported</MenuItem>
              <MenuItem value="REJECTED">Rejected</MenuItem>
            </Select>
          </FormControl>
        </Box>

        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ backgroundColor: '#f5f5f5' }}>
                <TableCell>Vendor</TableCell>
                <TableCell>Date</TableCell>
                <TableCell>Category</TableCell>
                <TableCell>Source</TableCell>
                <TableCell align="right">Tax</TableCell>
                <TableCell align="right">Total</TableCell>
                <TableCell align="center">Confidence</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {receipts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    No receipts yet. Click <strong>Scan Inboxes</strong> or <strong>Upload</strong> to get started.
                  </TableCell>
                </TableRow>
              )}
              {receipts.map((r) => {
                const conf = Number(r.confidence_score || 0);
                const low = conf < (stats?.confidenceThreshold ?? 0.85);
                return (
                  <TableRow key={r.id} hover>
                    <TableCell>{r.vendor || <em>Unknown</em>}</TableCell>
                    <TableCell>{r.receipt_date || '—'}</TableCell>
                    <TableCell>{r.category}</TableCell>
                    <TableCell><Chip size="small" label={r.source} variant="outlined" /></TableCell>
                    <TableCell align="right">{money(r.tax_cents)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>{money(r.total_cents)}</TableCell>
                    <TableCell align="center">
                      <Tooltip title={low ? 'Below 0.85 — review recommended' : 'High confidence'}>
                        <Chip size="small" label={conf.toFixed(2)} color={low ? 'warning' : 'success'} />
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={r.status.replace('_', ' ')} color={STATUS_COLORS[r.status] || 'default'} />
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        <Tooltip title="Edit / correct">
                          <span><IconButton size="small" disabled={r.status === 'POSTED'} onClick={() => setEditReceipt({
                            ...r,
                            _subtotal: (r.subtotal_cents / 100).toFixed(2),
                            _tax: (r.tax_cents / 100).toFixed(2),
                            _total: (r.total_cents / 100).toFixed(2),
                          })}><Edit fontSize="small" /></IconButton></span>
                        </Tooltip>
                        {r.status === 'PENDING_REVIEW' && (
                          <Tooltip title="Approve">
                            <IconButton size="small" color="info" onClick={() => handleApprove(r.id)}><CheckCircle fontSize="small" /></IconButton>
                          </Tooltip>
                        )}
                        {r.status !== 'POSTED' && r.status !== 'REJECTED' && (
                          <Tooltip title="Post to ledger (draft JE)">
                            <IconButton size="small" color="success" onClick={() => handlePost(r.id)}><PostAdd fontSize="small" /></IconButton>
                          </Tooltip>
                        )}
                        {accountingConnections.length > 0 && r.status !== 'REJECTED' && (
                          <Tooltip title={`Sync to ${accountingConnections[0].providerLabel}`}>
                            <IconButton size="small" color="secondary" onClick={() => receiptAPI.sync(r.id, accountingConnections[0].id).then(() => { setSuccess('Synced'); loadAll(); }).catch(showError)}><CloudSync fontSize="small" /></IconButton>
                          </Tooltip>
                        )}
                        {r.status !== 'POSTED' && (
                          <Tooltip title="Reject">
                            <IconButton size="small" color="error" onClick={() => handleReject(r.id)}><Delete fontSize="small" /></IconButton>
                          </Tooltip>
                        )}
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Connect dialog */}
      <Dialog open={connectOpen} onClose={() => setConnectOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Connect an Account</DialogTitle>
        <DialogContent>
          <FormControl fullWidth sx={{ mt: 1 }}>
            <InputLabel>Provider</InputLabel>
            <Select label="Provider" value={connectProvider} onChange={(e) => setConnectProvider(e.target.value)}>
              {providers.map((p) => (
                <MenuItem key={p.provider} value={p.provider}>
                  {p.label} {p.configured ? '' : '(sandbox)'}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            fullWidth sx={{ mt: 2 }} label="Account label (optional)"
            placeholder="e.g. ar@cohenentities.com"
            value={connectLabel} onChange={(e) => setConnectLabel(e.target.value)}
          />
          <Typography variant="caption" color="textSecondary" sx={{ mt: 1, display: 'block' }}>
            Sandbox providers return sample receipts so you can test the full pipeline. Add provider OAuth keys on the server to enable live syncing.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConnectOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleConnect} disabled={busy}>Connect</Button>
        </DialogActions>
      </Dialog>

      {/* Upload dialog */}
      <Dialog open={uploadOpen} onClose={() => setUploadOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Upload Paper / Digital Receipt</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
            Paste the receipt/invoice text (e.g. from your scanner's OCR or an email). The AI parser extracts the vendor, date, total and tax, and masks sensitive data.
          </Typography>
          <TextField fullWidth label="File name (optional)" value={uploadName} onChange={(e) => setUploadName(e.target.value)} sx={{ mb: 2 }} />
          <TextField
            fullWidth multiline minRows={6} label="Receipt text"
            placeholder={'Acme Coffee\\n2024-03-10\\nLatte 4.50\\nTax 0.37\\nTotal $4.87'}
            value={uploadText} onChange={(e) => setUploadText(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUploadOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleUpload} disabled={busy || !uploadText.trim()}>Parse &amp; Capture</Button>
        </DialogActions>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={Boolean(editReceipt)} onClose={() => setEditReceipt(null)} fullWidth maxWidth="sm">
        <DialogTitle>Review &amp; Correct Receipt</DialogTitle>
        {editReceipt && (
          <DialogContent>
            <Grid container spacing={2} sx={{ mt: 0 }}>
              <Grid item xs={12} sm={6}>
                <TextField fullWidth label="Vendor" value={editReceipt.vendor || ''} onChange={(e) => setEditReceipt({ ...editReceipt, vendor: e.target.value })} />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField fullWidth label="Date" type="date" InputLabelProps={{ shrink: true }} value={editReceipt.receipt_date || ''} onChange={(e) => setEditReceipt({ ...editReceipt, receipt_date: e.target.value })} />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField fullWidth label="Category" value={editReceipt.category || ''} onChange={(e) => setEditReceipt({ ...editReceipt, category: e.target.value })} />
              </Grid>
              <Grid item xs={6} sm={2}>
                <TextField fullWidth label="Subtotal" value={editReceipt._subtotal} onChange={(e) => setEditReceipt({ ...editReceipt, _subtotal: e.target.value })} />
              </Grid>
              <Grid item xs={6} sm={2}>
                <TextField fullWidth label="Tax" value={editReceipt._tax} onChange={(e) => setEditReceipt({ ...editReceipt, _tax: e.target.value })} />
              </Grid>
              <Grid item xs={6} sm={2}>
                <TextField fullWidth label="Total" value={editReceipt._total} onChange={(e) => setEditReceipt({ ...editReceipt, _total: e.target.value })} />
              </Grid>
            </Grid>
            <Divider sx={{ my: 2 }} />
            <Typography variant="caption" color="textSecondary">Extracted text (PII masked)</Typography>
            <Paper variant="outlined" sx={{ p: 1.5, mt: 0.5, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12 }}>
              {editReceipt.raw_text || '—'}
            </Paper>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setEditReceipt(null)}>Cancel</Button>
          <Button variant="contained" onClick={handleSaveEdit} disabled={busy}>Save &amp; Mark Reviewed</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
