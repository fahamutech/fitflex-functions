// Settlement configuration, Phase 3 PR B, against the CI database: the
// migration that activates the Dar values and gives gyms their first rate
// card, the admin listing, and drafting cards for gyms that have none.
// Database tests run in a transaction that is rolled back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { createSettlementConfigService } from '../src/services/settlement-config-service.mjs';
import { resolveGymRateSnapshot } from '../src/shared/settlement-config.mjs';
import { calculateWholesaleRates } from '../src/shared/settlement-engine.mjs';
import migration from '../db/migrations/20261104090000-activate-dar-settlement-config.cjs';

const ROLLBACK = Symbol('rollback');
const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;

async function inRollback(fn) {
  try {
    await db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

async function makeGym(trx, tier, rates = {}) {
  const id = uid('gym');
  await trx('Gym').insert({ id, name: `Gym ${tier}`, tier, location: 'Dar es Salaam', updatedAt: new Date(), ...rates });
  return id;
}

test('the migration gives each gym with full retail rates an active rate card, with the rules copied in', () => inRollback(async (trx) => {
  const standard = await makeGym(trx, 'standard', { ratePerDay: 5000, ratePerWeek: 15000, ratePerMonth: 50000 });
  const premium = await makeGym(trx, 'premium', { ratePerDay: 20000, ratePerWeek: 70000, ratePerMonth: 250000 });
  const noWeekly = await makeGym(trx, 'standard', { ratePerDay: 5000, ratePerMonth: 50000 });
  const online = await makeGym(trx, 'online', { ratePerDay: 1000, ratePerWeek: 3000, ratePerMonth: 9000 });
  await migration.up(trx);
  await migration.up(trx);   // harmless to run again

  const cards = Object.fromEntries((await trx('GymRateCard').whereIn('gymId', [standard, premium, noWeekly, online])).map((c) => [c.gymId, c]));
  assert.deepEqual(Object.keys(cards).sort(), [premium, standard].sort());   // the incomplete and the online gym are skipped
  const s = cards[standard];
  assert.deepEqual([s.status, s.effectiveFrom, s.effectiveTo, s.version, s.gymTier], ['active', '2026-10-01', null, 1, 'standard']);
  assert.deepEqual([s.retailDailyTzs, s.retailWeeklyTzs, s.retailMonthlyTzs], [5000, 15000, 50000]);
  assert.deepEqual([s.dailyDiscountBps, s.weeklyDiscountBps, s.monthlyDiscountBps, s.dailyCeilingTzs, s.weeklyCeilingTzs, s.monthlyCeilingTzs], [2500, 2000, 2000, 3500, 12000, 42000]);
  assert.deepEqual(s.ruleSources.monthlyCeilingTzs, { ruleId: 'rule-ceil-standard-1', version: 1, scopeType: 'gym_tier', scopeId: 'standard' });
  assert.equal(s.ruleSources.dailyDiscountBps.ruleId, 'rule-global-1');
  assert.notEqual(s.approvedBy, s.createdBy);
  assert.equal(cards[premium].monthlyCeilingTzs, 175000);

  // The engine reads it like any approved card.
  const { snapshot } = resolveGymRateSnapshot({ rateCards: Object.values(cards), gymId: standard, date: '2026-10-01' });
  assert.deepEqual(calculateWholesaleRates(snapshot), { dailyTzs: 3500, weeklyTzs: 12000, monthlyTzs: 40000 });
}));

test('the migration leaves a gym that already has a card, and configuration an admin already decided, alone', () => inRollback(async (trx) => {
  const gymId = await makeGym(trx, 'standard', { ratePerDay: 5000, ratePerWeek: 15000, ratePerMonth: 50000 });
  await trx('GymRateCard').insert({ id: uid('rc'), gymId, version: 1, gymTier: 'standard', retailDailyTzs: 1, retailWeeklyTzs: 2, retailMonthlyTzs: 3, status: 'draft', createdBy: 'maker' });
  const rejected = { id: uid('ptv'), tierKey: uid('tier'), version: 1, priceTzs: 1, visitAllowance: 1, status: 'rejected', createdBy: 'maker' };
  await trx('PassTierVersion').insert(rejected);
  await migration.up(trx);
  assert.deepEqual((await trx('GymRateCard').where({ gymId })).map((c) => c.status), ['draft']);
  assert.equal((await trx('PassTierVersion').where({ id: rejected.id }).first()).status, 'rejected');
}));

test('drafting cards for gyms that have none: drafts only, incomplete gyms reported', () => inRollback(async (trx) => {
  const service = createSettlementConfigService({ db: trx });
  const ready = await makeGym(trx, 'midtier', { ratePerDay: 10000, ratePerWeek: 35000, ratePerMonth: 120000 });
  const incomplete = await makeGym(trx, 'standard', { ratePerDay: 5000 });
  const online = await makeGym(trx, 'online');
  const out = await service.draftRateCardsForGyms({ actorId: 'admin-1' });

  const drafted = out.drafted.find((c) => c.gymId === ready);
  assert.deepEqual([drafted.status, drafted.gymTier, drafted.retailWeeklyTzs, drafted.createdBy], ['draft', 'midtier', 35000, 'admin-1']);
  assert.deepEqual(out.skipped.find((s) => s.gymId === incomplete), { gymId: incomplete, reason: 'retail_rates_missing' });
  assert.deepEqual(out.skipped.find((s) => s.gymId === online), { gymId: online, reason: 'online_gym' });
  // The drafter can't approve their own draft; someone else can.
  assert.equal((await service.activate({ kind: 'rate_card', id: drafted.id, effectiveFrom: '2026-11-01', actorId: 'admin-1' })).error, 'cannot_approve_own_draft');
  assert.equal((await service.activate({ kind: 'rate_card', id: drafted.id, effectiveFrom: '2026-11-01', actorId: 'admin-2' })).rateCard.status, 'active');
  // A second call drafts nothing new for that gym.
  assert.equal((await service.draftRateCardsForGyms({ actorId: 'admin-1' })).drafted.some((c) => c.gymId === ready), false);
}));

test('the admin listing shows drafts, active and rejected rows, and filters by status', () => inRollback(async (trx) => {
  const service = createSettlementConfigService({ db: trx });
  const draft = (await service.createPassTierVersion({ tierKey: 'basic', priceTzs: 65000, visitAllowance: 16, actorId: 'maker' })).passTierVersion;
  const all = await service.listConfiguration();
  assert.ok(all.passTierVersions.some((p) => p.id === draft.id));
  assert.ok(all.passTierVersions.some((p) => p.id === 'ptv-basic-1' && p.status === 'active'));
  assert.ok(all.rules.some((r) => r.id === 'rule-global-1'));
  const drafts = await service.listConfiguration({ status: 'draft' });
  assert.ok(drafts.passTierVersions.every((p) => p.status === 'draft'));
  assert.ok(drafts.passTierVersions.some((p) => p.id === draft.id));
  assert.equal((await service.listConfiguration({ status: 'active' })).passTierVersions.some((p) => p.id === draft.id), false);
  assert.equal(draft.version, 2);   // the next version after the seeded one
}));
