// Moderation & promotion services against in-memory stores: the lifecycle end to
// end, who may do what, the integrity rules, capacity, and what discovery will
// be told is live. No database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, promoBody, approved, iso, HOUR, DAY } from './support/promotion-fixtures.mjs';

const ok = (out) => { assert.equal(out.error, undefined, JSON.stringify(out)); return out; };
const err = (out, code, status) => {
  assert.equal(out.error, code, JSON.stringify(out));
  if (status) assert.equal(out.status, status);
  return out;
};

// ── Creating ────────────────────────────────────────────────────────────────

test('create: saves a draft with its placements and writes an audit entry', async () => {
  const w = makeWorld();
  const { promotion } = ok(await w.promotionService.create({ body: promoBody(w.clock, { placements: ['gym_discovery', 'home'] }), actorId: 'a1' }));
  assert.equal(promotion.status, 'draft');
  assert.deepEqual(promotion.placements, ['gym_discovery', 'home']);
  assert.equal(promotion.entity.name, 'Gym A');
  assert.equal(promotion.createdBy, 'a1');
  const audit = w.stores.auditLog.rows.find(a => a.action === 'promotion.created' && a.target === promotion.id);
  assert.equal(audit.actor, 'a1');
  assert.equal(audit.after.status, 'draft');
});

test('create: server-side integrity rules', async () => {
  const w = makeWorld();
  const c = (over) => w.promotionService.create({ body: promoBody(w.clock, over), actorId: 'a1' });
  err(await c({ startsAt: iso(w.clock, 5 * HOUR), endsAt: iso(w.clock, 2 * HOUR) }), 'end_before_start', 422);
  err(await c({ endsAt: iso(w.clock, HOUR) , startsAt: iso(w.clock, HOUR) }), 'end_before_start', 422);
  err(await c({ startsAt: iso(w.clock, -3 * DAY), endsAt: iso(w.clock, -2 * DAY) }), 'period_in_past', 422);
  err(await c({ entityId: 'nope' }), 'entity_not_found', 404);
  err(await c({ placements: ['trainer_discovery'] }), 'placement_not_valid_for_entity', 422);
  err(await c({ placements: [] }), 'placements_required', 422);
  err(await c({ type: 'tv_ad' }), 'invalid_promotion_type', 422);
  err(await w.promotionService.create({ body: promoBody(w.clock), actorId: null }), 'actor_required', 403);
});

test('create: the entity type must match the entity id', async () => {
  const w = makeWorld();
  const out = err(await w.promotionService.create({ body: promoBody(w.clock, { entityType: 'trainer', entityId: 'gym_a', placements: ['trainer_discovery'] }), actorId: 'a1' }), 'entity_type_mismatch', 422);
  assert.equal(out.foundAs, 'gym');
});

test('create: rejected, suspended and hidden entities cannot be promoted', async () => {
  const w = makeWorld();
  await w.moderationService.decide({ entityType: 'gym', entityId: 'gym_a', action: 'require_review', reason: 'check', actorId: 'm1' });
  await w.moderationService.decide({ entityType: 'gym', entityId: 'gym_a', action: 'reject', reason: 'no', actorId: 'm1' });
  err(await w.promotionService.create({ body: promoBody(w.clock), actorId: 'a1' }), 'entity_not_promotable', 409);

  await w.moderationService.decide({ entityType: 'gym', entityId: 'gym_b', action: 'suspend', reason: 'x', actorId: 'm1' });
  const s = err(await w.promotionService.create({ body: promoBody(w.clock, { entityId: 'gym_b' }), actorId: 'a1' }), 'entity_not_promotable', 409);
  assert.deepEqual(s.reasons, ['moderation_suspended']);

  await w.moderationService.decide({ entityType: 'gym', entityId: 'gym_c', action: 'hide', reason: 'x', actorId: 'm1' });
  err(await w.promotionService.create({ body: promoBody(w.clock, { entityId: 'gym_c' }), actorId: 'a1' }), 'entity_not_promotable', 409);
});

test('create: Sponsored is paid by default, Recommended is not', async () => {
  const w = makeWorld();
  const s = ok(await w.promotionService.create({ body: promoBody(w.clock, { type: 'sponsored', relationshipType: 'paid_advertising', commercialRef: 'INV-1' }), actorId: 'a1' }));
  assert.equal(s.promotion.isCommercial, true);
  assert.equal(s.promotion.label, 'Sponsored');
  const r = ok(await w.promotionService.create({ body: promoBody(w.clock, { type: 'recommended', relationshipType: 'editorial' }), actorId: 'a1' }));
  assert.equal(r.promotion.isCommercial, false);
  assert.equal(r.promotion.label, 'Recommended by FitFlex');
  err(await w.promotionService.create({ body: promoBody(w.clock, { type: 'recommended', isCommercial: true, relationshipType: 'paid_advertising' }), actorId: 'a1' }), 'recommended_cannot_be_commercial', 422);
  err(await w.promotionService.create({ body: promoBody(w.clock, { type: 'sponsored', isCommercial: false }), actorId: 'a1' }), 'sponsored_requires_commercial', 422);
});

