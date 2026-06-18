import React, { useEffect, useState } from 'react';
import {
  Box, Typography, TextField, Button, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Paper, FormControl, InputLabel, Select, MenuItem, Grid
} from '@mui/material';
import { reportAPI, accountAPI } from '../services/api';

export default function GeneralLedger() {
  const [accounts, setAccounts] = useState([]);
  const [ledgerData, setLedgerData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [entityId] = useState('ent-ljc');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [startDate, setStartDate] = useState(
    new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().split('T')[0]
  );
  const [endDate, setEndDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedAccount, setSelectedAccount] = useState(null);

  const loadAccounts = async () => {
    try {
      const response = await accountAPI.list(entityId);
      setAccounts(response.data);
    } catch (error) {
      console.error('Error loading accounts:', error);
    }
  };

  const flattenAccounts = (accs) => {
    let flat = [];
    accs.forEach(acc => {
      flat.push(acc);
      if (acc.children) flat = flat.concat(flattenAccounts(acc.children));
    });
    return flat;
  };

  const handleViewLedger = async () => {
    if (!selectedAccountId) {
      alert('Please select an account');
      return;
    }

    try {
      setLoading(true);
      const response = await reportAPI.generalLedger(entityId, selectedAccountId, startDate, endDate);
      setLedgerData(response.data.entries);
      setSelectedAccount(response.data.account);
    } catch (error) {
      console.error('Error loading ledger:', error);
      alert('Error loading ledger data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAccounts();
  }, [entityId]);

  const flatAccounts = flattenAccounts(accounts);

  return (
    <Box>
      <Typography variant="h4" sx={{ mb: 3 }}>General Ledger</Typography>

      {/* Filters */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Grid container spacing={2} sx={{ mb: 2 }}>
          <Grid item xs={12} sm={6} md={3}>
            <FormControl fullWidth>
              <InputLabel>Account</InputLabel>
              <Select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
              >
                <MenuItem value="">All Accounts</MenuItem>
                {flatAccounts.map(acc => (
                  <MenuItem key={acc.id} value={acc.id}>
                    {acc.account_number} - {acc.account_name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <TextField
              fullWidth
              type="date"
              label="Start Date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <TextField
              fullWidth
              type="date"
              label="End Date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
          </Grid>
          <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex', alignItems: 'flex-end' }}>
            <Button fullWidth variant="contained" onClick={handleViewLedger} disabled={loading}>
              {loading ? 'Loading...' : 'View'}
            </Button>
          </Grid>
        </Grid>
      </Paper>

      {/* Results */}
      {selectedAccount && (
        <Paper sx={{ p: 2, mb: 3, backgroundColor: '#f5f5f5' }}>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6} md={3}>
              <Typography variant="caption" color="textSecondary">Account Number</Typography>
              <Typography variant="h6">{selectedAccount.account_number}</Typography>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Typography variant="caption" color="textSecondary">Account Name</Typography>
              <Typography variant="h6">{selectedAccount.account_name}</Typography>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Typography variant="caption" color="textSecondary">Type</Typography>
              <Typography variant="h6">{selectedAccount.account_type}</Typography>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Typography variant="caption" color="textSecondary">Balance</Typography>
              <Typography variant="h6" color="primary">
                {ledgerData.length > 0
                  ? (ledgerData[ledgerData.length - 1].runningBalance || 0).toFixed(2)
                  : '0.00'}
              </Typography>
            </Grid>
          </Grid>
        </Paper>
      )}

      {/* Table */}
      {ledgerData.length > 0 && (
        <TableContainer component={Paper}>
          <Table>
            <TableHead>
              <TableRow sx={{ backgroundColor: '#f5f5f5' }}>
                <TableCell>Date</TableCell>
                <TableCell>JE #</TableCell>
                <TableCell>Description</TableCell>
                <TableCell align="right">Debit</TableCell>
                <TableCell align="right">Credit</TableCell>
                <TableCell align="right">Balance</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {ledgerData.map((entry, index) => (
                <TableRow key={entry.id}>
                  <TableCell>{entry.posting_date}</TableCell>
                  <TableCell>{entry.je_number}</TableCell>
                  <TableCell>{entry.description}</TableCell>
                  <TableCell align="right">{parseFloat(entry.debit).toFixed(2)}</TableCell>
                  <TableCell align="right">{parseFloat(entry.credit).toFixed(2)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 'bold' }}>
                    {entry.runningBalance?.toFixed(2) || '0.00'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {!loading && ledgerData.length === 0 && selectedAccount && (
        <Typography color="textSecondary" sx={{ mt: 3 }}>
          No entries found for this account in the selected period.
        </Typography>
      )}
    </Box>
  );
}
