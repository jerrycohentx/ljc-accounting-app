import React, { useState, useEffect } from 'react';
import {
  Box, Typography, Paper, Tabs, Tab, TextField, Button, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Grid, Card, CardContent,
  CircularProgress
} from '@mui/material';
import { reportAPI } from '../services/api';

function TabPanel(props) {
  const { children, value, index } = props;
  return value === index ? <Box sx={{ pt: 3 }}>{children}</Box> : null;
}

export default function Reports() {
  const [tabValue, setTabValue] = useState(0);
  const [entityId] = useState('ent-ljc');
  const [loading, setLoading] = useState(false);

  // P&L
  const [plStartDate, setPlStartDate] = useState(
    new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().split('T')[0]
  );
  const [plEndDate, setPlEndDate] = useState(new Date().toISOString().split('T')[0]);
  const [plData, setPlData] = useState(null);

  // Balance Sheet
  const [bsDate, setBsDate] = useState(new Date().toISOString().split('T')[0]);
  const [bsData, setBsData] = useState(null);

  const loadIncomeStatement = async () => {
    try {
      setLoading(true);
      const response = await reportAPI.incomeStatement(entityId, plStartDate, plEndDate);
      setPlData(response.data);
    } catch (error) {
      console.error('Error loading P&L:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadBalanceSheet = async () => {
    try {
      setLoading(true);
      const response = await reportAPI.balanceSheet(entityId, bsDate);
      setBsData(response.data);
    } catch (error) {
      console.error('Error loading Balance Sheet:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tabValue === 0) loadIncomeStatement();
    else if (tabValue === 1) loadBalanceSheet();
  }, [tabValue]);

  return (
    <Box>
      <Typography variant="h4" sx={{ mb: 3 }}>Financial Reports</Typography>

      <Tabs value={tabValue} onChange={(e, v) => setTabValue(v)} sx={{ mb: 3 }}>
        <Tab label="Income Statement" />
        <Tab label="Balance Sheet" />
      </Tabs>

      {/* Income Statement */}
      <TabPanel value={tabValue} index={0}>
        <Paper sx={{ p: 3, mb: 3 }}>
          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={12} sm={5}>
              <TextField
                fullWidth
                type="date"
                label="Start Date"
                value={plStartDate}
                onChange={(e) => setPlStartDate(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
            <Grid item xs={12} sm={5}>
              <TextField
                fullWidth
                type="date"
                label="End Date"
                value={plEndDate}
                onChange={(e) => setPlEndDate(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
            <Grid item xs={12} sm={2} sx={{ display: 'flex', alignItems: 'flex-end' }}>
              <Button fullWidth variant="contained" onClick={loadIncomeStatement} disabled={loading}>
                {loading ? <CircularProgress size={24} /> : 'Load'}
              </Button>
            </Grid>
          </Grid>
        </Paper>

        {plData && (
          <Paper sx={{ p: 3 }}>
            <Typography variant="h5" align="center" sx={{ mb: 3, fontWeight: 'bold' }}>
              Income Statement
            </Typography>
            <Typography variant="body2" align="center" sx={{ mb: 4, color: 'textSecondary' }}>
              For the period {plData.period.startDate} to {plData.period.endDate}
            </Typography>

            {/* Revenues */}
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow sx={{ backgroundColor: '#f5f5f5' }}>
                    <TableCell sx={{ fontWeight: 'bold' }}>Revenues</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>Amount</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {plData.revenues.map((rev) => (
                    <TableRow key={rev.accountNumber}>
                      <TableCell sx={{ pl: 4 }}>{rev.accountName}</TableCell>
                      <TableCell align="right">
                        ${rev.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow sx={{ backgroundColor: '#e3f2fd', fontWeight: 'bold' }}>
                    <TableCell sx={{ fontWeight: 'bold' }}>Total Revenues</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>
                      ${plData.totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </TableContainer>

            {/* Expenses */}
            <TableContainer sx={{ mt: 3 }}>
              <Table>
                <TableHead>
                  <TableRow sx={{ backgroundColor: '#fff3e0' }}>
                    <TableCell sx={{ fontWeight: 'bold' }}>Expenses</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>Amount</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {plData.expenses.map((exp) => (
                    <TableRow key={exp.accountNumber}>
                      <TableCell sx={{ pl: 4 }}>{exp.accountName}</TableCell>
                      <TableCell align="right">
                        ${exp.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow sx={{ backgroundColor: '#fff3e0', fontWeight: 'bold' }}>
                    <TableCell sx={{ fontWeight: 'bold' }}>Total Expenses</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold' }}>
                      ${plData.totalExpense.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </TableContainer>

            {/* Net Income */}
            <Card sx={{ mt: 3, backgroundColor: plData.netIncome >= 0 ? '#e8f5e9' : '#ffebee' }}>
              <CardContent>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography variant="h6" sx={{ fontWeight: 'bold' }}>Net Income (Loss)</Typography>
                  <Typography
                    variant="h5"
                    sx={{
                      fontWeight: 'bold',
                      color: plData.netIncome >= 0 ? '#388e3c' : '#d32f2f'
                    }}
                  >
                    ${plData.netIncome.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </Typography>
                </Box>
              </CardContent>
            </Card>
          </Paper>
        )}
      </TabPanel>

      {/* Balance Sheet */}
      <TabPanel value={tabValue} index={1}>
        <Paper sx={{ p: 3, mb: 3 }}>
          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={12} sm={5}>
              <TextField
                fullWidth
                type="date"
                label="As of Date"
                value={bsDate}
                onChange={(e) => setBsDate(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
            <Grid item xs={12} sm={7} sx={{ display: 'flex', alignItems: 'flex-end' }}>
              <Button fullWidth variant="contained" onClick={loadBalanceSheet} disabled={loading}>
                {loading ? <CircularProgress size={24} /> : 'Load'}
              </Button>
            </Grid>
          </Grid>
        </Paper>

        {bsData && (
          <Paper sx={{ p: 3 }}>
            <Typography variant="h5" align="center" sx={{ mb: 3, fontWeight: 'bold' }}>
              Balance Sheet
            </Typography>
            <Typography variant="body2" align="center" sx={{ mb: 4, color: 'textSecondary' }}>
              As of {bsData.asOfDate}
            </Typography>

            <Grid container spacing={3}>
              {/* Assets */}
              <Grid item xs={12} md={6}>
                <TableContainer>
                  <Table>
                    <TableHead>
                      <TableRow sx={{ backgroundColor: '#e3f2fd' }}>
                        <TableCell sx={{ fontWeight: 'bold' }}>ASSETS</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 'bold' }}>Amount</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {bsData.assets.map((asset) => (
                        <TableRow key={asset.accountNumber}>
                          <TableCell sx={{ pl: 4 }}>{asset.accountName}</TableCell>
                          <TableCell align="right">
                            ${asset.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow sx={{ backgroundColor: '#bbdefb', fontWeight: 'bold' }}>
                        <TableCell sx={{ fontWeight: 'bold' }}>Total Assets</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 'bold' }}>
                          ${bsData.totalAssets.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </TableContainer>
              </Grid>

              {/* Liabilities & Equity */}
              <Grid item xs={12} md={6}>
                <TableContainer>
                  <Table>
                    <TableHead>
                      <TableRow sx={{ backgroundColor: '#fff3e0' }}>
                        <TableCell sx={{ fontWeight: 'bold' }}>LIABILITIES & EQUITY</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 'bold' }}>Amount</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {bsData.liabilities.map((liability) => (
                        <TableRow key={liability.accountNumber}>
                          <TableCell sx={{ pl: 4 }}>{liability.accountName}</TableCell>
                          <TableCell align="right">
                            ${liability.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow sx={{ backgroundColor: '#f3e5f5' }}>
                        <TableCell sx={{ fontWeight: 'bold', pt: 2 }}>Equity</TableCell>
                        <TableCell align="right" />
                      </TableRow>
                      {bsData.equity.map((eq) => (
                        <TableRow key={eq.accountNumber}>
                          <TableCell sx={{ pl: 4 }}>{eq.accountName}</TableCell>
                          <TableCell align="right">
                            ${eq.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow sx={{ backgroundColor: '#ffe0b2', fontWeight: 'bold' }}>
                        <TableCell sx={{ fontWeight: 'bold' }}>Total Liabilities & Equity</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 'bold' }}>
                          ${bsData.totalLiabilitiesAndEquity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </TableContainer>
              </Grid>
            </Grid>
          </Paper>
        )}
      </TabPanel>
    </Box>
  );
}