test('create: products and vendors can be promoted in their own placements', async () => {
  const w = makeWorld();
  ok(await w.promotionService.create({ body: promoBody(w.clock, { entityType: 'product', entityId: 'prod_1', placements: ['marketplace'] }), actorId: 'a1' }));
  ok(await w.promotionService.create({ body: promoBody(w.clock, { entityType: 'vendor', entityId: 'usr_v1', placements: ['vendor_discovery', 'marketplace'] }), actorId: 'a1' }));
  ok(await w.promotionService.create({ body: promoBody(w.clock, { entityType: 'trainer', entityId: 'tr_1', placements: ['trainer_discovery'] }), actorId: 'a1' }));
  err(await w.promotionService.create({ body: promoBody(w.clock, { entityType: 'product', entityId: 'prod_1', placements: ['gym_discovery'] }), actorId: 'a1' }), 'placement_not_valid_for_entity', 422);
});

test('create: a geographic scope must name known areas', async () => {
  const w = makeWorld();
  ok(await w.promotionService.create({ body: promoBody(w.clock, { geoScope: { areaIds: ['tz-znz'] } }), actorId: 'a1' }));
  const out = err(await w.promotionService.create({ body: promoBody(w.clock, { geoScope: { areaIds: ['atlantis'] } }), actorId: 'a1' }), 'unknown_geo_area', 422);
  assert.deepEqual(out.areaIds, ['atlantis']);
});

// ── Approval ────────────────────────────────────────────────────────────────

test('approval: a different person must approve, and the entity must still be eligible', async () => {
  const w = makeWorld();
  const { promotion } = ok(await w.promotionService.create({ body: promoBody(w.clock), actorId: 'maker' }));
  err(await w.promotionService.approve({ id: promotion.id, actorId: 'checker' }), 'invalid_transition', 409);   // not submitted yet
  ok(await w.promotionService.submit({ id: promotion.id, actorId: 'maker' }));
  err(await w.promotionService.approve({ id: promotion.id, actorId: 'maker' }), 'cannot_approve_own_submission', 403);
  // Submitted by one person, created by another: the submitter cannot approve either.
  const second = ok(await w.promotionService.create({ body: promoBody(w.clock, { entityId: 'gym_b' }), actorId: 'maker' }));
  ok(await w.promotionService.submit({ id: second.promotion.id, actorId: 'other' }));
  err(await w.promotionService.approve({ id: second.promotion.id, actorId: 'other' }), 'cannot_approve_own_submission', 403);
  const done = ok(await w.promotionService.approve({ id: promotion.id, actorId: 'checker' }));
  assert.equal(done.promotion.status, 'approved');
  assert.equal(done.promotion.approvedBy, 'checker');
});

test('approval: an entity suspended after submission blocks approval', async () => {
  const w = makeWorld();
  const { promotion } = ok(await w.promotionService.create({ body: promoBody(w.clock), actorId: 'maker' }));
  ok(await w.promotionService.submit({ id: promotion.id, actorId: 'maker' }));
  await w.moderationService.decide({ entityType: 'gym', entityId: 'gym_a', action: 'suspend', reason: 'complaint', actorId: 'm1' });
  err(await w.promotionService.approve({ id: promotion.id, actorId: 'checker' }), 'entity_not_promotable', 409);
});

test('approval: a gym that is not active, or a vendor that is not live, is not promotable', async () => {
  const w = makeWorld();
  const off = ok(await w.promotionService.create({ body: promoBody(w.clock, { entityId: 'gym_off' }), actorId: 'maker' }));    // a draft is allowed
  ok(await w.promotionService.submit({ id: off.promotion.id, actorId: 'maker' }));
  const out = err(await w.promotionService.approve({ id: off.promotion.id, actorId: 'checker' }), 'entity_not_promotable', 409);
  assert.deepEqual(out.reasons, ['gym_not_active']);

  const w2 = makeWorld({ operational: () => false });
  const p = ok(await w2.promotionService.create({ body: promoBody(w2.clock, { entityType: 'product', entityId: 'prod_1', placements: ['marketplace'] }), actorId: 'maker' }));
  ok(await w2.promotionService.submit({ id: p.promotion.id, actorId: 'maker' }));
  assert.deepEqual(err(await w2.promotionService.approve({ id: p.promotion.id, actorId: 'checker' }), 'entity_not_promotable').reasons, ['vendor_not_operational']);
});

test('approval: reject needs a reason, and a rejected promotion can be reopened and resubmitted', async () => {
  const w = makeWorld();
  const { promotion } = ok(await w.promotionService.create({ body: promoBody(w.clock), actorId: 'maker' }));
  ok(await w.promotionService.submit({ id: promotion.id, actorId: 'maker' }));
  err(await w.promotionService.reject({ id: promotion.id, actorId: 'checker', reason: ' ' }), 'reason_required', 400);
  ok(await w.promotionService.reject({ id: promotion.id, actorId: 'checker', reason: 'wrong dates' }));
  err(await w.promotionService.approve({ id: promotion.id, actorId: 'checker' }), 'invalid_transition', 409);
  ok(await w.promotionService.reopen({ id: promotion.id, actorId: 'maker' }));
  ok(await w.promotionService.update({ id: promotion.id, body: { priority: 1 }, actorId: 'maker' }));
  ok(await w.promotionService.submit({ id: promotion.id, actorId: 'maker' }));
  ok(await w.promotionService.approve({ id: promotion.id, actorId: 'checker' }));
});

test('approval: a commercial promotion must say what the arrangement is', async () => {
  const w = makeWorld();
  const { promotion } = ok(await w.promotionService.create({ body: promoBody(w.clock, { type: 'sponsored', relationshipType: 'paid_advertising' }), actorId: 'maker' }));
  err(await w.promotionService.submit({ id: promotion.id, actorId: 'maker' }), 'commercial_reference_required', 422);
  ok(await w.promotionService.update({ id: promotion.id, body: { commercialRef: 'CONTRACT-77' }, actorId: 'maker' }));
  ok(await w.promotionService.submit({ id: promotion.id, actorId: 'maker' }));
});

