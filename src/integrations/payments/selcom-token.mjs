import { timingSafeEqual } from 'node:crypto';

// Shared-secret check for the Selcom webhook (audit M2). The secret may come in the
// x-selcom-webhook-token header (preferred: headers are not logged with the URL) or,
// for callback URLs already registered with Selcom, as ?token=. With no secret
// configured the route is closed.
function matches(given, expected) {
  if (typeof given !== 'string' || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hasWebhookToken(req, expected = process.env.SELCOM_WEBHOOK_SECRET) {
  if (!expected) return false;
  const header = req.headers?.['x-selcom-webhook-token'];
  const query = req.query?.token;
  return matches(Array.isArray(header) ? header[0] : header, expected) || matches(query, expected);
}

function stripToken(url) {
  return url.replace(/([?&])token=[^&#]*/gi, '$1token=[redacted]');
}

/** Remove the secret from everything a request logger could print. Call right after the check. */
export function redactWebhookToken(req) {
  for (const key of ['originalUrl', 'url']) {
    if (typeof req[key] === 'string') req[key] = stripToken(req[key]);
  }
  if (req.query && 'token' in req.query) req.query.token = '[redacted]';
  if (req.headers && 'x-selcom-webhook-token' in req.headers) req.headers['x-selcom-webhook-token'] = '[redacted]';
}
