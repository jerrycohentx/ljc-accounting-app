import { Configuration, PlaidApi, PlaidEnvironments, CountryCode } from 'plaid';

const PLAID_ENV_MAP = {
  sandbox: PlaidEnvironments.sandbox,
  development: PlaidEnvironments.development,
  production: PlaidEnvironments.production,
};

export function isPlaidConfigured() {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

export function getPlaidEnv() {
  return (process.env.PLAID_ENV || 'sandbox').toLowerCase();
}

export function getPlaidClient() {
  if (!isPlaidConfigured()) {
    throw new Error('Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET.');
  }

  const envName = getPlaidEnv();
  const basePath = PLAID_ENV_MAP[envName];
  if (!basePath) {
    throw new Error(`Invalid PLAID_ENV "${envName}". Use sandbox, development, or production.`);
  }

  const configuration = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
      },
    },
  });

  return new PlaidApi(configuration);
}

/**
 * Verify live connectivity to Plaid by making a lightweight authenticated call.
 *
 * `isPlaidConfigured()` only confirms env vars exist; this confirms the
 * client_id/secret are actually valid for the selected environment and that
 * Plaid is reachable. Uses institutionsGet (count 1) — the cheapest call that
 * still requires valid credentials.
 *
 * @returns {Promise<{connected: boolean, environment: string, error?: string, errorCode?: string}>}
 */
export async function verifyPlaidConnection() {
  const environment = getPlaidEnv();

  if (!isPlaidConfigured()) {
    return {
      connected: false,
      environment,
      error: 'Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET.',
      errorCode: 'NOT_CONFIGURED',
    };
  }

  try {
    const client = getPlaidClient();
    await client.institutionsGet({
      count: 1,
      offset: 0,
      country_codes: [CountryCode.Us],
    });
    return { connected: true, environment };
  } catch (error) {
    const data = error.response?.data;
    return {
      connected: false,
      environment,
      error: data?.error_message || error.message || 'Unable to reach Plaid',
      errorCode: data?.error_code || 'CONNECTION_FAILED',
    };
  }
}
