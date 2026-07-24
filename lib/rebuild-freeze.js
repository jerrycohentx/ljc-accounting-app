/**
 * Rebuild freeze gates auto-importers (email, OFX folder, ACH inbox, Plaid).
 * Opt-in only: set REBUILD_FREEZE=1 during a purge/rebuild. Default = off so
 * production stays automatic after books are stable.
 */

export function isRebuildFreezeActive() {
  const v = String(process.env.REBUILD_FREEZE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}
