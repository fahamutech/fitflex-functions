// Identity V2 · I6a — how a FitFlex verification code reaches a person.
//
// Nothing is sent unless a provider is named in the environment; a deploy on
// its own never starts sending (or paying for) messages.
//   VERIFICATION_SMS_PROVIDER    'africastalking' | 'fake' (never in production)
//   VERIFICATION_EMAIL_PROVIDER  'fake' (never in production); a real email
//                                provider is added once one is chosen
// Credentials come from the environment only.

const IS_PROD = () => process.env.NODE_ENV === 'production';

/** What the 'fake' providers "sent", for tests and local development. */
export const fakeOutbox = [];

const fake = channel => ({
  configured: true,
  send: async (to, message) => { fakeOutbox.push({ channel, to, ...message }); return { ok: true }; },
});
const notConfigured = { configured: false, send: async () => ({ ok: false, error: 'not_configured' }) };

/** Africa's Talking bulk SMS. Sender ID is optional (their shared short code otherwise). */
function africasTalkingSms() {
  const apiKey = process.env.AFRICAS_TALKING_API_KEY;
  const username = process.env.AFRICAS_TALKING_USERNAME;
  if (!apiKey || !username) return notConfigured;
  const apiUrl = process.env.AFRICAS_TALKING_API_URL || 'https://api.africastalking.com';
  const from = process.env.VERIFICATION_SMS_SENDER_ID;
  return {
    configured: true,
    send: async (to, { text }) => {
      try {
        const response = await fetch(`${apiUrl}/version1/messaging`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', apiKey },
          body: new URLSearchParams({ username, to, message: text, ...(from ? { from } : {}) }).toString(),
        });
        const body = await response.json().catch(() => null);
        const recipient = body?.SMSMessageData?.Recipients?.[0];
        // 100 Processed, 101 Sent, 102 Queued.
        const accepted = response.ok && recipient && [100, 101, 102].includes(Number(recipient.statusCode));
        if (!accepted) console.warn('[verification] SMS not accepted:', response.status, recipient?.status || body?.SMSMessageData?.Message || '');
        return accepted ? { ok: true } : { ok: false, error: 'provider_rejected' };
      } catch (err) {
        console.warn('[verification] SMS send failed:', err?.message);
        return { ok: false, error: 'provider_unreachable' };
      }
    },
  };
}

export function smsSender() {
  const provider = String(process.env.VERIFICATION_SMS_PROVIDER || '').trim().toLowerCase();
  if (provider === 'africastalking') return africasTalkingSms();
  if (provider === 'fake' && !IS_PROD()) return fake('sms');
  return notConfigured;
}

export function emailSender() {
  const provider = String(process.env.VERIFICATION_EMAIL_PROVIDER || '').trim().toLowerCase();
  if (provider === 'fake' && !IS_PROD()) return fake('email');
  return notConfigured;
}
