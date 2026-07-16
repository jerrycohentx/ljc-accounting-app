import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../config/database.js';
import { categorizeTransaction } from './categorization-rules.js';
import { detectAndQueueChargeback } from './chargeback.js';
import { detectPaymentReturn } from './bank-return-match.js';
import { filterNewTransactions } from './transaction-dedup.js';
import { tryVerifyDrawFromBankTxn } from './holdback-disbursement.js';

// Mortgage / loan payments carry their source statement with them (Jerry,
// 2026-07-16): when the caller knows which uploaded statement produced a
// draft, attach it to mortgage/loan-payment JEs so the support document is
// one click away at review time. Matched on description + rule label.
const MORTGAGE_LOAN_PMT_RE = /mortgag|fays*servicing|shellpoint|newrez|carrington|loans*(?:pay|pmt)|payoff/i;

let jeDocsReady = false;
async function ensureJeDocsTable(db) {
  if (jeDocsReady) return;
  await db.run(`CREATE TABLE IF NOT EXISTS journal_entry_documents (
    id TEXT PRIMARY KEY,
    journal_entry_id TEXT NOT NULL,
    file_name TEXT,
    file_mime TEXT,
    file_data TEXT,
    uploaded_by TEXT,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  jeDocsReady = true;
}

async function ensureUndepositedFunds(db, entityId) {
  let row = await db.get(
    'SELECT id FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, '1100']
  );
  if (row) return row.id;
  const id = `acc-${uuidv4()}`;
  await db.run(
    `INSERT INTO accounts (id, entity_id, account_number, account_name, account_type, normal_balance, is_active)
     VALUES (?, ?, '1100', 'Undeposited Funds', 'ASSET', 'DEBIT', true)`,
    [id, entityId]
  );
  return id;
}

/**
 * Re-run categorization rules against transactions already sitting in the
 * pending review queue (DRAFT, not yet posted). Only changes a transaction
 * when a rule now resolves to a *different* offset account than it currently
 * has -- typically because a new rule was learned from a manual correction
 * (or a default rule was added/edited) after this transaction was first
 * imported. Chargeback reclassification is out of scope here (it changes
 * more than the offset account) and is left for manual review. Non-fatal
 * and non-destructive: only touches DRAFT import_transactions / DRAFT
 * journal_entries, never posted entries.
 */
export async function reapplyRulesToPending(db, entityId) {
  if (!entityId) return { scanned: 0, updated: 0, unchanged: 0, skippedChargeback: 0, byRule: [] };

  // NOTE: Postgres folds unquoted SQL aliases to lowercase (e.g. "AS journalEntryId"
  // comes back as row.journalentryid, not row.journalEntryId, and row.journalEntryId
  // reads as undefined). Select plain snake_case columns and map to camelCase in JS
  // instead of relying on camelCase aliases in the SQL text.
  const rows = await db.all(
    `SELECT it.id, it.description, it.journal_entry_id, it.offset_account_id
     FROM import_transactions it
     JOIN journal_entries je ON je.id = it.journal_entry_id
     WHERE it.entity_id = ? AND it.status = 'DRAFT' AND je.status = 'DRAFT'`,
    [entityId]
  );

  let updated = 0;
  let unchanged = 0;
  let skippedChargeback = 0;
  const ruleCounts = new Map();

  for (const row of rows) {
    let cat;
    try {
      cat = await categorizeTransaction(db, entityId, row.description);
    } catch (err) {
      console.error('reapplyRulesToPending: categorizeTransaction failed (non-fatal):', err.message);
      unchanged += 1;
      continue;
    }

    if (cat.isChargeback) {
      skippedChargeback += 1;
      continue;
    }
    if (!cat.offsetAccountId || cat.offsetAccountId === row.offset_account_id) {
      unchanged += 1;
      continue;
    }

    const offsetLine = await db.get(
      'SELECT id FROM journal_entry_lines WHERE journal_entry_id = ? AND line_number = 2',
      [row.journal_entry_id]
    );
    if (!offsetLine) {
      unchanged += 1;
      continue;
    }

    await db.run(
      'UPDATE journal_entry_lines SET account_id = ?, description = ? WHERE id = ?',
      [cat.offsetAccountId, cat.label || 'Pending categorization', offsetLine.id]
    );
    await db.run(
      'UPDATE import_transactions SET offset_account_id = ?, suggested_rule_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [cat.offsetAccountId, cat.ruleId || null, row.id]
    );

    updated += 1;
    const key = cat.label || 'Unlabeled rule';
    ruleCounts.set(key, (ruleCounts.get(key) || 0) + 1);
  }

  return {
    scanned: rows.length,
    updated,
    unchanged,
    skippedChargeback,
    byRule: [...ruleCounts.entries()].map(([label, count]) => ({ label, count })),
  };
}

/**
 * Commit bank transactions as DRAFT journal entries with journal_entry_lines ONLY.
 * Nothing hits general_ledger until the user posts from Bank Feeds (QBO-style).
 * Auto-categorization rules assign the offset account; chargebacks are flagged.
 * After committing the new transactions, automatically re-sweeps the rest of
 * the pending review queue with the current rules (see reapplyRulesToPending)
 * so every download also catches up any older transactions a newly learned
 * rule now covers -- always part of the download/review/approve flow.
 *
 * Duplicate protection: before creating anything, every incoming transaction
 * is checked against everything already imported for this entity+account --
 * by exact fitid AND by content (date + signed amount + similar description).
 * This is what stops the same real transaction from being posted twice when
 * it arrives through a different pipeline than last time (e.g. a scanned
 * statement re-loading something an OFX file already brought in, or vice
 * versa) -- every caller of this function gets this protection automatically,
 * regardless of import method. Duplicates are silently skipped (not posted)
 * and reported back in the return value for visibility.
 */
export async function commitBankImportTransactions(db, {
  entityId,
  transactions,
  importId,
  userId,
  sourceLabel = 'Bank Import',
  bankAccountNumber = '1000',
  sourceDocument = null,
}) {
  const entity = await db.get('SELECT * FROM entities WHERE id = ?', entityId);
  if (!entity) throw new Error('Entity not found');

  const bankAccount = await db.get(
    'SELECT * FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, bankAccountNumber]
  );
  if (!bankAccount) {
    throw new Error(`Bank account (${bankAccountNumber}) not found for entity`);
  }

  const {
    kept: newTransactions,
    duplicates: skippedDuplicates,
    fitidDuplicateCount,
    contentDuplicateCount,
  } = await filterNewTransactions(db, entityId, bankAccount.id, transactions);

  const defaultOffsetId = await ensureUndepositedFunds(db, entityId);
  let createdJECount = 0;
  const importedTransactions = [];

  for (const txn of newTransactions) {
    const cat = await categorizeTransaction(db, entityId, txn.description);

    if (cat.isChargeback) {
      await detectAndQueueChargeback(db, {
        entityId,
        fitid: txn.fitid,
        amount: txn.amount,
        description: txn.description,
        date: txn.date,
        userId,
      });
    }

    const offsetAccountId = cat.offsetAccountId || defaultOffsetId;
    const jeId = `je-${uuidv4()}`;
    const jeNumber = `IMP-${Date.now()}-${uuidv4().substring(0, 8)}`;
    const isDeposit = txn.isCredit;
    const amount = Math.abs(Number(txn.amount));
    const debitAmount = isDeposit ? amount : 0;
    const creditAmount = !isDeposit ? amount : 0;

    await db.run(
      `INSERT INTO journal_entries (
        id, entity_id, je_number, description, posting_date, status,
        created_by, total_debit, total_credit, memo
      ) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
      [
        jeId,
        entityId,
        jeNumber,
        `${sourceLabel}: ${txn.description}`,
        txn.date,
        userId,
        amount,
        amount,
        `${sourceLabel} - FITID: ${txn.fitid}${cat.label ? ` | rule: ${cat.label}` : ''}`,
      ]
    );

    // Line 1: bank account
    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [`jel-${uuidv4()}`, jeId, bankAccount.id, debitAmount, creditAmount, `Bank: ${txn.description}`]
    );

    // Line 2: offset (categorized or undeposited funds)
    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, ?, ?, 2)`,
      [`jel-${uuidv4()}`, jeId, offsetAccountId, creditAmount, debitAmount, cat.label || 'Pending categorization']
    );

    // Auto-attach the uploaded statement to mortgage / loan-payment drafts.
    if (sourceDocument && sourceDocument.fileData
        && MORTGAGE_LOAN_PMT_RE.test(`${txn.description} ${cat.label || ''}`)) {
      try {
        await ensureJeDocsTable(db);
        await db.run(
          `INSERT INTO journal_entry_documents (id, journal_entry_id, file_name, file_mime, file_data, uploaded_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [`jed-${uuidv4()}`, jeId, sourceDocument.fileName || null,
           sourceDocument.fileMime || 'application/pdf', sourceDocument.fileData, userId || null]
        );
      } catch (err) {
        console.warn('statement auto-attach (non-fatal):', err.message);
      }
    }

    const importTxnId = `imp-txn-${uuidv4()}`;
    await db.run(
      `INSERT INTO import_transactions (
        id, fitid, import_id, entity_id, account_id, journal_entry_id,
        date, amount, description, status, offset_account_id, suggested_rule_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)`,
      [
        importTxnId,
        txn.fitid,
        importId,
        entityId,
        bankAccount.id,
        jeId,
        txn.date,
        txn.amount,
        txn.description,
        offsetAccountId,
        cat.ruleId || null,
        new Date().toISOString(),
      ]
    );

    try {
      await detectPaymentReturn(db, {
        entityId,
        txn,
        importTransactionId: importTxnId,
        bankAccountNumber,
        userId,
      });
    } catch (err) {
      console.warn('payment return detect (non-fatal):', err.message);
    }

    try {
      const importRow = await db.get('SELECT * FROM import_transactions WHERE id = ?', importTxnId);
      const verified = await tryVerifyDrawFromBankTxn(db, {
        importTransaction: importRow,
        userId,
        entityId,
      });
      if (verified) {
        await db.run(
          `UPDATE import_transactions SET status = 'MATCHED', matched_to_gl_id = COALESCE(matched_to_gl_id, ?) WHERE id = ?`,
          [verified.gl_entry_id || null, importTxnId]
        );
      }
    } catch (err) {
      console.warn('holdback wire match (non-fatal):', err.message);
    }

    importedTransactions.push({ fitid: txn.fitid, jeNumber, jeId, status: 'DRAFT', rule: cat.label });
    createdJECount += 1;
  }

  const reapply = await reapplyRulesToPending(db, entityId);

  return {
    createdJECount,
    importedTransactions,
    reapply,
    duplicatesSkipped: skippedDuplicates.length,
    duplicateDetail: skippedDuplicates.map((t) => ({
      fitid: t.fitid,
      date: t.date,
      amount: t.amount,
      description: t.description,
    })),
    fitidDuplicateCount,
    contentDuplicateCount,
  };
}

