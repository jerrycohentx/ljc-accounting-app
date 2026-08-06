import { v4 as uuidv4 } from 'uuid';
import { categorizeAmexTransaction } from './amex-categorization.js';
import { resolveAccountByNumber } from './categorization-rules.js';
import { filterNewTransactions } from './transaction-dedup.js';
import {
  assertNotCashOffset,
  isCardPaymentTxn,
  isMerchantCreditTxn,
} from './card-import-guards.js';

/**
 * Find bank-side Amex payment already posted (DR 2010 from Simmons/Lone Star AMEX EPAYMENT).
 */
export async function findMatchingBankPayment(db, entityId, { amount, date, toleranceDays = 7, cardAccountNumber = '2010' }) {
  const absAmt = Math.abs(Number(amount));
  const cardNum = String(cardAccountNumber || '2010');
  const rows = await db.all(
    `SELECT je.id AS je_id, je.posting_date, je.description, jelCard.debit AS card_debit, jelCard.credit AS card_credit
     FROM journal_entries je
     JOIN journal_entry_lines jelCard ON jelCard.journal_entry_id = je.id
     JOIN accounts a ON a.id = jelCard.account_id AND a.account_number = ?
     WHERE je.entity_id = ? AND je.status = 'POSTED'
       AND je.reversed_by_je_id IS NULL AND je.reverses_je_id IS NULL
       AND (
         ABS(jelCard.debit - ?) < 0.02 OR ABS(jelCard.credit - ?) < 0.02
         OR ABS(jelCard.debit + jelCard.credit - ?) < 0.02
       )`,
    [cardNum, entityId, absAmt, absAmt, absAmt]
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
 * Charges: DR expense · CR 2010.
 * Merchant credits: DR 2010 · CR expense.
 * Payments: never invent cash — match bank OFX or skip.
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

  const defaultExpense = await resolveAccountByNumber(db, entityId, '5700');
  if (!defaultExpense) throw new Error('Expense account 5700 not found — required for Amex charges');

  const {
    kept: newTransactions,
    duplicates: skippedDuplicates,
    fitidDuplicateCount,
    contentDuplicateCount,
  } = await filterNewTransactions(db, entityId, cardAccount.id, transactions);

  let createdJECount = 0;
  let matchedPayments = 0;
  let skippedPayments = 0;
  let merchantCredits = 0;
  const importedTransactions = [];

  for (const txn of newTransactions) {
    const absAmount = Math.abs(Number(txn.amount));
    const desc = String(txn.description || '');

    // --- Payments: bank OFX owns the cash leg ---
    if (isCardPaymentTxn(txn) && !isMerchantCreditTxn(txn)) {
      const bankMatch = skipMatchedPayments
        ? await findMatchingBankPayment(db, entityId, {
          amount: txn.amount,
          date: txn.date,
          cardAccountNumber,
        })
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
      skippedPayments += 1;
      importedTransactions.push({
        fitid: txn.fitid,
        status: 'UNMATCHED_PAYMENT',
        amount: txn.amount,
        description: desc,
      });
      continue;
    }

    const isCredit = isMerchantCreditTxn(txn) || Number(txn.amount) < 0;
    const cat = await categorizeAmexTransaction(db, entityId, {
      ...txn,
      isMerchantCredit: isCredit,
      isPayment: false,
    });
    const offsetAccountId = cat.offsetAccountId || defaultExpense.id;
    await assertNotCashOffset(db, entityId, offsetAccountId, 'Amex import');

    // Charge: DR expense CR card. Merchant credit: DR card CR expense.
    const cardDebit = isCredit ? absAmount : 0;
    const cardCredit = isCredit ? 0 : absAmount;
    const offsetDebit = isCredit ? 0 : absAmount;
    const offsetCredit = isCredit ? absAmount : 0;

    const jeId = `je-${uuidv4()}`;
    const prefix = String(cardAccountNumber) === '2010' ? 'AMEX'
      : String(cardAccountNumber) === '2011' ? 'CHASE'
      : String(cardAccountNumber) === '2013' ? 'RAMP'
      : `CARD${cardAccountNumber}`;
    const jeNumber = `${prefix}-${Date.now()}-${uuidv4().substring(0, 8)}`;

    await db.run(
      `INSERT INTO journal_entries (
        id, entity_id, je_number, description, posting_date, status,
        created_by, total_debit, total_credit, memo
      ) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
      [
        jeId,
        entityId,
        jeNumber,
        `${sourceLabel}: ${desc}`,
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
      [`jel-${uuidv4()}`, jeId, cardAccount.id, cardDebit, cardCredit, `Amex: ${desc}`]
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
        desc,
        offsetAccountId,
        new Date().toISOString(),
      ]
    );

    importedTransactions.push({
      fitid: txn.fitid,
      jeNumber,
      jeId,
      status: 'DRAFT',
      rule: cat.label,
      kind: isCredit ? 'merchant_credit' : 'charge',
    });
    createdJECount += 1;
    if (isCredit) merchantCredits += 1;
  }

  return {
    createdJECount,
    matchedPayments,
    unmatchedPayments: skippedPayments,
    merchantCredits,
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