// ── Schedule, activate, pause, resume, expire ───────────────────────────────

test('lifecycle: schedule, then the job starts it at its start and expires it at its end', async () => {
  const w = makeWorld();
  const p = await approved(w);
  ok(await w.promotionService.schedule({ id: p.id, actorId: 'checker' }));
  assert.equal((await w.promotionService.runLifecycle()).activated, 0);                  // not yet
  w.clock.advance(HOUR + 1000);
  const run = await w.promotionService.runLifecycle();
  assert.equal(run.activated, 1);
  assert.equal((await w.promotionService.get(p.id)).promotion.status, 'active');
  assert.equal((await w.promotionService.runLifecycle()).activated, 0);                  // idempotent
  w.clock.advance(8 * DAY);
  assert.equal((await w.promotionService.runLifecycle()).expired, 1);
  assert.equal((await w.promotionService.get(p.id)).promotion.status, 'expired');
  assert.equal((await w.promotionService.runLifecycle()).expired, 0);
  const actions = w.stores.auditLog.rows.filter(a => a.target === p.id).map(a => a.action);
  for (const a of ['promotion.created', 'promotion.submitted', 'promotion.approved', 'promotion.scheduled', 'promotion.activated', 'promotion.expired']) assert.ok(actions.includes(a), a);
});

test('lifecycle: activate now needs the start to have arrived; schedule needs it to be ahead', async () => {
  const w = makeWorld();
  const p = await approved(w);                                                           // starts in an hour
  err(await w.promotionService.activate({ id: p.id, actorId: 'checker' }), 'start_in_future', 409);
  w.clock.advance(2 * HOUR);
  err(await w.promotionService.schedule({ id: p.id, actorId: 'checker' }), 'start_not_in_future', 409);
  ok(await w.promotionService.activate({ id: p.id, actorId: 'checker' }));
});

test('lifecycle: an expired promotion cannot be activated, resumed or scheduled, even before the job runs', async () => {
  const w = makeWorld();
  const p = await approved(w);
  w.clock.advance(10 * DAY);                                                             // past its end; job has not run
  err(await w.promotionService.activate({ id: p.id, actorId: 'checker' }), 'promotion_expired', 409);
  err(await w.promotionService.schedule({ id: p.id, actorId: 'checker' }), 'promotion_expired', 409);

  const w2 = makeWorld();
  const q = await approved(w2);
  w2.clock.advance(2 * HOUR);
  ok(await w2.promotionService.activate({ id: q.id, actorId: 'c' }));
  ok(await w2.promotionService.pause({ id: q.id, actorId: 'c', reason: 'hold' }));
  w2.clock.advance(10 * DAY);
  err(await w2.promotionService.resume({ id: q.id, actorId: 'c' }), 'promotion_expired', 409);
  assert.equal((await w2.promotionService.get(q.id)).promotion.status, 'expired');
});

test('lifecycle: pause stops a promotion, resume restores it, and a promotion resumed before its start is scheduled again', async () => {
  const w = makeWorld();
  const p = await approved(w);
  ok(await w.promotionService.schedule({ id: p.id, actorId: 'c' }));
  ok(await w.promotionService.pause({ id: p.id, actorId: 'c' }));
  assert.equal((await w.promotionService.listLive({ placement: 'gym_discovery' })).length, 0);
  assert.equal(ok(await w.promotionService.resume({ id: p.id, actorId: 'c' })).promotion.status, 'scheduled');   // before its start
  w.clock.advance(2 * HOUR);
  await w.promotionService.runLifecycle();
  assert.equal((await w.promotionService.listLive({ placement: 'gym_discovery' })).length, 1);
  ok(await w.promotionService.pause({ id: p.id, actorId: 'c', reason: 'dispute' }));
  assert.equal((await w.promotionService.listLive({ placement: 'gym_discovery' })).length, 0);       // paused has no effect
  assert.equal(ok(await w.promotionService.resume({ id: p.id, actorId: 'c' })).promotion.status, 'active');
  assert.equal((await w.promotionService.listLive({ placement: 'gym_discovery' })).length, 1);
  err(await w.promotionService.resume({ id: p.id, actorId: 'c' }), 'invalid_transition', 409);
});

test('lifecycle: cancel needs a reason; finished promotions are final', async () => {
  const w = makeWorld();
  const p = await approved(w);
  err(await w.promotionService.cancel({ id: p.id, actorId: 'c' }), 'reason_required', 400);
  ok(await w.promotionService.cancel({ id: p.id, actorId: 'c', reason: 'client withdrew' }));
  err(await w.promotionService.activate({ id: p.id, actorId: 'c' }), 'invalid_transition', 409);
  err(await w.promotionService.cancel({ id: p.id, actorId: 'c', reason: 'again' }), 'invalid_transition', 409);
  err(await w.promotionService.update({ id: p.id, body: { priority: 1 }, actorId: 'c' }), 'not_editable', 409);
});

