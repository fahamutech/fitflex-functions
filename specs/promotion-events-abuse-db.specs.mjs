// The open events endpoint is proportionately hard to inflate from one device:
// per-session caps on taps and saves per promotion, and on everything per hour.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { promotionService, promotionEventsService } from '../src/bootstrap/services.mjs';
import { SESSION_EVENT_CAPS, SESSION_HOURLY_CAP } from '../src/shared/promotion-events.mjs';

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;
const made = { gyms: [], promotions: [], users: [] };
const iso = ms => new Date(Date.now() + ms).toISOString();

before(async () => {
  await promotionService.setLimit({ placement: 'gym_discovery', promotionType: 'featured', maxSlots: 500, actorId: 'promo_abuse_spec' });
});
after(async () => {
  await db('PlacementConfig').where({ id: 'gym_discovery:featured' }).del();
  await db('AuditLog').where('actor', 'promo_abuse_spec').del();
  if (made.promotions.length) {
    await db('PromotionEvent').whereIn('promotionId', made.promotions).del();
    await db('PromotionPlacement').whereIn('promotionId', made.promotions).del();
    await db('Promotion').whereIn('id', made.promotions).del();
  }
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) { await db('AuditLog').whereIn('actor', made.users).del(); await db('User').whereIn('id', made.users).del(); }
});

async function livePromotion() {
  const mk = async () => { const id = uid('usr'); await db('User').insert({ id, userType: 'admin', displayName: 'Abuse admin', updatedAt: new Date() }); made.users.push(id); return id; };
  const maker = await mk(); const checker = await mk();
  const gymId = uid('gym');
  await db('Gym').insert({ id: gymId, name: `Abuse Gym ${gymId}`, tier: 'standard', location: 'Dar es Salaam', status: 'active', updatedAt: new Date() });
  made.gyms.push(gymId);
  const c = await promotionService.create({ actorId: maker, body: { entityType: 'gym', entityId: gymId, type: 'featured', placements: ['gym_discovery'], startsAt: iso(-HOUR), endsAt: iso(30 * 24 * HOUR), priority: 1 } });
  made.promotions.push(c.promotion.id);
  for (const [fn, who] of [['submit', maker], ['approve', checker], ['activate', checker]]) assert.equal((await promotionService[fn]({ id: c.promotion.id, actorId: who })).error, undefined);
  return { promotionId: c.promotion.id, gymId };
}
const ev = (g, type, sessionId, over = {}) => ({ type, entityType: 'gym', entityId: g.gymId, promotionId: g.promotionId, placement: 'gym_discovery', sessionId, ...over });

test('one session cannot pile up taps or saves on a promotion, across batches, but another session is unaffected', async () => {
  const g = await livePromotion();
  const s = `sess-${randomUUID().slice(0, 10)}`;
  const first = await promotionEventsService.ingest({ events: Array.from({ length: 40 }, () => ev(g, 'click', s)) });
  assert.equal(first.accepted, SESSION_EVENT_CAPS.click);
  assert.equal(first.rejected.length, 10);
  assert.ok(first.rejected.every(r => r.error === 'session_limit'));
  assert.deepEqual(first.rejected.map(r => r.index), Array.from({ length: 10 }, (_, i) => 30 + i));         // the ones past the cap, in order
  const again = await promotionEventsService.ingest({ events: [ev(g, 'click', s), ev(g, 'save', s)] });
  assert.deepEqual([again.accepted, again.rejected.map(r => r.error)], [1, ['session_limit']]);              // clicks used up, a first save is fine
  const saves = await promotionEventsService.ingest({ events: Array.from({ length: 12 }, () => ev(g, 'save', s)) });
  assert.equal(saves.accepted, SESSION_EVENT_CAPS.save - 1);                                                 // one save already counted
  const other = await promotionEventsService.ingest({ events: Array.from({ length: 5 }, () => ev(g, 'click', `sess-${randomUUID().slice(0, 10)}`)) });
  assert.equal(other.accepted, 5);
  for (const type of ['booking_click', 'subscription_click']) {
    const out = await promotionEventsService.ingest({ events: Array.from({ length: 12 }, () => ev(g, type, s)) });
    assert.equal(out.accepted, SESSION_EVENT_CAPS[type], type);
  }
});

test('an impression or view repeated still counts once and does not eat into the tap caps', async () => {
  const g = await livePromotion();
  const s = `sess-${randomUUID().slice(0, 10)}`;
  const out = await promotionEventsService.ingest({ events: [...Array.from({ length: 49 }, () => ev(g, 'impression', s)), ev(g, 'click', s)] });
  assert.deepEqual([out.accepted, out.duplicates, out.rejected], [2, 48, []]);
});

test('one session is also limited across everything in an hour', async () => {
  const g = await livePromotion();
  const s = `sess-${randomUUID().slice(0, 10)}`;
  const seeded = Array.from({ length: SESSION_HOURLY_CAP - 10 }, () => ({ id: randomUUID(), at: new Date(), event: 'impression', entityType: 'gym', entityId: g.gymId, promotionId: g.promotionId, placement: 'gym_discovery', sessionId: s, source: 'mobile' }));
  for (let i = 0; i < seeded.length; i += 500) await db('PromotionEvent').insert(seeded.slice(i, i + 500));
  const out = await promotionEventsService.ingest({ events: Array.from({ length: 20 }, (_, i) => ev(g, 'detail_view', s, { placement: i % 2 ? 'home' : 'search_results', promotionId: g.promotionId })) });
  // Detail views repeat per promotion within ten minutes, so only the first is new: use clicks for the cap.
  const clicks = await promotionEventsService.ingest({ events: Array.from({ length: 20 }, () => ev(g, 'click', s)) });
  assert.equal(out.accepted + clicks.accepted, 10);
  assert.ok(clicks.rejected.every(r => r.error === 'session_limit'));
});
