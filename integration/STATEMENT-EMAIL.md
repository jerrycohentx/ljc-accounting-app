# Bank statement email auto-ingest

The accounting app checks your email every **6 hours** for bank statement attachments (PDF, OFX, QFX), imports them, and makes them available in **Reconcile** automatically.

## What you do

**Nothing.** Once mailboxes are configured on the server (Render environment variables), statements are picked up when banks email them.

## Where statements go

1. Saved to `data/bank-imports/inbox/` (audit copy)
2. Parsed and merged into `data/bank-imports/LJC/*-statements.json`
3. Posted to the bank register (same as manual import)
4. Ready in **Banking → Reconcile** with auto-match

## Mailbox setup (one-time — your IT / Cursor agent)

Configure **Render → Environment** for https://ljc-accounting-app.onrender.com

### Option A — jerry@ljcfinancial.com (Microsoft 365) — recommended for Lone Star PDFs

```
GRAPH_TENANT_ID=...
GRAPH_CLIENT_ID=...
GRAPH_CLIENT_SECRET=...
GRAPH_MAILBOX_USER=jerry@ljcfinancial.com
```

Requires Azure app registration with **Mail.Read** application permission and admin consent.

### Option B — Gmail (documents@ or jerrycohentx@)

```
GMAIL_OAUTH_CLIENT_ID=...
GMAIL_OAUTH_CLIENT_SECRET=...
GMAIL_OAUTH_ACCOUNTS=[{"label":"documents","user":"documents.ljcfinancial@gmail.com","refresh_token":"..."}]
```

### Option C — IMAP app password (fallback)

```
STATEMENT_EMAIL_ACCOUNTS=[{"label":"documents","user":"documents.ljcfinancial@gmail.com","password":"app-password-here","host":"imap.gmail.com"}]
```

Or per-mailbox override:

```
STATEMENT_EMAIL_PASSWORD_DOCUMENTS=your-app-password
```

## Optional tuning

| Variable | Default | Meaning |
|----------|---------|---------|
| `STATEMENT_EMAIL_ENABLED` | on | Set `0` to disable |
| `STATEMENT_EMAIL_INTERVAL_HOURS` | 6 | How often to check inbox |
| `STATEMENT_EMAIL_SINCE_DAYS` | 45 | How far back to scan |
| `STATEMENT_EMAIL_SCAN_ON_STARTUP` | on | Check when server starts |

## Manual run (support)

Authenticated API:

```
POST /api/email/ingest/run
GET  /api/email/ingest/status
```

## Banks detected automatically

| Keywords in email / filename | Account |
|------------------------------|---------|
| Lone Star, 7367 | 1001 |
| Simmons, 0260 | 1000 |
| Amex, 88007 | 2010 |

## If email ingest is not configured yet

Use **Import bank statement** on the reconcile screen, or forward bank emails to a configured mailbox.
