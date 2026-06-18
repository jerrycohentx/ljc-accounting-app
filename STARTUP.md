# LJC Accounting App - Complete Setup & Startup Guide

## Overview

This guide walks you through setting up and running the LJC Accounting App from scratch. It's designed for non-technical users but includes all the details you need.

**Timeline:** This process takes about 15-20 minutes total.

---

## Part 1: Initial Setup (Do This Once)

### Step 1a: Open Terminal/Command Prompt

**On Mac/Linux:**
- Open Terminal (Cmd+Space, type "Terminal", press Enter)

**On Windows:**
- Open PowerShell or Command Prompt
- Press `Win+R`, type `cmd` or `powershell`, press Enter

### Step 1b: Navigate to App Directory

```bash
cd path/to/ljc-accounting-app
```

Replace `path/to/ljc-accounting-app` with the actual path where you cloned the repo.

Example on Windows:
```bash
cd "C:\Users\jerry\Claude\Projects\AI accounting\ljc-accounting-app"
```

### Step 1c: Install Node.js Dependencies

```bash
npm install
```

This downloads all required packages. **Only do this once** - it may take 2-5 minutes.

### Step 1d: Initialize the Database

```bash
python3 scripts/setup-production.py
```

This creates the SQLite database with:
- All accounting tables (accounts, journals, ledger, etc.)
- 6 default entities (LJC Financial, Justin Financial, OMC Housing, Graceful Meadows, QOF, Aviation)
- Admin user account
- Essential chart of accounts

**Expected output:**
```
============================================================
LJC ACCOUNTING APP - PRODUCTION DATABASE SETUP
============================================================

[timestamp] ✓ Step 1: Preparing database directory...
[timestamp] ✓ Step 2: Backing up existing database...
[timestamp] ✓ Step 3: Creating database with schema...
[timestamp] ✓ Step 4: Creating default entities...
[timestamp] ✓ Step 5: Creating admin user...
[timestamp] ✓ Step 6: Creating essential chart of accounts...
[timestamp] ✓ Step 7: Verifying installation...

============================================================
✓ DATABASE SETUP COMPLETE
============================================================

Database created at: ./db/accounting.db

Admin User:
  Email: jerry@ljcfinancial.com
  Password: LJCAccounting2026!

Next Steps:
  1. Start the app: npm run dev
  2. Go to http://localhost:3000
  3. Login with credentials above
  4. Change password on first login
```

**Done!** Your database is ready. Setup complete.

---

## Part 2: Starting the App (Do This Each Time)

### Step 2a: Start Backend Server

From the `ljc-accounting-app` directory:

```bash
npm run dev
```

**Expected output:**
```
[timestamp] ✓ Database connected
✓ Server running on http://localhost:3000
✓ Database at ./db/accounting.db
✓ API Endpoints ready
```

Leave this terminal window open. Do NOT close it.

### Step 2b: Start Frontend (In a New Terminal)

Open a NEW terminal window and navigate to the frontend:

```bash
cd path/to/ljc-accounting-app/frontend
npm install  # Only needed once
npm run dev
```

**Expected output:**
```
  VITE v... ready in ... ms
  ➜  Local:   http://localhost:5173/
```

### Step 2c: Open the App in Your Browser

Go to: **http://localhost:5173/**

You should see the login page.

---

## Part 3: Logging In

### First Login

**Email:** `jerry@ljcfinancial.com`
**Password:** `LJCAccounting2026!`

Click **Login**.

### Change Your Password

On first login, you'll be prompted to change your password. **DO THIS** - don't skip it.

### You're In!

You should now see the dashboard with:
- List of entities (LJC Financial, Justin Financial, etc.)
- Accounting menu (Journals, Accounts, Reports)
- Bank import option (NEW - Phase 5a)
- Reconciliation tools (NEW - Phase 5a)

---

## Part 4: Using Bank Import (NEW)

### What It Does

Imports transactions from your bank (OFX format) and creates draft journal entries. You review them before posting.

### Step 4a: Get Your Bank Export

1. Log into your bank (Simmons Bank for LJC)
2. Go to Accounts → Downloads
3. Export as OFX format for desired date range
4. Save the file (e.g., `LJC_transactions_June2026.ofx`)

### Step 4b: Upload OFX File

1. In the app, go to **Bank Import** (in main menu)
2. Click **Choose File** or drag & drop your OFX file
3. Click **Upload & Preview**

You'll see:
- Transaction count
- Date range
- Preview of first 10 transactions
- Any duplicates detected
- Validation warnings (if any)

### Step 4c: Review Transactions

The import shows all transactions in a preview:
- **Date** - When the transaction posted
- **Description** - Merchant/payee name
- **Amount** - Debit (check/withdraw) or Credit (deposit)
- **Status** - DRAFT (not yet in ledger)

**Look for:**
- Wrong amounts? (might indicate a duplicate)
- Suspicious merchants? (could be error)
- Missing transactions? (might already be imported)

