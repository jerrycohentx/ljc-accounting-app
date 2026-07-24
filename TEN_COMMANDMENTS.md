# Jerry's Ten Commandments for the Cohen Entities Accounting App

These are permanent, standing rules for any AI assistant (Claude or otherwise)
working on this accounting system. They override convenience, speed, or the
desire to give a tidy-looking answer. They are not suggestions.

## 1. The Prime Directive: Balance or Don't Report It Balanced

> "It's black and white — either a transaction balances or it doesn't. No ifs,
> ands, or buts. Same with a reconciliation. Either it balances or it doesn't.
> If it doesn't, research whatever is necessary to resolve until it does
> balance." — Jerry Cohen, verbatim, July 2026

Concretely, this means:

- No fudging. A variance is never rounded away, written off without
  explanation, or described in soft language ("close enough," "immaterial")
  unless Jerry has explicitly agreed it's immaterial for a stated reason.
- No kicking the can down the road. An open reconciliation variance is not a
  deliverable. "Here's the report, there's a $X gap I didn't explain" is not
  an acceptable stopping point.
- No "uncategorized" entries as a resting place. Every transaction must post
  to a real, correct GL account. "Uncategorized" or a suspense account is a
  temporary flag to come back to immediately, never a final answer.
- Every double-entry transaction must balance to the penny (debits = credits).
  Every reconciliation must tie to the real bank/statement ending balance to
  the penny. If it doesn't, that is treated as a bug to be found and fixed,
  not a rounding footnote.
- When a variance is found: research the actual GL entries, trace the
  transaction history, find the root cause, and fix it — before declaring the
  task done. If full resolution requires more time or a business decision
  only Jerry can make (e.g., "is this real transaction X or Y"), say so
  explicitly and keep working the rest; don't quietly present an unresolved
  number as if it were final.

## 2. Accounting Standards

- GAAP compliance, accrual-basis accounting.
- Standard chart of accounts numbering: Assets 1000-1999, Liabilities
  2000-2999, Equity 3000-3999, Revenue 4000-4999, Expenses 5000-5999.
- Strict double-entry, ACID-compliant postings. Every journal entry must
  balance (sum of debits = sum of credits) before it is committed.
- Use exact decimal math for all money (no floating-point rounding drift).

## 3. Data Integrity & Safety

- Never silently delete or overwrite financial history. Corrections happen
  via new offsetting/correcting entries with a clear audit-trail memo, not by
  editing or deleting the original entry.
- Never introduce a duplicate posting. Transactions imported from any source
  (bank statement PDF, OFX file, Plaid, manual entry) must be checked against
  everything already posted for that entity/account before being committed.
- Any destructive or effectively irreversible action pauses for Jerry's
  explicit go-ahead first.

## 4. Communication

- Report results honestly, including bad news. A variance, a bug, or a
  mistake gets surfaced plainly — not hidden, not minimized.
- Explain results in plain English: what was wrong, what was done, what (if
  anything) Jerry needs to decide or do next.

## 5. Prohibited Account

- Account 2999, "Other Liabilities (Opening Rollup)," is not a real account.
  **No journal entry, ever, should post to it** — not as a temporary plug,
  not as an intermediate step, not for any reason. If a transaction doesn't
  have an obvious correct account yet, stop and ask Jerry rather than
  parking it in 2999.
  — Jerry Cohen, verbatim, July 2026

## 6. Graceful Meadows Transfers

- All transfers to Graceful Meadows are recorded as an intercompany
  receivable/payable in the Due To/From account, specifically **"Due To -
  GM" (account 2900)** — never as a direct expense, distribution, or through
  account 2999.

## 7. Reconciliation Report Format

- The QuickBooks Desktop-style Reconciliation Summary + Detail report format
  is the **only** format for presenting reconciliations to Jerry going
  forward — delivered as real documents (PDF), not ad hoc chat summaries or
  widgets.

## 8. Drillable Reports & QBO-Style Date Ranges

- Every line item in every report (Balance Sheet, P&L, Cash Flow, Trial
  Balance, General Ledger, etc.) must be clickable/drillable down to the
  underlying transactions.
- Every report's date selection must offer the same preset options as
  QuickBooks Online (Today, Yesterday, This/Last Week, This/Last Month,
  This/Last Quarter, This/Last Year, Year-to-Date variants, All Dates,
  Custom) — not just raw date pickers.
- If a report (e.g. Cash Flow) doesn't yet have real underlying data or
  logic to support this, say so plainly rather than adding a date/drill UI
  on top of a stub that would mislead Jerry into thinking the numbers are
  real.

## 9. Hard period integrity (system-enforced, July 2026)

- Period close is refused unless every monitored bank/card account has a
  CLOSED reconciliation covering that month at **$0.00** difference.
- Plug / "Enter Adjustment" / `reconcile-adjustment` journal entries are
  **permanently disabled** in the app.
- Assistants must call
  `GET /api/entities/:entityId/accounting/periods/integrity` and may only
  say a month is closed when **`isClosed: true`**. Chat memory is not proof.

---
*This file is the durable source of truth for these standing rules. Any
assistant working on this codebase should read it before doing reconciliation,
GL posting, or import work, and must not violate it.*

## Monthly close discipline (added 7/3/2026, owner directive)
Every month must be FULLY closed before work moves to the next month:
1. Every bank account reconciled to its statement with $0.00 difference (closed session).
2. Every credit card reconciled to its statement (analytic tie acceptable where the recon engine cannot handle credit-normal accounts; document cutoff items).
3. Intercompany balances tied against counterparty books.
4. Zero uncategorized entries: 1100 Undeposited Funds and all Uncategorized income/expense accounts empty for the month; pending-import queue cleared.
The monthly loan-servicing (TMO) report is required input for categorizing ACH collection batches, chargebacks, and borrower checks.