export async function getExistingFitidsForEntity(entityId) {
  const db = await getDatabase();
  const rows = await db.all(
    'SELECT DISTINCT fitid FROM import_transactions WHERE entity_id = ? AND status != ?',
    [entityId, 'REJECTED']
  );
  return new Set(rows.map((r) => r.fitid));
}

/**
 * Derive a stable "contains" match pattern from a bank transaction description,
 * for learning a new categorization rule. Strips trailing reference/check numbers
 * (which vary transaction to transaction) so the pattern generalizes to future
 * transactions from the same payee/source, while staying specific enough not to
 * over-match unrelated activity.
 */
function deriveRulePattern(description) {
  const text = String(description || '').trim();
  if (!text) return null;

  // Drop a trailing run of digit/reference tokens (check #s, batch #s, member IDs, etc.)
  let cleaned = text.replace(/(?:[\s#]+[\d-]{4,})+\s*$/, '').trim();
  if (cleaned.length < 6) cleaned = text;

  const MAX = 40;
  if (cleaned.length > MAX) {
    const cut = cleaned.slice(0, MAX);
    const lastSpace = cut.lastIndexOf(' ');
    cleaned = (lastSpace > 10 ? cut.slice(0, lastSpace) : cut).trim();
  }

  return cleaned.length >= 6 ? cleaned : null;
}

/**
 * "Learn" a bank categorization rule from a manual correction: the next time a
 * transaction with a matching description comes in, it auto-categorizes to the
 * same account instead of landing as "uncategorized" / undeposited funds.
 * Priority 5 -- lower than every built-in default rule -- so a user's explicit
 * correction always wins over the generic defaults.
 * Non-fatal: if this fails, the manual recategorization the user just made is
 * unaffected; we just skip learning for next time.
 */
export async function learnCategorizationRule(db, { entityId, description, offsetAccountId }) {
  if (!entityId || !offsetAccountId) return null;

  const pattern = deriveRulePattern(description);
  if (!pattern) return null;

  try {
    const account = await db.get(
      'SELECT account_number FROM accounts WHERE id = ?',
      offsetAccountId
    );
    if (!account?.account_number) return null;

    const label = `Learned: ${pattern.slice(0, 30)}`;
    const existing = await db.get(
      'SELECT id FROM bank_categorization_rules WHERE entity_id = ? AND pattern = ?',
      [entityId, pattern]
    );

    if (existing) {
      await db.run(
        `UPDATE bank_categorization_rules
         SET offset_account_number = ?, transfer_account_number = NULL, is_transfer = false,
             is_chargeback = false, is_active = TRUE, label = ?
         WHERE id = ?`,
        [account.account_number, label, existing.id]
      );
      return existing.id;
    }

    const id = `rule-${uuidv4()}`;
    await db.run(
      `INSERT INTO bank_categorization_rules
       (id, entity_id, pattern, match_type, offset_account_number, transfer_account_number,
        is_transfer, is_chargeback, priority, label, is_active)
       VALUES (?, ?, ?, 'contains', ?, NULL, false, false, 5, ?, TRUE)`,
      [id, entityId, pattern, account.account_number, label]
    );
    return id;
  } catch (err) {
    console.error('learnCategorizationRule failed (non-fatal):', err.message);
    return null;
  }
}

/** Update offset account on a pending import (user changed category in Bank Feeds). */
export async function updateImportOffsetAccount(db, { entityId, fitid, offsetAccountId }) {
  const row = await db.get(
    `SELECT it.*, je.status AS je_status FROM import_transactions it
     JOIN journal_entries je ON je.id = it.journal_entry_id
     WHERE it.fitid = ? AND it.entity_id = ?`,
    [fitid, entityId]
  );
  if (!row) throw new Error('Import transaction not found');
  if (row.je_status === 'POSTED') throw new Error('Cannot recategorize a posted transaction');

  await db.run(
    'UPDATE import_transactions SET offset_account_id = ?, updated_at = CURRENT_TIMESTAMP WHERE fitid = ? AND entity_id = ?',
    [offsetAccountId, fitid, entityId]
  );

  const lines = await db.all(
    'SELECT jel.*, a.account_number FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id WHERE jel.journal_entry_id = ? ORDER BY jel.line_number',
    [row.journal_entry_id]
  );
  const bankLine = lines.find((l) => l.account_number === '1000' || l.account_number === '1001');
  const offsetLine = lines.find((l) => l.id !== bankLine?.id);
  if (offsetLine) {
    await db.run('UPDATE journal_entry_lines SET account_id = ? WHERE id = ?', [offsetAccountId, offsetLine.id]);
  }

  // Learn from this correction so future similar transactions auto-categorize
  // and don't need to be manually recategorized again.
  await learnCategorizationRule(db, {
    entityId,
    description: row.description,
    offsetAccountId,
  });

  return { fitid, offsetAccountId };
}
