/**
 * Outbound email (password reset codes). Configure SMTP on Render.
 */

import nodemailer from 'nodemailer';

let transporter = null;

export function isSmtpConfigured() {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
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
  return process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@ljcfinancial.com';
}

export async function sendPasswordResetCode({ to, code, expiresMinutes = 15 }) {
  const transport = getTransporter();
  if (!transport) {
    throw new Error('SMTP not configured (set SMTP_USER and SMTP_PASS on Render)');
  }

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

  await transport.sendMail({
    from: fromAddress(),
    to,
    subject,
    text,
    html,
  });

  return true;
}
