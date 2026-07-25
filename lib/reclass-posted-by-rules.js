/**
 * Append-only reclass: move posted expense/income offsets from dump accounts
 * (default 5700 Office & Software) onto the account learned rules assign.
 *
 * Idempotent via memo `reclass-rules:<origJeId>:<glId>`.
 * Reopens closed months as needed, then recloses when integrity still allows.
 */
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { postJournalEntryToGl } from './post-journal.js';
import { categorizeTransaction, seedDefaultRules } from './categorization-rules.js';
import { learnCategorizationFromHistory } from './learn-categorization-from-history.js';
import { normalizeIsoDate } from './bank-statement-view.js';
import { reopenPeriod, closePeriod, monthBounds } from './period-lock.js';
import { getPeriodIntegrityStatus } from './period-integrity.js';

const DEFAULT_SOURCE = ['5700'];

async function accountByNumber(db, entityId, number) {
  return db.get(
    'SELECT id, account_number, account_name FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, number]
  );
}

function toIsoDate(value) {
  return normalizeIsoDate(value) || String(value || '').slice(0, 10);
}

function matchText(row) {
  return [row.je_description, row.gl_description, row.line_description, row.memo]
    .filter(Boolean)
    .join(' ');
}

/**
 * @returns {Promise<object>}
 */
