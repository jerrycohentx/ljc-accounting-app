/**
 * Full system status payload (loan tracker sidebar pattern).
 */

import { getAppInfo } from './app-info.js';
import { getBackupStatus } from './app-backup.js';
import { getStatementAutoLoadStatus } from './statement-auto-load.js';
import { isPostgres } from '../config/database.js';

export async function buildHealthPayload(dbExtras = {}) {
  const app = getAppInfo();
  const backup = getBackupStatus();
  const dbType = isPostgres() ? 'postgres' : 'sqlite';

  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    app,
    backup,
    database: {
      type: dbType,
      label: dbType === 'postgres' ? 'PostgreSQL (cloud)' : 'SQLite (local)',
    },
    statementAutoLoad: getStatementAutoLoadStatus(),
    ...dbExtras,
  };
}
