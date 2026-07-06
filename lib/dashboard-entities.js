/**
 * Multi-entity dashboard metrics — entity-scoped SQLite aggregates.
 */

import Decimal from 'decimal.js';
import { POSTED_GL_SUBQUERY, calculateAccountBalance } from './posted-gl.js';

async function getAccountsWithBalances(db, entityId, asOfDate) {
  const query = `
    SELECT
      a.id, a.account_number, a.account_name, a.account_type, a.normal_balance,
      COALESCE(SUM(gl.debit), 0) as total_debit,
      COALESCE(SUM(gl.credit), 0) as total_credit
    FROM accounts a
    LEFT JOIN (${POSTED_GL_SUBQUERY}) gl ON a.id = gl.account_id AND gl.entity_id = ?
    WHERE a.entity_id = ? AND a.is_active = 1
    AND (gl.posting_date IS NULL OR gl.posting_date <= ?)
    GROUP BY a.id
    ORDER BY a.account_number
  `;
  return db.all(query, [entityId, entityId, asOfDate]);
}

function sumBalances(accounts, predicate) {
  let total = new Decimal(0);
  for (const acc of accounts) {
    if (!predicate(acc)) continue;
    total = total.plus(calculateAccountBalance(acc));
  }
  return total.toNumber();
}

function inferSourceFromDescription(description) {
  const d = String(description || '');
  if (/\(Plaid\)/i.test(d)) return 'plaid';
  if (/OFX/i.test(d)) return 'ofx';
  if (/email|statement/i.test(d)) return 'email';
  return 'import';
}

export async function getEntitySummary(db, entityId, asOfDate) {
  const accounts = await getAccountsWithBalances(db, entityId, asOfDate);

  const cashBalance = sumBalances(accounts, (a) =>
    a.account_type === 'ASSET'
    && (/^Cash/i.test(a.account_name) || /^10\d{2}$/.test(a.account_number))
  );

  const arBalance = sumBalances(accounts, (a) =>
    a.account_type === 'ASSET'
    && (/receivable/i.test(a.account_name) || /^12\d{2}$/.test(a.account_number))
  );

  const loanPayableBalance = sumBalances(accounts, (a) =>
    a.account_type === 'LIABILITY'
    && (/payable|note payable|mortgage/i.test(a.account_name))
  );

  const pendingRow = await db.get(
    `SELECT COUNT(*) AS count FROM import_transactions it
     JOIN journal_entries je ON je.id = it.journal_entry_id
     WHERE it.entity_id = ? AND it.status = 'DRAFT' AND je.status = 'DRAFT'`,
    [entityId]
  );

  const unreconciledRow = await db.get(
    `SELECT COUNT(*) AS count FROM general_ledger gl
     JOIN journal_entries je ON je.id = gl.journal_entry_id
     WHERE gl.entity_id = ? AND je.status = 'POSTED'
     AND (gl.reconciliation_status IS NULL OR gl.reconciliation_status = '')`,
    [entityId]
  );

  const plaidSync = await db.get(
    `SELECT MAX(updated_at) AS last_sync FROM plaid_items
     WHERE entity_id = ? AND is_active = 1`,
    [entityId]
  );

  const lastImport = await db.get(
    `SELECT MAX(it.created_at) AS last_import FROM import_transactions it
     WHERE it.entity_id = ? AND it.status != 'REJECTED'`,
    [entityId]
  );

  const lastFeedSync = plaidSync?.last_sync || lastImport?.last_import || null;

  return {
    entityId,
    asOfDate,
    cashBalance,
    arBalance,
    loanPayableBalance,
    pendingFeedCount: Number(pendingRow?.count || 0),
    unreconciledCount: Number(unreconciledRow?.count || 0),
    lastFeedSync,
  };
}

