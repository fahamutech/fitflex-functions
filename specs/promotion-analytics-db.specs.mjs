// Promotion analytics against the CI database: taking events in (checks,
// repeats, clocks, who may add what), crediting purchases, adding events up
// exactly, retention, and the routes with their permissions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { promotionService, promotionEventsService, promotionAnalyticsService, shopService, opsService } from '../src/bootstrap/services.mjs';
import { postPromotionEvents, promotionAnalyticsSummary, promotionAnalyticsDetail, campaignAnalytics } from '../functions/promotion-events.mjs';
import * as jobs from '../functions/jobs.mjs';

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = ms => new Date(Date.now() + ms).toISOString();
const made = { gyms: [], users: [], products: [], promotions: [], campaigns: [], orders: [] };
const session = () => `sess-${randomUUID().slice(0, 12)}`;

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(route, { claims, query = {}, body = {}, params = {}, ip } = {}) {
  const req = { headers: { ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}), ...(ip ? { 'x-forwarded-for': ip } : {}) }, params, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}
const staff = (sub, ...scopes) => ({ sub, userType: 'admin', portalUser: true, aclPermissions: scopes });

async function gym(name = 'Analytics Gym') {
  const id = uid('gym');
  await db('Gym').insert({ id, name: `${name} ${id}`, tier: 'standard', location: 'Dar es Salaam', status: 'active', updatedAt: new Date() });
  made.gyms.push(id);
  return id;
}
async function admin() {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'admin', displayName: 'Analytics admin', updatedAt: new Date() });
  made.users.push(id);
  return id;
}
/** A live promotion on an entity (created, submitted, approved by another admin, activated). */
async function livePromotion(entityType, entityId, over = {}) {
  const maker = await admin(); const checker = await admin();
  const placements = over.placements ?? [{ gym: 'gym_discovery', trainer: 'trainer_discovery', product: 'marketplace' }[entityType]];
  const c = await promotionService.create({ actorId: maker, body: { entityType, entityId, type: 'featured', placements, startsAt: iso(-HOUR), endsAt: iso(30 * DAY), priority: 1, ...over } });
  assert.equal(c.error, undefined, JSON.stringify(c));
  made.promotions.push(c.promotion.id);
  for (const [fn, who] of [['submit', maker], ['approve', checker], ['activate', checker]]) {
    const out = await promotionService[fn]({ id: c.promotion.id, actorId: who });
    assert.equal(out.error, undefined, `${fn}: ${JSON.stringify(out)}`);
  }
  return c.promotion.id;
}
const rows = promotionId => db('PromotionEvent').where({ promotionId }).orderBy('at');
/** Put an event straight into the table, at a chosen time. */
async function seed(promotionId, entityType, entityId, event, atMs, over = {}) {
  await db('PromotionEvent').insert({ id: randomUUID(), at: new Date(atMs), event, entityType, entityId, promotionId, placement: 'gym_discovery', sessionId: session(), source: 'mobile', ...over });
}

// These specs run many live promotions side by side; the placement limits (5 featured, 10 promoted) are
// raised for the run so the limits themselves, tested elsewhere, do not get in the way.
const LIMITED = ['gym_discovery', 'search_results', 'marketplace', 'home'].flatMap(pl => ['featured', 'promoted', 'campaign'].map(ty => [pl, ty]));
before(async () => {
  for (const [placement, promotionType] of LIMITED) await promotionService.setLimit({ placement, promotionType, maxSlots: 500, actorId: 'promo_analytics_spec' });
});

after(async () => {
  await db('PlacementConfig').whereIn('id', LIMITED.map(([pl, ty]) => `${pl}:${ty}`)).del();
  await db('AuditLog').where('actor', 'promo_analytics_spec').del();
  if (made.promotions.length) {
    await db('PromotionEvent').whereIn('promotionId', made.promotions).del();
    await db('PromotionPlacement').whereIn('promotionId', made.promotions).del();
    await db('Promotion').whereIn('id', made.promotions).del();
  }
  if (made.campaigns.length) await db('PromotionCampaign').whereIn('id', made.campaigns).del();
  if (made.orders.length) await db('ShopOrder').whereIn('id', made.orders).del();
  if (made.products.length) await db('Product').whereIn('id', made.products).del();
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) { await db('PromotionEvent').whereIn('userId', made.users).del(); await db('AuditLog').whereIn('actor', made.users).del(); await db('User').whereIn('id', made.users).del(); }
});

