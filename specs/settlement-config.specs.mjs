// Settlement configuration resolvers (Phase 1): effective dating, field-level
// precedence, snapshots. Pure-function tests: no database.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEffectiveOn, resolutionDateForCycle, resolveReimbursementRule, resolveNetworkPayoutBps,
  resolveRateCard, resolvePassTierVersion, resolveGymRateSnapshot, resolveMemberCycleTerms,
  legacyKycGraceActive
} from '../src/shared/settlement-config.mjs';
import { calculateMemberSettlement } from '../src/shared/settlement-engine.mjs';
import { RULES, RATE_CARDS, PASS_TIER_VERSIONS, cycleFor, dailyVisits, approveCard } from './fixtures/settlement-dar.mjs';

const rule = (id, fields) => ({ id, version: 1, status: 'active', effectiveFrom: '2026-01-01', effectiveTo: null, ...fields });

describe('effective dating', () => {
  test('effectiveFrom is inclusive, effectiveTo exclusive, only active rows count', () => {
    const row = { status: 'active', effectiveFrom: '2026-10-15', effectiveTo: '2026-11-01' };
    assert.equal(isEffectiveOn(row, '2026-10-14'), false);
    assert.equal(isEffectiveOn(row, '2026-10-15'), true);
    assert.equal(isEffectiveOn(row, '2026-10-31'), true);
    assert.equal(isEffectiveOn(row, '2026-11-01'), false);
    assert.equal(isEffectiveOn({ ...row, status: 'draft' }, '2026-10-20'), false);
    assert.equal(isEffectiveOn({ ...row, status: 'superseded' }, '2026-10-20'), false);
  });
  test('DR-10: a cycle resolves on its start date in EAT, not UTC', () => {
    assert.equal(resolutionDateForCycle('2026-10-14T21:30:00.000Z'), '2026-10-15');   // 00:30 EAT
    assert.equal(resolutionDateForCycle('2026-10-14T20:59:59.000Z'), '2026-10-14');   // 23:59 EAT
  });
});

