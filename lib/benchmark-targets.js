/** Custom benchmark targets (spec §4a manual targets). */

export async function ensureBenchmarkTargetTable(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS benchmark_targets (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      segment_key TEXT DEFAULT 'all',
      kpi_key TEXT NOT NULL,
      value REAL NOT NULL,
      source TEXT,
      effective_date DATE,
      note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entity_id, segment_key, kpi_key)
    )
  `);
}

export async function getBenchmarkTarget(db, entityId, kpiKey, segmentKey = 'all') {
  await ensureBenchmarkTargetTable(db);
  const row = await db.get(
    `SELECT value, source, effective_date, note FROM benchmark_targets
     WHERE entity_id = ? AND kpi_key = ? AND segment_key IN (?, 'all')
     ORDER BY CASE WHEN segment_key = ? THEN 0 ELSE 1 END
     LIMIT 1`,
    [entityId, kpiKey, segmentKey, segmentKey]
  );
  if (!row) return null;
  return {
    value: Number(row.value),
    source: row.source || 'custom',
    effectiveDate: row.effective_date,
    note: row.note,
  };
}

export async function listBenchmarkTargets(db, entityId, segmentKey = null) {
  await ensureBenchmarkTargetTable(db);
  if (segmentKey) {
    return db.all(
      'SELECT * FROM benchmark_targets WHERE entity_id = ? AND segment_key = ? ORDER BY kpi_key',
      [entityId, segmentKey]
    );
  }
  return db.all(
    'SELECT * FROM benchmark_targets WHERE entity_id = ? ORDER BY segment_key, kpi_key',
    [entityId]
  );
}

export async function upsertBenchmarkTarget(db, {
  id,
  entityId,
  segmentKey = 'all',
  kpiKey,
  value,
  source = 'custom',
  effectiveDate = null,
  note = null,
}) {
  await ensureBenchmarkTargetTable(db);
  await db.run(
    `INSERT INTO benchmark_targets (id, entity_id, segment_key, kpi_key, value, source, effective_date, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id, segment_key, kpi_key) DO UPDATE SET
       value = excluded.value,
       source = excluded.source,
       effective_date = excluded.effective_date,
       note = excluded.note`,
    [id, entityId, segmentKey, kpiKey, value, source, effectiveDate, note]
  );
}
