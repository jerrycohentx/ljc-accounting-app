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
import QBDBankFeeds from './qbd/QBDBankFeeds';
import Reconciliation from './pages/Reconciliation';
import BankImport from './pages/BankImport';
import DocumentCapture from './pages/DocumentCapture';
import BankReconciliation from './pages/BankReconciliation';

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
            <Route path="journal" element={<QBDJournalEntry />} />
            <Route path="write-checks" element={<QBDCashEntry mode="check" />} />
            <Route path="make-deposits" element={<QBDCashEntry mode="deposit" />} />
            <Route path="reconcile" element={<QBDReconcile />} />
            <Route path="bank-feeds" element={<QBDBankFeeds />} />
            <Route path="reconciliation" element={<Reconciliation />} />
            <Route path="bank-import" element={<BankImport />} />
            <Route path="bank-reconciliation" element={<BankReconciliation />} />
            <Route path="document-capture" element={<DocumentCapture />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </ThemeProvider>
  );
}

export default App;
