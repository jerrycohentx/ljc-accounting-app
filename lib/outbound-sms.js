/**
 * Outbound SMS (password reset codes) via Twilio REST API.
 */

export function isSmsConfigured() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID
    && process.env.TWILIO_AUTH_TOKEN
    && process.env.TWILIO_FROM_NUMBER
  );
}

/** Normalize US numbers to E.164 (+1XXXXXXXXXX). */
export function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith('+')) {
    const digits = s.replace(/\D/g, '');
    return digits ? `+${digits}` : '';
  }
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return '';
}

export function maskPhone(e164) {
  const digits = String(e164 || '').replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***-***-${digits.slice(-4)}`;
}

export async function sendPasswordResetSms({ to, code, expiresMinutes = 15 }) {
  if (!isSmsConfigured()) {
    throw new Error('Twilio not configured (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER)');
  }

  const toNorm = normalizePhone(to);
  if (!toNorm) throw new Error('Invalid phone number');

  const body = `LJC Accounting password reset code: ${code}. Expires in ${expiresMinutes} min. Ignore if you did not request this.`;

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = normalizePhone(process.env.TWILIO_FROM_NUMBER);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: toNorm, From: from, Body: body }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.error_message || res.statusText;
    throw new Error(`Twilio SMS failed: ${msg}`);
  }

  return { sid: data.sid, to: toNorm };
}