test('lifecycle: a live promotion can be closed early, and an expired one acknowledged', async () => {
  const w = makeWorld();
  const p = await approved(w);
  w.clock.advance(2 * HOUR);
  ok(await w.promotionService.activate({ id: p.id, actorId: 'c' }));
  assert.equal(ok(await w.promotionService.complete({ id: p.id, actorId: 'c' })).promotion.status, 'completed');
  const q = await approved(w, { entityId: 'gym_b' });
  w.clock.advance(20 * DAY);
  await w.promotionService.runLifecycle();
  assert.equal(ok(await w.promotionService.complete({ id: q.id, actorId: 'c' })).promotion.status, 'completed');
});

// ── Editing ─────────────────────────────────────────────────────────────────

test('edit: a draft is fully editable and re-validated', async () => {
  const w = makeWorld();
  const { promotion } = ok(await w.promotionService.create({ body: promoBody(w.clock), actorId: 'a1' }));
  const out = ok(await w.promotionService.update({ id: promotion.id, body: { priority: 1, placements: ['gym_discovery', 'search_results'], notes: 'launch' }, actorId: 'a1' }));
  assert.equal(out.promotion.priority, 1);
  assert.deepEqual(out.promotion.placements, ['gym_discovery', 'search_results']);
  err(await w.promotionService.update({ id: promotion.id, body: { endsAt: iso(w.clock, -HOUR) }, actorId: 'a1' }), 'end_before_start', 422);
  err(await w.promotionService.update({ id: promotion.id, body: { placements: ['trainer_discovery'] }, actorId: 'a1' }), 'placement_not_valid_for_entity', 422);
  err(await w.promotionService.update({ id: 'missing', body: {}, actorId: 'a1' }), 'promotion_not_found', 404);
});

test('edit: once approved only priority, weight, end date and references can change — and the change is audited', async () => {
  const w = makeWorld();
  const p = await approved(w, { priority: 5 });
  err(await w.promotionService.update({ id: p.id, body: { entityId: 'gym_b' }, actorId: 'c' }), 'field_locked', 409);
  err(await w.promotionService.update({ id: p.id, body: { startsAt: iso(w.clock, 2 * HOUR) }, actorId: 'c' }), 'field_locked', 409);
  const out = ok(await w.promotionService.update({ id: p.id, body: { priority: 2 }, actorId: 'c' }));
  assert.equal(out.promotion.priority, 2);
  const entry = w.stores.auditLog.rows.find(a => a.action === 'promotion.updated' && a.target === p.id);
  assert.equal(entry.before.priority, 5);
  assert.equal(entry.after.priority, 2);
  assert.equal(entry.actor, 'c');
  // A submitted promotion must be reopened first, so the approver sees what was submitted.
  const q = ok(await w.promotionService.create({ body: promoBody(w.clock, { entityId: 'gym_b' }), actorId: 'm' }));
  ok(await w.promotionService.submit({ id: q.promotion.id, actorId: 'm' }));
  err(await w.promotionService.update({ id: q.promotion.id, body: { priority: 1 }, actorId: 'm' }), 'not_editable', 409);
});

// ── Capacity ────────────────────────────────────────────────────────────────

test('capacity: approval is refused when the placement is full, and a configured limit overrides the default', async () => {
  const w = makeWorld();
  ok(await w.promotionService.setLimit({ placement: 'gym_discovery', promotionType: 'featured', maxSlots: 2, actorId: 'admin' }));
  await approved(w, { entityId: 'gym_a' });
  await approved(w, { entityId: 'gym_b' });
  const third = ok(await w.promotionService.create({ body: promoBody(w.clock, { entityId: 'gym_c' }), actorId: 'maker' }));
  const sub = ok(await w.promotionService.submit({ id: third.promotion.id, actorId: 'maker' }));
  assert.equal(sub.warnings[0].code, 'placement_full');                                  // warned at submit
  const out = err(await w.promotionService.approve({ id: third.promotion.id, actorId: 'checker' }), 'placement_full', 409);
  assert.equal(out.capacity[0].placement, 'gym_discovery');
  assert.equal(out.capacity[0].max, 2);
});

test('capacity: the default limit is enforced without any configuration', async () => {
  const w = makeWorld();
  for (let i = 0; i < 5; i += 1) {
    w.stores.gyms.rows.push({ id: `gym_x${i}`, name: `X${i}`, status: 'active', homepageVisible: true });
    await approved(w, { entityId: `gym_x${i}` });
  }
  const sixth = ok(await w.promotionService.create({ body: promoBody(w.clock, { entityId: 'gym_a' }), actorId: 'maker' }));
  ok(await w.promotionService.submit({ id: sixth.promotion.id, actorId: 'maker' }));
  err(await w.promotionService.approve({ id: sixth.promotion.id, actorId: 'checker' }), 'placement_full', 409);
  // Promoted is a separate allowance from Featured.
  await approved(w, { entityId: 'gym_a', type: 'promoted' });
});

test('capacity: a promotion in a different period or area does not use the slot; freeing one makes room', async () => {
  const w = makeWorld();
  ok(await w.promotionService.setLimit({ placement: 'gym_discovery', promotionType: 'featured', maxSlots: 1, actorId: 'admin' }));
  const first = await approved(w, { entityId: 'gym_a', geoScope: { areaIds: ['tz-znz'] } });
  await approved(w, { entityId: 'gym_b', geoScope: { areaIds: ['tz-dar'] } });                          // other area: fits
  await approved(w, { entityId: 'gym_c', startsAt: iso(w.clock, 10 * DAY), endsAt: iso(w.clock, 12 * DAY), geoScope: { areaIds: ['tz-znz'] } });   // later: fits
  const clash = ok(await w.promotionService.create({ body: promoBody(w.clock, { entityId: 'gym_off', geoScope: { areaIds: ['tz-znz-stone-town'] } }), actorId: 'maker' }));
  const preview = ok(await w.promotionService.preview({ id: clash.promotion.id }));
  assert.equal(preview.capacity[0].full, true);
  assert.equal(preview.canApprove, false);
  ok(await w.promotionService.cancel({ id: first.id, actorId: 'c', reason: 'freed' }));
  assert.equal(ok(await w.promotionService.preview({ id: clash.promotion.id })).capacity[0].full, false);
});

