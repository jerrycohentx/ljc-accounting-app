/** Safe JSON field parse for PG TEXT / JSON columns. */
export function parseJsonField(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