export async function getEntitiesSummary(db) {
  const today = new Date().toISOString().split('T')[0];
  const entities = await db.all(
    "SELECT id, name, code, type FROM entities WHERE status = 'ACTIVE' ORDER BY name"
  );

  const summaries = [];
  for (const ent of entities) {
    const metrics = await getEntitySummary(db, ent.id, today);
    summaries.push({
      id: ent.id,
      name: ent.name,
      code: ent.code,
      type: ent.type,
      ...metrics,
    });
  }

  const totalPending = summaries.reduce((s, e) => s + (e.pendingFeedCount || 0), 0);

  return {
    asOfDate: today,
    lastUpdated: new Date().toISOString(),
    totalPendingFeedCount: totalPending,
    entities: summaries,
  };
}

export async function getReviewQueue(db, {
  entityId = null,
  source = null,
  startDate = null,
  endDate = null,
  accountId = null,
  limit = 500,
} = {}) {
  const params = [];
  let where = "it.status = 'DRAFT' AND je.status = 'DRAFT'";

  if (entityId) {
    where += ' AND it.entity_id = ?';
    params.push(entityId);
  }
  if (accountId) {
    where += ' AND it.account_id = ?';
    params.push(accountId);
  }
  if (startDate) {
    where += ' AND it.date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    where += ' AND it.date <= ?';
    params.push(endDate);
  }

  const rows = await db.all(
    `SELECT it.fitid, it.date, it.amount, it.description, it.journal_entry_id,
            it.offset_account_id, it.suggested_rule_id, it.entity_id, it.account_id,
            it.created_at, je.je_number, je.description AS je_description, je.memo,
            a.account_number, a.account_name,
            oa.account_number AS offset_account_number, oa.account_name AS offset_account_name,
            e.name AS entity_name,
            bcr.label AS rule_label
     FROM import_transactions it
     JOIN journal_entries je ON je.id = it.journal_entry_id
     JOIN entities e ON e.id = it.entity_id
     LEFT JOIN accounts a ON a.id = it.account_id
     LEFT JOIN accounts oa ON oa.id = it.offset_account_id
     LEFT JOIN bank_categorization_rules bcr ON bcr.id = it.suggested_rule_id
     WHERE ${where}
     ORDER BY it.date DESC, it.created_at DESC
     LIMIT ?`,
    [...params, Math.min(Number(limit) || 500, 1000)]
  );

  let items = rows.map((r) => {
    const amt = Math.abs(Number(r.amount));
    const isDeposit = Number(r.amount) > 0;
    const src = inferSourceFromDescription(r.je_description);
    return {
      fitid: r.fitid,
      jeId: r.journal_entry_id,
      jeNumber: r.je_number,
      entityId: r.entity_id,
      entityName: r.entity_name,
      date: r.date,
      description: r.description,
      payment: isDeposit ? null : amt.toFixed(2),
      deposit: isDeposit ? amt.toFixed(2) : null,
      amount: Number(r.amount),
      accountId: r.account_id,
      accountNumber: r.account_number,
      accountName: r.account_name,
      offsetAccountId: r.offset_account_id,
      offsetAccountNumber: r.offset_account_number,
      offsetAccountName: r.offset_account_name,
      categorySuggestion: r.rule_label || r.offset_account_name || null,
      source: src,
      status: 'DRAFT',
      downloadedAt: r.created_at,
    };
  });

  if (source) {
    items = items.filter((i) => i.source === source);
  }

  return { items, count: items.length };
}

export async function getPendingFeedCount(db, entityId = null) {
  const params = [];
  let where = "it.status = 'DRAFT' AND je.status = 'DRAFT'";
  if (entityId) {
    where += ' AND it.entity_id = ?';
    params.push(entityId);
  }
  const row = await db.get(
    `SELECT COUNT(*) AS count FROM import_transactions it
     JOIN journal_entries je ON je.id = it.journal_entry_id
     WHERE ${where}`,
    params
  );
  return Number(row?.count || 0);
}
