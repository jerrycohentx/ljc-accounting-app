/**
 * Persist durable bank_categorization_rules from already-correct posted activity.
 * Uses the same learnCategorizationRule path as Feed Review corrections.
 */
import { v4 as uuidv4 } from 'uuid';
import { learnCategorizationRule } from './import-commit.js';
import { seedDefaultRules } from './categorization-rules.js';

const DUMP_ACCOUNTS = new Set(['5700', '4091', '1100']);

/** High-confidence merchant seeds distilled from correctly coded Amex / OFX history. */
export const HISTORY_MERCHANT_SEEDS = [
  { pattern: 'GOV*HCTAX', offset: '6120', label: 'Harris County property tax', priority: 8 },
  { pattern: 'HCTAX', offset: '6120', label: 'Harris County property tax', priority: 9 },
  { pattern: 'FT BEND CO TAX', offset: '6120', label: 'Fort Bend property tax', priority: 8 },
  { pattern: 'FORT BEND COUNTY', offset: '6120', label: 'Fort Bend property tax', priority: 8 },
  { pattern: 'CHUBB', offset: '5300', label: 'Chubb insurance', priority: 8 },
  { pattern: 'US ASSURE', offset: '5300', label: 'US Assure insurance', priority: 8 },
  { pattern: 'RYAN SPECIALTY', offset: '5300', label: 'Ryan Specialty insurance', priority: 8 },
  { pattern: 'OBSIDIAN ADMITTED', offset: '5300', label: 'Obsidian / Wellington insurance', priority: 8 },
  { pattern: 'FIRST CONNECT INSUR', offset: '5300', label: 'First Connect insurance', priority: 8 },
  { pattern: 'DELTA GENERAL AGENCY', offset: '5300', label: 'Delta General Agency insurance', priority: 8 },
  { pattern: 'PROTECTIVE LIFE', offset: '5300', label: 'Protective Life insurance', priority: 8 },
  { pattern: 'WELLINGTON INSUR', offset: '5300', label: 'Wellington insurance', priority: 8 },
  { pattern: 'OSCARHEALTH', offset: '5400', label: 'Oscar health insurance', priority: 8 },
  { pattern: 'OSCAR HEALTH', offset: '5400', label: 'Oscar health insurance', priority: 8 },
  { pattern: 'CVS PHARMACY', offset: '5400', label: 'Pharmacy — health', priority: 9 },
  { pattern: 'CENTERWELL PHARMACY', offset: '5400', label: 'Pharmacy — health', priority: 9 },
  { pattern: 'OPTUM HOME DELIVERY', offset: '5400', label: 'Pharmacy — health', priority: 9 },
  { pattern: 'FLBLUE', offset: '5400', label: 'Florida Blue health', priority: 9 },
  { pattern: 'COMPLETE HEALTH', offset: '5410', label: 'Member health', priority: 9 },
  { pattern: 'DAVID B FISHER', offset: '5410', label: 'Member dental', priority: 8 },
  { pattern: 'HMSPG ORTHO', offset: '5410', label: 'Member ortho', priority: 9 },
  { pattern: 'ALICIA M', offset: '5600', label: 'Professional fees — Alicia M', priority: 8 },
  { pattern: 'KEEVER & WIESENTHAL', offset: '5600', label: 'Professional fees', priority: 9 },
  { pattern: 'HUFFSTETLER', offset: '5600', label: 'Professional fees', priority: 9 },
  { pattern: 'COMCAST', offset: '6254', label: 'Wentworth internet — tenant reimbursable', priority: 8 },
  { pattern: 'XFINITY', offset: '6254', label: 'Wentworth internet — tenant reimbursable', priority: 8 },
  { pattern: 'VERIZONWRLSS', offset: '5710', label: 'Wireless (non-Wentworth)', priority: 10 },
  { pattern: 'VERIZON', offset: '5710', label: 'Wireless (non-Wentworth)', priority: 11 },
  { pattern: 'RELIANT ENERGY', offset: '6252', label: 'Wentworth electric — tenant reimbursable', priority: 8 },
  { pattern: 'JUST ENERGY', offset: '6252', label: 'Wentworth electric — tenant reimbursable', priority: 8 },
  { pattern: 'Chabad-CHAI', offset: '5720', label: 'Donation', priority: 9 },
  { pattern: 'CHABAD', offset: '5720', label: 'Donation', priority: 10 },
  { pattern: 'LAWNCARE', offset: '5750', label: 'Lawn / repairs', priority: 10 },
  { pattern: 'LAWNSTARTER', offset: '5750', label: 'Lawn / repairs', priority: 10 },
  { pattern: 'LISTER PLUMBING', offset: '5750', label: 'Plumbing repairs', priority: 9 },
  { pattern: 'PLUMBING SYSTEM PROS', offset: '5750', label: 'Plumbing repairs', priority: 9 },
  { pattern: 'WIRED ELECTRICAL', offset: '5750', label: 'Electrical repairs', priority: 9 },
  { pattern: 'THE HOME DEPOT', offset: '5750', label: 'Repairs / supplies', priority: 10 },
  { pattern: 'HOMEDEPOT', offset: '5750', label: 'Repairs / supplies', priority: 10 },
  { pattern: 'FLOOR AND DECOR', offset: '5750', label: 'Repairs / flooring', priority: 9 },
  { pattern: 'AQUA POOL', offset: '6100', label: 'Rental property expense', priority: 10 },
  { pattern: 'KIAVI', offset: '5800', label: 'Lending platform fee', priority: 10 },
  { pattern: 'ATG PAY', offset: '5300', label: 'Insurance / ATG', priority: 12 },
  { pattern: 'ATGPAY', offset: '5300', label: 'Insurance / ATG', priority: 12 },
  { pattern: 'COVINGTON WOO', offset: '5300', label: 'Insurance / Covington', priority: 12 },
  { pattern: 'RHYTHM OPS', offset: '5500', label: 'Utilities', priority: 10 },
  { pattern: 'DALLAS WATER', offset: '5500', label: 'Utilities', priority: 10 },
  { pattern: "SAM'S CLUB FUEL", offset: '5910', label: 'Automobile / fuel', priority: 9 },
  { pattern: 'SAMS CLUB FUEL', offset: '5910', label: 'Automobile / fuel', priority: 9 },
  { pattern: "SAM'S CLUB", offset: '5740', label: 'Office / warehouse supplies', priority: 12 },
  { pattern: 'MISTER CAR WASH', offset: '5910', label: 'Automobile', priority: 10 },
  { pattern: 'HOUSTON CHRONICLE', offset: '5730', label: 'Subscriptions', priority: 10 },
  { pattern: 'WALGREENS', offset: '5400', label: 'Pharmacy / health', priority: 11 },
  { pattern: 'NORTHERN TOOL', offset: '5750', label: 'Tools / repairs', priority: 10 },
  { pattern: 'SURGERY CENTER', offset: '5410', label: 'Member medical', priority: 9 },
  { pattern: 'IN *WIRED ELECTRIC', offset: '5750', label: 'Electrical repairs', priority: 9 },
  { pattern: 'WIRED ELECTRIC', offset: '5750', label: 'Electrical repairs', priority: 10 },
  { pattern: 'AMAZON', offset: '5740', label: 'Office supplies / Amazon', priority: 40 },
  { pattern: 'AMZN', offset: '5740', label: 'Office supplies / Amazon', priority: 41 },
  { pattern: 'APPLE.COM', offset: '5710', label: 'Computer / software', priority: 20 },
  { pattern: 'MICROSOFT', offset: '5710', label: 'Computer / software', priority: 20 },
  { pattern: 'ADOBE', offset: '5710', label: 'Computer / software', priority: 20 },
  { pattern: 'GOOGLE *', offset: '5710', label: 'Computer / software', priority: 21 },
  { pattern: 'OPENAI', offset: '5710', label: 'Computer / software', priority: 20 },
  { pattern: 'CURSOR', offset: '5710', label: 'Computer / software', priority: 20 },
  { pattern: 'GITHUB', offset: '5710', label: 'Computer / software', priority: 20 },
  { pattern: 'SHELL OIL', offset: '5910', label: 'Automobile / fuel', priority: 12 },
  { pattern: 'EXXON', offset: '5910', label: 'Automobile / fuel', priority: 12 },
  { pattern: 'CHEVRON', offset: '5910', label: 'Automobile / fuel', priority: 12 },
  { pattern: 'INTEREST CHARGE', offset: '5000', label: 'Amex interest', priority: 7 },
  { pattern: 'INTUIT QUICKBOOKS', offset: '5710', label: 'Software — QuickBooks', priority: 9 },
  { pattern: 'QUICKBOOKS', offset: '5710', label: 'Software — QuickBooks', priority: 10 },
  { pattern: 'BLUEHOST', offset: '5710', label: 'Web hosting', priority: 10 },
  { pattern: 'CALLRAIL', offset: '5780', label: 'Advertising — CallRail', priority: 10 },
  { pattern: 'STOR-IT SELF STORAGE', offset: '6100', label: 'Storage — rental property', priority: 10 },
  { pattern: 'FIRST AMERICAN FLOOD', offset: '5300', label: 'Flood insurance / data', priority: 9 },
  { pattern: 'HIGHLAND SPECIALITY PHARM', offset: '5400', label: 'Pharmacy — health', priority: 9 },
  { pattern: 'HIGHLAND SPECIALTY PHARM', offset: '5400', label: 'Pharmacy — health', priority: 9 },
  { pattern: 'SLADE & BAKER', offset: '5410', label: 'Member vision', priority: 9 },
  { pattern: 'METHODIST', offset: '5410', label: 'Member medical / parking', priority: 15 },
  { pattern: 'BAYLOR', offset: '5410', label: 'Member medical / parking', priority: 15 },
  { pattern: 'AMK VALET', offset: '5410', label: 'Medical parking', priority: 12 },
  { pattern: 'CITY OF SUGAR LAND', offset: '6100', label: 'Municipal / property fees', priority: 12 },
  { pattern: 'ONLINENOTAR', offset: '5600', label: 'Notary / professional', priority: 10 },
  { pattern: 'PAYPAL *ONLINENOTAR', offset: '5600', label: 'Notary / professional', priority: 9 },
  { pattern: 'LATE FEE', offset: '5200', label: 'Card late fee', priority: 8 },
];

