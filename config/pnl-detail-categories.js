/**
 * Nested P&L category trees for Summary vs Detail reporting.
 *
 * Summary collapses one level (shows group totals under the parent).
 * Detail expands leaves (law firms, title companies, per-property utilities, etc.).
 *
 * Add new categories here — boot calls ensurePnlDetailCategories() to create
 * accounts, set parents, and seed vendor → account rules.
 */
export const PNL_DETAIL_CATEGORIES = [
  {
    entityId: 'ent-ljc',
    parent: { number: '5600', name: 'Legal & Professional Fees', type: 'EXPENSE' },
    groups: [
      {
        number: '5610',
        name: 'Legal Fees',
        type: 'EXPENSE',
        children: [
          {
            number: '5611',
            name: 'Keever & Wiesenthal',
            type: 'EXPENSE',
            patterns: [
              { pattern: 'KEEVER & WIESENTHAL', priority: 8 },
              { pattern: 'KEEVER', priority: 12 },
            ],
          },
          {
            number: '5612',
            name: 'Huffstetler & Company',
            type: 'EXPENSE',
            patterns: [
              { pattern: 'HUFFSTETLER', priority: 8 },
            ],
          },
          {
            number: '5613',
            name: 'Alicia M.',
            type: 'EXPENSE',
            patterns: [
              { pattern: 'ALICIA M', priority: 8 },
            ],
          },
        ],
      },
      {
        number: '5620',
        name: 'Title & Closing',
        type: 'EXPENSE',
        children: [
          {
            number: '5621',
            name: 'Capital Title of Texas',
            type: 'EXPENSE',
            patterns: [
              { pattern: 'CAPITAL TITLE', priority: 8 },
              { pattern: 'CAPITAL TITL', priority: 9 },
            ],
          },
        ],
      },
      {
        number: '5601',
        name: 'Notary',
        type: 'EXPENSE',
        patterns: [
          { pattern: 'PAYPAL *ONLINENOTAR', priority: 8 },
          { pattern: 'ONLINENOTAR', priority: 9 },
        ],
        children: [],
      },
    ],
  },
];
