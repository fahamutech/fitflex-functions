// Identity V2 · I6 (slice B) — member invitations and the desk sale (O2).
// Desk payment → invitation carrying the plan and payment → the person
// accepts → the subscription is created, starting on the payment date.
// Nothing exists before acceptance; a paid invitation that lapses is held for
// the gym to re-issue or refund.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  gymPeopleLookup, gymCreateInvitation, gymListInvitations, gymCancelInvitation,
  gymReissueInvitation, gymMarkInvitationRefunded, myInvitations, acceptMyInvitation,
} from '../functions/invitations.mjs';
import { ownerCreateMember } from '../functions/owner-members.mjs';
import { users } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';

const uniq = p => `${p}_${randomUUID().slice(0, 8)}`;
const localPhone = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const day = n => new Date(Date.now() + n * 864e5);
const iso = d => d.toISOString();

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
async function call(route, claims, { params = {}, body = {}, query = {} } = {}) {
  const req = { headers: { authorization: `Bearer ${sign(claims)}` }, params, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat()) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}
async function on(fn) {
  const saved = { a: process.env.IDENTITY_V2, b: process.env.V2_INVITES };
  process.env.IDENTITY_V2 = 'true'; process.env.V2_INVITES = 'true';
  try { return await fn(); } finally {
    if (saved.a === undefined) delete process.env.IDENTITY_V2; else process.env.IDENTITY_V2 = saved.a;
    if (saved.b === undefined) delete process.env.V2_INVITES; else process.env.V2_INVITES = saved.b;
  }
}

async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_i6b'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date().toISOString(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return db('User').where({ id: row.id }).first();
}
async function makeOwner() {
  const gymId = uniq('gym_i6b');
  await db('Gym').insert({ id: gymId, name: 'Iron Paradise', tier: 'standard', location: 'Dar es Salaam', status: 'active', updatedAt: new Date() });
  const owner = await makeUser({ userType: 'gym_operator', gymIds: [gymId], gymId });
  return { owner, gymId, claims: { sub: owner.id, userType: 'gym_operator' } };
}
/** A person whose phone Firebase has verified. */
async function personWithPhone(overrides = {}) {
  const phone = localPhone();
  const user = await makeUser({ firebaseUid: uniq('fb'), phone, displayName: 'Juma Hassan', ...overrides });
  await db('LoginIdentifier').insert({
    id: uniq('lid'), personId: user.personId, type: 'phone', value: phone, normalizedValue: `+255${phone.slice(1)}`,
    verifiedAt: new Date(), status: 'active',
  });
  return { user, phone, claims: { sub: user.id, userType: user.userType } };
}
const plan = (extra = {}) => ({ role: 'member', durationUnit: 'M', startDate: iso(day(0)), endDate: iso(day(30)), tier: 'standard', ...extra });
const invite = (o, body, claims = o.claims) => call(gymCreateInvitation, claims, { params: { gymId: o.gymId }, body });
const accept = (p, invitationId) => call(acceptMyInvitation, p.claims, { params: { invitationId } });
const count = async (table, where) => Number((await db(table).where(where).count({ n: '*' }).first()).n);

// ── The desk-sale lifecycle (O2) ───────────────────────────────────────────

test('desk payment → invitation → acceptance → subscription from the payment date', async () => {
  await on(async () => {
    const o = await makeOwner();
    const p = await personWithPhone();
    const paidOn = day(-3); // paid at the desk three days before accepting
    const sent = await invite(o, plan({ phone: p.phone, paidAmount: 50000, startDate: iso(paidOn), endDate: iso(day(27)) }));
    assert.equal(sent.statusCode, 201);
    assert.equal(sent.body.invitation.paidAmountTzs, 50000);

    // Before acceptance nothing exists: no plan, no payment record, no access.
    assert.equal(await count('Subscription', { memberId: p.user.id }), 0);
    assert.equal(await count('PaymentRequest', { memberId: p.user.id }), 0);
    assert.equal(await count('OrgMembership', { personId: p.user.personId, gymId: o.gymId }), 0);

    const inbox = await call(myInvitations, p.claims);
    assert.equal(inbox.body.invitations[0].plan.tier, 'standard', 'the person sees what they are accepting');

    const out = await accept(p, sent.body.invitation.id);
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.personaId, p.user.id);

    const sub = await db('Subscription').where({ memberId: p.user.id }).first();
    assert.deepEqual([sub.type, sub.status, sub.homeGymId, sub.tier], ['direct_sub', 'active', o.gymId, 'standard']);
    assert.equal(+new Date(sub.startedAt), +paidOn, 'the plan starts on the payment date');
    const payment = await db('PaymentRequest').where({ memberId: p.user.id }).first();
    assert.deepEqual([Number(payment.amountTzs), payment.status, payment.subscriptionId], [50000, 'approved', sub.id]);
    assert.equal(+new Date(payment.requestedAt), +paidOn);
    const membership = await db('OrgMembership').where({ id: out.body.membershipId }).first();
    assert.deepEqual([membership.role, membership.status, membership.source], ['member', 'active', 'invite']);

    assert.equal((await invite(o, plan({ phone: p.phone }))).body.error, 'already_a_member');
  });
});

