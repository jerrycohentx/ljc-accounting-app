import Decimal from 'decimal.js';

export function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Derive comparison period from primary + mode (spec §2). */
export function deriveComparePeriod(primary, compareMode, customCompare = null) {
  if (!compareMode || compareMode === 'none') return null;

  if (compareMode === 'custom' && customCompare?.start && customCompare?.end) {
    return { start: customCompare.start, end: customCompare.end };
  }

  const { start, end } = primary;
  const startD = new Date(`${start}T12:00:00Z`);
  const endD = new Date(`${end}T12:00:00Z`);
  const days = Math.round((endD - startD) / (86400000)) + 1;

  if (compareMode === 'prior_year' || compareMode === 'same_period_last_year') {
    const shift = (d) => {
      const x = new Date(d);
      x.setUTCFullYear(x.getUTCFullYear() - 1);
      return x.toISOString().slice(0, 10);
    };
    return { start: shift(start), end: shift(end) };
  }

  if (compareMode === 'prior_period') {
    const priorEnd = new Date(startD);
    priorEnd.setUTCDate(priorEnd.getUTCDate() - 1);
    const priorStart = new Date(priorEnd);
    priorStart.setUTCDate(priorStart.getUTCDate() - days + 1);
    return {
      start: priorStart.toISOString().slice(0, 10),
      end: priorEnd.toISOString().slice(0, 10),
    };
  }

  return null;
}

export function computeVariance(current, comparison, { isPercent = false } = {}) {
  const cur = current == null ? null : round2(current);
  const cmp = comparison == null ? null : round2(comparison);

  if (cur == null && cmp == null) {
    return { current: null, comparison: null, variance: null, variancePct: null, variancePp: null };
  }

  if (isPercent) {
    const variancePp = cur != null && cmp != null ? round2(cur - cmp) : null;
    return { current: cur, comparison: cmp, variance: variancePp, variancePct: null, variancePp };
  }

  const variance = cur != null && cmp != null ? round2(cur - cmp) : null;
  let variancePct = null;
  if (variance != null && cmp != null && Math.abs(cmp) >= 0.005) {
    variancePct = round2((variance / Math.abs(cmp)) * 100);
  }

  return { current: cur, comparison: cmp, variance, variancePct, variancePp: null };
}

/** Polarity for variance/benchmark coloring (spec §3). */
export function linePolarity(accountType, accountName = '') {
  const name = String(accountName);
  if (accountType === 'REVENUE') return 'higher_is_better';
  if (accountType === 'EXPENSE') return 'lower_is_better';
  if (/Delinquency|Default|Chargeback|Bad Debt/i.test(name)) return 'lower_is_better';
  if (/Interest Income|Rental|Fee Income/i.test(name)) return 'higher_is_better';
  return 'neutral';
}

export function varianceColor(polarity, variance) {
  if (variance == null || polarity === 'neutral' || Math.abs(variance) < 0.005) return null;
  const favorable = polarity === 'higher_is_better'
    ? variance > 0
    : polarity === 'lower_is_better'
      ? variance < 0
      : null;
  if (favorable == null) return null;
  return favorable ? 'favorable' : 'unfavorable';
}

export function benchmarkGapColor(polarity, gap) {
  if (gap == null || polarity === 'neutral' || Math.abs(gap) < 0.0005) return null;
  const favorable = polarity === 'higher_is_better' ? gap > 0 : gap < 0;
  return favorable ? 'favorable' : 'unfavorable';
}

export function mergeComparisonLines(currentLines, compareLines, getKey) {
  const cmpMap = new Map((compareLines || []).map((l) => [getKey(l), l]));
  return (currentLines || []).map((line) => {
    const key = getKey(line);
    const cmp = cmpMap.get(key);
    const isPct = line.format === 'percent';
    const v = computeVariance(line.amount ?? line.value, cmp?.amount ?? cmp?.value, { isPercent: isPct });
    return {
      ...line,
      comparisonAmount: v.comparison,
      variance: v.variance,
      variancePct: v.variancePct,
      variancePp: v.variancePp,
    };
  });
}

export function sumDecimal(values) {
  return values.reduce((s, v) => s.plus(new Decimal(v || 0)), new Decimal(0)).toNumber();
}
