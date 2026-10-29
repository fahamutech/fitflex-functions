// Member scan accepts the web URL form (S2) next to the old fitflex:gym: payload, with the same signature check;
// the entrance-qr endpoints add webUrl only once PORTAL_PUBLIC_URL is set.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { gyms, users } from '../src/bootstrap/collections.mjs';
import { operatorService } from '../src/bootstrap/services.mjs';
import { issue as issueMemberQr, issueGymQr } from '../src/auth/qr-token.mjs';
import { memberScanGymQr, operatorGymEntranceQr, adminGymEntranceQr } from '../functions/checkins.mjs';

assert.match(String(process.env.DATABASE_URL_CI || ''), /fitflex_ci/, 'specs run against the CI database only');

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], gyms: [] };
const portalBefore = process.env.PORTAL_PUBLIC_URL;
beforeEach(() => { delete process.env.PORTAL_PUBLIC_URL; });
after(async () => {
  if (portalBefore === undefined) delete process.env.PORTAL_PUBLIC_URL; else process.env.PORTAL_PUBLIC_URL = portalBefore;
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

test('member scan: URL form is verified like the payload; forged, unsigned, wrong-scheme and oversized forms stay invalid_gym_qr', async () => {
  const w = await world();
  const payload = issueGymQr(w.gymId);
  const bad = [
    `https://portal.example.test/g/?q=${encodeURIComponent(payload.slice(0, -2))}xx`,
    `https://portal.example.test/g/?q=${encodeURIComponent(payload.replace(w.gymId, 'gym_other'))}`,
    `http://portal.example.test/g/?q=${encodeURIComponent(payload)}`,
    `https://portal.example.test/g/`,
    `https://portal.example.test/g/?q=${'a'.repeat(3000)}`,
    `javascript:${payload}`, 'not a code', '', null, undefined, 42, { q: payload },
  ];
  for (const gymQr of bad) {
    const out = await operatorService.memberScanGym({ memberId: w.memberId, gymQr });
    assert.equal(out.status, 400, String(gymQr).slice(0, 60));
    assert.deepEqual(out.body, { ok: false, failure: 'invalid_gym_qr' });
  }
  // The route itself is unchanged in method and path.
  assert.equal(memberScanGymQr.method, 'post');
  assert.equal(memberScanGymQr.path, '/me/checkins/scan');
});

test('entrance QR: unchanged response while PORTAL_PUBLIC_URL is unset; webUrl only once it is set', async () => {
  const w = await world();
  const direct = operatorService.gymEntranceQr({ operator: w.operator, gymId: w.gymId });
  assert.deepEqual(Object.keys(direct.body).sort(), ['gymId', 'gymName', 'payload']);
  assert.equal(direct.body.payload, issueGymQr(w.gymId));
  const adminOff = operatorService.gymEntranceQr({ gymId: w.gymId, isAdmin: true });
  assert.deepEqual(Object.keys(adminOff.body).sort(), ['gymId', 'gymName', 'payload']);

  process.env.PORTAL_PUBLIC_URL = 'https://portal.example.test/';
  for (const out of [operatorService.gymEntranceQr({ operator: w.operator, gymId: w.gymId }), operatorService.gymEntranceQr({ gymId: w.gymId, isAdmin: true })]) {
    assert.equal(out.body.payload, issueGymQr(w.gymId));
    assert.equal(out.body.webUrl, `https://portal.example.test/g/?q=${encodeURIComponent(issueGymQr(w.gymId))}`);
    // The printed URL scans back into a valid check-in code.
    assert.equal((await operatorService.memberScanGym({ memberId: w.memberId, gymQr: out.body.webUrl })).status, 200);
  }
  process.env.PORTAL_PUBLIC_URL = '   ';
  assert.ok(!('webUrl' in operatorService.gymEntranceQr({ gymId: w.gymId, isAdmin: true }).body), 'blank counts as unset');
  assert.equal(operatorGymEntranceQr.path, '/operator/gyms/:gymId/entrance-qr');
  assert.equal(adminGymEntranceQr.path, '/admin/gyms/:gymId/entrance-qr');

});

test('a member scan through the URL form records an ordinary in-app scan visit', async () => {
  await gyms.ready;
  const gymId = uid('gym'); const memberId = uid('usr');
  await gyms.insertAsync({ id: gymId, name: 'Url Form Gym', tier: 'standard', status: 'active', location: 'Masaki', homepageVisible: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await users.insertAsync({ id: memberId, userType: 'trainer', displayName: 'Url Form', accountStatus: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  made.gyms.push(gymId); made.users.push(memberId);
  // No pass: refused with the same code for the payload and the URL form.
  const a = await operatorService.memberScanGym({ memberId, gymQr: issueGymQr(gymId) });
  const b = await operatorService.memberScanGym({ memberId, gymQr: `https://portal.example.test/g/?q=${encodeURIComponent(issueGymQr(gymId))}` });
  assert.equal(a.status, 409);
  assert.deepEqual(b.body, a.body);
});
