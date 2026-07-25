/**
 * Wentworth (3427) utilities are tenant-reimbursed per the Wentworth lease —
 * book as receivable assets, not P&L expenses (gas / electric / water / internet).
 *
 * Policy source of truth: Wentworth lease (tenant reimburses utilities paid by landlord).
 */
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { postJournalEntryToGl } from './post-journal.js';
import { normalizeIsoDate } from './bank-statement-view.js';
import { reopenPeriod, closePeriod, monthBounds } from './period-lock.js';
import { getPeriodIntegrityStatus } from './period-integrity.js';
import { seedDefaultRules } from './categorization-rules.js';

export const WENTWORTH_UTIL_CONFIRM = (entityId) => `WENTWORTH-UTIL-${entityId}`;

/** Durable citation — do not treat chat memory as the authority. */
export const WENTWORTH_POLICY_SOURCE = 'Wentworth lease';

const LEASE_NOTE =
  'Source: Wentworth lease — tenant reimburses utilities paid by landlord. Not a company expense.';

const WENTWORTH_ACCOUNTS = [
  {
    number: '6251',
    name: 'Due from Tenant — Gas — 3427 Wentworth',
    description: `${LEASE_NOTE} Vendors: CenterPoint ENTEX.`,
  },
  {
    number: '6252',
    name: 'Due from Tenant — Electric — 3427 Wentworth',
    description: `${LEASE_NOTE} Vendors: Reliant / Just Energy.`,
  },
  {
    number: '6253',
    name: 'Due from Tenant — Water — 3427 Wentworth',
    description: LEASE_NOTE,
  },
  {
    number: '6254',
    name: 'Due from Tenant — Internet — 3427 Wentworth',
    description: `${LEASE_NOTE} Vendors: Comcast / Xfinity.`,
  },
];

const RULE_UPDATES = [
  { pattern: 'CPENERGY ENTEX', offset: '6251', label: 'Wentworth gas (lease — tenant reimbursable)', priority: 12 },
  { pattern: 'ENTEX CNP', offset: '6251', label: 'Wentworth gas (lease — tenant reimbursable)', priority: 12 },
  { pattern: 'CENTERPOINT ENERGY', offset: '6251', label: 'Wentworth gas (lease — tenant reimbursable)', priority: 13 },
  { pattern: 'RELIANT ENERGY', offset: '6252', label: 'Wentworth electric (lease — tenant reimbursable)', priority: 8 },
  { pattern: 'JUST ENERGY', offset: '6252', label: 'Wentworth electric (lease — tenant reimbursable)', priority: 8 },
  { pattern: 'PENNYWISE POWER', offset: '6252', label: 'Wentworth electric (lease — tenant reimbursable)', priority: 14 },
  { pattern: 'COMCAST', offset: '6254', label: 'Wentworth internet (lease — tenant reimbursable)', priority: 8 },
  { pattern: 'XFINITY', offset: '6254', label: 'Wentworth internet (lease — tenant reimbursable)', priority: 8 },
];

async function upsertRule(db, entityId, spec) {
  const existing = await db.get(
    'SELECT id FROM bank_categorization_rules WHERE entity_id = ? AND pattern = ?',
    [entityId, spec.pattern]
  );
  if (existing) {
    await db.run(
      `UPDATE bank_categorization_rules
       SET offset_account_number = ?, transfer_account_number = NULL, is_transfer = false,
           is_chargeback = false, is_active = TRUE, label = ?, priority = ?
       WHERE id = ?`,
      [spec.offset, spec.label, spec.priority, existing.id]
    );
    return { id: existing.id, updated: true };
  }
  const id = `rule-${uuidv4()}`;
  await db.run(
    `INSERT INTO bank_categorization_rules
     (id, entity_id, pattern, match_type, offset_account_number, transfer_account_number,
      is_transfer, is_chargeback, priority, label, is_active)
     VALUES (?, ?, ?, 'contains', ?, NULL, false, false, ?, ?, TRUE)`,
    [id, entityId, spec.pattern, spec.offset, spec.priority, spec.label]
  );
  return { id, inserted: true };
}

