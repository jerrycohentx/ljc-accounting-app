#!/usr/bin/env node
import { getDatabase, closeDatabase } from '../config/database.js';
import { auditSurgicalReclass } from '../lib/audit-surgical-reclass.js';

const entityId = process.argv.includes('--entity')
  ? process.argv[process.argv.indexOf('--entity') + 1]
  : 'ent-ljc';

try {
  const db = await getDatabase();
  const result = await auditSurgicalReclass(db, { entityId });
  console.log(JSON.stringify({
    entityId: result.entityId,
    range: `${result.startDate} – ${result.endDate}`,
    scanned: result.scanned,
    errorCount: result.errorCount,
    byCode: result.byCode,
    samples: result.samples,
  }, null, 2));
  await closeDatabase();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
