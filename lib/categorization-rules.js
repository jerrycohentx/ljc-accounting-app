/**
 * Bank transaction auto-categorization rules (QBO-style "Bank Rules").
 * Matches memo/description text and assigns the offset GL account.
 */

import { v4 as uuidv4 } from 'uuid';

/** Default rules for LJC Simmons operating account — based on real statement patterns. */
export const DEFAULT_LJC_RULES = [
  { pattern: 'CHARGEBACK', label: 'Chargeback', is_chargeback: true, priority: 10 },
  { pattern: 'ACH BATCH LJC', offset: '2110', label: 'Warehouse advance (DLOC)', priority: 20 },
  { pattern: 'Rehab-', offset: '1350', label: 'Holdback draw deposit', priority: 25 },
  { pattern: 'Draw#', offset: '1350', label: 'Holdback draw', priority: 26 },
  { pattern: 'LeanneRent', offset: '4100', label: 'Rent income', priority: 30 },
  { pattern: 'AMEX EPAYMENT', offset: '2010', label: 'Amex payment', priority: 40 },
  { pattern: 'EPAY CHASE', offset: '2011', label: 'Chase card payment', priority: 41 },
  { pattern: 'NEWREZ-SHELLPOIN', offset: '1410', label: 'Mortgage principal', priority: 50 },
  { pattern: 'FAY SERVICING', offset: '1410', label: 'Loan servicing payment', priority: 51 },
  { pattern: 'LJC to GM', offset: '1900', label: 'Due from GM', priority: 60 },
  { pattern: 'Transfer CH x', transfer: '1010', label: 'Internal transfer', is_transfer: true, priority: 70 },
  { pattern: 'Transfer from x0260', transfer: '1010', label: 'Internal transfer out', is_transfer: true, priority: 71 },
  { pattern: 'Transfer to DDA', transfer: '1010', label: 'Transfer to sub-account', is_transfer: true, priority: 72 },
  { pattern: 'Phone/In-Person Transfer', transfer: '1010', label: 'Internal transfer', is_transfer: true, priority: 73 },
  { pattern: 'LONE STAR BANK', transfer: '1001', label: 'Wire to Lone Star', is_transfer: true, priority: 80 },
  { pattern: 'Wire Transfer Debit', transfer: '1001', label: 'Wire out', is_transfer: true, priority: 81 },
  { pattern: 'Account Analysis Charge', offset: '5200', label: 'Bank service fee', priority: 90 },
  { pattern: 'WELLINGTON INSUR', offset: '5300', label: 'Insurance', priority: 100 },
  { pattern: 'PROTECTIVE LIFE', offset: '5300', label: 'Life insurance', priority: 101 },
  { pattern: 'OscarHealth', offset: '5400', label: 'Health insurance', priority: 102 },
  { pattern: 'CPENERGY ENTEX', offset: '5500', label: 'Utilities', priority: 110 },
  { pattern: 'Loan LJC FINANCIAL', offset: '1400', label: 'Loan receivable payment', priority: 120 },
  { pattern: '#P4544 LJC FINANCIAL', offset: '1400', label: 'Loan payment batch', priority: 121 },
  { pattern: 'Prin pay', offset: '2110', label: 'DLOC principal paydown', priority: 122 },
  { pattern: 'PrinPayDown', offset: '2110', label: 'DLOC principal paydown', priority: 123 },
  { pattern: 'Prin paydown', offset: '2110', label: 'DLOC principal paydown', priority: 124 },
  { pattern: 'Intpay', offset: '2110', label: 'DLOC interest payment', priority: 125 },
  { pattern: 'Loanpay#', offset: '1400', label: 'Loan payment', priority: 126 },
  { pattern: 'Adv-sub-note', offset: '1310', label: 'Warehouse advance (NR)', priority: 130 },
  { pattern: 'Adv-Rehab', offset: '1350', label: 'Rehab advance / holdback', priority: 131 },
  { pattern: 'Feb pymnt', offset: '4100', label: 'Rent income', priority: 32 },
  { pattern: 'Rent LJC FINANCIAL', offset: '4100', label: 'Rent income', priority: 33 },
  { pattern: 'MANAGERENTHOUSES', offset: '4100', label: 'Rent income', priority: 34 },
  { pattern: 'Xfr to Sim LJC', transfer: '1000', label: 'Lone Star transfer to Simmons', is_transfer: true, priority: 73 },
  { pattern: 'PAYMENT    LJC FINANCIAL', transfer: '1000', label: 'Transfer to Simmons operating', is_transfer: true, priority: 75 },
  { pattern: 'LOAN PAYMENT', offset: '2999', label: 'Lone Star WLOC payment', priority: 45 },
  { pattern: 'OVERDRAFT FEE', offset: '5200', label: 'Bank overdraft fee', priority: 92 },
  { pattern: 'INTEREST PAID', offset: '4000', label: 'Bank interest income', priority: 31 },
  { pattern: 'C.D. INTEREST', offset: '4000', label: 'CD interest income', priority: 31 },
  { pattern: 'DDA Credit Memo', offset: '2999', label: 'Lone Star LOC advance', priority: 22 },
  { pattern: 'DDA DEBIT MEMO', offset: '2999', label: 'Lone Star LOC paydown/transfer', priority: 23 },
  { pattern: 'TRANSFER_I Baselane', offset: '5700', label: 'Baselane transfer', priority: 114 },
  { pattern: 'Xfr to Sim', transfer: '1010', label: 'Transfer to Simmons sub-account', is_transfer: true, priority: 74 },
  { pattern: 'Transfer from x4177 to x0260', transfer: '1010', label: 'Transfer from sub-account', is_transfer: true, priority: 75 },
  { pattern: 'Transfer from x5718 to x0260', transfer: '1010', label: 'Transfer from 5718', is_transfer: true, priority: 76 },
  { pattern: '4JL to LJC', transfer: '1010', label: '4JL transfer in', is_transfer: true, priority: 77 },
  { pattern: '4J to LJC', transfer: '1010', label: '4J transfer in', is_transfer: true, priority: 78 },
  { pattern: 'MORTGAGE CARRINGTON', offset: '1410', label: 'Mortgage payment', priority: 52 },
  { pattern: 'MTG PYMT CARRINGTON', offset: '1410', label: 'Mortgage payment', priority: 53 },
  { pattern: 'FORT BEND COUNTY', offset: '5500', label: 'Property tax / utilities', priority: 111 },
  { pattern: 'Zelle', offset: '5700', label: 'Office / misc', priority: 115 },
  { pattern: 'RAMP STATEMENT', offset: '5700', label: 'Ramp card / software', priority: 116 },
  { pattern: 'RAMP', offset: '5700', label: 'Ramp card / software', priority: 117 },
  { pattern: 'RESIDENTIALELEVA', offset: '5700', label: 'Software subscription', priority: 118 },
  { pattern: 'ACHINVOICE USIO', offset: '5200', label: 'Bank / ACH fee', priority: 91 },
  { pattern: 'SETTLEMENT PDS', offset: '1100', label: 'Settlement pending', priority: 119 },
  { pattern: 'Refund LJC FINANCIAL', offset: '4100', label: 'Rent refund', priority: 35 },
  { pattern: 'Calvert LJC FINANCIAL', offset: '1900', label: 'Due from GM', priority: 61 },
  { pattern: 'Leanne LJC FINANCIAL', offset: '4100', label: 'Rent / draw', priority: 36 },
];

