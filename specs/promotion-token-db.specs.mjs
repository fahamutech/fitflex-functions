// Signed tokens end to end: discovery hands them out, /events checks them, and
// analytics counts only what proved it was served. Includes the attack this
// exists to stop: forging events from ids anyone can read in a discover response.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { signServedToken, verifyServedToken, TOKEN_TTL_MS } from '../src/auth/promotion-token.mjs';
import { promotionService, promotionEventsService, promotionAnalyticsService } from '../src/bootstrap/services.mjs';
import { discoverGyms } from '../functions/discover.mjs';
import { postPromotionEvents, promotionAnalyticsSummary } from '../functions/promotion-events.mjs';

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = ms => new Date(Date.now() + ms).toISOString();
const made = { gyms: [], users: [], promotions: [] };
const session = () => `sess-${randomUUID().slice(0, 12)}`;

before(async () => { await promotionService.setLimit({ placement: 'gym_discovery', promotionType: 'featured', maxSlots: 500, actorId: 'promo_token_spec' }); });
after(async () => {
  await db('PlacementConfig').where({ id: 'gym_discovery:featured' }).del();
  await db('AuditLog').where('actor', 'promo_token_spec').del();
  if (made.promotions.length) {
    await db('PromotionEvent').whereIn('promotionId', made.promotions).del();
    await db('PromotionPlacement').whereIn('promotionId', made.promotions).del();
    await db('Promotion').whereIn('id', made.promotions).del();
  }
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) { await db('AuditLog').whereIn('actor', made.users).del(); await db('User').whereIn('id', made.users).del(); }
});

function res() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
async function call(route, { claims, query = {}, body = {} } = {}) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params: {}, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) { let passed = false; await guard(req, out, () => { passed = true; }); if (!passed) return out; }
  await route.onRequest(req, out);
  return out;
}
async function admin() { const id = uid('usr'); await db('User').insert({ id, userType: 'admin', displayName: 'Token admin', updatedAt: new Date() }); made.users.push(id); return id; }
async function liveGym(over = {}) {
  const gymId = uid('gym');
  await db('Gym').insert({ id: gymId, name: `Token Gym ${gymId}`, tier: 'standard', location: 'Dar es Salaam', status: 'active', updatedAt: new Date() });
  made.gyms.push(gymId);
  const maker = await admin(); const checker = await admin();
  const c = await promotionService.create({ actorId: maker, body: { entityType: 'gym', entityId: gymId, type: 'featured', placements: ['gym_discovery'], startsAt: iso(-HOUR), endsAt: iso(30 * DAY), priority: 1, ...over } });
  assert.equal(c.error, undefined, JSON.stringify(c));
  made.promotions.push(c.promotion.id);
  for (const [fn, who] of [['submit', maker], ['approve', checker], ['activate', checker]]) assert.equal((await promotionService[fn]({ id: c.promotion.id, actorId: who })).error, undefined, fn);
  return { gymId, promotionId: c.promotion.id };
}
const token = (g, sessionId, over = {}) => signServedToken({ promotionId: g.promotionId, entityType: 'gym', entityId: g.gymId, sessionId, ...over });
const event = (g, type, sessionId, over = {}) => ({ type, entityType: 'gym', entityId: g.gymId, promotionId: g.promotionId, placement: 'gym_discovery', sessionId, ...over });
const post = events => call(postPromotionEvents, { body: { events } });
const stored = g => db('PromotionEvent').where({ promotionId: g.promotionId }).orderBy('at');
const withMode = async (mode, fn) => { const before = process.env.PROMOTION_EVENT_TOKENS; process.env.PROMOTION_EVENT_TOKENS = mode; try { return await fn(); } finally { if (before === undefined) delete process.env.PROMOTION_EVENT_TOKENS; else process.env.PROMOTION_EVENT_TOKENS = before; } };

// ── Discovery hands the proof out ───────────────────────────────────────────

test('discovery gives each promoted card a token for the session that asked, and none without one', async () => {
  const g = await liveGym();
  const s1 = session(); const s2 = session();
  const find = out => out.body.featured.find(c => c.id === g.gymId);
  const withSession = find(await call(discoverGyms, { query: { session: s1, limit: '50' } }));
  assert.ok(withSession?.promotion?.token, 'a token is issued');
  assert.equal(verifyServedToken(withSession.promotion.token, { promotionId: g.promotionId, entityType: 'gym', entityId: g.gymId, sessionId: s1 }).ok, true);
  assert.equal(verifyServedToken(withSession.promotion.token, { promotionId: g.promotionId, entityType: 'gym', entityId: g.gymId, sessionId: s2 }).reason, 'mismatch');
  const other = find(await call(discoverGyms, { query: { session: s2, limit: '50' } }));
  assert.notEqual(other.promotion.token, withSession.promotion.token);
  // Without a session, or with one that is not a clean id, the card is as before.
  for (const query of [{ limit: '50' }, { limit: '50', session: 'short' }, { limit: '50', session: 'has spaces and !' }, { limit: '50', session: 'x'.repeat(80) }]) {
    const card = find(await call(discoverGyms, { query }));
    assert.equal(card.promotion.token, undefined, JSON.stringify(query));
    assert.equal(card.promotion.type, 'featured');
  }
  // An explicit sort turns promotion off, so there is nothing to prove.
  const sorted = await call(discoverGyms, { query: { session: s1, sort: 'rating', limit: '50' } });
  assert.deepEqual(sorted.body.featured, []);
  assert.ok(sorted.body.items.every(c => c.promotion === undefined));
});