test('a person with no member role gets one under the same Person on acceptance', async () => {
  await on(async () => {
    const o = await makeOwner();
    const p = await personWithPhone({ userType: 'trainer' });
    const sent = await invite(o, plan({ phone: p.phone }));
    const out = await accept(p, sent.body.invitation.id);
    assert.equal(out.statusCode, 200);
    const member = await db('User').where({ id: out.body.personaId }).first();
    assert.deepEqual([member.userType, member.personId], ['member', p.user.personId]);
    assert.equal(await count('Person', { id: p.user.personId }), 1);
    assert.equal(await count('Subscription', { memberId: member.id, homeGymId: o.gymId }), 1);
    assert.equal(await count('PaymentRequest', { memberId: member.id }), 0, 'no payment was taken');
  });
});

test('a former member whose plan expired can be invited again', async () => {
  await on(async () => {
    const o = await makeOwner();
    const p = await personWithPhone();
    const first = await invite(o, plan({ phone: p.phone, startDate: iso(day(-40)), endDate: iso(day(-10)) }));
    await accept(p, first.body.invitation.id);
    const again = await invite(o, plan({ phone: p.phone }));
    assert.equal(again.statusCode, 201);
    assert.equal((await accept(p, again.body.invitation.id)).statusCode, 200);
    const statuses = (await db('OrgMembership').where({ personId: p.user.personId, gymId: o.gymId })).map(m => m.status).sort();
    assert.deepEqual(statuses, ['active', 'left'], 'history is kept');
  });
});

test('a member invitation needs a valid plan', async () => {
  await on(async () => {
    const o = await makeOwner();
    const phone = localPhone();
    assert.equal((await invite(o, plan({ phone, durationUnit: 'Y' }))).body.error, 'durationUnit_must_be_D_W_or_M');
    assert.equal((await invite(o, plan({ phone, endDate: undefined }))).body.error, 'startDate_and_endDate_required');
    assert.equal((await invite(o, plan({ phone, startDate: iso(day(5)), endDate: iso(day(1)) }))).body.error, 'endDate_must_follow_startDate');
  });
});

// ── Who may invite ─────────────────────────────────────────────────────────

test('staff with the members scope invite members, and nothing else', async () => {
  await on(async () => {
    const o = await makeOwner();
    const staff = await makeUser({ userType: 'gym_staff', gymIds: [o.gymId], aclPermissions: ['members'] });
    const desk = { sub: staff.id, userType: 'gym_staff', aclPermissions: ['members'] };
    const noScope = { sub: staff.id, userType: 'gym_staff', aclPermissions: ['checkins'] };
    const p = await personWithPhone();

    assert.equal((await call(gymPeopleLookup, desk, { params: { gymId: o.gymId }, body: { phone: p.phone } })).body.found, true);
    const sent = await invite(o, plan({ phone: p.phone }), desk);
    assert.equal(sent.statusCode, 201);
    assert.equal((await invite(o, { role: 'staff', email: 'x@example.com' }, desk)).body.error, 'owner_only');
    assert.equal((await invite(o, { role: 'trainer', email: 'y@example.com' }, desk)).body.error, 'owner_only');
    assert.equal((await invite(o, plan({ phone: localPhone() }), noScope)).statusCode, 403);

    const staffInvite = await invite(o, { role: 'staff', email: `${uniq('rec')}@example.com` });
    const seen = await call(gymListInvitations, desk, { params: { gymId: o.gymId } });
    assert.deepEqual(seen.body.invitations.map(i => i.role), ['member'], 'staff see member invitations only');
    const cancelStaff = await call(gymCancelInvitation, desk, { params: { gymId: o.gymId, invitationId: staffInvite.body.invitation.id } });
    assert.equal(cancelStaff.statusCode, 404);

    const other = await makeOwner();
    assert.equal((await invite(other, plan({ phone: localPhone() }), desk)).body.error, 'not_your_gym');
  });
});

