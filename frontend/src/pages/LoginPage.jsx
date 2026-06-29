import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Container, Paper, TextField, Button, Typography, Alert,
  Tabs, Tab, CircularProgress, Link, InputAdornment
} from '@mui/material';
import { authAPI } from '../services/api';
import LoginStatusPanel from '../components/LoginStatusPanel';

const EMPTY_FORM = {
  email: '',
  password: '',
  fullName: '',
  code: '',
  newPassword: '',
  confirmPassword: '',
};

const LAST_EMAIL_KEY = 'ljc_last_login_email';
const DEMO_EMAIL = 'demo@ljcfinancial.com';
const IS_PRODUCTION_HOST = typeof window !== 'undefined'
  && !/localhost|127\.0\.0\.1/.test(window.location.hostname);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isDemoEmail(email) {
  return normalizeEmail(email) === DEMO_EMAIL;
}

function PasswordField({
  name, label, value, onChange, disabled, show, onToggleShow, helperText, autoComplete, autoFocus,
}) {
  return (
    <TextField
      fullWidth
      label={label}
      name={name}
      type={show ? 'text' : 'password'}
      value={value}
      onChange={onChange}
      margin="normal"
      disabled={disabled}
      helperText={helperText}
      autoComplete={autoComplete}
      autoFocus={autoFocus}
      InputProps={{
        endAdornment: (
          <InputAdornment position="end">
            <Button
              type="button"
              size="small"
              variant="outlined"
              onClick={onToggleShow}
              sx={{ fontSize: 12, minWidth: 52, py: 0.25 }}
            >
              {show ? 'Hide' : 'Show'}
            </Button>
          </InputAdornment>
        ),
      }}
    />
  );
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState(0);
  const [view, setView] = useState('auth');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [resetChannel, setResetChannel] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const forgotOpenedAt = useRef(0);

  const [formData, setFormData] = useState(EMPTY_FORM);
  const [emailReadOnly, setEmailReadOnly] = useState(true);

  useEffect(() => {
    // Fresh login screen — drop stale demo session so a new sign-in sticks
    localStorage.removeItem('token');
    localStorage.removeItem('user');

    try {
      const saved = normalizeEmail(
        localStorage.getItem(LAST_EMAIL_KEY)
        || sessionStorage.getItem('ljc_login_email')
        || ''
      );
      if (saved && !isDemoEmail(saved)) {
        setFormData((prev) => ({ ...prev, email: saved, password: '' }));
      } else if (isDemoEmail(saved)) {
        localStorage.removeItem(LAST_EMAIL_KEY);
        sessionStorage.removeItem('ljc_login_email');
      }
    } catch {
      // ignore
    }

    const t = setTimeout(() => setEmailReadOnly(false), 150);

    try {
      if (sessionStorage.getItem('ljc_session_expired')) {
        sessionStorage.removeItem('ljc_session_expired');
        setError('Your session expired — please sign in again with your account (not the demo user).');
      }
    } catch {
      // ignore
    }

    return () => clearTimeout(t);
  }, []);

  const persistEmail = (email) => {
    const normalized = normalizeEmail(email);
    if (!normalized || isDemoEmail(normalized)) return;
    try {
      localStorage.setItem(LAST_EMAIL_KEY, normalized);
      sessionStorage.setItem('ljc_login_email', normalized);
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
    setError('');
    const fd = new FormData(e.currentTarget);
    const email = normalizeEmail(fd.get('email') || formData.email);
    const password = String(fd.get('password') ?? formData.password);
    if (isDemoEmail(email) && IS_PRODUCTION_HOST) {
      setError('Use your LJC account (e.g. jerry@ljcfinancial.com), not the demo user.');
      setLoading(false);
      return;
    }
    try {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      const response = await authAPI.login(email, password);
      localStorage.setItem('token', response.data.token);
      localStorage.setItem('user', JSON.stringify(response.data.user));
      persistEmail(email);
      setFormData((prev) => ({ ...prev, email, password: '' }));
      navigate('/', { replace: true });
    } catch (err) {
      const msg = err.response?.data?.error || 'Login failed';
      if (msg === 'Invalid email or password') {
        setError(
          email.includes('jerry@')
            ? 'Invalid password for jerry@ljcfinancial.com. Click Show on the password field to verify what you typed, or use Forgot password? to reset via text.'
            : 'Invalid email or password. Clear the password field and type it again — browser autofill often inserts the demo password by mistake.'
        );
      } else {
        setError(msg);
      }
      setFormData((prev) => ({ ...prev, password: '' }));
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
      const msg = err.response?.data?.error || 'Could not send verification code';
      if (msg.includes('not fully configured')) {
        setError('Password reset email/text is not set up on the server yet. Go back to Login and sign in with your current password.');
      } else {
        setError(msg);
      }
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
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        py: 3,
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

              <form onSubmit={tab === 0 ? handleLogin : handleRegister} autoComplete="off">
                <input type="text" name="fake_user" autoComplete="username" style={{ display: 'none' }} tabIndex={-1} aria-hidden="true" />
                <input type="password" name="fake_pass" autoComplete="current-password" style={{ display: 'none' }} tabIndex={-1} aria-hidden="true" />
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
                  autoComplete="off"
                  inputProps={{
                    readOnly: emailReadOnly,
                    'data-lpignore': 'true',
                    'data-form-type': 'other',
                  }}
                  onFocus={() => setEmailReadOnly(false)}
                />

                <PasswordField
                  name="password"
                  label="Password"
                  value={formData.password}
                  onChange={handleInputChange}
                  disabled={loading}
                  show={showPassword}
                  onToggleShow={() => setShowPassword((v) => !v)}
                  autoComplete="off"
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
                <PasswordField
                  name="newPassword"
                  label="New password"
                  value={formData.newPassword}
                  onChange={handleInputChange}
                  disabled={loading}
                  show={showNewPassword}
                  onToggleShow={() => setShowNewPassword((v) => !v)}
                  helperText="At least 8 characters"
                  autoComplete="new-password"
                />
                <PasswordField
                  name="confirmPassword"
                  label="Confirm new password"
                  value={formData.confirmPassword}
                  onChange={handleInputChange}
                  disabled={loading}
                  show={showNewPassword}
                  onToggleShow={() => setShowNewPassword((v) => !v)}
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

          {view === 'auth' && !IS_PRODUCTION_HOST && (
            <Typography variant="caption" align="center" display="block" sx={{ mt: 2, color: 'text.secondary' }}>
              Dev demo: demo@ljcfinancial.com / demo123
            </Typography>
          )}
          {view === 'auth' && IS_PRODUCTION_HOST && (
            <Typography variant="caption" align="center" display="block" sx={{ mt: 2, color: 'text.secondary' }}>
              Sign in with your LJC account (e.g. jerry@ljcfinancial.com). Use <strong>Forgot password?</strong> if needed.
            </Typography>
          )}

          <LoginStatusPanel />
        </Paper>
      </Container>
    </Box>
  );
}
