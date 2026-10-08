// Hardening fixes found in review, against the real database: links to hidden listings,
// transacting with them, the four-eyes rule in the table, live ranking edits, event
// time rules, purchase reversal, account deletion, retention dates and atomic decisions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { trainers as trainerStore, gyms as gymStore } from '../src/bootstrap/collections.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { moderationService, promotionService, promotionEventsService, promotionAnalyticsService, shopService } from '../src/bootstrap/services.mjs';
import { createPromotionEventsService } from '../src/services/promotion-events-service.mjs';
import { getGym } from '../functions/gyms.mjs';
import { getTrainer } from '../functions/trainers.mjs';
import { memberEngageTrainer } from '../functions/trainer-engagements.mjs';
import { requestTrainerConnection } from '../functions/trainer-clients.mjs';
import { quoteTrainerBooking, createTrainerBooking } from '../functions/trainer-bookings.mjs';
import * as promotionRoutes from '../functions/promotions.mjs';
import { postPromotionEvents, promotionAnalyticsSummary } from '../functions/promotion-events.mjs';

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = ms => new Date(Date.now() + ms).toISOString();
const made = { gyms: [], users: [], products: [], promotions: [], trainers: [], orders: [] };
const LIMITED = ['gym_discovery', 'marketplace'].map(pl => [pl, 'featured']);

before(async () => {
  for (const [placement, promotionType] of LIMITED) await promotionService.setLimit({ placement, promotionType, maxSlots: 500, actorId: 'promo_hardening_spec' });
});
after(async () => {
  await db('PlacementConfig').whereIn('id', LIMITED.map(([a, b]) => `${a}:${b}`)).del();
  await db('AuditLog').where('actor', 'promo_hardening_spec').del();
  if (made.promotions.length) {
    await db('PromotionEvent').whereIn('promotionId', made.promotions).del();
    await db('PromotionPlacement').whereIn('promotionId', made.promotions).del();
    await db('Promotion').whereIn('id', made.promotions).del();
  }
  const ids = [...made.gyms, ...made.trainers, ...made.products, ...made.users];
  await db('ModerationEvent').whereIn('entityId', ids).del();
  await db('ModerationState').whereIn('entityId', ids).del();
  if (made.orders.length) await db('ShopOrder').whereIn('id', made.orders).del();
  if (made.products.length) await db('Product').whereIn('id', made.products).del();
  for (const id of made.trainers) await trainerStore.removeAsync(t => t.id === id);
  for (const id of made.gyms) await gymStore.removeAsync(g => g.id === id);
  if (made.users.length) { await db('PromotionEvent').whereIn('userId', made.users).del(); await db('AuditLog').whereIn('actor', made.users).del(); await db('User').whereIn('id', made.users).del(); }
});

function res() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
async function call(route, { claims, query = {}, body = {}, params = {} } = {}) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) { let passed = false; await guard(req, out, () => { passed = true; }); if (!passed) return out; }
  await route.onRequest(req, out);
  return out;
}
const staff = (sub, ...scopes) => ({ sub, userType: 'admin', portalUser: true, aclPermissions: scopes });
async function admin() { const id = uid('usr'); await db('User').insert({ id, userType: 'admin', displayName: 'Hardening admin', updatedAt: new Date() }); made.users.push(id); return id; }
// Through the store, so the gym is also in the in-memory cache the single-gym route reads.
async function gym() { const id = uid('gym'); await gymStore.insertAsync({ id, name: `Hardening Gym ${id}`, tier: 'standard', location: 'Dar es Salaam', status: 'active' }); made.gyms.push(id); return id; }
async function livePromotion(entityType, entityId, over = {}) {
  const maker = await admin(); const checker = await admin();
  const placements = [entityType === 'product' ? 'marketplace' : 'gym_discovery'];
  const c = await promotionService.create({ actorId: maker, body: { entityType, entityId, type: 'featured', placements, startsAt: iso(-HOUR), endsAt: iso(30 * DAY), priority: 5, ...over } });
  assert.equal(c.error, undefined, JSON.stringify(c));
  made.promotions.push(c.promotion.id);
  for (const [fn, who] of [['submit', maker], ['approve', checker], ['activate', checker]]) assert.equal((await promotionService[fn]({ id: c.promotion.id, actorId: who })).error, undefined, fn);
  return { id: c.promotion.id, maker, checker };
}

// ── Hidden listings cannot be reached or transacted with by link ────────────

