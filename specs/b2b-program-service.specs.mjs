// B2B Phase 2 service: programme lifecycle, benefits, eligibility listing,
// organisation isolation, a member's own benefits and the Corporate
// read-through — against in-memory collections, with the real b2bService.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createB2BService } from '../src/services/b2b-service.mjs';
import { createB2BProgramService } from '../src/services/b2b-program-service.mjs';

function store(rows = []) {
  const clone = r => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async allAsync() { return rows.map(clone); },
    async filterAsync(pred) { return rows.filter(pred).map(clone); },
    async findAsync(pred) { const r = rows.find(pred); return r ? clone(r) : null; },
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v).map(clone); },
    async filterByColumnInAsync(col, vs) { return rows.filter(r => vs.includes(r[col])).map(clone); },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? clone(r) : null; },
    async insertAsync(row) { rows.push(clone(row)); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
  };
}

// 2027-03-15 12:00 EAT.
let NOW = new Date('2027-03-15T09:00:00.000Z');

function setup() {
  NOW = new Date('2027-03-15T09:00:00.000Z');
  const s = {
    users: store([
      { id: 'admin', userType: 'admin' },
      { id: 'owner_a', userType: 'member', displayName: 'Owner A' },
      { id: 'owner_b', userType: 'member', displayName: 'Owner B' },
      { id: 'viewer_a', userType: 'member', displayName: 'Viewer A' },
      { id: 'm1', userType: 'member', displayName: 'Asha' },
      { id: 'm2', userType: 'member', displayName: 'Baraka' },
      { id: 'm3', userType: 'member', displayName: 'Chausiku' },
      { id: 'vendor1', userType: 'vendor', displayName: 'Shop' },
      { id: 'hr_corp', userType: 'corporate_hr', corporateId: 'corp_1', accountStatus: 'active' },
    ]),
    corporateAccounts: store([{ id: 'corp_1', companyName: 'NMB Bank', industrySector: 'banking', status: 'active' }]),
    corporateEmployees: store([
      { id: 'cemp_1', corporateId: 'corp_1', userId: 'm3', displayName: 'Chausiku', department: 'Finance', status: 'active', activatedAt: '2026-06-01T00:00:00.000Z' },
      { id: 'cemp_2', corporateId: 'corp_1', userId: null, displayName: 'Unlinked', department: 'Ops', status: 'active' },
    ]),
    partnerKycCases: store([]),
    organizations: store([]),
    organizationUsers: store([]),
    beneficiaries: store([]),
    programs: store([]),
    benefits: store([]),
    gyms: store([{ id: 'gym_a', tier: 'standard' }, { id: 'gym_b', tier: 'premium' }]),
    trainers: store([{ id: 'tp_1' }]),
    challenges: store([
      { id: 'ch_fitflex', creatorType: 'fitflex' },
      { id: 'ch_corp1', creatorType: 'corporate', creatorId: 'corp_1' },
      { id: 'ch_corp2', creatorType: 'corporate', creatorId: 'corp_2' },
    ]),
    auditLog: store([]),
  };
  const now = () => NOW;
  s.b2b = createB2BService({ ...s, now });
  s.prog = createB2BProgramService({ ...s, b2bService: s.b2b, now });
  return s;
}

const ADMIN = { userId: 'admin', userType: 'admin' };
const access = (s, organizationId, who = ADMIN) => s.b2b.resolveAccess({ organizationId, ...who });

/** Active insurer with an owner, a viewer and three beneficiaries. */
async function insurer(s, legalName = 'Jubilee', owner = 'owner_a') {
  const { organization } = await s.b2b.createOrganization({ body: { organizationType: 'insurer', legalName } });
  await s.b2b.setOrganizationStatus({ organizationId: organization.id, status: 'active' });
  const admin = await access(s, organization.id);
  await s.b2b.addOrganizationUser({ access: admin, body: { userId: owner, role: 'owner' } });
  return organization.id;
}
async function enrol(s, orgId, userId, extra = {}) {
  return (await s.b2b.enrollBeneficiary({ access: await access(s, orgId), body: { userId, status: 'active', ...extra } })).beneficiary;
}