describe('field-level rule precedence (DR-06, DR-07, DR-10)', () => {
  const rules = [
    rule('g', { scopeType: 'global', dailyDiscountBps: 2_500, weeklyDiscountBps: 2_000, monthlyDiscountBps: 2_000, networkPayoutBps: 7_500 }),
    rule('t', { scopeType: 'gym_tier', scopeId: 'standard', dailyCeilingTzs: 3_500, weeklyCeilingTzs: 12_000, monthlyCeilingTzs: 42_000 }),
    rule('x', { scopeType: 'gym', scopeId: 'gym-A', monthlyCeilingTzs: 45_000 })   // overrides one field only
  ];
  test('each field comes from the most specific rule that sets it', () => {
    const r = resolveReimbursementRule({ rules, date: '2026-10-01', gymTier: 'standard', gymId: 'gym-A' });
    assert.deepEqual(r.missing, []);
    assert.equal(r.values.monthlyCeilingTzs, 45_000);
    assert.equal(r.values.weeklyCeilingTzs, 12_000);
    assert.equal(r.values.dailyDiscountBps, 2_500);
    assert.deepEqual(r.sources.monthlyCeilingTzs, { ruleId: 'x', version: 1, scopeType: 'gym', scopeId: 'gym-A' });
    assert.equal(r.sources.weeklyCeilingTzs.ruleId, 't');
  });
  test('another gym of the same tier keeps the tier ceiling', () => {
    const r = resolveReimbursementRule({ rules, date: '2026-10-01', gymTier: 'standard', gymId: 'gym-B' });
    assert.equal(r.values.monthlyCeilingTzs, 42_000);
  });
  test('the gym tier, not the pass tier, supplies ceilings; PASS_TIER rules never set reimbursement', () => {
    const withPass = [...rules, rule('p', { scopeType: 'pass_tier', scopeId: 'premium', dailyCeilingTzs: 12_000, dailyDiscountBps: 0 })];
    const r = resolveReimbursementRule({ rules: withPass, date: '2026-10-01', gymTier: 'standard', gymId: 'gym-B' });
    assert.equal(r.values.dailyCeilingTzs, 3_500);
    assert.equal(r.values.dailyDiscountBps, 2_500);
  });
  test('network %: PASS_TIER overrides GLOBAL; GYM_TIER, GYM and SPECIAL_CONTRACT are ignored (DR-07)', () => {
    const net = [...rules,
      rule('p', { scopeType: 'pass_tier', scopeId: 'executive', networkPayoutBps: 7_000 }),
      rule('gt', { scopeType: 'gym_tier', scopeId: 'standard', networkPayoutBps: 5_000 }),
      rule('gy', { scopeType: 'gym', scopeId: 'gym-A', networkPayoutBps: 5_000 }),
      rule('sc', { scopeType: 'special_contract', scopeId: 'k1', networkPayoutBps: 1_000 })];
    assert.equal(resolveNetworkPayoutBps({ rules: net, date: '2026-10-01', passTier: 'executive' }).networkPayoutBps, 7_000);
    assert.equal(resolveNetworkPayoutBps({ rules: net, date: '2026-10-01', passTier: 'basic' }).networkPayoutBps, 7_500);
  });
  test('SPECIAL_CONTRACT rules are reserved and never resolved for reimbursement', () => {
    const r = resolveReimbursementRule({ rules: [...rules, rule('sc', { scopeType: 'special_contract', scopeId: 'gym-A', dailyCeilingTzs: 1 })],
      date: '2026-10-01', gymTier: 'standard', gymId: 'gym-A' });
    assert.equal(r.values.dailyCeilingTzs, 3_500);
  });
  test('a missing field is reported, not defaulted', () => {
    const r = resolveReimbursementRule({ rules: [rules[0]], date: '2026-10-01', gymTier: 'standard', gymId: 'gym-A' });
    assert.deepEqual(r.missing, ['dailyCeilingTzs', 'weeklyCeilingTzs', 'monthlyCeilingTzs']);
    const { dailyCeilingTzs, ...incomplete } = RATE_CARDS[0];
    const s = resolveGymRateSnapshot({ rateCards: [incomplete], gymId: 'gym-A', date: '2026-10-01' });
    assert.equal(s.error, 'rate_card_incomplete');
    assert.deepEqual(s.missing, ['dailyCeilingTzs']);
    assert.equal(s.snapshot, undefined);
  });
  test('two effective rules at the same scope are a configuration error', () => {
    const clash = [...rules, rule('t2', { scopeType: 'gym_tier', scopeId: 'standard', dailyCeilingTzs: 4_000 })];
    assert.throws(() => resolveReimbursementRule({ rules: clash, date: '2026-10-01', gymTier: 'standard', gymId: 'gym-A' }), /overlapping/);
  });
});

