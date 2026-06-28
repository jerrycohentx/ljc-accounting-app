/** Plain-language scan result for the UI toast. */

export function buildEmailIngestMessage(summary) {
  if (!summary || summary.skipped) {
    return summary?.reason === 'already running'
      ? 'Email scan already in progress'
      : 'Email scan skipped';
  }

  const parts = [];
  const results = summary.results || [];
  const mailboxErrors = (summary.errors || []).filter((e) => e.mailbox && e.error);
  const downloaded = results.filter((r) =>
    r.attachmentResults?.some((a) => a.downloadSource && !a.skipped)
  );
  const imported = results.filter((r) =>
    r.attachmentResults?.some((a) => a.importResult?.imported > 0)
  );
  const failed = results.filter((r) =>
    r.attachmentResults?.some((a) => a.error) || (r.error && r.portalDirect)
  );
  const skipped = results.filter((r) => r.skipped);
  const retried = results.filter((r) => r.retried);
  const portalDirect = results.filter((r) => r.portalDirect && !r.error);

  if (downloaded.length || portalDirect.some((r) => r.attachmentResults?.[0]?.downloadSource)) {
    parts.push(`Downloaded ${Math.max(downloaded.length, portalDirect.length)} Lone Star statement(s)`);
  }
  if (imported.length) {
    parts.push(`Imported ${imported.length} statement(s)`);
  }
  if (failed.length) {
    const err = failed[0]?.attachmentResults?.find((a) => a.error)?.error
      || failed[0]?.error
      || summary.errors?.[0]?.error;
    parts.push(err ? `Failed: ${err.slice(0, 160)}` : `${failed.length} failed`);
  }
  if (retried.length && !downloaded.length && !imported.length && !failed.length) {
    parts.push('Retried Lone Star download — check Recent imports below');
  }
  if (skipped.length && !downloaded.length && !imported.length && !failed.length) {
    parts.push(`${skipped.length} email(s) already processed — no new statements`);
  }

  if (mailboxErrors.length) {
    const hint = mailboxErrors[0].error.includes('Gmail OAuth not configured')
      ? `${mailboxErrors[0].mailbox}: Gmail OAuth keys missing on Render (GMAIL_OAUTH_CLIENT_ID / SECRET)`
      : `${mailboxErrors[0].mailbox}: ${mailboxErrors[0].error.slice(0, 100)}`;
    parts.push(hint);
  } else if (
    summary.messagesFetched === 0
    && summary.gmailOAuthConfigured === false
    && (summary.mailboxStats || []).some((m) => m.transport === 'gmail-oauth')
  ) {
    parts.push('Gmail connected but OAuth keys missing on Render — add GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET');
  }

  if (parts.length) {
    return parts.join('. ');
  }
  if (summary.messagesFetched === 0) {
    if (summary.lonestarPortalConfigured) {
      return 'No emails found — tried Lone Star portal directly; check Recent imports';
    }
    return 'No statement emails found in the last 45 days';
  }
  return `Scan complete — ${summary.messagesFetched || 0} email(s) checked, nothing new`;
}
