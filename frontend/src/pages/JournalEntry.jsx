import React, { useEffect, useState } from 'react';
import {
  Box, Typography, Button, Dialog, TextField, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Paper, Chip, IconButton, Tooltip,
  Grid, Card, CardContent, FormHelperText
} from '@mui/material';
import { Add, Edit, Delete, Check, SendRounded, Visibility } from '@mui/icons-material';
import { journalAPI, accountAPI } from '../services/api';

export default function JournalEntry() {
  const [journals, setJournals] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openDialog, setOpenDialog] = useState(false);
  const [viewDialog, setViewDialog] = useState(false);
  const [selectedJournal, setSelectedJournal] = useState(null);
  const [entityId] = useState('ent-ljc');

  const [formData, setFormData] = useState({
    description: '',
    postingDate: new Date().toISOString().split('T')[0],
    memo: '',
    lines: [
      { accountId: '', debit: '', credit: '', description: '' },
      { accountId: '', debit: '', credit: '', description: '' }
    ]
  });

  const loadJournals = async () => {
    try {
      setLoading(true);
      const response = await journalAPI.list(entityId);
      setJournals(response.data.data);
    } catch (error) {
      console.error('Error loading journals:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadAccounts = async () => {
    try {
      const response = await accountAPI.list(entityId);
      setAccounts(response.data);
    } catch (error) {
      console.error('Error loading accounts:', error);
    }
  };

  useEffect(() => {
    loadJournals();
    loadAccounts();
  }, [entityId]);

  const handleOpenDialog = () => {
    setOpenDialog(true);
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
    setFormData({
      description: '',
      postingDate: new Date().toISOString().split('T')[0],
      memo: '',
      lines: [
        { accountId: '', debit: '', credit: '', description: '' },
        { accountId: '', debit: '', credit: '', description: '' }
      ]
    });
  };

  const handleSave = async () => {
    try {
      // Flatten account hierarchy for easier lookup
      const flatAccounts = [];
      const flatten = (accs) => {
        accs.forEach(acc => {
          flatAccounts.push(acc);
          if (acc.children) flatten(acc.children);
        });
      };
      flatten(accounts);

      const lines = formData.lines
        .filter(line => line.accountId && (line.debit || line.credit))
        .map(line => ({
          accountId: line.accountId,
          debit: parseFloat(line.debit) || 0,
          credit: parseFloat(line.credit) || 0,
          description: line.description
        }));

      if (lines.length < 2) {
        alert('At least 2 lines required');
        return;
      }

      const totalDebit = lines.reduce((sum, l) => sum + l.debit, 0);
      const totalCredit = lines.reduce((sum, l) => sum + l.credit, 0);

      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        alert(`Journal does not balance. Debits: ${totalDebit}, Credits: ${totalCredit}`);
        return;
      }

      await journalAPI.create(entityId, {
        description: formData.description,
        postingDate: formData.postingDate,
        memo: formData.memo,
        lines
      });

      loadJournals();
      handleCloseDialog();
    } catch (error) {
      console.error('Error saving journal:', error);
      alert(error.response?.data?.error || 'Error saving journal entry');
    }
  };

  const handleApprove = async (journalId) => {
    try {
      await journalAPI.approve(entityId, journalId);
      loadJournals();
    } catch (error) {
      alert(error.response?.data?.error || 'Error approving journal');
    }
  };

  const handlePost = async (journalId) => {
    try {
      await journalAPI.post(entityId, journalId);
      loadJournals();
    } catch (error) {
      alert(error.response?.data?.error || 'Error posting journal');
    }
  };

  const getStatusColor = (status) => {
    const colors = {
      'DRAFT': 'default',
      'APPROVED': 'warning',
      'POSTED': 'success',
      'REJECTED': 'error'
    };
    return colors[status] || 'default';
  };

  const flatAccounts = [];
  const flatten = (accs) => {
    accs.forEach(acc => {
      flatAccounts.push(acc);
      if (acc.children) flatten(acc.children);
    });
  };
  flatten(accounts);

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h4">Journal Entries</Typography>
        <Button variant="contained" startIcon={<Add />} onClick={handleOpenDialog}>
          New Journal Entry
        </Button>
      </Box>

      {loading ? (
        <Typography>Loading...</Typography>
      ) : (
        <TableContainer component={Paper}>
          <Table>
            <TableHead>
              <TableRow sx={{ backgroundColor: '#f5f5f5' }}>
                <TableCell>JE #</TableCell>
                <TableCell>Date</TableCell>
                <TableCell>Description</TableCell>
                <TableCell align="right">Debit</TableCell>
                <TableCell align="right">Credit</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="center">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {journals.map(journal => (
                <TableRow key={journal.id}>
                  <TableCell>{journal.je_number}</TableCell>
                  <TableCell>{journal.posting_date}</TableCell>
                  <TableCell>{journal.description}</TableCell>
                  <TableCell align="right">{parseFloat(journal.total_debit).toFixed(2)}</TableCell>
                  <TableCell align="right">{parseFloat(journal.total_credit).toFixed(2)}</TableCell>
                  <TableCell>
                    <Chip label={journal.status} color={getStatusColor(journal.status)} size="small" />
                  </TableCell>
                  <TableCell align="center" sx={{ whiteSpace: 'nowrap' }}>
                    <Tooltip title="View">
                      <IconButton
                        size="small"
                        onClick={() => {
                          setSelectedJournal(journal);
                          setViewDialog(true);
                        }}
                      >
                        <Visibility fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    {journal.status === 'DRAFT' && (
                      <Tooltip title="Approve">
                        <IconButton size="small" onClick={() => handleApprove(journal.id)}>
                          <Check fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    {journal.status === 'APPROVED' && (
                      <Tooltip title="Post">
                        <IconButton size="small" onClick={() => handlePost(journal.id)}>
                          <SendRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={openDialog} onClose={handleCloseDialog} maxWidth="md" fullWidth>
        <Box sx={{ p: 3 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>New Journal Entry</Typography>

          <TextField
            fullWidth
            label="Description"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            margin="normal"
          />

          <TextField
            fullWidth
            type="date"
            label="Posting Date"
            value={formData.postingDate}
            onChange={(e) => setFormData({ ...formData, postingDate: e.target.value })}
            margin="normal"
            InputLabelProps={{ shrink: true }}
          />

          <TextField
            fullWidth
            label="Memo"
            value={formData.memo}
            onChange={(e) => setFormData({ ...formData, memo: e.target.value })}
            margin="normal"
            multiline
            rows={2}
          />

          <Typography variant="subtitle2" sx={{ mt: 3, mb: 2, fontWeight: 'bold' }}>
            Line Items
          </Typography>

          {formData.lines.map((line, index) => (
            <Grid container spacing={2} key={index} sx={{ mb: 2 }}>
              <Grid item xs={4}>
                <TextField
                  select
                  fullWidth
                  label="Account"
                  value={line.accountId}
                  onChange={(e) => {
                    const newLines = [...formData.lines];
                    newLines[index].accountId = e.target.value;
                    setFormData({ ...formData, lines: newLines });
                  }}
                  SelectProps={{ native: true }}
                >
                  <option value="">Select Account</option>
                  {flatAccounts.map(acc => (
                    <option key={acc.id} value={acc.id}>
                      {acc.account_number} - {acc.account_name}
                    </option>
                  ))}
                </TextField>
              </Grid>
              <Grid item xs={3}>
                <TextField
                  fullWidth
                  type="number"
                  label="Debit"
                  inputProps={{ step: '0.01' }}
                  value={line.debit}
                  onChange={(e) => {
                    const newLines = [...formData.lines];
                    newLines[index].debit = e.target.value;
                    newLines[index].credit = '';
                    setFormData({ ...formData, lines: newLines });
                  }}
                />
              </Grid>
              <Grid item xs={3}>
                <TextField
                  fullWidth
                  type="number"
                  label="Credit"
                  inputProps={{ step: '0.01' }}
                  value={line.credit}
                  onChange={(e) => {
                    const newLines = [...formData.lines];
                    newLines[index].credit = e.target.value;
                    newLines[index].debit = '';
                    setFormData({ ...formData, lines: newLines });
                  }}
                />
              </Grid>
              <Grid item xs={2}>
                <Button
                  fullWidth
                  variant="outlined"
                  size="small"
                  onClick={() => {
                    const newLines = formData.lines.filter((_, i) => i !== index);
                    setFormData({ ...formData, lines: newLines });
                  }}
                >
                  Delete
                </Button>
              </Grid>
            </Grid>
          ))}

          <Button
            fullWidth
            variant="outlined"
            onClick={() => {
              const newLines = [...formData.lines, { accountId: '', debit: '', credit: '', description: '' }];
              setFormData({ ...formData, lines: newLines });
            }}
          >
            + Add Line
          </Button>

          <Box sx={{ display: 'flex', gap: 2, mt: 3, justifyContent: 'flex-end' }}>
            <Button onClick={handleCloseDialog}>Cancel</Button>
            <Button variant="contained" onClick={handleSave}>Create</Button>
          </Box>
        </Box>
      </Dialog>

      {/* View Dialog */}
      <Dialog open={viewDialog} onClose={() => setViewDialog(false)} maxWidth="md" fullWidth>
        {selectedJournal && (
          <Box sx={{ p: 3 }}>
            <Typography variant="h6">{selectedJournal.je_number}</Typography>
            <Typography variant="body2" color="textSecondary">{selectedJournal.description}</Typography>
            <Typography variant="body2" sx={{ mt: 1 }}>Date: {selectedJournal.posting_date}</Typography>
            {/* Lines would be loaded and displayed here */}
            <Box sx={{ display: 'flex', gap: 2, mt: 3, justifyContent: 'flex-end' }}>
              <Button onClick={() => setViewDialog(false)}>Close</Button>
            </Box>
          </Box>
        )}
      </Dialog>
    </Box>
  );
}