// ── Taking events in ────────────────────────────────────────────────────────

test('ingest: every kind of event is stored with the promotion, campaign, placement and who it was', async () => {
  const g = await gym();
  const camp = await promotionService.createCampaign({ actorId: await admin(), body: { name: 'Ingest campaign', startsAt: iso(-DAY), endsAt: iso(40 * DAY) } });
  made.campaigns.push(camp.campaign.id);
  const p = await livePromotion('gym', g, { type: 'campaign', campaignId: camp.campaign.id, placements: ['gym_discovery', 'search_results'] });
  const s = session();
  const ev = (type, over = {}) => ({ type, entityType: 'gym', entityId: g, promotionId: p, placement: 'gym_discovery', sessionId: s, ...over });
  const out = await call(postPromotionEvents, { claims: { sub: 'member_1', userType: 'member' }, body: {
    events: [ev('impression'), ev('impression', { placement: 'search_results' }), ev('click'), ev('detail_view'), ev('save'), ev('booking_click'), ev('subscription_click')],
  } });
  assert.equal(out.statusCode, 202, JSON.stringify(out.body));
  assert.deepEqual([out.body.accepted, out.body.duplicates, out.body.rejected], [7, 0, []]);
  const stored = await rows(p);
  assert.equal(stored.length, 7);
  assert.ok(stored.every(r => r.campaignId === camp.campaign.id && r.userId === 'member_1' && r.sessionId === s && r.source === 'mobile'));
  assert.deepEqual(stored.map(r => r.event).sort(), ['booking_click', 'click', 'detail_view', 'impression', 'impression', 'save', 'subscription_click']);
});

test('ingest: anonymous sessions are accepted with no user id, and the source can be web', async () => {
  const g = await gym();
  const p = await livePromotion('gym', g);
  const out = await call(postPromotionEvents, { body: { source: 'web', events: [{ type: 'impression', entityType: 'gym', entityId: g, promotionId: p, placement: 'gym_discovery', sessionId: session() }] } });
  assert.equal(out.statusCode, 202);
  const [r] = await rows(p);
  assert.deepEqual([r.userId, r.source], [null, 'web']);
  assert.equal((await call(postPromotionEvents, { body: { source: 'fax', events: [{}] } })).body.error, 'invalid_source');
});

test('ingest: a bad event is refused with a reason and the good ones in the same batch are kept', async () => {
  const g = await gym(); const other = await gym();
  const p = await livePromotion('gym', g);
  const draftMaker = await admin();
  const draft = await promotionService.create({ actorId: draftMaker, body: { entityType: 'gym', entityId: other, type: 'promoted', placements: ['gym_discovery'], startsAt: iso(HOUR), endsAt: iso(DAY) } });
  made.promotions.push(draft.promotion.id);
  const s = session();
  const good = { type: 'click', entityType: 'gym', entityId: g, promotionId: p, placement: 'gym_discovery', sessionId: s };
  const out = await call(postPromotionEvents, { body: { events: [
    good,
    { ...good, entityId: other },                                  // this promotion is not for that gym: cannot add to someone else's numbers
    { ...good, promotionId: 'promo_does_not_exist' },
    { ...good, promotionId: draft.promotion.id, entityId: other }, // never shown to anyone
    { ...good, promotionId: undefined },                           // an event must name its promotion
    { ...good, type: 'purchase' },                                 // conversions are the server's alone
    { ...good, sessionId: 'x' },
    'not an object',
  ] } });
  assert.equal(out.statusCode, 202);
  assert.equal(out.body.accepted, 1);
  assert.deepEqual(out.body.rejected.map(r => [r.index, r.error]), [
    [1, 'promotion_mismatch'], [2, 'promotion_not_found'], [3, 'promotion_not_served'], [4, 'promotion_required'], [5, 'invalid_event_type'], [6, 'session_required'], [7, 'invalid_event'],
  ]);
  assert.equal((await rows(p)).length, 1);
  assert.equal((await rows(draft.promotion.id)).length, 0);
});

