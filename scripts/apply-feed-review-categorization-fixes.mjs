#!/usr/bin/env node
/**
 * One-shot: seed CRE utility accounts + categorization rules, then re-sweep
 * pending Activity Review items for ent-ljc (Calacta wires, Chase owner draw, ENTEX gas).
 *
 * Usage: node scripts/apply-feed-review-categorization-fixes.mjs
 */
import { getDatabase } from '../config/database.js';
import { seedDefaultRules } from '../lib/categorization-rules.js';
import { seedCreCategorizationRules } from '../lib/cre-categorization.js';
import { reapplyRulesToPending } from '../lib/import-commit.js';

const ENTITY_ID = 'ent-ljc';
const TARGET_FITIDS = [
  'plaid-Qae7jK7jpQfkw1bVqqNdHLOEZ9MzDMIoZ0X9Bg', // EPAY CHASE
  'plaid-ndJrLQrLNDfZYKqj448AINOr1yL0eLIXdLDjP3', // CALCATA debit
  'plaid-p6ZV1nV1bdFoyjdn88KDIjVkZeYKMYILBzqAP1', // CALACTA debit
  'plaid-X6eoZ4oZpMFgoXMdvvBDI7dQAyx09xijeqRzvj', // wire return credit
  'plaid-p6ZV1nV1bdFoyjdn88K7h7PDBa0qdAtA64MDP', // ENTEX
];

const db = await getDatabase();
await seedDefaultRules(db, ENTITY_ID);
const cre = await seedCreCategorizationRules(db, ENTITY_ID);
const reapply = await reapplyRulesToPending(db, ENTITY_ID);

const placeholders = TARGET_FITIDS.map(() => '?').join(',');
const rows = await db.all(
  `SELECT it.fitid, it.date, it.amount, it.description,
          oa.account_number AS offset_num, oa.account_name AS offset_name
   FROM import_transactions it
   LEFT JOIN accounts oa ON oa.id = it.offset_account_id
   WHERE it.entity_id = ? AND it.fitid IN (${placeholders})
   ORDER BY it.date`,
  [ENTITY_ID, ...TARGET_FITIDS]
);

console.log(JSON.stringify({ cre, reapply, targetItems: rows }, null, 2));
process.exit(0);