test('a promoted card in the list (not only Featured) carries a token too', async () => {
  const g = await liveGym({ type: 'promoted', placements: ['search_results'] });
  await promotionService.setLimit({ placement: 'search_results', promotionType: 'promoted', maxSlots: 500, actorId: 'promo_token_spec' });
  try {
    const s = session();
    const out = await call(discoverGyms, { query: { q: g.gymId.slice(4), session: s, limit: '50' } });
    const card = out.body.items.find(c => c.id === g.gymId);
    assert.ok(card?.promotion?.token, JSON.stringify(out.body.items.map(c => c.id)));
    assert.equal(verifyServedToken(card.promotion.token, { promotionId: g.promotionId, entityType: 'gym', entityId: g.gymId, sessionId: s }).ok, true);
  } finally { await db('PlacementConfig').where({ id: 'search_results:promoted' }).del(); }
});

// ── /events checks it ───────────────────────────────────────────────────────

test('an event with the right token is verified, stored and counted', async () => {
  const g = await liveGym();
  const s = session();
  const t = token(g, s);
  const out = await post([event(g, 'impression', s, { token: t }), event(g, 'click', s, { token: t }), event(g, 'detail_view', s, { token: t })]);
  assert.deepEqual([out.statusCode, out.body.accepted, out.body.unverified, out.body.rejected], [202, 3, 0, []]);
  assert.ok((await stored(g)).every(r => r.verified === true));
  const d = await promotionAnalyticsService.detail(g.promotionId, {});
  assert.deepEqual([d.totals.impressions, d.totals.clicks, d.totals.detailViews, d.unverifiedEvents], [1, 1, 1, 0]);
});

test('a wrong token is refused, whatever the mode: another promotion, listing, session, tampered, expired or made up', async () => {
  const g = await liveGym(); const other = await liveGym();
  const s = session();
  const good = token(g, s);
  const bad = [
    token(other, s),                                                                                    // another promotion's card
    token(g, session()),                                                                                // another session's token
    signServedToken({ promotionId: g.promotionId, entityType: 'gym', entityId: other.gymId, sessionId: s }),   // right promotion, wrong listing
    signServedToken({ promotionId: g.promotionId, entityType: 'trainer', entityId: g.gymId, sessionId: s }),
    token(g, s, { now: new Date(Date.now() - TOKEN_TTL_MS - HOUR) }),                                   // expired
    `${good.slice(0, -4)}AAAA`,                                                                         // tampered
    'v1.bm90LWpzb24.AAAA', 'rubbish', `v1.${'a'.repeat(900)}.b`,
  ];
  for (const mode of ['optional', 'required']) {
    const out = await withMode(mode, () => post(bad.map(t => event(g, 'click', s, { token: t }))));
    assert.deepEqual([out.body.accepted, new Set(out.body.rejected.map(r => r.error))], [0, new Set(['invalid_token'])], mode);
    assert.equal(out.body.rejected.length, bad.length);
  }
  assert.equal((await stored(g)).length, 0);
});

test('an older build with no token is kept but not counted; once required, it is refused', async () => {
  const g = await liveGym();
  const s = session();
  const optional = await withMode('optional', () => post([event(g, 'impression', s), event(g, 'click', s)]));
  assert.deepEqual([optional.body.accepted, optional.body.unverified, optional.body.rejected], [2, 2, []]);
  assert.ok((await stored(g)).every(r => r.verified === false));
  const d = await promotionAnalyticsService.detail(g.promotionId, {});
  assert.deepEqual([d.totals.impressions, d.totals.clicks, d.unverifiedEvents], [0, 0, 2]);        // not in the numbers, but reported
  const required = await withMode('required', () => post([event(g, 'save', s)]));
  assert.deepEqual([required.body.accepted, required.body.rejected.map(r => r.error)], [0, ['token_required']]);
  // A mix in one batch: each event on its own.
  const t = token(g, s);
  const mix = await withMode('required', () => post([event(g, 'click', s, { token: t }), event(g, 'click', s), event(g, 'click', s, { token: 'nope' })]));
  assert.deepEqual([mix.body.accepted, mix.body.rejected.map(r => [r.index, r.error])], [1, [[1, 'token_required'], [2, 'invalid_token']]]);
});

