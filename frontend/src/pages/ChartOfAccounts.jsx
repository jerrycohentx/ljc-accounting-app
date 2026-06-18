import React, { useEffect, useState } from 'react';
import {
  Box, Typography, Button, Dialog, TextField, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Paper, Select, MenuItem, FormControl,
  InputLabel, IconButton, Tooltip, Chip
} from '@mui/material';
import { Add, Edit, Delete, ExpandMore, ExpandLess } from '@mui/icons-material';
import { accountAPI } from '../services/api';

export default function ChartOfAccounts() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openDialog, setOpenDialog] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [expandedRows, setExpandedRows] = useState(new Set());
  const [entityId] = useState('ent-ljc');
  
  const [formData, setFormData] = useState({
    accountNumber: '',
    accountName: '',
    accountType: 'ASSET',
    parentAccountId: null,
    description: ''
  });

  const loadAccounts = async () => {
    try {
      setLoading(true);
      const response = await accountAPI.list(entityId);
      setAccounts(response.data);
    } catch (error) {
      console.error('Error loading accounts:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAccounts();
  }, [entityId]);

  const handleOpenDialog = (account = null) => {
    if (account) {
      setEditingId(account.id);
      setFormData({
        accountNumber: account.account_number,
        accountName: account.account_name,
        accountType: account.account_type,
        parentAccountId: account.parent_account_id,
        description: account.description
      });
    } else {
      setEditingId(null);
      setFormData({
        accountNumber: '',
        accountName: '',
        accountType: 'ASSET',
        parentAccountId: null,
        description: ''
      });
    }
    setOpenDialog(true);
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
    setEditingId(null);
  };

  const handleSave = async () => {
    try {
      if (editingId) {
        await accountAPI.update(entityId, editingId, {
          accountName: formData.accountName,
          description: formData.description,
          parentAccountId: formData.parentAccountId
        });
      } else {
        await accountAPI.create(entityId, formData);
      }
      loadAccounts();
      handleCloseDialog();
    } catch (error) {
      console.error('Error saving account:', error);
    }
  };

  const toggleExpand = (accountId) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(accountId)) {
      newExpanded.delete(accountId);
    } else {
      newExpanded.add(accountId);
    }
    setExpandedRows(newExpanded);
  };

  const renderAccountRow = (account, level = 0) => {
    const rows = [
      <TableRow key={account.id}>
        <TableCell style={{ paddingLeft: `${level * 24}px` }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {account.children?.length > 0 && (
              <IconButton size="small" onClick={() => toggleExpand(account.id)}>
                {expandedRows.has(account.id) ? <ExpandLess /> : <ExpandMore />}
              </IconButton>
            )}
            <Typography>{account.account_number}</Typography>
          </Box>
        </TableCell>
        <TableCell>{account.account_name}</TableCell>
        <TableCell>
          <Chip label={account.account_type} size="small" />
        </TableCell>
        <TableCell>{account.normal_balance}</TableCell>
        <TableCell align="right">
          {account.balance?.computed?.toFixed(2) || '0.00'}
        </TableCell>
        <TableCell align="center">
          <Tooltip title="Edit">
            <IconButton size="small" onClick={() => handleOpenDialog(account)}>
              <Edit fontSize="small" />
            </IconButton>
          </Tooltip>
        </TableCell>
      </TableRow>
    ];

    if (expandedRows.has(account.id) && account.children?.length > 0) {
      account.children.forEach(child => {
        rows.push(...renderAccountRow(child, level + 1));
      });
    }

    return rows;
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h4">Chart of Accounts</Typography>
        <Button variant="contained" startIcon={<Add />} onClick={() => handleOpenDialog()}>
          New Account
        </Button>
      </Box>

      {loading ? (
        <Typography>Loading...</Typography>
      ) : (
        <TableContainer component={Paper}>
          <Table>
            <TableHead>
              <TableRow sx={{ backgroundColor: '#f5f5f5' }}>
                <TableCell>Account #</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Balance</TableCell>
                <TableCell align="right">Amount</TableCell>
                <TableCell align="center">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {accounts.map(account => renderAccountRow(account))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Dialog */}
      <Dialog open={openDialog} onClose={handleCloseDialog} maxWidth="sm" fullWidth>
        <Box sx={{ p: 3 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            {editingId ? 'Edit Account' : 'New Account'}
          </Typography>

          <TextField
            fullWidth
            label="Account Number"
            value={formData.accountNumber}
            onChange={(e) => setFormData({ ...formData, accountNumber: e.target.value })}
            margin="normal"
            disabled={!!editingId}
          />

          <TextField
            fullWidth
            label="Account Name"
            value={formData.accountName}
            onChange={(e) => setFormData({ ...formData, accountName: e.target.value })}
            margin="normal"
          />

          <FormControl fullWidth margin="normal" disabled={!!editingId}>
            <InputLabel>Account Type</InputLabel>
            <Select
              value={formData.accountType}
              onChange={(e) => setFormData({ ...formData, accountType: e.target.value })}
            >
              <MenuItem value="ASSET">Asset</MenuItem>
              <MenuItem value="LIABILITY">Liability</MenuItem>
              <MenuItem value="EQUITY">Equity</MenuItem>
              <MenuItem value="REVENUE">Revenue</MenuItem>
              <MenuItem value="EXPENSE">Expense</MenuItem>
              <MenuItem value="CONTRA">Contra</MenuItem>
            </Select>
          </FormControl>

          <TextField
            fullWidth
            label="Description"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            margin="normal"
            multiline
            rows={3}
          />

          <Box sx={{ display: 'flex', gap: 2, mt: 3, justifyContent: 'flex-end' }}>
            <Button onClick={handleCloseDialog}>Cancel</Button>
            <Button variant="contained" onClick={handleSave}>
              {editingId ? 'Update' : 'Create'}
            </Button>
          </Box>
        </Box>
      </Dialog>
    </Box>
  );
}
