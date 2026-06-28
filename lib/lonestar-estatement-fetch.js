/**
 * Orchestrate Lone Star eStatement download when a notification email arrives.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  extractCandidateUrls,
  getLonestarPortalConfig,
  isLonestarEStatementNotification,
  parseLonestarNotificationMeta,
  pickStatementDownloadUrl,
} from './lonestar-estatement-notify.js';
import {
  downloadLonestarStatementFromPortal,
  fetchLonestarPdfFromUrl,
} from './lonestar-portal-download.js';
import { jsonPathForAccount } from './statement-json-merge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

export { isLonestarEStatementNotification, parseLonestarNotificationMeta, getLonestarPortalConfig };

export function periodAlreadyImported(accountNumber, periodEnd) {
  if (!periodEnd) return false;
  const rel = jsonPathForAccount(accountNumber);
  if (!rel) return false;
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return false;
  try {
    const doc = JSON.parse(fs.readFileSync(full, 'utf8'));
    return (doc.statements || []).some(
      (s) => (s.meta?.periodEnd || s.meta?.closingDate) === periodEnd
    );
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{ buffer: Buffer, fileName: string, source: string, meta: object }>}
 */
export async function fetchLonestarStatementForNotification(email) {
  if (!isLonestarEStatementNotification(email)) {
    throw new Error('Not a Lone Star eStatement notification email');
  }

  const meta = parseLonestarNotificationMeta(email);
  if (meta.periodEnd && periodAlreadyImported('1001', meta.periodEnd)) {
    return {
      skipped: true,
      reason: `Statement for ${meta.periodEnd} already imported`,
      meta,
    };
  }

  const urls = extractCandidateUrls(email);
  const directUrl = pickStatementDownloadUrl(urls);
  const errors = [];

  if (directUrl) {
    try {
      const result = await fetchLonestarPdfFromUrl(directUrl);
      return { ...result, meta, skipped: false };
    } catch (err) {
      errors.push(`email link: ${err.message}`);
    }
  }

  const cfg = getLonestarPortalConfig();
  if (cfg.enabled) {
    try {
      const result = await downloadLonestarStatementFromPortal({
        periodEnd: meta.periodEnd,
        accountLast4: meta.accountLast4,
      });
      return { ...result, meta, skipped: false };
    } catch (err) {
      errors.push(`portal: ${err.message}`);
    }
  } else {
    errors.push('portal: LONESTAR_ONLINE_USER and LONESTAR_ONLINE_PASSWORD not configured');
  }

  throw new Error(
    `Could not download Lone Star eStatement. ${errors.join('; ')}. `
    + 'Add portal credentials on Render or forward PDF attachments from Lone Star.'
  );
}
