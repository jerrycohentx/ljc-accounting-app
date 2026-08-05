/**
 * Journal lines that must never appear in bank/card statement reconciliation.
 *
 * YE reclass / cutover AJEs credit (or debit) cash to remove phantom QBO rollup
 * balances — they are not bank deposits or withdrawals. In QB-style recon a
 * debit to 1000 lands in Deposits and a credit in Payments, which pollutes the
 * uncleared list.
 */

/** Sources that are never bank-clearable. */
export const NON_BANK_RECON_SOURCES = [
  'ye-reclass',
  'ye-cutover',
  'ye-close',
  'year-end-close',
  'opening-reclass',
  'qbo-rollup-reclass',
];

/**
 * Description patterns for legacy rows posted before source was set.
 * Keep tight — only year-end / cutover reclass language.
 */
const NON_BANK_DESC_RES = [
  /^ye\s*reclass\b/i,
  /\bye\s*reclass\b/i,
  /\bremove\s+qbo\b[\s\S]*\brollup\b/i,
  /\byear[-\s]?end\s+reclass\b/i,
  /\bcutover\s+reclass\b/i,
];

export function isNonBankReconJournal({ source = null, description = '', jeNumber = '' } = {}) {
  const src = String(source || '').trim().toLowerCase();
  if (src && NON_BANK_RECON_SOURCES.includes(src)) return true;

  const num = String(jeNumber || '');
  if (num.startsWith('OB-') || num.includes('-OB-') || /^YEC[-_]/i.test(num)) return true;

  const desc = String(description || '').trim();
  if (!desc) return false;
  return NON_BANK_DESC_RES.some((re) => re.test(desc));
}

/**
 * Tag legacy YE reclass journals with a durable source so every entity's bank
 * recon filter stays reliable even if description wording drifts later.
 */
export async function tagYeReclassJournalSources(db) {
  try {
    const r = await db.run(
      `UPDATE journal_entries
       SET source = 'ye-reclass'
       WHERE (source IS NULL OR TRIM(source) = '')
         AND (
           description LIKE 'YE reclass%'
           OR description LIKE 'YE Reclass%'
           OR LOWER(description) LIKE 'year-end reclass%'
           OR LOWER(description) LIKE 'year end reclass%'
         )`
    );
    return { tagged: r?.changes ?? r?.rowCount ?? 0 };
  } catch (err) {
    console.warn('tagYeReclassJournalSources:', err?.message || err);
    return { tagged: 0, error: err?.message || String(err) };
  }
}

/**
 * SQL AND-fragment that excludes non-bank journals from uncleared/recon lists.
 * Expects aliases `je` (journal_entries).
 */
export function sqlExcludeNonBankReconJournals(jeAlias = 'je') {
  const srcPlaceholders = NON_BANK_RECON_SOURCES.map(() => '?').join(', ');
  return {
    sql: `
      AND COALESCE(${jeAlias}.je_number, '') NOT LIKE 'OB-%'
      AND COALESCE(${jeAlias}.je_number, '') NOT LIKE '%-OB-%'
      AND COALESCE(${jeAlias}.je_number, '') NOT LIKE 'YEC-%'
      AND COALESCE(${jeAlias}.je_number, '') NOT LIKE 'YEC_%'
      AND (
        ${jeAlias}.source IS NULL
        OR LOWER(TRIM(${jeAlias}.source)) NOT IN (${srcPlaceholders})
      )
      AND COALESCE(${jeAlias}.description, '') NOT LIKE 'YE reclass%'
      AND COALESCE(${jeAlias}.description, '') NOT LIKE 'YE Reclass%'
      AND LOWER(COALESCE(${jeAlias}.description, '')) NOT LIKE 'year-end reclass%'
      AND LOWER(COALESCE(${jeAlias}.description, '')) NOT LIKE 'year end reclass%'
      AND LOWER(COALESCE(${jeAlias}.description, '')) NOT LIKE '%remove qbo%rollup%'
      AND LOWER(COALESCE(${jeAlias}.description, '')) NOT LIKE 'cutover reclass%'
    `,
    params: NON_BANK_RECON_SOURCES.map((s) => s.toLowerCase()),
  };
}
