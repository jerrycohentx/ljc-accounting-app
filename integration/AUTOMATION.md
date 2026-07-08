# LJC Automation — Plain English Summary

**Updated:** July 6, 2026

Both apps share `integration/ljc-automation-manifest.json`. The accounting server runs auto-backup, Plaid auto-sync, statement email ingest, statement folder auto-load, and ACH JE inbox scan on startup.

## NSF / payment returns (active paths)

Jerry **no longer uses TMO**. NSF detection and borrower notices use these paths only:

| Path | Direction | NSF notice email |
|------|-----------|------------------|
| **ACH Return Report (PDF)** | Loan Servicing import | Yes — Letter Center NSF notice (checkbox on import) |
| **Accounting bank feed** | Accounting detects return → loan polls `/api/payment-returns/pending-sync` | Yes — auto after sync |
| **Loan → accounting** | After NSF posted on loan ledger, POST `/api/automation/loan-events` | N/A (suggestion for accounting match only) |

**Deprecated (no NSF auto-email):** TMO master import, TMO history import, bulk history import.

### Accounting APIs

- `GET /api/payment-returns/pending-sync?entityId=ent-ljc` — loan app poll (JWT)
- `POST /api/payment-returns/:id/ack-sync` — loan acknowledges sync
- `GET /api/payment-returns/pending` — accounting review queue
- `POST /api/payment-returns/:id/draft-je` — DRAFT JE when rule + offset account match (no plugs)
- `POST /api/payment-returns/:id/post` — post only when bank line + loan/draw match on file
- `POST /api/automation/loan-events` — loan NSF push (integration key; suggestions only)

Bank imports call `detectPaymentReturn()` on each new Simmons/OFX/Plaid line (`integration/return-payment-rules.json`).

### Loan app behavior

- Polls accounting every 5 minutes while open (`startPaymentReturnSyncPoll`)
- ACH PDF import: reverse payment, $60 fee, 18% on fee, paid-to rollback, email NSF notice
- Accounting sync: same ledger treatment + auto email when borrower email on file
- Pushes `nsf_return` loan-events after ACH PDF import (not on accounting-sync round-trip)

## Other automation

| Routine | When | Where |
|---------|------|--------|
| Accounting DB backup | Every 60 min | Accounting server |
| **Plaid auto-sync** | Every 24h + startup + webhook | `lib/plaid-auto-sync.js` → review queue (DRAFT) |
| Statement email ingest | Every 6h (configurable) | Accounting |
| **Document email ingest** | Every 6h (configurable) | `lib/document-email-ingest.js` → Activity Review DRAFT |
| Statement OFX auto-load | Every 24h | Accounting |
| ACH JE inbox scan | Every 15 min | Accounting |
| Loan portfolio backup | On close / 10 min / after edits | Loan Servicing browser |

### Daily bank & card feeds (accounting)

1. **Plaid** — `PLAID_AUTO_SYNC_INTERVAL_HOURS` (default 24). On startup (20s delay) and when Plaid sends `SYNC_UPDATES_AVAILABLE` webhook. New transactions land in **Activity Review** as DRAFT; nothing posts without approval.
2. **Email** — `STATEMENT_EMAIL_INTERVAL_HOURS` (default 6). Simmons, Lone Star, Amex statements from connected mailboxes.
3. **Folder auto-load** — `STATEMENT_AUTO_LOAD_INTERVAL_HOURS` (default 24). OFX from `data/bank-imports/`.

Status API: `GET /api/feeds/status` (last run, next scheduled, pending review count).

Multi-entity dashboard: `GET /api/dashboard/entities-summary` — UI at **Dashboard** toolbar / `/dashboard`.

Activity review: `GET /api/import/review-queue` — UI at **Review** toolbar / `/feed-review` (badge shows pending count).

## ACH batch → accounting

When NACHA is generated in Loan Servicing, `QBO_ACH_JE_YYYY-MM.csv` is pushed to `/api/automation/ach-je/import` and scanned from `ACH lists\` every 15 minutes.

## Health checks

- Accounting: `/health` (full status + `gitSha`)
- Both apps: `/api/automation/platform-health`

## `.env`

- `LOAN_TRACKER_INTEGRATION_KEY` — same key in Loan app Cohen Accounting settings (default `ljc-cohen-loan-tracker-2026`)
- `ACH_JE_INBOX_SCAN_ENABLED=false` — disable folder scan
- `LOAN_TRACKER_URL=http://localhost:8765` — platform health
- `PLAID_AUTO_SYNC_INTERVAL_HOURS=24` — Plaid daily sync (set `PLAID_AUTO_SYNC_ENABLED=0` to disable)
- `PLAID_WEBHOOK_URL` — Render: `https://your-app.onrender.com/api/plaid/webhook` (triggers sync on bank updates)
- `STATEMENT_EMAIL_INTERVAL_HOURS=6` — email statement scan (use `24` for once-daily)
- `STATEMENT_AUTO_LOAD_INTERVAL_HOURS=24` — OFX folder auto-load
- `DAILY_FEED_RUN_HOUR` — optional documentation for preferred daily run hour

Never use 1Password CLI (`op`).
