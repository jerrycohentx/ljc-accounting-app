import { v4 as uuidv4 } from 'uuid';

/** LJC only has an active warehouse line with Simmons Bank (2026). */
export const ACTIVE_FUNDING_BANK = 'Simmons';

export const FUNDING_BANK_COA = {
  Simmons: {
    cash: { number: '1000', name: 'Cash & Bank Accounts - Simmons', type: 'ASSET', normalBalance: 'DEBIT' },
    dloc: { number: '2110', name: 'DLOC - Simmons Bank', type: 'LIABILITY', normalBalance: 'CREDIT' },
    notesReceivable: { number: '1310', name: 'Notes Receivable - Simmons DLOC', type: 'ASSET', normalBalance: 'DEBIT' },
    holdback: { number: '1350', name: 'Holdbacks - Simmons Bank', type: 'ASSET', normalBalance: 'DEBIT' },
    expense: { number: '5100', name: 'Draw & Inspection Fees', type: 'EXPENSE', normalBalance: 'DEBIT' },
  },
};

export function resolveFundingBank(wl) {
  const key = String(wl || ACTIVE_FUNDING_BANK).trim();
  if (key === ACTIVE_FUNDING_BANK || key === 'Portfolio') return ACTIVE_FUNDING_BANK;
  return ACTIVE_FUNDING_BANK;
}

export async function ensureFundingBankAccounts(db, entityId, fundingBank = ACTIVE_FUNDING_BANK) {
  const bank = resolveFundingBank(fundingBank);
  const specs = FUNDING_BANK_COA[bank];
  if (!specs) throw new Error(`Unsupported funding bank: ${bank}`);

  const accounts = {};
  for (const [role, spec] of Object.entries(specs)) {
    let row = await db.get(
      `SELECT id, account_number, account_name FROM accounts
       WHERE entity_id = ? AND account_number = ? LIMIT 1`,
      entityId,
      spec.number
    );
    if (!row) {
      const id = `acc-${uuidv4()}`;
      await db.run(
        `INSERT INTO accounts
         (id, entity_id, account_number, account_name, account_type, normal_balance, is_active)
         VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
        [id, entityId, spec.number, spec.name, spec.type, spec.normalBalance]
      );
      row = { id, account_number: spec.number, account_name: spec.name };
    }
    accounts[role] = row;
  }
  return { bank, accounts };
}