const PROGRAM = { name: 'ActiveLife Member Wellness', programType: 'insurance_wellness', startDate: '2027-01-01', endDate: '2027-12-31' };
const GYM = { name: '4 gym visits a month', benefitType: 'gym_access', fundingType: 'full', usageLimit: 4, usagePeriod: 'month' };

async function liveProgram(s, orgId, who, programBody = PROGRAM, benefitBody = GYM) {
  const owner = await access(s, orgId, who);
  const { program } = await s.prog.createProgram({ access: owner, body: programBody, actorId: who.userId });
  const { benefit } = await s.prog.createBenefit({ access: owner, programId: program.id, body: benefitBody });
  await s.prog.setBenefitStatus({ access: owner, programId: program.id, benefitId: benefit.id, status: 'active' });
  await s.prog.setProgramStatus({ access: owner, programId: program.id, status: 'pending' });
  await s.prog.setProgramStatus({ access: await access(s, orgId), programId: program.id, status: 'active', actorId: 'admin' });
  return { programId: program.id, benefitId: benefit.id };
}

const OWNER_A = { userId: 'owner_a', userType: 'member' };

// ── Programmes ───────────────────────────────────────────────────────────────

test('create, retrieve, list and update a draft programme', async () => {
  const s = setup();
  const orgId = await insurer(s);
  const owner = await access(s, orgId, OWNER_A);
  assert.equal((await s.prog.createProgram({ access: owner, body: { ...PROGRAM, name: ' ' } })).error, 'name_required');
  assert.equal((await s.prog.createProgram({ access: owner, body: { ...PROGRAM, programType: 'lottery' } })).error, 'invalid_program_type');
  assert.equal((await s.prog.createProgram({ access: owner, body: { ...PROGRAM, startDate: '2027-13-01' } })).error, 'invalid_start_date');
  assert.equal((await s.prog.createProgram({ access: owner, body: { ...PROGRAM, endDate: '2026-12-01' } })).error, 'end_before_start');
  assert.equal((await s.prog.createProgram({ access: owner, body: { ...PROGRAM, startDate: '2026-01-01', endDate: '2027-01-31' } })).error, 'ends_in_past');
  assert.equal((await s.prog.createProgram({ access: owner, body: { ...PROGRAM, eligibility: { scope: 'selected', beneficiaryIds: ['nope'] } } })).error, 'unknown_beneficiaries');

  const { program } = await s.prog.createProgram({ access: owner, body: { ...PROGRAM, budgetTzs: 10_000_000 }, actorId: 'owner_a' });
  assert.deepEqual([program.status, program.effectiveStatus, program.eligibility.scope, program.budgetTzs], ['draft', 'draft', 'all', 10_000_000]);
  assert.equal((await s.prog.getProgram({ access: owner, programId: program.id })).program.name, PROGRAM.name);
  assert.equal((await s.prog.listPrograms({ access: owner })).total, 1);
  const updated = await s.prog.updateProgram({ access: owner, programId: program.id, body: { startDate: '2027-02-01', eligibility: { scope: 'groups', groups: ['Gold'] } } });
  assert.deepEqual([updated.program.startDate, updated.program.eligibility.groups], ['2027-02-01', ['Gold']]);
  assert.equal((await s.prog.updateProgram({ access: owner, programId: program.id, body: { status: 'active' } })).error, 'use_status_endpoint');
  assert.equal(s.auditLog.rows.filter(r => r.action.startsWith('b2b.program.')).length, 2);
});

