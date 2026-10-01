// B2B Phase 3 against the CI database: benefit evaluation, the consumption
// ledger (limits, funding, idempotency, concurrency, reversal, budget), and
// the integrations with gym check-in, trainer bookings and Corporate.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import {
  gyms, trainers, b2bService, b2bProgramService, b2bConsumptionService as usage,
  checkInService, checkinStatusService, trainerBookingService, corporateService,
} from '../src/bootstrap/services.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [], gyms: [], trainers: [], corporates: [] };
const ADMIN = { userType: 'admin' };

async function user(userType = 'member', extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Usage ${userType} ${id.slice(-4)}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
ADMIN.userId = await user('admin');

async function gym(extra = {}) {
  const id = uid('gym');
  await gyms.insertAsync({ id, name: `Usage Gym ${id.slice(-4)}`, tier: 'standard', location: 'Dar es Salaam', status: 'active', ratePerDay: 5000, perVisitRate: 5000, ...extra });
  made.gyms.push(id);
  return gyms.find(g => g.id === id);
}

const access = (organizationId, who = ADMIN) => b2bService.resolveAccess({ organizationId, ...who });

async function sponsor(organizationType = 'insurer') {
  const { organization } = await b2bService.createOrganization({ body: { organizationType, legalName: `Usage ${organizationType} ${uid('o')}` }, actorId: ADMIN.userId });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: ADMIN.userId });
  return organization.id;
}

async function enrol(orgId, userId, extra = {}) {
  const r = await b2bService.enrollBeneficiary({ access: await access(orgId), body: { userId, status: 'active', ...extra }, actorId: ADMIN.userId });
  assert.ok(r.beneficiary, JSON.stringify(r));
  return r.beneficiary;
}

const GYM_BENEFIT = { name: '8 gym visits a month', benefitType: 'gym_access', fundingType: 'full', usageLimit: 8, usagePeriod: 'month' };

/** An active programme with one active benefit. */
async function programme(orgId, benefitBody = GYM_BENEFIT, programBody = {}) {
  const a = await access(orgId);
  const created = await b2bProgramService.createProgram({ access: a, body: { name: 'Usage programme', startDate: '2026-01-01', ...programBody }, actorId: ADMIN.userId });
  assert.ok(created.program, JSON.stringify(created));
  const programId = created.program.id;
  const benefit = await b2bProgramService.createBenefit({ access: a, programId, body: benefitBody, actorId: ADMIN.userId });
  assert.ok(benefit.benefit, JSON.stringify(benefit));
  const benefitId = benefit.benefit.id;
  await b2bProgramService.setBenefitStatus({ access: a, programId, benefitId, status: 'active', actorId: ADMIN.userId });
  await b2bProgramService.setProgramStatus({ access: a, programId, status: 'pending', actorId: ADMIN.userId });
  const live = await b2bProgramService.setProgramStatus({ access: a, programId, status: 'active', actorId: ADMIN.userId });
  assert.equal(live.program?.status, 'active', JSON.stringify(live));
  return { programId, benefitId };
}

/** One beneficiary of a new sponsor with one benefit. */
async function covered(benefitBody = GYM_BENEFIT, { orgType = 'insurer', programBody = {} } = {}) {
  const orgId = await sponsor(orgType);
  const memberId = await user('member');
  const beneficiary = await enrol(orgId, memberId);
  return { orgId, memberId, beneficiary, ...(await programme(orgId, benefitBody, programBody)) };
}

const visit = (memberId, g, extra = {}) => usage.consume({
  userId: memberId, sourceType: 'gym_checkin', sourceId: uid('chk'), provider: { type: 'gym', id: g.id, tier: g.tier }, grossTzs: 5000, ...extra,
});
const ledger = where => db('B2BBenefitConsumption').where(where).orderBy('createdAt');

