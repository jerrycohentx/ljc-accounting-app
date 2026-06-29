/**
 * Full system status payload (loan tracker sidebar pattern).
 */

import { getAppInfo } from './app-info.js';
import { getBackupStatus } from './app-backup.js';
import { getStatementAutoLoadStatus } from './statement-auto-load.js';
import { isPostgres } from '../config/database.js';
import { isSmsConfigured } from './outbound-sms.js';
import { getPasswordResetEmailChannels, isPasswordResetEmailAvailable } from './outbound-mail.js';

export async function buildHealthPayload(dbExtras = {}, db = null) {
  const app = getAppInfo();
  const backup = getBackupStatus();
  const dbType = isPostgres() ? 'postgres' : 'sqlite';
  const emailChannels = getPasswordResetEmailChannels(db);
  const emailReady = db ? await isPasswordResetEmailAvailable(db) : (
    emailChannels.resend || emailChannels.smtp || emailChannels.graph
    || emailChannels.statementEnv || emailChannels.gmailOAuthEnv
  );

  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    app,
    backup,
    database: {
      type: dbType,
      label: dbType === 'postgres' ? 'PostgreSQL (cloud)' : 'SQLite (local)',
    },
    passwordReset: {
      sms: isSmsConfigured(),
      email: emailReady,
      channels: emailChannels,
    },
    statementAutoLoad: getStatementAutoLoadStatus(),
    ...dbExtras,
  };
}