test('capacity: extending a held promotion must still fit; limits report what is used', async () => {
  const w = makeWorld();
  ok(await w.promotionService.setLimit({ placement: 'gym_discovery', promotionType: 'featured', maxSlots: 1, actorId: 'admin' }));
  const a = await approved(w, { entityId: 'gym_a', endsAt: iso(w.clock, 3 * DAY) });
  await approved(w, { entityId: 'gym_b', startsAt: iso(w.clock, 4 * DAY), endsAt: iso(w.clock, 6 * DAY) });
  err(await w.promotionService.update({ id: a.id, body: { endsAt: iso(w.clock, 5 * DAY) }, actorId: 'c' }), 'placement_full', 409);
  ok(await w.promotionService.update({ id: a.id, body: { endsAt: iso(w.clock, 3.5 * DAY) }, actorId: 'c' }));
  const row = (await w.promotionService.limits()).find(l => l.placement === 'gym_discovery' && l.promotionType === 'featured');
  assert.deepEqual([row.maxSlots, row.used, row.source], [1, 2, 'config']);
  const dflt = (await w.promotionService.limits()).find(l => l.placement === 'home' && l.promotionType === 'promoted');
  assert.deepEqual([dflt.maxSlots, dflt.source], [10, 'default']);
});

test('capacity: limit settings are validated and audited', async () => {
  const w = makeWorld();
  err(await w.promotionService.setLimit({ placement: 'nowhere', promotionType: 'featured', maxSlots: 1, actorId: 'a' }), 'invalid_placement', 400);
  err(await w.promotionService.setLimit({ placement: 'home', promotionType: 'nope', maxSlots: 1, actorId: 'a' }), 'invalid_promotion_type', 400);
  err(await w.promotionService.setLimit({ placement: 'home', promotionType: 'featured', maxSlots: -1, actorId: 'a' }), 'invalid_max_slots', 400);
  err(await w.promotionService.setLimit({ placement: 'home', promotionType: 'featured', maxSlots: 3, maxBoostFraction: 2, actorId: 'a' }), 'invalid_boost_fraction', 400);
  ok(await w.promotionService.setLimit({ placement: 'home', promotionType: 'featured', maxSlots: 3, maxBoostFraction: 0.1, actorId: 'a' }));
  ok(await w.promotionService.setLimit({ placement: 'home', promotionType: 'featured', maxSlots: 4, actorId: 'a' }));
  const entries = w.stores.auditLog.rows.filter(a => a.action === 'promotion.placement_limit_set');
  assert.equal(entries.length, 2);
  assert.equal(entries[1].before.maxSlots, 3);
});

// ── Moderation ──────────────────────────────────────────────────────────────

test('moderation: the queue lists entities by status; those with no decision are approved', async () => {
  const w = makeWorld();
  const all = ok(await w.moderationService.list({ entityType: 'gym' }));
  assert.equal(all.total, 4);
  assert.equal(all.counts.approved, 4);
  await w.moderationService.decide({ entityType: 'gym', entityId: 'gym_a', action: 'require_review', reason: 'complaint', actorId: 'm' });
  const pending = ok(await w.moderationService.list({ entityType: 'gym', status: 'pending' }));
  assert.deepEqual(pending.items.map(i => i.id), ['gym_a']);
  assert.equal(pending.items[0].reason, 'complaint');
  assert.equal(ok(await w.moderationService.list({ entityType: 'gym', q: 'closed' })).total, 1);
  err(await w.moderationService.list({ entityType: 'spaceship' }), 'invalid_entity_type', 400);
  err(await w.moderationService.list({ entityType: 'gym', status: 'weird' }), 'invalid_status', 400);
  assert.equal((await w.moderationService.counts()).pending, 1);
});

test('moderation: every action is recorded in the entity history and the audit log, with before and after', async () => {
  const w = makeWorld();
  const d = (action, reason) => w.moderationService.decide({ entityType: 'trainer', entityId: 'tr_1', action, reason, actorId: 'mod_1' });
  ok(await d('suspend', 'complaint'));
  ok(await d('restore'));
  ok(await d('hide', 'photos'));
  ok(await d('restore'));
  const { history, moderationStatus, allowedActions } = ok(await w.moderationService.detail('trainer', 'tr_1'));
  assert.equal(moderationStatus, 'approved');
  assert.equal(history.length, 4);
  assert.deepEqual(history.map(h => h.action).sort(), ['hide', 'restore', 'restore', 'suspend']);
  assert.ok(allowedActions.some(a => a.action === 'suspend' && a.reasonRequired));
  const entry = w.stores.auditLog.rows.find(a => a.action === 'moderation.suspend');
  assert.deepEqual([entry.actor, entry.target, entry.before.status, entry.after.status, entry.after.reason], ['mod_1', 'trainer:tr_1', 'approved', 'suspended', 'complaint']);
});