after(async () => {
  if (made.orgs.length) {
    const ids = await db('B2BBenefitConsumption').whereIn('organizationId', made.orgs).pluck('id');
    await db('AuditLog').whereIn('target', ids).del();
    await db('B2BBenefitConsumption').whereIn('organizationId', made.orgs).del();
    await db('B2BOrganization').whereIn('id', made.orgs).del();
  }
  if (made.corporates.length) {
    await db('B2BBenefitConsumption').whereIn('organizationId', db('B2BOrganization').whereIn('legacyCorporateId', made.corporates).select('id')).del();
    await db('B2BOrganization').whereIn('legacyCorporateId', made.corporates).del();
    await db('CorporateEmployee').whereIn('corporateId', made.corporates).del();
    await db('CorporateAccount').whereIn('id', made.corporates).del();
  }
  await db('TrainerBooking').whereIn('memberId', made.users).del();
  await db('Checkin').whereIn('memberId', made.users).del();
  await db('Subscription').whereIn('memberId', made.users).del();
  for (const id of made.trainers) await trainers.removeAsync(t => t.id === id);
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  await db('AuditLog').whereIn('actor', made.users).del();
  await db('User').whereIn('id', made.users).del();
});

// ── Gym check-in ─────────────────────────────────────────────────────────────

test('a beneficiary checks in on the benefit: one verified consumption, sponsor pays, allowance drops', async () => {
  const g = await gym();
  const { memberId, orgId, programId, benefitId, beneficiary } = await covered();

  const result = await checkInService.perform({ memberId, gymId: g.id, method: 'member_scanned' });   // no personal pass at all
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.checkin.subscriptionType, result.checkin.visitConsumed, result.checkin.subscriptionId], ['b2b_benefit', false, null]);
  assert.deepEqual([result.b2b.grossTzs, result.b2b.sponsorTzs, result.b2b.beneficiaryTzs, result.b2b.remaining.uses], [5000, 5000, 0, 7]);

  const [row] = await ledger({ sourceType: 'gym_checkin', sourceId: result.checkin.id });
  assert.deepEqual(
    [row.status, row.organizationId, row.programId, row.benefitId, row.beneficiaryId, row.userId, row.providerType, row.providerId, row.serviceType, row.quantity],
    ['approved', orgId, programId, benefitId, beneficiary.id, memberId, 'gym', g.id, 'gym_access', 1],
  );
  assert.ok(row.verifiedAt);
  assert.equal(row.rulesSnapshot.remainingAfter.uses, 7);
  assert.equal((await db('Checkin').where({ id: result.checkin.id }).first()).status, 'valid');

  // Scanning again the same day returns the same visit; nothing more is consumed.
  const again = await checkInService.perform({ memberId, gymId: g.id, method: 'member_scanned' });
  assert.deepEqual([again.idempotent, again.checkin.id], [true, result.checkin.id]);
  assert.equal((await ledger({ benefitId })).length, 1);

  const mine = await b2bProgramService.myBenefits({ userId: memberId });
  assert.deepEqual(mine.benefits.map(b => [b.benefit.name, b.used, b.remaining]), [['8 gym visits a month', 1, 7]]);
});

test('personal usage is untouched: no benefit, an exhausted allowance or an excluded gym fall back to the member\'s pass', async () => {
  const g = await gym();
  const other = await gym();
  // Not a beneficiary and no pass: the usual refusal.
  const stranger = await user('member');
  assert.deepEqual(await checkInService.perform({ memberId: stranger, gymId: g.id }), { ok: false, failure: 'subscription_inactive' });

  const { memberId, benefitId } = await covered({ ...GYM_BENEFIT, usageLimit: 1, providerRules: { scope: 'selected', gymIds: [g.id] } });
  const now = new Date();
  await db('Subscription').insert({
    id: uid('sub'), memberId, type: 'platform_pass', tier: 'pro', status: 'active', startedAt: now, cycleStartedAt: now,
    renewsAt: new Date(+now + 30 * 86_400_000), expiresAt: new Date(+now + 30 * 86_400_000),
  });
  // A gym the benefit doesn't cover: the member's own pass is used, no ledger row.
  const elsewhere = await checkInService.perform({ memberId, gymId: other.id });
  assert.deepEqual([elsewhere.ok, elsewhere.checkin.subscriptionType, elsewhere.b2b], [true, 'platform_pass', undefined]);
  assert.equal((await ledger({ benefitId })).length, 0);

  // Allowance used up earlier this month: a new visit falls back to the pass.
  await visit(memberId, g, { at: new Date(+now - 60_000) });
  await db('Checkin').where({ memberId }).del();
  const fallback = await checkInService.perform({ memberId, gymId: g.id });
  assert.deepEqual([fallback.ok, fallback.checkin.subscriptionType, fallback.checkin.visitConsumed], [true, 'platform_pass', true]);
  const rows = await ledger({ benefitId });
  assert.deepEqual(rows.map(r => [r.status, r.rejectionReason, r.sponsorTzs]), [['approved', null, 5000], ['rejected', 'usage_limit_reached', 0]]);
});

