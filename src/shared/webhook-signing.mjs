// Marathon & running events · S5 — webhook signing, secret storage and response redaction (spec §7.3, §7.5).
// OWNER REVIEW (D35): secret storage and the signature scheme.
//
//   signature   hex(HMAC_SHA256(secret, timestamp + "." + rawBody)); header `X-FitFlex-Signature: v1=<hex>[,v1=<hex>]`
//               (two values while a rotation grace window is open: new secret first, old second).
//   secret      `whsec_` + 43 base64url characters, shown to the organizer once. HMAC needs the raw key, so it is stored
//               ENCRYPTED: AES-256-GCM under EVENTS_WEBHOOK_SECRET_KEY (32 bytes, base64), with a key id and the
//               endpoint id as additional authenticated data (a ciphertext copied to another endpoint will not open).
//               A database leak alone yields no usable secret. No key (or a malformed one) → the ring is null and the
//               feature is OFF: nothing is signed, decrypted or sent.
import { createHmac, createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_VERSION = 'v1';
export const REPLAY_WINDOW_SECONDS = 300;
const AAD_CONTEXT = 'fitflex.webhook.secret.v1';

export const newWebhookSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;
export const sha256hex = value => createHash('sha256').update(String(value)).digest('hex');
export const last4 = secret => String(secret).slice(-4);

// ── Signing ─────────────────────────────────────────────────────────────────

export const signBody = (secret, timestamp, rawBody) => createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

/** The signature header for one attempt: one value per live secret, the newest first. */
export const signatureHeader = (secrets, timestamp, rawBody) => secrets.filter(Boolean).map(s => `${SIGNATURE_VERSION}=${signBody(s, timestamp, rawBody)}`).join(',');

/** The fixed headers of every delivery (spec §7.3). `timestamp` is unix seconds, recomputed on every attempt. */
export function deliveryHeaders({ eventId, eventType, timestamp, attemptNo, signature }) {
  return {
    'Content-Type': 'application/json', 'User-Agent': 'FitFlex-Webhooks/1', 'X-FitFlex-Event-Id': eventId, 'X-FitFlex-Event-Type': eventType,
    'X-FitFlex-Timestamp': String(timestamp), 'X-FitFlex-Delivery-Attempt': String(attemptNo), 'X-FitFlex-Signature': signature,
  };
}

const safeEqualHex = (a, b) => { const x = Buffer.from(a, 'utf8'); const y = Buffer.from(b, 'utf8'); return x.length === y.length && timingSafeEqual(x, y); };

/**
 * The reference verifier the guide prints (in Node, Python and PHP): verify on the RAW body, in constant time,
 * reject a timestamp more than 5 minutes off, accept if ANY v1 value matches ANY of the secrets.
 * → { ok: true } | { ok: false, reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' }
 */
export function verifySignature({ secrets, headers, rawBody, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = REPLAY_WINDOW_SECONDS }) {
  const get = name => { const k = Object.keys(headers ?? {}).find(h => h.toLowerCase() === name.toLowerCase()); return k ? String(headers[k]) : null; };
  const timestamp = get('X-FitFlex-Timestamp');
  const header = get('X-FitFlex-Signature');
  if (!timestamp || !header || !/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'missing_headers' };
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return { ok: false, reason: 'stale_timestamp' };
  const given = header.split(',').map(p => p.trim()).filter(p => p.startsWith(`${SIGNATURE_VERSION}=`)).map(p => p.slice(SIGNATURE_VERSION.length + 1));
  let match = false;
  for (const secret of secrets) {
    const expected = signBody(secret, timestamp, rawBody);
    for (const g of given) if (safeEqualHex(g, expected)) match = true;   // no early exit: constant work per candidate
  }
  return match ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

// ── Secret storage ──────────────────────────────────────────────────────────

const KEY_ID = /^[A-Za-z0-9_-]{1,16}$/;
const keyOf = b64 => { try { const k = Buffer.from(String(b64 ?? '').trim(), 'base64'); return k.length === 32 ? k : null; } catch { return null; } };

/** { keyId, key, previous: { [keyId]: Buffer } } from the environment, or null when there is no usable key (feature off). */
export function webhookKeyRing(env = process.env) {
  const key = keyOf(env.EVENTS_WEBHOOK_SECRET_KEY);
  if (!key) return null;
  const keyId = String(env.EVENTS_WEBHOOK_SECRET_KEY_ID ?? '').trim() || 'k1';
  if (!KEY_ID.test(keyId)) return null;
  const previous = {};
  const raw = String(env.EVENTS_WEBHOOK_SECRET_KEY_PREVIOUS ?? '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) for (const [id, v] of Object.entries(parsed)) { const k = keyOf(v); if (k && KEY_ID.test(id) && id !== keyId) previous[id] = k; }
    } catch { /* ignored: previous keys are optional */ }
  }
  return { keyId, key, previous };
}

const aad = endpointId => Buffer.from(`${AAD_CONTEXT}|${endpointId}`);

/** → { ciphertext, keyId }; ciphertext is `v1.<iv>.<tag>.<data>` in base64url. */
export function encryptSecret(ring, secret, endpointId) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.key, iv);
  cipher.setAAD(aad(endpointId));
  const data = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return { ciphertext: ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.'), keyId: ring.keyId };
}

/** The secret, or null when the key is gone, the ciphertext was altered or it belongs to another endpoint. */
export function decryptSecret(ring, { ciphertext, keyId }, endpointId) {
  try {
    const key = keyId === ring.keyId ? ring.key : ring.previous[keyId];
    const [v, iv, tag, data] = String(ciphertext).split('.');
    if (!key || v !== 'v1' || !iv || !tag || !data) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(aad(endpointId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch { return null; }
}

// ── Response snippets (spec §7.5) ───────────────────────────────────────────

const REDACTIONS = [
  /whsec_[A-Za-z0-9_-]+/g, /ffs_[A-Za-z0-9_]+/g, /\bBearer\s+\S+/gi, /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, /\+?\d[\d\s().-]{7,}\d/g, /[A-Za-z0-9+/_=-]{24,}/g,
];
const TEXT_TYPES = /^(text\/|application\/(json|xml|problem\+json|x-www-form-urlencoded))/i;

/** A short, safe excerpt of a receiver's answer, or null when it is not text. Never stores more than 200 characters. */
export function redactSnippet(raw, contentType = 'text/plain') {
  if (raw == null || raw === '') return null;
  if (contentType && !TEXT_TYPES.test(String(contentType))) return null;
  // Strip control characters first, then redact on the cleaned text, then cut: a secret cannot slip out by being cut in half.
  let text = String(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const re of REDACTIONS) text = text.replace(re, '[redacted]');
  return text.slice(0, 200) || null;
}
