import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCheckIn as validateRaw, classifyVisit, CHECKIN_FAILURE, subscriptionCoversGym, pickSubscriptionForGym, PASS_GYM_ACCESS, gymAccessTiers } from '../src/shared/check-in-rules.mjs';
import { settingsWithTiers, TEST_TIERS } from './fixtures/tier-settings.mjs';

// Settings is the only source of tier caps and gym access: pass the
// subscription tier's config from Settings, as the services do.
const settings = settingsWithTiers();
const validateCheckIn = (ctx) => validateRaw({ tierConfig: settings.getTierConfig(ctx.subscription?.tier), ...ctx });

const stdGym = { id: 'g1', tier: 'standard' };  // 24/7 (no operatingHours)
const midGym = { id: 'g2', tier: 'midtier' };

const activeBasic = { status: 'active', tier: 'basic',     expiresAt: '2099-01-01' };
const activePro   = { status: 'active', tier: 'pro',       expiresAt: '2099-01-01' };
const activeExec  = { status: 'active', tier: 'executive', expiresAt: '2099-01-01' };
const activeOnline = { status: 'active', tier: 'online_free', expiresAt: '2099-01-01' };

test('BL-010: same gym same day does NOT consume an additional visit', () => {
  const todays = [{ gymId: 'g1', timestamp: new Date().toISOString() }];
  const c = classifyVisit(todays, 'g1');
  assert.equal(c.consumesVisit, false);
  assert.equal(c.sameDaySameGym, true);
});

test('BL-011: a different gym the same day consumes a second visit (that gym is paid for it)', () => {
  const todays = [{ gymId: 'g1' }];
  const c = classifyVisit(todays, 'g2');
  assert.equal(c.consumesVisit, true);
  assert.equal(c.sameDayAlreadyCheckedIn, true);
  assert.equal(c.differentGymToday, true);
});

test('BL-012 step 1: inactive subscription rejected', () => {
  const r = validateCheckIn({ subscription: { status: 'expired', expiresAt: '2000-01-01' },
                              gym: stdGym, todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 0 } });
  assert.equal(r.ok, false);
  assert.equal(r.failure, CHECKIN_FAILURE.SUBSCRIPTION_INACTIVE);
});

test('BL-012 step 1: 24h grace period allows check-in', () => {
  const justExpired = new Date(Date.now() - 60_000).toISOString();
  const r = validateCheckIn({ subscription: { status: 'expired', tier: 'pro', expiresAt: justExpired },
                              gym: stdGym, todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 0 } });
  assert.equal(r.ok, true);
});

test('BL-012 step 2: Basic cannot enter Mid-Tier gym', () => {
  const r = validateCheckIn({ subscription: activeBasic, gym: midGym,
                              todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 0 } });
  assert.equal(r.failure, CHECKIN_FAILURE.TIER_NOT_COVERED);
});

test('Free online plan: refused while it is not configured in Settings', () => {
  const online = validateCheckIn({ subscription: activeOnline, gym: { id: 'online_1', tier: 'online', accessMode: 'free_online' },
                                  todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 0 } });
  assert.equal(online.ok, false);
  assert.equal(online.failure, CHECKIN_FAILURE.TIER_NOT_CONFIGURED);
});

test('Free online plan configured in Settings only covers online gyms', () => {
  const withOnline = settingsWithTiers([...TEST_TIERS, { key: 'online_free', label: 'Online', monthlyPrice: 0, visits: -1, gymAccess: 'online' }]);
  const tierConfig = withOnline.getTierConfig('online_free');
  const online = validateRaw({ subscription: activeOnline, gym: { id: 'online_1', tier: 'online', accessMode: 'free_online' },
                               todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 0 }, tierConfig });
  assert.equal(online.ok, true);
  const physical = validateRaw({ subscription: activeOnline, gym: stdGym, todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 0 }, tierConfig });
  assert.equal(physical.failure, CHECKIN_FAILURE.TIER_NOT_COVERED);
});

test('Basic tier blocked when visiting a different gym same day', () => {
  const r = validateCheckIn({ subscription: activeBasic, gym: { id: 'g3', tier: 'standard' },
                              todaysCheckins: [{ gymId: 'g1' }], cycleUsage: { visitsUsedInCycle: 5 } });
  assert.equal(r.failure, CHECKIN_FAILURE.BASIC_DAILY_LIMIT);
});

test('BL-012 step 3: visit cap exhausted', () => {
  const r = validateCheckIn({ subscription: activePro, gym: stdGym,
                              todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 30 } });
  assert.equal(r.failure, CHECKIN_FAILURE.VISITS_EXHAUSTED);
});

