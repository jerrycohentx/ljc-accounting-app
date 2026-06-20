/**
 * One-time Render setup: create Postgres and set DATABASE_URL on the web service.
 * Usage: RENDER_API_KEY=rnd_xxx node scripts/setup-render-postgres.js
 */
const API_BASE = 'https://api.render.com/v1';
const SERVICE_NAME = 'ljc-accounting-app';
const DB_NAME = 'ljc-accounting-db';

async function renderFetch(path, options = {}) {
  const apiKey = process.env.RENDER_API_KEY;
  if (!apiKey) {
    throw new Error('Set RENDER_API_KEY (from https://dashboard.render.com/u/settings#api-keys)');
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Render API ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function getOwnerId() {
  const owners = await renderFetch('/owners?limit=20');
  const owner = owners[0]?.owner ?? owners[0];
  if (!owner?.id) {
    throw new Error('No Render owner/workspace found for this API key');
  }
  return owner.id;
}

async function findService(ownerId) {
  const services = await renderFetch(`/services?ownerId=${ownerId}&limit=100`);
  const match = services.find((item) => item.service?.name === SERVICE_NAME || item.name === SERVICE_NAME);
  return match?.service ?? match;
}

async function findDatabase(ownerId) {
  const databases = await renderFetch(`/postgres?ownerId=${ownerId}&limit=100`);
  const match = databases.find((item) => item.postgres?.name === DB_NAME || item.name === DB_NAME);
  return match?.postgres ?? match;
}

async function createDatabase(ownerId) {
  console.log(`Creating Postgres database "${DB_NAME}"...`);
  return renderFetch('/postgres', {
    method: 'POST',
    body: JSON.stringify({
      name: DB_NAME,
      ownerId,
      plan: 'free',
      region: 'oregon',
      version: '16',
      databaseName: 'ljc_accounting',
      databaseUser: 'ljc_accounting_user',
    }),
  });
}

async function waitForDatabase(dbId, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    const db = await renderFetch(`/postgres/${dbId}`);
    const status = db.status;
    console.log(`  database status: ${status}`);
    if (status === 'available') {
      return db;
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw new Error('Timed out waiting for Postgres to become available');
}

async function getConnectionString(dbId) {
  const db = await renderFetch(`/postgres/${dbId}`);
  const internal = db.connectionInfo?.internalConnectionString;
  const external = db.connectionInfo?.externalConnectionString;
  return internal || external;
}

async function setServiceEnvVar(serviceId, key, value) {
  console.log(`Setting ${key} on service ${SERVICE_NAME}...`);
  return renderFetch(`/services/${serviceId}/env-vars`, {
    method: 'PUT',
    body: JSON.stringify([{ key, value }]),
  });
}

async function triggerDeploy(serviceId) {
  console.log('Triggering deploy...');
  return renderFetch(`/services/${serviceId}/deploys`, {
    method: 'POST',
    body: JSON.stringify({ clearCache: 'do_not_clear' }),
  });
}

async function main() {
  const ownerId = await getOwnerId();
  console.log(`Render owner: ${ownerId}`);

  const service = await findService(ownerId);
  if (!service?.id) {
    throw new Error(`Service "${SERVICE_NAME}" not found in Render account`);
  }
  console.log(`Found service: ${service.name} (${service.id})`);

  let database = await findDatabase(ownerId);
  if (!database) {
    database = await createDatabase(ownerId);
  }
  console.log(`Database: ${database.name} (${database.id})`);

  database = await waitForDatabase(database.id);
  const connectionString = await getConnectionString(database.id);
  if (!connectionString) {
    throw new Error('Could not read Postgres connection string from Render');
  }

  await setServiceEnvVar(service.id, 'DATABASE_URL', connectionString);
  await triggerDeploy(service.id);

  console.log('\n✓ Render Postgres wired. Wait ~2 minutes, then test login at:');
  console.log('  https://ljc-accounting-app.onrender.com');
  console.log('  demo@ljcfinancial.com / demo123');
}

main().catch((error) => {
  console.error('Setup failed:', error.message);
  process.exit(1);
});
