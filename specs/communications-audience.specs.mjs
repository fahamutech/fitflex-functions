// Communications M2 — audience filters (pure): validation, the brief's
// compound examples, presets, missing facts, area, and age.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateFilter, buildAudienceFilter, matchesFilter, audienceCatalog, ageOn, PRESETS,
} from '../src/shared/audience.mjs';

const member = (over = {}) => ({
  memberId: 'm', status: 'active', plan: 'monthly', tier: 'basic', paymentStatus: 'approved',
  expiresOn: '2026-10-20', daysUntilExpiry: 20, daysSinceExpiry: null, joinedDaysAgo: 100,
  homeGymId: 'gym_a', lastVisitDaysAgo: 2, visitsLast30Days: 8, totalVisits: 40, engagement: 'active',
  age: 30, gender: 'female', subscriptionType: 'direct_sub', passTier: null, areaGymId: 'gym_a',
  ...over,
});
const matches = (m, f, scope = 'gym', ctx) => {
  const r = buildAudienceFilter(f, scope);
  assert.ok(!r.error, JSON.stringify(r));
  return matchesFilter(m, r.filter, ctx);
};

// ── the brief's compound examples ──────────────────────────────────────────

test('status = ACTIVE AND expiry within 7 days', () => {
  const f = { filter: { all: [
    { field: 'status', op: 'in', value: ['active', 'expiring_soon'] },
    { field: 'daysUntilExpiry', op: 'between', value: [0, 7] },
  ] } };
  assert.equal(matches(member({ status: 'expiring_soon', daysUntilExpiry: 5 }), f), true);
  assert.equal(matches(member({ daysUntilExpiry: 20 }), f), false);
  assert.equal(matches(member({ status: 'expired', daysUntilExpiry: -3 }), f), false);
});

test('status = EXPIRED AND expired between 0 and 30 days ago', () => {
  const f = { filter: { all: [
    { field: 'status', op: 'eq', value: 'expired' },
    { field: 'daysSinceExpiry', op: 'between', value: [0, 30] },
  ] } };
  assert.equal(matches(member({ status: 'expired', daysSinceExpiry: 12 }), f), true);
  assert.equal(matches(member({ status: 'expired', daysSinceExpiry: 45 }), f), false);
  assert.equal(matches(member({ status: 'active' }), f), false);
});

test('OR groups nest inside AND groups', () => {
  const f = { filter: { all: [
    { field: 'gender', op: 'eq', value: 'female' },
    { any: [{ field: 'age', op: 'lte', value: 25 }, { field: 'engagement', op: 'in', value: ['slipping', 'at_risk'] }] },
  ] } };
  assert.equal(matches(member({ age: 22 }), f), true);
  assert.equal(matches(member({ engagement: 'at_risk' }), f), true);
  assert.equal(matches(member({ age: 40 }), f), false);
  assert.equal(matches(member({ age: 22, gender: 'male' }), f), false);
});

// ── presets ────────────────────────────────────────────────────────────────

test('gym presets: all leaves out suspended; active includes expiring soon', () => {
  const p = (key, m) => matches(m, { preset: key });
  assert.equal(p('all', member({ status: 'suspended' })), false);
  assert.equal(p('all', member({ status: 'expired' })), true);
  assert.equal(p('active', member({ status: 'expiring_soon' })), true);
  assert.equal(p('active', member({ status: 'expired' })), false);
  assert.equal(p('expiring', member({ status: 'expiring_soon' })), true);
  assert.equal(p('recently_expired', member({ status: 'expired', daysSinceExpiry: 40 })), false);
  assert.equal(p('new', member({ joinedDaysAgo: 10 })), true);
  assert.equal(p('new', member({ joinedDaysAgo: 10, status: 'expired' })), false);
});

test('inactive: 14+ days since the last visit, or never visited after 14 days as a member', () => {
  const p = (m) => matches(m, { preset: 'inactive' });
  assert.equal(p(member({ lastVisitDaysAgo: 14 })), true);
  assert.equal(p(member({ lastVisitDaysAgo: 13 })), false);
  assert.equal(p(member({ lastVisitDaysAgo: null, joinedDaysAgo: 20 })), true);
  assert.equal(p(member({ lastVisitDaysAgo: null, joinedDaysAgo: 3 })), false, 'a brand-new member is not inactive');
  assert.equal(p(member({ lastVisitDaysAgo: 40, status: 'expired' })), false, 'expired members are a different audience');
});

test('a preset and a custom filter are AND-ed', () => {
  const f = { preset: 'active', filter: { all: [{ field: 'plan', op: 'eq', value: 'monthly' }] } };
  assert.equal(matches(member(), f), true);
  assert.equal(matches(member({ plan: 'weekly' }), f), false);
});

// ── missing facts ──────────────────────────────────────────────────────────

test('a condition on a missing fact matches only exists:false', () => {
  const noAge = member({ age: null });
  assert.equal(matches(noAge, { filter: { all: [{ field: 'age', op: 'lte', value: 99 }] } }), false);
  assert.equal(matches(noAge, { filter: { all: [{ field: 'age', op: 'gte', value: 0 }] } }), false);
  assert.equal(matches(noAge, { filter: { all: [{ field: 'age', op: 'exists', value: false }] } }), true);
  assert.equal(matches(member({ gender: null }), { filter: { all: [{ field: 'gender', op: 'neq', value: 'male' }] } }), false);
});

test('text fields compare without case; dates compare as local days', () => {
  assert.equal(matches(member({ tier: 'Premium' }), { filter: { all: [{ field: 'tier', op: 'in', value: ['premium', 'pro'] }] } }), true);
  const before = { filter: { all: [{ field: 'expiresOn', op: 'before', value: '2026-10-21' }] } };
  assert.equal(matches(member(), before), true);
  assert.equal(matches(member({ expiresOn: '2026-10-21' }), before), false);
});