test('a hidden gym or trainer is not found by id, and a hidden trainer cannot be booked, connected with or engaged', async () => {
  const mod = await admin();
  const g = await gym();
  assert.equal((await call(getGym, { params: { id: g } })).statusCode, 200);
  await moderationService.decide({ entityType: 'gym', entityId: g, action: 'hide', reason: 'x', actorId: mod });
  assert.equal((await call(getGym, { params: { id: g } })).statusCode, 404);
  await moderationService.decide({ entityType: 'gym', entityId: g, action: 'restore', actorId: mod });
  assert.equal((await call(getGym, { params: { id: g } })).statusCode, 200);

  const t = uid('tr');
  await trainerStore.insertAsync({ id: t, displayName: `Hardening Trainer ${t}`, specialties: ['boxing'], status: 'active', approvalStatus: 'approved', gymIds: [] });
  made.trainers.push(t);
  const member = { sub: await admin(), userType: 'member' };
  assert.equal((await call(getTrainer, { params: { id: t } })).statusCode, 200);
  await moderationService.decide({ entityType: 'trainer', entityId: t, action: 'suspend', reason: 'x', actorId: mod });
  assert.equal((await call(getTrainer, { params: { id: t } })).statusCode, 404);
  for (const [route, extra] of [[memberEngageTrainer, { params: { id: t }, body: { type: 'interest' } }], [requestTrainerConnection, { params: { id: t }, body: {} }],
    [quoteTrainerBooking, { body: { trainerId: t, slots: [] } }], [createTrainerBooking, { body: { trainerId: t, slots: [] } }]]) {
    const out = await call(route, { claims: member, ...extra });
    assert.deepEqual([out.statusCode, out.body.error], [409, 'trainer_unavailable'], route.path);
  }
  // Restored: the same calls reach the real handlers again (and answer for themselves, not with "unavailable").
  await moderationService.decide({ entityType: 'trainer', entityId: t, action: 'restore', actorId: mod });
  const engaged = await call(memberEngageTrainer, { claims: member, params: { id: t }, body: { type: 'interest' } });
  assert.notEqual(engaged.body?.error, 'trainer_unavailable');
});

async function product(price = 0) {
  const vendor = uid('usr');
  await db('User').insert({ id: vendor, userType: 'vendor', displayName: 'V', approvalStatus: 'approved', accountStatus: 'active', vendorProfile: JSON.stringify({ businessName: 'V', status: 'published' }), updatedAt: new Date() });
  made.users.push(vendor);
  const id = uid('prd');
  await db('Product').insert({ id, vendorId: vendor, name: `Hardening Product ${id}`, category: 'gear', priceTzs: price, stock: 10, status: 'active', approvalStatus: 'approved', visibility: 'visible', updatedAt: new Date() });
  made.products.push(id);
  return { id, vendor };
}
const order = (buyerId, productId, gymId) => shopService.createOrder({ buyerId, body: { items: [{ productId, qty: 1 }], deliveryMethod: 'gym_pickup', pickupGymId: gymId, paymentMethod: 'mpesa' } });

test('a hidden product, or a product of a suspended vendor, cannot be ordered even by someone with an old link', async () => {
  const mod = await admin(); const buyer = await admin(); const g = await gym();
  const a = await product(); const b = await product();
  const ok = await order(buyer, a.id, g);
  assert.ok(ok.order, JSON.stringify(ok)); made.orders.push(ok.order.id);
  await moderationService.decide({ entityType: 'product', entityId: a.id, action: 'hide', reason: 'x', actorId: mod });
  assert.deepEqual([(await order(buyer, a.id, g)).error, (await order(buyer, a.id, g)).status], ['product_not_found', 404]);
  await moderationService.decide({ entityType: 'vendor', entityId: b.vendor, action: 'suspend', reason: 'x', actorId: mod });
  assert.equal((await order(buyer, b.id, g)).error, 'product_not_found');
});

// ── The table refuses what the service refuses ──────────────────────────────

test('the database refuses a promotion approved by the person who made or submitted it', async () => {
  const g = await gym();
  const base = { id: uid('promo'), entityType: 'gym', entityId: g, type: 'featured', createdBy: 'maker_a', submittedBy: 'sub_b', startsAt: new Date(Date.now() + HOUR), endsAt: new Date(Date.now() + DAY), updatedAt: new Date() };
  made.promotions.push(base.id);
  await db('Promotion').insert({ ...base, status: 'approved', approvedBy: 'checker_c' });
  for (const approvedBy of ['maker_a', 'sub_b']) {
    await assert.rejects(db('Promotion').insert({ ...base, id: uid('promo'), approvedBy, status: 'approved' }), err => err.code === '23514', approvedBy);
  }
});

// ── Live ranking edits belong to the approver ───────────────────────────────

