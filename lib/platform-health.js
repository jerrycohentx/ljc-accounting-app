import fs from 'fs';
import path from 'path';
import { getBackupStatus } from './app-backup.js';
import { getAchJeInboxScanStatus } from './ach-je-inbox-worker.js';
import { getStatementAutoLoadStatus } from './statement-auto-load.js';
import { getStatementEmailIngestStatus } from './statement-email-ingest.js';
import { loanTrackerUrl, loadAutomationManifest } from './automation-manifest.js';

function verifyLoanBackup(maxAgeHours = 26) {
  const backupDir = loadAutomationManifest().paths?.loanPortfolioBackup || 'C:\\LJC-LoanTracker\\Backups';
  if (!fs.existsSync(backupDir)) {
    return { ok: false, error: 'Loan backup directory missing', backupDir };
  }
  const re = /^LJC_backup_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/;
  const files = fs.readdirSync(backupDir)
    .filter((f) => re.test(f))
    .map((f) => {
      const full = path.join(backupDir, f);
      const st = fs.statSync(full);
      return { filename: f, mtime: st.mtime, sizeBytes: st.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return { ok: false, error: 'No loan backups found', backupDir };
  const latest = files[0];
  const ageHours = (Date.now() - latest.mtime.getTime()) / 3600000;
  return {
    ok: ageHours <= maxAgeHours,
    latest: { ...latest, mtime: latest.mtime.toISOString(), ageHours: Math.round(ageHours * 10) / 10 },
    maxAgeHours,
    count: files.length,
  };
}

export async function buildPlatformHealthPayload(db) {
  const loanUrl = loanTrackerUrl();
  let loanHealth = { ok: false };
  try {
    const resp = await fetch(`${loanUrl}/api/health`, { signal: AbortSignal.timeout(4000) });
    loanHealth = await resp.json();
    loanHealth.ok = resp.ok;
  } catch (error) {
    loanHealth = { ok: false, error: error.message };
  }

  const emailIngest = db ? await getStatementEmailIngestStatus(db) : null;

  return {
    timestamp: new Date().toISOString(),
    manifest: loadAutomationManifest(),
    accounting: {
      ok: true,
      backup: getBackupStatus(),
      achJeInboxScan: getAchJeInboxScanStatus(),
      statementAutoLoad: getStatementAutoLoadStatus(),
      statementEmailIngest: emailIngest,
    },
    loanServicing: {
      health: loanHealth,
      backup: verifyLoanBackup(26),
    },
  };
}