async function ensureWentworthUtilityAccounts(db, entityId) {
  const ar = await db.get(
    `SELECT id FROM accounts WHERE entity_id = ? AND account_number = '1200' LIMIT 1`,
    [entityId]
  );
  const parentId = ar?.id || null;
  const results = [];

  for (const spec of WENTWORTH_ACCOUNTS) {
    let row = await db.get(
      `SELECT id, account_number, account_name, account_type FROM accounts
       WHERE entity_id = ? AND account_number = ?`,
      [entityId, spec.number]
    );
    if (!row) {
      const id = `acc-${uuidv4()}`;
      await db.run(
        `INSERT INTO accounts
         (id, entity_id, account_number, account_name, account_type, normal_balance,
          parent_account_id, description, is_active)
         VALUES (?, ?, ?, ?, 'ASSET', 'DEBIT', ?, ?, TRUE)`,
        [id, entityId, spec.number, spec.name, parentId, spec.description]
      );
      results.push({ number: spec.number, created: true, id });
      continue;
    }
    await db.run(
      `UPDATE accounts
       SET account_name = ?, account_type = 'ASSET', normal_balance = 'DEBIT',
           parent_account_id = COALESCE(?, parent_account_id),
           description = ?, is_active = TRUE, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [spec.name, parentId, spec.description, row.id]
    );
    results.push({
      number: spec.number,
      updated: true,
      id: row.id,
      wasType: row.account_type,
    });
  }
  return results;
}

function toIsoDate(value) {
  return normalizeIsoDate(value) || String(value || '').slice(0, 10);
}

/**
 * Move Comcast/Xfinity lines parked on expense (5710/5700/5500) onto 6254.
 * Electric/gas already on 6251/6252 become non-expense via account_type flip.
 */
async function reclassWentworthInternetFromExpense(db, {
  entityId,
  userId,
  startDate,
  endDate,
  dryRun,
  reclose,
}) {
  const internet = await db.get(
    `SELECT id, account_number FROM accounts WHERE entity_id = ? AND account_number = '6254'`,
    [entityId]
  );
  if (!internet) throw new Error('6254 not found');

  const rows = await db.all(
    `SELECT gl.id AS gl_id, gl.debit, gl.credit, gl.posting_date, gl.description AS gl_description,
            je.id AS journal_id, je.je_number, je.description AS je_description, je.memo,
            a.account_number AS from_account_number, a.id AS from_account_id
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id
       AND je.status = 'POSTED'
       AND je.reversed_by_je_id IS NULL
       AND je.reverses_je_id IS NULL
     JOIN accounts a ON a.id = gl.account_id
     WHERE gl.entity_id = ?
       AND gl.posting_date >= ? AND gl.posting_date <= ?
       AND a.account_type = 'EXPENSE'
       AND a.account_number IN ('5700', '5710', '5500', '6100')
       AND (
         UPPER(COALESCE(je.description,'')) LIKE '%COMCAST%'
         OR UPPER(COALESCE(je.description,'')) LIKE '%XFINITY%'
         OR UPPER(COALESCE(je.memo,'')) LIKE '%COMCAST%'
         OR UPPER(COALESCE(je.memo,'')) LIKE '%XFINITY%'
         OR UPPER(COALESCE(gl.description,'')) LIKE '%COMCAST%'
         OR UPPER(COALESCE(gl.description,'')) LIKE '%XFINITY%'
       )
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries r
         WHERE r.entity_id = je.entity_id
           AND r.status = 'POSTED'
           AND r.reversed_by_je_id IS NULL
           AND r.memo LIKE ('reclass-wentworth-util:' || je.id || ':' || gl.id || '%')
       )
     ORDER BY gl.posting_date, je.je_number`,
    [entityId, startDate, endDate]
  );

  // Also catch reclass-rules memos: format is reclass-rules:<jeId>:<glId>
  // Postgres/SQLite SUBSTR of uuid may be wrong length — resolve via join on memo prefix.
  const extra = await db.all(
    `SELECT gl.id AS gl_id, gl.debit, gl.credit, gl.posting_date, gl.description AS gl_description,
            je.id AS journal_id, je.je_number, je.description AS je_description, je.memo,
            a.account_number AS from_account_number, a.id AS from_account_id
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id
       AND je.status = 'POSTED'
       AND je.reversed_by_je_id IS NULL
       AND je.reverses_je_id IS NULL
     JOIN accounts a ON a.id = gl.account_id AND a.account_number = '5710'
     JOIN journal_entries orig ON je.memo LIKE ('reclass-rules:' || orig.id || ':%')
     WHERE gl.entity_id = ?
       AND gl.posting_date >= ? AND gl.posting_date <= ?
       AND (UPPER(COALESCE(orig.description,'')) LIKE '%COMCAST%'
         OR UPPER(COALESCE(orig.description,'')) LIKE '%XFINITY%')
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries r
         WHERE r.entity_id = je.entity_id
           AND r.status = 'POSTED'
           AND r.reversed_by_je_id IS NULL
           AND r.memo LIKE ('reclass-wentworth-util:' || je.id || ':' || gl.id || '%')
       )`,
    [entityId, startDate, endDate]
  );

  const seen = new Set();
  const combined = [];
  for (const row of [...rows, ...extra]) {
    if (seen.has(row.gl_id)) continue;
    seen.add(row.gl_id);
    combined.push(row);
  }

  const results = [];
  let reclassed = 0;
  const monthsTouched = new Set();

  for (const row of combined) {
    const debit = new Decimal(row.debit || 0);
    const credit = new Decimal(row.credit || 0);
    if (debit.isZero() && credit.isZero()) continue;
    const amount = Decimal.max(debit, credit);
    const postingDate = toIsoDate(row.posting_date);
    const entry = {
      jeNumber: row.je_number,
      postingDate,
      amount: Number(amount.toFixed(2)),
      fromAccount: row.from_account_number,
      toAccount: '6254',
      description: (row.je_description || '').slice(0, 120),
    };

    if (dryRun) {
      results.push({ ...entry, dryRun: true });
      reclassed += 1;
      continue;
    }

    const { periodStart, periodEnd } = monthBounds(postingDate);
    const integrity = await getPeriodIntegrityStatus(db, { entityId, periodStart, periodEnd });
    if (integrity.isClosed || integrity.databasePeriodStatus === 'CLOSED') {
      await reopenPeriod(db, { entityId, periodStart, periodEnd });
    }
    monthsTouched.add(`${periodStart}|${periodEnd}`);

    const jeId = `je-${uuidv4()}`;
    const jeNumber = `RCLS-WWUTIL-${Date.now()}-${uuidv4().substring(0, 6)}`;
    const memo = `reclass-wentworth-util:${row.journal_id}:${row.gl_id}`;

    await db.run(
      `INSERT INTO journal_entries
       (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
      [
        jeId,
        entityId,
        jeNumber,
        `Reclass Wentworth internet → 6254: ${row.je_number}`,
        postingDate,
        userId,
        amount.toFixed(2),
        amount.toFixed(2),
        memo,
      ]
    );

    if (debit.gt(0)) {
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, ?, 0, ?, 1)`,
        [`jel-${uuidv4()}`, jeId, internet.id, debit.toFixed(2), 'Wentworth internet — tenant reimbursable']
      );
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, 0, ?, ?, 2)`,
        [`jel-${uuidv4()}`, jeId, row.from_account_id, debit.toFixed(2), `Clear ${row.from_account_number}`]
      );
    } else {
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, ?, 0, ?, 1)`,
        [`jel-${uuidv4()}`, jeId, row.from_account_id, credit.toFixed(2), `Clear ${row.from_account_number}`]
      );
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, 0, ?, ?, 2)`,
        [`jel-${uuidv4()}`, jeId, internet.id, credit.toFixed(2), 'Wentworth internet — tenant reimbursable']
      );
    }

    await postJournalEntryToGl(db, { journalId: jeId, entityId, userId });
    results.push({ ...entry, reclassJeId: jeId, reclassJeNumber: jeNumber });
    reclassed += 1;
  }

  const reclosed = [];
  if (!dryRun && reclose) {
    for (const key of monthsTouched) {
      const [periodStart, periodEnd] = key.split('|');
      try {
        const integrity = await getPeriodIntegrityStatus(db, { entityId, periodStart, periodEnd });
        if (integrity.canClose) {
          reclosed.push({
            periodStart,
            periodEnd,
            ...(await closePeriod(db, {
              entityId,
              periodStart,
              periodEnd,
              userId,
              notes: 'Reclosed after Wentworth utility reimbursable fix',
            })),
          });
        } else {
          reclosed.push({ periodStart, periodEnd, skipped: true, blockers: integrity.blockers });
        }
      } catch (e) {
        reclosed.push({ periodStart, periodEnd, error: e.message });
      }
    }
  }

  return { scanned: combined.length, reclassed, results, reclosed };
}

