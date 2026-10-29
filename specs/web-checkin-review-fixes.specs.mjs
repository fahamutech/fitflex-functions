// S2 review fixes: web bookkeeping (authSessionId, clientMeta, intentId) is stripped on every owner/admin route that
// spreads check-in rows, and a voided visit's intent answers intent_used (409) instead of a 500.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { gyms, users, subscriptions, checkins, platformSettings } from '../src/bootstrap/collections.mjs';
import { ownerGymService, memberManagement, adminMemberService, checkinStatusService, settingsService, gymService, trainerService, moderationGate, partnerGate } from '../src/bootstrap/services.mjs';
import { issueGymQr } from '../src/auth/qr-token.mjs';
import { createCheckInService } from '../src/services/check-in-service.mjs';
import { createWebGymProfileService } from '../src/services/web-gym-profile-service.mjs';
import { createWebCheckinService } from '../src/services/web-checkin-service.mjs';

assert.match(String(process.env.DATABASE_URL_CI || ''), /fitflex_ci/, 'specs run against the CI database only');

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const nowIso = () => new Date().toISOString();
const made = { users: [], gyms: [] };
const secretBefore = process.env.QR_HMAC_SECRET;
let tiersBefore;
before(async () => {
  process.env.QR_HMAC_SECRET = 'review-fixes-secret';
  tiersBefore = settingsService.adminGet().subscriptionTiers.map(t => ({ ...t }));
  await platformSettings.updateAsync(s => s.id === 'platform', { subscriptionTiers: [{ key: 'pro', label: 'Pro', monthlyPrice: 120_000, visits: 30, gymAccess: 'midtier' }] });
});
after(async () => {
  await platformSettings.updateAsync(s => s.id === 'platform', { subscriptionTiers: tiersBefore });
  if (secretBefore === undefined) delete process.env.QR_HMAC_SECRET; else process.env.QR_HMAC_SECRET = secretBefore;
  if (made.users.length) await db('User').whereIn('id', made.users).del();
  for (const id of made.users) await users.removeAsync(u => u.id === id);
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  await db.destroy();
});

const SECRETS = ['sid-secret', 'intent-secret', 'hash-secret'];
function clean(value, where) {
  const text = JSON.stringify(value);
  for (const k of ['authSessionId', 'clientMeta', 'intentId']) assert.ok(!text.includes(`"${k}"`), `${where}: ${k} present`);
  for (const s of SECRETS) assert.ok(!text.includes(s), `${where}: ${s} leaked`);
}

async function world({ tier = 'midtier' } = {}) {
  await gyms.ready;
  const gymId = uid('gym'); const memberId = uid('usr');
  await gyms.insertAsync({ id: gymId, name: 'Review Fix Gym', tier, status: 'active', location: 'Masaki', homepageVisible: true, createdAt: nowIso(), updatedAt: nowIso() });
  await users.insertAsync({ id: memberId, userType: 'member', displayName: 'Review Fix', accountStatus: 'active', createdAt: nowIso(), updatedAt: nowIso() });
  made.gyms.push(gymId); made.users.push(memberId);
  const subId = uid('sub');
  const start = new Date(Date.now() - 5 * 86_400_000).toISOString();
  await subscriptions.insertAsync({ id: subId, memberId, type: 'direct_sub', tier: 'pro', status: 'active', homeGymId: gymId, startedAt: start, cycleStartedAt: start, renewsAt: new Date(Date.now() + 25 * 86_400_000).toISOString(), expiresAt: new Date(Date.now() + 25 * 86_400_000).toISOString() });
  const checkinId = uid('chk');
  await db('Checkin').insert({
    id: checkinId, memberId, gymId, timestamp: new Date(), method: 'web_scanned', subscriptionType: 'direct_sub', passTier: 'pro', visitNumberInCycle: 1, gymTier: tier,
    creditsDeductedTzs: 0, visitConsumed: true, status: 'valid', subscriptionId: subId, businessDate: new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10),
    source: 'web_gym_qr_by_member', authSessionId: 'sid-secret', intentId: `intent-secret:${uid('i')}`, clientMeta: JSON.stringify({ channel: 'web', uaFamily: 'chrome', ipHash: 'hash-secret' }),
  });
  return { gymId, memberId, checkinId, owner: { id: uid('own'), userType: 'gym_operator', gymIds: [gymId], gymId } };
}

test('GET /owner/gyms/:gymId/checkins (gymCheckIns) strips the bookkeeping', async () => {
  const w = await world();
  const out = await ownerGymService.gymCheckIns({ owner: w.owner, gymId: w.gymId, checkins });
  assert.ok(out.list.some(c => c.id === w.checkinId));
  clean(out.list, 'gymCheckIns');
});

