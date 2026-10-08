// Placement capacity under concurrency: the room check and the claim of a slot
// are one step, so two admins approving at the same moment cannot both take the
// last slot. Runs against the real database (a Postgres advisory lock serialises
// the claims, across servers).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { promotionService } from '../src/bootstrap/services.mjs';

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { gyms: [], promotions: [], users: [] };
// A window far in the future that no other spec uses, so only these promotions compete for the slots.
const WINDOW = { startsAt: '2041-03-01T08:00:00.000Z', endsAt: '2041-03-08T08:00:00.000Z' };
const LIMIT = ['campaign_page', 'featured'];

before(async () => {
  assert.equal((await promotionService.setLimit({ placement: LIMIT[0], promotionType: LIMIT[1], maxSlots: 2, actorId: 'promo_concurrency_spec' })).error, undefined);
});
after(async () => {
  await db('PlacementConfig').where({ id: `${LIMIT[0]}:${LIMIT[1]}` }).del();
  await db('AuditLog').where('actor', 'promo_concurrency_spec').del();
  if (made.promotions.length) {
    await db('PromotionPlacement').whereIn('promotionId', made.promotions).del();
    await db('Promotion').whereIn('id', made.promotions).del();
  }
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) { await db('AuditLog').whereIn('actor', made.users).del(); await db('User').whereIn('id', made.users).del(); }
});

async function admin() {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'admin', displayName: 'Concurrency admin', updatedAt: new Date() });
  made.users.push(id);
  return id;
}
async function submittedPromotion(maker, over = {}) {
  const gymId = uid('gym');
  await db('Gym').insert({ id: gymId, name: `Concurrency Gym ${gymId}`, tier: 'standard', location: 'Dar es Salaam', status: 'active', updatedAt: new Date() });
  made.gyms.push(gymId);
  const c = await promotionService.create({ actorId: maker, body: { entityType: 'gym', entityId: gymId, type: 'featured', placements: ['campaign_page'], ...WINDOW, priority: 1, ...over } });
  assert.equal(c.error, undefined, JSON.stringify(c));
  made.promotions.push(c.promotion.id);
  assert.equal((await promotionService.submit({ id: c.promotion.id, actorId: maker })).error, undefined);
  return c.promotion.id;
}

test('six admins approving at once for two slots: exactly two succeed and the rest are told the placement is full', async () => {
  const maker = await admin();
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push(await submittedPromotion(maker));
  const checkers = await Promise.all(ids.map(() => admin()));
  const outcomes = await Promise.all(ids.map((id, i) => promotionService.approve({ id, actorId: checkers[i] })));
  const approved = outcomes.filter(o => !o.error);
  const refused = outcomes.filter(o => o.error);
  assert.equal(approved.length, 2, JSON.stringify(outcomes.map(o => o.error ?? 'ok')));
  assert.deepEqual([...new Set(refused.map(o => o.error))], ['placement_full']);
  const rows = await db('Promotion').whereIn('id', ids).select('status');
  assert.equal(rows.filter(r => r.status === 'approved').length, 2);
});

test('extending the end of a held promotion into a full period is refused even when two try at once', async () => {
  const maker = await admin(); const checker = await admin(); const checker2 = await admin();
  // Two promotions fill the later window; two short ones in the first window each want to stretch into it.
  const later = { startsAt: '2041-04-01T08:00:00.000Z', endsAt: '2041-04-08T08:00:00.000Z' };
  const first = { startsAt: '2041-03-20T08:00:00.000Z', endsAt: '2041-03-25T08:00:00.000Z' };
  for (let i = 0; i < 2; i += 1) {
    const id = await submittedPromotion(maker, later);
    assert.equal((await promotionService.approve({ id, actorId: checker })).error, undefined);
  }
  const a = await submittedPromotion(maker, first); const b = await submittedPromotion(maker, first);
  assert.equal((await promotionService.approve({ id: a, actorId: checker })).error, undefined);
  assert.equal((await promotionService.approve({ id: b, actorId: checker2 })).error, undefined);
  const extended = await Promise.all([a, b].map(id => promotionService.update({ id, body: { endsAt: '2041-04-05T08:00:00.000Z' }, actorId: maker })));
  assert.deepEqual(extended.map(o => o.error), ['placement_full', 'placement_full']);
});
