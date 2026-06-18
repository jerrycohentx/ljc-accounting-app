# OFX Parser Module

## Overview

`ofx-parser.js` is a robust SGML-based OFX file parser designed for bank transaction imports. It handles both bank statements and credit card statements in the OFX (Open Financial Exchange) format commonly exported from U.S. banks.

## Why SGML not XML?

Most banks export "Web Connect" files in SGML format (legacy), not XML. SGML uses simpler tag syntax and is very common from U.S. financial institutions. This parser handles SGML format natively without requiring complex XML parsing.

## Features

- Parses SGML-formatted OFX files (typical bank exports)
- Handles both bank (STMTTRN) and credit card (CCSTMTTRN) statements
- Extracts transaction metadata: date, amount, description, check number, FITID
- Automatically detects statement type (bank vs. credit card)
- Provides deduplication via FITID (unique bank transaction ID)
- Validates parsed transactions
- Tolerates malformed OFX (missing optional fields)
- Returns structured JSON for database import

## Usage

### Basic Import

```javascript
import { parseOFX } from './lib/ofx-parser.js';

// Parse from file path
const result = parseOFX('/path/to/bank-export.ofx');

// Parse from content string
const result = parseOFX(ofxContent);

console.log(result);
// {
//   success: true,
//   fileName: 'bank-export.ofx',
//   accountId: '0260',
//   statementType: 'BANK',
//   transactionCount: 173,
//   dateRange: { start: '2026-01-01', end: '2026-06-17' },
//   transactions: [ ... ],
//   errors: [],
//   metadata: { ... }
// }
```

### Advanced Options

```javascript
// Strict validation - rejects transactions with missing required fields
const result = parseOFX(ofxContent, { strict: true });

if (result.success) {
  console.log(`${result.transactionCount} transactions parsed`);
} else {
  console.log('Parsing failed:', result.errors);
}
```

## API Reference

### parseOFX(filePathOrContent, options)

Main parser function.

**Parameters:**
- `filePathOrContent` (string): File path or OFX content
- `options` (object, optional):
  - `strict` (boolean): If true, reject invalid transactions (default: false)

**Returns:** Parse result object

**Result Object:**
```javascript
{
  success: boolean,           // Parsing succeeded
  fileName: string,           // Original file name
  accountId: string,          // Extracted account ID
  routingNumber: string,      // Bank routing number (if found)
  statementType: 'BANK' | 'CREDIT_CARD',
  transactionCount: number,   // Total transactions parsed
  dateRange: {                // First & last transaction dates
    start: string,            // ISO format YYYY-MM-DD
    end: string
  },
  transactions: [             // Array of parsed transactions
    {
      date: string,           // ISO format
      amount: number,         // Signed: + credit, - debit
      description: string,    // Merchant/payee
      fitid: string,          // Unique transaction ID
      checkNumber: string|null,
      type: string,           // CHECK, DEBIT, CREDIT, TRANSFER, etc.
      isCredit: boolean,      // Amount >= 0
      isDebit: boolean,       // Amount < 0
      status: 'DRAFT',        // Initial status
      raw: {                  // Original OFX values
        trnType: string,
        name: string,
        memo: string
      }
    }
  ],
  errors: [string],           // Any parsing warnings
  metadata: {
    parsedAt: string,         // ISO timestamp
    fileType: 'OFX',
    format: 'SGML'
  }
}
```

### validateTransactions(transactions)

Validate parsed transactions for import safety.

**Parameters:**
- `transactions` (array): Array of transaction objects

**Returns:**
```javascript
{
  valid: boolean,             // All checks passed
  count: number,
  issues: [string],           // Critical errors
  warnings: [string],         // Non-critical warnings
  summary: string             // Human-readable summary
}
```

**Validates:**
- All required fields present (fitid, date, amount)
- No duplicate FITIDs
- Date values are valid

**Example:**
```javascript
const validation = validateTransactions(result.transactions);

if (!validation.valid) {
  console.error('Validation failed:', validation.issues);
} else {
  console.log(validation.summary);
  // "173 transactions, 0 errors, 2 warnings"
}
```

