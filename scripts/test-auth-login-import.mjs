#!/usr/bin/env node
/** Ensures auth login route can call verifyPassword (regression: PR #26 dropped import). */
import { readFileSync } from 'fs';

const src = readFileSync(new URL('../routes/auth.js', import.meta.url), 'utf8');
if (!src.includes("import { verifyPassword } from '../lib/password-verify.js'")) {
  console.error('FAIL: routes/auth.js missing verifyPassword import');
  process.exit(1);
}
if (!src.includes('await verifyPassword(password, user.password_hash)')) {
  console.error('FAIL: routes/auth.js does not call verifyPassword on login');
  process.exit(1);
}
console.log('✓ auth login imports verifyPassword');