test('lifecycle: submit, FitFlex activates, pause, resume, cancel; invalid moves refused', async () => {
  const s = setup();
  const orgId = await insurer(s);
  const owner = await access(s, orgId, OWNER_A);
  const { program } = await s.prog.createProgram({ access: owner, body: PROGRAM });
  const move = (status, who = owner) => s.prog.setProgramStatus({ access: who, programId: program.id, status, actorId: 'x' });

  assert.equal((await move('paused')).error, 'invalid_transition');
  assert.equal((await move('expired')).error, 'invalid_status');   // only by date
  assert.equal((await move('pending')).program.status, 'pending');
  assert.equal((await move('draft')).program.status, 'draft');      // withdraw
  await move('pending');
  assert.deepEqual((await move('active')).requiredRole, 'platform_admin');
  const admin = await access(s, orgId);
  assert.equal((await move('active', admin)).error, 'no_active_benefits');
  const { benefit } = await s.prog.createBenefit({ access: owner, programId: program.id, body: GYM });
  await s.prog.setBenefitStatus({ access: owner, programId: program.id, benefitId: benefit.id, status: 'active' });
  const active = await move('active', admin);
  assert.deepEqual([active.program.status, active.program.activatedBy], ['active', 'x']);
  assert.equal((await move('paused')).program.status, 'paused');
  assert.equal((await move('active')).program.status, 'active');    // the organisation may resume
  assert.equal((await move('cancelled')).program.status, 'cancelled');
  assert.equal((await move('active', admin)).error, 'invalid_transition');   // cancelled is final
  assert.equal((await s.prog.updateProgram({ access: owner, programId: program.id, body: { name: 'x' } })).error, 'program_closed');
  assert.equal((await s.prog.createBenefit({ access: owner, programId: program.id, body: GYM })).error, 'program_closed');
});

test('a live programme only takes non-destructive edits', async () => {
  const s = setup();
  const orgId = await insurer(s);
  const { programId } = await liveProgram(s, orgId, OWNER_A, { ...PROGRAM, budgetTzs: 1_000_000 });
  const owner = await access(s, orgId, OWNER_A);
  const edit = body => s.prog.updateProgram({ access: owner, programId, body });
  const refused = await edit({ startDate: '2027-02-01', eligibility: { scope: 'all' } });
  assert.deepEqual([refused.error, refused.fields], ['program_live', ['startDate', 'eligibility']]);
  assert.equal((await edit({ endDate: '2027-06-30' })).error, 'cannot_shorten_live_program');
  assert.equal((await edit({ budgetTzs: 500_000 })).error, 'cannot_reduce_live_budget');
  const ok = await edit({ name: 'ActiveLife 2027', endDate: '2028-03-31', budgetTzs: 2_000_000 });
  assert.deepEqual([ok.program.name, ok.program.endDate, ok.program.budgetTzs], ['ActiveLife 2027', '2028-03-31', 2_000_000]);
});

test('programmes expire by date: effective status at once, stored by the daily job', async () => {
  const s = setup();
  const orgId = await insurer(s);
  const { programId } = await liveProgram(s, orgId, OWNER_A);
  NOW = new Date('2028-01-01T09:00:00.000Z');
  const owner = await access(s, orgId, OWNER_A);
  assert.equal((await s.prog.getProgram({ access: owner, programId })).program.effectiveStatus, 'expired');
  assert.equal((await s.prog.setProgramStatus({ access: owner, programId, status: 'paused' })).error, 'invalid_transition');
  assert.equal((await s.prog.createBenefit({ access: owner, programId, body: GYM })).error, 'program_closed');
  assert.deepEqual(await s.prog.expireDue(), { expired: 1 });
  assert.deepEqual(await s.prog.expireDue(), { expired: 0 });
  assert.equal(s.programs.rows[0].status, 'expired');
});

// ── Benefits ─────────────────────────────────────────────────────────────────

