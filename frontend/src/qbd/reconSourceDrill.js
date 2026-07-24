/**
 * Open the source document behind a reconciliation line.
 * Prefer a JE-attached file; otherwise the stored bank-statement PDF for the period.
 */
import { journalAPI, mgmtReportAPI, bankReconAPI } from '../services/api';

function base64ToObjectUrl(b64, mime = 'application/pdf') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

export async function openStatementPdf(entityId, accountId, statementDate) {
  if (!entityId || !accountId || !statementDate) return false;
  const r = await bankReconAPI.statementFile(entityId, accountId, statementDate);
  const d = r.data || {};
  if (!d.found || !d.dataBase64) return false;
  const url = base64ToObjectUrl(d.dataBase64, d.mime || 'application/pdf');
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return true;
}

export async function openJournalSourceDocument(entityId, journalEntryId) {
  if (!entityId || !journalEntryId) return { opened: false, journal: null };
  const r = await journalAPI.get(entityId, journalEntryId);
  const journal = r.data;
  const src = journal?.sourceDocument;
  if (src?.hasFile) {
    if (src.documentId) {
      await journalAPI.viewDocument(entityId, journalEntryId);
    } else if (src.mgmtReportId) {
      await mgmtReportAPI.viewFile(src.mgmtReportId, src.fileName);
    } else {
      return { opened: false, journal };
    }
    return { opened: true, journal, kind: 'attachment' };
  }
  return { opened: false, journal };
}

/**
 * Drill a recon report/worksheet line to its source document.
 * @returns {{ opened: boolean, journal?: object|null, kind?: string }}
 */
export async function drillReconLineSource({
  entityId,
  accountId,
  statementDate,
  journalEntryId,
  glId = null,
}) {
  let jeId = journalEntryId || null;
  let acctId = accountId || null;
  if (!jeId && glId) {
    try {
      const resolved = await bankReconAPI.resolveGl(entityId, glId);
      jeId = resolved.data?.journalEntryId || null;
      if (!acctId && resolved.data?.accountId) acctId = resolved.data.accountId;
    } catch {
      /* GL may be missing on older archives */
    }
  }

  if (jeId) {
    const jeResult = await openJournalSourceDocument(entityId, jeId);
    if (jeResult.opened) return jeResult;
    const stmtOk = await openStatementPdf(entityId, acctId, statementDate);
    if (stmtOk) return { opened: true, journal: jeResult.journal, kind: 'statement' };
    return { opened: false, journal: jeResult.journal, kind: null };
  }
  const stmtOk = await openStatementPdf(entityId, acctId, statementDate);
  if (stmtOk) return { opened: true, journal: null, kind: 'statement' };
  return { opened: false, journal: null, kind: null };
}
