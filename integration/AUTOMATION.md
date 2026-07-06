# LJC Automation — Plain English Summary

**Updated:** July 5, 2026

Both apps share `integration/ljc-automation-manifest.json`. The accounting server already runs auto-backup, statement email ingest, and statement folder auto-load on startup. This pass adds **cross-app ACH journal import** and a **unified health check**.

## What runs automatically

| Routine | When | Where |
|---------|------|--------|
| Accounting DB backup | Every 60 min (configurable) | Accounting server startup |
| Statement email ingest | Scheduled interval | Accounting |
| Statement OFX auto-load | Every 24h | Accounting |
| **ACH JE inbox scan** | Every 15 min | Accounting (new) |
| Loan portfolio backup | On close / 10 min / after edits | Loan Servicing browser |
| NSF/wire return sync | While Loan app is open | Loan → Accounting poll |

## ACH batch → accounting (new)

When you generate NACHA in Loan Servicing:

1. `QBO_ACH_JE_YYYY-MM.csv` saves to `AI accounting\ACH lists\`
2. Loan app pushes the CSV to accounting (`/api/automation/ach-je/import`)
3. Accounting also scans that folder every 15 minutes (idempotent — same month never duplicates)

## Health checks

- Accounting: `/health` (full status + backup)
- Both apps: `/api/automation/platform-health` (no login)

## Loan events (scaffold)

Loan app can POST payment/NSF/payoff events to `/api/automation/loan-events` — **suggestions only**, no auto-posting.

## `.env` (only if missing)

- `LOAN_TRACKER_INTEGRATION_KEY` — same key in Loan app Cohen Accounting settings
- `ACH_JE_INBOX_SCAN_ENABLED=false` — disable folder scan
- `ACH_JE_INBOX_INTERVAL_MINUTES=15` — scan frequency
- `LOAN_TRACKER_URL=http://localhost:8765` — for platform health

Never use 1Password CLI (`op`).