test('Unlimited (executive) plan never exhausts', () => {
  const r = validateCheckIn({ subscription: activeExec, gym: { id: 'gx', tier: 'luxury_executive' },
                              todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 9999 } });
  assert.equal(r.ok, true);
});

test('Same-gym-same-day check-in does not count against cap even at cap', () => {
  const r = validateCheckIn({ subscription: activePro, gym: stdGym,
                              todaysCheckins: [{ gymId: 'g1' }],
                              cycleUsage: { visitsUsedInCycle: 30 } });
  assert.equal(r.ok, true);
  assert.equal(r.visitConsumed, false);
});

test('BL-012 step 4: gym closed', () => {
  const closedGym = { id: 'gc', tier: 'standard',
    operatingHours: { default: { open: '06:00', close: '22:00' } } };
  // 02:00 EAT  =>  23:00 UTC previous day
  const fakeNow = new Date('2026-04-25T23:00:00Z');
  const r = validateCheckIn({ subscription: activePro, gym: closedGym,
                              todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 0 }, now: fakeNow });
  assert.equal(r.failure, CHECKIN_FAILURE.GYM_CLOSED);
});

test('Successful check-in returns visitConsumed=true on first visit of the day', () => {
  const r = validateCheckIn({ subscription: activePro, gym: stdGym,
                              todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 5 } });
  assert.equal(r.ok, true);
  assert.equal(r.visitConsumed, true);
});

// ── Gym-bound plans: direct gym plans and trainer passes only open their own gym ──

const directAtG1 = { status: 'active', type: 'direct_sub', tier: null, homeGymId: 'g1', expiresAt: '2099-01-01', startedAt: '2026-09-01' };
const trainerPassAtG1 = { ...directAtG1, type: 'trainer_pass' };

test('Gym-bound: direct plan checks in at its own gym', () => {
  const r = validateCheckIn({ subscription: directAtG1, gym: stdGym, todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 0 } });
  assert.equal(r.ok, true);
});

test('Gym-bound: direct plan is rejected at another gym', () => {
  const r = validateCheckIn({ subscription: directAtG1, gym: midGym, todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 0 } });
  assert.equal(r.ok, false);
  assert.equal(r.failure, CHECKIN_FAILURE.WRONG_GYM);
});

test('Gym-bound: trainer pass is rejected at another gym', () => {
  const r = validateCheckIn({ subscription: trainerPassAtG1, gym: midGym, todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 0 } });
  assert.equal(r.failure, CHECKIN_FAILURE.WRONG_GYM);
});

test('Gym-bound: platform passes still roam', () => {
  assert.equal(subscriptionCoversGym({ ...activeExec, type: 'platform_pass' }, midGym), true);
});

test('pickSubscriptionForGym prefers the newest plan that covers the gym', () => {
  const olderPlatform = { ...activePro, type: 'platform_pass', startedAt: '2026-08-01' };
  const newerDirectElsewhere = { ...directAtG1, homeGymId: 'g9', startedAt: '2026-09-10' };
  assert.equal(pickSubscriptionForGym([newerDirectElsewhere, olderPlatform], stdGym), olderPlatform);
});

test('pickSubscriptionForGym falls back to the newest plan so the failure is explained', () => {
  const elsewhere = { ...directAtG1, homeGymId: 'g9' };
  assert.equal(pickSubscriptionForGym([elsewhere], stdGym), elsewhere);
  assert.equal(pickSubscriptionForGym([], stdGym), null);
});

// ── Owner decision 2026-10-19: Settings is the only tier source (fail closed) ──

test('a pass whose tier is not in Settings is refused, never treated as unlimited', () => {
  const r = validateRaw({ subscription: { status: 'active', tier: 'gold', expiresAt: '2099-01-01' }, gym: stdGym,
                          todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 0 }, tierConfig: settings.getTierConfig('gold') });
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'tier_not_configured');
  assert.equal(CHECKIN_FAILURE.TIER_NOT_CONFIGURED, 'tier_not_configured');
});

test('a tiered pass with no tier config at all is refused (no built-in fallback)', () => {
  for (const tier of ['basic', 'pro', 'premium', 'executive', 'online_free']) {
    const r = validateRaw({ subscription: { status: 'active', tier, expiresAt: '2099-01-01' }, gym: stdGym,
                            todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 0 } });
    assert.equal(r.failure, CHECKIN_FAILURE.TIER_NOT_CONFIGURED, tier);
  }
});

