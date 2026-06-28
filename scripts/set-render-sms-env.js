/**
 * Set password-reset SMS env vars on Render (ADMIN_PHONE + optional Twilio).
 *
 * Usage:
 *   RENDER_API_KEY=rnd_xxx node scripts/set-render-sms-env.js
 *   RENDER_API_KEY=rnd_xxx TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=+1... node scripts/set-render-sms-env.js
 */
const API_BASE = 'https://api.render.com/v1';
const SERVICE_NAME = 'ljc-accounting-app';

async function renderFetch(path, options = {}) {
  const apiKey = process.env.RENDER_API_KEY;
  if (!apiKey) throw new Error('Set RENDER_API_KEY');

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
  const match = services.find((item) => item.service?.name === SERVICE_NAME || item.name === SERVICE_NAME);
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
  if (!ownerId) throw new Error('No Render owner found');

  const service = await findService(ownerId);
  if (!service?.id) throw new Error(`Service ${SERVICE_NAME} not found`);

  const pairs = [
    { key: 'ADMIN_PHONE', value: process.env.ADMIN_PHONE || '+12818317855' },
  ];
  if (process.env.TWILIO_ACCOUNT_SID) pairs.push({ key: 'TWILIO_ACCOUNT_SID', value: process.env.TWILIO_ACCOUNT_SID });
  if (process.env.TWILIO_AUTH_TOKEN) pairs.push({ key: 'TWILIO_AUTH_TOKEN', value: process.env.TWILIO_AUTH_TOKEN });
  if (process.env.TWILIO_FROM_NUMBER) pairs.push({ key: 'TWILIO_FROM_NUMBER', value: process.env.TWILIO_FROM_NUMBER });

  console.log('Setting env vars:', pairs.map((p) => p.key).join(', '));
  await setEnvVars(service.id, pairs);

  await renderFetch(`/services/${service.id}/deploys`, {
    method: 'POST',
    body: JSON.stringify({ clearCache: 'do_not_clear' }),
  });

  console.log('✓ Done. Wait ~2 minutes for redeploy.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
