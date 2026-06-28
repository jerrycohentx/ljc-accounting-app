/**
 * OFX Parser for LJC Accounting App
 * ===================================
 *
 * Parses SGML-formatted OFX files from bank exports.
 * Handles both bank statements and credit card statements.
 *
 * OFX Format Notes:
 * - Uses SGML (not XML) with simple tag format <TAG>value</TAG>
 * - Supports STMTTRN for bank transactions, CCSTMTTRN for credit card
 * - FITID provides deduplication key
 * - TRNAMT is signed: positive = credit, negative = debit
 */

import fs from 'fs';

/**
 * Extract tag value from OFX block
 * @param {string} block - Content block
 * @param {string} tagName - Tag name (case-insensitive)
 * @returns {string} Tag value or empty string if not found
 */
function extractTag(block, tagName) {
  const regex = new RegExp(`<${tagName}>([^\\r\\n<]+)`, 'i');
  const match = block.match(regex);
  return match ? match[1].trim() : '';
}

/**
 * Parse date in YYYYMMDD format to ISO string
 * @param {string} dateStr - Date string in YYYYMMDD format
 * @returns {string} ISO date string or original if invalid
 */
function parseDate(dateStr) {
  if (!dateStr || dateStr.length < 8) return dateStr;

  try {
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);

    // Validate date
    const date = new Date(`${year}-${month}-${day}`);
    if (isNaN(date.getTime())) {
      return dateStr;
    }

    return date.toISOString().split('T')[0];
  } catch {
    return dateStr;
  }
}

/**
 * Parse amount string to number
 * @param {string} amountStr - Amount as string
 * @returns {number} Parsed amount
 */
function parseAmount(amountStr) {
  const amount = parseFloat(amountStr);
  return isNaN(amount) ? 0 : amount;
}

/**
 * Detect if OFX is for credit card
 * @param {string} ofxContent - Full OFX content
 * @returns {boolean} True if credit card statement
 */
function isCreditCard(ofxContent) {
  return /(<CREDITCARDMSGSRSV1>|<CCACCTFROM>)/i.test(ofxContent);
}

/**
 * Extract account ID from OFX content
 * @param {string} ofxContent - Full OFX content
 * @returns {string} Account ID or empty string
 */
function extractAccountId(ofxContent) {
  // Try bank account first
  let match = ofxContent.match(/<ACCTID>([^<]+)/i);
  if (match) return match[1].trim();

  // Try credit card account
  match = ofxContent.match(/<ACCTID>([^<]+)/i);
  if (match) return match[1].trim();

  // Try bank ID as fallback
  match = ofxContent.match(/<BANKID>([^<]+)/i);
  if (match) return match[1].trim();

  return '';
}

/**
 * Extract bank routing number
 * @param {string} ofxContent - Full OFX content
 * @returns {string} Routing number or empty string
 */
function extractRoutingNumber(ofxContent) {
  const match = ofxContent.match(/<BANKID>([^<]+)/i);
  return match ? match[1].trim() : '';
}

/**
 * Parse a single transaction from OFX block
 * @param {string} block - Transaction block (between <STMTTRN> tags)
 * @param {boolean} isCCStatement - Is this a credit card statement
 * @returns {object} Parsed transaction
 */
function parseTransaction(block, isCCStatement = false) {
  const rawDate = extractTag(block, 'DTPOSTED');
  const amount = parseAmount(extractTag(block, 'TRNAMT'));
  const name = extractTag(block, 'NAME');
  const memo = extractTag(block, 'MEMO');
  const fitid = extractTag(block, 'FITID');
  const checkNum = extractTag(block, 'CHECKNUM');

  // Combine name and memo for description
  const description = `${name} ${memo}`.trim() || 'Transaction';

  // Parse transaction type
  const trnType = extractTag(block, 'TRNTYPE');
  let type = 'OTHER';
  if (trnType.toUpperCase() === 'CHECK') {
    type = 'CHECK';
  } else if (trnType.toUpperCase() === 'DEBIT') {
    type = 'DEBIT';
  } else if (trnType.toUpperCase() === 'CREDIT') {
    type = 'CREDIT';
  } else if (trnType.toUpperCase() === 'INT') {
    type = 'INTEREST';
  } else if (trnType.toUpperCase() === 'FEE') {
    type = 'FEE';
  } else if (trnType.toUpperCase() === 'ATM') {
    type = 'ATM';
  } else if (trnType.toUpperCase() === 'XFER') {
    type = 'TRANSFER';
  } else if (trnType.toUpperCase() === 'POS') {
    type = 'PURCHASE';
  }

  return {
    date: parseDate(rawDate),
    amount,
    description,
    fitid,
    checkNumber: checkNum || null,
    type,
    isCredit: amount >= 0,
    isDebit: amount < 0,
    status: 'DRAFT',
    raw: {
      trnType,
      name,
      memo
    }
  };
}

/**
 * Main OFX parser function
 * Parses OFX file and returns array of transactions
 *
 * @param {string} filePathOrContent - Path to OFX file or OFX content string
 * @param {object} options - Parser options
 * @param {boolean} options.strict - Validate all required fields (default: false)
 * @returns {object} Parse result with transactions and metadata
 */