export async function reclassPostedByLearnedRules(db, {
  entityId = 'ent-ljc',
  userId = 'usr-admin',
  startDate = '2026-01-01',
  endDate = '2026-03-31',
  sourceAccountNumbers = DEFAULT_SOURCE,
  dryRun = false,
  learnFirst = true,
  reclose = true,
} = {}) {
  if (learnFirst) {
    await learnCategorizationFromHistory(db, { entityId, startDate, endDate: '2026-06-30' });
  } else {
    await seedDefaultRules(db, entityId);
  }

  const sources = [];
  for (const num of sourceAccountNumbers) {
    const acct = await accountByNumber(db, entityId, num);
    if (acct) sources.push(acct);
  }
  if (!sources.length) throw new Error('No source dump accounts found');

  const sourceIds = sources.map((s) => s.id);
  const sourceNums = new Set(sources.map((s) => s.account_number));

  const rows = await db.all(
    `SELECT gl.id AS gl_id, gl.debit, gl.credit, gl.posting_date, gl.description AS gl_description,
            je.id AS journal_id, je.je_number, je.description AS je_description, je.memo,
            a.account_number AS from_account_number, a.id AS from_account_id,
            jel.description AS line_description
     FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id
       AND je.status = 'POSTED'
       AND je.reversed_by_je_id IS NULL
       AND je.reverses_je_id IS NULL
     JOIN accounts a ON a.id = gl.account_id
     LEFT JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id AND jel.account_id = gl.account_id
       AND ABS(COALESCE(jel.debit,0) - COALESCE(gl.debit,0)) < 0.02
       AND ABS(COALESCE(jel.credit,0) - COALESCE(gl.credit,0)) < 0.02
     WHERE gl.entity_id = ?
       AND gl.account_id IN (${sourceIds.map(() => '?').join(',')})
       AND gl.posting_date >= ? AND gl.posting_date <= ?
       AND (je.je_number LIKE 'AMEX-%' OR je.je_number LIKE 'IMP-%')
       AND je.description NOT LIKE '%Amex Mar cycle%'
       AND je.description NOT LIKE '%charge catch-up%'
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries r
         WHERE r.entity_id = je.entity_id
           AND r.status = 'POSTED'
           AND r.reversed_by_je_id IS NULL
           AND r.memo LIKE ('reclass-rules:' || je.id || ':' || gl.id || '%')
       )
     ORDER BY gl.posting_date, je.je_number`,
    [entityId, ...sourceIds, startDate, endDate]
  );

  const results = [];
  let reclassed = 0;
  let skipped = 0;
  const monthsTouched = new Set();

  for (const row of rows) {
    const debit = new Decimal(row.debit || 0);
    const credit = new Decimal(row.credit || 0);
    if (debit.isZero() && credit.isZero()) {
      skipped += 1;
      continue;
    }

    const text = matchText(row);
    const cat = await categorizeTransaction(db, entityId, text);
    if (!cat.offsetAccountId || cat.isTransfer || cat.isChargeback) {
      skipped += 1;
      results.push({
        jeNumber: row.je_number,
        skipped: true,
        reason: 'no_rule',
        description: (row.je_description || '').slice(0, 100),
      });
      continue;
    }

    const target = await db.get(
      'SELECT id, account_number, account_name FROM accounts WHERE id = ?',
      [cat.offsetAccountId]
    );
    if (!target || sourceNums.has(target.account_number) || target.account_number === row.from_account_number) {
      skipped += 1;
      results.push({
        jeNumber: row.je_number,
        skipped: true,
        reason: 'same_or_dump',
        toAccount: target?.account_number,
        description: (row.je_description || '').slice(0, 100),
      });
      continue;
    }

    const amount = Decimal.max(debit, credit);
    const postingDate = toIsoDate(row.posting_date);
    const entry = {
      jeNumber: row.je_number,
      postingDate,
      amount: Number(amount.toFixed(2)),
      fromAccount: row.from_account_number,
      toAccount: target.account_number,
      label: cat.label || 'Reclass from learned rules',
      description: (row.je_description || text).slice(0, 120),
    };

    if (dryRun) {
      results.push({ ...entry, dryRun: true });
      reclassed += 1;
      monthsTouched.add(postingDate.slice(0, 7));
      continue;
    }

    const { periodStart, periodEnd } = monthBounds(postingDate);
    const integrity = await getPeriodIntegrityStatus(db, { entityId, periodStart, periodEnd });
    if (integrity.isClosed || integrity.databasePeriodStatus === 'CLOSED') {
      await reopenPeriod(db, { entityId, periodStart, periodEnd });
      monthsTouched.add(`${periodStart}|${periodEnd}`);
    } else {
      monthsTouched.add(`${periodStart}|${periodEnd}`);
    }

    const jeId = `je-${uuidv4()}`;
    const jeNumber = `RCLS-RULE-${Date.now()}-${uuidv4().substring(0, 6)}`;
    const memo = `reclass-rules:${row.journal_id}:${row.gl_id}`;
    const fromAcct = await db.get('SELECT id FROM accounts WHERE id = ?', [row.from_account_id]);

    await db.run(
      `INSERT INTO journal_entries
       (id, entity_id, je_number, description, posting_date, status, created_by, total_debit, total_credit, memo)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
      [
        jeId,
        entityId,
        jeNumber,
        `Reclass ${row.from_account_number}→${target.account_number}: ${row.je_number}`,
        postingDate,
        userId,
        amount.toFixed(2),
        amount.toFixed(2),
        memo,
      ]
    );

    // Original expense was typically Dr dump / Cr card|bank.
    // Reclass: Cr dump / Dr target (or reverse if original was credit on dump).
    if (debit.gt(0)) {
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, ?, 0, ?, 1)`,
        [`jel-${uuidv4()}`, jeId, target.id, debit.toFixed(2), entry.label]
      );
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, 0, ?, ?, 2)`,
        [`jel-${uuidv4()}`, jeId, fromAcct.id, debit.toFixed(2), `Clear ${row.from_account_number}`]
      );
    } else {
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, ?, 0, ?, 1)`,
        [`jel-${uuidv4()}`, jeId, fromAcct.id, credit.toFixed(2), `Clear ${row.from_account_number}`]
      );
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, 0, ?, ?, 2)`,
        [`jel-${uuidv4()}`, jeId, target.id, credit.toFixed(2), entry.label]
      );
    }

    await postJournalEntryToGl(db, { journalId: jeId, entityId, userId });
    results.push({ ...entry, reclassJeId: jeId, reclassJeNumber: jeNumber });
    reclassed += 1;
  }

  const reclosed = [];
  if (!dryRun && reclose) {
    for (const key of monthsTouched) {
      if (!key.includes('|')) continue;
      const [periodStart, periodEnd] = key.split('|');
      try {
        const integrity = await getPeriodIntegrityStatus(db, { entityId, periodStart, periodEnd });
        if (integrity.canClose) {
          const closed = await closePeriod(db, {
            entityId,
            periodStart,
            periodEnd,
            userId,
            notes: 'Reclosed after learned-rules expense reclass',
          });
          reclosed.push({ periodStart, periodEnd, ...closed });
        } else {
          reclosed.push({
            periodStart,
            periodEnd,
            skipped: true,
            reason: 'canClose=false',
            blockers: integrity.blockers,
          });
        }
      } catch (e) {
        reclosed.push({ periodStart, periodEnd, error: e.message });
      }
    }
  }

  const byTarget = {};
  for (const r of results) {
    if (r.toAccount && !r.skipped) {
      byTarget[r.toAccount] = (byTarget[r.toAccount] || 0) + (r.amount || 0);
    }
  }

  return {
    entityId,
    startDate,
    endDate,
    scanned: rows.length,
    reclassed,
    skipped,
    dryRun,
    byTarget,
    reclosed,
    results: results.filter((r) => !r.skipped || r.reason === 'no_rule').slice(0, 500),
    noRuleCount: results.filter((r) => r.reason === 'no_rule').length,
  };
}