test('moderation: invalid transitions and missing reasons are refused on the server', async () => {
  const w = makeWorld();
  const d = (action, reason, id = 'gym_a') => w.moderationService.decide({ entityType: 'gym', entityId: id, action, reason, actorId: 'm' });
  err(await d('approve'), 'invalid_transition', 409);                                    // already approved
  err(await d('suspend', ''), 'reason_required', 400);
  err(await d('restore'), 'invalid_transition', 409);                                    // nothing to restore
  err(await d('explode', 'x'), 'unknown_action', 400);
  err(await d('hide', 'x', 'nope'), 'entity_not_found', 404);
  err(await w.moderationService.decide({ entityType: 'gym', entityId: 'gym_a', action: 'hide', reason: 'x', actorId: null }), 'actor_required', 403);
  ok(await d('require_review', 'check'));
  ok(await d('reject', 'no'));
  err(await d('approve'), 'invalid_transition', 409);                                    // rejected needs reopening first
  ok(await d('reopen'));
  ok(await d('approve'));
});

test('moderation: the detail never exposes a vendor\'s account fields', async () => {
  const w = makeWorld();
  w.stores.users.rows[0].passwordHash = 'secret';
  const d = ok(await w.moderationService.detail('vendor', 'usr_v1'));
  assert.equal(JSON.stringify(d).includes('secret'), false);
  assert.equal(d.summary.name, 'Vendor One');
  assert.equal(d.eligibility.ok, true);
  err(await w.moderationService.detail('vendor', 'gym_a'), 'entity_not_found', 404);
});

test('moderation: suspending or hiding an entity pauses its running and scheduled promotions; restoring does not resume them', async () => {
  const w = makeWorld();
  const live = await approved(w, { entityId: 'gym_a' });
  const other = await approved(w, { entityId: 'gym_b' });
  w.clock.advance(2 * HOUR);
  ok(await w.promotionService.activate({ id: live.id, actorId: 'c' }));
  ok(await w.promotionService.activate({ id: other.id, actorId: 'c' }));
  const sched = await approved(w, { entityId: 'gym_a', type: 'promoted', startsAt: iso(w.clock, 2 * DAY), endsAt: iso(w.clock, 4 * DAY) });
  ok(await w.promotionService.schedule({ id: sched.id, actorId: 'c' }));

  const out = ok(await w.moderationService.decide({ entityType: 'gym', entityId: 'gym_a', action: 'suspend', reason: 'unsafe', actorId: 'm' }));
  assert.equal(out.heldPromotions, 2);
  assert.equal((await w.promotionService.get(live.id)).promotion.status, 'paused');
  assert.match((await w.promotionService.get(live.id)).promotion.statusReason, /unsafe/);
  assert.equal((await w.promotionService.get(other.id)).promotion.status, 'active');     // other entities untouched
  assert.deepEqual((await w.promotionService.listLive({ placement: 'gym_discovery' })).map(p => p.entityId), ['gym_b']);

  ok(await w.moderationService.decide({ entityType: 'gym', entityId: 'gym_a', action: 'restore', actorId: 'm' }));
  assert.equal((await w.promotionService.get(live.id)).promotion.status, 'paused');      // a person decides to resume
  ok(await w.promotionService.resume({ id: live.id, actorId: 'c' }));
});

test('moderation: an entity blocked before a scheduled start is held by the job instead of starting', async () => {
  const w = makeWorld();
  const p = await approved(w, { entityId: 'gym_a' });
  ok(await w.promotionService.schedule({ id: p.id, actorId: 'c' }));
  // The block is recorded without going through decide(), as if the hold had been missed.
  w.stores.moderationStates.rows.push({ id: 'gym:gym_a', entityType: 'gym', entityId: 'gym_a', status: 'suspended' });
  w.clock.advance(2 * HOUR);
  const run = await w.promotionService.runLifecycle();
  assert.deepEqual([run.activated, run.held], [0, 1]);
  assert.equal((await w.promotionService.get(p.id)).promotion.status, 'paused');
});

// ── What discovery will be told ─────────────────────────────────────────────

test('live: only active, in-window promotions on eligible entities, for the right placement and viewer', async () => {
  const w = makeWorld();
  const zanzibar = await approved(w, { entityId: 'gym_a', geoScope: { areaIds: ['tz-znz'] }, priority: 2 });
  const everywhere = await approved(w, { entityId: 'gym_b', priority: 1, placements: ['gym_discovery', 'home'] });
  const approvedOnly = await approved(w, { entityId: 'gym_c' });                         // approved but never activated
  w.clock.advance(2 * HOUR);
  for (const p of [zanzibar, everywhere]) ok(await w.promotionService.activate({ id: p.id, actorId: 'c' }));

  const ids = async (q) => (await w.promotionService.listLive(q)).map(p => p.id);
  assert.deepEqual(await ids({ placement: 'gym_discovery', viewer: { areaIds: ['tz-znz-stone-town'] } }), [everywhere.id, zanzibar.id]);   // priority order
  assert.deepEqual(await ids({ placement: 'gym_discovery', viewer: { areaIds: ['tz-dar-city'] } }), [everywhere.id]);                 // outside Zanzibar
  assert.deepEqual(await ids({ placement: 'gym_discovery', viewer: {} }), [everywhere.id]);                                         // no location known
  assert.deepEqual(await ids({ placement: 'home' }), [everywhere.id]);
  assert.deepEqual(await ids({ placement: 'trainer_discovery' }), []);                                                              // placement respected
  assert.ok(!(await ids({ placement: 'gym_discovery' })).includes(approvedOnly.id));
  assert.equal((await w.promotionService.listLive({ placement: 'gym_discovery', type: 'promoted' })).length, 0);
});

