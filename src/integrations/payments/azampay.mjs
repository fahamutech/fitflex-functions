// AzamPay — the one place FitFlex talks to it.
// Docs: https://developerdocs.azampay.co.tz (Tanzania API v1).
// Credentials and the environment only ever come from the server's settings
// (AZAMPAY_APP_NAME, AZAMPAY_CLIENT_ID, AZAMPAY_CLIENT_SECRET, AZAMPAY_ENV, …),
// never from code or the database.
//
//   token       POST {auth}/AppRegistration/GenerateToken      {appName, clientId, clientSecret}
//   charge      POST {checkout}/azampay/mno/checkout           {accountNumber, amount, currency, externalId, provider} → USSD push
//   bank        POST {checkout}/azampay/bank/checkout          {amount, currencyCode, merchantAccountNumber, merchantMobileNumber, otp, provider: CRDB|NMB, referenceId}
//   page        POST {checkout}/api/v1/Partner/PostCheckout    {appName, clientId, vendorId, vendorName, language, currency, externalId (30 chars), requestOrigin,
//                                                               redirectFailURL, redirectSuccessURL, amount, cart} → the URL of AzamPay's payment page
//   partners    GET  {checkout}/api/v1/Partner/GetPaymentPartners  (vendorId / vendorName for the page)
//   public key  GET  {checkout}/azampay/v1/public-key?format=Pem   (verifies callback signatures)
//   callback    POST <our url>   signature = RSA-SHA256 (PKCS#1 v1.5), base64, over
//                                {utilityref}{externalreference}{transactionstatus}{operator}
//   disburse    POST {disburse}/api/v1/azampay/disburse        (payouts; checksum needs a key from AzamPay)
//   name lookup POST {disburse}/api/v1/azampay/namelookup
//   payout status GET {disburse}/api/v1/azampay/transactionstatus?pgReferenceId=&bankName=
//
// AzamPay has NO status query for collections: the signed callback is the only
// confirmation of a member's payment. That is why the callback's RSA signature
// is checked against AzamPay's own public key, and its amount, our reference and
// the transaction are all checked again before anything is approved.
import { createVerify, createHash, publicEncrypt, timingSafeEqual, constants as cryptoConstants } from 'node:crypto';

/** Sandbox hosts, as published in the developer docs. Live hosts are given by AzamPay after KYC approval. */
export const AZAMPAY_SANDBOX_HOSTS = Object.freeze({
  auth: 'https://authenticator-sandbox.azampay.co.tz',
  checkout: 'https://sandbox.azampay.co.tz',
  disburse: 'https://api-disbursement-sandbox.azampay.co.tz',
});

/** The banks AzamPay's bank checkout accepts (its `provider` enum). */
export const AZAMPAY_BANKS = Object.freeze(['CRDB', 'NMB']);
/** Bank checkout takes an amount of 0 to 5,000,000 (AzamPay's documented range). */
export const AZAMPAY_BANK_MAX_TZS = 5_000_000;
/** The languages offered for AzamPay's payment page. */
export const AZAMPAY_PAGE_LANGUAGES = Object.freeze(['en', 'sw']);

/** The bank for a bank checkout: CRDB or NMB (any case), else null. */
export const bankFor = (raw) => AZAMPAY_BANKS.find((b) => b === String(raw ?? '').trim().toUpperCase()) ?? null;

/** A bank account number as the payer typed it: 5–30 letters, digits, dashes, slashes or spaces (trimmed), else null. */
export function toBankAccount(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = String(raw).trim();
  return /^[0-9A-Za-z][0-9A-Za-z\-/ ]{4,29}$/.test(value) ? value : null;
}

/**
 * The one-time password the payer's bank gave them, checked for SHAPE only (4–12 letters or digits):
 * it is passed to AzamPay and nowhere else — never stored, logged or audited.
 */
export function toOtp(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = String(raw).trim();
  return /^[0-9A-Za-z]{4,12}$/.test(value) ? value : null;
}

