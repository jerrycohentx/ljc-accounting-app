/**
 * SQLite-compatible wrapper for node-postgres.
 * Converts ? placeholders and common SQLite boolean/date idioms.
 */

function normalizePgSql(sql) {
  return sql
    .replace(/\bDATETIME\b/gi, 'TIMESTAMP')
    .replace(/\bis_active\s*=\s*1\b/gi, 'is_active = TRUE')
    .replace(/\bis_active\s*=\s*0\b/gi, 'is_active = FALSE')
    .replace(/\bcleared\s*=\s*1\b/gi, 'cleared = TRUE')
    .replace(/\bcleared\s*=\s*0\b/gi, 'cleared = FALSE')
    .replace(/INSERT OR IGNORE/gi, 'INSERT')
    .replace(/"/g, "'");
}

function flattenParams(params) {
  if (params.length === 1 && Array.isArray(params[0])) {
    return params[0];
  }
  return params;
}

function toPgQuery(sql, params) {
  let index = 0;
  const text = normalizePgSql(sql).replace(/\?/g, () => `$${++index}`);
  return { text, values: flattenParams(params) };
}

export function createPgAdapter(client) {
  return {
    async get(sql, ...params) {
      const { text, values } = toPgQuery(sql, params);
      const result = await client.query(text, values);
      return result.rows[0];
    },

    async all(sql, ...params) {
      const { text, values } = toPgQuery(sql, params);
      const result = await client.query(text, values);
      return result.rows;
    },

    async run(sql, ...params) {
      const { text, values } = toPgQuery(sql, params);
      const result = await client.query(text, values);
      return { changes: result.rowCount, lastID: result.rows[0]?.id };
    },

    async exec(sql) {
      const statements = sql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const statement of statements) {
        await client.query(normalizePgSql(statement));
      }
    },

    raw: client,
  };
}