// ── Eligibility ──────────────────────────────────────────────────────────────

test('evaluation names why a benefit does or does not apply, and writes nothing', async () => {
  const g = await gym();
  const premium = await gym({ tier: 'premium' });
  const { memberId, orgId, programId, benefitId, beneficiary } = await covered({ ...GYM_BENEFIT, providerRules: { scope: 'selected', gymTiers: ['standard'] } });
  const check = async (target = g, at) => {
    const r = await usage.evaluate({ userId: memberId, serviceType: 'gym_access', provider: { type: 'gym', id: target.id, tier: target.tier }, grossTzs: 5000, at });
    return [r.covered, r.candidates[0]?.reason ?? null];
  };
  const admin = await access(orgId);

  assert.deepEqual(await check(), [true, null]);
  assert.deepEqual(await check(premium), [false, 'provider_not_eligible']);
  assert.deepEqual(await check(g, new Date('2025-12-31T10:00:00Z')), [false, 'outside_program_dates']);

  await b2bService.setBeneficiaryStatus({ access: admin, beneficiaryId: beneficiary.id, status: 'suspended', actorId: ADMIN.userId });
  assert.deepEqual(await check(), [false, 'beneficiary_not_active']);
  await b2bService.setBeneficiaryStatus({ access: admin, beneficiaryId: beneficiary.id, status: 'active', actorId: ADMIN.userId });

  await b2bProgramService.setProgramStatus({ access: admin, programId, status: 'paused', actorId: ADMIN.userId });
  assert.deepEqual(await check(), [false, 'program_not_active']);
  assert.equal((await visit(memberId, g)).consumed, false);
  await b2bProgramService.setProgramStatus({ access: admin, programId, status: 'active', actorId: ADMIN.userId });

  // A second active benefit lets the first be switched off.
  const extra = await b2bProgramService.createBenefit({ access: admin, programId, body: { name: 'Trainer', benefitType: 'trainer_session', fundingType: 'full' } });
  await b2bProgramService.setBenefitStatus({ access: admin, programId, benefitId: extra.benefit.id, status: 'active' });
  await b2bProgramService.setBenefitStatus({ access: admin, programId, benefitId, status: 'inactive' });
  assert.deepEqual(await check(), [false, 'benefit_not_active']);

  assert.deepEqual(await usage.evaluate({ userId: await user('member'), serviceType: 'gym_access', provider: { type: 'gym', id: g.id, tier: g.tier }, grossTzs: 5000 })
    .then(r => [r.covered, r.candidates.length]), [false, 0]);
  assert.equal((await ledger({ benefitId })).length, 0);
});

// ── Usage limits ─────────────────────────────────────────────────────────────

const on = day => new Date(`${day}T09:00:00.000Z`);

test('monthly and weekly limits count calendar periods and reset with them', async () => {
  const g = await gym();
  const month = await covered({ ...GYM_BENEFIT, usageLimit: 2 });
  const outcomes = [];
  for (const day of ['2026-10-05', '2026-10-20', '2026-10-31', '2026-11-01']) {
    const r = await visit(month.memberId, g, { at: on(day) });
    outcomes.push(r.consumed ? r.remaining.uses : r.reason);
  }
  assert.deepEqual(outcomes, [1, 0, 'usage_limit_reached', 1]);   // November is a new month

  const week = await covered({ ...GYM_BENEFIT, usageLimit: 1, usagePeriod: 'week' });
  const w = [];
  for (const day of ['2026-10-05', '2026-10-11', '2026-10-12']) w.push((await visit(week.memberId, g, { at: on(day) })).consumed);   // Mon, Sun, next Mon
  assert.deepEqual(w, [true, false, true]);
});