test('over the routes: ranking edits need promotions_approve, other live edits need promotions, analytics-only staff cannot read promotions', async () => {
  const g = await gym();
  const p = await livePromotion('gym', g);
  const maker = staff(p.maker, 'promotions');
  const patch = (claims, body) => call(promotionRoutes.updatePromotion, { claims, params: { id: p.id }, body });
  const denied = await patch(maker, { priority: 1 });
  assert.deepEqual([denied.statusCode, denied.body.error, denied.body.requiredScope], [403, 'ranking_change_requires_approver', 'promotions_approve']);
  assert.equal((await patch(maker, { notes: 'agreed on the phone' })).statusCode, 200);
  assert.equal((await patch(staff(p.checker, 'promotions', 'promotions_approve'), { priority: 2 })).statusCode, 200);
  assert.equal((await patch({ sub: p.checker, userType: 'admin' }, { priority: 3 })).statusCode, 200);                 // a full admin is an approver
  assert.equal((await call(promotionRoutes.listPromotions, { claims: staff('s', 'promotion_analytics') })).statusCode, 403);
  const overview = await call(promotionRoutes.promotionOverview, { claims: staff('s2', 'campaigns') });
  assert.equal(overview.statusCode, 200);
  assert.deepEqual(overview.body.recent, []);                                                                           // no who-did-what without promotions or moderation
  assert.ok((await call(promotionRoutes.promotionOverview, { claims: staff('s3', 'promotions') })).body.recent.length > 0);
});

// ── Event time rules and repeats on our clock ───────────────────────────────

const ev = (g, promotionId, type, over = {}) => ({ type, entityType: 'gym', entityId: g, promotionId, placement: 'gym_discovery', sessionId: `sess-${randomUUID().slice(0, 12)}`, ...over });

test('events outside the promotion\'s period are refused; a little after its end (offline phones) is fine', async () => {
  const g = await gym();
  const p = await livePromotion('gym', g, { startsAt: iso(-HOUR), endsAt: iso(2 * HOUR) });
  const out = await call(postPromotionEvents, { body: { events: [
    ev(g, p.id, 'click', { at: iso(-30 * 60_000) }),            // inside
    ev(g, p.id, 'click', { at: iso(-HOUR - 20 * 60_000) }),     // before it started, beyond the scheduler's lag
  ] } });
  assert.deepEqual([out.body.accepted, out.body.rejected.map(r => r.error)], [1, ['outside_promotion_period']]);
  // It ended 2 hours ago: an event from just now is still counted (a phone that was offline).
  await db('Promotion').where({ id: p.id }).update({ startsAt: new Date(Date.now() - 10 * HOUR), endsAt: new Date(Date.now() - 2 * HOUR) });
  assert.equal((await call(postPromotionEvents, { body: { events: [ev(g, p.id, 'click', { at: iso(-HOUR) })] } })).body.accepted, 1);
  // It ended 8 hours ago: that is too late to be about it.
  await db('Promotion').where({ id: p.id }).update({ startsAt: new Date(Date.now() - 20 * HOUR), endsAt: new Date(Date.now() - 8 * HOUR) });
  const tooLate = await call(postPromotionEvents, { body: { events: [ev(g, p.id, 'click', { at: iso(-HOUR) })] } });
  assert.deepEqual([tooLate.body.accepted, tooLate.body.rejected.map(r => r.error)], [0, ['outside_promotion_period']]);
});

test('repeats are counted on our clock: changing the phone\'s time does not mint new impressions', async () => {
  const g = await gym();
  const p = await livePromotion('gym', g, { startsAt: iso(-10 * HOUR) });
  const s = `sess-${randomUUID().slice(0, 12)}`;
  const at = hoursAgo => iso(-hoursAgo * HOUR);
  const out = await call(postPromotionEvents, { body: { events: [0, 1, 2, 3, 5, 8].map(h => ev(g, p.id, 'impression', { sessionId: s, at: at(h) })) } });
  assert.deepEqual([out.body.accepted, out.body.duplicates], [1, 5]);
});

// ── Purchases are taken back with the order; account deletion; retention ────

test('a cancelled order takes its purchase credit back, and the revenue with it', async () => {
  const pr = await product(0);
  const p = await livePromotion('product', pr.id);
  const buyer = await admin(); const g = await gym();
  await db('PromotionEvent').insert({ id: randomUUID(), at: new Date(Date.now() - HOUR), event: 'click', entityType: 'product', entityId: pr.id, promotionId: p.id, placement: 'marketplace', userId: buyer, sessionId: 'sess-reversal-1', source: 'mobile' });
  const placed = await order(buyer, pr.id, g);
  assert.ok(placed.order, JSON.stringify(placed)); made.orders.push(placed.order.id);
  const credited = () => db('PromotionEvent').where({ promotionId: p.id, event: 'purchase' });
  assert.equal((await credited()).length, 1);
  const cancelled = await shopService.buyerCancelOrder({ buyerId: buyer, orderId: placed.order.id });
  assert.ok(!cancelled.error, JSON.stringify(cancelled));
  assert.equal((await credited()).length, 0);
  assert.equal((await promotionAnalyticsService.detail(p.id, {})).totals.purchases, 0);
});