test('an event cannot predate the card being served', async () => {
  const g = await liveGym();
  const s = session();
  const t = token(g, s, { now: new Date(Date.now() - 5 * 60_000) });                                   // served five minutes ago
  const out = await post([event(g, 'click', s, { token: t, at: iso(-30 * 60_000) }), event(g, 'click', s, { token: t, at: iso(-2 * 60_000) })]);
  assert.deepEqual([out.body.accepted, out.body.rejected.map(r => [r.index, r.error])], [1, [[0, 'invalid_token']]]);
});

test('unverified and verified events do not share repeat windows', async () => {
  const g = await liveGym();
  const s = session();
  await post([event(g, 'impression', s)]);                                                             // an old build's impression
  const out = await post([event(g, 'impression', s, { token: token(g, s) })]);                         // the same session's real one
  assert.deepEqual([out.body.accepted, out.body.duplicates], [1, 0]);
  assert.deepEqual((await stored(g)).map(r => r.verified).sort(), [false, true]);
});

// ── The attack this exists to stop ──────────────────────────────────────────

test('forging analytics from public ids adds nothing: no token, no count', async () => {
  const victim = await liveGym();
  // All an outsider can read in /discover: the promotion id and the listing id.
  const seen = (await call(discoverGyms, { query: { limit: '50' } })).body.featured.find(c => c.id === victim.gymId);
  assert.equal(seen.promotion.id, victim.promotionId);
  assert.equal(seen.promotion.token, undefined);
  // Forty fake devices each report an impression and a click, with no proof.
  for (let i = 0; i < 40; i += 1) {
    const s = session();
    await post([event(victim, 'impression', s), event(victim, 'click', s)]);
  }
  const d = await promotionAnalyticsService.detail(victim.promotionId, {});
  assert.deepEqual([d.totals.impressions, d.totals.clicks, d.totals.uniqueViewers], [0, 0, 0]);       // the victim's click-through rate is untouched
  assert.equal(d.totals.clickThroughRate, null);
  assert.equal(d.unverifiedEvents, 80);                                                                // visible to the admin as noise, not as performance
  // A token from a real card (another promotion) cannot be reused for the victim, nor can one session's for another.
  const mine = await liveGym();
  const s = session();
  const stolen = token(mine, s);
  const tryIt = await post([event(victim, 'click', s, { token: stolen }), event(victim, 'click', session(), { token: token(victim, s) })]);
  assert.deepEqual(tryIt.body.rejected.map(r => r.error), ['invalid_token', 'invalid_token']);
  assert.equal((await promotionAnalyticsService.detail(victim.promotionId, {})).totals.clicks, 0);
});

test('forging a purchase: an unverified click earns no credit, a verified one does', async () => {
  const g = await liveGym();
  const buyer = await admin();
  await db('PromotionEvent').insert({ id: randomUUID(), at: new Date(Date.now() - HOUR), event: 'click', entityType: 'product', entityId: 'prd_x', promotionId: g.promotionId, placement: 'marketplace', userId: buyer, sessionId: 'sess-forged-1', source: 'mobile', verified: false });
  const items = [{ productId: 'prd_x', qty: 1, priceTzs: 5000 }];
  assert.deepEqual(await promotionEventsService.recordPaidOrder({ id: uid('ord'), buyerId: buyer, items }), { credited: 0 });
  await db('PromotionEvent').insert({ id: randomUUID(), at: new Date(Date.now() - HOUR / 2), event: 'click', entityType: 'product', entityId: 'prd_x', promotionId: g.promotionId, placement: 'marketplace', userId: buyer, sessionId: 'sess-real-1', source: 'mobile', verified: true });
  assert.deepEqual(await promotionEventsService.recordPaidOrder({ id: uid('ord'), buyerId: buyer, items }), { credited: 1 });
  const [purchase] = await db('PromotionEvent').where({ promotionId: g.promotionId, event: 'purchase' });
  assert.equal(purchase.verified, true);                                                               // the server's own record is verified by nature
});

test('the summary and a campaign report how many events were left out', async () => {
  const g = await liveGym();
  const s = session();
  await post([event(g, 'click', s)]);
  const summary = await promotionAnalyticsService.summary({});
  assert.ok(summary.unverifiedEvents >= 1);
  const route = await call(promotionAnalyticsSummary, { claims: { sub: 'a', userType: 'admin' } });
  assert.equal(typeof route.body.unverifiedEvents, 'number');
  const none = await promotionAnalyticsService.summary({ type: 'campaign', campaignId: 'camp_nope' });
  assert.equal(none.unverifiedEvents, 0);
});

test('events are verified false by default in the table, and true for what the server records', async () => {
  const g = await liveGym();
  await db('PromotionEvent').insert({ id: randomUUID(), at: new Date(), event: 'click', entityType: 'gym', entityId: g.gymId, promotionId: g.promotionId, sessionId: 'sess-default-1', source: 'mobile' });
  assert.equal((await stored(g))[0].verified, false);
});