test('manual check-in results (existing visit today) strip the bookkeeping', async () => {
  const w = await world();
  const out = await memberManagement.checkInMember({ owner: w.owner, memberId: w.memberId, gymId: w.gymId });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.idempotent, true);
  assert.equal(out.checkin.id, w.checkinId);
  clean(out, 'checkInMember existing');
});

test('manual check-in of a new visit returns a clean row (first-visit path)', async () => {
  const w = await world();
  await db('Checkin').where({ id: w.checkinId }).del();
  const out = await memberManagement.checkInMember({ owner: w.owner, memberId: w.memberId, gymId: w.gymId });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.checkin.source, 'owner_manual');
  clean(out, 'checkInMember new');
});

test('admin member check-ins list strips the bookkeeping', async () => {
  const w = await world();
  const list = await adminMemberService.memberCheckins({ memberId: w.memberId });
  assert.ok(list.some(c => c.id === w.checkinId));
  clean(list, 'admin memberCheckins');
});

test('admin check-in status change response strips the bookkeeping (the stored row keeps it)', async () => {
  const w = await world();
  const out = await checkinStatusService.setStatus({ checkinId: w.checkinId, status: 'flagged', reason: 'review fix spec', actorId: 'admin-spec' });
  assert.equal(out.checkin.status, 'flagged');
  clean(out, 'setStatus');
  const stored = await db('Checkin').where({ id: w.checkinId }).first();
  assert.equal(stored.authSessionId, 'sid-secret', 'audit data is still stored');
});

function webService({ b2bFunding = null } = {}) {
  const checkInService = createCheckInService({ users, gyms, subscriptions, checkins, getTierConfig: settingsService.getTierConfig, b2bFunding });
  const webGymProfile = createWebGymProfileService({ gymService, settingsService, trainerService, moderationGate, partnerGate });
  return createWebCheckinService({ gyms, checkInService, webGymProfile, db });
}
async function voidIt(id) {
  await db('Checkin').where({ id }).update({ status: 'voided', statusReason: 'spec', voidedAt: new Date(), voidedBy: 'spec', voidReason: 'spec' });
}

test('voided intent, own pass: the same intent answers 409 intent_used, not a 500', async () => {
  const w = await world();
  await db('Checkin').where({ id: w.checkinId }).del();
  const svc = webService();
  const { intentToken } = await svc.createIntent({ q: issueGymQr(w.gymId) });
  const first = await svc.confirm({ userId: w.memberId, intentToken, confirm: true, idempotencyKey: 'key-12345678' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await voidIt(first.body.checkin.id);
  const again = await svc.confirm({ userId: w.memberId, intentToken, confirm: true, idempotencyKey: 'key-12345678' });
  assert.equal(again.status, 409);
  assert.deepEqual(again.body, { ok: false, failure: 'intent_used' });
});

test('voided intent, B2B-funded: intent_used, the hold is cancelled, nothing rethrown', async () => {
  const w = await world();
  await db('Checkin').where({ id: w.checkinId }).del();
  await db('Subscription').where({ memberId: w.memberId }).del();
  const calls = { hold: 0, cancel: [], confirm: 0 };
  const b2bFunding = {
    wouldCoverGymVisit: async () => true,
    holdGymVisit: async () => { calls.hold += 1; return { consumption: { id: uid('cons'), grossTzs: 1, sponsorTzs: 1, beneficiaryTzs: 0 } }; },
    confirm: async () => { calls.confirm += 1; }, cancel: async a => { calls.cancel.push(a.reason); },
  };
  const svc = webService({ b2bFunding });
  const { intentToken } = await svc.createIntent({ q: issueGymQr(w.gymId) });
  const first = await svc.confirm({ userId: w.memberId, intentToken, confirm: true, idempotencyKey: 'key-12345678' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await voidIt(first.body.checkin.id);
  const again = await svc.confirm({ userId: w.memberId, intentToken, confirm: true, idempotencyKey: 'key-12345678' });
  assert.equal(again.status, 409);
  assert.deepEqual(again.body, { ok: false, failure: 'intent_used' });
  assert.equal(calls.hold, 2);
  assert.equal(calls.cancel.length, 1, 'the second hold was released');
});

test('retention also clears intentId on old web visits', async () => {
  const w = await world();
  const svc = webService();
  await db('Checkin').where({ id: w.checkinId }).update({ timestamp: new Date(Date.now() - 40 * 86_400_000) });
  assert.ok((await svc.purgeClientMeta()) >= 1);
  const row = await db('Checkin').where({ id: w.checkinId }).first();
  assert.deepEqual([row.clientMeta, row.authSessionId, row.intentId], [null, null, null]);
});