test('a programme-lifetime limit never resets; unlimited never runs out', async () => {
  const g = await gym();
  const life = await covered({ ...GYM_BENEFIT, usageLimit: 2, usagePeriod: 'program' });
  const r = [];
  for (const day of ['2026-10-05', '2026-12-05', '2027-03-05']) r.push((await visit(life.memberId, g, { at: on(day) })).consumed);
  assert.deepEqual(r, [true, true, false]);

  const free = await covered({ ...GYM_BENEFIT, usageLimit: null, usagePeriod: 'unlimited' });
  for (let i = 0; i < 12; i += 1) {
    const v = await visit(free.memberId, g, { at: on('2026-10-05') });
    assert.deepEqual([v.consumed, v.remaining.uses], [true, null]);
  }
});

// ── Funding ──────────────────────────────────────────────────────────────────

test('sponsor and member responsibility for each funding type, in whole TZS', async () => {
  const g = await gym();
  const split = async (funding, grossTzs = 5000) => {
    const c = await covered({ ...GYM_BENEFIT, usageLimit: null, ...funding });
    const r = await visit(c.memberId, g, { grossTzs });
    assert.equal(r.consumption.sponsorTzs + r.consumption.beneficiaryTzs, grossTzs);
    return [r.consumption.sponsorTzs, r.consumption.beneficiaryTzs];
  };
  assert.deepEqual(await split({ fundingType: 'full' }), [5000, 0]);
  assert.deepEqual(await split({ fundingType: 'sponsor_fixed', sponsorAmountTzs: 3000 }), [3000, 2000]);
  assert.deepEqual(await split({ fundingType: 'sponsor_fixed', sponsorAmountTzs: 4000 }), [4000, 1000]);      // benefit covers less than the price
  assert.deepEqual(await split({ fundingType: 'sponsor_percentage', sponsorShareBps: 6000 }), [3000, 2000]);
  assert.deepEqual(await split({ fundingType: 'sponsor_percentage', sponsorShareBps: 6000, sponsorCapTzs: 2500 }), [2500, 2500]);
  assert.deepEqual(await split({ fundingType: 'beneficiary_fixed', beneficiaryAmountTzs: 2000 }), [3000, 2000]);
  assert.deepEqual(await split({ fundingType: 'sponsor_percentage', sponsorShareBps: 3333 }, 1001), [334, 667]);
});

test('a per-period sponsor cap pays what is left of it, then stops', async () => {
  const g = await gym();
  const c = await covered({ ...GYM_BENEFIT, usageLimit: null, periodSponsorCapTzs: 8000 });
  const r = [];
  for (let i = 0; i < 3; i += 1) {
    const v = await visit(c.memberId, g, { at: on('2026-10-05') });
    r.push(v.consumed ? [v.consumption.sponsorTzs, v.consumption.beneficiaryTzs] : v.reason);
  }
  assert.deepEqual(r, [[5000, 0], [3000, 2000], 'period_sponsor_cap_reached']);
});

// ── One sponsor per visit ────────────────────────────────────────────────────

test('with several sponsors one benefit is applied: least for the member, then the employer, never two', async () => {
  const g = await gym();
  const memberId = await user('member');
  const insurer = await sponsor('insurer');
  const employer = await sponsor('employer');
  await enrol(insurer, memberId);
  await enrol(employer, memberId);
  // Insurer: fully sponsored, 1 a month. Employer: 60%, 1 a month.
  const full = await programme(insurer, { ...GYM_BENEFIT, usageLimit: 1 });
  const partial = await programme(employer, { ...GYM_BENEFIT, usageLimit: 1, fundingType: 'sponsor_percentage', sponsorShareBps: 6000 });

  const first = await visit(memberId, g, { at: on('2026-10-05') });
  assert.deepEqual([first.consumption.benefitId, first.consumption.beneficiaryTzs], [full.benefitId, 0]);      // cheapest for the member
  assert.deepEqual(first.consumption.rulesSnapshot.alternatives, [partial.benefitId]);
  const second = await visit(memberId, g, { at: on('2026-10-06') });
  assert.deepEqual([second.consumption.benefitId, second.consumption.sponsorTzs], [partial.benefitId, 3000]);   // the other sponsor, alone
  assert.equal((await visit(memberId, g, { at: on('2026-10-07') })).consumed, false);
  for (const r of await ledger({ userId: memberId, status: 'approved' })) {
    assert.equal((await ledger({ sourceType: r.sourceType, sourceId: r.sourceId, status: 'approved' })).length, 1);
  }

  // Equal cost to the member: the employer's benefit is used.
  const tied = await user('member');
  const ins2 = await sponsor('insurer');
  const emp2 = await sponsor('employer');
  await enrol(ins2, tied);
  await enrol(emp2, tied);
  await programme(ins2, GYM_BENEFIT);
  const employerBenefit = await programme(emp2, GYM_BENEFIT);
  assert.equal((await visit(tied, g)).consumption.benefitId, employerBenefit.benefitId);
});

