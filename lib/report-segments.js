/** Entity business-line segments (spec §4d). */

export const SEGMENTS = {
  'ent-ljc': [
    { key: 'lending', label: 'Lending', naics: '522292', kpiPackKey: 'lending' },
    { key: 'rental', label: 'Rental', naics: '531110', kpiPackKey: 'rental' },
    { key: 'common', label: 'Common / Overhead', naics: null, kpiPackKey: 'generic' },
    { key: 'all', label: 'All LJC', naics: null, kpiPackKey: null },
  ],
  'ent-gm': [
    { key: 'all', label: 'Assisted Living', naics: '623312', kpiPackKey: 'assisted_living' },
  ],
};

/** Account-number prefix rules for LJC segment assignment (v1 heuristic). */
const LJC_LENDING_ACCOUNTS = /^1(3[0-9]{2}|4[0-9]{2})|^(4000|4010|4200|5000|5800)/;
const LJC_RENTAL_ACCOUNTS = /^(4100|4150|6100|6110|1500)/;

export function segmentsForEntity(entityId) {
  return SEGMENTS[entityId] || [{ key: 'all', label: 'All', naics: null, kpiPackKey: 'generic' }];
}

export function segmentForAccount(entityId, accountNumber) {
  if (entityId !== 'ent-ljc') return 'all';
  const n = String(accountNumber);
  if (LJC_LENDING_ACCOUNTS.test(n)) return 'lending';
  if (LJC_RENTAL_ACCOUNTS.test(n)) return 'rental';
  return 'common';
}

export function resolveSegment(entityId, segmentKey) {
  const list = segmentsForEntity(entityId);
  return list.find((s) => s.key === segmentKey) || list[list.length - 1];
}

export function accountMatchesSegment(entityId, accountNumber, segmentKey) {
  if (!segmentKey || segmentKey === 'all') return true;
  return segmentForAccount(entityId, accountNumber) === segmentKey;
}
