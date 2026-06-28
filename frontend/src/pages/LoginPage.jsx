import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Container, Paper, TextField, Button, Typography, Alert,
  Tabs, Tab, CircularProgress, Link
} from '@mui/material';
import { authAPI } from '../services/api';

export default function LoginPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState(0);
  const [view, setView] = useState('auth'); // auth | forgot-request | forgot-reset
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [buildLabel, setBuildLabel] = useState('');

  useEffect(() => {
    fetch('/health')
      .then((r) => r.json())
      .then((d) => setBuildLabel(d.app || d.version || ''))
      .catch(() => {});
  }, []);

  const [formData, setFormData] = useState({
    email: 'demo@ljcfinancial.com',
    password: 'demo123',
    fullName: 'Demo User',
    code: '',
    newPassword: '',
    confirmPassword: '',
  });

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
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
      setFormData({ ...formData, fullName: '' });
      const response = await authAPI.login(formData.email, formData.password);
      localStorage.setItem('token', response.data.token);
      localStorage.setItem('user', JSON.stringify(response.data.user));
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
      setSuccess(response.data.message || 'Verification code sent');
      if (response.data.devCode) {
        setSuccess(`${response.data.message} Code: ${response.data.devCode}`);
      }
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
      setFormData(prev => ({
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

  const goForgot = () => {
    setView('forgot-request');
    setError('');
    setSuccess('');
    setFormData(prev => ({ ...prev, code: '', newPassword: '', confirmPassword: '' }));
  };

  const goBackLogin = () => {
    setView('auth');
    setTab(0);
    setError('');
    setSuccess('');
  };

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
                />

                {tab === 0 && (
                  <Box sx={{ textAlign: 'right', mt: 1 }}>
                    <Link component="button" type="button" variant="body2" onClick={goForgot}>
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
                Enter your email. We will text a 6-digit verification code to your mobile number on file.
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
                />
                <Button fullWidth variant="contained" size="large" type="submit" sx={{ mt: 3 }} disabled={loading}>
                  {loading ? <CircularProgress size={24} /> : 'Send text verification code'}
                </Button>
                <Button fullWidth sx={{ mt: 1 }} onClick={goBackLogin} disabled={loading}>
                  Back to login
                </Button>
              </form>
            </>
          )}

          {view === 'forgot-reset' && (
            <>
              <Typography variant="h6" sx={{ mb: 2 }}>Reset password — step 2</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Enter the 6-digit code from your text message and choose a new password.
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
                />
                <Button fullWidth variant="contained" size="large" type="submit" sx={{ mt: 3 }} disabled={loading}>
                  {loading ? <CircularProgress size={24} /> : 'Set new password'}
                </Button>
                <Button
                  fullWidth
                  sx={{ mt: 1 }}
                  onClick={() => setView('forgot-request')}
                  disabled={loading}
                >
                  Resend text code
                </Button>
                <Button fullWidth sx={{ mt: 1 }} onClick={goBackLogin} disabled={loading}>
                  Back to login
                </Button>
              </form>
            </>
          )}

          {view === 'auth' && (
            <Typography variant="caption" align="center" display="block" sx={{ mt: 2 }}>
              Demo credentials: demo@ljcfinancial.com / demo123
            </Typography>
          )}
          {buildLabel && (
            <Typography variant="caption" align="center" display="block" sx={{ mt: 1, color: 'text.secondary' }}>
              Server {buildLabel}
            </Typography>
          )}
        </Paper>
      </Container>
    </Box>
  );
}
