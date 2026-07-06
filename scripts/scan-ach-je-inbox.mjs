#!/usr/bin/env node
import dotenv from 'dotenv';
import { getDatabase, closeDatabase } from '../config/database.js';
import { runAchJeInboxScan } from '../lib/ach-je-inbox-worker.js';

dotenv.config();
const summary = await runAchJeInboxScan(getDatabase, { reason: 'cli' });
console.log(JSON.stringify(summary, null, 2));
await closeDatabase();
