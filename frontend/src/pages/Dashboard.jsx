import React, { useEffect, useState } from 'react';
import {
  Box, Grid, Paper, Typography, Card, CardContent, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Chip, CircularProgress
} from '@mui/material';
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { reportAPI } from '../services/api';

export default function Dashboard() {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [entityId] = useState('ent-ljc');

  useEffect(() => {
    const loadDashboard = async () => {
      try {
        setLoading(true);
        const response = await reportAPI.balanceSheet(entityId, new Date().toISOString().split('T')[0]);
        const dashResponse = await fetch(
          `http://localhost:3000/api/entities/${entityId}/reports/dashboard`,
          {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
          }
        );
        const dashData = await dashResponse.json();
        setDashboard(dashData);
      } catch (error) {
        console.error('Error loading dashboard:', error);
      } finally {
        setLoading(false);
      }
    };

    loadDashboard();
  }, [entityId]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '400px' }}>
        <CircularProgress />
      </Box>
    );
  }

  const kpis = dashboard?.kpis || {};
  const kpiCards = [
    { label: 'Total Assets', value: kpis.totalAssets, color: '#1976d2' },
    { label: 'Total Liabilities', value: kpis.totalLiabilities, color: '#d32f2f' },
    { label: 'Total Equity', value: kpis.totalEquity, color: '#388e3c' },
    { label: 'Journal Entries', value: kpis.journalEntries, color: '#f57c00' }
  ];

  const chartData = [
    { name: 'Assets', value: Math.abs(kpis.totalAssets || 0) },
    { name: 'Liabilities', value: Math.abs(kpis.totalLiabilities || 0) },
    { name: 'Equity', value: Math.abs(kpis.totalEquity || 0) }
  ];

  const COLORS = ['#1976d2', '#d32f2f', '#388e3c'];

  return (
    <Box>
      <Typography variant="h4" sx={{ mb: 3 }}>Dashboard</Typography>

      {/* KPI Cards */}
      <Grid container spacing={2} sx={{ mb: 4 }}>
        {kpiCards.map((card, index) => (
          <Grid item xs={12} sm={6} md={3} key={index}>
            <Card>
              <CardContent>
                <Typography color="textSecondary" gutterBottom>
                  {card.label}
                </Typography>
                <Typography
                  variant="h5"
                  sx={{ color: card.color, fontWeight: 'bold' }}
                >
                  ${Math.abs(card.value || 0).toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                  })}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* Charts */}
      <Grid container spacing={3} sx={{ mb: 4 }}>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" sx={{ mb: 2 }}>Balance Sheet Overview</Typography>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, value }) => `${name}: $${value.toLocaleString()}`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {COLORS.map((color, index) => (
                    <Cell key={`cell-${index}`} fill={color} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => `$${value.toLocaleString()}`} />
              </PieChart>
            </ResponsiveContainer>
          </Paper>
        </Grid>

        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" sx={{ mb: 2 }}>Statistics</Typography>
            <Box sx={{ pt: 2 }}>
              <Box sx={{ mb: 2, display: 'flex', justifyContent: 'space-between' }}>
                <Typography>Total Accounts:</Typography>
                <Typography sx={{ fontWeight: 'bold' }}>{kpis.accountCount}</Typography>
              </Box>
              <Box sx={{ mb: 2, display: 'flex', justifyContent: 'space-between' }}>
                <Typography>Journal Entries:</Typography>
                <Typography sx={{ fontWeight: 'bold' }}>{kpis.journalEntries}</Typography>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <Typography>GL Entries:</Typography>
                <Typography sx={{ fontWeight: 'bold' }}>{kpis.generalLedgerEntries}</Typography>
              </Box>
            </Box>
          </Paper>
        </Grid>
      </Grid>

      {/* Top Accounts */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>Top Accounts by Balance</Typography>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ backgroundColor: '#f5f5f5' }}>
                <TableCell>Account #</TableCell>
                <TableCell>Account Name</TableCell>
                <TableCell>Type</TableCell>
                <TableCell align="right">Balance</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(dashboard?.topAccounts || []).map((account) => (
                <TableRow key={account.accountNumber}>
                  <TableCell>{account.accountNumber}</TableCell>
                  <TableCell>{account.accountName}</TableCell>
                  <TableCell>
                    <Chip label={account.accountType} size="small" />
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 'bold' }}>
                    ${account.balance.toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2
                    })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Recent Journal Entries */}
      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>Recent Journal Entries</Typography>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ backgroundColor: '#f5f5f5' }}>
                <TableCell>JE #</TableCell>
                <TableCell>Date</TableCell>
                <TableCell>Description</TableCell>
                <TableCell align="right">Debit</TableCell>
                <TableCell align="right">Credit</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(dashboard?.recentJournals || []).map((journal) => (
                <TableRow key={journal.id}>
                  <TableCell>{journal.je_number}</TableCell>
                  <TableCell>{journal.posting_date}</TableCell>
                  <TableCell>{journal.description}</TableCell>
                  <TableCell align="right">
                    ${parseFloat(journal.total_debit).toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2
                    })}
                  </TableCell>
                  <TableCell align="right">
                    ${parseFloat(journal.total_credit).toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2
                    })}
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={journal.status}
                      size="small"
                      color={journal.status === 'POSTED' ? 'success' : 'warning'}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
    </Box>
  );
}
