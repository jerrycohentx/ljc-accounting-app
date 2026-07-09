/**
 * Known rental properties, mapped from whatever label a management report
 * uses (address variants, "xx"-masked prefixes MANAGErenthouses.com puts in
 * front of some ownership labels, etc.) to the entity that owns them and,
 * where the chart of accounts has property-specific utility accounts, the
 * account numbers to use for Gas/Electric/Water instead of the generic
 * Rental Property Expenses bucket.
 *
 * Add a new property here (not in the parser) when a new one starts sending
 * reports — this is the only place that should need editing.
 */
export const PROPERTY_REGISTRY = [
  { canonical: '13923 Ivymount', entityId: 'ent-ljc', aliases: ['13923 ivymount'], utilityAccounts: { gas: '6231', electric: '6232', water: '6233' } },
  { canonical: '1220 W 18th', entityId: 'ent-ljc', aliases: ['1220 w 18th', '1220 w. 18th', '1220 west 18th'], utilityAccounts: { gas: '6211', electric: '6212', water: '6213' } },
  { canonical: '6810 Heath', entityId: 'ent-ljc', aliases: ['6810 heath'], utilityAccounts: { gas: '6241', electric: '6242', water: '6243' } },
  { canonical: '7803 Broadview', entityId: 'ent-ljc', aliases: ['7803 broadview'] },
  { canonical: '1311 Jefferson', entityId: 'ent-ljc', aliases: ['1311 jefferson'], utilityAccounts: { gas: '6221', electric: '6222', water: '6223' } },
  { canonical: '1721 Chapman', entityId: 'ent-ljc', aliases: ['1721 chapman'] },
  { canonical: '3050 Hazy Park', entityId: 'ent-ljc', aliases: ['3050 hazy park', 'hazy park'] },
  { canonical: '3402 Crosby Landing', entityId: 'ent-ljc', aliases: ['3402 crosby landing', 'crosby landing'] },
  { canonical: '3807 Hogan Court', entityId: 'ent-ljc', aliases: ['3807 hogan court', 'hogan court'] },
];

function normalize(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/^xx/, '') // MANAGErenthouses.com masks some ownership labels with a leading "xx"
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns { canonical, entityId, utilityAccounts } or null if unrecognized. */
export function matchProperty(rawLabel) {
  const norm = normalize(rawLabel);
  if (!norm) return null;
  for (const entry of PROPERTY_REGISTRY) {
    if (entry.aliases.some((a) => normalize(a) === norm)) return entry;
  }
  // Loose contains-match fallback (e.g. "Property: 13923 Ivymount Dr, Houston TX")
  for (const entry of PROPERTY_REGISTRY) {
    if (entry.aliases.some((a) => norm.includes(normalize(a)))) return entry;
  }
  return null;
}

/**
 * When each management company's management agreement says they remit the
 * prior period's net proceeds by. Only add an entry here once you've
 * confirmed it against the actual signed agreement — an unconfirmed guess is
 * worse than no date at all, since it would flag a normal, on-time deposit
 * as "overdue". Confirmed so far: WestSide Realty, by the 7th (per Jerry,
 * 2026-07-09). MANAGErenthouses.com's schedule is not yet confirmed.
 */
export const MANAGEMENT_COMPANY_REMIT_SCHEDULE = {
  'westside realty': { dueDayOfMonth: 7 },
};

/**
 * Given the management company and the report's period-end date, returns the
 * ISO date the net proceeds are expected by (the confirmed due day of the
 * month AFTER the period ends), or null if that company's schedule isn't
 * confirmed yet.
 */
export function computeExpectedDepositDate(managementCompany, periodEnd) {
  const schedule = MANAGEMENT_COMPANY_REMIT_SCHEDULE[String(managementCompany || '').toLowerCase().trim()];
  if (!schedule || !periodEnd) return null;
  const m = String(periodEnd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  let year = Number(m[1]);
  let month = Number(m[2]) + 1; // due the month AFTER the period ends
  if (month > 12) { month = 1; year += 1; }
  return `${year}-${String(month).padStart(2, '0')}-${String(schedule.dueDayOfMonth).padStart(2, '0')}`;
}
