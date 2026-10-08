// Promotion analytics — the events we record and how a raw event is checked.
// Pure: no I/O. Only things that really happened are counted: an impression is
// a card shown to someone, a click is a tap on it, and so on. Where the app
// cannot yet observe a step (a completed booking or subscription), nothing is
// recorded for it, and the dashboard says so rather than guessing.
import { ENTITY_TYPES, PLACEMENTS } from './promotion-config.mjs';

/** Events the apps may send. */
export const CLIENT_EVENTS = Object.freeze([
  'impression',          // a promoted (or Featured) card was shown
  'click',               // the customer opened it from the list
  'detail_view',         // the profile / product page was viewed (profile views, product views)
  'save',                // saved or favourited
  'booking_click',       // tapped Book (trainer)
  'subscription_click',  // tapped Subscribe / buy a pass (gym)
]);
/** Events only the server records, from what it can verify. */
export const SERVER_EVENTS = Object.freeze([
  'purchase',            // a shop order for the product was paid
  'booking',             // reserved: needs the booking payment to be attributable
  'subscription',        // reserved: needs the subscription payment to be attributable
]);
export const ALL_EVENTS = Object.freeze([...CLIENT_EVENTS, ...SERVER_EVENTS]);

/** Events that count as a conversion. */
export const CONVERSION_EVENTS = Object.freeze(['booking', 'subscription', 'purchase']);

export const MAX_BATCH = 50;
/** A purchase is credited to a promotion the buyer opened within this many days. */
export const ATTRIBUTION_WINDOW_DAYS = 7;
/** Raw events are kept this long; the owner decided 13 months. */
export const RETENTION_MONTHS = 13;
/** How far a client's own clock may be from ours before we use ours. */
const PAST_SLACK_MS = 24 * 3_600_000;
const FUTURE_SLACK_MS = 5 * 60_000;

const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * Check one event from a client. Returns { value } (ready to store, minus the
 * promotion lookup) or { error }. `now` is the server's clock.
 */
export function validateClientEvent(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object') return { error: 'invalid_event' };
  if (!CLIENT_EVENTS.includes(raw.type)) return { error: 'invalid_event_type' };
  if (!ENTITY_TYPES[raw.entityType]) return { error: 'invalid_entity_type' };
  const entityId = text(raw.entityId, 120);
  if (!entityId) return { error: 'entity_required' };
  const sessionId = text(raw.sessionId, 64);
  if (!sessionId || sessionId.length < 8) return { error: 'session_required' };
  let placement = null;
  if (raw.placement != null) {
    if (!PLACEMENTS[raw.placement]) return { error: 'invalid_placement' };
    placement = raw.placement;
  }
  const promotionId = text(raw.promotionId, 120);
  // Clients may not claim another time: theirs is used only if it is plausible.
  let at = now;
  if (raw.at !== undefined) {
    const t = new Date(raw.at);
    if (!Number.isNaN(t.getTime()) && t.getTime() >= now.getTime() - PAST_SLACK_MS && t.getTime() <= now.getTime() + FUTURE_SLACK_MS) at = t;
  }
  return { value: { event: raw.type, entityType: raw.entityType, entityId, placement, promotionId, sessionId, at } };
}

/**
 * Impressions and detail views repeat as a list scrolls or a screen reopens, so
 * the same one inside a window counts once. Taps and saves always count.
 */
export function dedupeKey({ event, entityType, entityId, promotionId, placement, sessionId, at }) {
  const t = at.getTime();
  const subject = promotionId || `${entityType}:${entityId}`;
  if (event === 'impression') return `imp:${sessionId}:${subject}:${placement || '-'}:${Math.floor(t / 3_600_000)}`;
  if (event === 'detail_view') return `view:${sessionId}:${subject}:${Math.floor(t / 600_000)}`;
  return null;
}

/** Ratios from totals; null where the denominator is zero (so "no data" is not shown as 0%). */
export function rates(t) {
  const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 10000) / 10000 : null);
  const conversions = (t.bookings || 0) + (t.subscriptions || 0) + (t.purchases || 0);
  return {
    clickThroughRate: ratio(t.clicks || 0, t.impressions || 0),
    viewRate: ratio(t.detailViews || 0, t.impressions || 0),
    conversions,
    conversionRate: ratio(conversions, t.clicks || 0),
  };
}

export const emptyTotals = () => ({
  impressions: 0, searchAppearances: 0, clicks: 0, detailViews: 0, saves: 0, bookingClicks: 0, subscriptionClicks: 0,
  bookings: 0, subscriptions: 0, purchases: 0, purchaseValueTzs: 0, uniqueViewers: 0,
});