test('ingest: an impression or view repeated in a window counts once, a tap or save always counts, another session counts', async () => {
  const g = await gym();
  const p = await livePromotion('gym', g);
  const s = session();
  const ev = (type, over = {}) => ({ type, entityType: 'gym', entityId: g, promotionId: p, placement: 'gym_discovery', sessionId: s, ...over });
  const first = await call(postPromotionEvents, { body: { events: [ev('impression'), ev('impression'), ev('detail_view'), ev('click'), ev('click'), ev('save')] } });
  assert.deepEqual([first.body.accepted, first.body.duplicates], [5, 1]);
  const again = await call(postPromotionEvents, { body: { events: [ev('impression'), ev('detail_view')] } });
  assert.deepEqual([again.body.accepted, again.body.duplicates], [0, 2]);                 // a later request too
  const other = await call(postPromotionEvents, { body: { events: [ev('impression', { sessionId: session() })] } });
  assert.equal(other.body.accepted, 1);
  assert.equal((await rows(p)).length, 6);
});

test('ingest: a client clock that is plausible is used, an implausible one is replaced by ours', async () => {
  const g = await gym();
  const p = await livePromotion('gym', g);
  const ev = (at, type = 'click') => ({ type, entityType: 'gym', entityId: g, promotionId: p, placement: 'gym_discovery', sessionId: session(), at });
  await call(postPromotionEvents, { body: { events: [ev(iso(-2 * HOUR)), ev(iso(-30 * DAY)), ev(iso(2 * DAY)), ev('garbage')] } });
  const times = (await rows(p)).map(r => Date.now() - new Date(r.at).getTime());
  assert.equal(times.filter(t => t > 1.9 * HOUR && t < 2.1 * HOUR).length, 1);          // the believable one is kept
  assert.equal(times.filter(t => t < 60_000).length, 3);                                  // the rest are "now"
});

test('ingest: size limits and an allowance per caller', async () => {
  assert.equal((await call(postPromotionEvents, { body: { events: [] } })).body.error, 'events_required');
  assert.equal((await call(postPromotionEvents, { body: {} })).statusCode, 400);
  const big = await call(postPromotionEvents, { body: { events: Array.from({ length: 51 }, () => ({})) } });
  assert.deepEqual([big.statusCode, big.body.error, big.body.max], [413, 'batch_too_large', 50]);
  // 24 batches of 50 fit in a minute; the 25th from the same caller is refused, another caller is fine.
  const flood = { events: Array.from({ length: 50 }, () => ({})) };
  const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  for (let i = 0; i < 24; i += 1) assert.equal((await call(postPromotionEvents, { body: flood, ip })).statusCode, 202);
  assert.equal((await call(postPromotionEvents, { body: flood, ip })).statusCode, 429);
  assert.equal((await call(postPromotionEvents, { body: flood, ip: '198.51.100.9' })).statusCode, 202);
});

// ── Purchases ───────────────────────────────────────────────────────────────

async function product(price = 0) {
  const vendor = uid('usr');
  await db('User').insert({ id: vendor, userType: 'vendor', displayName: 'V', approvalStatus: 'approved', accountStatus: 'active', vendorProfile: JSON.stringify({ businessName: 'V', status: 'published' }), updatedAt: new Date() });
  made.users.push(vendor);
  const id = uid('prd');
  await db('Product').insert({ id, vendorId: vendor, name: `Analytics Product ${id}`, category: 'gear', priceTzs: price, stock: 10, status: 'active', approvalStatus: 'approved', visibility: 'visible', updatedAt: new Date() });
  made.products.push(id);
  return { id, vendor };
}

test('purchase: credited to the promotion the buyer opened in the last week, once, with its value', async () => {
  const pr = await product(25000);
  const p = await livePromotion('product', pr.id, { placements: ['marketplace'] });
  const buyer = uid('usr');
  await seed(p, 'product', pr.id, 'impression', Date.now() - 3 * DAY, { userId: buyer, placement: 'marketplace' });
  await seed(p, 'product', pr.id, 'click', Date.now() - 2 * DAY, { userId: buyer, placement: 'marketplace' });
  const order = { id: uid('ord'), buyerId: buyer, items: [{ productId: pr.id, vendorId: pr.vendor, qty: 2, priceTzs: 25000 }] };
  assert.deepEqual(await promotionEventsService.recordPaidOrder(order), { credited: 1 });
  assert.deepEqual(await promotionEventsService.recordPaidOrder(order), { credited: 0 });   // the same order twice
  const [purchase] = (await rows(p)).filter(r => r.event === 'purchase');
  assert.deepEqual([purchase.valueTzs, purchase.source, purchase.userId, purchase.placement, purchase.sessionId], [50000, 'server', buyer, 'marketplace', `server:${order.id}`]);
});

