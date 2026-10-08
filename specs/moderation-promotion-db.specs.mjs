// Moderation & promotion against the CI database: what the schema refuses, the
// seeded geography and the address backfill, the real store round-trip, and the
// admin routes with their guards chained the way bfast runs them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { moderationService, promotionService, opsService } from '../src/bootstrap/services.mjs';
import * as moderationRoutes from '../functions/moderation.mjs';
import * as promotionRoutes from '../functions/promotions.mjs';
import * as jobs from '../functions/jobs.mjs';
import { PORTAL_ACL_SCOPES } from '../src/services/portal-user-service.mjs';

const require = createRequire(import.meta.url);
const migration = require('../db/migrations/20261126090000-moderation-promotion.cjs');

const ROLLBACK = Symbol('rollback');
const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;
const iso = ms => new Date(Date.now() + ms).toISOString();
const made = { gyms: [], users: [], promotions: [], campaigns: [], states: [], configs: [] };

async function inRollback(fn) {
  try {
    await db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}
const refuses = (trx, fn, code) => assert.rejects(trx.transaction(fn), err => err.code === code, `expected Postgres error ${code}`);

async function makeGym(over = {}) {
  const id = uid('gym');
  await db('Gym').insert({ id, name: `Promo ${id}`, tier: 'standard', location: 'Dar es Salaam', status: 'active', updatedAt: new Date(), ...over });
  made.gyms.push(id);
  return id;
}
async function makeAdmin() {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'admin', displayName: 'Promo admin', updatedAt: new Date() });
  made.users.push(id);
  return id;
}

after(async () => {
  const ids = [...made.promotions];
  if (ids.length) {
    await db('PromotionPlacement').whereIn('promotionId', ids).del();
    await db('Promotion').whereIn('id', ids).del();
  }
  if (made.campaigns.length) await db('PromotionCampaign').whereIn('id', made.campaigns).del();
  if (made.configs.length) await db('PlacementConfig').whereIn('id', made.configs).del();
  for (const g of made.gyms) await db('ModerationEvent').where({ entityType: 'gym', entityId: g }).del();
  if (made.gyms.length) {
    await db('ModerationState').where({ entityType: 'gym' }).whereIn('entityId', made.gyms).del();
    await db('Gym').whereIn('id', made.gyms).del();
  }
  if (made.users.length) {
    await db('AuditLog').whereIn('actor', made.users).del();
    await db('User').whereIn('id', made.users).del();
  }
  await db('AuditLog').where('actor', 'like', 'promo_spec_%').del();
});

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(route, { claims, params = {}, body = {}, query = {} }) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params, body, query };
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

// ── Schema ──────────────────────────────────────────────────────────────────

test('schema: the starting geography is in place, as a tree', async () => {
  const rows = await db('GeoArea').select();
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(byId.tz.level, 'country');
  assert.equal(byId['tz-znz'].parentId, 'tz');
  assert.equal(byId['tz-znz-city'].parentId, 'tz-znz');
  assert.equal(byId['tz-znz-stone-town'].level, 'district');
  for (const r of ['Dar es Salaam', 'Zanzibar', 'Arusha', 'Dodoma', 'Mwanza']) assert.ok(rows.some(a => a.level === 'region' && a.name === r), r);
  await inRollback(async (trx) => {
    await refuses(trx, t => t('GeoArea').insert({ id: 'x', level: 'planet', name: 'x' }), '23514');
  });
});

