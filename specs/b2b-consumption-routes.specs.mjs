// B2B Phase 3 routes, guards chained as bfast runs them: the ledger is
// FitFlex-only, organisations read their own aggregates, and no route lets a
// caller consume a benefit or name an amount.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { gyms, b2bConsumptionService as usage } from '../src/bootstrap/services.mjs';
import * as b2bRoutes from '../functions/b2b.mjs';
import { adminOnboardCorporate, adminSetCorporateStatus, adminCreateHrUser, corporateProvisionStaff, corporateLinkStaffUser } from '../functions/corporate.mjs';

await ensureInit();
const {
  adminCreateB2BOrganization, adminSetB2BOrganizationStatus, addB2BOrganizationUser, enrollB2BBeneficiary,
  createB2BProgram, createB2BBenefit, setB2BBenefitStatus, setB2BProgramStatus,
  adminListB2BConsumptions, adminGetB2BConsumption, adminReverseB2BConsumption, adminEvaluateB2BUsage, getB2BProgramUsage, myB2BBenefits,
} = b2bRoutes;

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [], gyms: [], corporates: [] };

async function user(userType) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Usage route ${userType}`, updatedAt: new Date() });
  made.users.push(id);
  return id;
}
function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(route, { claims, params = {}, body = {}, query = {} }) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

after(async () => {
  const orgIds = [...made.orgs, ...(made.corporates.length ? await db('B2BOrganization').whereIn('legacyCorporateId', made.corporates).pluck('id') : [])];
  if (orgIds.length) {
    await db('AuditLog').whereIn('target', db('B2BBenefitConsumption').whereIn('organizationId', orgIds).select('id')).del();
    await db('B2BBenefitConsumption').whereIn('organizationId', orgIds).del();
    await db('B2BOrganization').whereIn('id', orgIds).del();
  }
  if (made.corporates.length) {
    await db('CorporateEmployee').whereIn('corporateId', made.corporates).del();
    await db('CorporateAccount').whereIn('id', made.corporates).del();
  }
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  await db('AuditLog').whereIn('actor', made.users).del();
  await db('User').whereIn('id', made.users).del();
});

async function liveOrganisation(admin, name) {
  const created = await call(adminCreateB2BOrganization, { claims: admin, body: { organizationType: 'insurer', legalName: name } });
  const id = created.body.organization.id;
  made.orgs.push(id);
  await call(adminSetB2BOrganizationStatus, { claims: admin, params: { id }, body: { status: 'active' } });
  const programId = (await call(createB2BProgram, { claims: admin, params: { id }, body: { name: `${name} programme`, startDate: '2026-01-01' } })).body.program.id;
  const benefitId = (await call(createB2BBenefit, { claims: admin, params: { id, programId }, body: { name: 'Gym', benefitType: 'gym_access', fundingType: 'full', usageLimit: 8, usagePeriod: 'month' } })).body.benefit.id;
  await call(setB2BBenefitStatus, { claims: admin, params: { id, programId, benefitId }, body: { status: 'active' } });
  await call(setB2BProgramStatus, { claims: admin, params: { id, programId }, body: { status: 'pending' } });
  await call(setB2BProgramStatus, { claims: admin, params: { id, programId }, body: { status: 'active' } });
  return { id, programId, benefitId };
}

test('the ledger is FitFlex-only; organisations read only their own aggregates', async () => {
  const admin = { sub: await user('admin'), userType: 'admin' };
  const a = await liveOrganisation(admin, 'Usage route A');
  const b = await liveOrganisation(admin, 'Usage route B');
  const ownerA = { sub: await user('member'), userType: 'member' };
  await call(addB2BOrganizationUser, { claims: admin, params: { id: a.id }, body: { userId: ownerA.sub, role: 'owner' } });
  const memberId = await user('member');
  await call(enrollB2BBeneficiary, { claims: admin, params: { id: a.id }, body: { userId: memberId, status: 'active' } });

  const gymId = uid('gym');
  await gyms.insertAsync({ id: gymId, name: 'Usage route gym', tier: 'standard', location: 'Dar', status: 'active', ratePerDay: 5000 });
  made.gyms.push(gymId);
  const gym = gyms.find(g => g.id === gymId);
  const consumed = await usage.consume({ userId: memberId, sourceType: 'gym_checkin', sourceId: uid('chk'), provider: { type: 'gym', id: gymId, tier: gym.tier }, grossTzs: 5000 });
  const consumptionId = consumed.consumption.id;

  // Dry run by ids: the value comes from the gym record, not the caller.
  const dry = await call(adminEvaluateB2BUsage, { claims: admin, body: { userId: memberId, serviceType: 'gym_access', providerId: gymId, grossTzs: 1, sponsorTzs: 999999 } });
  assert.deepEqual([dry.statusCode, dry.body.covered, dry.body.grossTzs, dry.body.chosen.sponsorTzs, dry.body.chosen.remaining.uses], [200, true, 5000, 5000, 6]);
  assert.equal((await db('B2BBenefitConsumption').where({ benefitId: a.benefitId })).length, 1);   // wrote nothing

  // Members, organisation owners and portal staff without the scope are refused.
  for (const claims of [ownerA, { sub: memberId, userType: 'member' }]) {
    for (const [route, params] of [[adminListB2BConsumptions, {}], [adminGetB2BConsumption, { consumptionId }], [adminReverseB2BConsumption, { consumptionId }], [adminEvaluateB2BUsage, {}]]) {
      assert.equal((await call(route, { claims, params, body: { reason: 'x' } })).statusCode, 403, route.path);
    }
  }
  const staff = { ...admin, portalUser: true, aclPermissions: ['corporate'] };
  assert.equal((await call(adminListB2BConsumptions, { claims: staff })).body.requiredScope, 'b2b');
  assert.equal((await call(adminListB2BConsumptions, {})).statusCode, 401);

  const list = await call(adminListB2BConsumptions, { claims: admin, query: { organizationId: a.id } });
  assert.deepEqual([list.body.total, list.body.items[0].id, list.body.totals.sponsorTzs], [1, consumptionId, 5000]);
  const detail = await call(adminGetB2BConsumption, { claims: admin, params: { consumptionId } });
  assert.equal(detail.body.settlementCandidate.consumptionId, consumptionId);

  // The owner sees A's totals, never B's programme, and no event rows.
  const mine = await call(getB2BProgramUsage, { claims: ownerA, params: { id: a.id, programId: a.programId } });
  assert.deepEqual([mine.statusCode, mine.body.totals.uses, mine.body.byBeneficiary.length], [200, 1, 1]);
  assert.equal((await call(getB2BProgramUsage, { claims: ownerA, params: { id: b.id, programId: b.programId } })).statusCode, 404);
  assert.equal((await call(getB2BProgramUsage, { claims: ownerA, params: { id: a.id, programId: b.programId } })).statusCode, 404);

  // The member sees their own allowance.
  const benefits = await call(myB2BBenefits, { claims: { sub: memberId, userType: 'member' } });
  assert.deepEqual(benefits.body.benefits.map(x => [x.used, x.remaining]), [[1, 7]]);

  const reversed = await call(adminReverseB2BConsumption, { claims: admin, params: { consumptionId }, body: { reason: 'Test reversal' } });
  assert.deepEqual([reversed.statusCode, reversed.body.consumption.status, reversed.body.consumption.reversedBy], [200, 'reversed', admin.sub]);
  assert.equal((await call(adminReverseB2BConsumption, { claims: admin, params: { consumptionId }, body: {} })).body.error, 'reason_required');
});

test('no route consumes a benefit: usage only enters through the gym check-in and trainer booking services', () => {
  const source = readFileSync(new URL('../functions/b2b.mjs', import.meta.url), 'utf8');
  assert.equal(/usage\.(consume|holdGymVisit|consumeTrainerSession|confirm)\(/.test(source), false);
  const mutating = Object.values(b2bRoutes).filter(r => r?.path?.includes('consumptions') && r.method !== 'get').map(r => r.path);
  assert.deepEqual(mutating, ['/admin/b2b/consumptions/:consumptionId/reverse']);
});

test('HR links an employee to a member account through the corporate route', async () => {
  const admin = { sub: await user('admin'), userType: 'admin' };
  const onboard = await call(adminOnboardCorporate, { claims: admin, body: { companyName: 'Usage route corp', industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'fully_funded', passTier: 'pro' } });
  made.corporates.push(onboard.body.id);
  await call(adminSetCorporateStatus, { claims: admin, params: { id: onboard.body.id }, body: { status: 'active' } });
  const hr = await call(adminCreateHrUser, { claims: admin, params: { id: onboard.body.id }, body: { displayName: 'HR', email: `hr-${uid('x')}@usage.tz`, password: 'a-long-password' } });
  made.users.push(hr.body.hrUser.id);
  const hrClaims = { sub: hr.body.hrUser.id, userType: 'corporate_hr' };
  const employeeId = (await call(corporateProvisionStaff, { claims: hrClaims, body: { displayName: 'Emp' } })).body.employee.id;
  const memberId = await user('member');

  assert.equal((await call(corporateLinkStaffUser, { claims: { sub: memberId, userType: 'member' }, params: { id: employeeId }, body: { userId: memberId } })).statusCode, 403);
  const linked = await call(corporateLinkStaffUser, { claims: hrClaims, params: { id: employeeId }, body: { userId: memberId } });
  assert.deepEqual([linked.statusCode, linked.body.employee.userId], [200, memberId]);
  const second = (await call(corporateProvisionStaff, { claims: hrClaims, body: { displayName: 'Emp 2' } })).body.employee.id;
  assert.equal((await call(corporateLinkStaffUser, { claims: hrClaims, params: { id: second }, body: { userId: memberId } })).body.error, 'user_already_linked');
  assert.equal((await call(corporateLinkStaffUser, { claims: hrClaims, params: { id: employeeId }, body: { userId: null } })).body.employee.userId, null);
});

test('a benefit-only member gets a QR; staff see "covered", never the sponsor or the amounts', async () => {
  const { operatorService } = await import('../src/bootstrap/services.mjs');
  const admin = { sub: await user('admin'), userType: 'admin' };
  const org = await liveOrganisation(admin, 'Usage route staff scan');
  const memberId = await user('member');
  const stranger = await user('member');
  await call(enrollB2BBeneficiary, { claims: admin, params: { id: org.id }, body: { userId: memberId, status: 'active' } });
  const gymId = uid('gym');
  await gyms.insertAsync({ id: gymId, name: 'Staff scan gym', tier: 'standard', location: 'Dar', status: 'active', ratePerDay: 5000 });
  made.gyms.push(gymId);
  const operator = { id: await user('gym_operator'), userType: 'gym_operator', gymIds: [gymId] };

  // No pass and no benefit: no QR, as before.
  assert.equal((await operatorService.issueMemberQr(stranger)).error, 'active_subscription_required');
  const { qr } = await operatorService.issueMemberQr(memberId);
  assert.ok(qr?.token);

  const preview = await operatorService.verifyQr({ operator, gymId, qrToken: qr.token });
  assert.deepEqual([preview.body.eligible, preview.body.reason, preview.body.subscription], [true, 'sponsor_benefit', null]);
  assert.equal((await db('B2BBenefitConsumption').where({ benefitId: org.benefitId })).length, 0);   // a preview consumes nothing

  const scanned = await operatorService.checkIn({ operator, gymId, qrToken: qr.token });
  assert.equal(scanned.status, 200, JSON.stringify(scanned.body));
  assert.deepEqual(scanned.body.b2b, { covered: true });
  assert.equal(scanned.body.checkin.subscriptionType, 'b2b_benefit');
  assert.equal(JSON.stringify(scanned.body).includes('Usage route staff scan'), false);
  const [row] = await db('B2BBenefitConsumption').where({ benefitId: org.benefitId });
  assert.deepEqual([row.status, row.sourceId, row.metadata.method], ['approved', scanned.body.checkin.id, 'gym_scanned']);
  await db('Checkin').where({ memberId }).del();
});