test('purchase: not credited without a recent open of the promotion, or for a different buyer, or after a week', async () => {
  const pr = await product(1000);
  const p = await livePromotion('product', pr.id, { placements: ['marketplace'] });
  const buyer = uid('usr');
  const order = (b = buyer) => ({ id: uid('ord'), buyerId: b, items: [{ productId: pr.id, qty: 1, priceTzs: 1000 }] });
  assert.deepEqual(await promotionEventsService.recordPaidOrder(order()), { credited: 0 });          // never saw it
  await seed(p, 'product', pr.id, 'impression', Date.now() - HOUR, { userId: buyer });                // seeing is not opening
  assert.deepEqual(await promotionEventsService.recordPaidOrder(order()), { credited: 0 });
  await seed(p, 'product', pr.id, 'click', Date.now() - 8 * DAY, { userId: buyer });                  // too long ago
  assert.deepEqual(await promotionEventsService.recordPaidOrder(order()), { credited: 0 });
  await seed(p, 'product', pr.id, 'click', Date.now() - DAY, { userId: uid('usr') });                 // someone else's click
  assert.deepEqual(await promotionEventsService.recordPaidOrder(order()), { credited: 0 });
  assert.deepEqual(await promotionEventsService.recordPaidOrder({ id: 'x', buyerId: null, items: [] }), { credited: 0 });
  assert.equal((await rows(p)).filter(r => r.event === 'purchase').length, 0);
});

test('purchase: a paid shop order is credited through the real order path, and a failure never fails the order', async () => {
  const pr = await product(0);                                                                       // a free item: the order is paid at once
  const p = await livePromotion('product', pr.id, { placements: ['marketplace'] });
  const buyer = await admin();
  await seed(p, 'product', pr.id, 'detail_view', Date.now() - HOUR, { userId: buyer, placement: 'marketplace' });
  const gymId = await gym();
  const placed = await shopService.createOrder({ buyerId: buyer, body: { items: [{ productId: pr.id, qty: 1 }], deliveryMethod: 'gym_pickup', pickupGymId: gymId, paymentMethod: 'mpesa' } });
  assert.ok(placed.order, JSON.stringify(placed));
  made.orders.push(placed.order.id);
  assert.equal((await rows(p)).filter(r => r.event === 'purchase').length, 1);
});

// ── Adding up ───────────────────────────────────────────────────────────────

const eatDay = ms => new Date(ms + 3 * HOUR).toISOString().slice(0, 10);

test('analytics: exact totals, ratios, search appearances, unique viewers and the funnel', async () => {
  const g = await gym('Totals Gym');
  const p = await livePromotion('gym', g, { placements: ['gym_discovery', 'search_results'] });
  const t = Date.now() - 2 * DAY;
  const viewers = ['u1', 'u2', 'u3'].map(u => `${u}_${p}`);
  for (const v of viewers) await seed(p, 'gym', g, 'impression', t, { userId: v });
  for (let i = 0; i < 7; i += 1) await seed(p, 'gym', g, 'impression', t + i, { userId: null, sessionId: `anon-session-${i % 2}-${p}`, placement: 'search_results' });   // 7 impressions, 2 anonymous sessions
  for (let i = 0; i < 4; i += 1) await seed(p, 'gym', g, 'click', t);
  await seed(p, 'gym', g, 'detail_view', t); await seed(p, 'gym', g, 'detail_view', t); await seed(p, 'gym', g, 'detail_view', t);
  await seed(p, 'gym', g, 'save', t);
  await seed(p, 'gym', g, 'subscription_click', t); await seed(p, 'gym', g, 'subscription_click', t);
  await seed(p, 'gym', g, 'booking_click', t);

  const d = await promotionAnalyticsService.detail(p, {});
  assert.equal(d.error, undefined, JSON.stringify(d));
  const T = d.totals;
  assert.deepEqual([T.impressions, T.searchAppearances, T.clicks, T.detailViews, T.saves, T.bookingClicks, T.subscriptionClicks, T.uniqueViewers], [10, 7, 4, 3, 1, 1, 2, 5]);
  assert.deepEqual([T.clickThroughRate, T.viewRate, T.conversions, T.conversionRate], [0.4, 0.3, 0, 0]);
  assert.deepEqual(d.funnel, [{ step: 'impressions', count: 10 }, { step: 'clicks', count: 4 }, { step: 'detailViews', count: 3 }, { step: 'actionClicks', count: 3 }, { step: 'conversions', count: 0 }]);
  assert.deepEqual(d.byPlacement.filter(x => x.impressions > 0).map(x => [x.placement, x.impressions]).sort(), [['gym_discovery', 3], ['search_results', 7]]);
  assert.deepEqual(d.notTracked, ['booking_conversions', 'subscription_conversions']);
});