test('benefits: create each type, validate providers and dates, retrieve, list', async () => {
  const s = setup();
  const orgId = await insurer(s);
  const owner = await access(s, orgId, OWNER_A);
  const { program } = await s.prog.createProgram({ access: owner, body: PROGRAM });
  const add = body => s.prog.createBenefit({ access: owner, programId: program.id, body });

  assert.equal((await add({ ...GYM, benefitType: 'spa' })).error, 'invalid_benefit_type');
  assert.equal((await add({ ...GYM, providerRules: { scope: 'selected', gymIds: ['gym_a', 'gym_x'] } })).missing.gymIds[0], 'gym_x');
  assert.equal((await add({ ...GYM, startDate: '2026-12-01' })).error, 'benefit_outside_program');
  assert.equal((await add({ ...GYM, endDate: '2028-01-31' })).error, 'benefit_outside_program');
  assert.deepEqual((await add({ name: 'Challenges', benefitType: 'challenge', fundingType: 'none', providerRules: { scope: 'selected', challengeIds: ['ch_corp2'] } })).missing,
    { challengeIds: ['ch_corp2'] });   // another company's challenge

  const created = [
    await add({ ...GYM, name: '8 visits/month at chosen gyms', usageLimit: 8, providerRules: { scope: 'selected', gymIds: ['gym_a'], gymTiers: ['standard'] } }),
    await add({ name: '2 trainer sessions/month at 50%', benefitType: 'trainer_session', fundingType: 'sponsor_percentage', sponsorShareBps: 5000, usageLimit: 2, usagePeriod: 'month', providerRules: { scope: 'selected', trainerIds: ['tp_1'] } }),
    await add({ name: 'Monthly challenge', benefitType: 'challenge', fundingType: 'none', providerRules: { scope: 'selected', challengeIds: ['ch_fitflex'] } }),
    await add({ name: '20% off supplements', benefitType: 'marketplace', fundingType: 'sponsor_percentage', sponsorShareBps: 2000, usagePeriod: 'month', periodSponsorCapTzs: 50000, providerRules: { scope: 'selected', vendorIds: ['vendor1'], productCategories: ['supplements'] } }),
    await add({ name: 'Wellness workshop', benefitType: 'wellness_activity', fundingType: 'beneficiary_fixed', beneficiaryAmountTzs: 2000, usageLimit: 1, usagePeriod: 'quarter', startDate: '2027-04-01', endDate: '2027-06-30' }),
    await add({ name: 'Custom perk', benefitType: 'custom', fundingType: 'sponsor_fixed', sponsorAmountTzs: 3000, usagePeriod: 'program', usageLimit: 20, terms: 'Once per quarter' }),
  ];
  for (const c of created) assert.equal(c.benefit?.status, 'draft', JSON.stringify(c));
  assert.equal(created[4].benefit.validity.startDate, '2027-04-01');
  assert.equal(created[1].benefit.fundingSummary, 'Sponsor pays 50%; beneficiary pays the rest');
  assert.equal((await s.prog.listBenefits({ access: owner, programId: program.id })).benefits.length, 6);
  const one = await s.prog.getBenefit({ access: owner, programId: program.id, benefitId: created[0].benefit.id });
  assert.deepEqual([one.window.start, one.window.end, one.window.usageLimit], ['2027-03-01', '2027-03-31', 8]);
  // Programme dates can't move away from a benefit's own dates.
  assert.equal((await s.prog.updateProgram({ access: owner, programId: program.id, body: { endDate: '2027-05-31' } })).error, 'benefit_outside_program');
});

test('benefit updates, activation and the live lock', async () => {
  const s = setup();
  const orgId = await insurer(s);
  const { programId, benefitId } = await liveProgram(s, orgId, OWNER_A);
  const owner = await access(s, orgId, OWNER_A);
  const update = body => s.prog.updateBenefit({ access: owner, programId, benefitId, body });
  const status = (id, st) => s.prog.setBenefitStatus({ access: owner, programId, benefitId: id, status: st });

  assert.deepEqual((await update({ usageLimit: 10 })).editable, ['name', 'description', 'terms']);
  assert.equal((await update({ name: '4 visits', terms: 'Standard gyms' })).benefit.terms, 'Standard gyms');
  assert.equal((await status(benefitId, 'inactive')).error, 'last_active_benefit');   // pause the programme instead
  const second = (await s.prog.createBenefit({ access: owner, programId, body: { ...GYM, name: 'Second' } })).benefit;
  await status(second.id, 'active');
  assert.equal((await status(benefitId, 'inactive')).benefit.status, 'inactive');
  // Once inactive, funding and limits may change; partial updates validate as a whole.
  const changed = await update({ fundingType: 'sponsor_fixed', sponsorAmountTzs: 3000, usageLimit: 6 });
  assert.deepEqual([changed.benefit.fundingType, changed.benefit.sponsorAmountTzs, changed.benefit.usageLimit, changed.benefit.usagePeriod], ['sponsor_fixed', 3000, 6, 'month']);
  assert.equal((await update({ sponsorAmountTzs: -5 })).error, 'invalid_sponsor_amount');
  assert.equal((await status(benefitId, 'draft')).error, 'invalid_transition');   // never back to draft
  assert.equal((await status(benefitId, 'active')).benefit.status, 'active');
});