function normalize(text) {
  return String(text || '').toUpperCase();
}

function ruleMatches(rule, text) {
  const hay = normalize(text);
  const pat = normalize(rule.pattern);
  switch (rule.match_type || 'contains') {
    case 'starts_with': return hay.startsWith(pat);
    case 'exact': return hay === pat;
    case 'regex':
      try { return new RegExp(rule.pattern, 'i').test(text); } catch { return false; }
    default: return hay.includes(pat);
  }
}

export async function seedDefaultRules(db, entityId = 'ent-ljc') {
  for (const spec of DEFAULT_LJC_RULES) {
    const existing = await db.get(
      'SELECT id FROM bank_categorization_rules WHERE entity_id = ? AND pattern = ?',
      [entityId, spec.pattern]
    );
    if (existing) continue;
    await db.run(
      `INSERT INTO bank_categorization_rules
       (id, entity_id, pattern, match_type, offset_account_number, transfer_account_number,
        is_transfer, is_chargeback, priority, label, is_active)
       VALUES (?, ?, ?, 'contains', ?, ?, ?, ?, ?, ?, TRUE)`,
      [
        `rule-${uuidv4()}`,
        entityId,
        spec.pattern,
        spec.offset || null,
        spec.transfer || null,
        spec.is_transfer ? 1 : 0,
        spec.is_chargeback ? 1 : 0,
        spec.priority,
        spec.label,
      ]
    );
  }
}

export async function resolveAccountByNumber(db, entityId, accountNumber) {
  if (!accountNumber) return null;
  return db.get(
    'SELECT id, account_number, account_name, account_type FROM accounts WHERE entity_id = ? AND account_number = ? AND is_active = 1',
    [entityId, accountNumber]
  );
}

/**
 * Apply rules to a bank transaction description. Returns:
 * { offsetAccountId, offsetAccountNumber, ruleId, isTransfer, isChargeback, label }
 */
export async function categorizeTransaction(db, entityId, description) {
  const rules = await db.all(
    `SELECT * FROM bank_categorization_rules
     WHERE entity_id = ? AND is_active = 1
     ORDER BY priority ASC, pattern ASC`,
    [entityId]
  );

  for (const rule of rules) {
    if (!ruleMatches(rule, description)) continue;

    if (rule.is_chargeback) {
      return {
        isChargeback: true,
        ruleId: rule.id,
        label: rule.label || 'Chargeback',
      };
    }

    const acctNum = rule.is_transfer ? rule.transfer_account_number : rule.offset_account_number;
    let account = rule.offset_account_id
      ? await db.get('SELECT id, account_number, account_name, account_type FROM accounts WHERE id = ?', rule.offset_account_id)
      : await resolveAccountByNumber(db, entityId, acctNum);

    if (!account && acctNum) {
      account = await resolveAccountByNumber(db, entityId, acctNum);
    }

    return {
      offsetAccountId: account?.id || null,
      offsetAccountNumber: acctNum || account?.account_number,
      ruleId: rule.id,
      isTransfer: Boolean(rule.is_transfer),
      label: rule.label,
    };
  }

  return { offsetAccountId: null, label: null };
}
