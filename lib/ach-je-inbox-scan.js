import fs from 'fs';
import path from 'path';
import { commitAchJeImport, LJC_ENTITY_ID } from './ach-je-import.js';
import { achJeArchiveDir, achJeInboxDir } from './automation-manifest.js';

function walkCsvFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      walkCsvFiles(full, out);
    } else if (/^QBO_ACH_JE_\d{4}-\d{2}\.csv$/i.test(name)) {
      out.push(full);
    }
  }
  return out.sort();
}

export async function scanAchJeInbox(db, options = {}) {
  const inbox = options.inboxDir || achJeInboxDir();
  const archiveDir = options.archiveDir || achJeArchiveDir();
  const entityId = options.entityId || LJC_ENTITY_ID;
  const userId = options.userId || 'loan-tracker-auto';

  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  const files = walkCsvFiles(inbox);
  const results = [];

  for (const fullPath of files) {
    const filename = path.basename(fullPath);
    try {
      const csvText = fs.readFileSync(fullPath, 'utf8');
      const result = await commitAchJeImport(db, { csvText, fileName: filename, entityId, userId });
      results.push({ filename, ...result });
      if (result.posted || result.skipped) {
        const archived = path.join(archiveDir, filename);
        fs.renameSync(fullPath, archived);
      }
    } catch (error) {
      results.push({ filename, error: error.message });
    }
  }

  return {
    inbox,
    scanned: files.length,
    results,
    imported: results.filter((r) => r.jeId && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    errors: results.filter((r) => r.error).length,
  };
}
