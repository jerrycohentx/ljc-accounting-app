/**
 * Open the source document behind a reconciliation line.
 *
 * Line drill-down opens ONLY a file attached to that journal entry
 * (receipt, check image, mgmt report, etc.). It does NOT open the bank
 * statement PDF — that is the period document, not the line's source.
 */
import { journalAPI, mgmtReportAPI, bankReconAPI } from '../services/api';

function base64ToObjectUrl(b64, mime = 'application/pdf') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/** Explicit "view statement" action (toolbar) — not used for line drill-down. */
export async function openStatementPdf(entityId, accountId, statementDate) {
  const url = await fetchStatementObjectUrl(entityId, accountId, statementDate);
  if (!url) return false;
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return true;
}

/** Load statement PDF as a blob URL for an in-app iframe (caller must revoke). */
export async function fetchStatementObjectUrl(entityId, accountId, statementDate) {
  if (!entityId || !accountId || !statementDate) return null;
  const r = await bankReconAPI.statementFile(entityId, accountId, statementDate);
  const d = r.data || {};
  if (!d.found || !d.dataBase64) return null;
  return base64ToObjectUrl(d.dataBase64, d.mime || 'application/pdf');
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
 * Drill a recon line to its attached source document only.
 * Never opens the bank statement PDF.
 * @returns {{ opened: boolean, journal?: object|null, kind?: string|null }}
 */
export async function drillReconLineSource({
  entityId,
  journalEntryId,
  glId = null,
}) {
  let jeId = journalEntryId || null;
  if (!jeId && glId) {
    try {
      const resolved = await bankReconAPI.resolveGl(entityId, glId);
      jeId = resolved.data?.journalEntryId || null;
    } catch {
      /* GL may be missing on older archives */
    }
  }

  if (!jeId) return { opened: false, journal: null, kind: null };

  const jeResult = await openJournalSourceDocument(entityId, jeId);
  if (jeResult.opened) return jeResult;
  return { opened: false, journal: jeResult.journal, kind: null };
}