async function upsertSeedRule(db, entityId, seed) {
  const existing = await db.get(
    'SELECT id FROM bank_categorization_rules WHERE entity_id = ? AND pattern = ?',
    [entityId, seed.pattern]
  );
  if (existing) {
    await db.run(
      `UPDATE bank_categorization_rules
       SET offset_account_number = ?, transfer_account_number = NULL, is_transfer = false,
           is_chargeback = false, is_active = TRUE, label = ?, priority = ?
       WHERE id = ?`,
      [seed.offset, seed.label, seed.priority, existing.id]
    );
    return { id: existing.id, updated: true };
  }
  const id = `rule-${uuidv4()}`;
  await db.run(
    `INSERT INTO bank_categorization_rules
     (id, entity_id, pattern, match_type, offset_account_number, transfer_account_number,
      is_transfer, is_chargeback, priority, label, is_active)
     VALUES (?, ?, ?, 'contains', ?, NULL, false, false, ?, ?, TRUE)`,
    [id, entityId, seed.pattern, seed.offset, seed.priority, seed.label]
  );
  return { id, inserted: true };
}

/**
 * Seed merchant rules from known-correct history, then mine posted AMEX/IMP
 * lines already on non-dump expense accounts into Learned rules.
 */
export async function learnCategorizationFromHistory(db, {
  entityId = 'ent-ljc',
  startDate = '2026-01-01',
  endDate = '2026-06-30',
} = {}) {
  await seedDefaultRules(db, entityId);

  const seeded = [];
  for (const seed of HISTORY_MERCHANT_SEEDS) {
    seeded.push({ pattern: seed.pattern, offset: seed.offset, ...(await upsertSeedRule(db, entityId, seed)) });
  }

  // Fort Bend was historically seeded to utilities — property tax office is 6120.
  await db.run(
    `UPDATE bank_categorization_rules
     SET offset_account_number = '6120', label = 'Fort Bend property tax', priority = 8
     WHERE entity_id = ? AND pattern = 'FORT BEND COUNTY'`,
    [entityId]
  );

  const rows = await db.all(
    `SELECT je.id AS journal_id, je.description, je.je_number, je.memo,
            a.account_number AS offset_number, a.id AS offset_account_id,
            jel.description AS line_description
     FROM journal_entries je
     JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
     JOIN accounts a ON a.id = jel.account_id
     WHERE je.entity_id = ?
       AND je.status = 'POSTED'
       AND je.reversed_by_je_id IS NULL
       AND je.reverses_je_id IS NULL
       AND je.posting_date >= ? AND je.posting_date <= ?
       AND (je.je_number LIKE 'AMEX-%' OR je.je_number LIKE 'IMP-%')
       AND a.account_type IN ('EXPENSE', 'INCOME', 'COGS', 'OTHER_EXPENSE', 'OTHER_INCOME')
       AND a.account_number NOT IN ('5700', '4091', '1100')
       AND COALESCE(jel.debit, 0) + COALESCE(jel.credit, 0) > 0
       AND je.description NOT LIKE '%Amex Mar cycle%'
       AND je.description NOT LIKE '%charge catch-up%'`,
    [entityId, startDate, endDate]
  );

  let learned = 0;
  const samples = [];
  for (const row of rows) {
    if (DUMP_ACCOUNTS.has(String(row.offset_number))) continue;
    const text = [row.description, row.line_description, row.memo].filter(Boolean).join(' ');
    const id = await learnCategorizationRule(db, {
      entityId,
      description: text,
      offsetAccountId: row.offset_account_id,
    });
    if (id) {
      learned += 1;
      if (samples.length < 40) {
        samples.push({
          je: row.je_number,
          offset: row.offset_number,
          text: text.slice(0, 100),
        });
      }
    }
  }

  return {
    entityId,
    startDate,
    endDate,
    seedsUpserted: seeded.length,
    learnedFromPosted: learned,
    scannedCorrectOffsets: rows.length,
    samples,
  };
}
