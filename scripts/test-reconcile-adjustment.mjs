#!/usr/bin/env node
import { postReconcileAdjustment } from '../lib/reconcile-adjustment.js';

// Smoke: module loads and rejects zero difference
try {
  await postReconcileAdjustment(null, {
    entityId: 'x',
    accountId: 'y',
    statementDate: '2026-01-31',
    difference: 0,
  });
  console.error('FAIL: should reject zero difference');
  process.exit(1);
} catch (e) {
  if (!String(e.message).includes('already zero')) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
}
console.log('✓ reconcile adjustment module loads');
