// B2B Phase 2 against the CI database: what the schema refuses, the store
// wiring, and the programme routes with guards chained as bfast runs them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, collection } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import {
  adminCreateB2BOrganization, adminSetB2BOrganizationStatus, addB2BOrganizationUser, enrollB2BBeneficiary,
  b2bProgramReference, adminListB2BPrograms, myB2BBenefits, listB2BPrograms, createB2BProgram, getB2BProgram,
  updateB2BProgram, setB2BProgramStatus, listB2BProgramEligibility, listB2BBenefits, createB2BBenefit,
  getB2BBenefit, updateB2BBenefit, setB2BBenefitStatus,
} from '../functions/b2b.mjs';

const ROLLBACK = Symbol('rollback');
const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const users = [];
const orgs = [];

async function inRollback(fn) {
  try {
    await db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}
async function rejects(trx, fn, code) {
  await assert.rejects(trx.transaction(fn), err => err.code === code, `expected Postgres error ${code}`);
}

async function makeUser(userType) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `B2B program ${userType}`, updatedAt: new Date() });
  users.push(id);
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
  if (orgs.length) await db('B2BOrganization').whereIn('id', orgs).del();   // cascades programmes and benefits
  if (users.length) {
    await db('AuditLog').whereIn('actor', users).del();
    await db('User').whereIn('id', users).del();
  }
});

// ── Schema ───────────────────────────────────────────────────────────────────

async function org(trx) {
  const id = uid('b2bo');
  await trx('B2BOrganization').insert({ id, organizationType: 'insurer', legalName: 'Schema insurer', status: 'active' });
  return id;
}
const program = (organizationId, extra = {}) => ({ id: uid('b2bp'), organizationId, name: 'P', startDate: '2027-01-01', endDate: '2027-12-31', eligibility: { scope: 'all' }, ...extra });
const benefit = (programId, extra = {}) => ({ id: uid('b2bf'), programId, name: 'B', benefitType: 'gym_access', fundingType: 'full', usagePeriod: 'month', usageLimit: 4, providerRules: { scope: 'all' }, ...extra });

test('programme status, dates, budget and activation record are enforced', () => inRollback(async (trx) => {
  const o = await org(trx);
  await rejects(trx, t => t('B2BWellnessProgram').insert(program(o, { status: 'live' })), '23514');
  await rejects(trx, t => t('B2BWellnessProgram').insert(program(o, { endDate: '2026-12-31' })), '23514');
  await rejects(trx, t => t('B2BWellnessProgram').insert(program(o, { startDate: '1/1/2027' })), '23514');
  await rejects(trx, t => t('B2BWellnessProgram').insert(program(o, { budgetTzs: -1 })), '23514');
  await rejects(trx, t => t('B2BWellnessProgram').insert(program(o, { status: 'active' })), '23514');   // no activatedAt
  await rejects(trx, t => t('B2BWellnessProgram').insert(program('b2bo_missing')), '23503');
  await trx('B2BWellnessProgram').insert(program(o, { status: 'active', activatedAt: new Date(), endDate: null }));
}));

test('each funding type carries exactly its numbers; unlimited has no limits', () => inRollback(async (trx) => {
  const o = await org(trx);
  const p = program(o);
  await trx('B2BWellnessProgram').insert(p);
  const bad = [
    { fundingType: 'full', sponsorAmountTzs: 100 },
    { fundingType: 'sponsor_fixed' },
    { fundingType: 'sponsor_fixed', sponsorAmountTzs: 0 },
    { fundingType: 'sponsor_percentage' },
    { fundingType: 'sponsor_percentage', sponsorShareBps: 10001 },
    { fundingType: 'sponsor_percentage', sponsorShareBps: 5000, beneficiaryAmountTzs: 100 },
    { fundingType: 'beneficiary_fixed' },
    { fundingType: 'none', periodSponsorCapTzs: 1000 },
    { fundingType: 'gift' },
    { usagePeriod: 'unlimited', usageLimit: 4 },
    { usagePeriod: 'fortnight' },
    { usageLimit: 0 },
    { startDate: '2027-05-01', endDate: '2027-04-01' },
  ];
  for (const extra of bad) await rejects(trx, t => t('B2BBenefit').insert(benefit(p.id, extra)), '23514');
  for (const extra of [
    {}, { fundingType: 'sponsor_fixed', sponsorAmountTzs: 3000 },
    { fundingType: 'sponsor_percentage', sponsorShareBps: 6000, sponsorCapTzs: 5000 },
    { fundingType: 'beneficiary_fixed', beneficiaryAmountTzs: 2000 },
    { fundingType: 'none', usagePeriod: 'unlimited', usageLimit: null },
    { usagePeriod: 'month', usageLimit: null, periodSponsorCapTzs: 50000 },
  ]) await trx('B2BBenefit').insert(benefit(p.id, extra));
  // Benefits go with their programme.
  await trx('B2BWellnessProgram').where({ id: p.id }).del();
  assert.equal((await trx('B2BBenefit').where({ programId: p.id })).length, 0);
}));

