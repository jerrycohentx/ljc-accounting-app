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
 * US bank holidays (Federal Reserve schedule) for a given year, as "YYYY-MM-DD".
 * When a fixed-date holiday falls on a Sunday, banks observe it on Monday; when
 * it falls on a Saturday it is not observed on a weekday (Fed convention), and
 * the Saturday is already a non-business day.
 */
export function usBankHolidays(year) {
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (m, d) => `${year}-${pad(m)}-${pad(d)}`;
  const dow = (m, d) => new Date(Date.UTC(year, m - 1, d)).getUTCDay();
  const nthWeekday = (m, weekday, n) => {
    const first = dow(m, 1);
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  };
  const lastWeekday = (m, weekday) => {
    const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
    return lastDay - ((dow(m, lastDay) - weekday + 7) % 7);
  };
  const observed = (m, d) => (dow(m, d) === 0 ? iso(m, d + 1) : iso(m, d));
  const set = new Set([
    observed(1, 1),                       // New Year's Day
    iso(1, nthWeekday(1, 1, 3)),          // Martin Luther King Jr. Day (3rd Mon Jan)
    iso(2, nthWeekday(2, 1, 3)),          // Presidents Day (3rd Mon Feb)
    iso(5, lastWeekday(5, 1)),            // Memorial Day (last Mon May)
    observed(6, 19),                      // Juneteenth
    observed(7, 4),                       // Independence Day
    iso(9, nthWeekday(9, 1, 1)),          // Labor Day (1st Mon Sep)
    iso(10, nthWeekday(10, 1, 2)),        // Columbus Day (2nd Mon Oct)
    observed(11, 11),                     // Veterans Day
    iso(11, nthWeekday(11, 4, 4)),        // Thanksgiving (4th Thu Nov)
    observed(12, 25),                     // Christmas Day
  ]);
  // Jan 1 of NEXT year falling on a Sunday is observed Monday Jan 2 of next
  // year, which never lands in this year, so no cross-year adjustment needed.
  return set;
}

/** True when the "YYYY-MM-DD" date is a weekday that is not a US bank holiday. */
export function isBusinessDay(isoDate) {
  const m = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !usBankHolidays(Number(m[1])).has(isoDate);
}

/** Returns isoDate itself if it is a business day, otherwise the next business day. */
export function nextBusinessDayOnOrAfter(isoDate) {
  const m = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  for (let i = 0; i < 10; i++) {
    const iso = d.toISOString().slice(0, 10);
    if (isBusinessDay(iso)) return iso;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Given the management company and the report's period-end date, returns the
 * ISO date the net proceeds are expected by, or null if that company's
 * schedule isn't confirmed yet. The base date is the confirmed due day of the
 * month AFTER the period ends; when that day is a weekend or a US bank
 * holiday the deposit cannot settle, so the expected date rolls forward to
 * the next business day (e.g. Labor Day Mon 2026-09-07 -> Tue 2026-09-08,
 * per Jerry 2026-09-08). Without this, an on-time deposit shows as overdue.
 */
export function computeExpectedDepositDate(managementCompany, periodEnd) {
  const schedule = MANAGEMENT_COMPANY_REMIT_SCHEDULE[String(managementCompany || '').toLowerCase().trim()];
  if (!schedule || !periodEnd) return null;
  // Accept a plain "2026-06-30" string (SQLite), an ISO timestamp string
  // (Postgres via some drivers), or an actual JS Date object (Postgres via
  // pg's default date parsing) — normalize all three to just the date part.
  const raw = periodEnd instanceof Date ? periodEnd.toISOString() : String(periodEnd);
  const m = raw.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  let year = Number(m[1]);
  let month = Number(m[2]) + 1; // due the month AFTER the period ends
  if (month > 12) { month = 1; year += 1; }
  const base = `${year}-${String(month).padStart(2, '0')}-${String(schedule.dueDayOfMonth).padStart(2, '0')}`;
  return nextBusinessDayOnOrAfter(base);
}
