import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

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
