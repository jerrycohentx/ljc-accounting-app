/**
 * Outbound email (password reset codes). SMTP or Resend API.
 */

import nodemailer from 'nodemailer';

let transporter = null;

export function isSmtpConfigured() {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function isResendConfigured() {
  return !!process.env.RESEND_API_KEY;
}

export function isEmailConfigured() {
  return isSmtpConfigured() || isResendConfigured();
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

function fromAddress() {
  return process.env.SMTP_FROM || process.env.RESEND_FROM || process.env.SMTP_USER || 'LJC Accounting <noreply@ljcfinancial.com>';
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
  return true;
}

async function sendViaSmtp({ to, code, expiresMinutes }) {
  const transport = getTransporter();
  if (!transport) throw new Error('SMTP not configured');
  const { subject, text, html } = resetEmailContent(code, expiresMinutes);
  await transport.sendMail({ from: fromAddress(), to, subject, text, html });
  return true;
}

export async function sendPasswordResetCode({ to, code, expiresMinutes = 15 }) {
  if (isResendConfigured()) {
    return sendViaResend({ to, code, expiresMinutes });
  }
  if (isSmtpConfigured()) {
    return sendViaSmtp({ to, code, expiresMinutes });
  }
  throw new Error('Email not configured (set RESEND_API_KEY or SMTP_USER/SMTP_PASS on Render)');
}
