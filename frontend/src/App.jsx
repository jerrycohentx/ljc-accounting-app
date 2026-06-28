import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import LoginPage from './pages/LoginPage';
import ProtectedRoute from './components/ProtectedRoute';
import { EntityProvider } from './qbd/EntityContext';
import QBDLayout from './qbd/QBDLayout';
import QBDHome from './qbd/QBDHome';
import QBDChartOfAccounts from './qbd/QBDChartOfAccounts';
import QBDRegister from './qbd/QBDRegister';
import QBDReports from './qbd/QBDReports';
import QBDJournalEntry from './qbd/QBDJournalEntry';
import QBDCashEntry from './qbd/QBDCashEntry';
import QBDReconcile from './qbd/QBDReconcile';
import ReconcileRedirect from './qbd/ReconcileRedirect';
import QBDBankFeeds from './qbd/QBDBankFeeds';
import QBDPeriodClose from './qbd/QBDPeriodClose';
import QBDTaxFinancials from './qbd/QBDTaxFinancials';
import Receipts from './pages/Receipts';
import BankImport from './pages/BankImport';

const theme = createTheme({
  palette: { primary: { main: '#1976d2' }, secondary: { main: '#dc004e' }, background: { default: '#f5f5f5' } },
  typography: { fontFamily: 'Arial, sans-serif' }
});

function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Router>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <EntityProvider>
                  <QBDLayout />
                </EntityProvider>
              </ProtectedRoute>
            }
          >
            <Route index element={<QBDHome />} />
            <Route path="accounts" element={<QBDChartOfAccounts />} />
            <Route path="register/:accountId" element={<QBDRegister />} />
            <Route path="reports" element={<QBDReports />} />
            <Route path="tax-financials" element={<QBDTaxFinancials />} />
            <Route path="journal" element={<QBDJournalEntry />} />
            <Route path="write-checks" element={<QBDCashEntry mode="check" />} />
            <Route path="make-deposits" element={<QBDCashEntry mode="deposit" />} />
            <Route path="reconcile" element={<QBDReconcile />} />
            <Route path="bank-feeds" element={<QBDBankFeeds />} />
            <Route path="period-close" element={<QBDPeriodClose />} />
            <Route path="receipts" element={<Receipts />} />
            <Route path="bank-import" element={<BankImport />} />
            {/* Single bank reconcile screen — legacy paths redirect here */}
            <Route path="bank-reconciliation" element={<ReconcileRedirect />} />
            <Route path="bank-reconciliation/*" element={<ReconcileRedirect />} />
            <Route path="reconciliation" element={<ReconcileRedirect />} />
            <Route path="reconciliation/*" element={<ReconcileRedirect />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </ThemeProvider>
  );
}

export default App;
