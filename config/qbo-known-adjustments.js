/**
 * Documented QBO source corrections applied when building reports from YE trial balances.
 * These are not plugs — they reverse known mis-posts identified from QBO transaction detail.
 */

export const QBO_PL_KNOWN_ADJUSTMENTS = [
  {
    id: 'ivymount-rental-mispost-215k',
    entityId: 'ent-ljc',
    taxYear: 2025,
    /**
     * Match QBO P&L / TB account name (substring, case-insensitive).
     * Amount is subtracted from reported revenue (positive = reduce income).
     */
    accountNameIncludes: 'Rental Income:13923 Ivymount',
    reduceRevenueBy: 215000,
    reason:
      'QBO 10/15/2025 REO conveyance to Justin Financial ($215,000) was mis-posted as rental income. ' +
      'Real 2025 Ivymount rent was $2,200 (December). Contra to Due from Justin Financial (1901).',
    offsetAccountNumber: '1901',
    offsetAccountName: 'Due From - Justin Financial LLC',
    sourceRef: 'QBO Transaction Detail by Account 2025; Ivymount_Correction_Draft.beancount',
  },
];
