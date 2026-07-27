/**
 * Ramp Developer API client.
 *
 * Auth: OAuth 2.0 client-credentials grant. Each entity connection stores its
 * own client_id / client_secret (encrypted at rest). We exchange them for a
 * short-lived bearer token, cache it in-memory until shortly before expiry,
 * and use it to read card transactions.
 *
 * Scopes required for read sync: `transactions:read`. (Chart-of-accounts push
 * for coding-in-Ramp additionally needs `accounting:read accounting:write`.)
 */

const RAMP_BASES = {
  production: 'https://api.ramp.com',
  demo: 'https://demo-api.ramp.com',
};

export function rampBaseUrl(environment) {
  const env = String(environment || 'production').toLowerCase();
  return RAMP_BASES[env] || RAMP_BASES.production;
}

// Cache tokens per client_id so multiple entities don't clobber each other.
const tokenCache = new Map();

function cacheKey(environment, clientId) {
  return `${environment || 'production'}:${clientId}`;
}

/**
 * Get a bearer access token via client-credentials. Cached until ~60s before
 * expiry. `scope` is a space-delimited string; Ramp issues a token with only
 * the scopes requested (and granted to the app).
 */
export async function getRampAccessToken({ environment, clientId, clientSecret, scope = 'transactions:read' }) {
  if (!clientId || !clientSecret) {
    throw new Error('Ramp client_id and client_secret are required');
  }

  const key = cacheKey(environment, clientId);
  const cached = tokenCache.get(key);
  const now = Date.now();
  if (cached && cached.scope === scope && cached.expiresAt - 60_000 > now) {
    return cached.token;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials', scope });

  const res = await fetch(`${rampBaseUrl(environment)}/developer/v1/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const detail = json.error_description || json.error || json.message || res.statusText;
    throw new Error(`Ramp token request failed (${res.status}): ${detail}`);
  }

  const token = json.access_token;
  if (!token) {
    throw new Error('Ramp token response did not include an access_token');
  }

  const expiresInMs = (Number(json.expires_in) || 3600) * 1000;
  tokenCache.set(key, { token, scope, expiresAt: now + expiresInMs });
  return token;
}

/** Clear a cached token (e.g. after disconnect or a 401). */
export function clearRampTokenCache(environment, clientId) {
  if (clientId) tokenCache.delete(cacheKey(environment, clientId));
  else tokenCache.clear();
}

/** Low-level authenticated GET against the Ramp Developer API. */
async function rampGet(conn, pathAndQuery) {
  const token = await getRampAccessToken(conn);
  const url = pathAndQuery.startsWith('http')
    ? pathAndQuery
    : `${rampBaseUrl(conn.environment)}${pathAndQuery}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  if (res.status === 401) {
    clearRampTokenCache(conn.environment, conn.clientId);
    throw new Error('Ramp authorization failed (401) — check client credentials and scopes');
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const detail = json.error_description || json.error || json.message || res.statusText;
    throw new Error(`Ramp API ${res.status}: ${detail}`);
  }
  return json;
}

/**
 * List card transactions, following pagination (page.next cursor) until
 * exhausted. Optional filters:
 *   fromDate / toDate  — ISO timestamps for user_transaction_time window
 *   state              — e.g. 'CLEARED'
 * Returns a flat array of raw Ramp transaction objects.
 */
export async function listRampTransactions(conn, { fromDate = null, toDate = null, state = null, pageSize = 100, maxPages = 100 } = {}) {
  const params = new URLSearchParams();
  params.set('page_size', String(pageSize));
  if (fromDate) params.set('from_date', fromDate);
  if (toDate) params.set('to_date', toDate);
  if (state) params.set('state', state);

  let next = `/developer/v1/transactions?${params.toString()}`;
  const all = [];
  let pages = 0;

  while (next && pages < maxPages) {
    const json = await rampGet(conn, next);
    const rows = Array.isArray(json.data) ? json.data : [];
    all.push(...rows);
    next = json.page && json.page.next ? json.page.next : null;
    pages += 1;
  }

  return all;
}

/** Verify credentials by fetching a single transaction page. Returns {ok, count}. */
export async function verifyRampConnection(conn) {
  const json = await rampGet(conn, '/developer/v1/transactions?page_size=1');
  return { ok: true, sample: Array.isArray(json.data) ? json.data.length : 0 };
}
