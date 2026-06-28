/**
 * User phone column + lookup for password-reset SMS.
 */

import { normalizePhone } from './outbound-sms.js';

let phoneColumnEnsured = false;

export async function ensureUserPhoneColumn(db) {
  if (phoneColumnEnsured) return;
  try {
    await db.run('ALTER TABLE users ADD COLUMN phone TEXT');
  } catch {
    // column already exists
  }
  phoneColumnEnsured = true;
}

function phonesFromEnv() {
  const raw = process.env.PASSWORD_RESET_PHONES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const out = {};
      for (const [email, phone] of Object.entries(parsed)) {
        out[String(email).trim().toLowerCase()] = normalizePhone(phone);
      }
      return out;
    }
  } catch {
    // ignore
  }
  return {};
}

/** Apply ADMIN_PHONE to admin user when phone column is empty. */
export async function syncAdminPhoneFromEnv(db) {
  await ensureUserPhoneColumn(db);
  const phone = normalizePhone(process.env.ADMIN_PHONE);
  if (!phone) return;
  const email = (process.env.ADMIN_EMAIL || 'jerry@ljcfinancial.com').trim().toLowerCase();
  await db.run(
    'UPDATE users SET phone = ? WHERE email = ? AND (phone IS NULL OR phone = \'\')',
    [phone, email]
  );
}

/**
 * Resolve mobile number for password reset (DB, then env map, then ADMIN_PHONE for admin email).
 */
export async function resolvePhoneForUser(db, email) {
  await ensureUserPhoneColumn(db);
  await syncAdminPhoneFromEnv(db);

  const normalizedEmail = String(email || '').trim().toLowerCase();
  const user = await db.get(
    'SELECT email, phone FROM users WHERE email = ? AND is_active = 1',
    normalizedEmail
  );
  if (!user) return null;

  const fromDb = normalizePhone(user.phone);
  if (fromDb) return fromDb;

  const envMap = phonesFromEnv();
  if (envMap[normalizedEmail]) return envMap[normalizedEmail];

  const adminEmail = (process.env.ADMIN_EMAIL || 'jerry@ljcfinancial.com').trim().toLowerCase();
  if (normalizedEmail === adminEmail) {
    const adminPhone = normalizePhone(process.env.ADMIN_PHONE);
    if (adminPhone) return adminPhone;
  }

  return null;
}
