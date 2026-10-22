// Marathon & running events · S2 — member discovery (spec §11, §13, §14.1, §14.2, §14.5, §16).
//
//   options()        GET /events/options — the only events route that answers while EVENTS_MODULE is off
//   list(query)      GET /events — filters, sort, keyset-free opaque cursor, computed availability / prices
//   detail(idOrSlug) GET /events/:idOrSlug — public statuses only; drafts and unpublished never exist here
//   save / unsave    PUT / DELETE /me/event-favourites/:eventId (EVENTS_FAVOURITES)
// `shareUrl` is built from the same host as friend-invite links (FRIEND_INVITE_BASE_URL / APP_DOWNLOAD_LINK).
import {
  summaryView, detailView, distanceBucket, PUBLIC_STATUSES, EVENT_TYPES, DISTANCE_BUCKETS, PRICE_BUCKETS, SORTS, REGIONS, REGION_CODES, TIMEZONES,
  DEFAULT_CLOSING_SOON_HOURS,
} from '../shared/events-document.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const CANDIDATE_CAP = 500;
const toList = v => (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : []).map(s => String(s).trim()).filter(Boolean);
const toDate = v => { if (!v) return null; const d = new Date(v); return Number.isNaN(+d) ? null : d; };
/** Day boundaries are read in East Africa Time (UTC+3, no DST): a date-only `from`/`to` means the whole Dar day. */
export const DAY_TZ_OFFSET_MS = 3 * 3_600_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * `from` / `to` as the apps send them: a full ISO instant is used as is; a date-only value (YYYY-MM-DD,
 * what mobile sends) is the start (from) or the end, 23:59:59.999 (to), of that day in Africa/Dar_es_Salaam.
 */
export function parseDayBound(value, edge) {
  if (typeof value !== 'string' || !DATE_ONLY.test(value.trim())) return toDate(value);
  const midnightUtc = Date.parse(`${value.trim()}T00:00:00.000Z`);
  if (Number.isNaN(midnightUtc)) return null;
  const startOfDay = midnightUtc - DAY_TZ_OFFSET_MS;
  return new Date(edge === 'end' ? startOfDay + 86_400_000 - 1 : startOfDay);
}
const encodeCursor = offset => Buffer.from(String(offset), 'utf8').toString('base64url');
const decodeCursor = cursor => { if (!cursor) return 0; const n = parseInt(Buffer.from(String(cursor), 'base64url').toString('utf8'), 10); return Number.isInteger(n) && n >= 0 ? n : 0; };