test('a tier in Settings without an explicit visits value, or switched off, is not configured', () => {
  const s = settingsWithTiers([
    { key: 'basic', label: 'Basic', monthlyPrice: 60_000, gymAccess: 'standard' },                    // no visits
    { key: 'pro', label: 'Pro', monthlyPrice: 120_000, visits: 0, gymAccess: 'midtier' },             // zero
    { key: 'premium', label: 'Premium', monthlyPrice: 200_000, visits: 40, gymAccess: 'premium', active: false },
  ]);
  for (const tier of ['basic', 'pro', 'premium']) {
    assert.equal(s.getTierConfig(tier), null, tier);
    const r = validateRaw({ subscription: { status: 'active', tier, expiresAt: '2099-01-01' }, gym: stdGym,
                            todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 0 }, tierConfig: s.getTierConfig(tier) });
    assert.equal(r.failure, CHECKIN_FAILURE.TIER_NOT_CONFIGURED, tier);
  }
});

test('the visit cap comes from Settings: a changed cap applies at once', () => {
  const s = settingsWithTiers([{ key: 'pro', label: 'Pro', monthlyPrice: 60_000, visits: 12, gymAccess: 'midtier' }]);
  const r = validateRaw({ subscription: activePro, gym: stdGym, todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 12 },
                          tierConfig: s.getTierConfig('pro') });
  assert.equal(r.failure, CHECKIN_FAILURE.VISITS_EXHAUSTED);
});

test('a gym-desk plan labelled with a tier not in Settings still works as before (gym plans are not pass sales)', () => {
  const deskPlan = { ...directAtG1, tier: 'standard' };
  const r = validateRaw({ subscription: deskPlan, gym: stdGym, todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 999 },
                          tierConfig: settings.getTierConfig('standard') });
  assert.equal(r.ok, true);
  // A configured label keeps applying its Settings rules, as before.
  const basicDesk = { ...directAtG1, tier: 'basic' };
  const capped = validateRaw({ subscription: basicDesk, gym: stdGym, todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 20 },
                               tierConfig: settings.getTierConfig('basic') });
  assert.equal(capped.failure, CHECKIN_FAILURE.VISITS_EXHAUSTED);
});

test('gym plans and trainer passes carry no tier and need no tier config', () => {
  const r = validateRaw({ subscription: directAtG1, gym: stdGym, todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 999 } });
  assert.equal(r.ok, true);
  const t = validateRaw({ subscription: trainerPassAtG1, gym: stdGym, todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 999 } });
  assert.equal(t.ok, true);
});

// ── Security review M3: gym access must be a known value (fail closed) ──

test('a tier with a missing or unknown gymAccess is not configured, and never covers every gym', () => {
  const s = settingsWithTiers([
    { key: 'pro', label: 'Pro', monthlyPrice: 60_000, visits: 30 },                          // no gymAccess
    { key: 'premium', label: 'Premium', monthlyPrice: 100_000, visits: 30, gymAccess: 'all' }, // unknown
  ]);
  const luxury = { id: 'gl', tier: 'luxury_executive' };
  for (const tier of ['pro', 'premium']) {
    assert.equal(s.getTierConfig(tier), null, tier);
    assert.equal(s.isTierSellable(tier), false, tier);
    const r = validateRaw({ subscription: { status: 'active', tier, expiresAt: '2099-01-01' }, gym: luxury,
                            todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 0 }, tierConfig: s.getTierConfig(tier) });
    assert.equal(r.failure, CHECKIN_FAILURE.TIER_NOT_CONFIGURED, tier);
  }
});

test('a tier config handed in without a known gymAccess is refused at check-in (no "all gyms" fallback)', () => {
  for (const tierConfig of [{ visitCap: 30 }, { visitCap: 30, gymAccess: 'everywhere' }, { visitCap: Infinity, gymAccess: '' }]) {
    const r = validateRaw({ subscription: activePro, gym: { id: 'gl', tier: 'luxury_executive' }, todaysCheckins: [],
                            cycleUsage: { visitsUsedInCycle: 0 }, tierConfig });
    assert.equal(r.failure, CHECKIN_FAILURE.TIER_NOT_CONFIGURED, JSON.stringify(tierConfig));
  }
  // A gym plan labelled with such a tier stays a plain gym plan at its own gym.
  const r = validateRaw({ subscription: { ...directAtG1, tier: 'pro' }, gym: stdGym, todaysCheckins: [],
                          cycleUsage: { visitsUsedInCycle: 0 }, tierConfig: { visitCap: 30 } });
  assert.equal(r.ok, true);
});

test('PASS_GYM_ACCESS lists the known gym access values; each covers only its tiers', () => {
  assert.deepEqual([...PASS_GYM_ACCESS].sort(), ['luxury_executive', 'midtier', 'online', 'premium', 'standard']);
  assert.deepEqual(gymAccessTiers('midtier'), ['standard', 'midtier']);
  for (const v of [undefined, null, '', 'all', 'toString', '__proto__']) assert.equal(gymAccessTiers(v), null, String(v));
});