test('live: an expired promotion stops counting the moment its end passes, before the job has run', async () => {
  const w = makeWorld();
  const p = await approved(w);
  w.clock.advance(2 * HOUR);
  ok(await w.promotionService.activate({ id: p.id, actorId: 'c' }));
  assert.equal((await w.promotionService.listLive({ placement: 'gym_discovery' })).length, 1);
  w.clock.advance(8 * DAY);
  assert.equal((await w.promotionService.get(p.id)).promotion.status, 'active');          // stored status is stale
  assert.equal((await w.promotionService.listLive({ placement: 'gym_discovery' })).length, 0);
});

test('live: an entity that stops being eligible drops out without any status change, and returns when it is eligible again', async () => {
  const w = makeWorld();
  const p = await approved(w, { entityId: 'gym_a' });
  w.clock.advance(2 * HOUR);
  ok(await w.promotionService.activate({ id: p.id, actorId: 'c' }));
  w.stores.gyms.rows.find(g => g.id === 'gym_a').status = 'inactive';
  assert.equal((await w.promotionService.listLive({ placement: 'gym_discovery' })).length, 0);
  w.stores.gyms.rows.find(g => g.id === 'gym_a').status = 'active';
  assert.equal((await w.promotionService.listLive({ placement: 'gym_discovery' })).length, 1);
  w.stores.gyms.rows.find(g => g.id === 'gym_a').homepageVisible = false;
  assert.equal((await w.promotionService.listLive({ placement: 'gym_discovery' })).length, 0);
});

test('live: labels tell users what kind of placement they are looking at', async () => {
  const w = makeWorld();
  const s = await approved(w, { entityId: 'gym_a', type: 'sponsored', relationshipType: 'paid_advertising', commercialRef: 'C-1', placements: ['search_results'] });
  const r = await approved(w, { entityId: 'gym_b', type: 'recommended', relationshipType: 'editorial', placements: ['search_results'] });
  w.clock.advance(2 * HOUR);
  for (const p of [s, r]) ok(await w.promotionService.activate({ id: p.id, actorId: 'c' }));
  const live = await w.promotionService.listLive({ placement: 'search_results' });
  const byId = Object.fromEntries(live.map(p => [p.entityId, p]));
  assert.deepEqual([byId.gym_a.label, byId.gym_a.commercial], ['Sponsored', true]);
  assert.deepEqual([byId.gym_b.label, byId.gym_b.commercial], ['Recommended by FitFlex', false]);
});

// ── Campaigns and geography ─────────────────────────────────────────────────

test('campaigns: create, validate, and keep promotions inside the campaign period', async () => {
  const w = makeWorld();
  const mk = body => w.promotionService.createCampaign({ body, actorId: 'adm' });
  err(await mk({ startsAt: iso(w.clock, 0), endsAt: iso(w.clock, DAY) }), 'name_required', 422);
  err(await mk({ name: 'X', startsAt: iso(w.clock, DAY), endsAt: iso(w.clock, 0) }), 'end_before_start', 422);
  err(await mk({ name: 'X', startsAt: iso(w.clock, 0), endsAt: iso(w.clock, DAY), geoScope: { areaIds: ['mars'] } }), 'unknown_geo_area', 422);
  const { campaign } = ok(await mk({ name: 'Zanzibar Fitness Week', startsAt: iso(w.clock, 0), endsAt: iso(w.clock, 10 * DAY), geoScope: { areaIds: ['tz-znz'] } }));
  assert.equal(campaign.status, 'draft');

  const inside = await w.promotionService.create({ body: promoBody(w.clock, { type: 'campaign', campaignId: campaign.id, placements: ['campaign_page'] }), actorId: 'a' });
  ok(inside);
  err(await w.promotionService.create({ body: promoBody(w.clock, { type: 'campaign', campaignId: campaign.id, endsAt: iso(w.clock, 20 * DAY), placements: ['campaign_page'] }), actorId: 'a' }), 'outside_campaign_period', 422);
  err(await w.promotionService.create({ body: promoBody(w.clock, { type: 'campaign', placements: ['campaign_page'] }), actorId: 'a' }), 'campaign_required', 422);
  err(await w.promotionService.create({ body: promoBody(w.clock, { campaignId: 'camp_missing' }), actorId: 'a' }), 'campaign_not_found', 404);
  err(await w.promotionService.updateCampaign({ id: campaign.id, body: { endsAt: iso(w.clock, 2 * HOUR) }, actorId: 'adm' }), 'promotions_outside_period', 409);
  assert.equal((await w.promotionService.getCampaign(campaign.id)).promotions.length, 1);
  assert.equal((await w.promotionService.listCampaigns()).items[0].promotionCount, 1);
});

test('campaigns: status moves along its own lifecycle; cancelling lists, but does not touch, its promotions', async () => {
  const w = makeWorld();
  const { campaign } = ok(await w.promotionService.createCampaign({ body: { name: 'Summer', startsAt: iso(w.clock, 0), endsAt: iso(w.clock, 10 * DAY) }, actorId: 'adm' }));
  const set = (to, reason) => w.promotionService.setCampaignStatus({ id: campaign.id, to, reason, actorId: 'adm' });
  err(await set('ended'), 'invalid_transition', 409);
  ok(await set('active'));
  const promo = ok(await w.promotionService.create({ body: promoBody(w.clock, { type: 'campaign', campaignId: campaign.id, placements: ['campaign_page'] }), actorId: 'a' }));
  err(await set('cancelled'), 'reason_required', 400);
  const out = ok(await set('cancelled', 'client pulled out'));
  assert.deepEqual(out.openPromotions, [promo.promotion.id]);
  assert.equal((await w.promotionService.get(promo.promotion.id)).promotion.status, 'draft');
  err(await w.promotionService.create({ body: promoBody(w.clock, { type: 'campaign', campaignId: campaign.id, placements: ['campaign_page'] }), actorId: 'a' }), 'campaign_closed', 409);
});

