/**
 * QBD "Enter Adjustment" — PERMANENTLY DISABLED (Jerry hard rule: no plug entries).
 * Resolve real variances; never force-balance a reconciliation with a balancing JE.
 */

import { assertNotPlugJournal } from './period-integrity.js';

async function findOffsetAccount() {
  throw new Error('Reconciliation plug adjustments are permanently disabled');
}

/**
 * @deprecated Hard-blocked. Always throws PLUG_ENTRY_BLOCKED.
 */
export async function postReconcileAdjustment(db, args = {}) {
  assertNotPlugJournal({
    source: 'reconcile-adjustment',
    description: args.description || 'Reconciliation adjustment',
  });
  // Unreachable — assertNotPlugJournal always throws for this source.
  await findOffsetAccount();
  void db;
  void args;
  throw new Error('Reconciliation plug adjustments are permanently disabled');
}