test('schema: a promotion\'s period, status, type, priority and weight are checked by the database too', async () => {
  const gymId = await makeGym();
  const row = (over = {}) => ({
    id: uid('promo'), entityType: 'gym', entityId: gymId, type: 'featured', status: 'draft', createdBy: 'promo_spec_x',
    startsAt: new Date(Date.now() + HOUR), endsAt: new Date(Date.now() + 5 * HOUR), updatedAt: new Date(), ...over,
  });
  await inRollback(async (trx) => {
    await trx('Promotion').insert(row());                                                // a valid one goes in
    await refuses(trx, t => t('Promotion').insert(row({ endsAt: new Date(Date.now() + HOUR) })), '23514');            // end = start
    await refuses(trx, t => t('Promotion').insert(row({ endsAt: new Date(Date.now() - HOUR) })), '23514');            // end before start
    await refuses(trx, t => t('Promotion').insert(row({ status: 'live' })), '23514');
    await refuses(trx, t => t('Promotion').insert(row({ type: 'billboard' })), '23514');
    await refuses(trx, t => t('Promotion').insert(row({ entityType: 'spaceship' })), '23514');
    await refuses(trx, t => t('Promotion').insert(row({ priority: 0 })), '23514');
    await refuses(trx, t => t('Promotion').insert(row({ priority: 101 })), '23514');
    await refuses(trx, t => t('Promotion').insert(row({ boostWeight: 1.5 })), '23514');
    await refuses(trx, t => t('Promotion').insert(row({ campaignId: 'camp_missing' })), '23503');
    // Sponsored is paid, Recommended is not.
    await refuses(trx, t => t('Promotion').insert(row({ type: 'sponsored', isCommercial: false })), '23514');
    await refuses(trx, t => t('Promotion').insert(row({ type: 'recommended', isCommercial: true })), '23514');
    await trx('Promotion').insert(row({ type: 'sponsored', isCommercial: true }));
    await trx('Promotion').insert(row({ type: 'recommended', isCommercial: false }));
  });
});

test('schema: placements, limits, campaigns and moderation rows are constrained', async () => {
  const gymId = await makeGym();
  await inRollback(async (trx) => {
    const id = uid('promo');
    await trx('Promotion').insert({ id, entityType: 'gym', entityId: gymId, type: 'featured', createdBy: 'promo_spec_x', startsAt: new Date(), endsAt: new Date(Date.now() + HOUR), updatedAt: new Date() });
    await trx('PromotionPlacement').insert({ id: `${id}:home`, promotionId: id, placement: 'home' });
    await refuses(trx, t => t('PromotionPlacement').insert({ id: `${id}:home2`, promotionId: id, placement: 'home' }), '23505');   // once per placement
    await refuses(trx, t => t('PromotionPlacement').insert({ id: `${id}:x`, promotionId: id, placement: 'the_moon' }), '23514');
    await refuses(trx, t => t('PromotionPlacement').insert({ id: 'orphan:home', promotionId: 'missing', placement: 'home' }), '23503');
    await trx('Promotion').where({ id }).del();
    assert.equal((await trx('PromotionPlacement').where({ promotionId: id })).length, 0);                         // cascades

    await trx('PlacementConfig').insert({ id: 'home:featured', placement: 'home', promotionType: 'featured', maxSlots: 3 });
    await refuses(trx, t => t('PlacementConfig').insert({ id: 'home:featured2', placement: 'home', promotionType: 'featured', maxSlots: 3 }), '23505');
    await refuses(trx, t => t('PlacementConfig').insert({ id: 'home:promoted', placement: 'home', promotionType: 'promoted', maxSlots: -1 }), '23514');
    await refuses(trx, t => t('PlacementConfig').insert({ id: 'home:sponsored', placement: 'home', promotionType: 'sponsored', maxSlots: 1, maxBoostFraction: 1.2 }), '23514');
    await refuses(trx, t => t('PlacementConfig').insert({ id: 'home:recommended', placement: 'home', promotionType: 'recommended', maxSlots: 1, rotationMode: 'random' }), '23514');

    await refuses(trx, t => t('PromotionCampaign').insert({ id: 'c1', name: 'x', startsAt: new Date(), endsAt: new Date(Date.now() - HOUR), createdBy: 'a' }), '23514');
    await refuses(trx, t => t('PromotionCampaign').insert({ id: 'c2', name: 'x', status: 'weird', startsAt: new Date(), endsAt: new Date(Date.now() + HOUR), createdBy: 'a' }), '23514');

    await trx('ModerationState').insert({ id: `gym:${gymId}`, entityType: 'gym', entityId: gymId, status: 'suspended' });
    await refuses(trx, t => t('ModerationState').insert({ id: `gym:${gymId}:2`, entityType: 'gym', entityId: gymId, status: 'approved' }), '23505');   // one row per entity
    await refuses(trx, t => t('ModerationState').insert({ id: 'x', entityType: 'gym', entityId: 'y', status: 'maybe' }), '23514');
  });
});

test('schema: gyms and trainers gain nullable area columns; existing rows are unharmed', async () => {
  const gymId = await makeGym({ location: 'Somewhere unknown 123' });
  const g = await db('Gym').where({ id: gymId }).first();
  assert.equal(g.regionId, null);
  assert.equal(g.status, 'active');
  await inRollback(async (trx) => {
    await refuses(trx, t => t('Gym').where({ id: gymId }).update({ regionId: 'atlantis' }), '23503');
  });
});

