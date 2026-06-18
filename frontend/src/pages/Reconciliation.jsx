import React, { useEffect, useState } from 'react';
import {
  Box, Typography, Paper, Tabs, Tab, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Button, Dialog, TextField, FormControl, InputLabel, Select,
  MenuItem, Chip, IconButton, Tooltip, Grid, Card, CardContent, CircularProgress
} from '@mui/material';
import { Add, Edit, CheckCircle, Info } from '@mui/icons-material';
import { accountAPI, entityAPI } from '../services/api';

function TabPanel(props) {
  const { children, value, index } = props;
  return value === index ? <Box sx={{ pt: 3 }}>{children}</Box> : null;
}

const reconciliationAPI = {
  list: (entityId, params) => fetch(
    `http://localhost:3000/api/entities/${entityId}/reconciliations?${new URLSearchParams(params)}`,
    { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } }
  ).then(r => r.json()),
  
  create: (entityId, data) => fetch(
    `http://localhost:3000/api/entities/${entityId}/reconciliations`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    }
  ).then(r => r.json()),

  update: (entityId, id, data) => fetch(
    `http://localhost:3000/api/entities/${entityId}/reconciliations/${id}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    }
  ).then(r => r.json()),

  resolve: (entityId, id, notes) => fetch(
    `http://localhost:3000/api/entities/${entityId}/reconciliations/${id}/resolve`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ notes })
    }
  ).then(r => r.json()),

  intercompanyAnalysis: (entityId, asOfDate) => fetch(
    `http://localhost:3000/api/entities/${entityId}/reconciliations/intercompany/analysis?asOfDate=${asOfDate}`,
    { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } }
  ).then(r => r.json())
};

