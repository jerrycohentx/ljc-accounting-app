/**
 * Mirror intercompany account pairs across Cohen entities.
 * sideA/sideB: { entity, account, role: 'due_from'|'due_to', qboPattern? }
 * due_from = asset (positive when counterparty owes this entity)
 * due_to = liability (positive when this entity owes counterparty)
 */

export const INTERCOMPANY_PAIRS = [
  {
    id: 'ljc-gm',
    label: 'LJC ↔ Graceful Meadows',
    sideA: { entity: 'ent-ljc', account: '1900', role: 'due_from', qboPattern: /graceful meadows/i },
    sideB: { entity: 'ent-gm', account: '2900', role: 'due_to' },
    master: 'sideA',
  },
  {
    id: 'ljc-justin-receivable',
    label: 'LJC due from Justin ↔ Justin due to LJC (IC)',
    sideA: { entity: 'ent-ljc', account: '1901', role: 'due_from', qboPattern: /justin financial/i },
    sideB: { entity: 'ent-justin', account: '2901', role: 'due_to' },
    master: 'sideA',
  },
  {
    id: 'ljc-justin-payable',
    label: 'LJC due to Justin ↔ Justin due from LJC (IC)',
    sideA: { entity: 'ent-ljc', account: '2901', role: 'due_to' },
    sideB: { entity: 'ent-justin', account: '1900', role: 'due_from', qboPattern: /due \(to\) from:ljc financial/i },
    master: 'sideB',
  },
  {
    id: 'ljc-omc',
    label: 'LJC due to OMC ↔ OMC due from LJC',
    sideA: { entity: 'ent-ljc', account: '2902', role: 'due_to', qboPattern: /omc housing/i },
    sideB: { entity: 'ent-omc', account: '1900', role: 'due_from', qboPattern: /due from \(to\):ljc financial/i },
    master: 'sideB',
  },
  {
    id: 'ljc-qof',
    label: 'LJC due from QOF ↔ QOF due to LJC',
    sideA: { entity: 'ent-ljc', account: '1903', role: 'due_from', qboPattern: /due from - to:ljc qof/i },
    sideB: { entity: 'ent-qof', account: '2900', role: 'due_to', qboPattern: /ljc financial/i },
    master: 'sideA',
  },
  {
    id: 'ljc-4jl',
    label: 'LJC due to 4J&L ↔ 4J&L due from LJC',
    sideA: { entity: 'ent-ljc', account: '2910', role: 'due_to' },
    sideB: { entity: 'ent-4jl', account: '1900', role: 'due_from', qboPattern: /due \(to\) from:ljc financial/i },
    master: 'sideB',
  },
  {
    id: 'justin-4jl',
    label: 'Justin due to 4J&L ↔ 4J&L due from Justin',
    sideA: { entity: 'ent-justin', account: '2910', role: 'due_to', qboPattern: /due \(to\) from:4j&l/i },
    sideB: { entity: 'ent-4jl', account: '1901', role: 'due_from' },
    master: 'sideA',
  },
];

/** Justin notes payable to LJC — loan docs, NOT intercompany operating (no mirror tie). */
export const NON_IC_ACCOUNTS = [
  { entity: 'ent-justin', account: '2900', qboPattern: /notes payable:ljc financial/i, label: 'Notes Payable - LJC (loans)' },
];