test('geography: areas are added under the right parent', async () => {
  const w = makeWorld();
  const add = body => w.promotionService.createArea({ body, actorId: 'adm' });
  err(await add({ level: 'planet', name: 'x', parentId: 'tz' }), 'invalid_level', 422);
  err(await add({ level: 'city', name: 'Moshi', parentId: 'tz' }), 'invalid_parent', 422);        // a city goes under a region
  const { area } = ok(await add({ level: 'city', name: 'Moshi', parentId: 'tz-znz', lat: -3.35, lng: 37.34 }));
  assert.equal(area.id, 'tz-znz-moshi');
  err(await add({ level: 'city', name: 'Moshi', parentId: 'tz-znz' }), 'area_exists', 409);
  assert.ok((await w.promotionService.listAreas()).areas.some(a => a.id === 'tz-znz-moshi'));
});

test('overview: counts what an admin needs to see first', async () => {
  const w = makeWorld();
  await approved(w, { entityId: 'gym_a', endsAt: iso(w.clock, 3 * DAY) });
  const live = await approved(w, { entityId: 'gym_b' });
  w.clock.advance(2 * HOUR);
  ok(await w.promotionService.activate({ id: live.id, actorId: 'c' }));
  const pending = ok(await w.promotionService.create({ body: promoBody(w.clock, { entityId: 'gym_c' }), actorId: 'm' }));
  ok(await w.promotionService.submit({ id: pending.promotion.id, actorId: 'm' }));
  await w.moderationService.decide({ entityType: 'gym', entityId: 'gym_off', action: 'require_review', reason: 'x', actorId: 'm' });
  const o = await w.promotionService.overview();
  assert.equal(o.active, 1);
  assert.equal(o.pendingPromotionRequests, 1);
  assert.equal(o.pendingModeration, 1);
  assert.equal(o.expiringSoon.length, 1);
  assert.ok(o.recent.length > 0);
});

test('reference: placements, types and defaults are exposed for the admin UI', () => {
  const w = makeWorld();
  const ref = w.promotionService.reference();
  assert.deepEqual(ref.entityTypes.sort(), ['gym', 'product', 'trainer', 'vendor']);
  assert.ok(ref.placements.gym_discovery.entityTypes.includes('gym'));
  assert.equal(ref.promotionTypes.sponsored.commercial, 'required');
  assert.equal(ref.defaultLimits.featured, 5);
  assert.deepEqual(w.moderationService.reference().statuses, ['pending', 'approved', 'rejected', 'suspended', 'hidden']);
});

// ── Lookups for the wizard ──────────────────────────────────────────────────

test('lookup: entities are found by name, promotable ones first, with the reason when not', async () => {
  const w = makeWorld();
  await w.moderationService.decide({ entityType: 'gym', entityId: 'gym_b', action: 'suspend', reason: 'x', actorId: 'm' });
  const all = ok(await w.promotionService.searchEntities({ entityType: 'gym' }));
  assert.equal(all.total, 4);
  const names = all.items.map(i => i.name);
  assert.deepEqual(names.slice(0, 2).sort(), ['Gym A', 'Gym C']);                          // promotable first
  const b = all.items.find(i => i.id === 'gym_b');
  assert.deepEqual([b.promotable, b.reasons, b.moderationStatus], [false, ['moderation_suspended'], 'suspended']);
  assert.ok(all.items[0].placements.includes('gym_discovery') && !all.items[0].placements.includes('trainer_discovery'));
  assert.deepEqual(ok(await w.promotionService.searchEntities({ entityType: 'gym', q: 'closed' })).items.map(i => i.id), ['gym_off']);
  assert.equal(ok(await w.promotionService.searchEntities({ entityType: 'gym', limit: 1 })).items.length, 1);
  assert.equal(ok(await w.promotionService.searchEntities({ entityType: 'vendor', q: 'one' })).items[0].name, 'Vendor One');
  assert.equal(ok(await w.promotionService.searchEntities({ entityType: 'vendor' })).items.find(i => i.id === 'usr_v_draft').promotable, false);
  err(await w.promotionService.searchEntities({ entityType: 'robot' }), 'invalid_entity_type', 400);
});

test('lookup: partner organisations are found by name', async () => {
  const w = makeWorld();
  assert.deepEqual((await w.promotionService.searchPartners({})).items.map(o => o.id), ['org_2', 'org_1']);
  const hit = await w.promotionService.searchPartners({ q: 'safari' });
  assert.deepEqual(hit.items.map(o => [o.id, o.name, o.legalName]), [['org_1', 'Safari Cover', 'Safari Insurance Ltd']]);
  ok(await w.promotionService.create({ body: promoBody(w.clock, { partnerRef: 'org_1' }), actorId: 'a' }));
  err(await w.promotionService.create({ body: promoBody(w.clock, { partnerRef: 'org_missing' }), actorId: 'a' }), 'partner_not_found', 404);
});
