/**
 * Plaid institution allowlist — Simmons Bank + American Express.
 *
 * Institution IDs (Plaid Dashboard → Institutions):
 * - ins_111008 — Simmons Bank (US, OAuth)
 * - ins_10     — American Express (OAuth)
 * - ins_137213 — American Express - @ Work (corporate cards)
 *
 * Env overrides (comma-separated Plaid institution IDs):
 * - PLAID_SIMMONS_INSTITUTION_IDS — Simmons Bank IDs
 * - PLAID_AMEX_INSTITUTION_IDS    — American Express IDs
 */

const DEFAULT_SIMMONS_INSTITUTION_IDS = ['ins_111008'];
const DEFAULT_AMEX_INSTITUTION_IDS = ['ins_10', 'ins_137213'];

const BLOCKED_NAME_PATTERNS = [/lone\s*star/i, /lonestar/i];

function parseEnvIdList(value) {
  return (value || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function getSimmonsInstitutionIds() {
  const override = parseEnvIdList(process.env.PLAID_SIMMONS_INSTITUTION_IDS);
  return override.length > 0 ? override : DEFAULT_SIMMONS_INSTITUTION_IDS;
}

function getAmexInstitutionIds() {
  const override = parseEnvIdList(process.env.PLAID_AMEX_INSTITUTION_IDS);
  return override.length > 0 ? override : DEFAULT_AMEX_INSTITUTION_IDS;
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

/** Classify an institution as 'simmons', 'amex', or null (not allowed). */
function classifyInstitution(input) {
  const { institution_id: institutionId, name } = normalizeInstitution(input);
  if (isBlockedInstitutionName(name)) return null;

  if (institutionId && getSimmonsInstitutionIds().includes(institutionId)) return 'simmons';
  if (institutionId && getAmexInstitutionIds().includes(institutionId)) return 'amex';

  const lowerName = name.toLowerCase();
  if (lowerName.includes('simmons') && !lowerName.includes('lone star')) return 'simmons';
  if (/american express|amex/.test(lowerName)) return 'amex';

  return null;
}

/**
 * Whether this institution is allowed for automatic Plaid feeds.
 * Name kept as `isSimmonsInstitution` for backward compatibility with existing
 * call sites in routes/plaid.js — it now covers Simmons Bank AND American
 * Express, not just Simmons Bank.
 */
export function isSimmonsInstitution(input) {
  return classifyInstitution(input) !== null;
}

export function simmonsRejectMessage(input) {
  const { name } = normalizeInstitution(input);
  const displayName = name || 'This institution';

  if (isBlockedInstitutionName(name)) {
    return (
      'Lone Star Bank cannot be connected through Plaid. ' +
      'Use OFX file upload for Lone Star Bank transactions.'
    );
  }

  return (
    `${displayName} is not supported for Plaid feeds. ` +
    'Only Simmons Bank and American Express can be linked automatically. ' +
    'Use OFX file upload for other banks and cards.'
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
    allowedInstitutionIds: [...getSimmonsInstitutionIds(), ...getAmexInstitutionIds()],
    allowedBankName: 'Simmons Bank, American Express',
    blockedBanks: ['Lone Star Bank'],
  };
}

/** Institution key ('simmons' | 'amex') for a linked Plaid item — used for labeling. */
export function getInstitutionKey(input) {
  return classifyInstitution(input);
}