test('the collection API keeps days as text and round-trips the JSON rules', async () => {
  const progs = collection('b2b_programs');
  const bens = collection('b2b_benefits');
  const o = uid('b2bo');
  await db('B2BOrganization').insert({ id: o, organizationType: 'club', legalName: 'Wiring club' });
  try {
    const p = program(o, { eligibility: { scope: 'groups', groups: ['Gold'], beneficiaryIds: [], beneficiaryTypes: [], enrolledOnOrBefore: null } });
    await progs.insertAsync(p);
    const back = await progs.findByIdAsync(p.id);
    assert.deepEqual([back.startDate, back.endDate, back.eligibility.groups], ['2027-01-01', '2027-12-31', ['Gold']]);
    const b = benefit(p.id, { providerRules: { scope: 'selected', gymTiers: ['standard'] }, eligibility: { groups: ['Gold'], beneficiaryTypes: [] } });
    await bens.insertAsync(b);
    const bb = await bens.findByIdAsync(b.id);
    assert.deepEqual([bb.providerRules, bb.eligibility.groups, bb.usageLimit], [{ scope: 'selected', gymTiers: ['standard'] }, ['Gold'], 4]);
  } finally {
    await db('B2BOrganization').where({ id: o }).del();
  }
});

// ── Routes ───────────────────────────────────────────────────────────────────

async function activeOrg(admin, legalName) {
  const created = await call(adminCreateB2BOrganization, { claims: admin, body: { organizationType: 'insurer', legalName } });
  orgs.push(created.body.organization.id);
  await call(adminSetB2BOrganizationStatus, { claims: admin, params: { id: created.body.organization.id }, body: { status: 'active' } });
  return created.body.organization.id;
}

test('programme and benefit routes: full flow, roles, FitFlex activation and a member\'s benefits', async () => {
  assert.equal((await call(b2bProgramReference, {})).body.benefitTypes.gym_access.fulfilledBy, 'Gym check-in (Checkin)');
  const admin = { sub: await makeUser('admin'), userType: 'admin' };
  const id = await activeOrg(admin, 'Route insurer');
  const owner = { sub: await makeUser('member'), userType: 'member' };
  const analyst = { sub: await makeUser('member'), userType: 'member' };
  const memberId = await makeUser('member');
  await call(addB2BOrganizationUser, { claims: admin, params: { id }, body: { userId: owner.sub, role: 'owner' } });
  await call(addB2BOrganizationUser, { claims: admin, params: { id }, body: { userId: analyst.sub, role: 'analyst' } });
  await call(enrollB2BBeneficiary, { claims: admin, params: { id }, body: { userId: memberId, groupName: 'Gold', status: 'active' } });

  const year = new Date().getUTCFullYear() + 1;
  const created = await call(createB2BProgram, { claims: owner, params: { id }, body: { name: 'Route programme', startDate: `${year - 1}-01-01`, endDate: `${year}-12-31`, eligibility: { scope: 'groups', groups: ['Gold'] } } });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  const programId = created.body.program.id;
  assert.equal((await call(createB2BProgram, { claims: analyst, params: { id }, body: { name: 'x', startDate: `${year}-01-01` } })).statusCode, 403);

  const ben = await call(createB2BBenefit, { claims: owner, params: { id, programId }, body: { name: '8 visits', benefitType: 'gym_access', fundingType: 'full', usageLimit: 8, usagePeriod: 'month' } });
  assert.equal(ben.statusCode, 201, JSON.stringify(ben.body));
  const benefitId = ben.body.benefit.id;
  assert.equal((await call(setB2BBenefitStatus, { claims: owner, params: { id, programId, benefitId }, body: { status: 'active' } })).body.benefit.status, 'active');
  assert.equal((await call(updateB2BProgram, { claims: owner, params: { id, programId }, body: { description: 'For Gold members' } })).body.program.description, 'For Gold members');
  assert.equal((await call(setB2BProgramStatus, { claims: owner, params: { id, programId }, body: { status: 'pending' } })).body.program.status, 'pending');
  assert.equal((await call(setB2BProgramStatus, { claims: owner, params: { id, programId }, body: { status: 'active' } })).statusCode, 403);
  assert.equal((await call(setB2BProgramStatus, { claims: admin, params: { id, programId }, body: { status: 'active' } })).body.program.status, 'active');

  assert.equal((await call(listB2BPrograms, { claims: analyst, params: { id } })).body.total, 1);
  assert.equal((await call(getB2BProgram, { claims: analyst, params: { id, programId } })).body.benefits.length, 1);
  assert.equal((await call(listB2BBenefits, { claims: analyst, params: { id, programId } })).body.benefits[0].id, benefitId);
  assert.equal((await call(getB2BBenefit, { claims: analyst, params: { id, programId, benefitId } })).body.window.usageLimit, 8);
  assert.equal((await call(updateB2BBenefit, { claims: owner, params: { id, programId, benefitId }, body: { usageLimit: 12 } })).body.error, 'benefit_live');
  const eligibility = await call(listB2BProgramEligibility, { claims: analyst, params: { id, programId } });
  assert.deepEqual(eligibility.body.counts, { beneficiaries: 1, wouldBeEligible: 1, eligibleToday: 1 });
  const listed = await call(adminListB2BPrograms, { claims: admin, query: { organizationId: id } });
  assert.deepEqual(listed.body.items.map(p => p.id), [programId]);
  const staff = { sub: admin.sub, userType: 'admin', portalUser: true, aclPermissions: ['corporate'] };
  assert.equal((await call(adminListB2BPrograms, { claims: staff })).body.requiredScope, 'b2b');

  const mine = await call(myB2BBenefits, { claims: { sub: memberId, userType: 'member' } });
  assert.deepEqual(mine.body.benefits.map(b => [b.benefit.name, b.benefit.fundingSummary]), [['8 visits', 'Sponsor pays 100%']]);
  assert.equal((await call(myB2BBenefits, {})).statusCode, 401);
});

