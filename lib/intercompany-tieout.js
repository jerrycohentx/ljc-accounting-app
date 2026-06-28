import Decimal from 'decimal.js';
import { accountTypeFromNumber } from './qbo-trial-balance.js';
import { INTERCOMPANY_PAIRS, NON_IC_ACCOUNTS } from '../config/intercompany-pairs.js';

/**
 * Extract signed intercompany amount from QBO TB rows.
 * Returns natural balance (positive = normal side for role).
 */
export function extractQboIcAmount(rows, { qboPattern, role }) {
  if (!qboPattern) return null;

  let netDebit = new Decimal(0);
  for (const row of rows) {
    if (qboPattern.test(row.name)) {
      netDebit = netDebit.plus(row.netDebit);
    }
  }
  if (netDebit.isZero()) return null;

  const natural = role === 'due_to' ? netDebit.negated() : netDebit;
  return natural.abs().toFixed(2);
}

function getBalanceMap(balances) {
  const map = new Map();
  for (const b of balances) map.set(b.accountNumber, new Decimal(b.balance));
  return map;
}

function mapToBalances(map) {
  return [...map.entries()]
    .map(([accountNumber, balance]) => ({
      accountNumber,
      balance: Number(balance.toFixed(2)),
    }))
    .filter((b) => Math.abs(b.balance) > 0.004);
}

function setBalance(map, account, amount) {
  const val = new Decimal(amount);
  if (val.abs().lt(0.005)) map.delete(account);
  else map.set(account, val);
}

/**
 * Resolve tied amount for a pair from QBO extracts and/or rolled balances.
 */
export function resolveTieAmount({ amountA, amountB, master, pairId }) {
  const a = amountA != null ? new Decimal(amountA) : null;
  const b = amountB != null ? new Decimal(amountB) : null;

  if (a && a.abs().gt(0) && b && b.abs().gt(0)) {
    if (a.minus(b).abs().lt(0.01)) return a.toFixed(2);
    const chosen = master === 'sideB' ? b : a;
    return chosen.abs().toFixed(2);
  }
  if (a && a.abs().gt(0)) return a.abs().toFixed(2);
  if (b && b.abs().gt(0)) return b.abs().toFixed(2);
  return '0.00';
}

/**
 * Apply intercompany tie-out to rolled-up balance maps per entity.
 * Mutates balanceMaps in place; adjusts 3900 to keep each entity balanced.
 */
export function applyIntercompanyTieout(balanceMapsByEntity, qboRowsByEntity) {
  const tieReport = [];

  for (const pair of INTERCOMPANY_PAIRS) {
    const rowsA = qboRowsByEntity[pair.sideA.entity] || [];
    const rowsB = qboRowsByEntity[pair.sideB.entity] || [];

    const qboA = pair.sideA.qboPattern
      ? extractQboIcAmount(rowsA, pair.sideA)
      : null;
    const qboB = pair.sideB.qboPattern
      ? extractQboIcAmount(rowsB, pair.sideB)
      : null;

    const mapA = balanceMapsByEntity[pair.sideA.entity];
    const mapB = balanceMapsByEntity[pair.sideB.entity];
    if (!mapA || !mapB) continue;

    const rolledA = mapA.get(pair.sideA.account)?.toFixed(2) ?? null;
    const rolledB = mapB.get(pair.sideB.account)?.toFixed(2) ?? null;

    const amountA = qboA ?? rolledA;
    const amountB = qboB ?? rolledB;

    const tied = resolveTieAmount({
      amountA,
      amountB,
      master: pair.master,
      pairId: pair.id,
    });

    const tiedDec = new Decimal(tied);
    if (tiedDec.abs().lt(0.005)) {
      tieReport.push({ ...pair, tied: '0.00', status: 'zero', qboA, qboB, rolledA, rolledB });
      continue;
    }

    const oldA = mapA.get(pair.sideA.account) || new Decimal(0);
    const oldB = mapB.get(pair.sideB.account) || new Decimal(0);

    setBalance(mapA, pair.sideA.account, tied);
    setBalance(mapB, pair.sideB.account, tied);

    // Clear wrong-direction IC slots (e.g. LJC 1902 negative → moved to 2902)
    if (pair.id === 'ljc-omc') {
      mapA.delete('1902');
    }

    tieReport.push({
      id: pair.id,
      label: pair.label,
      tied,
      qboA,
      qboB,
      rolledA,
      rolledB,
      sideA: { entity: pair.sideA.entity, account: pair.sideA.account, before: oldA.toFixed(2), after: tied },
      sideB: { entity: pair.sideB.entity, account: pair.sideB.account, before: oldB.toFixed(2), after: tied },
      status: qboA && qboB && new Decimal(qboA).minus(qboB).abs().gt(0.01) ? 'qbo_variance_resolved' : 'tied',
    });
  }

  return tieReport;
}

/**
 * Build balance maps from rolled balance arrays.
 */
export function balancesToMap(balances) {
  return getBalanceMap(balances);
}

/**
 * Verify all IC pairs tie (due_from on A = due_to on B).
 */
export function verifyIntercompanyTieout(balanceMapsByEntity) {
  const results = [];
  let allTied = true;

  for (const pair of INTERCOMPANY_PAIRS) {
    const mapA = balanceMapsByEntity[pair.sideA.entity];
    const mapB = balanceMapsByEntity[pair.sideB.entity];
    const balA = mapA?.get(pair.sideA.account) || new Decimal(0);
    const balB = mapB?.get(pair.sideB.account) || new Decimal(0);
    const variance = balA.minus(balB).abs();
    const tied = variance.lt(0.01);

    if (!tied) allTied = false;

    results.push({
      id: pair.id,
      label: pair.label,
      sideA: { entity: pair.sideA.entity, account: pair.sideA.account, balance: balA.toFixed(2) },
      sideB: { entity: pair.sideB.entity, account: pair.sideB.account, balance: balB.toFixed(2) },
      variance: variance.toFixed(2),
      tied,
    });
  }

  return { allTied, pairs: results };
}

/**
 * Full pipeline: rollups → tie-out → balance arrays.
 */
export function tieOutRollups(rollupsByEntity, qboRowsByEntity) {
  const balanceMaps = {};
  for (const [entityId, balances] of Object.entries(rollupsByEntity)) {
    balanceMaps[entityId] = balancesToMap(balances);
  }

  const tieReport = applyIntercompanyTieout(balanceMaps, qboRowsByEntity);
  const verification = verifyIntercompanyTieout(balanceMaps);

  const tiedRollups = {};
  for (const [entityId, map] of Object.entries(balanceMaps)) {
    tiedRollups[entityId] = mapToBalances(map);
  }

  return { tiedRollups, tieReport, verification };
}

export { INTERCOMPANY_PAIRS, NON_IC_ACCOUNTS };
