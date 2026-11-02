import { timingSafeEqual } from 'node:crypto';
import { selcomWebhookQueryTokenOff } from '../../shared/feature-flags.mjs';

// Shared-secret check for the Selcom webhook (audit M2). The secret may come in the
// x-selcom-webhook-token header (preferred) or, for callback URLs already registered
// with Selcom, as ?token= (rejected when SELCOM_WEBHOOK_QUERY_TOKEN_OFF is on).
// An empty token, an empty/unset secret, or a non-string value never matches: with no
// secret configured the route is closed.
function matches(given, expected) {
  if (typeof given !== 'string' || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hasWebhookToken(req, expected = process.env.SELCOM_WEBHOOK_SECRET) {
  if (!expected) return false;
  const header = req.headers?.['x-selcom-webhook-token'];
  if (matches(Array.isArray(header) ? header[0] : header, expected)) return true;
  if (selcomWebhookQueryTokenOff()) return false;
  return matches(req.query?.token, expected);
}

const HEADER = 'x-selcom-webhook-token';
const stripToken = url => url.replace(/(^|[?&])token=[^&#]*/gi, '$1token=[redacted]');
const redactedCopy = obj => {
  const copy = { ...obj };
  if ('token' in copy) copy.token = '[redacted]';
  return copy;
};
function setOwn(req, key, value) {
  // Express 5 defines req.query as a prototype getter; assignment would silently fail.
  Object.defineProperty(req, key, { value, writable: true, configurable: true, enumerable: true });
}

/**
 * Scrub the secret from everything a logger running AFTER this call can read:
 * url/originalUrl, query, headers, rawHeaders and parseurl's cached parse. It cannot
 * affect loggers that already ran or captured the request before the handler started.
 */
export function redactWebhookToken(req) {
  for (const key of ['originalUrl', 'url']) {
    if (typeof req[key] === 'string') setOwn(req, key, stripToken(req[key]));
  }
  for (const key of ['_parsedUrl', '_parsedOriginalUrl']) {
    const parsed = req[key];
    if (parsed && typeof parsed === 'object') {
      const clean = { ...parsed };
      for (const f of Object.keys(clean)) if (typeof clean[f] === 'string') clean[f] = stripToken(clean[f]);
      setOwn(req, key, clean);
    }
  }
  let query;
  try { query = req.query; } catch { query = null; }
  if (query && typeof query === 'object' && 'token' in query) setOwn(req, 'query', redactedCopy(query));
  if (req.headers && HEADER in req.headers) {
    const headers = { ...req.headers, [HEADER]: '[redacted]' };
    setOwn(req, 'headers', headers);
  }
  if (Array.isArray(req.rawHeaders)) {
    const raw = [...req.rawHeaders];
    for (let i = 0; i < raw.length; i += 2) if (String(raw[i]).toLowerCase() === HEADER) raw[i + 1] = '[redacted]';
    setOwn(req, 'rawHeaders', raw);
  }
}
