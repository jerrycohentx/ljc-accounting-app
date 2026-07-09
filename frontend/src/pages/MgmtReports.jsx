import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Box, Paper, Typography, Button, Select, MenuItem, FormControl, InputLabel,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Chip,
  CircularProgress, Alert, Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, Stack, IconButton, Tooltip,
} from '@mui/material';
import { UploadFile, CheckCircle, PostAdd, Delete, Edit, AttachFile } from '@mui/icons-material';
import { entityAPI, mgmtReportAPI } from '../services/api';

const STATUS_COLORS = {
  PENDING_REVIEW: 'warning',
  REVIEWED: 'info',
  DRAFT_CREATED: 'success',
};

const money = (cents) =>
  (Number(cents || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/**
 * Upload monthly property-management reports (WestSide Realty, MANAGErenthouses.com,
 * etc.), review the parsed figures, and generate the balanced draft journal entry —
 * Dr Accounts Receivable / Cr Rental Income for the gross rent, Dr the relevant expense
 * account(s) / Cr Accounts Receivable for whatever the manager withheld. The entry lands
 * as a DRAFT; post it from the Journal Entries screen once it looks right.
 */
export default function MgmtReports() {
  const [entities, setEntities] = useState([]);
  const [entityId, setEntityId] = useState('ent-ljc');
  const [records, setRecords] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [editRecord, setEditRecord] = useState(null);
  const fileInputRef = useRef(null);

  const showError = (e) => setError(e?.response?.data?.error || e.message || 'Something went wrong');

  const loadAll = useCallback(async () => {
    if (!entityId) return;
    setLoading(true);
    try {
      const res = await mgmtReportAPI.list(entityId, statusFilter || undefined);
      setRecords(res.data);
    } catch (e) { showError(e); } finally { setLoading(false); }
  }, [entityId, statusFilter]);

  useEffect(() => { entityAPI.list().then((res) => setEntities(res.data)).catch(() => {}); }, []);
  useEffect(() => { loadAll(); }, [loadAll]);

  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const handleUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setBusy(true); setError(null); setSuccess(null);
    let createdCount = 0; let dupCount = 0;
    try {
      for (const file of files) {
        const fileData = await fileToBase64(file);
        const res = await mgmtReportAPI.upload({
          entityId, fileName: file.name, fileMime: file.type || 'application/pdf', fileData,
        });
        if (res.data.status === 'duplicate') dupCount += 1; else createdCount += 1;
      }
      setSuccess(`Uploaded ${createdCount} report(s)${dupCount ? `, ${dupCount} already imported` : ''}.`);
      await loadAll();
    } catch (e) { showError(e); } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleApprove = async (id) => {
    setBusy(true); setError(null);
    try { await mgmtReportAPI.approve(id); await loadAll(); }
    catch (e) { showError(e); } finally { setBusy(false); }
  };

  const handleCreateJournal = async (id) => {
    setBusy(true); setError(null); setSuccess(null);
    try {
      const res = await mgmtReportAPI.createJournal(id);
      setSuccess(`Draft journal entry ${res.data.jeNumber} created (Dr/Cr ${res.data.totalDebit}). Review and post it from Journal Entries.`);
      await loadAll();
    } catch (e) { showError(e); } finally { setBusy(false); }
  };

  const handleReject = async (id) => {
    if (!window.confirm('Discard this imported report?')) return;
    setBusy(true); setError(null);
    try { await mgmtReportAPI.reject(id); await loadAll(); }
    catch (e) { showError(e); } finally { setBusy(false); }
  };

  const openEdit = (record) => setEditRecord({
    ...record,
    incomeLines: record.incomeLines.length ? record.incomeLines : [],
    expenseLines: record.expenseLines.length ? record.expenseLines : [],
  });

  const updateLine = (which, idx, field, value) => {
    setEditRecord((r) => {
      const lines = [...r[which]];
      lines[idx] = { ...lines[idx], [field]: field === 'cents' ? Math.round(Number(value || 0) * 100) : value };
      return { ...r, [which]: lines };
    });
  };
  const addLine = (which) => setEditRecord((r) => ({ ...r, [which]: [...r[which], { label: '', cents: 0 }] }));
  const removeLine = (which, idx) => setEditRecord((r) => ({ ...r, [which]: r[which].filter((_, i) => i !== idx) }));

  const saveEdit = async () => {
    setBusy(true); setError(null);
    try {
      await mgmtReportAPI.update(editRecord.id, {
        propertyRaw: editRecord.propertyRaw,
        managementCompany: editRecord.managementCompany,
        periodStart: editRecord.periodStart,
        periodEnd: editRecord.periodEnd,
        incomeLines: editRecord.incomeLines,
        expenseLines: editRecord.expenseLines,
      });
      setEditRecord(null);
      await loadAll();
    } catch (e) { showError(e); } finally { setBusy(false); }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h5" gutterBottom>Property Management Report Import</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Upload the monthly report your property manager sends (WestSide Realty, MANAGErenthouses.com, etc.).
        Rent and each expense line are parsed automatically; review, then generate the draft journal entry.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess(null)}>{success}</Alert>}

      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
          <FormControl size="small" sx={{ minWidth: 220 }}>
            <InputLabel>Entity</InputLabel>
            <Select label="Entity" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
              {entities.map((en) => <MenuItem key={en.id} value={en.id}>{en.name}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel>Status</InputLabel>
            <Select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <MenuItem value="">All</MenuItem>
              <MenuItem value="PENDING_REVIEW">Needs review</MenuItem>
              <MenuItem value="REVIEWED">Reviewed</MenuItem>
              <MenuItem value="DRAFT_CREATED">Journal created</MenuItem>
            </Select>
          </FormControl>
          <Button variant="contained" component="label" startIcon={<UploadFile />} disabled={busy}>
            Upload Report(s)
            <input ref={fileInputRef} type="file" accept="application/pdf,.pdf,text/plain" multiple hidden onChange={handleUpload} />
          </Button>
          {busy && <CircularProgress size={22} />}
        </Stack>
      </Paper>

      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Property</TableCell>
              <TableCell>Management Co.</TableCell>
              <TableCell>Period End</TableCell>
              <TableCell align="right">Income</TableCell>
              <TableCell align="right">Expenses</TableCell>
              <TableCell align="right">Net</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={8} align="center"><CircularProgress size={22} /></TableCell></TableRow>}
            {!loading && records.length === 0 && (
              <TableRow><TableCell colSpan={8} align="center">No reports imported yet.</TableCell></TableRow>
            )}
            {records.map((r) => (
              <TableRow key={r.id} hover>
                <TableCell>
                  {r.propertyCanonical || <em>{r.propertyRaw || 'Unrecognized'}</em>}
                  {!r.propertyMatched && <Chip size="small" label="unmatched property" color="warning" sx={{ ml: 1 }} />}
                </TableCell>
                <TableCell>{r.managementCompany || '—'}</TableCell>
                <TableCell>{r.periodEnd || '—'}</TableCell>
                <TableCell align="right">{money(r.totalIncomeCents)}</TableCell>
                <TableCell align="right">{money(r.totalExpenseCents)}</TableCell>
                <TableCell align="right">{money(r.netIncomeCents)}</TableCell>
                <TableCell>
                  <Chip size="small" label={r.status.replace('_', ' ')} color={STATUS_COLORS[r.status] || 'default'} />
                  {r.needsReview && r.status !== 'DRAFT_CREATED' && <Chip size="small" label="needs review" color="warning" sx={{ ml: 1 }} />}
                </TableCell>
                <TableCell>
                  <Stack direction="row" spacing={0.5}>
                    {r.hasFile && (
                      <Tooltip title="View source report">
                        <IconButton size="small" onClick={() => mgmtReportAPI.viewFile(r.id, r.fileName).catch((e) => setError(e.message))}>
                          <AttachFile fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    <Tooltip title="Review / correct">
                      <IconButton size="small" onClick={() => openEdit(r)} disabled={!!r.journalEntryId}><Edit fontSize="small" /></IconButton>
                    </Tooltip>
                    {r.status === 'PENDING_REVIEW' && !r.journalEntryId && (
                      <Tooltip title="Mark reviewed">
                        <IconButton size="small" onClick={() => handleApprove(r.id)}><CheckCircle fontSize="small" /></IconButton>
                      </Tooltip>
                    )}
                    {!r.journalEntryId && (
                      <Tooltip title="Create draft journal entry">
                        <span>
                          <IconButton size="small" color="primary" onClick={() => handleCreateJournal(r.id)}
                            disabled={r.propertyMatched === false || (r.totalIncomeCents === 0 && r.totalExpenseCents === 0)}>
                            <PostAdd fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    )}
                    {!r.journalEntryId && (
                      <Tooltip title="Discard">
                        <IconButton size="small" onClick={() => handleReject(r.id)}><Delete fontSize="small" /></IconButton>
                      </Tooltip>
                    )}
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={!!editRecord} onClose={() => setEditRecord(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Review report</DialogTitle>
        <DialogContent>
          {editRecord && (
            <Stack spacing={2} sx={{ mt: 1 }}>
              {editRecord.notes && editRecord.notes.length > 0 && (
                <Alert severity="info">{editRecord.notes.join(' ')}</Alert>
              )}
              <TextField label="Property" value={editRecord.propertyRaw || ''} fullWidth
                onChange={(e) => setEditRecord({ ...editRecord, propertyRaw: e.target.value })}
                helperText="Must match a known property (e.g. '13923 Ivymount') for the journal entry to be created." />
              <TextField label="Management company" value={editRecord.managementCompany || ''} fullWidth
                onChange={(e) => setEditRecord({ ...editRecord, managementCompany: e.target.value })} />
              <Stack direction="row" spacing={2}>
                <TextField label="Period start" type="date" value={editRecord.periodStart || ''} InputLabelProps={{ shrink: true }}
                  onChange={(e) => setEditRecord({ ...editRecord, periodStart: e.target.value })} />
                <TextField label="Period end" type="date" value={editRecord.periodEnd || ''} InputLabelProps={{ shrink: true }}
                  onChange={(e) => setEditRecord({ ...editRecord, periodEnd: e.target.value })} />
              </Stack>

              <Typography variant="subtitle2">Income</Typography>
              {editRecord.incomeLines.map((l, i) => (
                <Stack direction="row" spacing={1} key={i}>
                  <TextField size="small" label="Label" value={l.label} onChange={(e) => updateLine('incomeLines', i, 'label', e.target.value)} fullWidth />
                  <TextField size="small" label="Amount" type="number" value={(l.cents / 100).toFixed(2)}
                    onChange={(e) => updateLine('incomeLines', i, 'cents', e.target.value)} sx={{ width: 140 }} />
                  <IconButton size="small" onClick={() => removeLine('incomeLines', i)}><Delete fontSize="small" /></IconButton>
                </Stack>
              ))}
              <Button size="small" onClick={() => addLine('incomeLines')}>+ Add income line</Button>

              <Typography variant="subtitle2">Expenses</Typography>
              {editRecord.expenseLines.map((l, i) => (
                <Stack direction="row" spacing={1} key={i}>
                  <TextField size="small" label="Label" value={l.label} onChange={(e) => updateLine('expenseLines', i, 'label', e.target.value)} fullWidth />
                  <TextField size="small" label="Amount" type="number" value={(l.cents / 100).toFixed(2)}
                    onChange={(e) => updateLine('expenseLines', i, 'cents', e.target.value)} sx={{ width: 140 }} />
                  <IconButton size="small" onClick={() => removeLine('expenseLines', i)}><Delete fontSize="small" /></IconButton>
                </Stack>
              ))}
              <Button size="small" onClick={() => addLine('expenseLines')}>+ Add expense line</Button>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditRecord(null)}>Cancel</Button>
          <Button variant="contained" onClick={saveEdit} disabled={busy}>Save</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
