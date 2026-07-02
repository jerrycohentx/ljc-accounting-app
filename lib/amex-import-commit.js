import { v4 as uuidv4 } from 'uuid';
import { categorizeAmexTransaction } from './amex-categorization.js';
import { resolveAccountByNumber } from './categorization-rules.js';
import { filterNewTransactions } from './transaction-dedup.js';

/**
 * Find bank-side Amex payment already posted (DR 2010 from Simmons/Lone Star AMEX EPAYMENT).
 */
export async function findMatchingBankPayment(db, entityId, { amount, date, toleranceDays = 7 }) {
  const absAmt = Math.abs(Number(amount));
  const rows = await db.all(
    `SELECT je.id AS je_id, je.posting_date, je.description, jel2010.debit AS amex_debit
     FROM journal_entries je
     JOIN journal_entry_lines jel2010 ON jel2010.journal_entry_id = je.id
     JOIN accounts a ON a.id = jel2010.account_id AND a.account_number = '2010'
     WHERE je.entity_id = ? AND je.status = 'POSTED'
       AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
       AND ABS(jel2010.debit - ?) < 0.02
       AND (je.description LIKE '%AMEX EPAYMENT%' OR je.description LIKE '%Amex payment%' OR je.memo LIKE '%Amex%')`,
    [entityId, absAmt]
  );

  const target = new Date(String(date).slice(0, 10));
  const match = rows.find((r) => {
    const posted = new Date(String(r.posting_date).slice(0, 10));
    const days = Math.abs((posted - target) / 86400000);
    return days <= toleranceDays;
  });
  return match || null;
}

/**
 * Post Amex card activity to GL account 2010.
 * Charges: DR expense · CR 2010. Payments: DR 2010 · CR cash (or skip if matched to bank feed).
 *
 * Duplicate protection: incoming transactions are checked against everything
 * already imported for this entity+card account -- by exact fitid AND by
 * content (date + signed amount + similar description) -- before anything is
 * posted, so the same charge/payment can't be double-booked if it arrives
 * through more than one import run. Scoped to this card account only, so an
 * Amex charge never collides with an unrelated bank transaction of the same
 * date/amount.
 */
export async function commitAmexImportTransactions(db, {
  entityId,
  transactions,
  importId,
  userId,
  sourceLabel = 'Amex Import',
  cardAccountNumber = '2010',
  skipMatchedPayments = true,
}) {
  const cardAccount = await db.get(
    'SELECT * FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, cardAccountNumber]
  );
  if (!cardAccount) throw new Error(`Card account ${cardAccountNumber} not found`);

  const {
    kept: newTransactions,
    duplicates: skippedDuplicates,
    fitidDuplicateCount,
    contentDuplicateCount,
  } = await filterNewTransactions(db, entityId, cardAccount.id, transactions);

  const defaultCash = await resolveAccountByNumber(db, entityId, '1000');
  let createdJECount = 0;
  let matchedPayments = 0;
  let skippedPayments = 0;
  const importedTransactions = [];

  for (const txn of newTransactions) {
    const absAmount = Math.abs(Number(txn.amount));

    if (txn.isPayment || txn.amount < 0) {
      const bankMatch = skipMatchedPayments
        ? await findMatchingBankPayment(db, entityId, { amount: txn.amount, date: txn.date })
        : null;
      if (bankMatch) {
        matchedPayments += 1;
        importedTransactions.push({
          fitid: txn.fitid,
          status: 'MATCHED_BANK',
          bankJeId: bankMatch.je_id,
          amount: txn.amount,
        });
        continue;
      }
    }

    const cat = await categorizeAmexTransaction(db, entityId, txn);
    const offsetAccountId = cat.offsetAccountId || defaultCash?.id;
    if (!offsetAccountId) throw new Error('No offset account for Amex transaction');

    const jeId = `je-${uuidv4()}`;
    const jeNumber = `AMEX-${Date.now()}-${uuidv4().substring(0, 8)}`;
    const isCharge = txn.amount > 0;

    const cardDebit = isCharge ? 0 : absAmount;
    const cardCredit = isCharge ? absAmount : 0;
    const offsetDebit = isCharge ? absAmount : 0;
    const offsetCredit = isCharge ? 0 : absAmount;

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
        absAmount,
        absAmount,
        `${sourceLabel} - FITID: ${txn.fitid}${cat.label ? ` | ${cat.label}` : ''}`,
      ]
    );

    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [`jel-${uuidv4()}`, jeId, cardAccount.id, cardDebit, cardCredit, `Amex: ${txn.description}`]
    );

    await db.run(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
       VALUES (?, ?, ?, ?, ?, ?, 2)`,
      [`jel-${uuidv4()}`, jeId, offsetAccountId, offsetDebit, offsetCredit, cat.label || 'Offset']
    );

    await db.run(
      `INSERT INTO import_transactions (
        id, fitid, import_id, entity_id, account_id, journal_entry_id,
        date, amount, description, status, offset_account_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
      [
        `imp-txn-${uuidv4()}`,
        txn.fitid,
        importId,
        entityId,
        cardAccount.id,
        jeId,
        txn.date,
        txn.amount,
        txn.description,
        offsetAccountId,
        new Date().toISOString(),
      ]
    );

    importedTransactions.push({ fitid: txn.fitid, jeNumber, jeId, status: 'DRAFT', rule: cat.label });
    createdJECount += 1;
    if (txn.isPayment || txn.amount < 0) skippedPayments += 1;
  }

  return {
    createdJECount,
    matchedPayments,
    unmatchedPayments: skippedPayments,
    importedTransactions,
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
