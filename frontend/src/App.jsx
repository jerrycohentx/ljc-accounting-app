import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import LoginPage from './pages/LoginPage';
import DashboardLayout from './components/DashboardLayout';
import Dashboard from './pages/Dashboard';
import ChartOfAccounts from './pages/ChartOfAccounts';
import GeneralLedger from './pages/GeneralLedger';
import JournalEntry from './pages/JournalEntry';
import Reports from './pages/Reports';
import Reconciliation from './pages/Reconciliation';
import Receipts from './pages/Receipts';
import ProtectedRoute from './components/ProtectedRoute';

const theme = createTheme({
  palette: {
    primary: { main: '#1976d2' },
    secondary: { main: '#dc004e' },
    background: { default: '#f5f5f5' }
  },
  typography: {
    fontFamily: 'Arial, sans-serif',
    h4: { fontWeight: 600, fontSize: '1.8rem' },
    h5: { fontWeight: 600, fontSize: '1.4rem' },
    h6: { fontWeight: 600, fontSize: '1.1rem' }
  }
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
                <DashboardLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="accounts" element={<ChartOfAccounts />} />
            <Route path="ledger" element={<GeneralLedger />} />
            <Route path="journal" element={<JournalEntry />} />
            <Route path="receipts" element={<Receipts />} />
            <Route path="reports" element={<Reports />} />
            <Route path="reconciliation" element={<Reconciliation />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </ThemeProvider>
  );
}

export default App;