test('backfill: a gym whose address names a known place gets its region and city; others are left alone; nothing is overwritten', async () => {
  await inRollback(async (trx) => {
    const mk = async (location, over = {}) => {
      const id = uid('gym');
      await trx('Gym').insert({ id, name: id, tier: 'standard', location, status: 'active', updatedAt: new Date(), ...over });
      return id;
    };
    const stone = await mk('Kiponda Street, Stone Town, Zanzibar');
    const dar = await mk('Masaki, dar es salaam');
    const znz = await mk('Zanzibar');
    const unknown = await mk('Nairobi, Kenya');
    const preset = await mk('Arusha', { regionId: 'tz-dar', cityId: 'tz-dar-city' });
    await migration.up(trx);                                                             // the fill is re-runnable
    const get = id => trx('Gym').where({ id }).first();
    assert.deepEqual([(await get(stone)).regionId, (await get(stone)).cityId], ['tz-znz', 'tz-znz-city']);
    assert.deepEqual([(await get(dar)).regionId, (await get(dar)).cityId], ['tz-dar', 'tz-dar-city']);
    assert.equal((await get(znz)).regionId, 'tz-znz');
    assert.equal((await get(unknown)).regionId, null);
    assert.equal((await get(preset)).regionId, 'tz-dar');                                // a value already set is never overwritten
  });
});

// ── Store round trip: real tables, real services ────────────────────────────

test('round trip: moderation and a promotion\'s whole life through the real store', async () => {
  const gymId = await makeGym();
  const maker = await makeAdmin();
  const checker = await makeAdmin();

  assert.equal(await moderationService.statusOf('gym', gymId), 'approved');              // no row yet
  const created = await promotionService.create({
    actorId: maker,
    body: {
      entityType: 'gym', entityId: gymId, type: 'featured', placements: ['gym_discovery', 'home'],
      startsAt: iso(-HOUR), endsAt: iso(48 * HOUR), priority: 2, geoScope: { areaIds: ['tz-dar'] }, categories: ['boxing'],
      audience: { minAge: 18 }, notes: 'launch',
    },
  });
  assert.equal(created.error, undefined, JSON.stringify(created));
  const id = created.promotion.id;
  made.promotions.push(id);
  made.configs.push('gym_discovery:featured');

  assert.equal((await promotionService.submit({ id, actorId: maker })).error, undefined);
  assert.equal((await promotionService.approve({ id, actorId: maker })).error, 'cannot_approve_own_submission');
  assert.equal((await promotionService.approve({ id, actorId: checker })).error, undefined);
  assert.equal((await promotionService.activate({ id, actorId: checker })).promotion.status, 'active');

  const stored = await db('Promotion').where({ id }).first();
  assert.deepEqual(stored.geoScope, { areaIds: ['tz-dar'] });                            // jsonb round-trips as an object
  assert.deepEqual(stored.categories, ['boxing']);
  assert.equal(stored.approvedBy, checker);
  assert.ok(stored.startsAt instanceof Date && stored.activatedAt instanceof Date);
  assert.deepEqual((await db('PromotionPlacement').where({ promotionId: id }).pluck('placement')).sort(), ['gym_discovery', 'home']);

  const live = await promotionService.listLive({ placement: 'gym_discovery', viewer: { areaIds: ['tz-dar-city'] } });
  assert.ok(live.some(p => p.id === id));
  assert.ok(!(await promotionService.listLive({ placement: 'gym_discovery', viewer: { areaIds: ['tz-znz'] } })).some(p => p.id === id));   // wrong region

  // Suspending the gym stops its promotion and writes history.
  const sus = await moderationService.decide({ entityType: 'gym', entityId: gymId, action: 'suspend', reason: 'complaint', actorId: checker });
  assert.equal(sus.heldPromotions, 1);
  assert.equal((await db('Promotion').where({ id }).first()).status, 'paused');
  assert.ok(!(await promotionService.listLive({ placement: 'gym_discovery' })).some(p => p.id === id));
  const events = await db('ModerationEvent').where({ entityType: 'gym', entityId: gymId });
  assert.deepEqual(events.map(e => [e.action, e.fromStatus, e.toStatus, e.actor]), [['suspend', 'approved', 'suspended', checker]]);
  assert.equal((await promotionService.resume({ id, actorId: checker })).error, 'entity_not_promotable');
  await moderationService.decide({ entityType: 'gym', entityId: gymId, action: 'restore', actorId: checker });
  assert.equal((await promotionService.resume({ id, actorId: checker })).promotion.status, 'active');

  // Every step is in the audit log, in order, with who did it.
  const trail = await db('AuditLog').where({ target: id }).orderBy('at').pluck('action');
  for (const a of ['promotion.created', 'promotion.submitted', 'promotion.approved', 'promotion.activated', 'promotion.paused', 'promotion.resumed']) assert.ok(trail.includes(a), a);
  assert.ok((await db('AuditLog').where({ target: `gym:${gymId}`, action: 'moderation.suspend' }).first()).after.reason === 'complaint');

  // The job moves it on when its time passes.
  await db('Promotion').where({ id }).update({ startsAt: new Date(Date.now() - 3 * HOUR), endsAt: new Date(Date.now() - HOUR) });
  assert.equal((await promotionService.listLive({ placement: 'gym_discovery' })).some(p => p.id === id), false);       // already out before the job runs
  const run = await promotionService.runLifecycle();
  assert.ok(run.expired >= 1);
  assert.equal((await db('Promotion').where({ id }).first()).status, 'expired');
});

