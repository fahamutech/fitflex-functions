// Owner member-management — backend REST endpoint integration journeys (runs against the CI database).
// Drives the public function handlers exactly as the Gym Owner app does, covering the
// "Members Management Flow" screens:
//   - register a direct member (POST /owner/members) -> creates a gym-linked subscription + payment
//   - list members with stats + filters (GET /owner/members)
//   - member details with check-in summary, plan, recent check-ins and payment history (GET /owner/members/:id)
//   - manual check-in (POST /owner/members/:id/checkin)
//   - renew membership (POST /owner/members/:id/renew)
//   - suspend / reactivate (POST /owner/members/:id/suspend)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateMemberProfile } from '../functions/subscriptions.mjs';
import { ownerCreateGym } from '../functions/owner-gyms.mjs';
import {
  ownerCreateMember,
  ownerListMembers,
  ownerMemberDetail,
  ownerCheckInMember,
  ownerRenewMember,
  ownerSuspendMember,
  ownerMemberCheckInSummary,
  ownerMemberCheckins,
  ownerMemberPayments,
} from '../functions/owner-members.mjs';

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const uniq = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const uniqPhone = () => `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const dateOnly = (d) => d.toISOString().slice(0, 10);

async function ensureUser({ id, userType, displayName, email, phone }) {
  const out = res();
  await updateMemberProfile.onRequest(
    { user: { sub: id, userType }, body: { displayName, email, phone } },
    out,
  );
  assert.equal(out.statusCode, 200, `ensureUser ${userType} failed: ${JSON.stringify(out.body)}`);
  return out.body.user;
}

async function createOwnerWithGym() {
  const ownerId = uniq('usr_owner');
  await ensureUser({ id: ownerId, userType: 'gym_operator', displayName: 'MM Owner', phone: uniqPhone() });
  const gymRes = res();
  await ownerCreateGym.onRequest(
    {
      user: { sub: ownerId, userType: 'gym_operator' },
      body: { name: uniq('MM Gym'), tier: 'standard', location: 'Dar es Salaam', perVisitRate: 5000 },
    },
    gymRes,
  );
  assert.equal(gymRes.statusCode, 201, `gym create failed: ${JSON.stringify(gymRes.body)}`);
  return { ownerId, gym: gymRes.body };
}

async function createDirectMember(ownerId, gym, overrides = {}) {
  const start = new Date();
  const end = new Date(start.getTime() + 30 * 86_400_000);
  const out = res();
  await ownerCreateMember.onRequest(
    {
      user: { sub: ownerId, userType: 'gym_operator' },
      body: {
        displayName: 'Amina Said',
        email: uniq('amina') + '@example.com',
        phone: uniqPhone(),
        gymId: gym.id,
        tier: 'premium',
        paidAmount: 180000,
        durationUnit: 'M',
        startDate: dateOnly(start),
        endDate: dateOnly(end),
        ...overrides,
      },
    },
    out,
  );
  return out;
}

// ───────────────────────── Create direct member ─────────────────────────
test('owner registers a direct member — creates a gym-linked subscription + payment', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const out = await createDirectMember(ownerId, gym);

  assert.equal(out.statusCode, 201, `create failed: ${JSON.stringify(out.body)}`);
  assert.ok(out.body.member?.id, 'member id expected');
  assert.equal(out.body.member.userType, 'member');
  const sub = out.body.subscription;
  assert.ok(sub, 'subscription expected');
  assert.equal(sub.type, 'direct_sub', 'direct members must use a direct_sub');
  assert.equal(sub.homeGymId, gym.id, 'subscription must be linked to the owner gym');
  assert.equal(sub.status, 'active');
});

test('create member validation — missing name / contact / dates', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const ctx = { user: { sub: ownerId, userType: 'gym_operator' } };

  const noName = res();
  await ownerCreateMember.onRequest({ ...ctx, body: { email: uniq('x') + '@e.com', gymId: gym.id, durationUnit: 'M', startDate: '2026-01-01', endDate: '2026-02-01' } }, noName);
  assert.equal(noName.statusCode, 400);
  assert.equal(noName.body.error, 'displayName_required');

  const noContact = res();
  await ownerCreateMember.onRequest({ ...ctx, body: { displayName: 'No Contact', gymId: gym.id, durationUnit: 'M', startDate: '2026-01-01', endDate: '2026-02-01' } }, noContact);
  assert.equal(noContact.statusCode, 400);
  assert.equal(noContact.body.error, 'email_or_phone_required');
});

// ───────────────────────── List members + stats ─────────────────────────
test('owner lists members — direct member appears active with stats block', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const created = await createDirectMember(ownerId, gym);
  const memberId = created.body.member.id;

  const out = res();
  await ownerListMembers.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, query: {} }, out);
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.ok(Array.isArray(out.body.members), 'members array expected');
  assert.ok(out.body.stats, 'stats block expected');
  for (const key of ['totalMembers', 'activeToday', 'expiringSoon']) {
    assert.equal(typeof out.body.stats[key], 'number', `stats.${key} expected`);
  }
  const row = out.body.members.find(m => m.id === memberId);
  assert.ok(row, 'created member must be listed');
  assert.equal(row.memberType, 'direct');
  assert.equal(row.status, 'active');
  assert.match(row.publicId, /^FM\d{3,}$/, 'masked public id expected');
});

test('owner members filter — memberType=direct excludes nothing it should not', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const created = await createDirectMember(ownerId, gym);
  const memberId = created.body.member.id;

  const out = res();
  await ownerListMembers.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, query: { memberType: 'direct' } }, out);
  assert.equal(out.statusCode, 200);
  assert.ok(out.body.members.some(m => m.id === memberId));

  const roamingOnly = res();
  await ownerListMembers.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, query: { memberType: 'fitflex' } }, roamingOnly);
  assert.equal(roamingOnly.statusCode, 200);
  assert.ok(!roamingOnly.body.members.some(m => m.id === memberId), 'direct member must be excluded from fitflex filter');
});

// ───────────────────────── Member detail ─────────────────────────
test('owner views member detail — plan, check-in summary and payment history', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const created = await createDirectMember(ownerId, gym);
  const memberId = created.body.member.id;

  const out = res();
  await ownerMemberDetail.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, params: { memberId } }, out);
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(out.body.id, memberId);
  assert.match(out.body.publicId, /^FM\d{3,}$/);
  assert.ok(out.body.plan, 'plan block expected');
  assert.equal(out.body.plan.tier, 'premium');
  assert.ok(out.body.checkInSummary, 'checkInSummary expected');
  assert.equal(out.body.checkInSummary.visits, 0);
  assert.ok(Array.isArray(out.body.recentCheckins));
  assert.ok(Array.isArray(out.body.paymentHistory));
  assert.equal(out.body.paymentHistory.length, 1, 'initial payment should be recorded');
});

test('member detail is ownership-guarded — other owner cannot read', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const created = await createDirectMember(ownerId, gym);
  const memberId = created.body.member.id;

  const { ownerId: otherOwner } = await createOwnerWithGym();
  const out = res();
  await ownerMemberDetail.onRequest({ user: { sub: otherOwner, userType: 'gym_operator' }, params: { memberId } }, out);
  assert.equal(out.statusCode, 403, 'foreign owner must be blocked');
});

// ───────────────────────── Manual check-in ─────────────────────────
test('owner checks a member in — recorded and reflected in detail', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const created = await createDirectMember(ownerId, gym);
  const memberId = created.body.member.id;

  const checkin = res();
  await ownerCheckInMember.onRequest(
    { user: { sub: ownerId, userType: 'gym_operator' }, params: { memberId }, body: { gymId: gym.id } },
    checkin,
  );
  assert.equal(checkin.statusCode, 200, JSON.stringify(checkin.body));
  assert.ok(checkin.body.ok, 'check-in should succeed');

  const detail = res();
  await ownerMemberDetail.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, params: { memberId } }, detail);
  assert.equal(detail.body.checkInSummary.visits, 1, 'visit count should increment');
  assert.ok(detail.body.recentCheckins.length >= 1, 'recent check-ins should include the new visit');
});

// ───────────────────────── Renew ─────────────────────────
test('owner renews a membership — extends expiry and appends payment history', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const created = await createDirectMember(ownerId, gym);
  const memberId = created.body.member.id;

  const start = new Date();
  const end = new Date(start.getTime() + 180 * 86_400_000);
  const renew = res();
  await ownerRenewMember.onRequest(
    {
      user: { sub: ownerId, userType: 'gym_operator' },
      params: { memberId },
      body: { tier: 'premium', paidAmount: 180000, durationUnit: 'M', startDate: dateOnly(start), endDate: dateOnly(end) },
    },
    renew,
  );
  assert.equal(renew.statusCode, 200, JSON.stringify(renew.body));

  const detail = res();
  await ownerMemberDetail.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, params: { memberId } }, detail);
  assert.equal(detail.body.paymentHistory.length, 2, 'renewal payment should be appended');
  assert.equal(detail.body.plan.expiresAt.slice(0, 10), dateOnly(end));
});

// ───────────────────────── Check-in summary (period selector) ─────────────────────────
test('owner reads check-in summary for week/month/year — counts the current check-in', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const created = await createDirectMember(ownerId, gym);
  const memberId = created.body.member.id;
  const ctx = { user: { sub: ownerId, userType: 'gym_operator' } };

  // record a single check-in (today)
  const checkin = res();
  await ownerCheckInMember.onRequest({ ...ctx, params: { memberId }, body: { gymId: gym.id } }, checkin);
  assert.equal(checkin.statusCode, 200, JSON.stringify(checkin.body));

  for (const period of ['week', 'month', 'year']) {
    const out = res();
    await ownerMemberCheckInSummary.onRequest({ ...ctx, params: { memberId }, query: { period } }, out);
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.equal(out.body.period, period);
    assert.equal(out.body.visits, 1, `period=${period} should count the visit`);
    assert.equal(typeof out.body.streakDays, 'number');
  }
});

test('owner reads check-in summary with custom range — excludes out-of-range visits', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const created = await createDirectMember(ownerId, gym);
  const memberId = created.body.member.id;
  const ctx = { user: { sub: ownerId, userType: 'gym_operator' } };

  const checkin = res();
  await ownerCheckInMember.onRequest({ ...ctx, params: { memberId }, body: { gymId: gym.id } }, checkin);
  assert.equal(checkin.statusCode, 200);

  // A past range that ends before today must report 0 visits.
  const past = res();
  await ownerMemberCheckInSummary.onRequest(
    { ...ctx, params: { memberId }, query: { period: 'custom', from: '2020-01-01', to: '2020-01-31' } },
    past,
  );
  assert.equal(past.statusCode, 200, JSON.stringify(past.body));
  assert.equal(past.body.visits, 0, 'check-in outside the custom range must be excluded');

  // A range spanning today must include it.
  const today = new Date();
  const from = dateOnly(new Date(today.getTime() - 86_400_000));
  const to = dateOnly(new Date(today.getTime() + 86_400_000));
  const within = res();
  await ownerMemberCheckInSummary.onRequest(
    { ...ctx, params: { memberId }, query: { period: 'custom', from, to } },
    within,
  );
  assert.equal(within.statusCode, 200);
  assert.equal(within.body.visits, 1, 'check-in inside the custom range must be counted');
});

test('check-in summary is ownership-guarded', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const created = await createDirectMember(ownerId, gym);
  const memberId = created.body.member.id;
  const { ownerId: other } = await createOwnerWithGym();
  const out = res();
  await ownerMemberCheckInSummary.onRequest(
    { user: { sub: other, userType: 'gym_operator' }, params: { memberId }, query: {} },
    out,
  );
  assert.equal(out.statusCode, 403);
});

// ───────────────────────── Paginated check-ins ─────────────────────────
test('owner lists member check-ins — paginated shape with items/total/nextCursor', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const created = await createDirectMember(ownerId, gym);
  const memberId = created.body.member.id;
  const ctx = { user: { sub: ownerId, userType: 'gym_operator' } };

  const checkin = res();
  await ownerCheckInMember.onRequest({ ...ctx, params: { memberId }, body: { gymId: gym.id } }, checkin);
  assert.equal(checkin.statusCode, 200);

  const out = res();
  await ownerMemberCheckins.onRequest({ ...ctx, params: { memberId }, query: { limit: '10' } }, out);
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.ok(Array.isArray(out.body.items), 'items array expected');
  assert.equal(out.body.total, 1);
  assert.equal(out.body.nextCursor, null, 'no more pages for a single check-in');
  assert.equal(out.body.items[0].gymName, gym.name);
});

test('member check-ins list is ownership-guarded', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const created = await createDirectMember(ownerId, gym);
  const memberId = created.body.member.id;
  const { ownerId: other } = await createOwnerWithGym();
  const out = res();
  await ownerMemberCheckins.onRequest(
    { user: { sub: other, userType: 'gym_operator' }, params: { memberId }, query: {} },
    out,
  );
  assert.equal(out.statusCode, 403);
});

// ───────────────────────── Paginated payments ─────────────────────────
test('owner lists member payments — paginates across multiple payments (load more)', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const created = await createDirectMember(ownerId, gym); // creates 1 payment
  const memberId = created.body.member.id;
  const ctx = { user: { sub: ownerId, userType: 'gym_operator' } };

  // two renewals -> two more payments (total 3)
  for (let i = 0; i < 2; i++) {
    const start = new Date();
    const end = new Date(start.getTime() + 30 * 86_400_000);
    const renew = res();
    await ownerRenewMember.onRequest(
      { ...ctx, params: { memberId }, body: { tier: 'premium', paidAmount: 50000, durationUnit: 'M', startDate: dateOnly(start), endDate: dateOnly(end) } },
      renew,
    );
    assert.equal(renew.statusCode, 200, JSON.stringify(renew.body));
  }

  const page1 = res();
  await ownerMemberPayments.onRequest({ ...ctx, params: { memberId }, query: { limit: '2' } }, page1);
  assert.equal(page1.statusCode, 200, JSON.stringify(page1.body));
  assert.equal(page1.body.total, 3, 'three payments total');
  assert.equal(page1.body.items.length, 2, 'first page holds two');
  assert.equal(page1.body.nextCursor, 2, 'next page offset expected');

  const page2 = res();
  await ownerMemberPayments.onRequest(
    { ...ctx, params: { memberId }, query: { limit: '2', cursor: String(page1.body.nextCursor) } },
    page2,
  );
  assert.equal(page2.statusCode, 200);
  assert.equal(page2.body.items.length, 1, 'second page holds the remainder');
  assert.equal(page2.body.nextCursor, null, 'no further pages');
});

test('member payments list is ownership-guarded', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const created = await createDirectMember(ownerId, gym);
  const memberId = created.body.member.id;
  const { ownerId: other } = await createOwnerWithGym();
  const out = res();
  await ownerMemberPayments.onRequest(
    { user: { sub: other, userType: 'gym_operator' }, params: { memberId }, query: {} },
    out,
  );
  assert.equal(out.statusCode, 403);
});

// ───────────────────────── Suspend / reactivate ─────────────────────────
test('owner suspends then reactivates a member', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const created = await createDirectMember(ownerId, gym);
  const memberId = created.body.member.id;

  const suspend = res();
  await ownerSuspendMember.onRequest(
    { user: { sub: ownerId, userType: 'gym_operator' }, params: { memberId }, body: { suspend: true } },
    suspend,
  );
  assert.equal(suspend.statusCode, 200, JSON.stringify(suspend.body));

  const detail = res();
  await ownerMemberDetail.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, params: { memberId } }, detail);
  assert.equal(detail.body.status, 'suspended');

  const reactivate = res();
  await ownerSuspendMember.onRequest(
    { user: { sub: ownerId, userType: 'gym_operator' }, params: { memberId }, body: { suspend: false } },
    reactivate,
  );
  assert.equal(reactivate.statusCode, 200);

  const detail2 = res();
  await ownerMemberDetail.onRequest({ user: { sub: ownerId, userType: 'gym_operator' }, params: { memberId } }, detail2);
  assert.notEqual(detail2.body.status, 'suspended');
});