export function parseOFX(filePathOrContent, options = {}) {
  const { strict = false } = options;

  let ofxContent;
  let fileName = 'unknown';

  // Determine if input is file path or content
  try {
    if (!filePathOrContent.includes('\n') && filePathOrContent.length < 1000) {
      // Likely a file path
      ofxContent = fs.readFileSync(filePathOrContent, { encoding: 'utf8' });
      fileName = filePathOrContent.split('/').pop() || 'unknown';
    } else {
      // Likely OFX content directly
      ofxContent = filePathOrContent;
    }
  } catch {
    // If file read fails, treat as content
    ofxContent = filePathOrContent;
  }

  // Basic validation
  if (!ofxContent || typeof ofxContent !== 'string') {
    throw new Error('Invalid OFX content: must be string');
  }

  if (!ofxContent.includes('<STMTTRN>') && !ofxContent.includes('<CCSTMTTRN>')) {
    throw new Error('No transactions found in OFX file');
  }

  // Detect statement type
  const isCCStatement = isCreditCard(ofxContent);
  const accountId = extractAccountId(ofxContent);
  const routingNumber = extractRoutingNumber(ofxContent);

  // Extract all transaction blocks
  const transactions = [];
  const errors = [];

  // Match both STMTTRN (bank) and CCSTMTTRN (credit card)
  const transactionBlocks = ofxContent.match(/<(?:CC)?STMTTRN>([\s\S]*?)<\/(?:CC)?STMTTRN>/gi) || [];

  for (const block of transactionBlocks) {
    try {
      const transaction = parseTransaction(block, isCCStatement);

      // Basic validation
      if (strict) {
        if (!transaction.fitid) {
          errors.push(`Transaction missing FITID at line: ${transaction.date}`);
          continue;
        }
        if (!transaction.date) {
          errors.push('Transaction missing date');
          continue;
        }
      }

      transactions.push(transaction);
    } catch (error) {
      errors.push(`Error parsing transaction: ${error.message}`);
    }
  }

  // Sort by date (oldest first)
  transactions.sort((a, b) => new Date(a.date) - new Date(b.date));

  return {
    success: true,
    fileName,
    accountId,
    routingNumber,
    statementType: isCCStatement ? 'CREDIT_CARD' : 'BANK',
    transactionCount: transactions.length,
    dateRange: transactions.length > 0 ? {
      start: transactions[0].date,
      end: transactions[transactions.length - 1].date
    } : null,
    transactions,
    errors,
    metadata: {
      parsedAt: new Date().toISOString(),
      fileType: 'OFX',
      format: 'SGML'
    }
  };
}

/**
 * Validate parsed transactions for import
 * @param {array} transactions - Array of parsed transactions
 * @returns {object} Validation result
 */
export function validateTransactions(transactions) {
  const issues = [];
  const warnings = [];

  if (!Array.isArray(transactions)) {
    return {
      valid: false,
      issues: ['Transactions must be an array'],
      warnings: []
    };
  }

  // Check for duplicates by FITID
  const fitids = new Set();
  const duplicates = [];

  for (const txn of transactions) {
    // Validate required fields
    if (!txn.fitid) {
      issues.push(`Transaction missing FITID: ${txn.description}`);
    }
    if (!txn.date) {
      issues.push(`Transaction missing date: ${txn.fitid || txn.description}`);
    }
    if (txn.amount === undefined || txn.amount === null) {
      issues.push(`Transaction missing amount: ${txn.fitid || txn.description}`);
    }
    if (!txn.description) {
      warnings.push(`Transaction missing description: ${txn.fitid}`);
    }

    // Check for duplicates
    if (fitids.has(txn.fitid)) {
      duplicates.push(txn.fitid);
    }
    fitids.add(txn.fitid);
  }

  if (duplicates.length > 0) {
    warnings.push(`Found ${duplicates.length} duplicate FITIDs in OFX file`);
  }

  return {
    valid: issues.length === 0,
    count: transactions.length,
    issues,
    warnings,
    summary: `${transactions.length} transactions, ${issues.length} errors, ${warnings.length} warnings`
  };
}

/**
 * Deduplicate transactions against existing FITIDs
 * @param {array} newTransactions - New transactions to check
 * @param {Set|array} existingFitids - Existing FITIDs already in system
 * @returns {object} Result with duplicates and new transactions
 */
export function deduplicateTransactions(newTransactions, existingFitids) {
  const fitidSet = existingFitids instanceof Set ? existingFitids : new Set(existingFitids);

  const duplicates = [];
  const newTxns = [];

  for (const txn of newTransactions) {
    if (fitidSet.has(txn.fitid)) {
      duplicates.push(txn);
    } else {
      newTxns.push(txn);
    }
  }

  return {
    newTransactions: newTxns,
    duplicateCount: duplicates.length,
    newCount: newTxns.length,
    duplicates
  };
}

export default {
  parseOFX,
  validateTransactions,
  deduplicateTransactions,
  extractTag,
  parseDate,
  parseAmount
};
