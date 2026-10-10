// Settlement configuration (settlement Phase 2, PR 2) against the CI
// database: the seeds, the store wiring (calendar dates stay "YYYY-MM-DD"),
// what the database refuses, the activation service, and the Phase 1
// resolvers and engine fed straight from the tables.
//
// Every test runs inside a transaction that is rolled back, so active rows —
// which the database won't let anyone delete — never leak between runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, collection } from '../src/infra/knex-store.mjs';
import { createSettlementConfigService } from '../src/services/settlement-config-service.mjs';
import { resolveMemberCycleTerms, resolveGymRateSnapshot, resolutionDateForCycle } from '../src/shared/settlement-config.mjs';
import { calculateMemberSettlement } from '../src/shared/settlement-engine.mjs';

const ROLLBACK = Symbol('rollback');
const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const TODAY = '2026-10-10';
const service = createSettlementConfigService({ now: () => new Date(`${TODAY}T09:00:00.000Z`) });

/** Run `fn(trx)` in a transaction that is always rolled back. */
async function inRollback(fn) {
  try {
    await db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

/** Expect a Postgres error inside a savepoint, so the outer transaction survives. */
async function rejects(trx, fn, code) {
  await assert.rejects(trx.transaction(fn), (err) => err.code === code, `expected Postgres error ${code}`);
}

async function makeGym(trx, tier = 'standard') {
  const id = uid('gym');
  await trx('Gym').insert({ id, name: 'Settlement Config Gym', tier, location: 'Dar es Salaam', updatedAt: new Date() });
  return id;
}

const ptv = (extra = {}) => ({ id: uid('ptv'), tierKey: uid('tier'), version: 1, priceTzs: 60000, visitAllowance: 16, status: 'draft', createdBy: 'maker', ...extra });
const activeFields = (from = '2026-01-01', to = null) => ({ status: 'active', effectiveFrom: from, effectiveTo: to, approvedBy: 'checker', approvedAt: new Date() });


// ── seeds ────────────────────────────────────────────────────────────────────

test('the approved Dar values are seeded and active from 1 Jun 2026 (moved back from 1 Oct for the test data)', async () => {
  const passes = await db('PassTierVersion').whereIn('id', ['ptv-basic-1', 'ptv-pro-1', 'ptv-premium-1', 'ptv-executive-1']).orderBy('priceTzs');
  assert.deepEqual(passes.map((p) => [p.tierKey, p.priceTzs, p.visitAllowance, p.status, p.effectiveFrom]), [
    ['basic', 60000, 16, 'active', '2026-06-01'], ['pro', 150000, 18, 'active', '2026-06-01'],
    ['premium', 250000, 20, 'active', '2026-06-01'], ['executive', 400000, 24, 'active', '2026-06-01'],
  ]);
  assert.ok(passes.every((p) => p.approvedBy && p.approvedBy !== p.createdBy && p.effectiveTo === null));
  const global = await db('SettlementRule').where({ id: 'rule-global-1' }).first();
  assert.deepEqual([global.dailyDiscountBps, global.weeklyDiscountBps, global.monthlyDiscountBps, global.networkPayoutBps, global.status], [2500, 2000, 2000, 7500, 'active']);
  const ceilings = Object.fromEntries((await db('SettlementRule').where({ scopeType: 'gym_tier' }).whereLike('id', 'rule-ceil-%'))
    .map((r) => [r.scopeId, [r.dailyCeilingTzs, r.weeklyCeilingTzs, r.monthlyCeilingTzs]]));
  assert.deepEqual(ceilings, {
    standard: [3500, 12000, 42000], midtier: [7500, 30000, 105000],
    premium: [12000, 50000, 175000], luxury_executive: [18000, 75000, 270000],
  });
});

// ── store wiring ─────────────────────────────────────────────────────────────

test('the collection API keeps calendar dates as "YYYY-MM-DD" and money and basis points as integers', async () => {
  const cards = collection('gym_rate_cards');
  const gymId = uid('gym');
  await db('Gym').insert({ id: gymId, name: 'Wiring Gym', tier: 'standard', location: 'Dar', updatedAt: new Date() });
  try {
    const id = uid('rc');
    await cards.insertAsync({ id, gymId, version: 1, gymTier: 'standard', retailDailyTzs: 5000, retailWeeklyTzs: 15000, retailMonthlyTzs: 50000,
      dailyDiscountBps: 2500, status: 'draft', effectiveFrom: '2026-11-01', effectiveTo: '2026-12-01', ruleSources: { dailyDiscountBps: { ruleId: 'r1' } }, createdBy: 'maker' });
    const back = await cards.findByIdAsync(id);
    assert.equal(back.effectiveFrom, '2026-11-01');
    assert.equal(back.effectiveTo, '2026-12-01');
    assert.equal(back.retailDailyTzs, 5000);
    assert.equal(back.dailyDiscountBps, 2500);
    assert.deepEqual(back.ruleSources, { dailyDiscountBps: { ruleId: 'r1' } });
  } finally {
    await db('Gym').where({ id: gymId }).del();   // cascades the draft card
  }
});

// ── what the database refuses ────────────────────────────────────────────────

test('money is whole TZS and percentages are basis points 0–10000', () => inRollback(async (trx) => {
  await rejects(trx, (t) => t('PassTierVersion').insert(ptv({ priceTzs: 60000.5 })), '22P02');
  await rejects(trx, (t) => t('PassTierVersion').insert(ptv({ priceTzs: -1 })), '23514');
  await rejects(trx, (t) => t('SettlementRule').insert({ id: uid('r'), version: 1, scopeType: 'global', networkPayoutBps: 10001, createdBy: 'm' }), '23514');
  await rejects(trx, (t) => t('SettlementRule').insert({ id: uid('r'), version: 1, scopeType: 'global', dailyDiscountBps: -1, createdBy: 'm' }), '23514');
  await trx('SettlementRule').insert({ id: uid('r'), version: 99, scopeType: 'global', dailyDiscountBps: 2500, networkPayoutBps: 7500, createdBy: 'm' });
}));

test('rule scopes follow DR-06 and DR-07; SPECIAL_CONTRACT is reserved', () => inRollback(async (trx) => {
  const rule = (extra) => ({ id: uid('r'), version: 1, createdBy: 'm', ...extra });
  await rejects(trx, (t) => t('SettlementRule').insert(rule({ scopeType: 'gym_tier', scopeId: 'standard', networkPayoutBps: 7000 })), '23514');
  await rejects(trx, (t) => t('SettlementRule').insert(rule({ scopeType: 'gym', scopeId: 'g1', networkPayoutBps: 7000 })), '23514');
  await rejects(trx, (t) => t('SettlementRule').insert(rule({ scopeType: 'pass_tier', scopeId: 'pro', dailyCeilingTzs: 5000 })), '23514');
  await rejects(trx, (t) => t('SettlementRule').insert(rule({ scopeType: 'global', scopeId: 'x', networkPayoutBps: 7000 })), '23514');
  await rejects(trx, (t) => t('SettlementRule').insert(rule({ scopeType: 'gym', networkPayoutBps: null, dailyCeilingTzs: 1 })), '23514');   // no scopeId
  await rejects(trx, (t) => t('SettlementRule').insert(rule({ scopeType: 'gym_tier', scopeId: 'standard' })), '23514');                   // no values
  await rejects(trx, (t) => t('SettlementRule').insert(rule({ scopeType: 'city', scopeId: 'dar', networkPayoutBps: 1 })), '23514');
  await rejects(trx, (t) => t('SettlementRule').insert(rule({ scopeType: 'special_contract', scopeId: 'k1', dailyCeilingTzs: 1, ...activeFields() })), '23514');
  await trx('SettlementRule').insert(rule({ scopeType: 'special_contract', scopeId: 'k1', dailyCeilingTzs: 1 }));   // a draft is fine
}));

test('an active row needs a start date and an approver who is not its creator', () => inRollback(async (trx) => {
  await rejects(trx, (t) => t('PassTierVersion').insert(ptv({ status: 'active', approvedBy: 'checker', approvedAt: new Date() })), '23514');
  await rejects(trx, (t) => t('PassTierVersion').insert(ptv({ status: 'active', effectiveFrom: '2026-01-01' })), '23514');
  await rejects(trx, (t) => t('PassTierVersion').insert(ptv({ ...activeFields(), approvedBy: 'maker' })), '23514');
  await rejects(trx, (t) => t('PassTierVersion').insert(ptv({ effectiveFrom: '1/1/2026' })), '23514');
  await rejects(trx, (t) => t('PassTierVersion').insert(ptv({ effectiveFrom: '2026-02-01', effectiveTo: '2026-01-01' })), '23514');
  await rejects(trx, (t) => t('PassTierVersion').insert(ptv({ status: 'retired' })), '23514');
}));

test('two active versions for the same target can\'t overlap; back-to-back is fine', () => inRollback(async (trx) => {
  const tierKey = uid('tier');
  await trx('PassTierVersion').insert(ptv({ tierKey, ...activeFields('2026-01-01', '2026-07-01') }));
  await trx('PassTierVersion').insert(ptv({ tierKey, version: 2, ...activeFields('2026-07-01') }));   // starts the day v1 ends
  await rejects(trx, (t) => t('PassTierVersion').insert(ptv({ tierKey, version: 3, ...activeFields('2026-06-01', '2026-08-01') })), '23P01');
  await rejects(trx, (t) => t('PassTierVersion').insert(ptv({ tierKey, version: 3, ...activeFields('2027-01-01') })), '23P01'); // v2 is open-ended
  await trx('PassTierVersion').insert(ptv({ tierKey: uid('tier'), ...activeFields('2026-06-01') }));  // another tier: independent
  // Rules overlap per scope target; different targets don't collide.
  const gymRule = (scopeId, v, from, to) => ({ id: uid('r'), version: v, scopeType: 'gym', scopeId, dailyCeilingTzs: 1, createdBy: 'm', ...activeFields(from, to) });
  await trx('SettlementRule').insert(gymRule('gym-x', 1, '2026-01-01'));
  await trx('SettlementRule').insert(gymRule('gym-y', 1, '2026-01-01'));
  await rejects(trx, (t) => t('SettlementRule').insert(gymRule('gym-x', 2, '2026-05-01')), '23P01');
}));

test('an active version is read-only: only an open end date may be closed, and it can\'t be deleted', () => inRollback(async (trx) => {
  const row = ptv(activeFields('2026-01-01'));
  await trx('PassTierVersion').insert(row);
  await rejects(trx, (t) => t('PassTierVersion').where({ id: row.id }).update({ priceTzs: 1 }), 'P0001');
  await rejects(trx, (t) => t('PassTierVersion').where({ id: row.id }).update({ status: 'draft' }), 'P0001');
  await rejects(trx, (t) => t('PassTierVersion').where({ id: row.id }).update({ effectiveFrom: '2025-01-01' }), 'P0001');
  await rejects(trx, (t) => t('PassTierVersion').where({ id: row.id }).del(), 'P0001');
  await trx('PassTierVersion').where({ id: row.id }).update({ effectiveTo: '2026-12-01', updatedAt: new Date() });   // closing is allowed
  await rejects(trx, (t) => t('PassTierVersion').where({ id: row.id }).update({ effectiveTo: '2027-01-01' }), 'P0001'); // but only once
  const draft = ptv();
  await trx('PassTierVersion').insert(draft);
  await trx('PassTierVersion').where({ id: draft.id }).update({ priceTzs: 70000 });   // drafts stay editable
  await trx('PassTierVersion').where({ id: draft.id }).del();
}));

// ── activation service ──────────────────────────────────────────────────────

test('activation: maker-checker, closes the version it replaces, never starts in the past once live', () => inRollback(async (trx) => {
  const tierKey = uid('tier');
  const v1 = (await service.createPassTierVersion({ tierKey, priceTzs: 60000, visitAllowance: 16, actorId: 'maker' }, { trx })).passTierVersion;
  assert.equal(v1.version, 1);
  assert.deepEqual(await service.activate({ kind: 'pass_tier', id: v1.id, effectiveFrom: '2026-01-01', actorId: 'maker' }, { trx }),
    { error: 'cannot_approve_own_draft', status: 403 });
  // The first version of a tier may start in the past (nothing resolved before it).
  const a1 = await service.activate({ kind: 'pass_tier', id: v1.id, effectiveFrom: '2026-01-01', actorId: 'checker' }, { trx });
  assert.equal(a1.passTierVersion.status, 'active');

  const v2 = (await service.createPassTierVersion({ tierKey, priceTzs: 70000, visitAllowance: 18, actorId: 'maker' }, { trx })).passTierVersion;
  assert.equal(v2.version, 2);
  const past = await service.activate({ kind: 'pass_tier', id: v2.id, effectiveFrom: '2026-10-01', actorId: 'checker' }, { trx });
  assert.equal(past.error, 'effective_from_in_past');
  const a2 = await service.activate({ kind: 'pass_tier', id: v2.id, effectiveFrom: '2026-11-01', actorId: 'checker' }, { trx });
  assert.equal(a2.closed, v1.id);
  const rows = await trx('PassTierVersion').where({ tierKey }).orderBy('version');
  assert.deepEqual(rows.map((r) => [r.version, r.status, r.effectiveFrom, r.effectiveTo]), [[1, 'active', '2026-01-01', '2026-11-01'], [2, 'active', '2026-11-01', null]]);
  assert.equal((await service.activate({ kind: 'pass_tier', id: v2.id, effectiveFrom: '2026-12-01', actorId: 'checker' }, { trx })).error, 'not_a_draft');

  const audit = await trx('AuditLog').whereIn('target', [v1.id, v2.id]).orderBy('at');
  assert.ok(audit.some((a) => a.action === 'settlement_config_activated' && a.actor === 'checker' && a.target === v2.id));
}));

test('a rate card copies the rules in force on its start date; missing rules block approval', () => inRollback(async (trx) => {
  // An online gym has no ceiling rules, so its card can't be approved.
  const online = await makeGym(trx, 'online');
  const onlineCard = (await service.createRateCard({ gymId: online, retailDailyTzs: 1000, retailWeeklyTzs: 3000, retailMonthlyTzs: 9000, actorId: 'maker' }, { trx })).rateCard;
  const blocked = await service.activate({ kind: 'rate_card', id: onlineCard.id, effectiveFrom: '2026-11-01', actorId: 'checker' }, { trx });
  assert.equal(blocked.error, 'rule_missing');
  assert.deepEqual(blocked.missing, ['dailyCeilingTzs', 'weeklyCeilingTzs', 'monthlyCeilingTzs']);
  // And before the rules start there is nothing to copy either.
  const gymId = await makeGym(trx, 'standard');
  const early = (await service.createRateCard({ gymId, retailDailyTzs: 5000, retailWeeklyTzs: 15000, retailMonthlyTzs: 50000, actorId: 'maker' }, { trx })).rateCard;
  assert.equal((await service.activate({ kind: 'rate_card', id: early.id, effectiveFrom: '2026-05-01', actorId: 'checker' }, { trx })).error, 'rule_missing');

  const card = early;
  assert.equal(card.gymTier, 'standard');
  const ok = await service.activate({ kind: 'rate_card', id: card.id, effectiveFrom: '2026-11-01', actorId: 'checker' }, { trx });
  const c = ok.rateCard;
  assert.deepEqual([c.dailyDiscountBps, c.weeklyDiscountBps, c.monthlyDiscountBps, c.dailyCeilingTzs, c.weeklyCeilingTzs, c.monthlyCeilingTzs],
    [2500, 2000, 2000, 3500, 12000, 42000]);
  assert.equal(c.ruleSources.monthlyCeilingTzs.ruleId, 'rule-ceil-standard-1');
  assert.equal(c.ruleSources.dailyDiscountBps.ruleId, 'rule-global-1');
}));

test('a gym-specific rule overrides its tier field by field', () => inRollback(async (trx) => {
  const gymId = await makeGym(trx, 'standard');
  const gymRule = (await service.createRule({ scopeType: 'gym', scopeId: gymId, monthlyCeilingTzs: 45000, monthlyDiscountBps: 1800, actorId: 'maker' }, { trx })).rule;
  await service.activate({ kind: 'rule', id: gymRule.id, effectiveFrom: '2026-11-01', actorId: 'checker' }, { trx });
  const card = (await service.createRateCard({ gymId, retailDailyTzs: 5000, retailWeeklyTzs: 15000, retailMonthlyTzs: 60000, actorId: 'maker' }, { trx })).rateCard;
  const c = (await service.activate({ kind: 'rate_card', id: card.id, effectiveFrom: '2026-11-01', actorId: 'checker' }, { trx })).rateCard;
  assert.equal(c.monthlyCeilingTzs, 45000);          // gym
  assert.equal(c.monthlyDiscountBps, 1800);          // gym
  assert.equal(c.weeklyCeilingTzs, 12000);           // gym tier
  assert.equal(c.weeklyDiscountBps, 2000);           // global
  assert.equal(c.ruleSources.monthlyCeilingTzs.scopeType, 'gym');
  assert.equal(c.ruleSources.weeklyDiscountBps.scopeType, 'global');
}));

test('the service refuses invalid drafts before they reach the database', async () => {
  assert.equal((await service.createPassTierVersion({ tierKey: 'x', priceTzs: 60000.5, visitAllowance: 16, actorId: 'm' })).error, 'price_must_be_whole_tzs');
  assert.equal((await service.createRule({ scopeType: 'gym_tier', scopeId: 'standard', networkPayoutBps: 7000, actorId: 'm' })).error, 'network_rule_scope');
  assert.equal((await service.createRule({ scopeType: 'pass_tier', scopeId: 'pro', dailyCeilingTzs: 1, actorId: 'm' })).error, 'reimbursement_rule_scope');
  assert.equal((await service.createRule({ scopeType: 'global', dailyDiscountBps: 0.25, actorId: 'm' })).error, 'invalid_rule_value');
  assert.equal((await service.createRule({ scopeType: 'global', scopeId: 'x', dailyDiscountBps: 1, actorId: 'm' })).error, 'scope_id_mismatch');
  assert.equal((await service.activate({ kind: 'pass_tier', id: 'x', effectiveFrom: '1/1/2026', actorId: 'c' })).error, 'invalid_effective_from');
});

// ── end to end: tables → Phase 1 resolvers → engine ─────────────────────────

test('the Phase 1 engine settles a cycle straight from the configuration tables', () => inRollback(async (trx) => {
  const gymId = await makeGym(trx, 'midtier');
  const card = (await service.createRateCard({ gymId, retailDailyTzs: 10000, retailWeeklyTzs: 35000, retailMonthlyTzs: 120000, actorId: 'maker' }, { trx })).rateCard;
  await service.activate({ kind: 'rate_card', id: card.id, effectiveFrom: '2026-10-01', actorId: 'checker' }, { trx });

  const config = await service.activeConfiguration({ trx });
  const cycleStart = '2026-10-01T07:00:00.000Z';
  const { terms } = resolveMemberCycleTerms({ ...config, passTier: 'pro', cycleStart, collectedApprovedAmountTzs: 120000 });
  assert.deepEqual([terms.visitAllowance, terms.networkPayoutBps, terms.catalogPriceTzs], [18, 7500, 150000]);
  const { snapshot } = resolveGymRateSnapshot({ rateCards: config.rateCards, gymId, date: resolutionDateForCycle(cycleStart) });

  const visits = Array.from({ length: 15 }, (_, i) => ({
    checkinId: `v${i}`, memberId: 'm1', cycleId: 'sub-1', gymId, status: 'valid', visitConsumed: true, subscriptionType: 'platform_pass',
    timestamp: new Date(Date.UTC(2026, 9, 1 + i, 12)).toISOString(),
  }));
  const result = calculateMemberSettlement({
    cycle: { memberId: 'm1', cycleId: 'sub-1', subscriptionType: 'platform_pass', passTier: 'pro', cycleStart, cycleEnd: '2026-10-31T07:00:00.000Z',
      collectedApprovedAmountTzs: terms.collectedApprovedAmountTzs, networkPayoutBps: terms.networkPayoutBps, visitAllowance: terms.visitAllowance },
    visits, gymRates: [snapshot],
  });
  assert.equal(result.gyms[0].preliminaryTzs, 96000);   // min(120,000 × 80%, 105,000)
  assert.equal(result.member.networkCapTzs, 90000);     // collected 120,000 × 75%, not the 150,000 price
  assert.equal(result.member.totalFinalTzs, 90000);
  assert.equal(result.gyms[0].rateCardSnapshot.rateCardId, card.id);
}));
