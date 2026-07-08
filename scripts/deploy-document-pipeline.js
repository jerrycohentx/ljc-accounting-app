/**
 * Set document-email env vars on Render and trigger redeploy.
 *
 * Usage:
 *   RENDER_API_KEY=rnd_xxx node scripts/deploy-document-pipeline.js
 */
const API_BASE = 'https://api.render.com/v1';
const SERVICE_NAME = 'ljc-accounting-app';

async function renderFetch(path, options = {}) {
  const apiKey = process.env.RENDER_API_KEY;
  if (!apiKey) throw new Error('Set RENDER_API_KEY (https://dashboard.render.com/u/settings#api-keys)');

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
  if (!response.ok) throw new Error(`Render API ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function findService(ownerId) {
  const services = await renderFetch(`/services?ownerId=${ownerId}&limit=100`);
  const list = Array.isArray(services) ? services : services.items || [];
  const match = list.find((item) => item.service?.name === SERVICE_NAME || item.name === SERVICE_NAME);
  return match?.service ?? match;
}

async function setEnvVars(serviceId, pairs) {
  const body = pairs.map(({ key, value }) => ({ key, value }));
  return renderFetch(`/services/${serviceId}/env-vars`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

async function main() {
  const owners = await renderFetch('/owners?limit=20');
  const ownerId = owners[0]?.owner?.id ?? owners[0]?.id;
  const service = await findService(ownerId);
  if (!service?.id) throw new Error(`Service ${SERVICE_NAME} not found`);

  const pairs = [
    { key: 'FRONTEND_URL', value: process.env.FRONTEND_URL || 'https://ljc-accounting-app.onrender.com' },
    { key: 'DOCUMENT_EMAIL_ENABLED', value: '1' },
    { key: 'DOCUMENT_EMAIL_INTERVAL_HOURS', value: process.env.DOCUMENT_EMAIL_INTERVAL_HOURS || '6' },
    { key: 'DOCUMENT_DIGEST_ENABLED', value: '1' },
    { key: 'DOCUMENT_DIGEST_HOUR', value: process.env.DOCUMENT_DIGEST_HOUR || '7' },
    { key: 'DOCUMENT_DIGEST_TO', value: process.env.DOCUMENT_DIGEST_TO || 'jerry@ljcfinancial.com' },
  ];

  console.log('Setting:', pairs.map((p) => `${p.key}=${p.value}`).join(', '));
  await setEnvVars(service.id, pairs);
  await renderFetch(`/services/${service.id}/deploys`, {
    method: 'POST',
    body: JSON.stringify({ clearCache: 'do_not_clear' }),
  });
  console.log('✓ Render redeploy triggered — document email pipeline live in ~2–3 min.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