// ── Idempotency and concurrency ──────────────────────────────────────────────

test('the same usage event consumes once, however often and however concurrently it is submitted', async () => {
  const g = await gym();
  const c = await covered();
  const sourceId = uid('chk');
  const once = await visit(c.memberId, g, { sourceId });
  const twice = await visit(c.memberId, g, { sourceId });
  assert.deepEqual([twice.consumed, twice.idempotent, twice.consumption.id], [true, true, once.consumption.id]);

  const burst = uid('chk');
  const results = await Promise.all(Array.from({ length: 6 }, () => visit(c.memberId, g, { sourceId: burst })));
  assert.equal(new Set(results.map(r => r.consumption.id)).size, 1);
  assert.equal((await ledger({ benefitId: c.benefitId })).length, 2);
  // The database refuses a second live row for one event even if code tried.
  const [row] = await ledger({ sourceId: burst });
  const { createdAt, updatedAt, ...copy } = row;
  await assert.rejects(db('B2BBenefitConsumption').insert({ ...copy, id: uid('b2bc'), rulesSnapshot: null, metadata: null }), err => err.code === '23505');
});

test('two simultaneous visits cannot both take the last allowance', async () => {
  const g = await gym();
  const other = await gym();
  const c = await covered({ ...GYM_BENEFIT, usageLimit: 1 });
  const results = await Promise.all([visit(c.memberId, g), visit(c.memberId, other), visit(c.memberId, g), visit(c.memberId, other)]);
  assert.deepEqual(results.map(r => r.consumed).sort(), [false, false, false, true]);
  assert.equal((await ledger({ benefitId: c.benefitId, status: 'approved' })).length, 1);
});

// ── Reversal ─────────────────────────────────────────────────────────────────

test('reversal keeps the row, restores the allowance and is audited; recorded amounts cannot be edited', async () => {
  const g = await gym();
  const c = await covered({ ...GYM_BENEFIT, usageLimit: 1 });
  const first = await visit(c.memberId, g);
  assert.equal((await visit(c.memberId, g)).consumed, false);

  assert.equal((await usage.reverse({ consumptionId: first.consumption.id, reason: '  ', actorId: ADMIN.userId })).error, 'reason_required');
  const reversed = await usage.reverse({ consumptionId: first.consumption.id, reason: 'Wrong gym', actorId: ADMIN.userId });
  assert.deepEqual([reversed.consumption.status, reversed.consumption.reversedBy, reversed.consumption.reversalReason, reversed.consumption.sponsorTzs],
    ['reversed', ADMIN.userId, 'Wrong gym', 5000]);
  assert.equal((await usage.reverse({ consumptionId: first.consumption.id, reason: 'again', actorId: ADMIN.userId })).unchanged, true);
  assert.ok(await db('AuditLog').where({ action: 'b2b.consumption.reverse', target: first.consumption.id }).first());

  assert.equal((await visit(c.memberId, g)).consumed, true);   // allowance is back
  assert.deepEqual((await ledger({ benefitId: c.benefitId })).map(r => r.status).sort(), ['approved', 'rejected', 'reversed']);

  await assert.rejects(db('B2BBenefitConsumption').where({ id: first.consumption.id }).update({ sponsorTzs: 1, beneficiaryTzs: 4999 }), /immutable/);
  await assert.rejects(db('B2BBenefitConsumption').where({ id: first.consumption.id }).update({ status: 'approved', reversedAt: null, reversedBy: null, reversalReason: null }), /not allowed/);
});

