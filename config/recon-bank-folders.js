/**
 * Maps GL accounts to Jerry's OneDrive bank folder layout:
 *   Banks / {Bank Name} / Reconciliations / {YYYY} /
 */
export const BANKS_ROOT_DEFAULT =
  'C:\\Users\\jerry\\OneDrive\\Desktop\\LJC Financial, LLC\\Banks';

/** account_number → folder under Banks/ */
export const RECON_BANK_FOLDERS = {
  '1000': {
    bankFolder: 'Simmons-Spirit of Texas Bank',
    /** Prefer existing folder name (plural Reconciliations). */
    reconciliationsFolder: 'Reconciliations',
    shortLabel: 'Simmons Bank',
  },
  '1001': {
    bankFolder: 'Lone Star Bank',
    /** Existing typo in OneDrive — keep so files land where Jerry already looks. */
    reconciliationsFolder: 'Reconcilliations',
    shortLabel: 'Lone Star Bank',
  },
  '2010': {
    bankFolder: 'American Express',
    reconciliationsFolder: 'Reconciliations',
    shortLabel: 'American Express',
  },
  '2011': {
    bankFolder: 'Chase Credit Card',
    reconciliationsFolder: 'Reconciliations',
    shortLabel: 'Chase Credit Card',
  },
};

export function bankFolderMeta(accountNumber) {
  const n = String(accountNumber || '');
  return (
    RECON_BANK_FOLDERS[n] || {
      bankFolder: `Account ${n}`,
      reconciliationsFolder: 'Reconciliations',
      shortLabel: `Account ${n}`,
    }
  );
}

export function reconExportDir(accountNumber, statementDate, banksRoot = process.env.RECON_BANKS_ROOT || BANKS_ROOT_DEFAULT) {
  const meta = bankFolderMeta(accountNumber);
  const year = String(statementDate || '').slice(0, 4);
  if (!/^\d{4}$/.test(year)) throw new Error(`Invalid statement date for export: ${statementDate}`);
  return {
    ...meta,
    year,
    dir: `${banksRoot}\\${meta.bankFolder}\\${meta.reconciliationsFolder}\\${year}`,
  };
}