export default function Reconciliation() {
  const [tabValue, setTabValue] = useState(0);
  const [entityId] = useState('ent-ljc');
  const [entities, setEntities] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [reconciliations, setReconciliations] = useState([]);
  const [intercompanyData, setIntercompanyData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [openDialog, setOpenDialog] = useState(false);

  const [formData, setFormData] = useState({
    accountId: '',
    reconciliationType: 'INTERCOMPANY',
    counterpartyEntityId: '',
    counterpartyAccountId: '',
    ourBalance: '',
    theirBalance: '',
    asOfDate: new Date().toISOString().split('T')[0],
    notes: ''
  });

  const loadReconciliations = async () => {
    try {
      setLoading(true);
      const data = await reconciliationAPI.list(entityId, {});
      setReconciliations(data.data || []);
    } catch (error) {
      console.error('Error loading reconciliations:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadIntercompanyAnalysis = async () => {
    try {
      setLoading(true);
      const data = await reconciliationAPI.intercompanyAnalysis(entityId, formData.asOfDate);
      setIntercompanyData(data);
    } catch (error) {
      console.error('Error loading intercompany analysis:', error);
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

  const loadEntities = async () => {
    try {
      const response = await entityAPI.list();
      setEntities(response.data);
    } catch (error) {
      console.error('Error loading entities:', error);
    }
  };

  useEffect(() => {
    loadEntities();
    loadAccounts();
    if (tabValue === 0) loadReconciliations();
    else if (tabValue === 1) loadIntercompanyAnalysis();
  }, [tabValue]);

  const handleCreateReconciliation = async () => {
    try {
      const result = await reconciliationAPI.create(entityId, {
        accountId: formData.accountId,
        reconciliationType: formData.reconciliationType,
        counterpartyEntityId: formData.counterpartyEntityId || null,
        ourBalance: formData.ourBalance ? parseFloat(formData.ourBalance) : null,
        theirBalance: formData.theirBalance ? parseFloat(formData.theirBalance) : null,
        asOfDate: formData.asOfDate,
        notes: formData.notes
      });
      
      loadReconciliations();
      setOpenDialog(false);
      setFormData({
        accountId: '',
        reconciliationType: 'INTERCOMPANY',
        counterpartyEntityId: '',
        counterpartyAccountId: '',
        ourBalance: '',
        theirBalance: '',
        asOfDate: new Date().toISOString().split('T')[0],
        notes: ''
      });
    } catch (error) {
      console.error('Error creating reconciliation:', error);
      alert('Error creating reconciliation');
    }
  };

  const getStatusColor = (status) => {
    const colors = {
      'MATCHED': 'success',
      'VARIANCE': 'warning',
      'PENDING': 'default',
      'IN_PROGRESS': 'info',
      'RESOLVED': 'success'
    };
    return colors[status] || 'default';
  };

  const flattenAccounts = (accs) => {
    let flat = [];
    accs.forEach(acc => {
      flat.push(acc);
      if (acc.children) flat = flat.concat(flattenAccounts(acc.children));
    });
    return flat;
  };

  const flatAccounts = flattenAccounts(accounts);

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h4">Reconciliations</Typography>
        <Button variant="contained" startIcon={<Add />} onClick={() => setOpenDialog(true)}>
          New Reconciliation
        </Button>
      </Box>

      <Tabs value={tabValue} onChange={(e, v) => setTabValue(v)} sx={{ mb: 3 }}>
        <Tab label="All Reconciliations" />
        <Tab label="Intercompany Analysis" />
      </Tabs>

      {/* All Reconciliations */}
      <TabPanel value={tabValue} index={0}>
        {loading ? (
          <CircularProgress />
        ) : (
          <TableContainer component={Paper}>
            <Table>
              <TableHead>
                <TableRow sx={{ backgroundColor: '#f5f5f5' }}>
                  <TableCell>Account</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell align="right">Our Balance</TableCell>
                  <TableCell align="right">Their Balance</TableCell>
                  <TableCell align="right">Variance</TableCell>
                  <TableCell>As Of</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell align="center">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {reconciliations.map((recon) => (
                  <TableRow key={recon.id}>
                    <TableCell>{recon.account_id}</TableCell>
                    <TableCell>{recon.reconciliation_type}</TableCell>
                    <TableCell align="right">
                      ${parseFloat(recon.our_balance).toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2
                      })}
                    </TableCell>
                    <TableCell align="right">
                      {recon.their_balance ? (
                        `$${parseFloat(recon.their_balance).toLocaleString('en-US', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2
                        })}`
                      ) : (
                        <Typography color="textSecondary">—</Typography>
                      )}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>
                      {recon.variance ? (
                        `$${Math.abs(parseFloat(recon.variance)).toLocaleString('en-US', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2
                        })}`
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>{recon.as_of_date}</TableCell>
                    <TableCell>
                      <Chip
                        label={recon.status}
                        color={getStatusColor(recon.status)}
                        size="small"
                      />
                    </TableCell>
                    <TableCell align="center">
                      {recon.status !== 'RESOLVED' && (
                        <Tooltip title="Resolve">
                          <IconButton
                            size="small"
                            onClick={() => {
                              reconciliationAPI.resolve(entityId, recon.id, recon.notes);
                              loadReconciliations();
                            }}
                          >
                            <CheckCircle fontSize="small" />
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
      </TabPanel>

      {/* Intercompany Analysis */}
      <TabPanel value={tabValue} index={1}>
        <Paper sx={{ p: 3, mb: 3 }}>
          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                type="date"
                label="As of Date"
                value={formData.asOfDate}
                onChange={(e) => setFormData({ ...formData, asOfDate: e.target.value })}
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
            <Grid item xs={12} sm={6} sx={{ display: 'flex', alignItems: 'flex-end' }}>
              <Button fullWidth variant="contained" onClick={loadIntercompanyAnalysis} disabled={loading}>
                {loading ? <CircularProgress size={24} /> : 'Analyze'}
              </Button>
            </Grid>
          </Grid>
        </Paper>

        {intercompanyData && (
          <Box>
            <Typography variant="h6" sx={{ mb: 2 }}>
              Intercompany Accounts as of {intercompanyData.asOfDate}
            </Typography>
            
            <Grid container spacing={2}>
              {intercompanyData.intercompanyAccounts.map((acc) => (
                <Grid item xs={12} md={6} key={acc.accountNumber}>
                  <Card>
                    <CardContent>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', mb: 2 }}>
                        <Box>
                          <Typography variant="h6">{acc.accountNumber}</Typography>
                          <Typography color="textSecondary">{acc.accountName}</Typography>
                        </Box>
                        <Chip label={acc.status} color={getStatusColor(acc.status)} size="small" />
                      </Box>

                      <Box sx={{ backgroundColor: '#f5f5f5', p: 2, borderRadius: 1, mb: 2 }}>
                        <Typography variant="body2" color="textSecondary">Balance</Typography>
                        <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#1976d2' }}>
                          ${acc.balance.toLocaleString('en-US', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2
                          })}
                        </Typography>
                      </Box>

                      {acc.lastReconciliation && (
                        <Box sx={{ pt: 1, borderTop: '1px solid #eee' }}>
                          <Typography variant="caption" color="textSecondary">
                            Last Reconciliation: {acc.lastReconciliation.as_of_date}
                          </Typography>
                          {acc.lastReconciliation.variance && (
                            <Typography variant="body2" sx={{ mt: 1, color: '#d32f2f' }}>
                              Variance: ${Math.abs(acc.lastReconciliation.variance).toLocaleString('en-US', {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2
                              })}
                            </Typography>
                          )}
                        </Box>
                      )}

                      <Button
                        fullWidth
                        variant="outlined"
                        size="small"
                        sx={{ mt: 2 }}
                        onClick={() => {
                          setFormData({ ...formData, accountId: acc.accountNumber });
                          setOpenDialog(true);
                        }}
                      >
                        Reconcile
                      </Button>
                    </CardContent>
                  </Card>
                </Grid>
              ))}
            </Grid>
          </Box>
        )}
      </TabPanel>

      {/* Create Dialog */}
      <Dialog open={openDialog} onClose={() => setOpenDialog(false)} maxWidth="sm" fullWidth>
        <Box sx={{ p: 3 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>New Reconciliation</Typography>

          <FormControl fullWidth margin="normal">
            <InputLabel>Account</InputLabel>
            <Select
              value={formData.accountId}
              onChange={(e) => setFormData({ ...formData, accountId: e.target.value })}
            >
              <MenuItem value="">Select Account</MenuItem>
              {flatAccounts.filter(a => a.account_name.includes('Due')).map(acc => (
                <MenuItem key={acc.id} value={acc.id}>
                  {acc.account_number} - {acc.account_name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl fullWidth margin="normal">
            <InputLabel>Reconciliation Type</InputLabel>
            <Select
              value={formData.reconciliationType}
              onChange={(e) => setFormData({ ...formData, reconciliationType: e.target.value })}
            >
              <MenuItem value="INTERCOMPANY">Intercompany</MenuItem>
              <MenuItem value="BANK">Bank</MenuItem>
              <MenuItem value="LOAN">Loan</MenuItem>
              <MenuItem value="AP">Accounts Payable</MenuItem>
              <MenuItem value="AR">Accounts Receivable</MenuItem>
            </Select>
          </FormControl>

          <FormControl fullWidth margin="normal">
            <InputLabel>Counterparty Entity</InputLabel>
            <Select
              value={formData.counterpartyEntityId}
              onChange={(e) => setFormData({ ...formData, counterpartyEntityId: e.target.value })}
            >
              <MenuItem value="">—</MenuItem>
              {entities.filter(e => e.id !== entityId).map(ent => (
                <MenuItem key={ent.id} value={ent.id}>{ent.name}</MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            fullWidth
            type="number"
            label="Our Balance"
            inputProps={{ step: '0.01' }}
            value={formData.ourBalance}
            onChange={(e) => setFormData({ ...formData, ourBalance: e.target.value })}
            margin="normal"
          />

          <TextField
            fullWidth
            type="number"
            label="Their Balance"
            inputProps={{ step: '0.01' }}
            value={formData.theirBalance}
            onChange={(e) => setFormData({ ...formData, theirBalance: e.target.value })}
            margin="normal"
          />

          <TextField
            fullWidth
            type="date"
            label="As of Date"
            value={formData.asOfDate}
            onChange={(e) => setFormData({ ...formData, asOfDate: e.target.value })}
            margin="normal"
            InputLabelProps={{ shrink: true }}
          />

          <TextField
            fullWidth
            label="Notes"
            value={formData.notes}
            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
            margin="normal"
            multiline
            rows={3}
          />

          <Box sx={{ display: 'flex', gap: 2, mt: 3, justifyContent: 'flex-end' }}>
            <Button onClick={() => setOpenDialog(false)}>Cancel</Button>
            <Button variant="contained" onClick={handleCreateReconciliation}>Create</Button>
          </Box>
        </Box>
      </Dialog>
    </Box>
  );
}