test('voiding a check-in gives the benefit back', async () => {
  const g = await gym();
  const c = await covered({ ...GYM_BENEFIT, usageLimit: 1 });
  const { checkin } = await checkInService.perform({ memberId: c.memberId, gymId: g.id });
  const voided = await checkinStatusService.setStatus({ checkinId: checkin.id, status: 'voided', reason: 'Scanned by mistake', actorId: ADMIN.userId });
  assert.equal(voided.checkin.status, 'voided');
  const [row] = await ledger({ sourceId: checkin.id });
  assert.deepEqual([row.status, row.reversedBy], ['reversed', ADMIN.userId]);
  assert.match(row.reversalReason, /Scanned by mistake/);
  assert.equal((await visit(c.memberId, g)).consumed, true);
});

// ── Budget ───────────────────────────────────────────────────────────────────

test('when the budget runs out the programme pauses; only FitFlex resumes it, with a remark and budget to spend', async () => {
  const g = await gym();
  const c = await covered({ ...GYM_BENEFIT, usageLimit: null }, { programBody: { budgetTzs: 5000 } });
  const ownerId = await user('member');
  await b2bService.addOrganizationUser({ access: await access(c.orgId), body: { userId: ownerId, role: 'owner' }, actorId: ADMIN.userId });

  assert.equal((await visit(c.memberId, g)).consumed, true);
  const over = await visit(c.memberId, g);
  assert.deepEqual([over.consumed, over.reason], [false, 'program_budget_exhausted']);
  const paused = await db('B2BWellnessProgram').where({ id: c.programId }).first();
  assert.deepEqual([paused.status, paused.statusReason], ['paused', 'budget_exhausted']);
  assert.equal((await visit(c.memberId, g)).consumed, false);

  const owner = await access(c.orgId, { userId: ownerId, userType: 'member' });
  const admin = await access(c.orgId);
  const resume = (who, reason) => b2bProgramService.setProgramStatus({ access: who, programId: c.programId, status: 'active', reason, actorId: 'x' });
  assert.deepEqual([(await resume(owner, 'please')).status, (await resume(owner, 'please')).pausedFor], [403, 'budget_exhausted']);
  assert.equal((await resume(admin)).error, 'remark_required');
  assert.deepEqual([(await resume(admin, 'Top-up agreed')).error, (await resume(admin, 'Top-up agreed')).spentTzs], ['budget_still_exhausted', 5000]);
  // The whole 5,000 is spent: raise the budget, then resume.
  await b2bProgramService.updateProgram({ access: admin, programId: c.programId, body: { budgetTzs: 20000 }, actorId: ADMIN.userId });
  const resumed = await resume(admin, 'Top-up agreed with the sponsor');
  assert.deepEqual([resumed.program.status, resumed.program.statusReason], ['active', 'Top-up agreed with the sponsor']);
  assert.equal((await visit(c.memberId, g)).consumed, true);

  const report = await usage.programUsage({ access: owner, programId: c.programId });
  assert.deepEqual(report.budget, { budgetTzs: 20000, spentTzs: 10000, remainingTzs: 10000 });
});

// ── Trainer sessions ─────────────────────────────────────────────────────────

