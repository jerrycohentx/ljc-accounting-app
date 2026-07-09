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
