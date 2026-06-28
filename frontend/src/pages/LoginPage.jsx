import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Container, Paper, TextField, Button, Typography, Alert,
  Tabs, Tab, CircularProgress, Link
} from '@mui/material';
import { authAPI } from '../services/api';
import { formatBackupShort } from '../qbd/QBDBackupDialog';
import { formatEmailScanShort } from '../qbd/QBEmailIngestDialog';

const EMPTY_FORM = {
  email: '',
  password: '',
  fullName: '',
  code: '',
  newPassword: '',
  confirmPassword: '',
};

export default function LoginPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState(0);
  const [view, setView] = useState('auth');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [serverStatus, setServerStatus] = useState(null);
  const [resetChannel, setResetChannel] = useState('');
  const forgotOpenedAt = useRef(0);

  const [formData, setFormData] = useState(EMPTY_FORM);

  useEffect(() => {
    const loadHealth = () => {
      fetch('/health')
        .then((r) => r.json())
        .then((d) => setServerStatus(d))
        .catch(() => {});
    };
    loadHealth();
    const id = setInterval(loadHealth, 60000);
    try {
      const saved = sessionStorage.getItem('ljc_login_email');
      if (saved) setFormData((prev) => ({ ...prev, email: saved }));
    } catch {
      // ignore
    }
    return () => clearInterval(id);
  }, []);

  const persistEmail = (email) => {
    try {
      sessionStorage.setItem('ljc_login_email', email);
    } catch {
      // ignore
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => {
      const next = { ...prev, [name]: value };
      if (name === 'email') persistEmail(value);
      return next;
    });
    setError('');
    setSuccess('');
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const response = await authAPI.login(formData.email, formData.password);
      localStorage.setItem('token', response.data.token);
      localStorage.setItem('user', JSON.stringify(response.data.user));
      persistEmail(formData.email);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await authAPI.register(formData.email, formData.password, formData.fullName);
      setError('');
      setTab(0);
      const response = await authAPI.login(formData.email, formData.password);
      localStorage.setItem('token', response.data.token);
      localStorage.setItem('user', JSON.stringify(response.data.user));
      persistEmail(formData.email);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotRequest = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const response = await authAPI.forgotPasswordRequest(formData.email);
      setResetChannel(response.data.channel || '');
      let msg = response.data.message || 'Verification code sent';
      if (response.data.devCode) {
        msg = `${msg} Your code: ${response.data.devCode}`;
      }
      setSuccess(msg);
      setView('forgot-reset');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send verification code');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotReset = async (e) => {
    e.preventDefault();
    if (formData.newPassword !== formData.confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const response = await authAPI.forgotPasswordReset(
        formData.email,
        formData.code,
        formData.newPassword
      );
      setSuccess(response.data.message || 'Password updated');
      setView('auth');
      setTab(0);
      setFormData((prev) => ({
        ...prev,
        password: prev.newPassword,
        code: '',
        newPassword: '',
        confirmPassword: '',
      }));
    } catch (err) {
      setError(err.response?.data?.error || 'Password reset failed');
    } finally {
      setLoading(false);
    }
  };

  const goForgot = (e) => {
    e?.preventDefault?.();
    forgotOpenedAt.current = Date.now();
    setView('forgot-request');
    setError('');
    setSuccess('');
    setResetChannel('');
    setFormData((prev) => ({ ...prev, code: '', newPassword: '', confirmPassword: '' }));
  };

  const goBackLogin = () => {
    if (Date.now() - forgotOpenedAt.current < 500) return;
    setView('auth');
    setTab(0);
    setError('');
    setSuccess('');
  };

  const forgotHint = resetChannel === 'email'
    ? 'Enter the 6-digit code from your email and choose a new password.'
    : 'Enter the 6-digit code from your text message and choose a new password.';

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
      }}
    >
      <Container maxWidth="sm">
        <Paper elevation={3} sx={{ p: 4 }}>
          <Typography variant="h4" align="center" sx={{ mb: 3, fontWeight: 'bold' }}>
            LJC Accounting System
          </Typography>

          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          {success && <Alert severity="success" sx={{ mb: 2 }}>{success}</Alert>}

          {view === 'auth' && (
            <>
              <Tabs value={tab} onChange={(e, v) => setTab(v)} variant="fullWidth" sx={{ mb: 3 }}>
                <Tab label="Login" />
                <Tab label="Register" />
              </Tabs>

              <form onSubmit={tab === 0 ? handleLogin : handleRegister}>
                {tab === 1 && (
                  <TextField
                    fullWidth
                    label="Full Name"
                    name="fullName"
                    value={formData.fullName}
                    onChange={handleInputChange}
                    margin="normal"
                    disabled={loading}
                  />
                )}

                <TextField
                  fullWidth
                  label="Email"
                  name="email"
                  type="email"
                  value={formData.email}
                  onChange={handleInputChange}
                  margin="normal"
                  disabled={loading}
                  autoComplete="email"
                />

                <TextField
                  fullWidth
                  label="Password"
                  name="password"
                  type="password"
                  value={formData.password}
                  onChange={handleInputChange}
                  margin="normal"
                  disabled={loading}
                  autoComplete={tab === 0 ? 'current-password' : 'new-password'}
                />

                {tab === 0 && (
                  <Box sx={{ textAlign: 'right', mt: 1 }}>
                    <Link
                      component="button"
                      type="button"
                      variant="body2"
                      onClick={goForgot}
                      sx={{ userSelect: 'none' }}
                    >
                      Forgot password?
                    </Link>
                  </Box>
                )}

                <Button
                  fullWidth
                  variant="contained"
                  size="large"
                  type="submit"
                  sx={{ mt: 3 }}
                  disabled={loading}
                >
                  {loading ? <CircularProgress size={24} /> : (tab === 0 ? 'Login' : 'Register')}
                </Button>
              </form>
            </>
          )}

          {view === 'forgot-request' && (
            <>
              <Typography variant="h6" sx={{ mb: 2 }}>Reset password — step 1</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Enter your email. We will send a 6-digit code by text (or email if texting is unavailable).
              </Typography>
              <form onSubmit={handleForgotRequest}>
                <TextField
                  fullWidth
                  label="Email"
                  name="email"
                  type="email"
                  value={formData.email}
                  onChange={handleInputChange}
                  margin="normal"
                  disabled={loading}
                  autoFocus
                  autoComplete="email"
                />
                <Button fullWidth variant="contained" size="large" type="submit" sx={{ mt: 3 }} disabled={loading}>
                  {loading ? <CircularProgress size={24} /> : 'Send verification code'}
                </Button>
                <Button fullWidth sx={{ mt: 2 }} type="button" onClick={goBackLogin} disabled={loading}>
                  Back to login
                </Button>
              </form>
            </>
          )}

          {view === 'forgot-reset' && (
            <>
              <Typography variant="h6" sx={{ mb: 2 }}>Reset password — step 2</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {forgotHint}
              </Typography>
              <form onSubmit={handleForgotReset}>
                <TextField
                  fullWidth
                  label="Email"
                  name="email"
                  type="email"
                  value={formData.email}
                  margin="normal"
                  disabled
                />
                <TextField
                  fullWidth
                  label="Verification code"
                  name="code"
                  value={formData.code}
                  onChange={handleInputChange}
                  margin="normal"
                  disabled={loading}
                  inputProps={{ maxLength: 6, inputMode: 'numeric', pattern: '[0-9]*' }}
                  autoFocus
                />
                <TextField
                  fullWidth
                  label="New password"
                  name="newPassword"
                  type="password"
                  value={formData.newPassword}
                  onChange={handleInputChange}
                  margin="normal"
                  disabled={loading}
                  helperText="At least 8 characters"
                  autoComplete="new-password"
                />
                <TextField
                  fullWidth
                  label="Confirm new password"
                  name="confirmPassword"
                  type="password"
                  value={formData.confirmPassword}
                  onChange={handleInputChange}
                  margin="normal"
                  disabled={loading}
                  autoComplete="new-password"
                />
                <Button fullWidth variant="contained" size="large" type="submit" sx={{ mt: 3 }} disabled={loading}>
                  {loading ? <CircularProgress size={24} /> : 'Set new password'}
                </Button>
                <Button
                  fullWidth
                  sx={{ mt: 2 }}
                  type="button"
                  onClick={() => setView('forgot-request')}
                  disabled={loading}
                >
                  Resend code
                </Button>
                <Button fullWidth sx={{ mt: 1 }} type="button" onClick={goBackLogin} disabled={loading}>
                  Back to login
                </Button>
              </form>
            </>
          )}

          {view === 'auth' && (
            <Typography variant="caption" align="center" display="block" sx={{ mt: 2, color: 'text.secondary' }}>
              Demo login: demo@ljcfinancial.com / demo123
            </Typography>
          )}

          <Box
            sx={{
              mt: 2,
              pt: 1.5,
              borderTop: '2px solid #dbe2ec',
              background: 'linear-gradient(#eef2f7,#e4eaf2)',
              mx: -4,
              mb: -4,
              px: 2,
              py: 1.25,
              borderRadius: '0 0 4px 4px',
              fontSize: 12,
              color: '#42566f',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 1,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span><strong>Version</strong> {serverStatus?.app || serverStatus?.version || '…'}</span>
            <span>|</span>
            <span><strong>Backup</strong> {formatBackupShort(serverStatus?.lastBackupAt)}</span>
            <span>|</span>
            <span><strong>Email</strong> {formatEmailScanShort(serverStatus?.statementEmailIngest?.lastRunAt)}</span>
          </Box>
        </Paper>
      </Container>
    </Box>
  );
}