test('a trainer benefit is consumed when the session is completed, not when it is booked', async () => {
  const g = await gym();
  const trainerUser = await user('trainer');
  const trainerId = uid('trn');
  await trainers.insertAsync({ id: trainerId, userId: trainerUser, displayName: 'Usage Trainer', status: 'active', approvalStatus: 'approved', gymIds: [g.id], hourlyRateTzs: 30000 });
  made.trainers.push(trainerId);
  const c = await covered({ name: '2 trainer sessions a month at 50%', benefitType: 'trainer_session', fundingType: 'sponsor_percentage', sponsorShareBps: 5000, usageLimit: 2, usagePeriod: 'month', providerRules: { scope: 'selected', trainerIds: [trainerId] } });

  const booking = async (status = 'confirmed') => {
    const id = uid('tb');
    await db('TrainerBooking').insert({ id, memberId: c.memberId, trainerId, gymId: g.id, date: '2026-10-05', slot: '09:00', listPriceTzs: 30000, amountTzs: 30000, status });
    return id;
  };
  const b1 = await booking();
  assert.equal((await ledger({ sourceId: b1 })).length, 0);          // booked and paid: nothing consumed yet

  const done = await trainerBookingService.trainerCompleteBooking({ userId: trainerUser, bookingId: b1 });
  assert.equal(done.booking.status, 'completed');
  const [row] = await ledger({ sourceType: 'trainer_booking', sourceId: b1 });
  assert.deepEqual([row.status, row.providerType, row.providerId, row.grossTzs, row.sponsorTzs, row.beneficiaryTzs, row.metadata.memberPaidTzs],
    ['approved', 'trainer', trainerId, 30000, 15000, 15000, 30000]);

  // Completed by an admin instead; then un-completed, which gives the benefit back.
  const b2 = await booking();
  await trainerBookingService.adminUpdateStatus({ id: b2, status: 'completed', actorId: ADMIN.userId });
  assert.equal((await ledger({ sourceId: b2 }))[0].status, 'approved');
  await trainerBookingService.adminUpdateStatus({ id: b2, status: 'cancelled', actorId: ADMIN.userId });
  assert.equal((await ledger({ sourceId: b2 }))[0].status, 'reversed');
  // Another trainer isn't covered; the booking still completes normally.
  const otherTrainer = uid('trn');
  await trainers.insertAsync({ id: otherTrainer, userId: await user('trainer'), displayName: 'Other Trainer', status: 'active', gymIds: [g.id] });
  made.trainers.push(otherTrainer);
  const b3 = uid('tb');
  await db('TrainerBooking').insert({ id: b3, memberId: c.memberId, trainerId: otherTrainer, gymId: g.id, date: '2026-10-06', slot: '09:00', amountTzs: 30000, status: 'confirmed' });
  assert.equal((await trainerBookingService.adminUpdateStatus({ id: b3, status: 'completed', actorId: ADMIN.userId })).booking.status, 'completed');
  assert.equal((await ledger({ sourceId: b3 })).length, 0);
});

// ── Corporate ────────────────────────────────────────────────────────────────

test('a company employee uses the company programme once linked to their member account', async () => {
  const g = await gym();
  const settings = { companyName: `Usage Corp ${uid('c')}`, industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'copay_70_30', passTier: 'pro', seatLimit: 5 };
  const { account } = await corporateService.onboard({ body: settings, actorId: ADMIN.userId });
  made.corporates.push(account.id);
  await corporateService.setStatus({ corporateId: account.id, status: 'active', actorId: ADMIN.userId });
  const { employee } = await corporateService.provisionStaff({ corporateId: account.id, body: { displayName: 'Usage Employee', department: 'Finance' }, actorId: ADMIN.userId });
  await corporateService.setEmployeeStatus({ corporateId: account.id, employeeId: employee.id, status: 'active', actorId: ADMIN.userId });
  const orgId = (await b2bService.organizationForCorporate({ corporateId: account.id })).organization.id;
  const { benefitId } = await programme(orgId, { ...GYM_BENEFIT, fundingType: 'sponsor_percentage', sponsorShareBps: 7000 }, { eligibility: { scope: 'groups', groups: ['Finance'] } });

  const memberId = await user('member');
  assert.deepEqual(await checkInService.perform({ memberId, gymId: g.id }), { ok: false, failure: 'subscription_inactive' });   // not linked yet

  assert.equal((await corporateService.linkEmployeeUser({ corporateId: account.id, employeeId: employee.id, userId: await user('trainer'), actorId: ADMIN.userId })).error, 'user_must_be_member');
  assert.equal((await corporateService.linkEmployeeUser({ corporateId: 'corp_other', employeeId: employee.id, userId: memberId })).status, 404);
  const linked = await corporateService.linkEmployeeUser({ corporateId: account.id, employeeId: employee.id, userId: memberId, actorId: ADMIN.userId });
  assert.deepEqual([linked.employee.userId, linked.employee.pinHash], [memberId, undefined]);

  const result = await checkInService.perform({ memberId, gymId: g.id });
  assert.deepEqual([result.ok, result.b2b.sponsorTzs, result.b2b.beneficiaryTzs], [true, 3500, 1500]);
  const [row] = await ledger({ benefitId });
  assert.deepEqual([row.beneficiaryId, row.beneficiarySource, row.organizationId], [employee.id, 'corporate_employee', orgId]);
  // Corporate's own numbers are untouched by the visit.
  const after = await db('CorporateAccount').where({ id: account.id }).first();
  assert.deepEqual([after.seatsUsed, after.status], [1, 'active']);
});

