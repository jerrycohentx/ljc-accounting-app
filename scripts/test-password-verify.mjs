#!/usr/bin/env node
import { verifyPassword } from '../lib/password-verify.js';

async function testBcrypt() {
  const hash = '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012';
  // use real hash
  const bcrypt = await import('bcryptjs');
  const h = await bcrypt.default.hash('secret123', 10);
  const r = await verifyPassword('secret123', h);
  if (!r.ok || r.upgradedHash) throw new Error('bcrypt verify failed');
  console.log('✓ bcrypt verify');
}

async function testLegacyPlain() {
  const r = await verifyPassword('ChangeMe123!', 'ChangeMe123!');
  if (!r.ok || !r.upgradedHash) throw new Error('legacy plain verify failed');
  console.log('✓ legacy plain-text upgrade');
}

async function testWrong() {
  const r = await verifyPassword('wrong', 'ChangeMe123!');
  if (r.ok) throw new Error('should reject wrong password');
  console.log('✓ rejects wrong password');
}

try {
  await testBcrypt();
  await testLegacyPlain();
  await testWrong();
  console.log('\nAll password verify tests passed.');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
