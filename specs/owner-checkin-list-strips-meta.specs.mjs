// Web check-in bookkeeping (authSessionId, clientMeta, intentId) is audit data: it must not appear in the owner's
// recent check-ins, a staff scan's repeat answer, the member's own scan answer, or the member's check-in history.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { gyms, users } from '../src/bootstrap/collections.mjs';
import { operatorService, subscriptionService } from '../src/bootstrap/services.mjs';
import { issue as issueMemberQr, issueGymQr } from '../src/auth/qr-token.mjs';
import { publicCheckin } from '../src/shared/checkin-status.mjs';

assert.match(String(process.env.DATABASE_URL_CI || ''), /fitflex_ci/, 'specs run against the CI database only');

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], gyms: [] };
const BOOKKEEPING = ['authSessionId', 'clientMeta', 'intentId'];
after(async () => {
  if (made.users.length) await db('User').whereIn('id', made.users).del();
  for (const id of made.users) await users.removeAsync(u => u.id === id);
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  await db.destroy();
});

async function world() {
  await gyms.ready;
  const gymId = uid('gym');
  const memberId = uid('usr');
  await gyms.insertAsync({ id: gymId, name: 'Strip Meta Gym', tier: 'standard', status: 'active', location: 'Masaki', homepageVisible: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await users.insertAsync({ id: memberId, userType: 'member', displayName: 'Strip Meta', accountStatus: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  made.gyms.push(gymId); made.users.push(memberId);
  const checkinId = uid('chk');
  await db('Checkin').insert({
    id: checkinId, memberId, gymId, timestamp: new Date(), method: 'web_scanned', subscriptionType: 'platform_pass', passTier: 'pro', visitNumberInCycle: 1,
    gymTier: 'standard', creditsDeductedTzs: 0, visitConsumed: true, status: 'valid', businessDate: new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10),
    source: 'web_gym_qr_by_member', authSessionId: 'sid-secret', intentId: `intent-secret:${uid('i')}`, clientMeta: JSON.stringify({ channel: 'web', uaFamily: 'chrome', ipHash: 'hash-secret' }),
  });
  return { gymId, memberId, checkinId, operator: { id: uid('own'), userType: 'gym_operator', gymIds: [gymId], gymId } };
}
function noBookkeeping(value, where) {
  const text = JSON.stringify(value);
  for (const k of BOOKKEEPING) assert.ok(!(`"${k}"` in {}) && !text.includes(`"${k}"`), `${where}: ${k} must not be present`);
  for (const s of ['sid-secret', 'intent-secret', 'hash-secret']) assert.ok(!text.includes(s), `${where}: ${s} leaked`);
}

test('publicCheckin removes exactly the three bookkeeping fields', () => {
  const row = { id: 'c', gymId: 'g', authSessionId: 'a', clientMeta: { x: 1 }, intentId: 'i', source: 'web_gym_qr_by_member' };
  assert.deepEqual(publicCheckin(row), { id: 'c', gymId: 'g', source: 'web_gym_qr_by_member' });
  assert.equal(publicCheckin(null), null);
});

test('owner recent check-ins list shows the web visit without its bookkeeping', async () => {
  const w = await world();
  const list = await operatorService.recentCheckIns(w.operator);
  const row = list.find(c => c.id === w.checkinId);
  assert.ok(row, 'the web visit is listed');
  assert.equal(row.source, 'web_gym_qr_by_member');
  assert.equal(row.method, 'web_scanned');
  noBookkeeping(list, 'recentCheckIns');
});

test('a staff scan of a member already in via the web returns the visit without bookkeeping', async () => {
  const w = await world();
  const out = await operatorService.checkIn({ operator: w.operator, gymId: w.gymId, qrToken: issueMemberQr(w.memberId).token });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.idempotent, true);
  assert.equal(out.body.checkin.id, w.checkinId);
  noBookkeeping(out.body, 'operator checkIn');
});

test('the member scan answer for a repeat of a web visit has no bookkeeping, for both the old payload and the URL form', async () => {
  const w = await world();
  const payload = issueGymQr(w.gymId);
  const url = `https://portal.example.test/g/?q=${encodeURIComponent(payload)}`;
  for (const gymQr of [payload, url, `  ${url}  `]) {
    const out = await operatorService.memberScanGym({ memberId: w.memberId, gymQr });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.idempotent, true);
    assert.equal(out.body.checkin.id, w.checkinId);
    noBookkeeping(out.body, 'memberScanGym');
  }
});

test('the member check-in history has no bookkeeping', async () => {
  const w = await world();
  const list = await subscriptionService.memberCheckIns(w.memberId, {});
  assert.ok(list.some(c => c.id === w.checkinId));
  noBookkeeping(list, 'memberCheckIns');
  const ranged = await subscriptionService.memberCheckIns(w.memberId, { from: new Date(Date.now() - 86_400_000).toISOString() });
  noBookkeeping(ranged, 'memberCheckIns range');
});
