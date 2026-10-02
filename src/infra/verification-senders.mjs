// Identity V2 · I6a — how a FitFlex verification code reaches a person.
//
// Nothing is sent unless a provider is named in the environment; a deploy on
// its own never starts sending (or paying for) messages.
//   VERIFICATION_SMS_PROVIDER    'beem' | 'fake' (never in production)
//   VERIFICATION_EMAIL_PROVIDER  'mailgun' | 'fake' (never in production)
// Credentials come from the environment only.

const IS_PROD = () => process.env.NODE_ENV === 'production';

/** What the 'fake' providers "sent", for tests and local development. */
export const fakeOutbox = [];

const fake = channel => ({
  configured: true,
  send: async (to, message) => { fakeOutbox.push({ channel, to, ...message }); return { ok: true }; },
});
const notConfigured = { configured: false, send: async () => ({ ok: false, error: 'not_configured' }) };

/**
 * Beem Africa SMS (decision of 2 Oct 2026). BEEM_API_KEY / BEEM_SECRET_KEY,
 * and the sender name registered with Beem in VERIFICATION_SMS_SENDER_ID.
 */
function beemSms() {
  const apiKey = process.env.BEEM_API_KEY;
  const secretKey = process.env.BEEM_SECRET_KEY;
  const sender = process.env.VERIFICATION_SMS_SENDER_ID;
  if (!apiKey || !secretKey || !sender) return notConfigured;
  const apiUrl = process.env.BEEM_SMS_API_URL || 'https://apisms.beem.africa/v1/send';
  return {
    configured: true,
    send: async (to, { text }) => {
      try {
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${Buffer.from(`${apiKey}:${secretKey}`).toString('base64')}`,
          },
          body: JSON.stringify({
            source_addr: sender, encoding: 0, schedule_time: '', message: text,
            // Beem takes the number without the leading "+".
            recipients: [{ recipient_id: 1, dest_addr: String(to).replace(/^\+/, '') }],
          }),
        });
        const body = await response.json().catch(() => null);
        const accepted = response.ok && body?.successful === true && Number(body?.valid ?? 1) > 0;
        if (!accepted) console.warn('[verification] SMS not accepted:', response.status, body?.code ?? '', body?.message ?? '');
        return accepted ? { ok: true } : { ok: false, error: 'provider_rejected' };
      } catch (err) {
        console.warn('[verification] SMS send failed:', err?.message);
        return { ok: false, error: 'provider_unreachable' };
      }
    },
  };
}

/**
 * Mailgun email (decision of 2 Oct 2026). MAILGUN_API_KEY and MAILGUN_DOMAIN;
 * MAILGUN_API_URL for the EU region (https://api.eu.mailgun.net);
 * VERIFICATION_EMAIL_FROM to change the sender shown.
 */
function mailgunEmail() {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  if (!apiKey || !domain) return notConfigured;
  const apiUrl = (process.env.MAILGUN_API_URL || 'https://api.mailgun.net').replace(/\/+$/, '');
  const from = process.env.VERIFICATION_EMAIL_FROM || `FitFlex <no-reply@${domain}>`;
  return {
    configured: true,
    send: async (to, { subject, text }) => {
      try {
        const response = await fetch(`${apiUrl}/v3/${domain}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`,
          },
          body: new URLSearchParams({ from, to, subject, text }).toString(),
        });
        if (!response.ok) console.warn('[verification] email not accepted:', response.status);
        return response.ok ? { ok: true } : { ok: false, error: 'provider_rejected' };
      } catch (err) {
        console.warn('[verification] email send failed:', err?.message);
        return { ok: false, error: 'provider_unreachable' };
      }
    },
  };
}

export function smsSender() {
  const provider = String(process.env.VERIFICATION_SMS_PROVIDER || '').trim().toLowerCase();
  if (provider === 'beem') return beemSms();
  if (provider === 'fake' && !IS_PROD()) return fake('sms');
  return notConfigured;
}

export function emailSender() {
  const provider = String(process.env.VERIFICATION_EMAIL_PROVIDER || '').trim().toLowerCase();
  if (provider === 'mailgun') return mailgunEmail();
  if (provider === 'fake' && !IS_PROD()) return fake('email');
  return notConfigured;
}