test('roles: readers read, only programme managers change, only FitFlex activates', async () => {
  const s = setup();
  const orgId = await insurer(s);
  await s.b2b.addOrganizationUser({ access: await access(s, orgId), body: { userId: 'viewer_a', role: 'viewer' } });
  const { programId, benefitId } = await liveProgram(s, orgId, OWNER_A);
  const viewer = await access(s, orgId, { userId: 'viewer_a', userType: 'member' });
  assert.equal((await s.prog.listPrograms({ access: viewer })).total, 1);
  assert.equal((await s.prog.getBenefit({ access: viewer, programId, benefitId })).benefit.id, benefitId);
  assert.equal((await s.prog.createProgram({ access: viewer, body: PROGRAM })).requiredPermission, 'programs.manage');
  assert.equal((await s.prog.setProgramStatus({ access: viewer, programId, status: 'paused' })).requiredPermission, 'programs.manage');
  assert.equal((await s.prog.updateBenefit({ access: viewer, programId, benefitId, body: { name: 'x' } })).requiredPermission, 'programs.manage');
  // Seeing who is eligible also needs beneficiaries.read, which a viewer lacks.
  assert.equal((await s.prog.listEligibleBeneficiaries({ access: viewer, programId })).requiredPermission, 'beneficiaries.read');
});

test('isolation: organisation A never reaches organisation B programmes or benefits', async () => {
  const s = setup();
  const a = await insurer(s, 'A', 'owner_a');
  const b = await insurer(s, 'B', 'owner_b');
  const { programId, benefitId } = await liveProgram(s, b, { userId: 'owner_b', userType: 'member' });
  const asA = await access(s, a, OWNER_A);
  assert.equal((await access(s, b, OWNER_A)).status, 404);
  assert.equal((await s.prog.getProgram({ access: asA, programId })).status, 404);
  assert.equal((await s.prog.updateProgram({ access: asA, programId, body: { name: 'x' } })).status, 404);
  assert.equal((await s.prog.setProgramStatus({ access: asA, programId, status: 'cancelled' })).status, 404);
  assert.equal((await s.prog.listBenefits({ access: asA, programId })).status, 404);
  assert.equal((await s.prog.getBenefit({ access: asA, programId, benefitId })).status, 404);
  assert.equal((await s.prog.updateBenefit({ access: asA, programId, benefitId, body: { name: 'x' } })).status, 404);
  assert.equal((await s.prog.setBenefitStatus({ access: asA, programId, benefitId, status: 'inactive' })).status, 404);
  assert.equal((await s.prog.createBenefit({ access: asA, programId, body: GYM })).status, 404);
  assert.equal((await s.prog.listEligibleBeneficiaries({ access: asA, programId })).status, 404);
  assert.equal((await s.prog.listPrograms({ access: asA })).total, 0);
  // Selecting B's beneficiaries in A's programme is refused.
  const bBen = await enrol(s, b, 'm1');
  assert.equal((await s.prog.createProgram({ access: asA, body: { ...PROGRAM, eligibility: { scope: 'selected', beneficiaryIds: [bBen.id] } } })).error, 'unknown_beneficiaries');
  assert.equal(s.programs.rows.find(p => p.id === programId).name, PROGRAM.name);
});

// ── Eligibility ──────────────────────────────────────────────────────────────

test('eligible-beneficiary listing: groups, inactive beneficiaries and benefit narrowing', async () => {
  const s = setup();
  const orgId = await insurer(s);
  const gold = await enrol(s, orgId, 'm1', { groupName: 'Gold', beneficiaryType: 'policyholder' });
  await enrol(s, orgId, 'm2', { groupName: 'Silver', beneficiaryType: 'dependant' });
  const owner = await access(s, orgId, OWNER_A);
  const { programId, benefitId } = await liveProgram(s, orgId, OWNER_A,
    { ...PROGRAM, eligibility: { scope: 'groups', groups: ['Gold', 'Silver'] } },
    { ...GYM, eligibility: { beneficiaryTypes: ['policyholder'] } });

  const all = await s.prog.listEligibleBeneficiaries({ access: owner, programId });
  assert.deepEqual(all.counts, { beneficiaries: 2, wouldBeEligible: 2, eligibleToday: 2 });
  const forBenefit = await s.prog.listEligibleBeneficiaries({ access: owner, programId, query: { benefitId, include: 'all' } });
  assert.deepEqual(forBenefit.items.map(r => [r.beneficiary.displayName, r.eligibleToday, r.todayReason]),
    [['Asha', true, null], ['Baraka', false, 'benefit_not_for_beneficiary_type']]);

  await s.b2b.setBeneficiaryStatus({ access: await access(s, orgId), beneficiaryId: gold.id, status: 'suspended' });
  const after = await s.prog.listEligibleBeneficiaries({ access: owner, programId, query: { include: 'all' } });
  assert.equal(after.items.find(r => r.beneficiary.id === gold.id).reason, 'beneficiary_not_active');
  // A draft programme still shows who it would reach.
  const draft = (await s.prog.createProgram({ access: owner, body: { ...PROGRAM, eligibility: { scope: 'groups', groups: ['Silver'] } } })).program;
  const preview = await s.prog.listEligibleBeneficiaries({ access: owner, programId: draft.id });
  assert.deepEqual([preview.counts.wouldBeEligible, preview.counts.eligibleToday], [1, 0]);
});