test('organisation A cannot reach organisation B programmes through any route', async () => {
  const admin = { sub: await makeUser('admin'), userType: 'admin' };
  const a = await activeOrg(admin, 'Route A');
  const b = await activeOrg(admin, 'Route B');
  const ownerA = { sub: await makeUser('member'), userType: 'member' };
  await call(addB2BOrganizationUser, { claims: admin, params: { id: a }, body: { userId: ownerA.sub, role: 'owner' } });
  const year = new Date().getUTCFullYear() + 1;
  const programId = (await call(createB2BProgram, { claims: admin, params: { id: b }, body: { name: 'B programme', startDate: `${year}-01-01` } })).body.program.id;
  const benefitId = (await call(createB2BBenefit, { claims: admin, params: { id: b, programId }, body: { name: 'B benefit', benefitType: 'custom', fundingType: 'full' } })).body.benefit.id;

  for (const [route, params, body] of [
    [listB2BPrograms, { id: b }], [createB2BProgram, { id: b }, { name: 'x', startDate: `${year}-01-01` }],
    [getB2BProgram, { id: b, programId }], [updateB2BProgram, { id: b, programId }, { name: 'x' }],
    [setB2BProgramStatus, { id: b, programId }, { status: 'cancelled' }], [listB2BProgramEligibility, { id: b, programId }],
    [listB2BBenefits, { id: b, programId }], [createB2BBenefit, { id: b, programId }, { name: 'x', benefitType: 'custom', fundingType: 'full' }],
    [getB2BBenefit, { id: b, programId, benefitId }], [updateB2BBenefit, { id: b, programId, benefitId }, { name: 'x' }],
    [setB2BBenefitStatus, { id: b, programId, benefitId }, { status: 'active' }],
  ]) {
    const out = await call(route, { claims: ownerA, params, body });
    assert.deepEqual([out.statusCode, out.body.error], [404, 'organization_not_found'], route.path);
  }
  // B's ids under A's organisation are unknown too.
  assert.equal((await call(getB2BProgram, { claims: ownerA, params: { id: a, programId } })).statusCode, 404);
  assert.equal((await call(getB2BBenefit, { claims: ownerA, params: { id: a, programId, benefitId } })).statusCode, 404);
  assert.equal((await db('B2BWellnessProgram').where({ id: programId }).first()).name, 'B programme');
});
