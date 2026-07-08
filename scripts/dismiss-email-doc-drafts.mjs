#!/usr/bin/env node
/**
 * One-shot cleanup: reject DRAFT email-doc imports (document email pipeline).
 * Safe: only fitid LIKE 'email-doc:%' OR JE description LIKE 'Email doc:%',
 * only DRAFT journal entries, never touches POSTED ledger rows.
 *
 * Usage:
 *   node scripts/dismiss-email-doc-drafts.mjs              # uses DATABASE_URL from .env if set
 *   DATABASE_URL=... node scripts/dismiss-email-doc-drafts.mjs
 */

import 'dotenv/config';
import { getDatabase, closeDatabase, isPostgres } from '../config/database.js';

const db = await getDatabase();

try {
  console.log('Database:', isPostgres() ? 'PostgreSQL' : 'SQLite');
  const rows = await db.all(
    `SELECT it.id AS import_id, it.fitid, it.entity_id, it.journal_entry_id, je.status AS je_status, je.description
     FROM import_transactions it
     JOIN journal_entries je ON je.id = it.journal_entry_id
     WHERE it.status = 'DRAFT'
       AND je.status = 'DRAFT'
       AND (
         it.fitid LIKE 'email-doc:%'
         OR je.description LIKE 'Email doc:%'
       )`
  );

  let rejected = 0;
  for (const row of rows) {
    await db.run('DELETE FROM journal_entry_lines WHERE journal_entry_id = ?', [row.journal_entry_id]);
    await db.run('DELETE FROM journal_entries WHERE id = ? AND status = ?', [row.journal_entry_id, 'DRAFT']);
    await db.run(
      "UPDATE import_transactions SET status = 'REJECTED' WHERE id = ? AND status = 'DRAFT'",
      [row.import_id]
    );
    rejected += 1;
  }

  console.log(JSON.stringify({
    found: rows.length,
    rejected,
    samples: rows.slice(0, 10).map((r) => ({
      entityId: r.entity_id,
      fitid: r.fitid,
      description: r.description,
    })),
  }, null, 2));
} finally {
  await closeDatabase();
}
