// AzamPay — the one place FitFlex talks to it.
// Docs: https://developerdocs.azampay.co.tz (Tanzania API v1).
// Credentials and the environment only ever come from the server's settings
// (AZAMPAY_APP_NAME, AZAMPAY_CLIENT_ID, AZAMPAY_CLIENT_SECRET, AZAMPAY_ENV, …),
// never from code or the database.
//
//   token       POST {auth}/AppRegistration/GenerateToken      {appName, clientId, clientSecret}
//   charge      POST {checkout}/azampay/mno/checkout           {accountNumber, amount, currency, externalId, provider} → USSD push
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
import { createVerify, createHash, publicEncrypt, constants as cryptoConstants } from 'node:crypto';

/** Sandbox hosts, as published in the developer docs. Live hosts are given by AzamPay after KYC approval. */
export const AZAMPAY_SANDBOX_HOSTS = Object.freeze({
  auth: 'https://authenticator-sandbox.azampay.co.tz',
  checkout: 'https://sandbox.azampay.co.tz',
  disburse: 'https://api-disbursement-sandbox.azampay.co.tz',
});

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

/**
 * AzamPay's settings from the environment, or null when a credential is missing.
 *
 * `environment` is 'sandbox' unless AZAMPAY_ENV is exactly 'live': a typo can
 * never send real money. Live needs all three hosts set explicitly
 * (AZAMPAY_AUTH_URL, AZAMPAY_CHECKOUT_URL, AZAMPAY_DISBURSE_URL), as AzamPay
 * gives them after KYC approval; without them the settings fall back to sandbox.
 * In sandbox the hosts may be pointed at a mock, except when NODE_ENV=production.
 */
export function azampaySettings(env = process.env) {
  const appName = first(env, ['AZAMPAY_APP_NAME']);
  const clientId = first(env, ['AZAMPAY_CLIENT_ID']);
  const clientSecret = first(env, ['AZAMPAY_CLIENT_SECRET']);
  if (!appName || !clientId || !clientSecret) return null;
  const hostsFromEnv = {
    auth: first(env, ['AZAMPAY_AUTH_URL']),
    checkout: first(env, ['AZAMPAY_CHECKOUT_URL']),
    disburse: first(env, ['AZAMPAY_DISBURSE_URL']),
  };
  const liveHostsGiven = Boolean(hostsFromEnv.auth && hostsFromEnv.checkout && hostsFromEnv.disburse);
  const wantsLive = first(env, ['AZAMPAY_ENV']).toLowerCase() === 'live';
  const environment = wantsLive && liveHostsGiven ? 'live' : 'sandbox';
  let hosts;
  if (environment === 'live') hosts = hostsFromEnv;
  else if (env.NODE_ENV === 'production') hosts = { ...AZAMPAY_SANDBOX_HOSTS };
  else hosts = {
    auth: hostsFromEnv.auth || AZAMPAY_SANDBOX_HOSTS.auth,
    checkout: hostsFromEnv.checkout || AZAMPAY_SANDBOX_HOSTS.checkout,
    disburse: hostsFromEnv.disburse || AZAMPAY_SANDBOX_HOSTS.disburse,
  };
  const strip = (u) => String(u).replace(/\/+$/, '');
  return {
    appName, clientId, clientSecret,
    // Some AzamPay apps also issue an API key, sent as X-API-Key on checkout calls.
    apiKey: first(env, ['AZAMPAY_API_KEY']) || null,
    environment,
    hosts: { auth: strip(hosts.auth), checkout: strip(hosts.checkout), disburse: strip(hosts.disburse) },
    // Optional extra checks on a callback: AzamPay can be asked to send these.
    callbackUser: first(env, ['AZAMPAY_CALLBACK_USER']) || null,
    callbackPassword: first(env, ['AZAMPAY_CALLBACK_PASSWORD']) || null,
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

/** Whole shillings from an amount like "60000" or "60000.00", or null. */
export function amountToTzs(raw) {
  const n = Number(String(raw ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** The text AzamPay signs on a checkout callback. */
export const callbackSignedText = (p) =>
  `${p?.utilityref ?? ''}${p?.externalreference ?? ''}${p?.transactionstatus ?? ''}${p?.operator ?? ''}`;

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

const KEY_TTL_MS = 24 * 60 * 60_000;

/**
 * A client for one set of settings. `fetchFn` and `now` are injectable for tests.
 * The token is cached until a minute before it expires; AzamPay's public key for
 * 24 hours (fetched again once when a signature does not verify).
 */
export function createAzamPayClient({ settings, fetchFn = globalThis.fetch, now = () => Date.now(), timeoutMs = 15_000 } = {}) {
  let cachedToken = null;
  let cachedKey = null;

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
     * Is this callback really from AzamPay? Checks the RSA signature with AzamPay's
     * public key (fetched again once if it does not verify, in case the key rotated),
     * and, when configured, the user / password / clientId AzamPay sends along.
     */
    async verifyCallback(payload) {
      if (!payload || typeof payload !== 'object') return false;
      if (payload.clientId != null && String(payload.clientId) !== settings.clientId) return false;
      if (settings.callbackUser && String(payload.user ?? '') !== settings.callbackUser) return false;
      if (settings.callbackPassword && String(payload.password ?? '') !== settings.callbackPassword) return false;
      let key;
      try { key = await publicKey(); } catch { return false; }
      if (verifyCallbackSignature(payload, key)) return true;
      try { key = await publicKey(true); } catch { return false; }
      return verifyCallbackSignature(payload, key);
    },

    // ── payouts (disbursement) ────────────────────────────────────────────
    payoutsConfigured: () => Boolean(settings.disbursePublicKey),

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
      const q = new URLSearchParams({ pgReferenceId: String(pgReferenceId), bankName: String(bankName) });
      return authed((t) => call('GET', `${settings.hosts.disburse}/api/v1/azampay/transactionstatus?${q}`, { token: t }));
    },
  };
}
