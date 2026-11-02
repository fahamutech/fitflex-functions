// Marathon & running events · S7 — client analytics ingestion (spec §5.1, §5.2, §5.7). Answers 404 feature_disabled unless
// EVENTS_MODULE, EVENTS_REGISTRATION and EVENTS_ANALYTICS are on. The member token is used to refuse anonymous spam and to
// rate limit, then discarded: nothing about the caller is stored. Request bodies are never logged by this file.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsAnalytics } from '../src/shared/feature-flags.mjs';
import { eventsAnalyticsService as svc } from '../src/bootstrap/services.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';

const created = new Date().toISOString();
const requestLimiter = createVendorLimiter({ perMinute: 60 });
const eventLimiter = createVendorLimiter({ perMinute: 200 });
/** For specs: clear both windows. */
export const resetEventsAnalyticsLimits = () => { requestLimiter.reset(); eventLimiter.reset(); };
const MAX_BODY_BYTES = 4096;

export const postEventsAnalytics = {
  created, method: 'post', path: '/events/analytics',
  description: 'Member (EVENTS_ANALYTICS on): a batch of app analytics counters. Body { events: [{ name, props }] } (≤ 20 events, each props ≤ 8 keys, body ≤ 4 KB). Names and dimension keys outside the allowlist are dropped; dimension values outside a closed set are stored as "other"; counts are bucketed; ids, amounts, names and free text never reach a counter. Nothing about the caller is stored. → 202 { accepted, dropped }. 413 payload_too_large | too_many_events; 400 invalid_batch; 429 rate_limited (60 requests and 200 events a minute per member); 404 feature_disabled.',
  onGuard: routeGuard('post', [requireEventsAnalytics, requireAuth('member')]),
  onRequest: async (req, res) => {
    res.set?.('Cache-Control', 'no-store');
    const body = req.body || {};
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) return res.status(413).json({ error: 'payload_too_large', maxBytes: MAX_BODY_BYTES });
    if (limitOrNull(requestLimiter, `a:${req.user.sub}`, res)) return undefined;
    const count = Array.isArray(body.events) ? Math.min(body.events.length, 200) : 1;
    for (let i = 0; i < count; i += 1) if (limitOrNull(eventLimiter, `e:${req.user.sub}`, res)) return undefined;
    const out = await svc.ingest({ events: body.events });
    if (out.error) return res.status(out.status || 400).json({ error: out.error, ...(out.max ? { max: out.max } : {}) });
    const { status, ...rest } = out;
    return res.status(status).json(rest);
  },
};