### Step 4d: Confirm Import

If preview looks good:

1. Click **Import Transactions**
2. Transactions are created as DRAFT journal entries
3. They appear in your General Ledger as "Pending"
4. Status changes to DRAFT (not yet POSTED)

### Step 4e: Post to Ledger (Later)

Once you've reviewed and reconciled:

1. Go to **Journals**
2. Find your bank import journal entries (marked "Bank Import: ...")
3. Click to open
4. Review debit/credit entries
5. Click **Post** to add to General Ledger

---

## Part 5: Using Bank Reconciliation (NEW)

### What It Does

Matches transactions in your General Ledger to actual bank statements. Catches errors and discrepancies.

### Step 5a: Open Reconciliation Tool

1. Go to **Bank Reconciliation** (in menu)
2. Select Entity (LJC Financial)
3. Select Account (Simmons Bank - X0260)
4. Select Month (e.g., June 2026)

You'll see two columns:
- **LEFT:** Transactions from your General Ledger
- **RIGHT:** Actual bank transactions (from imports)

### Step 5b: Auto-Match (Recommended First)

Click **Auto-Match All**:
- System matches transactions by amount and date
- Marks matches automatically
- Shows unmatched items

**How it works:**
- Looks for GL entries and bank transactions with same amount
- Within 2 days of each other
- Automatically pairs them up
- Very fast for clean data

### Step 5c: Manual Matching (For Unmatched Items)

For any unmatched transactions:

1. Click GL transaction (left side)
2. System suggests matching bank transactions
3. Click the matching bank transaction to pair them
4. Click **Match** button

**Tips:**
- Check amounts match (usually within $0.01)
- Check dates are close (within 2 days typical)
- Some cleared checks might have different bank date vs. GL date

### Step 5d: Mark as Reconciled

Once all transactions are matched:

1. Click **Clear Reconciliation** button
2. Set reconciliation date (usually end of month)
3. System marks all matched items as "RECONCILED"

### Step 5e: Review Summary

After clearing:

You'll see:
- **Bank Balance:** What bank says you have
- **GL Balance:** What your books say you have
- **Variance:** Difference (should be $0.00)
- **Status:** RECONCILED or VARIANCE

**If variance > 0:**
- Check for missing transactions
- Look for transposed numbers
- Verify imports are complete

---

## Part 6: Common Tasks

### Change Password

1. Click your name (top right)
2. Click **Settings** or **My Account**
3. Click **Change Password**
4. Enter old & new password
5. Click **Save**

### Add a New Entity

1. Go to **Settings** → **Entities**
2. Click **Add Entity**
3. Enter: Name, Code, Type (OPERATING/RELATED/HOLDING/QOF)
4. Click **Create**

(New entities must be added by an ADMIN user)

### Create a Manual Journal Entry

1. Go to **Journals**
2. Click **New Journal Entry**
3. Set date and description
4. Add line items (debit/credit pairs)
5. Verify balance (debits = credits)
6. Save and submit for approval

### Export Reports

1. Go to **Reports**
2. Select report type (P&L, Balance Sheet, etc.)
3. Select date range
4. Click **Export as PDF** or **Export as Excel**

---

## Part 7: Troubleshooting

### "Server not found" or "Connection refused"

**Problem:** Can't access http://localhost:3000

**Solution:**
1. Check terminal where you ran `npm run dev`
2. Make sure you see `✓ Server running on http://localhost:3000`
3. If not, see "Server won't start" below

### Server won't start / npm run dev fails

**Problem:** Error in terminal when starting backend

**Solution:**
```bash
# Stop the server (Ctrl+C)
# Then try:
npm install
npm run dev
```

If still failing:
```bash
# Check if port is in use:
# Windows:
netstat -ano | findstr :3000
# Kill process if needed:
taskkill /PID <PID> /F
```

### "Database locked" error

**Problem:** Can't import or reconcile

**Solution:**
1. Stop backend server (Ctrl+C in terminal)
2. Wait 5 seconds
3. Restart: `npm run dev`

This resets the database lock.

### Forgot admin password

**Problem:** Can't log in

**Solution:**
```bash
# Reset database completely:
python3 scripts/setup-production.py
# This will create a new admin user with default password
```

### Duplicate transactions imported

**Problem:** Same transaction appears twice in ledger

**Solution:**
1. Go to **Bank Import** → **Recent Imports**
2. Find the duplicate import
3. Click **View Details**
4. Click **Delete & Rollback**
5. Re-import from original file

The system uses FITID (unique bank ID) to prevent true duplicates, but if imported twice, it shows twice.

### Reconciliation won't match

**Problem:** Can't match GL to bank even though amounts look the same

**Typical causes:**
- Amounts differ by more than $0.01 (due to rounding)
- Dates more than 2 days apart
- Deposit made as multiple transfers