test('round trip: placement limits and campaigns persist', async () => {
  const admin = await makeAdmin();
  const set = await promotionService.setLimit({ placement: 'trainer_discovery', promotionType: 'promoted', maxSlots: 7, maxBoostFraction: 0.15, actorId: admin });
  assert.equal(set.error, undefined);
  made.configs.push('trainer_discovery:promoted');
  const row = await db('PlacementConfig').where({ id: 'trainer_discovery:promoted' }).first();
  assert.deepEqual([row.maxSlots, row.maxBoostFraction], [7, 0.15]);
  const limit = (await promotionService.limits()).find(l => l.placement === 'trainer_discovery' && l.promotionType === 'promoted');
  assert.deepEqual([limit.maxSlots, limit.source], [7, 'config']);
  await db('PlacementConfig').where({ id: 'trainer_discovery:promoted' }).del();

  const c = await promotionService.createCampaign({ actorId: admin, body: { name: 'Zanzibar Fitness Week', startsAt: iso(HOUR), endsAt: iso(100 * HOUR), geoScope: { areaIds: ['tz-znz'] } } });
  assert.equal(c.error, undefined);
  made.campaigns.push(c.campaign.id);
  assert.deepEqual((await db('PromotionCampaign').where({ id: c.campaign.id }).first()).geoScope, { areaIds: ['tz-znz'] });
});

// ── Routes and permissions ──────────────────────────────────────────────────