/**
 * Convert Wentworth utility GL to tenant-reimbursable assets and reclass internet off expense.
 */
export async function applyWentworthTenantUtilityTreatment(db, {
  entityId = 'ent-ljc',
  userId = 'usr-admin',
  startDate = '2026-01-01',
  endDate = '2026-06-30',
  dryRun = false,
  reclose = true,
} = {}) {
  if (entityId !== 'ent-ljc') {
    throw new Error('Wentworth utility treatment is only for ent-ljc');
  }

  await seedDefaultRules(db, entityId);

  const accounts = await ensureWentworthUtilityAccounts(db, entityId);
  const rules = [];
  for (const spec of RULE_UPDATES) {
    rules.push({ pattern: spec.pattern, offset: spec.offset, ...(await upsertRule(db, entityId, spec)) });
  }
  // Keep Verizon as office/wireless expense (not Wentworth tenant).
  await db.run(
    `UPDATE bank_categorization_rules
     SET offset_account_number = '5710', label = 'Wireless / internet (non-Wentworth)', priority = 10
     WHERE entity_id = ? AND pattern IN ('VERIZONWRLSS', 'VERIZON')`,
    [entityId]
  );

  const internetReclass = await reclassWentworthInternetFromExpense(db, {
    entityId,
    userId,
    startDate,
    endDate,
    dryRun,
    reclose,
  });

  const utilBalances = [];
  for (const num of ['6251', '6252', '6253', '6254', '5710']) {
    const row = await db.get(
      `SELECT a.account_number, a.account_name, a.account_type,
              COALESCE(SUM(gl.debit),0) - COALESCE(SUM(gl.credit),0) AS balance
       FROM accounts a
       LEFT JOIN general_ledger gl ON gl.account_id = a.id
       LEFT JOIN journal_entries je ON je.id = gl.journal_entry_id
         AND je.status = 'POSTED' AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
         AND gl.posting_date >= ? AND gl.posting_date <= ?
       WHERE a.entity_id = ? AND a.account_number = ?
       GROUP BY a.id, a.account_number, a.account_name, a.account_type`,
      [startDate, endDate, entityId, num]
    );
    if (row) utilBalances.push(row);
  }

  return {
    entityId,
    dryRun,
    policySource: WENTWORTH_POLICY_SOURCE,
    accounts,
    rulesUpserted: rules.length,
    internetReclass,
    utilBalances,
    message: dryRun
      ? `Accounts flipped to tenant receivable (per ${WENTWORTH_POLICY_SOURCE}); dry run would move ${internetReclass.reclassed} Comcast line(s)`
      : `Wentworth utilities follow ${WENTWORTH_POLICY_SOURCE}: tenant-reimbursable assets; Comcast moved off expense`,
  };
}