/** The wallets AzamPay's MNO checkout accepts (its `provider` enum). */
export const AZAMPAY_PROVIDERS = Object.freeze(['Airtel', 'Tigo', 'Halopesa', 'Azampesa', 'Mpesa']);

const clean = (value) => String(value ?? '').trim().replace(/^(["'])(.*)\1$/s, '$2').trim();
const first = (env, names) => {
  for (const name of names) {
    const value = clean(env[name]);
    if (value) return value;
  }
  return '';
};

const isHttps = (u) => /^https:\/\/[^\s/]+/i.test(String(u));

/**
 * Why AzamPay cannot be used although its credentials are set, or null. AZAMPAY_ENV=live is a
 * promise that real money is taken: it is never quietly turned into the sandbox (which, with
 * AZAMPAY_SANDBOX_SETTLES on, would activate plans for sandbox money). Live needs the auth and
 * checkout hosts AzamPay gives after KYC approval, each https://; the disbursement host is for
 * payouts only (optional; https:// when given).
 *   'live_hosts_missing' | 'live_hosts_not_https' | null
 */
export function azampayConfigProblem(env = process.env) {
  if (first(env, ['AZAMPAY_ENV']).toLowerCase() !== 'live') return null;
  const auth = first(env, ['AZAMPAY_AUTH_URL']);
  const checkout = first(env, ['AZAMPAY_CHECKOUT_URL']);
  const disburse = first(env, ['AZAMPAY_DISBURSE_URL']);
  if (!auth || !checkout) return 'live_hosts_missing';
  if (!isHttps(auth) || !isHttps(checkout) || (disburse && !isHttps(disburse))) return 'live_hosts_not_https';
  return null;
}

/**
 * AzamPay's settings from the environment, or null when a credential is missing
 * or the live configuration is incomplete (see azampayConfigProblem): fail closed.
 *
 * `environment` is 'sandbox' unless AZAMPAY_ENV is exactly 'live': a typo can
 * never send real money. Live needs AZAMPAY_AUTH_URL and AZAMPAY_CHECKOUT_URL set
 * explicitly (https://), as AzamPay gives them after KYC approval; without them
 * there are NO settings (no client, nothing settles). AZAMPAY_DISBURSE_URL is for
 * payouts only: without it collections work and payouts stay closed.
 * In sandbox the hosts may be pointed at a mock, except when NODE_ENV=production.
 */
export function azampaySettings(env = process.env) {
  const appName = first(env, ['AZAMPAY_APP_NAME']);
  const clientId = first(env, ['AZAMPAY_CLIENT_ID']);
  const clientSecret = first(env, ['AZAMPAY_CLIENT_SECRET']);
  if (!appName || !clientId || !clientSecret) return null;
  if (azampayConfigProblem(env)) return null;
  const hostsFromEnv = {
    auth: first(env, ['AZAMPAY_AUTH_URL']),
    checkout: first(env, ['AZAMPAY_CHECKOUT_URL']),
    disburse: first(env, ['AZAMPAY_DISBURSE_URL']),
  };
  const environment = first(env, ['AZAMPAY_ENV']).toLowerCase() === 'live' ? 'live' : 'sandbox';
  let hosts;
  if (environment === 'live') hosts = hostsFromEnv;
  else if (env.NODE_ENV === 'production') hosts = { ...AZAMPAY_SANDBOX_HOSTS };
  else hosts = {
    auth: hostsFromEnv.auth || AZAMPAY_SANDBOX_HOSTS.auth,
    checkout: hostsFromEnv.checkout || AZAMPAY_SANDBOX_HOSTS.checkout,
    disburse: hostsFromEnv.disburse || AZAMPAY_SANDBOX_HOSTS.disburse,
  };
  const strip = (u) => (u ? String(u).replace(/\/+$/, '') : null);
  return {
    appName, clientId, clientSecret,
    // Some AzamPay apps also issue an API key, sent as X-API-Key on checkout calls.
    apiKey: first(env, ['AZAMPAY_API_KEY']) || null,
    environment,
    hosts: { auth: strip(hosts.auth), checkout: strip(hosts.checkout), disburse: strip(hosts.disburse) },
    // Optional extra checks on a callback: AzamPay can be asked to send these.
    callbackUser: first(env, ['AZAMPAY_CALLBACK_USER']) || null,
    callbackPassword: first(env, ['AZAMPAY_CALLBACK_PASSWORD']) || null,
    // The checkout page: the vendor AzamPay knows this merchant as (GET …/GetPaymentPartners). The page stays closed without both.
    vendorId: first(env, ['AZAMPAY_VENDOR_ID']) || null,
    vendorName: first(env, ['AZAMPAY_VENDOR_NAME']) || null,
    // Payouts: the RSA public key AzamPay gives for the disbursement checksum (PEM). Payouts stay off without it.
    disbursePublicKey: (env.AZAMPAY_DISBURSE_PUBLIC_KEY ? String(env.AZAMPAY_DISBURSE_PUBLIC_KEY).replace(/\\n/g, '\n').trim() : '') || null,
  };
}

/** A Tanzanian number as 255XXXXXXXXX, or null when it is not one. */
export function toMsisdn(raw) {
  let digits = String(raw ?? '').replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (/^0[67]\d{8}$/.test(digits)) digits = `255${digits.slice(1)}`;
  else if (/^[67]\d{8}$/.test(digits)) digits = `255${digits}`;
  return /^255[67]\d{8}$/.test(digits) ? digits : null;
}

/**
 * ASSUMPTION (to confirm before going live): the mobile-money network behind a
 * Tanzanian number, from its prefix (TCRA numbering). Numbers move between
 * networks, so the app may always say which wallet the member pays from
 * (`network`), and that wins. AzamPesa is a wallet, not a number range: it is
 * only used when the member picks it.
 */
const PREFIX_NETWORK = Object.freeze({
  '74': 'Mpesa', '75': 'Mpesa', '76': 'Mpesa',
  '65': 'Tigo', '67': 'Tigo', '71': 'Tigo', '77': 'Tigo',
  '68': 'Airtel', '69': 'Airtel', '78': 'Airtel',
  '61': 'Halopesa', '62': 'Halopesa',
});

/** The AzamPay `provider` for a payment: the member's choice when valid, else from the number, else null. */
export function networkFor(msisdn, chosen = null) {
  if (chosen) {
    const hit = AZAMPAY_PROVIDERS.find((p) => p.toLowerCase() === String(chosen).trim().toLowerCase().replace(/[\s_-]/g, ''));
    if (hit) return hit;
    const aliases = { mpesa: 'Mpesa', 'm-pesa': 'Mpesa', vodacom: 'Mpesa', mixx: 'Tigo', yas: 'Tigo', tigopesa: 'Tigo', airtelmoney: 'Airtel', airtel_money: 'Airtel', halotel: 'Halopesa' };
    const alias = aliases[String(chosen).trim().toLowerCase()];
    if (alias) return alias;
    return null;
  }
  const m = /^255(\d{2})\d{7}$/.exec(String(msisdn ?? ''));
  return m ? (PREFIX_NETWORK[m[1]] ?? null) : null;
}

/**
 * Whole shillings from an amount like "60000" or "60000.00", or null. An amount with
 * cents ("59999.5") is not rounded into the price asked: it is unreadable (null), so held.
 */
export function amountToTzs(raw) {
  const text = String(raw ?? '').replace(/,/g, '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The text AzamPay signs on a checkout callback. */
export const callbackSignedText = (p) =>
  `${p?.utilityref ?? ''}${p?.externalreference ?? ''}${p?.transactionstatus ?? ''}${p?.operator ?? ''}`;

/** Does the callback carry everything a signature check needs (the signature and the signed fields we require)? */
export const callbackIsSigned = (payload) => Boolean(payload && typeof payload === 'object'
  && typeof payload.signature === 'string' && payload.signature.trim() && payload.utilityref && payload.transactionstatus);

/** Equal strings, compared in constant time (callback user / password). */
function sameSecret(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Is `signatureB64` AzamPay's RSA-SHA256 (PKCS#1 v1.5) signature of this callback under `publicKeyPem`? */
export function verifyCallbackSignature(payload, publicKeyPem) {
  if (!payload || typeof payload !== 'object' || !publicKeyPem) return false;
  const signature = typeof payload.signature === 'string' ? payload.signature.trim() : '';
  if (!signature || !payload.utilityref || !payload.transactionstatus) return false;
  try {
    const v = createVerify('SHA256');
    v.update(callbackSignedText(payload), 'utf8');
    v.end();
    return v.verify(publicKeyPem, signature, 'base64');
  } catch {
    return false;
  }
}

/**
 * What a checkout callback says, in the mobile-money service's terms.
 * referenceId is OUR reference (sent as externalId; AzamPay returns it as utilityref).
 * transactionIds are every id AzamPay may use for the transaction: the service
 * matches whichever one the request recorded when the prompt went out.
 * Fields the service keeps are allowlisted (never the password, user or signature).
 */
export function parseCallback(payload) {
  const ids = [payload?.transid, payload?.reference, payload?.externalreference]
    .filter((v) => v != null && String(v).trim() !== '').map((v) => String(v).trim());
  const raw = {
    transactionstatus: payload?.transactionstatus ?? null,
    operator: payload?.operator ?? null,
    reference: payload?.reference ?? null,
    externalreference: payload?.externalreference ?? null,
    utilityref: payload?.utilityref ?? null,
    amount: payload?.amount ?? null,
    transid: payload?.transid ?? null,
    mnoreference: payload?.mnoreference ?? null,
    message: payload?.message ?? null,
  };
  const status = String(payload?.transactionstatus ?? '').trim().toLowerCase();
  return {
    referenceId: payload?.utilityref ? String(payload.utilityref).trim() : null,
    transactionId: ids[0] ?? null,
    transactionIds: [...new Set(ids)],
    confirmed: {
      status: status === 'success' ? 'COMPLETED' : status === 'failure' || status === 'failed' ? 'FAILED' : 'UNKNOWN',
      amountTzs: amountToTzs(payload?.amount),
      remark: payload?.message ? String(payload.message).slice(0, 200) : null,
      raw,
    },
  };
}

/**
 * Disbursement checksum: Base64(RSA(SHA512(text))), PKCS#1 padding, under the key
 * AzamPay gives. ASSUMPTION (to confirm with AzamPay): SHA-512 as lowercase hex
 * is what is encrypted. Which fields make up `text` AzamPay tells merchants
 * privately, so the caller passes the text.
 */
export function disburseChecksum(text, publicKeyPem) {
  const digest = createHash('sha512').update(String(text), 'utf8').digest('hex');
  return publicEncrypt({ key: publicKeyPem, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(digest, 'utf8')).toString('base64');
}

/**
 * Did the request possibly reach AzamPay? A timeout, a dropped connection or a
 * 5xx can come after AzamPay already put a prompt on the phone; a 4xx or a
 * refused token cannot have.
 */
export const maybeSent = (err) =>
  err?.code === 'unreachable' || (err?.code === 'provider_error' && Number(err?.status) >= 500);

export class AzamPayError extends Error {
  constructor(message, { status = 502, body = null, code = 'provider_error' } = {}) {
    super(message);
    this.name = 'AzamPayError';
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

/**
 * The payment page's address from PostCheckout's answer: a bare string, JSON-quoted or not (some gateways wrap it
 * as { data | url }). Only an absolute http(s) URL is accepted — https only outside the sandbox — so nothing else
 * (a script address, a relative path) is ever handed to a client to open.
 */
export function pageUrlOf(text, environment = 'live') {
  let value = typeof text === 'string' ? text.trim() : '';
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'string') value = parsed.trim();
    else if (parsed && typeof parsed === 'object') value = String(parsed.data ?? parsed.url ?? '').trim();
  } catch { /* plain text */ }
  if (!value || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && environment !== 'live')) return url.toString();
  } catch { /* not a URL */ }
  return null;
}

const KEY_TTL_MS = 24 * 60 * 60_000;
/** A signature that does not verify makes us fetch AzamPay's key again (it may have rotated) at most this often. */
export const KEY_REFETCH_MIN_MS = 5 * 60_000;

/**
 * A client for one set of settings. `fetchFn` and `now` are injectable for tests.
 * The token is cached until a minute before it expires; AzamPay's public key for
 * 24 hours (fetched again once when a signature does not verify).
 */
export function createAzamPayClient({ settings, fetchFn = globalThis.fetch, now = () => Date.now(), timeoutMs = 15_000 } = {}) {
  let cachedToken = null;
  let cachedKey = null;
  let lastForcedKeyAt = null;

  async function call(method, url, { body, token, apiKey = false } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (apiKey && settings.apiKey) headers['X-API-Key'] = settings.apiKey;
    let res;
    try {
      res = await fetchFn(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new AzamPayError(`AzamPay unreachable: ${err?.message || err}`, { code: 'unreachable' });
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
    if (!res.ok) {
      throw new AzamPayError(`AzamPay answered ${res.status}`, { status: res.status, body: json, code: res.status === 401 ? 'unauthorised' : 'provider_error' });
    }
    return json ?? {};
  }

  /** As `call`, for an endpoint that answers a bare string (JSON-quoted or plain text): resolves with that string. */
  async function callText(method, url, { body, token, apiKey = false } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/plain' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (apiKey && settings.apiKey) headers['X-API-Key'] = settings.apiKey;
    let res;
    try {
      res = await fetchFn(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new AzamPayError(`AzamPay unreachable: ${err?.message || err}`, { code: 'unreachable' });
    }
    const text = await res.text();
    if (!res.ok) {
      throw new AzamPayError(`AzamPay answered ${res.status}`, { status: res.status, code: res.status === 401 ? 'unauthorised' : 'provider_error' });
    }
    return text;
  }

  async function token(force = false) {
    if (!force && cachedToken && cachedToken.expiresAt > now() + 60_000) return cachedToken.value;
    const out = await call('POST', `${settings.hosts.auth}/AppRegistration/GenerateToken`, {
      body: { appName: settings.appName, clientId: settings.clientId, clientSecret: settings.clientSecret },
    });
    const value = out?.data?.accessToken;
    if (!value || typeof value !== 'string') throw new AzamPayError('AzamPay gave no access token', { code: 'no_token' });
    const expires = Date.parse(out?.data?.expire);
    // Without a readable expiry, refresh well inside an hour.
    cachedToken = { value, expiresAt: Number.isFinite(expires) ? expires : now() + 50 * 60_000 };
    return cachedToken.value;
  }

  /** Run with a token, getting a fresh one once if the cached one was refused. */
  async function authed(fn) {
    try {
      return await fn(await token());
    } catch (err) {
      if (err instanceof AzamPayError && err.code === 'unauthorised') return fn(await token(true));
      throw err;
    }
  }

  async function publicKey(force = false) {
    if (!force && cachedKey && cachedKey.expiresAt > now()) return cachedKey.value;
    const out = await authed((t) => call('GET', `${settings.hosts.checkout}/azampay/v1/public-key?format=Pem`, { token: t, apiKey: true }));
    const value = typeof out?.publicKey === 'string' ? out.publicKey.trim() : '';
    if (!out?.success || !value.includes('BEGIN PUBLIC KEY')) throw new AzamPayError('AzamPay gave no public key', { code: 'no_public_key' });
    cachedKey = { value, expiresAt: now() + KEY_TTL_MS };
    return value;
  }

  function disburseKey() {
    if (!settings.hosts.disburse) throw new AzamPayError('Payouts need AZAMPAY_DISBURSE_URL', { code: 'payouts_not_configured', status: 503 });
    if (!settings.disbursePublicKey) throw new AzamPayError('Payouts need AZAMPAY_DISBURSE_PUBLIC_KEY', { code: 'payouts_not_configured', status: 503 });
    return settings.disbursePublicKey;
  }

  return {
    provider: 'azampay',
    environment: settings.environment,
    // No status query for collections: the signed callback confirms a payment.
    confirmsByCallback: true,
    parseCallback,

    /** Ask the customer's phone to approve `amountTzs`. Resolves with AzamPay's transaction id. */
    async initiatePayment({ msisdn, amountTzs, reference, network = null }) {
      const provider = networkFor(msisdn, network);
      if (!provider) throw new AzamPayError('Unknown mobile-money network for this number', { code: 'unknown_network', status: 400 });
      const out = await authed((t) => call('POST', `${settings.hosts.checkout}/azampay/mno/checkout`, {
        token: t, apiKey: true,
        body: { accountNumber: msisdn, amount: String(Math.round(amountTzs)), currency: 'TZS', externalId: reference, provider },
      }));
      const transactionId = out?.transactionId ? String(out.transactionId) : null;
      if (out?.success === false || !transactionId) {
        throw new AzamPayError(out?.message || 'AzamPay did not accept the payment', { body: out, code: 'rejected', status: 422 });
      }
      return { transactionId, network: provider };
    },

    /**
     * Bank checkout (CRDB | NMB): the payer gives the account, the mobile number registered with the bank and the
     * one-time password their bank gave them. Resolves with AzamPay's transaction id. The OTP goes into the request
     * body and nowhere else: errors carry AzamPay's ANSWER, never what was sent.
     */
    async initiateBankPayment({ bank, accountNumber, msisdn, otp, amountTzs, reference }) {
      const provider = bankFor(bank);
      if (!provider) throw new AzamPayError('Unknown bank', { code: 'unknown_bank', status: 400 });
      const out = await authed((t) => call('POST', `${settings.hosts.checkout}/azampay/bank/checkout`, {
        token: t, apiKey: true,
        body: { amount: Math.round(amountTzs), currencyCode: 'TZS', merchantAccountNumber: accountNumber, merchantMobileNumber: msisdn, merchantName: null, otp, provider, referenceId: reference },
      }));
      const transactionId = out?.transactionId ? String(out.transactionId) : null;
      if (out?.success === false || !transactionId) {
        throw new AzamPayError(out?.message || 'AzamPay did not accept the payment', { body: out, code: 'rejected', status: 422 });
      }
      return { transactionId, bank: provider };
    },

    /** Can AzamPay's payment page be opened (the vendor it needs is configured)? */
    pageConfigured: () => Boolean(settings.vendorId && settings.vendorName),

    /**
     * AzamPay's hosted payment page for `amountTzs`. `externalId` is ours (exactly 30 characters); the redirect
     * URLs are built by the caller from the server's own configuration. Resolves with the page's URL, which must
     * be an absolute http(s) address (https outside the sandbox) or the answer is refused.
     */
    async createCheckoutPage({ amountTzs, externalId, language = 'en', itemName, requestOrigin, redirectSuccessUrl, redirectFailUrl }) {
      if (!settings.vendorId || !settings.vendorName) throw new AzamPayError('The checkout page needs AZAMPAY_VENDOR_ID and AZAMPAY_VENDOR_NAME', { code: 'page_not_configured', status: 503 });
      if (typeof externalId !== 'string' || externalId.length !== 30) throw new AzamPayError('externalId must be exactly 30 characters', { code: 'invalid_reference', status: 400 });
      const res = await authed((t) => callText('POST', `${settings.hosts.checkout}/api/v1/Partner/PostCheckout`, {
        token: t, apiKey: true,
        body: {
          appName: settings.appName, clientId: settings.clientId, vendorId: settings.vendorId, vendorName: settings.vendorName,
          language, currency: 'TZS', externalId, requestOrigin, redirectFailURL: redirectFailUrl, redirectSuccessURL: redirectSuccessUrl,
          amount: String(Math.round(amountTzs)), cart: { items: [{ name: String(itemName || 'FitFlex').slice(0, 100) }] },
        },
      }));
      const url = pageUrlOf(res, settings.environment);
      if (!url) throw new AzamPayError('AzamPay gave no payment page', { code: 'rejected', status: 422 });
      return { url };
    },

    /** The payment partners of this app (where the page's vendorId / vendorName come from). */
    async paymentPartners() {
      const out = await authed((t) => call('GET', `${settings.hosts.checkout}/api/v1/Partner/GetPaymentPartners`, { token: t, apiKey: true }));
      return (Array.isArray(out) ? out : []).map((p) => ({
        partnerName: p?.partnerName ?? null, provider: p?.provider ?? null, vendorName: p?.vendorName ?? null,
        paymentVendorId: p?.paymentVendorId ?? null, paymentPartnerId: p?.paymentPartnerId ?? null, currency: p?.currency ?? null,
      }));
    },

    /**
     * Is this callback really from AzamPay? `clientId` must be present and ours, the
     * user / password must match when configured (constant time), and the RSA signature
     * must verify with AzamPay's public key. When it does not verify the key is fetched
     * again in case it rotated — but only for a body that carries a signature and the
     * signed fields, and at most once every KEY_REFETCH_MIN_MS, so junk posted to the
     * route cannot make this server call AzamPay at will.
     */
    async verifyCallback(payload) {
      if (!payload || typeof payload !== 'object') return false;
      if (typeof payload.clientId !== 'string' || payload.clientId !== settings.clientId) return false;
      if (settings.callbackUser && !sameSecret(payload.user, settings.callbackUser)) return false;
      if (settings.callbackPassword && !sameSecret(payload.password, settings.callbackPassword)) return false;
      if (!callbackIsSigned(payload)) return false;
      let key;
      try { key = await publicKey(); } catch { return false; }
      if (verifyCallbackSignature(payload, key)) return true;
      if (lastForcedKeyAt !== null && now() - lastForcedKeyAt < KEY_REFETCH_MIN_MS) return false;
      lastForcedKeyAt = now();
      try { key = await publicKey(true); } catch { return false; }
      return verifyCallbackSignature(payload, key);
    },

    // ── payouts (disbursement) ────────────────────────────────────────────
    payoutsConfigured: () => Boolean(settings.disbursePublicKey && settings.hosts.disburse),

    /** The name on a wallet or bank account, before paying it. */
    async nameLookup({ bankName, accountNumber, checksumText }) {
      const checksum = disburseChecksum(checksumText, disburseKey());
      return authed((t) => call('POST', `${settings.hosts.disburse}/api/v1/azampay/namelookup`, { token: t, body: { bankName, accountNumber, checksum } }));
    },

    /**
     * Send money to a partner's wallet. `externalReferenceId` (≤ 30 chars) is ours and
     * must be unique per payout; AzamPay answers with pgReferenceId and calls back later.
     */
    async disburse({ source, destination, amountTzs, externalReferenceId, remarks = null, checksumText }) {
      if (!externalReferenceId || String(externalReferenceId).length > 30) throw new AzamPayError('externalReferenceId must be 1–30 characters', { code: 'invalid_reference', status: 400 });
      const checksum = disburseChecksum(checksumText, disburseKey());
      const out = await authed((t) => call('POST', `${settings.hosts.disburse}/api/v1/azampay/disburse`, {
        token: t,
        body: {
          source, destination,
          transferDetails: { type: 'disbursement', amount: Math.round(amountTzs), dateInEpoch: Math.floor(now() / 1000) },
          externalReferenceId: String(externalReferenceId), checksum, remarks,
        },
      }));
      if (out?.success === false || !out?.pgReferenceId) throw new AzamPayError(out?.message || 'AzamPay did not accept the payout', { body: out, code: 'rejected', status: 422 });
      return { pgReferenceId: String(out.pgReferenceId), message: out.message ?? null };
    },

    /** A payout's state, by AzamPay's reference and the network used. */
    async payoutStatus({ pgReferenceId, bankName }) {
      if (!settings.hosts.disburse) throw new AzamPayError('Payouts need AZAMPAY_DISBURSE_URL', { code: 'payouts_not_configured', status: 503 });
      const q = new URLSearchParams({ pgReferenceId: String(pgReferenceId), bankName: String(bankName) });
      return authed((t) => call('GET', `${settings.hosts.disburse}/api/v1/azampay/transactionstatus?${q}`, { token: t }));
    },
  };
}
