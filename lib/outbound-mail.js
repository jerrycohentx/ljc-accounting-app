/**
 * Outbound email (password reset codes).
 * Tries: Resend → Microsoft Graph → SMTP env → statement IMAP passwords → Gmail OAuth.
 */

import nodemailer from 'nodemailer';
import { getStatementEmailAccounts, getGmailOAuthAccounts, isGmailOAuthConfigured } from './statement-email-config.js';
import { isGraphMailConfigured, sendGraphMail } from './graph-outbound-mail.js';
import { sendGmailOAuthMail } from './gmail-oauth-mail.js';
import { resolveAllMailboxes } from './statement-mailbox-store.js';

let transporter = null;

export function isSmtpConfigured() {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function isResendConfigured() {
  return !!process.env.RESEND_API_KEY;
}

function inferSmtpHost(user) {
  const domain = String(user || '').split('@')[1]?.toLowerCase() || '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'smtp.gmail.com';
  if (domain === 'ljcfinancial.com' || domain.endsWith('.onmicrosoft.com')) return 'smtp.office365.com';
  return process.env.SMTP_HOST || 'smtp.gmail.com';
}

function fromAddress() {
  return process.env.SMTP_FROM || process.env.RESEND_FROM || process.env.SMTP_USER || 'LJC Accounting <onboarding@resend.dev>';
}

function resetEmailContent(code, expiresMinutes) {
  const subject = 'LJC Accounting — password reset code';
  const text = [
    'You requested a password reset for LJC Accounting.',
    '',
    `Verification code: ${code}`,
    '',
    `This code expires in ${expiresMinutes} minutes.`,
    '',
    'If you did not request this, ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;line-height:1.5">
      <h2 style="color:#333">Password reset</h2>
      <p>You requested a password reset for <strong>LJC Accounting</strong>.</p>
      <p style="font-size:28px;letter-spacing:4px;font-weight:bold;color:#1565c0">${code}</p>
      <p>Enter this code on the reset screen. It expires in <strong>${expiresMinutes} minutes</strong>.</p>
      <p style="color:#666;font-size:13px">If you did not request this, ignore this email.</p>
    </div>`;

  return { subject, text, html };
}

export function getPasswordResetEmailChannels(db = null) {
  const channels = {
    resend: isResendConfigured(),
    smtp: isSmtpConfigured(),
    graph: isGraphMailConfigured(),
    statementEnv: getStatementEmailAccounts().some((a) => a.password && a.user),
    gmailOAuthEnv: isGmailOAuthConfigured() && getGmailOAuthAccounts().length > 0,
    statementDb: false,
    gmailOAuthDb: false,
  };
  return channels;
}

export async function isPasswordResetEmailAvailable(db = null) {
  if (isResendConfigured() || isSmtpConfigured() || isGraphMailConfigured()) return true;
  if (getStatementEmailAccounts().some((a) => a.password && a.user)) return true;
  if (isGmailOAuthConfigured() && getGmailOAuthAccounts().length > 0) return true;
  return false;
}

/** @deprecated use isPasswordResetEmailAvailable */
export function isEmailConfigured() {
  return isResendConfigured() || isSmtpConfigured() || isGraphMailConfigured()
    || getStatementEmailAccounts().some((a) => a.password && a.user)
    || (isGmailOAuthConfigured() && getGmailOAuthAccounts().length > 0);
}

function getTransporter() {
  if (transporter) return transporter;
  if (!isSmtpConfigured()) return null;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

async function sendViaResend({ to, code, expiresMinutes }) {
  const { subject, text, html } = resetEmailContent(code, expiresMinutes);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [to],
      subject,
      text,
      html,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Resend email failed');
  return { transport: 'resend', to };
}

async function sendViaSmtpCredentials({ user, pass, host, to, code, expiresMinutes }) {
  const { subject, text, html } = resetEmailContent(code, expiresMinutes);
  const transport = nodemailer.createTransport({
    host: host || inferSmtpHost(user),
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
  });
  await transport.sendMail({
    from: `${fromAddress().replace(/<[^>]+>/, '').trim() || 'LJC Accounting'} <${user}>`,
    to,
    subject,
    text,
    html,
  });
  return { transport: 'smtp', from: user, to };
}

async function sendViaSmtp({ to, code, expiresMinutes }) {
  const transport = getTransporter();
  if (!transport) throw new Error('SMTP not configured');
  const { subject, text, html } = resetEmailContent(code, expiresMinutes);
  await transport.sendMail({ from: fromAddress(), to, subject, text, html });
  return { transport: 'smtp', to };
}

async function tryGmailOAuthAccounts(accounts, { to, code, expiresMinutes }) {
  const { subject, text, html } = resetEmailContent(code, expiresMinutes);
  const errors = [];
  for (const acct of accounts) {
    if (!acct.refresh_token) continue;
    try {
      const result = await sendGmailOAuthMail({
        refreshToken: acct.refresh_token,
        from: acct.user,
        to,
        subject,
        text,
        html,
      });
      return result;
    } catch (err) {
      errors.push(`${acct.user}: ${err.message}`);
    }
  }
  if (errors.length) throw new Error(errors.join('; '));
  throw new Error('No Gmail OAuth accounts available');
}

export async function sendPasswordResetCode({ to, code, expiresMinutes = 15, db = null }) {
  const attempts = [];

  if (isResendConfigured()) {
    attempts.push(async () => sendViaResend({ to, code, expiresMinutes }));
  }
  if (isGraphMailConfigured()) {
    const { subject, text, html } = resetEmailContent(code, expiresMinutes);
    attempts.push(async () => sendGraphMail({ to, subject, text, html }));
  }
  if (isSmtpConfigured()) {
    attempts.push(async () => sendViaSmtp({ to, code, expiresMinutes }));
  }

  for (const acct of getStatementEmailAccounts()) {
    if (!acct.password || !acct.user) continue;
    attempts.push(async () => sendViaSmtpCredentials({
      user: acct.user,
      pass: acct.password,
      host: inferSmtpHost(acct.user),
      to,
      code,
      expiresMinutes,
    }));
  }

  if (isGmailOAuthConfigured() && getGmailOAuthAccounts().length) {
    attempts.push(async () => tryGmailOAuthAccounts(getGmailOAuthAccounts(), { to, code, expiresMinutes }));
  }

  if (db) {
    const mailboxes = await resolveAllMailboxes(db);
    for (const mb of mailboxes) {
      if (mb.password) {
        attempts.push(async () => sendViaSmtpCredentials({
          user: mb.user,
          pass: mb.password,
          host: inferSmtpHost(mb.user),
          to,
          code,
          expiresMinutes,
        }));
      }
      if (mb.refresh_token) {
        const { subject, text, html } = resetEmailContent(code, expiresMinutes);
        attempts.push(async () => sendGmailOAuthMail({
          refreshToken: mb.refresh_token,
          from: mb.user,
          to,
          subject,
          text,
          html,
        }));
      }
    }
  }

  const errors = [];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err) {
      errors.push(err.message);
    }
  }

  throw new Error(
    errors.length
      ? `All email channels failed: ${errors.slice(0, 3).join(' | ')}`
      : 'Email not configured (set RESEND_API_KEY, GRAPH_*, SMTP, or connect Gmail OAuth on Render)'
  );
}