test('routes: viewing, managing, approving and moderating are separate grants', async () => {
  const gymId = await makeGym();
  const maker = await makeAdmin();
  const checker = await makeAdmin();
  const viewer = await makeAdmin();
  const body = { entityType: 'gym', entityId: gymId, type: 'promoted', placements: ['search_results'], startsAt: iso(HOUR), endsAt: iso(30 * HOUR) };

  // No token / wrong role / no scope.
  assert.equal((await call(promotionRoutes.listPromotions, {})).statusCode, 401);
  assert.equal((await call(promotionRoutes.listPromotions, { claims: { sub: maker, userType: 'member' } })).statusCode, 403);
  assert.equal((await call(promotionRoutes.listPromotions, { claims: staff(viewer, 'gyms') })).body.error, 'acl_forbidden');

  // Create needs promotions; viewing alone is not enough.
  assert.equal((await call(promotionRoutes.createPromotion, { claims: staff(viewer, 'campaigns'), body })).statusCode, 403);
  const made1 = await call(promotionRoutes.createPromotion, { claims: staff(maker, 'promotions'), body });
  assert.equal(made1.statusCode, 201, JSON.stringify(made1.body));
  const id = made1.body.promotion.id;
  made.promotions.push(id);

  // A creator with only `promotions` can submit but not approve; approval is a separate scope and never one's own.
  assert.equal((await call(promotionRoutes.submitPromotion, { claims: staff(maker, 'promotions'), params: { id } })).statusCode, 200);
  assert.equal((await call(promotionRoutes.approvePromotion, { claims: staff(maker, 'promotions'), params: { id } })).statusCode, 403);
  const self = await call(promotionRoutes.approvePromotion, { claims: staff(maker, 'promotions', 'promotions_approve'), params: { id } });
  assert.equal(self.body.error, 'cannot_approve_own_submission');
  const done = await call(promotionRoutes.approvePromotion, { claims: staff(checker, 'promotions_approve'), params: { id } });
  assert.equal(done.statusCode, 200, JSON.stringify(done.body));
  assert.equal(done.body.promotion.status, 'approved');

  // A viewer with promotions_approve alone can read the list and the detail.
  const list = await call(promotionRoutes.listPromotions, { claims: staff(checker, 'promotions_approve'), query: { status: 'approved' } });
  assert.equal(list.statusCode, 200);
  assert.ok(list.body.items.some(p => p.id === id));
  // Analytics-only staff have their own read routes; they cannot open a promotion's notes, references and history.
  assert.equal((await call(promotionRoutes.getPromotion, { claims: staff(checker, 'promotion_analytics'), params: { id } })).statusCode, 403);
  const detail = await call(promotionRoutes.getPromotion, { claims: staff(checker, 'promotions_approve'), params: { id } });
  assert.equal(detail.statusCode, 200);
  assert.ok(detail.body.history.length >= 3);
  assert.ok(detail.body.allowedActions.includes('schedule'));

  // Errors carry their HTTP status.
  assert.equal((await call(promotionRoutes.getPromotion, { claims: staff(viewer, 'promotions'), params: { id: 'nope' } })).statusCode, 404);
  assert.equal((await call(promotionRoutes.cancelPromotion, { claims: staff(maker, 'promotions'), params: { id }, body: {} })).statusCode, 400);   // reason needed
  const notEditable = await call(promotionRoutes.updatePromotion, { claims: staff(maker, 'promotions'), params: { id }, body: { entityId: 'x' } });
  assert.equal(notEditable.statusCode, 409);
  assert.equal(notEditable.body.error, 'field_locked');
  const bad = await call(promotionRoutes.createPromotion, { claims: staff(maker, 'promotions'), body: { ...body, endsAt: body.startsAt } });
  assert.equal(bad.statusCode, 422);
  assert.equal(bad.body.error, 'end_before_start');
  await call(promotionRoutes.cancelPromotion, { claims: staff(maker, 'promotions'), params: { id }, body: { reason: 'test over' } });
});

test('routes: moderation is gated by its own scopes, and a decision pauses the entity\'s promotions', async () => {
  const gymId = await makeGym();
  const mod = await makeAdmin();
  const look = await makeAdmin();
  const vs = (sub, ...s) => ({ claims: staff(sub, ...s), params: { entityType: 'gym', entityId: gymId } });

  assert.equal((await call(moderationRoutes.moderationQueue, { claims: staff(look, 'promotions'), query: { entityType: 'gym' } })).statusCode, 403);
  const queue = await call(moderationRoutes.moderationQueue, { claims: staff(look, 'moderation'), query: { entityType: 'gym', q: gymId } });
  assert.equal(queue.statusCode, 200);
  assert.equal(queue.body.items[0].moderationStatus, 'approved');
  assert.equal((await call(moderationRoutes.moderationQueue, { claims: staff(look, 'moderation'), query: { entityType: 'robot' } })).statusCode, 400);

  // Looking is not deciding.
  assert.equal((await call(moderationRoutes.moderationSuspend, { ...vs(look, 'moderation'), body: { reason: 'x' } })).statusCode, 403);
  assert.equal((await call(moderationRoutes.moderationSuspend, { ...vs(mod, 'moderation_decide'), body: {} })).body.error, 'reason_required');
  const ok = await call(moderationRoutes.moderationSuspend, { ...vs(mod, 'moderation_decide'), body: { reason: 'unsafe equipment' } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.from, ok.body.to], ['approved', 'suspended']);

  const detail = await call(moderationRoutes.moderationDetail, vs(look, 'moderation'));
  assert.equal(detail.body.moderationStatus, 'suspended');
  assert.equal(detail.body.eligibility.ok, false);
  assert.equal(detail.body.history[0].actor, mod);
  assert.ok(detail.body.allowedActions.some(a => a.action === 'restore'));

  assert.equal((await call(moderationRoutes.moderationApprove, { ...vs(mod, 'moderation_decide') })).statusCode, 409);   // nothing pending
  assert.equal((await call(moderationRoutes.moderationRestore, vs(mod, 'moderation_decide'))).body.to, 'approved');
  assert.equal((await call(moderationRoutes.moderationDetail, { claims: staff(look, 'moderation'), params: { entityType: 'gym', entityId: 'nope' } })).statusCode, 404);
  const counts = await call(moderationRoutes.moderationCounts, { claims: { sub: look, userType: 'admin' } });   // a full admin needs no scope
  assert.equal(counts.statusCode, 200);
});

