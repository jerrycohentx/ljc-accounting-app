/**
 * Scan posted bank/card imports for offset accounts that disagree with current rules
 * or obvious intercompany / revenue-on-wire mistakes.
 */
import { categorizeTransaction, seedDefaultRules } from './categorization-rules.js';

const BANK_NUMBERS = new Set(['1000', '1001', '1002', '1003', '1010', '1030']);
const DUMP_NUMBERS = new Set(['1100', '5700', '4091']);
const ENTITY = 'ent-ljc';
const START_DATE = '2026-01-01';

function stripImportPrefix(text) {
  return String(text || '')
    .replace(/^OFX Import:\s*/i, '')
    .replace(/^Simmons OFX [^:]+:\s*/i, '')
    .replace(/^Reconcile:\s*[^:]+:\s*/i, '')
    .replace(/^OFX:\s*[^\s]+\s*/i, '')
    .trim();
}

function classifyIssue(row, expected) {
  const desc = row.text;
  const hay = desc.toUpperCase();
  const offsetNum = row.offset_number;
  const bankOut = Number(row.bank_credit) > 0;
  const bankIn = Number(row.bank_debit) > 0;

  if (/GRACEFUL|MEADOW/i.test(hay) && bankOut && offsetNum !== '2900') {
    return { code: 'graceful_intercompany', severity: 'high', expectedNumber: '2900' };
  }
  if (/GRACEFUL|MEADOW/i.test(hay) && bankIn && !['1900', '4100'].includes(offsetNum)) {
    return { code: 'graceful_receipt', severity: 'medium', expectedNumber: '1900' };
  }
  if (bankOut && row.offset_type === 'REVENUE') {
    return { code: 'revenue_on_outbound', severity: 'high', expectedNumber: expected?.offsetAccountNumber || '?' };
  }
  if (DUMP_NUMBERS.has(offsetNum)) {
    const exp = expected?.offsetAccountNumber;
    if (exp && exp === offsetNum) return null;
    return { code: 'dump_account_posted', severity: 'medium', expectedNumber: exp || '?' };
  }
  if (expected?.offsetAccountId && expected.offsetAccountNumber
      && expected.offsetAccountNumber !== offsetNum
      && !expected.isTransfer) {
    return { code: 'rule_mismatch', severity: 'medium', expectedNumber: expected.offsetAccountNumber };
  }
  if (expected?.isTransfer && expected.offsetAccountNumber && expected.offsetAccountNumber !== offsetNum) {
    return { code: 'transfer_mismatch', severity: 'medium', expectedNumber: expected.offsetAccountNumber };
  }
  return null;
}

/**
 * @returns {Promise<object>}
 */
export async function auditSurgicalReclass(db, {
  entityId = ENTITY,
  startDate = START_DATE,
  endDate = '2026-12-31',
  accountNumbers = null,
} = {}) {
  await seedDefaultRules(db, entityId);

  const rows = await db.all(
    `SELECT je.id AS journal_id, je.je_number, je.description, je.posting_date, je.memo,
            bank.account_number AS bank_number, bank.account_name AS bank_name,
            COALESCE(bank_line.credit, 0) AS bank_credit,
            COALESCE(bank_line.debit, 0) AS bank_debit,
            off.id AS offset_line_id, off.account_id AS offset_account_id,
            off_acct.account_number AS offset_number, off_acct.account_name AS offset_name,
            off_acct.account_type AS offset_type,
            it.description AS import_description
     FROM journal_entries je
     JOIN journal_entry_lines bank_line ON bank_line.journal_entry_id = je.id
     JOIN accounts bank ON bank.id = bank_line.account_id
       AND bank.account_number IN ('1000', '1001', '1002', '1010', '1030', '2010')
     JOIN journal_entry_lines off ON off.journal_entry_id = je.id AND off.id != bank_line.id
     JOIN accounts off_acct ON off_acct.id = off.account_id
     LEFT JOIN import_transactions it ON it.journal_entry_id = je.id
     WHERE je.entity_id = ?
       AND je.status = 'POSTED'
       AND je.reversed_by_je_id IS NULL
       AND je.reverses_je_id IS NULL
       AND je.posting_date >= ? AND je.posting_date <= ?
       AND (je.je_number LIKE 'IMP-%' OR je.description LIKE '%OFX Import%' OR je.description LIKE 'Reconcile:%')
       AND bank_line.line_number = 1
       AND off.line_number = 2
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries r
         WHERE r.entity_id = je.entity_id AND r.status = 'POSTED'
           AND r.memo LIKE ('reclass-offset:' || je.id || ':' || off.id || '%')
       )
     ORDER BY je.posting_date, je.je_number`,
    [entityId, startDate, endDate]
  );

  const byJe = new Map();
  for (const row of rows) {
    if (accountNumbers && !accountNumbers.has(row.bank_number)) continue;
    if (!byJe.has(row.journal_id)) byJe.set(row.journal_id, row);
  }

  const issues = [];
  for (const row of byJe.values()) {
    const text = stripImportPrefix(row.import_description || row.description || '');
    const expected = await categorizeTransaction(db, entityId, text);
    const issue = classifyIssue({ ...row, text }, expected);
    if (!issue) continue;
    issues.push({
      journalId: row.journal_id,
      jeNumber: row.je_number,
      postingDate: String(row.posting_date).slice(0, 10),
      bankNumber: row.bank_number,
      amount: Math.max(Number(row.bank_debit), Number(row.bank_credit)),
      description: text.slice(0, 120),
      offsetNumber: row.offset_number,
      offsetName: row.offset_name,
      offsetLineId: row.offset_line_id,
      ...issue,
      ruleLabel: expected?.label || null,
    });
  }

  const byCode = {};
  for (const i of issues) {
    byCode[i.code] = (byCode[i.code] || 0) + 1;
  }

  return {
    entityId,
    startDate,
    endDate,
    scanned: byJe.size,
    errorCount: issues.length,
    byCode,
    samples: issues.slice(0, 25),
    issues,
  };
}
