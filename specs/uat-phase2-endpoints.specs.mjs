// UAT Phase 2 — backend REST endpoint integration journeys (runs against the CI database).
// Drives the public function handlers exactly as the apps do, so every write flows through
// the same store instances the handlers read from.
//
// Covers the owner/member feedback that is enforced at the API boundary:
//   A2 — unique masked identity: FM###/FT###/FO### and NO name/email exposed at scan time.
//   A3 — owner can request an arbitrary reporting period (periodStart/periodEnd echoed back).
//   A4 — gym staff (receptionist) roster: a valid payload succeeds; the 400s are only the
//        genuine validation failures (missing email/password/name / unowned gym).
//   A8 — owner sees overall performance with a direct-vs-FitFlex split.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateMemberProfile, me } from '../functions/subscriptions.mjs';
import { ownerCreateGym } from '../functions/owner-gyms.mjs';
import { ownerCreateStaff } from '../functions/owner-staff.mjs';
import { operatorVerifyQr, operatorDashboard } from '../functions/checkins.mjs';
import { issue as issueQr } from '../src/auth/qr-token.mjs';

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const uniq = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
// Phone is unique-constrained in PG — generate a fresh number per user.
const uniqPhone = () => `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

// Create (or upsert) a user of any role through the profile endpoint so it lands in the
// handler's user store and the database.
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
  await ensureUser({ id: ownerId, userType: 'gym_operator', displayName: 'UAT Owner', phone: uniqPhone() });
  const gymRes = res();
  await ownerCreateGym.onRequest(
    {
      user: { sub: ownerId, userType: 'gym_operator' },
      body: { name: uniq('UAT Gym'), tier: 'standard', location: 'Dar es Salaam', perVisitRate: 5000 },
    },
    gymRes,
  );
  assert.equal(gymRes.statusCode, 201, `gym create failed: ${JSON.stringify(gymRes.body)}`);
  return { ownerId, gym: gymRes.body };
}

// ───────────────────────── A2: masked, role-prefixed public identity ─────────────────────────
test('A2: /me returns role-prefixed public IDs — FM for member, FT trainer, FO owner', async () => {
  const member = await ensureUser({ id: uniq('usr_m'), userType: 'member', displayName: 'Member One', phone: uniqPhone() });
  const trainer = await ensureUser({ id: uniq('usr_t'), userType: 'trainer', displayName: 'Trainer One', phone: uniqPhone() });
  const owner = await ensureUser({ id: uniq('usr_o'), userType: 'gym_operator', displayName: 'Owner One', phone: uniqPhone() });

  for (const [user, prefix] of [[member, 'FM'], [trainer, 'FT'], [owner, 'FO']]) {
    const out = res();
    await me.onRequest({ user: { sub: user.id, userType: user.userType } }, out);
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.match(out.body.user.publicId, new RegExp(`^${prefix}\\d{3,}$`), `expected ${prefix}### for ${user.userType}`);
    assert.equal(out.body.user.userCode, out.body.user.publicId);
  }
});

test('A2: operator QR verification masks the member — exposes publicId, hides name/email/phone', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const member = await ensureUser({
    id: uniq('usr_scan'),
    userType: 'member',
    displayName: 'Sensitive Name',
    email: `${uniq('secret')}@example.com`,
    phone: uniqPhone(),
  });

  const out = res();
  await operatorVerifyQr.onRequest(
    { user: { sub: ownerId, userType: 'gym_operator' }, body: { qrToken: issueQr(member.id).token, gymId: gym.id } },
    out,
  );

  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  const scanned = out.body.member;
  assert.ok(scanned, 'member payload expected');
  assert.match(scanned.publicId, /^FM\d{3,}$/, 'scan must show a masked FM### code');
  // Privacy: the operator must NOT see real identity during a scan.
  assert.equal(scanned.displayName, undefined, 'name must be hidden during scan');
  assert.equal(scanned.email, undefined, 'email must be hidden during scan');
  assert.equal(scanned.phone, undefined, 'phone must be hidden during scan');
});

// ───────────────────────── A4: gym staff roster validation ─────────────────────────
// ownerCreateStaff calls Firebase Admin on the success path, which isn't available in this
// test environment — so we only assert the request-validation guards that run *before* the
// Firebase call. See specs/gym-staff-roster.specs.mjs for the RBAC-permission behaviour.
test('A4: staff-add 400s are limited to genuine validation problems', async () => {
  const { ownerId, gym } = await createOwnerWithGym();
  const ctx = { user: { sub: ownerId, userType: 'gym_operator' } };

  const noEmail = res();
  await ownerCreateStaff.onRequest({ ...ctx, body: { displayName: 'No Email', gymIds: [gym.id] } }, noEmail);
  assert.equal(noEmail.statusCode, 400);
  assert.equal(noEmail.body.error, 'email_and_password_required');

  const noName = res();
  await ownerCreateStaff.onRequest(
    { ...ctx, body: { email: uniq('x') + '@e.com', password: 'pin1234', gymIds: [gym.id] } },
    noName,
  );
  assert.equal(noName.statusCode, 400);
  assert.equal(noName.body.error, 'displayName_required');

  const badScope = res();
  await ownerCreateStaff.onRequest(
    { ...ctx, body: { displayName: 'Bad Scope', email: uniq('s') + '@e.com', password: 'pin1234', gymIds: [gym.id], aclPermissions: ['not_a_real_scope'] } },
    badScope,
  );
  assert.equal(badScope.statusCode, 400);
  assert.equal(badScope.body.error, 'invalid_acl_scopes');

  const unownedGym = res();
  await ownerCreateStaff.onRequest(
    { ...ctx, body: { displayName: 'Wrong Gym', email: uniq('y') + '@e.com', password: 'pin1234', gymIds: ['gym_not_owned'] } },
    unownedGym,
  );
  assert.equal(unownedGym.statusCode, 400);
  assert.equal(unownedGym.body.error, 'must_assign_to_at_least_one_owned_gym');
});

// ───────────────────────── A3 + A8: configurable period + direct/FitFlex split ─────────────────────────
test('A3: owner dashboard honours an explicit reporting period', async () => {
  const { ownerId } = await createOwnerWithGym();
  const out = res();
  await operatorDashboard.onRequest(
    {
      user: { sub: ownerId, userType: 'gym_operator' },
      query: { periodStart: '2026-01-01', periodEnd: '2026-01-31' },
    },
    out,
  );

  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(out.body.periodStart, '2026-01-01', 'period start must reflect the requested window');
  assert.equal(out.body.periodEnd, '2026-01-31', 'period end must reflect the requested window');
});

test('A8: owner dashboard exposes overall performance with a direct-vs-FitFlex split', async () => {
  const { ownerId } = await createOwnerWithGym();
  const out = res();
  await operatorDashboard.onRequest(
    { user: { sub: ownerId, userType: 'gym_operator' }, query: { memberType: 'fitflex' } },
    out,
  );

  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(out.body.memberType, 'fitflex', 'owner can switch the member-type view');
  const overall = out.body.overall;
  assert.ok(overall, 'overall performance block expected');
  for (const key of ['gymCount', 'totalVisits', 'uniqueMembers', 'directVisits', 'directMembers', 'fitflexVisits', 'fitflexMembers']) {
    assert.equal(typeof overall[key], 'number', `overall.${key} must be reported`);
  }
  assert.ok(Array.isArray(out.body.gymSummaries), 'per-gym breakdown expected');
});
