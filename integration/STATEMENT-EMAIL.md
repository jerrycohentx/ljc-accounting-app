# Bank statement email — automatic import

Bank statements that arrive by email are imported automatically every **6 hours**. You do not need to download or upload files.

## What you do (one time)

1. Open **https://ljc-accounting-app.onrender.com**
2. Click **Banking → Connect bank email…**
3. Click **Connect** next to each Gmail account and sign in once
4. Close the Google window when it says **Email connected**

After that, statements appear in **Banking → Reconcile** automatically.

## Optional: scan immediately

In the same dialog, click **Scan email now**.

## jerry@ljcfinancial.com (Lone Star PDFs)

Microsoft 365 mail for `jerry@ljcfinancial.com` is read by the server using Graph API credentials (configured on Render by your Cursor agent — not by you).

Until Graph is configured, forward Lone Star statement emails to **documents.ljcfinancial@gmail.com** and connect that Gmail account using the steps above.

## What the app does with each email

1. Finds PDF / OFX attachments from banks
2. Detects Simmons (1000), Lone Star (1001), or Amex (2010)
3. Saves a copy under `data/bank-imports/inbox/`
4. Updates statement data and posts transactions to the register
5. Auto-matches in Reconcile when you open the period

## Status bar

Bottom of the screen shows **Email: [last scan time]**. Click it to open the email dialog.

## Agent setup (Render environment)

Gmail OAuth (required for Connect button):

```
GMAIL_OAUTH_CLIENT_ID=...
GMAIL_OAUTH_CLIENT_SECRET=...
GMAIL_OAUTH_REDIRECT_URI=https://ljc-accounting-app.onrender.com/api/email/gmail/callback
```

Microsoft Graph (jerry@ mailbox):

```
GRAPH_TENANT_ID=...
GRAPH_CLIENT_ID=...
GRAPH_CLIENT_SECRET=...
GRAPH_MAILBOX_USER=jerry@ljcfinancial.com
```

## API (for agents)

```
GET  /api/email/gmail/status
GET  /api/email/gmail/auth-url?user=...
GET  /api/email/gmail/callback   (Google redirect)
POST /api/email/ingest/run
GET  /api/email/ingest/status
POST /api/import/email-scan
```
