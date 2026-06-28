# Gmail on Render — fix “GMAIL API ⚠ add GMAIL_OAUTH_CLIENT_ID + SECRET”

The app reads Gmail using Google’s API. Render needs two keys (one-time setup).

## Option A — Add OAuth keys on Render (keeps “Connect with Google”)

1. Open **https://console.cloud.google.com/apis/credentials**
2. Select the project used for LJC Accounting (or create one).
3. **Create credentials → OAuth client ID → Web application**
4. **Authorized redirect URI** (must match exactly):

   `https://ljc-accounting-app.onrender.com/api/email/gmail/callback`

5. Copy **Client ID** and **Client secret**.
6. Render → **ljc-accounting-app → Environment → Add**:
   - `GMAIL_OAUTH_CLIENT_ID` = (paste Client ID)
   - `GMAIL_OAUTH_CLIENT_SECRET` = (paste Client secret)
7. Save → wait for redeploy → **Banking → Connect bank email… → Scan email now**

If Gmail still fails, click **Connect with Google** again for each account after redeploy.

## Option B — Use a Gmail App Password (no Google Cloud keys)

For each `@gmail.com` account:

1. Google Account → **Security → 2-Step Verification → App passwords**
2. Create password for **Mail**
3. In LJC Accounting: **Banking → Connect bank email…**
4. Click **Connect** (not “Connect with Google”) → paste the 16-character password

This uses IMAP and does **not** require `GMAIL_OAUTH_CLIENT_ID` on Render.

## Lone Star statements without Gmail

If **Lone Star portal ✓ login 7367** shows in the email dialog, a manual **Scan email now** will also try **my.lsbtexas.com** directly (no email required). You still need `LONESTAR_ONLINE_PASSWORD` on Render.