// ── Paid, never accepted: held for the gym ─────────────────────────────────

async function lapsedPaidInvitation(o, p, paidOn = day(-20)) {
  const sent = await invite(o, plan({ phone: p.phone, paidAmount: 30000, startDate: iso(paidOn), endDate: iso(day(10)) }));
  const id = sent.body.invitation.id;
  await db('Invitation').where({ id }).update({ createdAt: day(-20), expiresAt: day(-1) });
  return { id, paidOn };
}

test('a paid invitation that expires unaccepted is flagged, and can be re-issued with its original payment date', async () => {
  await on(async () => {
    const o = await makeOwner();
    const p = await personWithPhone();
    const { id, paidOn } = await lapsedPaidInvitation(o, p);

    const flagged = await call(gymListInvitations, o.claims, { params: { gymId: o.gymId }, query: { needsResolution: '1' } });
    assert.deepEqual(flagged.body.invitations.map(i => [i.id, i.status, i.needsResolution]), [[id, 'expired', true]]);
    assert.equal(await count('Subscription', { memberId: p.user.id }), 0, 'nothing was created or refunded automatically');
    assert.equal((await accept(p, id)).statusCode, 409);

    const reissued = await call(gymReissueInvitation, o.claims, { params: { gymId: o.gymId, invitationId: id } });
    assert.equal(reissued.statusCode, 201);
    assert.equal(reissued.body.invitation.paidAmountTzs, 30000);
    const after = await call(gymListInvitations, o.claims, { params: { gymId: o.gymId }, query: { needsResolution: '1' } });
    assert.deepEqual(after.body.invitations, [], 'resolved');
    assert.equal((await call(gymReissueInvitation, o.claims, { params: { gymId: o.gymId, invitationId: id } })).body.error, 'nothing_to_resolve');

    assert.equal((await accept(p, reissued.body.invitation.id)).statusCode, 200);
    const sub = await db('Subscription').where({ memberId: p.user.id }).first();
    assert.equal(+new Date(sub.startedAt), +paidOn, 'still dated from the original payment');
    assert.equal(await count('PaymentRequest', { memberId: p.user.id }), 1, 'one payment, not two');
  });
});

test('the gym can instead record that it refunded the payment; unpaid invitations need nothing', async () => {
  await on(async () => {
    const o = await makeOwner();
    const p = await personWithPhone();
    const { id } = await lapsedPaidInvitation(o, p);
    const refunded = await call(gymMarkInvitationRefunded, o.claims, { params: { gymId: o.gymId, invitationId: id }, body: { note: 'Cash returned' } });
    assert.equal(refunded.statusCode, 200);
    assert.equal(refunded.body.invitation.needsResolution, false);
    const stored = await db('Invitation').where({ id }).first();
    assert.deepEqual([stored.payload.resolution.type, stored.payload.resolution.note], ['refunded', 'Cash returned']);
    assert.equal(await count('PaymentRequest', { memberId: p.user.id }), 0, 'FitFlex moved no money');
    assert.equal((await call(gymMarkInvitationRefunded, o.claims, { params: { gymId: o.gymId, invitationId: id } })).body.error, 'nothing_to_resolve');

    const q = await personWithPhone();
    const unpaid = await invite(o, plan({ phone: q.phone }));
    await db('Invitation').where({ id: unpaid.body.invitation.id }).update({ createdAt: day(-20), expiresAt: day(-1) });
    const none = await call(gymReissueInvitation, o.claims, { params: { gymId: o.gymId, invitationId: unpaid.body.invitation.id } });
    assert.equal(none.body.error, 'nothing_to_resolve');
  });
});

// ── The old desk create ────────────────────────────────────────────────────

test('flag on: the legacy member create is replaced by invitations', async () => {
  await on(async () => {
    const o = await makeOwner();
    const out = await call(ownerCreateMember, o.claims, {
      body: { displayName: 'Walk In', phone: localPhone(), durationUnit: 'M', startDate: iso(day(0)), endDate: iso(day(30)), initialPassword: '123456' },
    });
    assert.equal(out.statusCode, 400);
    assert.equal(out.body.error, 'use_invitation');
    assert.equal(await count('User', { displayName: 'Walk In' }), 0);
  });
});
