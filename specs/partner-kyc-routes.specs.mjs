// Partner KYC routes: who may call what. Partners reach only their own KYC;
// members don't have one; admins need the 'kyc' scope when they are portal
// staff. Guards run exactly as bfast-function chains them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { myKyc, myKycPerson, adminKycCases, adminKycPartner, adminKycSiteVisit } from '../functions/partner-kyc.mjs';

const users = [];

async function makeUser(userType) {
  const id = `usr_${randomUUID().slice(0, 8)}`;
  await db('User').insert({ id, userType, displayName: `KYC route ${userType}`, updatedAt: new Date() });
  users.push(id);
  return id;
}

function res() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

/** Run a route's guards, then its handler if every guard passes. */
async function call(route, { claims, params = {}, body = {}, query = {} }) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat()) {
    let passed = false;
    guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

after(async () => {
  if (users.length) {
    await db('AuditLog').whereIn('actor', users).del();
    await db('User').whereIn('id', users).del();
  }
});

test('a trainer reads and fills in their own KYC', async () => {
  const id = await makeUser('trainer');
  const read = await call(myKyc, { claims: { sub: id, userType: 'trainer' } });
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.partnerType, 'trainer');
  const saved = await call(myKycPerson, { claims: { sub: id, userType: 'trainer' }, params: { role: 'principal' }, body: { fullName: 'Route Trainer' } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.people[0].fullName, 'Route Trainer');
  const wrongRole = await call(myKycPerson, { claims: { sub: id, userType: 'trainer' }, params: { role: 'director' }, body: {} });
  assert.deepEqual([wrongRole.statusCode, wrongRole.body], [400, { error: 'invalid_role', allowed: ['principal'] }]);
});

test('members, staff and signed-out callers have no partner KYC', async () => {
  assert.equal((await call(myKyc, {})).statusCode, 401);
  assert.equal((await call(myKyc, { claims: { sub: await makeUser('member'), userType: 'member' } })).statusCode, 403);
  assert.equal((await call(myKyc, { claims: { sub: 'x', userType: 'gym_staff' } })).statusCode, 403);
  assert.equal((await call(myKyc, { claims: { sub: 'x', userType: 'admin' } })).statusCode, 403);
});

test('admin KYC routes need the kyc scope for portal staff', async () => {
  const superAdmin = { sub: await makeUser('admin'), userType: 'admin' };
  assert.equal((await call(adminKycCases, { claims: superAdmin })).statusCode, 200);
  const staffWithout = { sub: 'staff', userType: 'admin', portalUser: true, aclPermissions: ['gyms'] };
  const refused = await call(adminKycCases, { claims: staffWithout });
  assert.deepEqual([refused.statusCode, refused.body.requiredScope], [403, 'kyc']);
  const staffWith = { ...staffWithout, aclPermissions: ['kyc'] };
  assert.equal((await call(adminKycCases, { claims: staffWith })).statusCode, 200);
  assert.equal((await call(adminKycCases, { claims: { sub: 'v', userType: 'vendor' } })).statusCode, 403);
});

test('admin partner routes resolve the partner from the URL', async () => {
  const admin = { sub: await makeUser('admin'), userType: 'admin' };
  const vendorId = await makeUser('vendor');
  const ok = await call(adminKycPartner, { claims: admin, params: { partnerType: 'vendor', subjectId: vendorId } });
  assert.equal(ok.body.partnerType, 'vendor');
  const mismatch = await call(adminKycPartner, { claims: admin, params: { partnerType: 'trainer', subjectId: vendorId } });
  assert.deepEqual([mismatch.statusCode, mismatch.body.error], [404, 'partner_not_found']);
  const badType = await call(adminKycPartner, { claims: admin, params: { partnerType: 'member', subjectId: vendorId } });
  assert.deepEqual([badType.statusCode, badType.body.error], [400, 'invalid_partner_type']);
  const noGym = await call(adminKycSiteVisit, { claims: admin, params: { gymId: 'gym_missing' }, body: {} });
  assert.deepEqual([noGym.statusCode, noGym.body.error], [404, 'gym_not_found']);
});