test('analytics: the day-by-day series is in East Africa Time, covers every day, and fills the empty ones', async () => {
  const g = await gym('Daily Gym');
  const p = await livePromotion('gym', g);
  // 21:30 UTC is 00:30 the next day in Dar es Salaam.
  const lateUtc = new Date(Date.now() - 3 * DAY); lateUtc.setUTCHours(21, 30, 0, 0);
  await seed(p, 'gym', g, 'click', lateUtc.getTime());
  await seed(p, 'gym', g, 'click', lateUtc.getTime() + 60_000);
  const d = await promotionAnalyticsService.detail(p, {});
  assert.equal(d.daily.length, 30);
  const expectedDay = eatDay(lateUtc.getTime());
  assert.equal(expectedDay, new Date(lateUtc.getTime() + DAY).toISOString().slice(0, 10));        // the next calendar day
  assert.equal(d.daily.find(x => x.day === expectedDay).clicks, 2);
  assert.equal(d.daily.reduce((n, x) => n + x.clicks, 0), 2);
  assert.ok(d.daily.every((x, i, a) => i === 0 || x.day > a[i - 1].day));
  const narrow = await promotionAnalyticsService.detail(p, { from: expectedDay, to: expectedDay });
  assert.deepEqual([narrow.daily.length, narrow.totals.clicks], [1, 2]);
  const before = await promotionAnalyticsService.detail(p, { from: '2020-01-01', to: '2020-01-05' });
  assert.deepEqual([before.daily.length, before.totals.clicks, before.totals.clickThroughRate], [5, 0, null]);   // no impressions: no rate
});

test('analytics: the summary lists promotions with their numbers, filters, and promotions with nothing yet show zeros', async () => {
  const g1 = await gym('Sum A'); const g2 = await gym('Sum B'); const g3 = await gym('Sum C');
  const a = await livePromotion('gym', g1, { type: 'featured' });
  const b = await livePromotion('gym', g2, { type: 'promoted', placements: ['search_results'] });
  const c = await livePromotion('gym', g3, { type: 'featured' });
  const t = Date.now() - DAY;
  for (let i = 0; i < 5; i += 1) await seed(a, 'gym', g1, 'impression', t + i);
  await seed(a, 'gym', g1, 'click', t);
  for (let i = 0; i < 3; i += 1) await seed(b, 'gym', g2, 'impression', t + i, { placement: 'search_results' });
  const all = await promotionAnalyticsService.summary({});
  const mine = Object.fromEntries(all.items.filter(i => [a, b, c].includes(i.promotion.id)).map(i => [i.promotion.id, i]));
  assert.deepEqual([mine[a].impressions, mine[a].clicks, mine[a].clickThroughRate], [5, 1, 0.2]);
  assert.deepEqual([mine[b].impressions, mine[b].searchAppearances], [3, 3]);
  assert.deepEqual([mine[c].impressions, mine[c].clickThroughRate], [0, null]);                      // live, but nothing recorded: zeros, not missing
  assert.equal(mine[a].promotion.entityName, `Sum A ${g1}`);
  assert.ok(all.items.findIndex(i => i.promotion.id === a) < all.items.findIndex(i => i.promotion.id === b));   // most impressions first
  assert.ok(all.totals.impressions >= 8);

  const onlyPromoted = await promotionAnalyticsService.summary({ type: 'promoted' });
  assert.ok(onlyPromoted.items.some(i => i.promotion.id === b) && !onlyPromoted.items.some(i => i.promotion.id === a));
  const search = await promotionAnalyticsService.summary({ placement: 'search_results', type: 'promoted' });
  assert.equal(search.items.find(i => i.promotion.id === b).impressions, 3);
  const none = await promotionAnalyticsService.summary({ placement: 'home', type: 'promoted' });
  assert.equal(none.items.find(i => i.promotion.id === b).impressions, 0);                           // the placement filter changes the numbers
});