test('routes: limits, campaigns and geography need the campaigns scope', async () => {
  const admin = await makeAdmin();
  const put = (claims, body) => call(promotionRoutes.setPromotionLimit, { claims, params: { placement: 'vendor_discovery', promotionType: 'featured' }, body });
  assert.equal((await put(staff(admin, 'promotions'), { maxSlots: 2 })).statusCode, 403);
  const set = await put(staff(admin, 'campaigns'), { maxSlots: 2 });
  assert.equal(set.statusCode, 200);
  made.configs.push('vendor_discovery:featured');
  assert.equal((await put(staff(admin, 'campaigns'), { maxSlots: 'lots' })).statusCode, 400);
  await db('PlacementConfig').where({ id: 'vendor_discovery:featured' }).del();

  const camp = await call(promotionRoutes.createCampaign, { claims: staff(admin, 'campaigns'), body: { name: 'Route test', startsAt: iso(HOUR), endsAt: iso(5 * HOUR) } });
  assert.equal(camp.statusCode, 201);
  made.campaigns.push(camp.body.campaign.id);
  assert.equal((await call(promotionRoutes.createCampaign, { claims: staff(admin, 'promotions'), body: {} })).statusCode, 403);
  assert.equal((await call(promotionRoutes.startCampaign, { claims: staff(admin, 'campaigns'), params: { id: camp.body.campaign.id } })).body.campaign.status, 'active');
  const areas = await call(promotionRoutes.listGeoAreas, { claims: staff(admin, 'promotions') });
  assert.ok(areas.body.areas.length >= 12);
  const ref = await call(promotionRoutes.promotionReference, { claims: staff(admin, 'promotions') });
  assert.ok(ref.body.placements.marketplace);
  const prev = await call(promotionRoutes.promotionPreview, { claims: staff(admin, 'promotions'), body: { entityType: 'gym', entityId: 'nope', type: 'featured', placements: ['home'], startsAt: iso(HOUR), endsAt: iso(5 * HOUR) } });
  assert.equal(prev.statusCode, 404);
});

test('routes: the wizard lookups need the promotions scope and answer from the real tables', async () => {
  const admin = await makeAdmin();
  const gymId = await makeGym({ name: 'Lookup Gym Zanzibar' });
  assert.equal((await call(promotionRoutes.searchPromotionEntities, { claims: staff(admin, 'moderation'), query: { entityType: 'gym' } })).statusCode, 403);
  const found = await call(promotionRoutes.searchPromotionEntities, { claims: staff(admin, 'promotions'), query: { entityType: 'gym', q: 'lookup gym zanzibar' } });
  assert.equal(found.statusCode, 200);
  assert.deepEqual(found.body.items.map(i => [i.id, i.promotable]), [[gymId, true]]);
  assert.equal((await call(promotionRoutes.searchPromotionEntities, { claims: staff(admin, 'promotions'), query: { entityType: 'nope' } })).statusCode, 400);
  const partners = await call(promotionRoutes.searchPromotionPartners, { claims: staff(admin, 'promotions'), query: { q: 'zzz-no-such-organisation' } });
  assert.equal(partners.statusCode, 200);
  assert.deepEqual(partners.body.items, []);
  assert.equal((await call(promotionRoutes.searchPromotionPartners, { claims: staff(admin, 'campaigns') })).statusCode, 403);
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test('wiring: new scopes are grantable, and the lifecycle job is registered and runnable', async () => {
  for (const s of ['moderation', 'moderation_decide', 'promotions', 'promotions_approve', 'campaigns', 'promotion_analytics']) assert.ok(PORTAL_ACL_SCOPES.includes(s), s);
  assert.equal(jobs.promotionLifecycle.rule, '*/5 * * * *');
  const run = await opsService.runJob('promotion-lifecycle', { trigger: 'manual', actorId: 'promo_spec_ops' });
  assert.notEqual(run.error, 'unknown_job');
  assert.notEqual(run.status, 'failed', JSON.stringify(run));
});