// ── area (FitFlex only) ────────────────────────────────────────────────────

test('area: gym location text, or within a radius of a gym', () => {
  const gymsById = new Map([
    ['gym_a', { id: 'gym_a', location: 'Masaki, Dar es Salaam', coordinates: { lat: -6.7469, lng: 39.2666 } }],
    ['gym_b', { id: 'gym_b', location: 'Mikocheni, Dar es Salaam', coordinates: { lat: -6.7707, lng: 39.2434 } }],
    ['gym_c', { id: 'gym_c', location: 'Arusha', coordinates: { lat: -3.3869, lng: 36.683 } }],
    ['gym_x', { id: 'gym_x', location: 'Unknown', coordinates: { lat: null, lng: null } }],
  ]);
  const ctx = { gymsById };
  const contains = { filter: { all: [{ field: 'area', op: 'contains', value: 'dar es salaam' }] } };
  const near = { filter: { all: [{ field: 'area', op: 'within_km', value: { gymId: 'gym_b', km: 10 } }] } };
  assert.equal(matches(member({ areaGymId: 'gym_a' }), contains, 'platform', ctx), true);
  assert.equal(matches(member({ areaGymId: 'gym_c' }), contains, 'platform', ctx), false);
  assert.equal(matches(member({ areaGymId: 'gym_a' }), near, 'platform', ctx), true);
  assert.equal(matches(member({ areaGymId: 'gym_c' }), near, 'platform', ctx), false);
  assert.equal(matches(member({ areaGymId: 'gym_x' }), near, 'platform', ctx), false, 'no coordinates → not near');
  assert.equal(matches(member({ areaGymId: null }), contains, 'platform', ctx), false);
});

// ── validation ─────────────────────────────────────────────────────────────

test('gyms cannot use FitFlex-only fields', () => {
  for (const field of ['area', 'subscriptionType', 'passTier']) {
    const r = validateFilter({ all: [{ field, op: 'exists', value: true }] }, 'gym');
    assert.equal(r.error, 'invalid_audience');
    assert.equal(r.detail, `field_not_allowed:${field}`);
  }
  assert.ok(!validateFilter({ all: [{ field: 'area', op: 'contains', value: 'Arusha' }] }, 'platform').error);
});

test('bad filters are refused with a reason', () => {
  const detail = (f, scope = 'gym') => validateFilter(f, scope).detail;
  assert.equal(detail({ field: 'age', op: 'gte', value: 1 }), 'root_must_be_group');
  assert.equal(detail({ all: [{ field: 'shoeSize', op: 'eq', value: 1 }] }), 'unknown_field:shoeSize');
  assert.equal(detail({ all: [{ field: 'age', op: 'contains', value: '3' }] }), 'bad_operator:age:contains');
  assert.equal(detail({ all: [{ field: 'status', op: 'eq', value: 'gold' }] }), 'bad_value:status');
  assert.equal(detail({ all: [{ field: 'age', op: 'between', value: [40, 20] }] }), 'bad_value:age');
  assert.equal(detail({ all: [{ field: 'expiresOn', op: 'after', value: '20/10/2026' }] }), 'bad_value:expiresOn');
  assert.equal(detail({ all: [{ field: 'age', op: 'gte', value: '30' }] }), 'bad_value:age');
  assert.equal(detail({ any: [] }), 'empty_any');
  assert.equal(detail({ all: [], any: [] }), 'root_must_be_group');
  assert.equal(detail({ all: [{ all: [{ all: [{ all: [] }] }] }] }), 'too_deep');
  const many = { all: Array.from({ length: 26 }, () => ({ field: 'age', op: 'gte', value: 1 })) };
  assert.equal(detail(many), 'too_many_conditions');
  assert.equal(buildAudienceFilter({ preset: 'vip' }, 'gym').detail, 'unknown_preset:vip');
  assert.equal(buildAudienceFilter({ preset: 'pass_holders' }, 'gym').detail, 'unknown_preset:pass_holders');
  assert.equal(buildAudienceFilter({}, 'gym').detail, 'audience_required');
});

test('validation returns a clean copy without extra keys', () => {
  const r = validateFilter({ all: [{ field: 'age', op: 'gte', value: 18, sql: 'DROP TABLE' }] }, 'gym');
  assert.deepEqual(r.filter, { all: [{ field: 'age', op: 'gte', value: 18 }] });
});

test('every preset is a valid filter for its own scope', () => {
  for (const scope of ['gym', 'platform']) {
    for (const [key, filter] of Object.entries(PRESETS[scope])) {
      assert.ok(!validateFilter(filter, scope).error, `${scope}.${key}`);
    }
  }
});

test('the catalogue lists only fields the scope may use', () => {
  const gym = audienceCatalog('gym').fields.map(f => f.key);
  const platform = audienceCatalog('platform').fields.map(f => f.key);
  assert.ok(!gym.includes('area'));
  assert.ok(platform.includes('area'));
  assert.ok(audienceCatalog('gym').presets.some(p => p.key === 'inactive'));
});

test('age in whole years on a local day', () => {
  assert.equal(ageOn('1996-10-02', '2026-10-01'), 29);
  assert.equal(ageOn('1996-10-01', '2026-10-01'), 30);
  assert.equal(ageOn('2030-01-01', '2026-10-01'), null);
  assert.equal(ageOn('not a date', '2026-10-01'), null);
  assert.equal(ageOn(null, '2026-10-01'), null);
});
