// Promotion analytics — the pure rules: what an event must look like, what
// counts as a repeat, and how ratios are reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateClientEvent, dedupeKey, rates, emptyTotals, CLIENT_EVENTS, SERVER_EVENTS, CONVERSION_EVENTS, MAX_BATCH, RETENTION_MONTHS, ATTRIBUTION_WINDOW_DAYS,
} from '../src/shared/promotion-events.mjs';

const NOW = new Date('2026-10-10T09:00:00.000Z');
const good = (over = {}) => ({ type: 'impression', entityType: 'gym', entityId: 'g1', promotionId: 'p1', placement: 'gym_discovery', sessionId: 'session-abc-123', ...over });

test('a well-formed event is accepted and normalised', () => {
  const out = validateClientEvent(good({ entityId: '  g1  ' }), NOW);
  assert.equal(out.error, undefined);
  assert.deepEqual({ ...out.value, at: undefined }, { event: 'impression', entityType: 'gym', entityId: 'g1', placement: 'gym_discovery', promotionId: 'p1', sessionId: 'session-abc-123', at: undefined });
  assert.equal(out.value.at.getTime(), NOW.getTime());
});

test('each kind of mistake is named', () => {
  const e = over => validateClientEvent(good(over), NOW).error;
  assert.equal(validateClientEvent(null, NOW).error, 'invalid_event');
  assert.equal(validateClientEvent('x', NOW).error, 'invalid_event');
  assert.equal(e({ type: 'purchase' }), 'invalid_event_type');                 // conversions are the server's to record
  assert.equal(e({ type: 'booking' }), 'invalid_event_type');
  assert.equal(e({ type: 'tap' }), 'invalid_event_type');
  assert.equal(e({ entityType: 'planet' }), 'invalid_entity_type');
  assert.equal(e({ entityId: '' }), 'entity_required');
  assert.equal(e({ entityId: 7 }), 'entity_required');
  assert.equal(e({ sessionId: 'short' }), 'session_required');
  assert.equal(e({ sessionId: undefined }), 'session_required');
  assert.equal(e({ placement: 'nowhere' }), 'invalid_placement');
  assert.equal(validateClientEvent(good({ placement: undefined }), NOW).value.placement, null);
});

test('a client may only say when something happened if it is plausible', () => {
  const at = ms => validateClientEvent(good({ at: new Date(NOW.getTime() + ms).toISOString() }), NOW).value.at.getTime() - NOW.getTime();
  assert.equal(at(-3_600_000), -3_600_000);                                    // an hour ago: believed (a phone that was offline)
  assert.equal(at(60_000), 60_000);
  assert.equal(at(-3 * 86_400_000), 0);                                        // days ago: ours is used
  assert.equal(at(3_600_000), 0);                                              // in the future: ours is used
  assert.equal(validateClientEvent(good({ at: 'whenever' }), NOW).value.at.getTime(), NOW.getTime());
});

test('impressions and views repeat as a list scrolls, so they count once in a window; taps and saves always count', () => {
  const k = (over = {}) => dedupeKey({ ...validateClientEvent(good(over), NOW).value, ...over.after });
  const base = { event: 'impression', entityType: 'gym', entityId: 'g1', promotionId: 'p1', placement: 'gym_discovery', sessionId: 'session-abc-123', at: NOW };
  assert.equal(dedupeKey(base), dedupeKey({ ...base, at: new Date(NOW.getTime() + 20 * 60_000) }));         // same hour
  assert.notEqual(dedupeKey(base), dedupeKey({ ...base, at: new Date(NOW.getTime() + 3_600_000) }));        // next hour
  assert.notEqual(dedupeKey(base), dedupeKey({ ...base, sessionId: 'another-session-1' }));
  assert.notEqual(dedupeKey(base), dedupeKey({ ...base, placement: 'home' }));                              // another place is another impression
  assert.notEqual(dedupeKey(base), dedupeKey({ ...base, promotionId: 'p2' }));
  const view = { ...base, event: 'detail_view' };
  assert.equal(dedupeKey(view), dedupeKey({ ...view, at: new Date(NOW.getTime() + 5 * 60_000) }));          // same ten minutes
  assert.notEqual(dedupeKey(view), dedupeKey({ ...view, at: new Date(NOW.getTime() + 11 * 60_000) }));
  for (const event of ['click', 'save', 'booking_click', 'subscription_click']) assert.equal(dedupeKey({ ...base, event }), null, event);
  assert.ok(k());
});

test('ratios are null, not zero, when there is nothing to divide by', () => {
  assert.deepEqual(rates(emptyTotals()), { clickThroughRate: null, viewRate: null, conversions: 0, conversionRate: null });
  const r = rates({ ...emptyTotals(), impressions: 12540, clicks: 1280, detailViews: 2430, purchases: 30, bookings: 8, subscriptions: 4 });
  assert.equal(r.clickThroughRate, 0.1021);
  assert.equal(r.viewRate, 0.1938);
  assert.equal(r.conversions, 42);
  assert.equal(r.conversionRate, 0.0328);
  assert.equal(rates({ ...emptyTotals(), impressions: 10 }).clickThroughRate, 0);                          // shown but never tapped is a real 0%
});

test('the vocabulary is closed and the decisions are in one place', () => {
  assert.deepEqual(CLIENT_EVENTS.filter(e => SERVER_EVENTS.includes(e)), []);
  assert.deepEqual([...CONVERSION_EVENTS].sort(), ['booking', 'purchase', 'subscription']);
  assert.equal(MAX_BATCH, 50);
  assert.equal(RETENTION_MONTHS, 13);
  assert.equal(ATTRIBUTION_WINDOW_DAYS, 7);
});
