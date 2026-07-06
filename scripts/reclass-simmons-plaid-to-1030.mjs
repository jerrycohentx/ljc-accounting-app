#!/usr/bin/env node
/**
 * Reclass posted Simmons Plaid bank lines from GL 1000 → 1030 (ent-ljc).
 * Usage: node scripts/reclass-simmons-plaid-to-1030.mjs [--dry-run]
 */

import { getDatabase } from '../config/database.js';
import { reclassPostedSimmonsPlaidBankAccount } from '../lib/reclass-simmons-plaid.js';
import { resolveAutomationUserId } from '../lib/system-user.js';

const dryRun = process.argv.includes('--dry-run');

const db = await getDatabase();
const userId = await resolveAutomationUserId(db);
const result = await reclassPostedSimmonsPlaidBankAccount(db, { userId, dryRun });

console.log(JSON.stringify({ dryRun, ...result }, null, 2));
if (result.errors?.length) process.exit(1);