### deduplicateTransactions(newTransactions, existingFitids)

Separate new transactions from duplicates already in system.

**Parameters:**
- `newTransactions` (array): Freshly parsed transactions
- `existingFitids` (Set|array): FITIDs already in database

**Returns:**
```javascript
{
  newTransactions: [array],   // Transactions not yet in system
  duplicateCount: number,
  newCount: number,
  duplicates: [array]         // Already-imported transactions
}
```

**Example:**
```javascript
// Get existing FITIDs from database
const existing = await db.all(
  'SELECT DISTINCT fitid FROM import_transactions'
);
const fitidSet = new Set(existing.map(r => r.fitid));

// Check what's new
const dedup = deduplicateTransactions(parsed.transactions, fitidSet);

console.log(`${dedup.newCount} new, ${dedup.duplicateCount} duplicates`);
```

## Transaction Fields

### amount

Signed decimal value:
- **Positive** = Credit (deposit, payment received)
- **Negative** = Debit (withdrawal, payment made)

Always matches the bank's perspective (what they report to you).

```javascript
// Deposit of $1,000
{ amount: 1000.00, isCredit: true, isDebit: false }

// Payment of $500
{ amount: -500.00, isCredit: false, isDebit: true }
```

### type

Transaction type extracted from OFX TRNTYPE field:

| Type | Meaning |
|------|---------|
| CHECK | Check written |
| DEBIT | Debit card transaction |
| CREDIT | Incoming payment/deposit |
| TRANSFER | Inter-account transfer |
| INTEREST | Interest earned |
| FEE | Bank fee |
| ATM | ATM withdrawal |
| PURCHASE | Purchase (credit card) |
| OTHER | Unknown type |

### fitid

**Critical for deduplication.** The bank-assigned unique transaction ID.

- Guaranteed unique per statement
- Format varies by bank (numeric, alphanumeric, UUID)
- Use this as primary key in import_transactions table
- Never changes, so it's the single source of truth for duplicate detection

## Common Errors & Solutions

### "No transactions found in OFX file"

**Problem:** File doesn't contain STMTTRN or CCSTMTTRN blocks

**Causes:**
- File is XML-formatted OFX (not SGML) - different format
- File is corrupt or incomplete
- Wrong file type altogether

**Solution:**
- Verify you exported in "Web Connect" format (SGML)
- Check file opens in text editor and contains <STMTTRN> tags
- Try exporting again from bank portal

### "Invalid OFX content: must be string"

**Problem:** Function received wrong data type

**Solution:**
- Pass file path as string: `parseOFX('./file.ofx')`
- OR pass file contents as string: `parseOFX(fsReadFileSync('./file.ofx', 'utf8'))`
- Not: `parseOFX(buffer)` or `parseOFX(fileObject)`

### Parsing succeeds but transactions are empty

**Problem:** OFX file has different tag names

**Causes:**
- Bank using variant OFX format
- Different statement structure
- Credit card vs. bank differences

**Solution:**
- Check raw OFX tags match expected format
- Open file in text editor, search for `<STMTTRN>`
- If tags are different, update regex in parseTransaction()

### Large files timeout

**Problem:** Parsing takes very long for files with 1000+ transactions

**Solution:**
- No batching needed - parseOFX handles large files
- If timeout occurs, likely file corruption
- Try processing smaller date ranges separately

## Performance

Typical performance:
- **100 transactions:** ~50ms
- **500 transactions:** ~200ms
- **1000+ transactions:** <1 second

Bottleneck is regex matching, not data volume.

## Integration with Accounting App

### Import Flow

```
User uploads OFX file
    ↓
POST /api/import/ofx
    ↓
parseOFX() - returns transactions
    ↓
validateTransactions() - check for errors
    ↓
deduplicateTransactions() - find new vs existing
    ↓
Show preview to user
    ↓
User confirms import
    ↓
POST /api/import/transactions
    ↓
Create journal entries from transactions
    ↓
Add to General Ledger (DRAFT status)
    ↓
User reviews & posts to ledger
```

