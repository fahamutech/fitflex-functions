import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCheckIn, classifyVisit, CHECKIN_FAILURE } from '../src/shared/check-in-rules.mjs';

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

test('BL-011: different gym same day DOES consume a visit', () => {
  const todays = [{ gymId: 'g1' }];
  const c = classifyVisit(todays, 'g2');
  assert.equal(c.consumesVisit, true);
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

test('Free online plan only covers online free gyms', () => {
  const online = validateCheckIn({ subscription: activeOnline, gym: { id: 'online_1', tier: 'online', accessMode: 'free_online' },
                                  todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 0 } });
  assert.equal(online.ok, true);

  const physical = validateCheckIn({ subscription: activeOnline, gym: stdGym,
                                     todaysCheckins: [], cycleUsage: { visitsUsedInCycle: 0 } });
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
