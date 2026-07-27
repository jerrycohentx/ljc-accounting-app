# Ramp card integration

Pulls **Ramp card transactions** directly into the accounting app's review
queue ("Check Categories"), replacing the Ramp → Puzzle sync. Nothing posts to
the ledger automatically — every Ramp charge lands as a DRAFT for review, same
as bank feeds.

## How it works

1. Jerry connects Ramp once: **Banking → Connect Ramp card…** (`/ramp`). He
   pastes the Ramp API **Client ID** and **Client Secret** (stored encrypted).
2. A background worker (`lib/ramp-sync.js`) polls Ramp every few hours via the
   OAuth **client-credentials** grant and the `GET /developer/v1/transactions`
   endpoint, following pagination.
3. Settled card transactions (`CLEARED`/`COMPLETION`) are mapped to the shared
   bank-import shape and committed as DRAFT journal entries + `import_transactions`
   rows. Dedup is by `fitid = ramp-<transaction_id>`, so overlapping windows
   never double-book (idempotent).
4. Jerry reviews/categorizes them in **Check Categories**, then posts.

## Accounting model

Ramp charges book against a **Ramp Card liability** account:

- Charge:  **DR** expense (categorized) / **CR** `2015 Ramp Card`
- Refund:  **DR** `2015 Ramp Card` / **CR** expense

The account `2015 Ramp Card` (LIABILITY, CREDIT normal balance) is auto-created
on first sync if missing.

> **Follow-up for the books to net correctly:** the payment that pays off the
> Ramp balance from Simmons (the "RAMP STATEMENT" ACH) should book
> **DR `2015 Ramp Card` / CR Simmons**, not straight to an expense. Otherwise
> Ramp spend is counted twice (once per charge, once at statement payment).
> Update the categorization rule for the Simmons "RAMP" payment to target
> account `2015` instead of `5700`.

## Environment variables (Render / `.env`)

| Var | Default | Purpose |
|---|---|---|
| `RAMP_AUTO_SYNC_ENABLED` | `1` | Set `0` to disable the background worker |
| `RAMP_AUTO_SYNC_INTERVAL_HOURS` | `6` | Poll frequency |
| `RAMP_AUTO_SYNC_STARTUP_DELAY_MS` | `30000` | Delay before first poll on boot |
| `RAMP_AUTO_SYNC_ON_STARTUP` | `1` | Set `0` to skip the boot sync |
| `RAMP_INITIAL_LOOKBACK_DAYS` | `120` | How far back the first sync reaches |
| `RAMP_CARD_ACCOUNT_NUMBER` | `2015` | GL account Ramp charges book to |
| `PLAID_TOKEN_KEY` / `JWT_SECRET` | — | Reused to encrypt stored Ramp credentials |

Credentials themselves are **not** env vars — Jerry pastes them once in the UI
and they are AES-256-GCM encrypted at rest (same crypto as Plaid tokens).

## Ramp API app setup (one-time, in Ramp)

Ramp → **Settings → Developer / API** → create an app with the
**`transactions:read`** scope, grant type **Client credentials**. Copy the
Client ID and Client Secret into the app's Connect Ramp screen.

## Endpoints

- `GET  /api/ramp/status?entityId=…` — connection + auto-sync status
- `POST /api/ramp/connect` — `{ entityId, clientId, clientSecret, environment, businessName }` (verifies before saving)
- `POST /api/ramp/sync` — `{ entityId }` pull now
- `POST /api/ramp/disconnect` — `{ entityId }`
- `POST /api/ramp/webhook` — unauthenticated; triggers a background sync
