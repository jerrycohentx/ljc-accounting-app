import express from 'express';
import jwt from 'jsonwebtoken';
import bcryptjs from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../config/database.js';
import { issuePasswordResetCode, verifyPasswordResetCode } from '../lib/password-reset-store.js';
import { isSmsConfigured, sendPasswordResetSms, maskPhone } from '../lib/outbound-sms.js';
import { resolvePhoneForUser } from '../lib/user-phone.js';

const router = express.Router();

const GENERIC_RESET_MSG = 'If that email is registered, a verification code was sent by text message.';

// POST /auth/forgot-password/request — step 1: SMS verification code
router.post('/forgot-password/request', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const db = await getDatabase();
    const user = await db.get('SELECT id, email, full_name FROM users WHERE email = ? AND is_active = 1', email);

    if (!user) {
      return res.json({ message: GENERIC_RESET_MSG });
    }

    const phone = await resolvePhoneForUser(db, email);
    if (!phone) {
      console.warn('[password-reset] No phone on file for', email);
      return res.status(400).json({
        error: 'No mobile number on file for this account. Contact support to add your phone number.',
      });
    }

    const { code, expiresMinutes } = await issuePasswordResetCode(db, email);

    if (!isSmsConfigured()) {
      console.warn('[password-reset] Twilio not configured — code not sent for', email);
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[password-reset] DEV code:', code, 'phone:', phone);
        return res.json({
          message: `${GENERIC_RESET_MSG} (Dev: ${maskPhone(phone)})`,
          devCode: code,
          smsConfigured: false,
          sentTo: maskPhone(phone),
        });
      }
      return res.status(503).json({
        error: 'Text message reset is not configured yet. Contact support.',
      });
    }

    await sendPasswordResetSms({ to: phone, code, expiresMinutes });
    return res.json({
      message: `${GENERIC_RESET_MSG} Sent to ${maskPhone(phone)}.`,
      smsConfigured: true,
      sentTo: maskPhone(phone),
    });
  } catch (error) {
    console.error('Forgot password request error:', error);
    return res.status(500).json({ error: 'Could not send verification code' });
  }
});

// POST /auth/forgot-password/reset — step 2: code + new password
router.post('/forgot-password/reset', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    const newPassword = String(req.body.newPassword || '');

    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'Email, verification code, and new password required' });
    }
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Verification code must be 6 digits' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const db = await getDatabase();
    const verify = await verifyPasswordResetCode(db, email, code);

    if (!verify.ok) {
      const messages = {
        no_code: 'No reset code found — request a new one',
        expired: 'Code expired — request a new one',
        too_many_attempts: 'Too many attempts — request a new code',
        invalid_code: 'Invalid verification code',
      };
      return res.status(400).json({ error: messages[verify.reason] || 'Invalid verification code' });
    }

    const user = await db.get('SELECT id FROM users WHERE email = ? AND is_active = 1', email);
    if (!user) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const passwordHash = await bcryptjs.hash(newPassword, 10);
    await db.run(
      'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [passwordHash, user.id]
    );

    return res.json({ message: 'Password updated — you can log in now' });
  } catch (error) {
    console.error('Forgot password reset error:', error);
    return res.status(500).json({ error: 'Password reset failed' });
  }
});

// POST /auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, fullName } = req.body;

    if (!email || !password || !fullName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const db = await getDatabase();
    const existing = await db.get('SELECT id FROM users WHERE email = ?', email);

    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcryptjs.hash(password, 10);
    const userId = `usr-${uuidv4()}`;

    await db.run(
      'INSERT INTO users (id, email, password_hash, full_name, role, entities_access) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, email, passwordHash, fullName, 'USER', JSON.stringify(['ent-ljc'])]
    );

    return res.status(201).json({
      message: 'User registered successfully',
      userId
    });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const db = await getDatabase();
    const user = await db.get('SELECT * FROM users WHERE email = ? AND is_active = 1', email);

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isValid = await bcryptjs.compare(password, user.password_hash);

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    await db.run(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
      user.id
    );

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        entitiesAccess: user.entities_access ? JSON.parse(user.entities_access) : []
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// POST /auth/loan-tracker-token — machine login for LJC Loan Tracker (holdback export)
router.post('/loan-tracker-token', async (req, res) => {
  try {
    const key = req.headers['x-loan-tracker-key'];
    const expected = process.env.LOAN_TRACKER_INTEGRATION_KEY;

    if (!expected || !key || key !== expected) {
      return res.status(401).json({ error: 'Invalid integration key' });
    }

    const email = process.env.LOAN_TRACKER_USER_EMAIL || 'demo@ljcfinancial.com';
    const db = await getDatabase();
    const user = await db.get('SELECT * FROM users WHERE email = ? AND is_active = 1', email);

    if (!user) {
      return res.status(404).json({ error: 'Integration user not found' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        entitiesAccess: user.entities_access ? JSON.parse(user.entities_access) : [],
      },
    });
  } catch (error) {
    console.error('Loan tracker token error:', error);
    return res.status(500).json({ error: 'Integration login failed' });
  }
});

// POST /auth/refresh
router.post('/refresh', (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });

    const newToken = jwt.sign(
      { userId: decoded.userId, email: decoded.email, role: decoded.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.json({ token: newToken });
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

export default router;
