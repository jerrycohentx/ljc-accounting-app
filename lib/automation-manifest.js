import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(__dirname, '..', 'integration', 'ljc-automation-manifest.json');

let cached = null;

export function loadAutomationManifest() {
  if (!cached) {
    cached = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  }
  return cached;
}

export function achJeInboxDir() {
  return process.env.ACH_JE_INBOX_DIR
    || loadAutomationManifest().paths?.achJeInbox
    || path.join(__dirname, '..', '..', 'ACH lists');
}

export function achJeArchiveDir() {
  return process.env.ACH_JE_ARCHIVE_DIR
    || loadAutomationManifest().paths?.achJeArchive
    || path.join(achJeInboxDir(), 'imported');
}

export function loanTrackerUrl() {
  return process.env.LOAN_TRACKER_URL
    || loadAutomationManifest().apps?.loanServicing?.localUrl
    || 'http://localhost:8765';
}
