import bcryptjs from 'bcryptjs';

function isBcryptHash(hash) {
  return typeof hash === 'string' && /^\$2[aby]\$/.test(hash);
}

/**
 * Verify password against stored hash. Supports legacy plain-text hashes (migrates on success).
 * @returns {Promise<{ ok: boolean, upgradedHash: string|null }>}
 */
export async function verifyPassword(password, storedHash) {
  if (!storedHash) return { ok: false, upgradedHash: null };

  if (isBcryptHash(storedHash)) {
    const ok = await bcryptjs.compare(password, storedHash);
    return { ok, upgradedHash: null };
  }

  // Legacy: password stored as plain text in password_hash column
  if (password === storedHash) {
    const upgradedHash = await bcryptjs.hash(password, 10);
    return { ok: true, upgradedHash };
  }

  return { ok: false, upgradedHash: null };
}

/** Upgrade any plain-text password_hash rows to bcrypt (password = stored string). */
export async function repairPlainTextPasswordHashes(db) {
  const rows = await db.all('SELECT id, email, password_hash FROM users WHERE is_active = 1');
  let repaired = 0;
  for (const row of rows || []) {
    if (!row.password_hash || isBcryptHash(row.password_hash)) continue;
    const hash = await bcryptjs.hash(String(row.password_hash), 10);
    await db.run(
      'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [hash, row.id]
    );
    repaired += 1;
    console.log(`[auth] Upgraded legacy plain-text password hash for ${row.email}`);
  }
  return repaired;
}
