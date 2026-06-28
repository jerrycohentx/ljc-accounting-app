import { QBO_PL_JAN_2026 } from './qbo-pl-jan2026-targets.js';
import { QBO_PL_FEB_JUN_2026 } from './qbo-pl-feb-jun2026-targets.js';

/** All QBO P&L catch-up periods for LJC 2026 YTD (in chronological order). */
export const QBO_PL_PERIODS_2026 = [QBO_PL_JAN_2026, QBO_PL_FEB_JUN_2026];

export function getQboPlConfig(periodKey) {
  if (!periodKey || periodKey === 'all' || periodKey === '2026') {
    return null;
  }
  if (periodKey === 'jan' || periodKey === '2026-01') return QBO_PL_JAN_2026;
  if (periodKey === 'feb-jun' || periodKey === '2026-02-06') return QBO_PL_FEB_JUN_2026;
  const found = QBO_PL_PERIODS_2026.find((p) => p.jeNumber === periodKey);
  return found || null;
}
