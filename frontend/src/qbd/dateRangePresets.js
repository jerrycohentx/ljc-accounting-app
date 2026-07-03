// QuickBooks-style date range presets shared across all report pages.
// computeRange(key, todayISOStr) -> { from, to } (both 'YYYY-MM-DD')

function pad(n) { return String(n).padStart(2, '0'); }
function toISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseISO(s) { return new Date(s + 'T00:00:00'); }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function startOfWeek(d) { const r = new Date(d); const day = r.getDay(); return addDays(r, -day); }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function startOfQuarter(d) { const q = Math.floor(d.getMonth() / 3); return new Date(d.getFullYear(), q * 3, 1); }
function endOfQuarter(d) { const q = Math.floor(d.getMonth() / 3); return new Date(d.getFullYear(), q * 3 + 3, 0); }
function startOfYear(d) { return new Date(d.getFullYear(), 0, 1); }
function endOfYear(d) { return new Date(d.getFullYear(), 11, 31); }

export const DATE_PRESETS = [
  ['custom', 'Custom'],
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['this_week', 'This week'],
  ['this_week_to_date', 'This week-to-date'],
  ['last_week', 'Last week'],
  ['last_week_to_date', 'Last week-to-date'],
  ['this_month', 'This month'],
  ['this_month_to_date', 'This month-to-date'],
  ['last_month', 'Last month'],
  ['last_month_to_date', 'Last month-to-date'],
  ['this_quarter', 'This quarter'],
  ['this_quarter_to_date', 'This quarter-to-date'],
  ['last_quarter', 'Last quarter'],
  ['last_quarter_to_date', 'Last quarter-to-date'],
  ['this_year', 'This year'],
  ['this_year_to_date', 'This year-to-date'],
  ['last_year', 'Last year'],
  ['last_year_to_date', 'Last year-to-date'],
  ['all_dates', 'All dates'],
];

export function computeRange(key, todayISOStr) {
  const today = parseISO(todayISOStr);
  switch (key) {
    case 'today': return { from: toISO(today), to: toISO(today) };
    case 'yesterday': { const y = addDays(today, -1); return { from: toISO(y), to: toISO(y) }; }
    case 'this_week': { const s = startOfWeek(today); return { from: toISO(s), to: toISO(addDays(s, 6)) }; }
    case 'this_week_to_date': { const s = startOfWeek(today); return { from: toISO(s), to: toISO(today) }; }
    case 'last_week': { const s = addDays(startOfWeek(today), -7); return { from: toISO(s), to: toISO(addDays(s, 6)) }; }
    case 'last_week_to_date': { const s = addDays(startOfWeek(today), -7); return { from: toISO(s), to: toISO(addDays(s, today.getDay())) }; }
    case 'this_month': return { from: toISO(startOfMonth(today)), to: toISO(endOfMonth(today)) };
    case 'this_month_to_date': return { from: toISO(startOfMonth(today)), to: toISO(today) };
    case 'last_month': { const lm = new Date(today.getFullYear(), today.getMonth() - 1, 1); return { from: toISO(startOfMonth(lm)), to: toISO(endOfMonth(lm)) }; }
    case 'last_month_to_date': { const lm = new Date(today.getFullYear(), today.getMonth() - 1, 1); const cap = Math.min(today.getDate(), endOfMonth(lm).getDate()); return { from: toISO(startOfMonth(lm)), to: toISO(new Date(lm.getFullYear(), lm.getMonth(), cap)) }; }
    case 'this_quarter': return { from: toISO(startOfQuarter(today)), to: toISO(endOfQuarter(today)) };
    case 'this_quarter_to_date': return { from: toISO(startOfQuarter(today)), to: toISO(today) };
    case 'last_quarter': { const lq = new Date(today.getFullYear(), today.getMonth() - 3, 1); return { from: toISO(startOfQuarter(lq)), to: toISO(endOfQuarter(lq)) }; }
    case 'last_quarter_to_date': { const lq = new Date(today.getFullYear(), today.getMonth() - 3, 1); return { from: toISO(startOfQuarter(lq)), to: toISO(endOfQuarter(lq)) }; }
    case 'this_year': return { from: toISO(startOfYear(today)), to: toISO(endOfYear(today)) };
    case 'this_year_to_date': return { from: toISO(startOfYear(today)), to: toISO(today) };
    case 'last_year': { const ly = new Date(today.getFullYear() - 1, 0, 1); return { from: toISO(startOfYear(ly)), to: toISO(endOfYear(ly)) }; }
    case 'last_year_to_date': { const ly = new Date(today.getFullYear() - 1, 0, 1); const cap = new Date(ly.getFullYear(), today.getMonth(), today.getDate()); return { from: toISO(startOfYear(ly)), to: toISO(cap) }; }
    case 'all_dates': return { from: '2000-01-01', to: toISO(today) };
    default: return null; // 'custom' -> caller keeps existing manual dates
  }
}
