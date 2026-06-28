/**
 * Two-step password reset codes (email verification).
 */

import bcryptjs from 'bcryptjs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const DDL = `
CREATE TABLE IF NOT EXISTS password_reset_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_password_reset_email ON password_reset_codes(email);
`;

export async function ensurePasswordResetTable(db) {
  for (const stmt of DDL.split(';').filter((s) => s.trim())) {
    await db.run(stmt);
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

export async function issuePasswordResetCode(db, email) {
  await ensurePasswordResetTable(db);
  const normalized = normalizeEmail(email);
  const code = generateCode();
  const codeHash = await bcryptjs.hash(code, 10);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  const id = `prc-${uuidv4()}`;

  await db.run('DELETE FROM password_reset_codes WHERE email = ?', normalized);
  await db.run(
    'INSERT INTO password_reset_codes (id, email, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?, 0)',
    [id, normalized, codeHash, expiresAt]
  );

  return { code, expiresAt, expiresMinutes: CODE_TTL_MS / 60000 };
}

export async function verifyPasswordResetCode(db, email, code) {
  await ensurePasswordResetTable(db);
  const normalized = normalizeEmail(email);
  const row = await db.get(
    'SELECT * FROM password_reset_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1',
    normalized
  );

  if (!row) return { ok: false, reason: 'no_code' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  const match = await bcryptjs.compare(String(code).trim(), row.code_hash);
  if (!match) {
    await db.run(
      'UPDATE password_reset_codes SET attempts = attempts + 1 WHERE id = ?',
      row.id
    );
    return { ok: false, reason: 'invalid_code' };
  }

  await db.run('DELETE FROM password_reset_codes WHERE email = ?', normalized);
  return { ok: true };
}
