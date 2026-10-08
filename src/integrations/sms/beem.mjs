// Beem Africa SMS — the one place FitFlex talks to Beem. Verification codes,
// reminders and campaigns all send through this call.
// Docs: https://docs.beem.africa/api-reference/send-sms
// Credentials only ever come from the environment (BEEM_API_KEY,
// BEEM_SECRET_KEY), never from code or the database.

export const BEEM_SEND_URL = 'https://apisms.beem.africa/v1/send';
/** Beem takes up to this many recipients in one request. */
export const BEEM_MAX_RECIPIENTS = 100;

// A value pasted into a server's settings often arrives with spaces, a line
// break or quotes around it; Beem then answers 120 "Invalid Authentication
// Parameters" for a pair that is in fact right.
const clean = (value) => String(value ?? '').trim().replace(/^(["'])(.*)\1$/s, '$2').trim();

/** Beem's settings from the environment, or null when a credential is missing. */
export function beemSettings(env = process.env) {
  const apiKey = clean(env.BEEM_API_KEY);
  const secretKey = clean(env.BEEM_SECRET_KEY);
  if (!apiKey || !secretKey) return null;
  return { apiKey, secretKey, apiUrl: env.BEEM_SMS_API_URL || BEEM_SEND_URL };
}

/**
 * What the stored credentials look like, never what they are: for telling a
 * mis-pasted value from a wrong one. Beem's API key is 16 hex characters and
 * its secret key a long base64 string.
 */
export function beemCredentialShape(env = process.env) {
  const shape = (raw, looksRight) => {
    const value = clean(raw);
    return {
      set: Boolean(value),
      length: value.length,
      // Spaces, line breaks or quotes around the stored value (removed before use).
      hadPadding: String(raw ?? '') !== value,
      spaceInside: /\s/.test(value),
      looksRight: looksRight.test(value),
    };
  };
  return {
    apiKey: shape(env.BEEM_API_KEY, /^[0-9a-f]{16}$/i),
    secretKey: shape(env.BEEM_SECRET_KEY, /^[A-Za-z0-9+/]{40,}={0,2}$/),
  };
}

/**
 * One request to Beem: `text` to every number in `to` (E.164, at most
 * BEEM_MAX_RECIPIENTS) from the sender name `sender`.
 * @returns {Promise<{ ok: true, requestId: string|null }
 *   | { ok: false, error: 'provider_rejected'|'provider_unreachable', retryable: boolean, code?: number, message?: string }>}
 * `code` and `message` are Beem's own (e.g. 120 "Invalid Authentication
 * Parameters"); they never include a credential.
 */
export async function beemSend({ apiKey, secretKey, apiUrl = BEEM_SEND_URL, sender, text, to, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${apiKey}:${secretKey}`).toString('base64')}`,
      },
      body: JSON.stringify({
        source_addr: sender, encoding: 0, schedule_time: '', message: text,
        // Beem takes the number without the leading "+".
        recipients: to.map((n, i) => ({ recipient_id: i + 1, dest_addr: String(n).replace(/^\+/, '') })),
      }),
    });
  } catch (err) {
    return { ok: false, error: 'provider_unreachable', retryable: true, message: String(err?.message || err).slice(0, 200) };
  }
  const body = await response.json().catch(() => null);
  const code = Number(body?.code ?? body?.data?.code);
  const accepted = response.ok && (body?.successful === true || code === 100) && Number(body?.valid ?? 1) > 0;
  if (accepted) return { ok: true, requestId: body?.request_id != null ? String(body.request_id) : null };
  return {
    ok: false, error: 'provider_rejected',
    // Beem being busy or down may pass; a refusal (bad credentials, sender
    // name, number, balance) will not.
    retryable: response.status >= 500 || response.status === 429,
    code: Number.isFinite(code) ? code : response.status,
    message: String(body?.message ?? body?.data?.message ?? response.statusText ?? '').slice(0, 200),
  };
}