test('a member sees every benefit they hold today, across organisations and programmes', async () => {
  const s = setup();
  const insurerId = await insurer(s);
  await enrol(s, insurerId, 'm3', { groupName: 'Gold' });
  await liveProgram(s, insurerId, OWNER_A, PROGRAM, { ...GYM, fundingType: 'sponsor_percentage', sponsorShareBps: 6000 });
  // m3 is also an employee of a mapped company with its own programme.
  const employer = (await s.b2b.ensureOrganizationForCorporate({ corporateId: 'corp_1' })).organization.id;
  await liveProgram(s, employer, ADMIN, { ...PROGRAM, name: 'NMB Wellness', eligibility: { scope: 'groups', groups: ['Finance'] } }, { ...GYM, name: '8 visits', usageLimit: 8 });

  const { benefits } = await s.prog.myBenefits({ userId: 'm3' });
  assert.deepEqual(benefits.map(b => [b.organization.name, b.program.name, b.benefit.name, b.window.usageLimit, b.remaining]).sort(), [
    ['Jubilee', 'ActiveLife Member Wellness', '4 gym visits a month', 4, null],
    ['NMB Bank', 'NMB Wellness', '8 visits', 8, null],
  ]);
  assert.equal(benefits.find(b => b.organization.name === 'Jubilee').benefit.fundingSummary, 'Sponsor pays 60%; beneficiary pays the rest');
  assert.deepEqual((await s.prog.myBenefits({ userId: 'm1' })).benefits, []);
  // Suspending the company (through Corporate) removes its benefits.
  s.corporateAccounts.rows[0].status = 'suspended';
  assert.equal((await s.prog.myBenefits({ userId: 'm3' })).benefits.length, 1);
});

test('a mapped company can run programmes over its employees without touching Corporate', async () => {
  const s = setup();
  const orgId = (await s.b2b.ensureOrganizationForCorporate({ corporateId: 'corp_1' })).organization.id;
  const hr = await access(s, orgId, { userId: 'hr_corp', userType: 'corporate_hr' });
  assert.equal((await s.prog.createProgram({ access: hr, body: PROGRAM })).requiredPermission, 'programs.manage');   // HR reads only
  const { programId } = await liveProgram(s, orgId, ADMIN, { ...PROGRAM, eligibility: { scope: 'groups', groups: ['Finance'] } },
    { ...GYM, providerRules: { scope: 'selected', gymIds: ['gym_a'] } });
  const list = await s.prog.listEligibleBeneficiaries({ access: hr, programId, query: { include: 'all' } });
  assert.deepEqual(list.items.map(r => [r.beneficiary.id, r.wouldBeEligible, r.beneficiary.source]), [['cemp_1', true, 'corporate_employee'], ['cemp_2', false, 'corporate_employee']]);
  // Corporate challenges of this company are valid providers.
  const admin = await access(s, orgId);
  assert.ok((await s.prog.createBenefit({ access: admin, programId, body: { name: 'NMB challenge', benefitType: 'challenge', fundingType: 'none', providerRules: { scope: 'selected', challengeIds: ['ch_corp1'] } } })).benefit);
  assert.deepEqual(s.corporateAccounts.rows[0], { id: 'corp_1', companyName: 'NMB Bank', industrySector: 'banking', status: 'active' });
});