export function createEventsDiscoveryService({
  catalogue, now = () => new Date(), flags = {}, closingSoonHours = () => DEFAULT_CLOSING_SOON_HOURS,
  shareBase = () => process.env.FRIEND_INVITE_BASE_URL || process.env.APP_DOWNLOAD_LINK || 'https://fitflex-af-app.web.app',
}) {
  const on = name => Boolean(flags[name]?.());
  const viewOpts = () => ({ now: now(), closingSoonHours: closingSoonHours() });

  /** Spec §13: the flag probe. Never 404s; `discovery` false while EVENTS_MODULE is off. */
  function options() {
    const discovery = on('module');
    return {
      discovery,
      favourites: discovery && on('favourites'),
      registration: discovery && on('registration'),
      currency: 'TZS',
      closingSoonHours: closingSoonHours(),
      regions: REGIONS.map(r => ({ code: r.code, name: { ...r.name } })),
      timezones: [...TIMEZONES],
      types: [...EVENT_TYPES],
      distances: [...DISTANCE_BUCKETS],
      prices: [...PRICE_BUCKETS],
      sorts: [...SORTS],
    };
  }

  const shareUrlOf = event => `${String(shareBase()).replace(/\/+$/, '')}/events/${encodeURIComponent(event.slug || event.id)}`;

  async function list({ query = {}, userId = null }) {
    const types = toList(query.type).filter(t => EVENT_TYPES.includes(t));
    const distances = toList(query.distance).filter(d => DISTANCE_BUCKETS.includes(d));
    const region = query.region && REGION_CODES.includes(String(query.region)) ? String(query.region) : null;
    const price = PRICE_BUCKETS.includes(query.price) ? query.price : 'any';
    const sort = SORTS.includes(query.sort) ? query.sort : 'soonest';
    const openOnly = query.availability === 'open';
    const savedOnly = ['1', 'true'].includes(String(query.saved ?? ''));
    const text = typeof query.q === 'string' && query.q.trim() ? query.q.trim().slice(0, 80) : null;
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 50);
    const offset = decodeCursor(query.cursor);
    const from = parseDayBound(query.from, 'start') ?? now();
    const to = parseDayBound(query.to, 'end');

    let ids = null;
    if (savedOnly) {
      if (!userId) return { items: [], nextCursor: null, total: 0 };
      ids = [...(await catalogue.savedEventIds(userId))];
      if (!ids.length) return { items: [], nextCursor: null, total: 0 };
    }
    const candidates = await catalogue.listPublicCandidates({ statuses: [...PUBLIC_STATUSES], types, region, from, to, q: text, ids, limit: CANDIDATE_CAP });
    const saved = userId ? await catalogue.savedEventIds(userId, candidates.map(j => j.event.id)) : null;
    let items = candidates.map(j => summaryView(j, { ...viewOpts(), saved: userId ? saved.has(j.event.id) : null }));
    if (distances.length) items = items.filter(s => s.distancesM.some(m => distances.includes(distanceBucket(m))));
    if (price === 'free') items = items.filter(s => s.fromPriceTzs === 0);
    else if (price === 'under_20k') items = items.filter(s => s.fromPriceTzs !== null && s.fromPriceTzs < 20000);
    else if (price === 'under_50k') items = items.filter(s => s.fromPriceTzs !== null && s.fromPriceTzs < 50000);
    if (openOnly) items = items.filter(s => ['open', 'closing_soon'].includes(s.availability));
    if (sort === 'price_low') items.sort((a, b) => (a.fromPriceTzs ?? Infinity) - (b.fromPriceTzs ?? Infinity) || a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
    else if (sort === 'newest') {
      const publishedAt = new Map(candidates.map(j => [j.event.id, j.event.publishedAt ? +new Date(j.event.publishedAt) : 0]));
      items.sort((a, b) => publishedAt.get(b.id) - publishedAt.get(a.id) || a.id.localeCompare(b.id));
    }
    // soonest: the candidates already come (startsAt, id) ascending.
    const page = items.slice(offset, offset + limit);
    return { items: page, nextCursor: offset + limit < items.length ? encodeCursor(offset + limit) : null, total: items.length };
  }

  /** The public document; anything not publicly visible (draft, submitted, archived, unknown) is simply not found. Cancelled stays visible (§14.1). */
  async function detail({ idOrSlug, userId = null }) {
    const joined = await catalogue.loadJoined(String(idOrSlug || ''), { statuses: [...PUBLIC_STATUSES, 'completed', 'cancelled'] });
    if (!joined) return fail('event_not_found', 404);
    const saved = userId ? (await catalogue.savedEventIds(userId, [joined.event.id])).has(joined.event.id) : null;
    return detailView(joined, { ...viewOpts(), saved, shareUrl: shareUrlOf(joined.event) });
  }

  async function publicEvent(eventId) {
    const joined = await catalogue.loadJoined(String(eventId || ''), { statuses: [...PUBLIC_STATUSES, 'completed', 'cancelled'] });
    return joined ? joined.event : null;
  }

  async function save({ userId, eventId }) {
    const event = await publicEvent(eventId);
    if (!event) return fail('event_not_found', 404);
    await catalogue.saveFavourite(userId, event.id);
    return { saved: true };
  }

  async function unsave({ userId, eventId }) {
    const event = await publicEvent(eventId);
    if (!event) return fail('event_not_found', 404);
    await catalogue.removeFavourite(userId, event.id);
    return { saved: false };
  }

  return { options, list, detail, save, unsave, shareUrlOf };
}
