// Promotion analytics — taking in events from the apps, and showing admins what
// they add up to. Ingest is open to any app session (signed in or not): it
// stores only what passes the checks in src/shared/promotion-events.mjs, and an
// event can only be credited to a promotion that is for the entity it names.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl, bearerFrom, verify } from '../src/auth/jwt.mjs';
import { promotionEventsService, promotionAnalyticsService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

const canView = [requireAuth('admin'), requireAcl('promotion_analytics')];

function send(res, result, okStatus = 200) {
  const { error, status, ...payload } = result;
  if (error) return res.status(status).json({ error, ...payload });
  return res.status(okStatus).json(payload);
}

// Allowances so one device cannot flood the table, and the table cannot be flooded from many addresses at
// once: events per minute and per hour for each caller, and a ceiling for everyone together. In memory per
// server, so with several servers the real allowance is the number of servers times these.
const LIMITS = { perMinute: 1200, perHour: 6000, allCallersPerMinute: 30000 };
const buckets = new Map();
const everyone = { count: 0, resetAt: 0 };
let lastSweep = 0;
function take(bucket, n, windowMs, limit, nowMs) {
  if (bucket.resetAt <= nowMs) { bucket.count = 0; bucket.resetAt = nowMs + windowMs; }
  if (bucket.count + n > limit) return false;
  bucket.count += n;
  return true;
}
function allow(key, n) {
  const nowMs = Date.now();
  const mine = buckets.get(key) || { minute: { count: 0, resetAt: 0 }, hour: { count: 0, resetAt: 0 } };
  buckets.set(key, mine);
  // Check every window before counting in any, so a refused request uses up nothing.
  const probe = (b, windowMs, limit) => (b.resetAt <= nowMs ? n <= limit : b.count + n <= limit);
  if (!probe(mine.minute, 60_000, LIMITS.perMinute) || !probe(mine.hour, 3_600_000, LIMITS.perHour) || !probe(everyone, 60_000, LIMITS.allCallersPerMinute)) return false;
  take(mine.minute, n, 60_000, LIMITS.perMinute, nowMs); take(mine.hour, n, 3_600_000, LIMITS.perHour, nowMs); take(everyone, n, 60_000, LIMITS.allCallersPerMinute, nowMs);
  // Forget callers whose hour is over, at most once a minute, so a flood of made-up keys cannot make every call slow.
  if (buckets.size > 5000 && nowMs - lastSweep > 60_000) {
    lastSweep = nowMs;
    for (const [k, v] of buckets) if (v.hour.resetAt <= nowMs) buckets.delete(k);
  }
  return true;
}
const callerKey = (req, claims) => claims?.sub || String(req.headers?.['x-forwarded-for'] || req.ip || 'anon').split(',')[0].trim();

export const postPromotionEvents = {
  created, method: 'post', path: '/events',
  description: 'Apps: report what customers did with promoted listings, in a batch of up to 50. Body: { source?: "mobile"|"web", events: [{ type: impression|click|detail_view|save|booking_click|subscription_click, entityType, entityId, promotionId, placement?, sessionId, at? }] }. Each event is checked on its own; the answer lists what was kept, what repeated an impression or view already counted, and what was refused and why. Open to signed-in and anonymous sessions.',
  onRequest: async (req, res) => {
    const token = bearerFrom(req);
    const claims = token ? verify(token) : null;
    const events = req.body?.events;
    if (Array.isArray(events) && !allow(callerKey(req, claims), events.length)) return res.status(429).json({ error: 'rate_limited' });
    return send(res, await promotionEventsService.ingest({ events, userId: claims?.sub ?? null, source: req.body?.source ?? 'mobile' }), 202);
  },
};

const rangeOf = req => ({ from: req.query?.from, to: req.query?.to });

export const promotionAnalyticsSummary = {
  created, method: 'get', path: '/admin/promotion-analytics',
  description: 'Admin (promotion_analytics): performance of every promotion that has run in the range (default last 30 days, EAT calendar days; ?from=YYYY-MM-DD&to=YYYY-MM-DD). Filter with ?type=, ?entityType=, ?campaignId=, ?placement=. Counts are of recorded events only; booking and subscription conversions are not tracked yet and are listed in notTracked.',
  onGuard: canView,
  onRequest: async (req, res) => send(res, await promotionAnalyticsService.summary({
    ...rangeOf(req), type: req.query?.type, entityType: req.query?.entityType, campaignId: req.query?.campaignId, placement: req.query?.placement,
  })),
};

export const promotionAnalyticsDetail = {
  created, method: 'get', path: '/admin/promotions/:id/analytics',
  description: 'Admin (promotion_analytics): one promotion\'s totals, funnel, per-placement split and a day-by-day series for the range.',
  onGuard: canView,
  onRequest: async (req, res) => send(res, await promotionAnalyticsService.detail(req.params.id, rangeOf(req))),
};

export const campaignAnalytics = {
  created, method: 'get', path: '/admin/promotion-campaigns/:id/analytics',
  description: 'Admin (promotion_analytics): a campaign\'s promotions together and each on its own, for the range.',
  onGuard: canView,
  onRequest: async (req, res) => send(res, await promotionAnalyticsService.campaign(req.params.id, rangeOf(req))),
};