**Solution:**
1. Verify amount in GL matches bank
2. Check posting date vs. bank date
3. For multi-part deposits, match each piece separately

### Missing from bank but in GL

**Problem:** Transaction in your journals but not in bank import

**Cause:** Not yet uploaded from bank, or bank hasn't posted it yet

**Solution:**
1. Check bank website for the transaction
2. If on bank: wait for import, then match
3. If not on bank: error in manual entry - investigate

### Missing from GL but in bank

**Problem:** Bank transaction imported but no matching GL entry

**Cause:** You didn't post the imported transaction, or it's pending review

**Solution:**
1. Go to **Journals**
2. Find "Bank Import: ..." entries marked DRAFT
3. Review them
4. Click **Post** to add to GL

---

## Part 8: Database Files & Backups

### Where's My Data?

All data is in: `./db/accounting.db`

This is a SQLite database file (like Excel but for accounting).

### Backup Your Database

**Manually:**
```bash
# Copy the database file to another location:
cp db/accounting.db ~/Backups/ljc-accounting-backup-$(date +%Y%m%d).db
```

**On Windows:**
```bash
# Copy to Desktop:
copy db\accounting.db %USERPROFILE%\Desktop\ljc-backup-$(Get-Date -Format "yyyyMMdd").db
```

### Restore from Backup

```bash
cp ~/Backups/ljc-accounting-backup-20260615.db ./db/accounting.db
npm run dev
```

---

## Part 9: Understanding the System

### Database Structure

```
LJC Accounting Database
├── Entities (companies: LJC Financial, Justin, OMC, etc.)
├── Users (login accounts)
├── Chart of Accounts (account numbers & names)
├── Journal Entries (transactions you've recorded)
├── General Ledger (posting of journal entries)
├── Import Transactions (from bank OFX files)
└── Reconciliation Matches (GL matched to bank)
```

### Transaction Lifecycle

```
OFX Bank File
    ↓
    [IMPORT - parseOFX]
    ↓
Import Transactions (DRAFT)
    ↓
    [CONFIRM - create journal entries]
    ↓
Journal Entries (DRAFT)
    ↓
    [REVIEW - approve entry]
    ↓
Journal Entries (APPROVED)
    ↓
    [POST - add to ledger]
    ↓
General Ledger (POSTED)
    ↓
    [RECONCILE - match to bank]
    ↓
General Ledger (RECONCILED)
```

### Account Numbering

LJC uses standard accounting numbers:

```
1000-1999: Assets
  1000 - Simmons Bank (checking)
  1100 - Undeposited Funds
  1200 - Accounts Receivable
  
2000-2999: Liabilities
  2000 - Accounts Payable
  2100 - Credit Cards
  2200 - Warehouse Lines
  
3000-3999: Equity
  3000 - Owner's Equity
  
4000-4999: Revenue
  4000 - Interest Income
  4100 - Fee Income
  
5000-5999: Expenses
  5000 - Interest Expense
  5100 - Operating Expense
```

---

## Part 10: Getting Help

### Check Logs

Errors appear in the terminal where you ran `npm run dev`:

```
[timestamp] Error: Account not found
```

Read the error message carefully - it usually tells you what went wrong.

### Review Recent Imports

1. Click **Bank Import**
2. Click **Recent Imports**
3. See the import status and error count

### Export for Accountant

1. Go to **Reports** → **Trial Balance**
2. Export to PDF
3. Email to your accountant for review

---

## Summary Checklist

- [ ] Installed Node.js
- [ ] Ran `npm install`
- [ ] Ran `python3 scripts/setup-production.py` (database created)
- [ ] Started backend: `npm run dev`
- [ ] Started frontend: `cd frontend && npm run dev`
- [ ] Opened http://localhost:5173 in browser
- [ ] Logged in with jerry@ljcfinancial.com / LJCAccounting2026!
- [ ] Changed admin password
- [ ] Imported bank OFX file
- [ ] Reconciled transactions
- [ ] Posted journal entries to ledger

---

## What's Next?

Once you're comfortable with the basics:

1. **Import Monthly OFX Files** - Set a routine to import each month
2. **Reconcile Weekly** - Catch errors early
3. **Post When Balanced** - After reconciliation confirms balance
4. **Review Reports** - Monthly P&L and Balance Sheet
5. **Backup Weekly** - Protect your data

---

## Contact & Support

If you encounter issues:

1. Check **Part 7: Troubleshooting** above
2. Review server terminal for error messages
3. Check database connection
4. Reset and restart: `npm run dev`

For persistent issues:
- Database might be corrupted: run `python3 scripts/setup-production.py` to reset
- Clear browser cache: Ctrl+Shift+Delete (Chrome) or Cmd+Shift+Delete (Firefox)
- Try different browser (Firefox/Chrome/Safari)

---

**Created:** June 2026
**App Version:** 5a (Phase 5: Bank Import & Reconciliation)
**Status:** Production Ready
