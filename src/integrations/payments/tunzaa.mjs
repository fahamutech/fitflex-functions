// Malipo by Tunzaa — the one place FitFlex talks to it.
// Docs: https://malipo.tunzaa.co.tz/docs/
// Credentials and the environment only ever come from the server's settings
// (TUNZAA_API_KEY, TUNZAA_SECRET_KEY, TUNZAA_ENV), never from code or the database.
//
//   token     POST /accounts/request/token   {api_key, secret_key} → Bearer, 1 hour
//   charge    POST /payments/initiate-payment {customer_msisdn, amount, reference} → USSD push
//   status    GET  /payments/check-status/:transactionID
//   callback  POST <our url>  X-Signature = HMAC-SHA256 hex of the JSON (keys sorted), secret key
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TUNZAA_BASE_URL = 'https://pay.tunzaa.co.tz';

const clean = (value) => String(value ?? '').trim().replace(/^(["'])(.*)\1$/s, '$2').trim();

/**
 * Tunzaa's settings from the environment, or null when a credential is missing.
 * `environment` is 'sandbox' unless TUNZAA_ENV is exactly 'live': a typo can
 * never send real money.
 */
export function tunzaaSettings(env = process.env) {
  const apiKey = clean(env.TUNZAA_API_KEY);
  const secretKey = clean(env.TUNZAA_SECRET_KEY);
  if (!apiKey || !secretKey) return null;
  const environment = clean(env.TUNZAA_ENV).toLowerCase() === 'live' ? 'live' : 'sandbox';
  // The host is fixed in production: pointing it elsewhere would let a mock "confirm" payments.
  const override = env.NODE_ENV === 'production' ? '' : clean(env.TUNZAA_BASE_URL);
  return { apiKey, secretKey, environment, baseUrl: override || TUNZAA_BASE_URL };
}

/** A Tanzanian number as 255XXXXXXXXX (what Tunzaa wants), or null when it is not one. */
export function toMsisdn(raw) {
  let digits = String(raw ?? '').replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (/^0[67]\d{8}$/.test(digits)) digits = `255${digits.slice(1)}`;
  else if (/^[67]\d{8}$/.test(digits)) digits = `255${digits}`;
  return /^255[67]\d{8}$/.test(digits) ? digits : null;
}

/** The same JSON with object keys sorted at every level. */
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

/**
 * Is `signature` the HMAC of this payload under the secret key? The docs say
 * "JSON payload with alphabetically sorted keys" without fixing the
 * separators, so both common renderings are accepted (compact, and
 * `", "` / `": "` as Python writes it). Compared in constant time.
 */
export function verifySignature(payload, signature, secretKey) {
  if (!payload || typeof payload !== 'object' || typeof signature !== 'string' || !secretKey) return false;
  const given = Buffer.from(signature.trim().toLowerCase());
  const sorted = sortKeys(payload);
  const compact = JSON.stringify(sorted);
  const spaced = compact.replace(/"(?:[^"\\]|\\.)*"|[,:]/g, (m) => (m === ',' ? ', ' : m === ':' ? ': ' : m));
  return [compact, spaced].some((body) => {
    const expected = Buffer.from(createHmac('sha256', secretKey).update(body).digest('hex'));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

/** Whole shillings from Tunzaa's "1500.00" style amount, or null. */
export function amountToTzs(raw) {
  const n = Number(String(raw ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Did the request possibly reach Tunzaa? A timeout, a dropped connection or a
 * 5xx can come after Tunzaa already put a prompt on the phone; a 4xx or a
 * refused token cannot have.
 */
export const maybeSent = (err) =>
  err?.code === 'unreachable' || (err?.code === 'provider_error' && Number(err?.status) >= 500);

export class TunzaaError extends Error {
  constructor(message, { status = 502, body = null, code = 'provider_error' } = {}) {
    super(message);
    this.name = 'TunzaaError';
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

/**
 * A client for one set of settings. `fetchFn` and `now` are injectable for tests.
 * The Bearer token is cached until a minute before it expires.
 */
export function createTunzaaClient({ settings, fetchFn = globalThis.fetch, now = () => Date.now(), timeoutMs = 15_000 } = {}) {
  let cached = null;

  async function call(method, path, { body, token, scenario } = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-Environment': settings.environment };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (scenario && settings.environment === 'sandbox') headers['X-Sandbox-Scenario'] = scenario;
    let res;
    try {
      res = await fetchFn(`${settings.baseUrl}${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new TunzaaError(`Tunzaa unreachable: ${err?.message || err}`, { code: 'unreachable' });
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
    if (!res.ok) {
      throw new TunzaaError(`Tunzaa answered ${res.status}`, { status: res.status, body: json, code: res.status === 401 ? 'unauthorised' : 'provider_error' });
    }
    return json ?? {};
  }

  async function token(force = false) {
    if (!force && cached && cached.expiresAt > now() + 60_000) return cached.value;
    const out = await call('POST', '/accounts/request/token', { body: { api_key: settings.apiKey, secret_key: settings.secretKey } });
    if (!out.access_token) throw new TunzaaError('Tunzaa gave no access token', { body: null, code: 'no_token' });
    cached = { value: out.access_token, expiresAt: now() + (Number(out.expires_in) || 3600) * 1000 };
    return cached.value;
  }

  /** Run with a token, getting a fresh one once if the cached one was refused. */
  async function authed(fn) {
    try {
      return await fn(await token());
    } catch (err) {
      if (err instanceof TunzaaError && err.code === 'unauthorised') return fn(await token(true));
      throw err;
    }
  }

  return {
    environment: settings.environment,

    /** Ask the customer's phone to approve `amountTzs`. Resolves with the transaction id. */
    async initiatePayment({ msisdn, amountTzs, reference, scenario }) {
      const out = await authed((t) => call('POST', '/payments/initiate-payment', {
        token: t, scenario,
        body: { customer_msisdn: msisdn, amount: String(Math.round(amountTzs)), reference },
      }));
      const transactionId = out.transactionID || out.transaction_id || null;
      if (out.success === false || !transactionId) {
        throw new TunzaaError(out.message || 'Tunzaa did not accept the payment', { body: out, code: 'rejected', status: 422 });
      }
      return { transactionId };
    },

    /** The transaction's final state: { status: 'COMPLETED'|'FAILED'|'PENDING'|…, amountTzs, raw }. */
    async checkStatus(transactionId) {
      const out = await authed((t) => call('GET', `/payments/check-status/${encodeURIComponent(transactionId)}`, { token: t }));
      const data = out.data || out;
      return {
        status: String(data.status || '').toUpperCase() || 'UNKNOWN',
        amountTzs: amountToTzs(data.amount),
        transactionId: data.transactionID || transactionId,
        remark: data.remark || null,
        raw: data,
      };
    },
  };
}
