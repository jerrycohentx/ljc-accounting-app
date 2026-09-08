# Claude Learning Ledger — Jerry Cohen (project-scoped copy)
Cross-project master lives at C:\Users\jerry\OneDrive\Desktop\Claude\LEARNING-LEDGER.md.
This copy exists because remote (claude.ai/code) sessions cannot reach OneDrive. Merge into the master when a desktop session next runs.

## Corrections from Jerry
Things he has had to tell Claude. Highest priority — never make him say it a third time.

### 2026-09-08 · "Odoo bot" emails on/about the 7th are Westside Realty operating statements — never treat them as unidentified
Westside emails the prior month's Monthly Income Statement for every LJC property it manages on the 7th, and the net-rent deposit lands the same day (one day later after a bank holiday, e.g. Labor Day → 9/08). Second time told; the app already encodes the 7th in lib/property-registry.js. Cost: Jerry had to re-explain a routine monthly event.

## Working routes
What actually works in his systems, and what is blocked. Saves rediscovery.

### 2026-09-07 · Remote claude.ai/code sessions cannot reach Odoo, Render production, or the servicing app
Network policy returns 403 on CONNECT to ljc-financial-llc.odoo.com and ljc-accounting-app.onrender.com; no DB env vars; OneDrive (LJC-LoanTracker backups, ACH lists) is not mounted; Google Drive holds no 2026 ACH/NSF docs. Any "check Odoo vs servicing" question must run from a Cowork/desktop session with the Odoo tab and OneDrive folder, or after the environment's network allowlist adds those two hosts.

## Business patterns
Counterparties, timing conventions, document locations, naming quirks.

### 2026-09-08 · Westside Realty monthly cycle: statements + net rent on the 7th, deposit slips one business day after a bank holiday
Broker Lawrence Whiteing, Westside Realty, 11152 Westheimer #317, Houston 77042. Statement per property = "Monthly Income Statement"; one deposit covers all properties net of fees/repairs. Book: Dr Due from Westside Realty (gross rent), Cr rent income; expenses/mgmt fee (6100) against the receivable; deposit clears the receivable. Statements filed at Rental-REO property/Operating statements/<yr>/Westside Realty/<prior month>/.

### 2026-09-08 · Westside management agreements (Google Drive) — fee terms to test every statement against
LJC Financial: 6810 Heath + 1311 Jefferson + 5229 Wilmington, TXR-2201 dated 11/01/2024 (Drive "Heath Jefferson Wilmington Management Agreements.pdf"): 10% of gross rents collected, 50% of one month's rent leasing fee, no renewal fee, 10% project-management fee on major renovations/fire claims, 6% if sold to tenant or Westside procures buyer, $150/hr insurance/legal, $250/hr sale coordination; Westside may use its own contractors. Supersedes the 01/24/2024 Jefferson+Heath agreement (8.5%, 100% leasing fee). 7803 Broadview, TXR-2201 dated 03/01/2025–02/28/2026 then month-to-month: 8.5% of gross rents charged or collected, 50% leasing fee, no renewal fee. Contract says only "remit each month" funds plus a statement of receipts, disbursements and charges — the 7th is Westside's practice, not a contract term. Not found in Drive: agreements for 1220 W 18th and 13923 Ivymount (check OneDrive Rental-REO property/<property>/ before asking). OMC Housing 3610 Crane (May 2015) and 4410 Engleford (2018 revised) agreements sit in Drive folder "Westside Realty" — not yet read.

## Mistakes and their causes
Errors Claude made, what caused them, and what prevents a repeat.