// ── Reporting and isolation ──────────────────────────────────────────────────

test('organisations see their own usage as aggregates; another organisation sees nothing', async () => {
  const g = await gym();
  const a = await covered({ ...GYM_BENEFIT, fundingType: 'sponsor_fixed', sponsorAmountTzs: 3000 });
  const b = await covered();
  await visit(a.memberId, g, { at: on('2026-10-05') });
  await visit(a.memberId, g, { at: on('2026-10-06') });
  await visit(b.memberId, g, { at: on('2026-10-05') });
  const analystId = await user('member');
  const viewerId = await user('member');
  await b2bService.addOrganizationUser({ access: await access(a.orgId), body: { userId: analystId, role: 'analyst' } });
  await b2bService.addOrganizationUser({ access: await access(a.orgId), body: { userId: viewerId, role: 'viewer' } });
  const analyst = await access(a.orgId, { userId: analystId, userType: 'member' });

  const report = await usage.programUsage({ access: analyst, programId: a.programId });
  assert.deepEqual(report.totals, { uses: 2, grossTzs: 10000, sponsorTzs: 6000, beneficiaryTzs: 4000 });
  assert.deepEqual(report.byBenefit.map(r => [r.benefitId, r.uses, r.sponsorTzs]), [[a.benefitId, 2, 6000]]);
  assert.deepEqual(report.byProvider.map(r => [r.providerId, r.providerName, r.uses]), [[g.id, g.name, 2]]);
  assert.deepEqual(report.byBeneficiary.map(r => [r.beneficiaryId, r.uses, r.beneficiaryTzs]), [[a.beneficiary.id, 2, 4000]]);
  assert.deepEqual(report.byStatus, { approved: 2 });
  // Aggregates only: no individual events, dates or check-in ids.
  assert.equal(JSON.stringify(report).includes('gym_checkin'), false);
  assert.equal((await usage.programUsage({ access: analyst, programId: a.programId, query: { from: '2026-10-06' } })).totals.uses, 1);

  assert.equal((await usage.programUsage({ access: await access(a.orgId, { userId: viewerId, userType: 'member' }), programId: a.programId })).requiredPermission, 'usage.read');
  assert.equal((await usage.programUsage({ access: analyst, programId: b.programId })).status, 404);   // B's programme
  assert.equal((await access(b.orgId, { userId: analystId, userType: 'member' })).status, 404);

  // FitFlex sees every row, filterable, with the source event and the settlement candidate.
  const list = await usage.adminList({ query: { organizationId: a.orgId, status: 'approved' } });
  assert.deepEqual([list.total, list.totals.sponsorTzs, list.items[0].providerName, list.items[0].organizationName != null], [2, 6000, g.name, true]);
  assert.equal((await usage.adminList({ query: { providerId: g.id, userId: b.memberId } })).total, 1);
  assert.equal((await usage.adminList({ query: { benefitId: a.benefitId, from: '2026-10-06', to: '2026-10-06' } })).total, 1);
  const detail = await usage.adminGet({ consumptionId: list.items[0].id });
  assert.deepEqual(Object.keys(detail.settlementCandidate).filter(k => /payout|commission/i.test(k)), []);   // no payout figures
  assert.deepEqual([detail.settlementCandidate.settleable, detail.settlementCandidate.sponsorTzs, detail.settlementCandidate.currency], [true, 3000, 'TZS']);
});