describe('K: historical rate cards and rules (DR-10, DR-23)', () => {
  const cards = [
    { id: 'rc-A-1', gymId: 'gym-A', version: 1, gymTier: 'standard', status: 'active', effectiveFrom: '2026-01-01', effectiveTo: '2026-10-15', retailDailyTzs: 5_000, retailWeeklyTzs: 15_000, retailMonthlyTzs: 50_000 },
    { id: 'rc-A-2', gymId: 'gym-A', version: 2, gymTier: 'standard', status: 'active', effectiveFrom: '2026-10-15', effectiveTo: null, retailDailyTzs: 4_000, retailWeeklyTzs: 12_000, retailMonthlyTzs: 40_000 }
  ].map(card => approveCard(card));
  test('a cycle starting before the rate change uses the old card; after, the new one', () => {
    assert.equal(resolveRateCard({ rateCards: cards, gymId: 'gym-A', date: '2026-10-01' }).id, 'rc-A-1');
    assert.equal(resolveRateCard({ rateCards: cards, gymId: 'gym-A', date: '2026-10-14' }).id, 'rc-A-1');
    assert.equal(resolveRateCard({ rateCards: cards, gymId: 'gym-A', date: '2026-10-15' }).id, 'rc-A-2');
    assert.equal(resolveRateCard({ rateCards: cards, gymId: 'gym-A', date: '2025-12-31' }), null);
  });
  test('visits after the change still pay the rate in force at the cycle start', () => {
    const date = resolutionDateForCycle('2026-10-01T07:00:00.000Z');
    const { snapshot } = resolveGymRateSnapshot({ rateCards: cards, gymId: 'gym-A', date });
    // all 5 visits fall on 16–20 Oct, after rc-A-2 took effect
    const r = calculateMemberSettlement({ cycle: cycleFor('basic'), visits: dailyVisits('gym-A', 5, { firstDay: 16 }), gymRates: [snapshot] });
    assert.equal(r.gyms[0].rateCardSnapshot.rateCardId, 'rc-A-1');
    assert.equal(r.gyms[0].preliminaryTzs, 12_000);        // old weekly 15,000 → 12,000, not new 9,600
  });
  test('changing today\'s configuration does not change an old snapshot\'s result', () => {
    const date = '2026-10-01';
    const { snapshot } = resolveGymRateSnapshot({ rateCards: cards, gymId: 'gym-A', date });
    const input = { cycle: cycleFor('basic'), visits: dailyVisits('gym-A', 8), gymRates: [snapshot] };
    const before = calculateMemberSettlement(input);
    // Later: the gym's card is edited and a new ceiling rule is approved.
    cards[0].retailWeeklyTzs = 1_000;
    const laterRules = [...RULES, { id: 'rule-ceil-standard-2', version: 2, scopeType: 'gym_tier', scopeId: 'standard', status: 'active', effectiveFrom: '2026-11-01', effectiveTo: null, weeklyCeilingTzs: 5_000 }];
    assert.equal(Object.isFrozen(snapshot), true);
    assert.deepEqual(calculateMemberSettlement(input), before);
    // Re-resolving the old date still ignores a rule that starts later.
    const again = resolveReimbursementRule({ rules: laterRules, date, gymTier: 'standard', gymId: 'gym-A' });
    assert.equal(again.values.weeklyCeilingTzs, 12_000);
    assert.equal(before.gyms[0].preliminaryTzs, 24_000);
  });
  test('approval copies the rules in force on the card\'s start date; a later rule needs a new card version', () => {
    // Activating v2 closes v1 on the day v2 starts.
    const closed = RULES.map(r => (r.id === 'rule-ceil-standard' ? { ...r, effectiveTo: '2026-11-01' } : r));
    const laterRules = [...closed, { id: 'rule-ceil-standard-2', version: 2, scopeType: 'gym_tier', scopeId: 'standard', status: 'active', effectiveFrom: '2026-11-01', effectiveTo: null,
      dailyCeilingTzs: 3_500, weeklyCeilingTzs: 5_000, monthlyCeilingTzs: 42_000 }];
    const card = { id: 'rc-A-9', gymId: 'gym-A', version: 9, gymTier: 'standard', status: 'active', effectiveFrom: '2026-10-15', effectiveTo: null, retailDailyTzs: 5_000, retailWeeklyTzs: 15_000, retailMonthlyTzs: 50_000 };
    assert.equal(approveCard(card, laterRules).weeklyCeilingTzs, 12_000);                                  // approved before the rule starts
    assert.equal(approveCard({ ...card, effectiveFrom: '2026-11-01' }, laterRules).weeklyCeilingTzs, 5_000); // the re-derived version
    assert.deepEqual(approveCard(card, laterRules).ruleSources.weeklyCeilingTzs, { ruleId: 'rule-ceil-standard', version: 1, scopeType: 'gym_tier', scopeId: 'standard' });
  });
  test('two overlapping rate cards for one gym are a configuration error', () => {
    const clash = [...cards, { ...cards[1], id: 'rc-A-x' }];
    assert.throws(() => resolveRateCard({ rateCards: clash, gymId: 'gym-A', date: '2026-10-20' }), /overlapping/);
  });
  test('a gym without a card gives no snapshot', () => {
    assert.equal(resolveGymRateSnapshot({ rateCards: cards, gymId: 'gym-Q', date: '2026-10-20' }).error, 'no_rate_card');
  });
});

