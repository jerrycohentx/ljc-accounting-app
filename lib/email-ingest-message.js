/** Plain-language scan result for the UI toast. */

export function buildEmailIngestMessage(summary) {
  if (!summary || summary.skipped) {
    return summary?.reason === 'already running'
      ? 'Email scan already in progress'
      : 'Email scan skipped';
  }

  const parts = [];
  const results = summary.results || [];
  const downloaded = results.filter((r) =>
    r.attachmentResults?.some((a) => a.downloadSource && !a.skipped)
  );
  const imported = results.filter((r) =>
    r.attachmentResults?.some((a) => a.importResult?.imported > 0)
  );
  const failed = results.filter((r) =>
    r.attachmentResults?.some((a) => a.error)
  );
  const skipped = results.filter((r) => r.skipped);
  const retried = results.filter((r) => r.retried);

  if (downloaded.length) {
    parts.push(`Downloaded ${downloaded.length} Lone Star statement(s)`);
  }
  if (imported.length) {
    parts.push(`Imported ${imported.length} statement(s)`);
  }
  if (failed.length) {
    const err = failed[0]?.attachmentResults?.find((a) => a.error)?.error
      || summary.errors?.[0]?.error;
    parts.push(err ? `Failed: ${err.slice(0, 120)}` : `${failed.length} failed`);
  }
  if (retried.length && !downloaded.length && !imported.length && !failed.length) {
    parts.push('Retried Lone Star download — check Recent imports below');
  }
  if (skipped.length && !downloaded.length && !imported.length && !failed.length) {
    parts.push(`${skipped.length} email(s) already processed — no new statements`);
  }
  if (summary.lonestarNoticesFound && !downloaded.length && !imported.length && !failed.length) {
    if (!summary.lonestarPortalConfigured) {
      parts.push('Lone Star notice found — add LONESTAR_ONLINE_PASSWORD on Render');
    } else if (!skipped.length) {
      parts.push('Lone Star notice seen but nothing new to import');
    }
  }
  if (summary.messagesFetched === 0) {
    return 'No statement emails found in the last 45 days';
  }
  if (!parts.length) {
    return `Scan complete — ${summary.messagesFetched || 0} email(s) checked, nothing new`;
  }
  return parts.join('. ');
}