test('a purchase is credited to a tap only, not to a page view', async () => {
  const pr = await product(1000);
  const p = await livePromotion('product', pr.id);
  const buyer = uid('usr');
  await db('PromotionEvent').insert({ id: randomUUID(), at: new Date(Date.now() - HOUR), event: 'detail_view', entityType: 'product', entityId: pr.id, promotionId: p.id, placement: 'marketplace', userId: buyer, sessionId: 'sess-view-1', source: 'mobile' });
  assert.deepEqual(await promotionEventsService.recordPaidOrder({ id: uid('ord'), buyerId: buyer, items: [{ productId: pr.id, qty: 1, priceTzs: 1000 }] }), { credited: 0 });
});

test('deleting an account removes who the events were about, and keeps the counts', async () => {
  const g = await gym();
  const p = await livePromotion('gym', g);
  const who = uid('usr');
  await db('PromotionEvent').insert([1, 2, 3].map(() => ({ id: randomUUID(), at: new Date(), event: 'click', entityType: 'gym', entityId: g, promotionId: p.id, sessionId: 'sess-forget-1', userId: who, source: 'mobile' })));
  assert.deepEqual(await promotionEventsService.forgetUser(who), { cleared: 3 });
  assert.equal((await db('PromotionEvent').where({ promotionId: p.id })).filter(r => r.userId === who).length, 0);
  assert.equal((await db('PromotionEvent').where({ promotionId: p.id, event: 'click' })).length, 3);
  assert.deepEqual(await promotionEventsService.forgetUser(null), { cleared: 0 });
});

test('retention counts calendar months back and never reaches further than that', async () => {
  const cutoffFor = async (isoNow, months) => (await createPromotionEventsService({ db, promotions: null, now: () => new Date(isoNow) }).purge({ months })).cutoff.slice(0, 10);
  assert.equal(await cutoffFor('2026-03-31T10:00:00.000Z', 1), '2026-02-28');          // 31 March minus a month is the end of February, not 3 March
  assert.equal(await cutoffFor('2026-10-09T10:00:00.000Z', 13), '2025-09-09');
  assert.equal(await cutoffFor('2024-03-31T10:00:00.000Z', 1), '2024-02-29');          // leap year
  assert.equal(await cutoffFor('2026-01-15T10:00:00.000Z', 2), '2025-11-15');
});

// ── Analytics inputs and sums ───────────────────────────────────────────────

test('analytics: a very large revenue total is a number, not an overflow; a bad placement is refused, not a server error', async () => {
  const g = await gym();
  const p = await livePromotion('gym', g);
  await db('PromotionEvent').insert([1, 2].map(() => ({ id: randomUUID(), at: new Date(), event: 'purchase', entityType: 'gym', entityId: g, promotionId: p.id, sessionId: 'server:x', source: 'server', valueTzs: 2_000_000_000 })));
  const d = await promotionAnalyticsService.detail(p.id, {});
  assert.equal(d.totals.purchaseValueTzs, 4_000_000_000);
  assert.equal(typeof d.totals.purchaseValueTzs, 'number');
  const bad = await call(promotionAnalyticsSummary, { claims: { sub: 'a', userType: 'admin' }, query: { placement: ['a', 'b'] } });
  assert.deepEqual([bad.statusCode, bad.body.error], [400, 'invalid_placement']);
  assert.equal((await call(promotionAnalyticsSummary, { claims: { sub: 'a', userType: 'admin' }, query: { placement: 'nowhere' } })).statusCode, 400);
});

// ── Decisions are atomic with promotion changes ─────────────────────────────

test('a suspension and an activation at the same moment leave a consistent result, and neither waits forever', async () => {
  for (let round = 0; round < 3; round += 1) {
    const g = await gym();
    const maker = await admin(); const checker = await admin(); const mod = await admin();
    const c = await promotionService.create({ actorId: maker, body: { entityType: 'gym', entityId: g, type: 'featured', placements: ['gym_discovery'], startsAt: iso(-HOUR), endsAt: iso(30 * DAY), priority: 5 } });
    made.promotions.push(c.promotion.id);
    await promotionService.submit({ id: c.promotion.id, actorId: maker });
    await promotionService.approve({ id: c.promotion.id, actorId: checker });
    const [decision, activation] = await Promise.all([
      moderationService.decide({ entityType: 'gym', entityId: g, action: 'suspend', reason: 'race', actorId: mod }),
      promotionService.activate({ id: c.promotion.id, actorId: checker }),
    ]);
    assert.equal(decision.error, undefined);
    const status = (await db('Promotion').where({ id: c.promotion.id }).first()).status;
    // Either the activation came first and the suspension then paused it, or the suspension came first and the activation was refused.
    assert.notEqual(status, 'active', `round ${round}: ${JSON.stringify({ decision, activation })}`);
    assert.ok(['paused', 'approved'].includes(status), status);
  }
});