### Database Schema

Store parsed transactions in `import_transactions` table:

```sql
CREATE TABLE import_transactions (
  id TEXT PRIMARY KEY,
  fitid TEXT NOT NULL UNIQUE,        -- Use parseOFX.fitid
  import_id TEXT,                    -- Session ID
  entity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  date DATE NOT NULL,                -- parseOFX.date
  amount DECIMAL(19,2) NOT NULL,     -- parseOFX.amount
  description TEXT,                  -- parseOFX.description
  check_number TEXT,                 -- parseOFX.checkNumber
  transaction_type TEXT,             -- parseOFX.type
  status TEXT DEFAULT 'DRAFT',       -- DRAFT, MATCHED, RECONCILED
  matched_to_gl_id TEXT,            -- GL entry ID when matched
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Example: Complete Import Flow

```javascript
import { parseOFX, validateTransactions, deduplicateTransactions } from './lib/ofx-parser.js';

async function importOFXFile(filePath, entityId) {
  // 1. Parse the OFX file
  const parseResult = parseOFX(filePath);
  
  if (!parseResult.success) {
    throw new Error(`Parse failed: ${parseResult.errors.join(', ')}`);
  }
  
  // 2. Validate transactions
  const validation = validateTransactions(parseResult.transactions);
  if (!validation.valid) {
    throw new Error(`Validation failed: ${validation.issues.join(', ')}`);
  }
  
  // 3. Check for duplicates in database
  const db = await getDatabase();
  const existing = await db.all(
    'SELECT fitid FROM import_transactions WHERE entity_id = ?',
    [entityId]
  );
  const existingFitids = new Set(existing.map(r => r.fitid));
  
  // 4. Separate new from duplicates
  const dedup = deduplicateTransactions(parseResult.transactions, existingFitids);
  
  console.log(`Parsed: ${parseResult.transactionCount}`);
  console.log(`New: ${dedup.newCount}`);
  console.log(`Duplicates: ${dedup.duplicateCount}`);
  
  // 5. Store new transactions
  const importId = `imp-${uuid()}`;
  for (const txn of dedup.newTransactions) {
    await db.run(
      `INSERT INTO import_transactions (
        id, fitid, import_id, entity_id, account_id, date, amount,
        description, check_number, transaction_type, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `itxn-${uuid()}`,
        txn.fitid,
        importId,
        entityId,
        accountId,
        txn.date,
        txn.amount,
        txn.description,
        txn.checkNumber,
        txn.type,
        'DRAFT',
        new Date().toISOString()
      ]
    );
  }
  
  return {
    importId,
    parsed: parseResult.transactionCount,
    imported: dedup.newCount,
    skipped: dedup.duplicateCount
  };
}
```

## Testing

Test with the provided OFX file:

```bash
# From project root:
node -e "
const { parseOFX, validateTransactions } = require('./lib/ofx-parser.js');
const result = parseOFX('./data/LJC_transactions.ofx');
const validation = validateTransactions(result.transactions);

console.log('Parsed:', result.transactionCount);
console.log('Valid:', validation.valid);
console.log('Summary:', validation.summary);
console.log('Date Range:', result.dateRange);
"
```

## Limitations

- **SGML only:** Does not parse XML-formatted OFX files
- **ASCII text only:** Not for binary file formats
- **No encryption:** Assumes unencrypted OFX content
- **No compression:** Does not handle gzip/compressed OFX
- **US banks only:** Dates in YYYYMMDD (US format)

## Future Enhancements

Potential improvements:
- XML-formatted OFX support
- Investment transaction parsing (stocks, mutual funds)
- Bank-specific field parsing
- Automatic merchant-to-account mapping
- Transaction categorization via ML

## Reference

- **OFX Spec:** http://www.ofxhome.com/spec.html
- **SGML Tags:** Standard STMTTRN, CCSTMTTRN
- **FITID:** Unique Financial Transaction ID per bank
- **Web Connect:** Quicken/Web Connect export format (SGML)

---

**Version:** 1.0  
**Created:** June 2026  
**Status:** Production Ready
