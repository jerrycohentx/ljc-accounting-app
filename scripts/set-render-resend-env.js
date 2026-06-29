/**
 * Set RESEND_API_KEY on Render for password-reset emails (onboarding@resend.dev sender).
 *
 * Usage:
 *   RENDER_API_KEY=rnd_xxx RESEND_API_KEY=re_xxx node scripts/set-render-resend-env.js
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
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) throw new Error('Set RESEND_API_KEY (from https://resend.com/api-keys)');

  const owners = await renderFetch('/owners?limit=20');
  const ownerId = owners[0]?.owner?.id ?? owners[0]?.id;
  const service = await findService(ownerId);
  if (!service?.id) throw new Error(`Service ${SERVICE_NAME} not found`);

  const pairs = [
    { key: 'RESEND_API_KEY', value: resendKey },
    { key: 'RESEND_FROM', value: process.env.RESEND_FROM || 'LJC Accounting <onboarding@resend.dev>' },
  ];

  console.log('Setting:', pairs.map((p) => p.key).join(', '));
  await setEnvVars(service.id, pairs);
  await renderFetch(`/services/${service.id}/deploys`, {
    method: 'POST',
    body: JSON.stringify({ clearCache: 'do_not_clear' }),
  });
  console.log('✓ Render redeploy triggered — password reset email should work in ~2 min.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
