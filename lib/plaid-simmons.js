/**
 * Simmons Bank only — Plaid feeds are restricted to Simmons (not Lone Star Bank).
 *
 * Plaid institution IDs (verify in Plaid Dashboard → Institutions):
 * - ins_111008 — Simmons Bank (US)
 *
 * Override via PLAID_SIMMONS_INSTITUTION_IDS (comma-separated) for OAuth variants.
 */

const DEFAULT_SIMMONS_INSTITUTION_IDS = ['ins_111008'];

const BLOCKED_NAME_PATTERNS = [
  /lone\s*star/i,
  /lonestar/i,
];

function getAllowedInstitutionIds() {
  const fromEnv = (process.env.PLAID_SIMMONS_INSTITUTION_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : DEFAULT_SIMMONS_INSTITUTION_IDS;
}

function normalizeInstitution(input) {
  if (!input) return { institution_id: '', name: '' };
  return {
    institution_id: input.institution_id || input.institutionId || '',
    name: input.name || input.institution_name || '',
  };
}

export function isBlockedInstitutionName(name) {
  if (!name) return false;
  return BLOCKED_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

export function isSimmonsInstitution(input) {
  const { institution_id: institutionId, name } = normalizeInstitution(input);

  if (isBlockedInstitutionName(name)) {
    return false;
  }

  const allowedIds = getAllowedInstitutionIds();
  if (institutionId && allowedIds.includes(institutionId)) {
    return true;
  }

  const lowerName = name.toLowerCase();
  if (lowerName.includes('simmons') && !lowerName.includes('lone star')) {
    return true;
  }

  return false;
}

export function simmonsRejectMessage(input) {
  const { name } = normalizeInstitution(input);
  const displayName = name || 'This bank';

  if (isBlockedInstitutionName(name)) {
    return (
      'Lone Star Bank cannot be connected through Plaid. ' +
      'LJC Accounting only supports Simmons Bank for automatic feeds. ' +
      'Use OFX file upload for Lone Star Bank transactions.'
    );
  }

  return (
    `${displayName} is not supported for Plaid feeds. ` +
    'Only Simmons Bank can be linked automatically. ' +
    'Use OFX file upload for other banks.'
  );
}

export function assertSimmonsInstitution(input) {
  if (!isSimmonsInstitution(input)) {
    const error = new Error(simmonsRejectMessage(input));
    error.statusCode = 403;
    throw error;
  }
}

export function getSimmonsInstitutionConfig() {
  return {
    allowedInstitutionIds: getAllowedInstitutionIds(),
    allowedBankName: 'Simmons Bank',
    blockedBanks: ['Lone Star Bank'],
  };
}