describe('member cycle terms (DR-05, DR-22)', () => {
  test('the approved pass economics', () => {
    const expected = { basic: [60_000, 16], pro: [150_000, 18], premium: [250_000, 20], executive: [400_000, 24] };
    for (const [tier, [price, allowance]] of Object.entries(expected)) {
      const v = resolvePassTierVersion({ passTierVersions: PASS_TIER_VERSIONS, tierKey: tier, date: '2026-10-01' });
      assert.deepEqual([v.priceTzs, v.visitAllowance], [price, allowance], tier);
    }
  });
  test('allowance and network % come from the pass tier; the cap basis is the collected amount', () => {
    const { terms } = resolveMemberCycleTerms({ passTierVersions: PASS_TIER_VERSIONS, rules: RULES, passTier: 'pro',
      cycleStart: '2026-10-01T07:00:00.000Z', collectedApprovedAmountTzs: 120_000 });
    assert.equal(terms.catalogPriceTzs, 150_000);
    assert.equal(terms.collectedApprovedAmountTzs, 120_000);
    assert.equal(terms.visitAllowance, 18);
    assert.equal(terms.networkPayoutBps, 7_500);
    assert.equal(terms.networkPayoutSource.ruleId, 'rule-global');
  });
  test('a future pass version applies only to cycles starting on or after its date', () => {
    const versions = [
      { ...PASS_TIER_VERSIONS[0], effectiveTo: '2027-01-01' },
      { id: 'ptv-basic-2', tierKey: 'basic', version: 2, status: 'active', effectiveFrom: '2027-01-01', effectiveTo: null, priceTzs: 70_000, visitAllowance: 18 }
    ];
    const at = cycleStart => resolveMemberCycleTerms({ passTierVersions: versions, rules: RULES, passTier: 'basic', cycleStart, collectedApprovedAmountTzs: 60_000 }).terms;
    assert.equal(at('2026-12-31T07:00:00.000Z').visitAllowance, 16);   // existing cycles keep their snapshot
    assert.equal(at('2027-01-01T07:00:00.000Z').visitAllowance, 18);
  });
  test('an unknown pass tier is reported, not defaulted', () => {
    const r = resolveMemberCycleTerms({ passTierVersions: PASS_TIER_VERSIONS, rules: RULES, passTier: 'gold', cycleStart: '2026-10-01T07:00:00.000Z', collectedApprovedAmountTzs: 1 });
    assert.equal(r.error, 'no_pass_tier_version');
  });
});

describe('DR-08 legacy KYC grace placeholder', () => {
  test('no date supplied: no grace, a verified account is required', () => {
    assert.equal(legacyKycGraceActive({ legacyKycGraceEndsAt: null, at: '2026-10-01T00:00:00.000Z' }), false);
  });
  test('a fixed end date: grace before it, none from it', () => {
    const legacyKycGraceEndsAt = '2026-10-28T06:00:00.000Z';
    assert.equal(legacyKycGraceActive({ legacyKycGraceEndsAt, at: '2026-10-28T05:59:59.000Z' }), true);
    assert.equal(legacyKycGraceActive({ legacyKycGraceEndsAt, at: '2026-10-28T06:00:00.000Z' }), false);
  });
  test('an invalid date fails loudly instead of granting a permanent exemption', () => {
    assert.throws(() => legacyKycGraceActive({ legacyKycGraceEndsAt: 'forever', at: '2026-10-01T00:00:00.000Z' }), TypeError);
  });
});
