# Password reset SMS (Twilio)

Password reset sends a **6-digit code by text** to the mobile number on file for your account.

## Jerry's number (configured)

- **jerry@ljcfinancial.com** → **+1 (281) 831-7855** (`ADMIN_PHONE` on Render)

## Render environment variables

| Variable | Purpose |
|----------|---------|
| `ADMIN_PHONE` | Jerry's mobile (E.164: `+12818317855`) |
| `TWILIO_ACCOUNT_SID` | From [Twilio Console](https://console.twilio.com) |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_FROM_NUMBER` | Twilio phone number that sends texts (E.164) |

Optional per-user map:

```json
PASSWORD_RESET_PHONES={"demo@ljcfinancial.com":"+12818317855"}
```

## One-time Twilio setup (agent / not Jerry)

1. Create account at https://www.twilio.com (trial is fine for testing).
2. Buy or use trial **phone number** with SMS capability.
3. Copy **Account SID** and **Auth Token** from the console.
4. In [Render → ljc-accounting-app → Environment](https://dashboard.render.com):
   - `TWILIO_ACCOUNT_SID` = …
   - `TWILIO_AUTH_TOKEN` = …
   - `TWILIO_FROM_NUMBER` = `+1…` (your Twilio number)
5. Save → Render redeploys (~2 min).

Or run (with Render API key):

```bash
RENDER_API_KEY=rnd_xxx node scripts/set-render-sms-env.js
```

## Test

1. https://ljc-accounting-app.onrender.com/login
2. **Forgot password?** → `jerry@ljcfinancial.com` → **Send text verification code**
3. Enter code from phone → new password

## Without Twilio

If Twilio keys are missing, reset returns “Text message reset is not configured yet.” Jerry can still log in with the current password or `ChangeMe123!` until Twilio is wired.