test('analytics: a campaign adds up its promotions', async () => {
  const g1 = await gym('Camp A'); const g2 = await gym('Camp B');
  const camp = await promotionService.createCampaign({ actorId: await admin(), body: { name: 'Totals campaign', startsAt: iso(-DAY), endsAt: iso(40 * DAY) } });
  made.campaigns.push(camp.campaign.id);
  const a = await livePromotion('gym', g1, { type: 'campaign', campaignId: camp.campaign.id });
  const b = await livePromotion('gym', g2, { type: 'campaign', campaignId: camp.campaign.id });
  await seed(a, 'gym', g1, 'impression', Date.now() - HOUR, { campaignId: camp.campaign.id }); await seed(a, 'gym', g1, 'click', Date.now() - HOUR, { campaignId: camp.campaign.id });
  await seed(b, 'gym', g2, 'impression', Date.now() - HOUR, { campaignId: camp.campaign.id });
  const out = await promotionAnalyticsService.campaign(camp.campaign.id, {});
  assert.equal(out.campaign.name, 'Totals campaign');
  assert.deepEqual([out.totals.impressions, out.totals.clicks, out.items.length], [2, 1, 2]);
  assert.equal((await promotionAnalyticsService.campaign('camp_nope', {})).error, 'campaign_not_found');
});

test('analytics: ranges are validated', async () => {
  const bad = r => promotionAnalyticsService.summary(r);
  assert.equal((await bad({ from: 'yesterday' })).error, 'invalid_range');
  assert.equal((await bad({ from: '2026-10-10', to: '2026-10-01' })).error, 'invalid_range');
  assert.equal((await bad({ from: '2024-01-01', to: '2026-10-01' })).error, 'range_too_long');
  assert.equal((await promotionAnalyticsService.detail('promo_nope', {})).error, 'promotion_not_found');
  assert.equal((await bad({ from: '2026-02-30' })).error, 'invalid_range');
});

// ── Permissions and retention ───────────────────────────────────────────────

test('routes: analytics needs its own scope; a full admin needs none; draft promotions are not reported', async () => {
  const g = await gym();
  const p = await livePromotion('gym', g);
  assert.equal((await call(promotionAnalyticsSummary, {})).statusCode, 401);
  assert.equal((await call(promotionAnalyticsSummary, { claims: { sub: 'm', userType: 'member' } })).statusCode, 403);
  const forbidden = await call(promotionAnalyticsSummary, { claims: staff('s1', 'promotions', 'promotions_approve', 'campaigns') });
  assert.deepEqual([forbidden.statusCode, forbidden.body.requiredScope], [403, 'promotion_analytics']);
  const ok = await call(promotionAnalyticsSummary, { claims: staff('s2', 'promotion_analytics') });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body.notTracked, ['booking_conversions', 'subscription_conversions']);
  assert.equal((await call(promotionAnalyticsDetail, { claims: { sub: 'a', userType: 'admin' }, params: { id: p } })).statusCode, 200);
  assert.equal((await call(promotionAnalyticsDetail, { claims: staff('s3', 'promotion_analytics'), params: { id: 'nope' } })).statusCode, 404);
  assert.equal((await call(promotionAnalyticsSummary, { claims: staff('s2', 'promotion_analytics'), query: { from: 'x' } })).statusCode, 400);
  assert.equal((await call(campaignAnalytics, { claims: staff('s3', 'promotion_analytics'), params: { id: 'camp_nope' } })).statusCode, 404);
  const maker = await admin();
  const draft = await promotionService.create({ actorId: maker, body: { entityType: 'gym', entityId: g, type: 'promoted', placements: ['search_results'], startsAt: iso(HOUR), endsAt: iso(DAY) } });
  made.promotions.push(draft.promotion.id);
  assert.ok(!(await call(promotionAnalyticsSummary, { claims: staff('s2', 'promotion_analytics') })).body.items.some(i => i.promotion.id === draft.promotion.id));
});

test('retention: events older than 13 months are deleted, newer ones are kept, and the job is registered', async () => {
  const g = await gym();
  const p = await livePromotion('gym', g);
  const months = n => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); return d.getTime(); };
  await seed(p, 'gym', g, 'click', months(14)); await seed(p, 'gym', g, 'click', months(14) - DAY); await seed(p, 'gym', g, 'click', months(12));
  const out = await promotionEventsService.purge();
  assert.ok(out.deleted >= 2);
  assert.equal((await rows(p)).length, 1);
  assert.equal((await promotionEventsService.purge()).deleted >= 0, true);                           // safe to run again
  assert.equal(jobs.promotionEventsRetention.rule, '40 21 * * *');
  const run = await opsService.runJob('promotion-events-retention', { trigger: 'manual', actorId: 'promo_events_ops' });
  assert.notEqual(run.error, 'unknown_job');
  assert.notEqual(run.status, 'failed', JSON.stringify(run));
});
