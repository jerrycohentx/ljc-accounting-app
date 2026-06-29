#!/usr/bin/env node
import { getPasswordResetEmailChannels } from '../lib/outbound-mail.js';
import { isSmsConfigured } from '../lib/outbound-sms.js';

const channels = getPasswordResetEmailChannels();
const sms = isSmsConfigured();
const email = Object.values(channels).some(Boolean);

console.log('password reset channels:', { sms, email, ...channels });
if (!sms && !email && process.env.CI === 'true') {
  console.error('FAIL: no password reset channels in CI');
  process.exit(1);
}
console.log('✓ password reset channel check complete');
