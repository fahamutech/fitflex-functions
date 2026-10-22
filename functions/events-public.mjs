// Marathon & running events · S2 — public discovery (spec §11, §13, §14.1, §14.2, §14.5).
// GET /events/options never 404s (the flag probe); everything else answers 404 feature_disabled while
// EVENTS_MODULE is off. Drafts, submitted and archived events do not exist to this surface.
// GET /events/options is declared before GET /events/:idOrSlug so it is mounted first.
import '../src/bootstrap/init.mjs';
import { requireAuth, optionalSessionClaims } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsModule, eventsFavouritesOn } from '../src/shared/feature-flags.mjs';
import { eventsDiscoveryService as svc } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

function send(res, result, okStatus = 200) {
  if (result?.error) {
    const { error, status, ...extra } = result;
    return res.status(status || 400).json({ error, ...extra });
  }
  if (okStatus === 204) return res.status(204).end();
  res.status(okStatus).json(result);
}

const favouritesGuard = method => routeGuard(method, [requireEventsModule, (req, res, next) => (eventsFavouritesOn() ? next() : res.status(404).json({ error: 'feature_disabled' })), requireAuth()]);

export const eventsOptions = {
  created, method: 'get', path: '/events/options',
  description: 'Public, no auth: which parts of the events module this server has switched on → { discovery, favourites, registration, currency: "TZS", closingSoonHours, regions: [{ code, name { en, sw } }], timezones[], types[], distances[], prices[], sorts[] }. Answers { discovery: false, … } while EVENTS_MODULE is off (the only events route that never 404s).',
  onRequest: async (_req, res) => res.json(svc.options()),
};

export const eventsList = {
  created, method: 'get', path: '/events',
  description: 'Public (optional auth for isSaved / saved=1): published, registration-closed and in-progress events. ?q&from&to&type[]=road|trail|fun|charity|virtual&distance[]=5k|10k|21k|42k|other&region=<code>&price=free|under_20k|under_50k|any&availability=open&saved=1&sort=soonest|price_low|newest&cursor&limit (≤50) → { items: [EventSummary: id, slug, title, type, status, startsAt, endsAt, timezone, utcOffsetMinutes, timezoneAbbr, registrationOpensAt, registrationClosesAt, availability, venue { name, city, region }, heroThumbUrl, heroImageAlt, distancesM[], fromPriceTzs, currency, organizer { id, name, verified }, isSaved?, updatedAt], nextCursor, total }. availability: open | closing_soon (EVENTS_CLOSING_SOON_HOURS, default 72) | sold_out | closed | not_yet_open | in_progress.',
  onGuard: routeGuard('get', [requireEventsModule]),
  onRequest: async (req, res) => send(res, await svc.list({ query: req.query || {}, userId: optionalSessionClaims(req)?.sub ?? null })),
};

export const eventDetail = {
  created, method: 'get', path: '/events/:idOrSlug',
  description: 'Public (optional auth for isSaved): one event by id or slug → EventDetail (summary + description { en, sw }, heroImageUrl, coverAlt, routeUrl, routeImageUrl, routeImageAlt, venue { address, lat, lng }, accessibility, inclusions, categories [{ id, name, distanceM, startsAt, capacity, availability, remaining (≤10 else null), eligibility, minAge, ticketTypes [{ id, name, priceTzs, currency, saleOpensAt, saleClosesAt, minPerOrder, maxPerOrder, availability }] }], collectionPoints, schedule, sponsors, contact, terms, refundPolicy, cancellation | null, shareUrl, publishedAt, updatedAt, version). Cancelled and completed events stay readable here; drafts, submitted and archived events are 404 event_not_found.',
  onGuard: routeGuard('get', [requireEventsModule]),
  onRequest: async (req, res) => send(res, await svc.detail({ idOrSlug: req.params.idOrSlug, userId: optionalSessionClaims(req)?.sub ?? null })),
};

export const saveEventFavourite = {
  created, method: 'put', path: '/me/event-favourites/:eventId',
  description: 'Signed-in (EVENTS_FAVOURITES on, else 404 feature_disabled): save an event → 204. 404 event_not_found for anything not publicly visible.',
  onGuard: favouritesGuard('put'),
  onRequest: async (req, res) => send(res, await svc.save({ userId: req.user.sub, eventId: req.params.eventId }), 204),
};

export const removeEventFavourite = {
  created, method: 'delete', path: '/me/event-favourites/:eventId',
  description: 'Signed-in (EVENTS_FAVOURITES on): unsave an event → 204. 404 event_not_found.',
  onGuard: favouritesGuard('delete'),
  onRequest: async (req, res) => send(res, await svc.unsave({ userId: req.user.sub, eventId: req.params.eventId }), 204),
};
