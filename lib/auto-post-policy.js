/**
 * Bank import auto-post gate. Disabled by default — nothing reaches the register
 * without explicit review in Bank Feeds ("Add to register") unless ALLOW_AUTO_POST=1.
 */
export const AUTO_POST_ENABLED = process.env.ALLOW_AUTO_POST === '1';

export function autoPostBlockedReason(context = 'bulk import') {
  return `Auto-post is disabled (${context}). Review categories in Bank Feeds, then add to the register manually.`;
}

/** @returns {{ allowed: boolean, reason?: string }} */
export function checkAutoPostAllowed(context = 'bulk import') {
  if (!AUTO_POST_ENABLED) {
    return { allowed: false, reason: autoPostBlockedReason(context) };
  }
  return { allowed: true };
}
