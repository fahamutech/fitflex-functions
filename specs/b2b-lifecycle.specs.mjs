// B2B Phase 7, slice 3 against the CI database: notices to members about
// their benefits and allowances, notices to organisations about programmes
// ending, and preparing a programme's renewal.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { purgeB2BBilling } from './fixtures/ledger-cleanup.mjs';
import { gyms, b2bService, b2bProgramService, b2bConsumptionService as usage, signJwt as sign } from '../src/bootstrap/services.mjs';
import { b2bPrograms, b2bBenefits } from '../src/bootstrap/collections.mjs';
import { createB2BLifecycleService, followingPeriod, NOTICE } from '../src/services/b2b-lifecycle-service.mjs';
import { createOpsService } from '../src/services/ops-service.mjs';
import { registerB2BJobs } from '../src/services/b2b-jobs.mjs';
import { localDay, addDays } from '../src/shared/member-progress.mjs';
import { getB2BProgramLifecycle, prepareB2BProgramRenewal } from '../functions/b2b.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [], gyms: [] };
const TODAY = localDay(new Date());

async function user(userType = 'member', name = null) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: name ?? `Lifecycle ${id.slice(-4)}`, updatedAt: new Date() });
  made.users.push(id);
  return id;
}
const OPERATOR = await user('admin');
const ADMIN = { userType: 'admin', userId: OPERATOR };
const access = (organizationId, who = ADMIN) => b2bService.resolveAccess({ organizationId, ...who });
async function sponsor(name, email = null) {
  const { organization } = await b2bService.createOrganization({ body: { organizationType: 'employer', legalName: `Lifecycle ${name} ${uid('o')}`, tradingName: name, ...(email ? { email } : {}) }, actorId: OPERATOR });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: OPERATOR });
  return organization.id;
}
async function enrol(orgId, groupName = null, { link = true, status = 'active' } = {}) {
  const userId = await user();
  const r = await b2bService.enrollBeneficiary({ access: await access(orgId), body: { userId, status, groupName }, actorId: OPERATOR });
  assert.ok(r.beneficiary, JSON.stringify(r));
  if (!link) await db('B2BBeneficiary').where({ id: r.beneficiary.id }).update({ userId: null });
  return { userId, id: r.beneficiary.id };
}
async function orgUser(orgId, role) {
  const sub = await user();
  const out = await b2bService.addOrganizationUser({ access: await access(orgId), body: { userId: sub, role }, actorId: OPERATOR });
  assert.ok(!out.error, JSON.stringify(out));
  return { sub, userType: 'member' };
}
async function programme(orgId, body, benefitBodies = []) {
  const a = await access(orgId);
  const created = await b2bProgramService.createProgram({ access: a, body: { name: 'Staff Wellness', startDate: addDays(TODAY, -60), ...body }, actorId: OPERATOR });
  assert.ok(created.program, JSON.stringify(created));
  const ids = [];
  for (const b of benefitBodies) {
    const out = await b2bProgramService.createBenefit({ access: a, programId: created.program.id, body: b, actorId: OPERATOR });
    assert.ok(out.benefit, JSON.stringify(out));
    await b2bProgramService.setBenefitStatus({ access: a, programId: created.program.id, benefitId: out.benefit.id, status: 'active', actorId: OPERATOR });
    ids.push(out.benefit.id);
  }
  await b2bProgramService.setProgramStatus({ access: a, programId: created.program.id, status: 'pending', actorId: OPERATOR });
  await b2bProgramService.setProgramStatus({ access: a, programId: created.program.id, status: 'active', actorId: OPERATOR });
  return { programId: created.program.id, benefitIds: ids };
}
const VISITS = { name: 'Gym visits', benefitType: 'gym_access', fundingType: 'full', usagePeriod: 'unlimited' };

/** The lifecycle service on a day of its own (or at an exact instant), with what it sent kept. */
function onDay(day = TODAY, { email = true, at = null } = {}) {
  const sent = { inbox: [], email: [] };
  const svc = createB2BLifecycleService({
    db, b2bService, programs: b2bPrograms, benefits: b2bBenefits, b2bProgramService, usage, now: () => new Date(at ?? `${day}T06:00:00.000Z`),
    notify: async (userId, m) => { sent.inbox.push({ userId, ...m }); await db('Notification').insert({ id: m.id, userId, type: m.type, title: m.title, body: m.body, data: JSON.stringify(m.data ?? {}), createdAt: new Date() }); },
    emailSender: () => (email ? { configured: true, send: async (to, m) => { sent.email.push({ to, ...m }); return { ok: true }; } } : { configured: false }),
  });
  return { svc, sent };
}
const to = (sent, ids) => sent.inbox.filter(m => ids.includes(m.userId));

function res() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
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
  await db('Notification').whereIn('userId', made.users).del().catch(() => {});
  await db('AuditLog').where({ action: 'b2b.program.notice_emailed' }).whereIn(db.raw(`"after"::jsonb->>'organizationId'`), made.orgs).del().catch(() => {});
  await db('JobRun').whereIn('triggeredBy', made.users).del();
  await purgeB2BBilling(db, made.orgs);
  if (made.orgs.length) {
    await db('B2BBeneficiary').whereIn('organizationId', made.orgs).del();
    await db('B2BOrganizationUser').whereIn('organizationId', made.orgs).del().catch(() => {});
    const programIds = await db('B2BWellnessProgram').whereIn('organizationId', made.orgs).pluck('id');
    await db('AuditLog').whereIn('target', programIds).del();
    await db('B2BBenefit').whereIn('programId', programIds).del();
    await db('B2BWellnessProgram').whereIn('organizationId', made.orgs).whereNotNull('renewedFromProgramId').del();
    await db('B2BWellnessProgram').whereIn('organizationId', made.orgs).del();
    await db('B2BOrganization').whereIn('id', made.orgs).del();
  }
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  await db('AuditLog').whereIn('actor', made.users).del();
  await db('User').whereIn('id', made.users).del();
});

// ── Rules ────────────────────────────────────────────────────────────────────

test('rules: the period that follows a programme, and when notices go out', () => {
  assert.deepEqual(followingPeriod('2026-01-01', '2026-12-31'), { startDate: '2027-01-01', endDate: '2027-12-31' });   // a calendar year
  assert.deepEqual(followingPeriod('2026-10-01', '2026-12-31'), { startDate: '2027-01-01', endDate: '2027-03-31' });   // a quarter
  assert.deepEqual(followingPeriod('2027-01-01', '2027-01-31'), { startDate: '2027-02-01', endDate: '2027-02-28' });   // a month, into a shorter one
  assert.deepEqual(followingPeriod('2028-01-01', '2028-01-31'), { startDate: '2028-02-01', endDate: '2028-02-29' });   // …in a leap year
  assert.deepEqual(followingPeriod('2026-03-15', '2026-06-14'), { startDate: '2026-06-15', endDate: '2026-09-14' });   // not month-aligned: the same number of days
  assert.deepEqual(followingPeriod('2026-11-10', '2026-11-10'), { startDate: '2026-11-11', endDate: '2026-11-11' });
  assert.deepEqual([NOTICE.benefitStartsWithinDays, NOTICE.benefitEndsWithinDays, [...NOTICE.programEndsWithinDays], NOTICE.allowanceWarnPct], [1, 7, [30, 7], 80]);
});

// ── Members ──────────────────────────────────────────────────────────────────

test('members: a benefit ending or starting is told once, to the people it is for, grouped into one notice', async () => {
  const orgId = await sponsor('Kili Co');
  const [gold1, gold2, silver] = [await enrol(orgId, 'Gold'), await enrol(orgId, 'Gold'), await enrol(orgId, 'Silver')];
  const suspended = await enrol(orgId, 'Gold');
  await b2bService.setBeneficiaryStatus({ access: await access(orgId), beneficiaryId: suspended.id, status: 'suspended', actorId: OPERATOR });
  await enrol(orgId, 'Gold', { link: false });
  const stranger = await enrol(await sponsor('Other Co'), 'Gold');
  const end = addDays(TODAY, 5);
  await programme(orgId, { endDate: end }, [
    VISITS,
    { ...VISITS, name: 'Trainer sessions', benefitType: 'trainer_session', eligibility: { groups: ['Gold'] } },
    { ...VISITS, name: 'Yoga class', startDate: addDays(TODAY, 1) },
  ]);
  const everyone = [gold1.userId, gold2.userId, silver.userId, suspended.userId, stranger.userId];

  const h = onDay();
  const first = await h.svc.benefitNotices();
  assert.equal(first.failed, 0);
  const mine = to(h.sent, everyone);
  const got = id => mine.filter(m => m.userId === id).map(m => [m.type, m.body]).sort();
  assert.deepEqual(got(gold1.userId), [
    ['b2b_benefit_ending', `Gym visits and Trainer sessions from Kili Co end in 5 days (${end}). Use them before then.`],
    ['b2b_benefit_starting', 'Yoga class from Kili Co starts tomorrow.'],
  ]);
  assert.deepEqual(got(silver.userId), [
    ['b2b_benefit_ending', `Gym visits from Kili Co ends in 5 days (${end}). Use it before then.`],
    ['b2b_benefit_starting', 'Yoga class from Kili Co starts tomorrow.'],
  ]);
  assert.deepEqual([got(gold2.userId).length, got(suspended.userId), got(stranger.userId)], [2, [], []]);
  // Run again, the same day and the next: nothing is repeated.
  await h.svc.benefitNotices();
  const next = onDay(addDays(TODAY, 1));
  await next.svc.benefitNotices();
  assert.deepEqual([to(h.sent, everyone).length, to(next.sent, everyone).length], [6, 0]);
  // A benefit still weeks from its end says nothing.
  const quietOrg = await sponsor('Quiet Co');
  const q = await enrol(quietOrg);
  await programme(quietOrg, { endDate: addDays(TODAY, 20) }, [VISITS]);
  const again = onDay();
  await again.svc.benefitNotices();
  assert.equal(to(again.sent, [q.userId]).length, 0);
});

test('members: a benefit that has ended is told once, even if the job missed the day, but not weeks later', async () => {
  const orgId = await sponsor('Ended Co');
  const m = await enrol(orgId);
  const end = addDays(TODAY, 2);
  await programme(orgId, { endDate: end }, [VISITS]);
  // The job did not run on the day after the end; it runs two days after.
  const late = onDay(addDays(end, 2));
  await late.svc.benefitNotices();
  assert.deepEqual(to(late.sent, [m.userId]).map(x => [x.type, x.title, x.body]), [['b2b_benefit_ended', 'A benefit has ended', `Gym visits from Ended Co ended on ${end}.`]]);
  const later = onDay(addDays(end, 3));
  await later.svc.benefitNotices();
  assert.equal(to(later.sent, [m.userId]).length, 0);
  // Never having run until much later, it stays silent rather than announce old news.
  const org2 = await sponsor('Old Co');
  const m2 = await enrol(org2);
  await programme(org2, { endDate: end }, [VISITS]);
  const stale = onDay(addDays(end, 10));
  await stale.svc.benefitNotices();
  assert.equal(to(stale.sent, [m2.userId]).length, 0);
});

test('members: an allowance nearly used and used up are each told once per window', async () => {
  const g = uid('gym');
  await gyms.insertAsync({ id: g, name: 'Lifecycle Gym', tier: 'standard', location: 'Dar es Salaam', status: 'active', ratePerDay: 5000 });
  made.gyms.push(g);
  // One clock for the visits and the job: the database's. The job looks at
  // usage the database stamped (updatedAt) in the 45 minutes before its own
  // "now", so a "now" of 06:00Z on the Dar day missed the visits whenever the
  // run was after 21:00Z (the Dar day is already tomorrow) or before 06:45Z.
  const { rows: [{ at }] } = await db.raw('SELECT now() AS at');
  const day = localDay(at);
  const orgId = await sponsor('Allowance Co');
  const five = await enrol(orgId, 'Five');
  const two = await enrol(orgId, 'Two');
  await programme(orgId, { startDate: addDays(day, -60) }, [
    { ...VISITS, name: 'Five visits', usagePeriod: 'month', usageLimit: 5, eligibility: { groups: ['Five'] } },
    { ...VISITS, name: 'Two visits', usagePeriod: 'month', usageLimit: 2, eligibility: { groups: ['Two'] } },
  ]);
  const visit = userId => usage.consume({ userId, sourceType: 'gym_checkin', sourceId: uid('chk'), provider: { type: 'gym', id: g, tier: 'standard' }, grossTzs: 5000, at });
  const h = onDay(day, { at });
  const mine = id => to(h.sent, [id]).map(m => [m.type, m.body]);

  for (let i = 0; i < 3; i += 1) assert.equal((await visit(five.userId)).consumed, true);
  await h.svc.allowanceNotices();
  assert.deepEqual(mine(five.userId), []);                                             // 3 of 5 is 60%
  await visit(five.userId);
  await h.svc.allowanceNotices();
  await h.svc.allowanceNotices();
  assert.deepEqual(mine(five.userId), [['b2b_allowance_nearly_used', 'You have used 4 of 5 of Five visits from Allowance Co. 1 left.']]);
  await visit(five.userId);
  await h.svc.allowanceNotices();
  await h.svc.allowanceNotices();
  assert.deepEqual(mine(five.userId).map(x => x[0]), ['b2b_allowance_nearly_used', 'b2b_allowance_used_up']);
  assert.match(mine(five.userId)[1][1], /^You have used all 5 of Five visits from Allowance Co\. It renews after \d{4}-\d{2}-\d{2}\.$/);
  assert.equal((await visit(five.userId)).consumed, false);                              // refused: nothing more to say
  await h.svc.allowanceNotices();
  assert.equal(mine(five.userId).length, 2);

  // A small allowance goes straight to "used up": one of two is not "nearly".
  await visit(two.userId);
  await h.svc.allowanceNotices();
  assert.deepEqual(mine(two.userId), []);
  await visit(two.userId);
  await h.svc.allowanceNotices();
  assert.deepEqual(mine(two.userId).map(x => x[0]), ['b2b_allowance_used_up']);
  // Usage from long ago is not looked at again.
  assert.deepEqual(await onDay(addDays(day, 2)).svc.allowanceNotices(), { due: 0, sent: 0, failed: 0 });
});

// ── Organisations ────────────────────────────────────────────────────────────

test('organisations: a programme ending is told at 30 days and at 7, and when it has ended, in the app and by email, once each', async () => {
  const mailbox = `office-${uid('m')}@lifecycle.test`;
  const orgId = await sponsor('Ending Co', mailbox);
  const owner = await orgUser(orgId, 'owner');
  const manager = await orgUser(orgId, 'manager');
  const hr = await orgUser(orgId, 'hr');
  const end = addDays(TODAY, 25);
  const { programId } = await programme(orgId, { endDate: end }, [VISITS]);
  const staff = [owner.sub, manager.sub, hr.sub];
  const emails = sent => sent.email.filter(e => e.to === mailbox);

  const d25 = onDay();
  await d25.svc.programNotices();
  assert.deepEqual(to(d25.sent, staff).map(m => [m.userId, m.type]).sort(), [[manager.sub, 'b2b_program_ending'], [owner.sub, 'b2b_program_ending']].sort());   // not HR
  assert.equal(to(d25.sent, [owner.sub])[0].body, `Staff Wellness ends in 25 days (${end}). To carry on without a gap, prepare its renewal under Programmes.`);
  assert.deepEqual(emails(d25.sent).map(e => e.subject), ['Programme ending: Staff Wellness']);
  await d25.svc.programNotices();
  assert.deepEqual([to(d25.sent, staff).length, emails(d25.sent).length], [2, 1]);
  const d20 = onDay(addDays(TODAY, 5));
  await d20.svc.programNotices();
  assert.deepEqual([to(d20.sent, staff).length, emails(d20.sent).length], [0, 0]);         // between the two stages

  // A renewal prepared in the meantime changes what the next notice says.
  const renewal = await d25.svc.prepareRenewal({ access: await access(orgId), programId, actorId: OPERATOR });
  assert.ok(renewal.program, JSON.stringify(renewal));
  const d5 = onDay(addDays(TODAY, 20));
  await d5.svc.programNotices();
  assert.deepEqual([to(d5.sent, staff).length, emails(d5.sent).length], [2, 1]);
  assert.equal(to(d5.sent, [owner.sub])[0].body, `Staff Wellness ends in 5 days (${end}). A renewal has been prepared and is with FitFlex to review.`);
  const after1 = onDay(addDays(end, 1));
  await after1.svc.programNotices();
  await after1.svc.programNotices();
  assert.deepEqual(to(after1.sent, staff).map(m => m.type), ['b2b_program_ended', 'b2b_program_ended']);
  assert.match(to(after1.sent, [owner.sub])[0].body, /ended on .* Its benefits can no longer be used\. A renewal has been prepared/);
  assert.equal(emails(after1.sent).length, 1);

  // With no email sender the in-app notices still go.
  const org2 = await sponsor('NoMail Co', `x-${uid('m')}@lifecycle.test`);
  const o2 = await orgUser(org2, 'owner');
  await programme(org2, { endDate: addDays(TODAY, 6) }, [VISITS]);
  const off = onDay(TODAY, { email: false });
  const out = await off.svc.programNotices();
  assert.deepEqual([to(off.sent, [o2.sub]).map(m => m.type), out.emailed], [['b2b_program_ending'], 0]);
});

// ── Renewal ──────────────────────────────────────────────────────────────────

test('renewal: a draft for the next period with the same benefits and people; once; nothing in force until it is submitted and activated', async () => {
  const g = uid('gym');
  await gyms.insertAsync({ id: g, name: 'Renewal Gym', tier: 'standard', location: 'Dar es Salaam', status: 'active', ratePerDay: 5000 });
  made.gyms.push(g);
  const orgId = await sponsor('Renew Co');
  const a = await access(orgId);
  const start = `${TODAY.slice(0, 4)}-01-01`;
  const end = `${TODAY.slice(0, 4)}-12-31`;
  const { programId, benefitIds } = await programme(orgId, { startDate: start, endDate: end, budgetTzs: 5000000, eligibility: { scope: 'groups', groups: ['Gold'] }, description: 'For head office' }, [
    { ...VISITS, usagePeriod: 'month', usageLimit: 8, providerRules: { scope: 'selected', gymIds: [g] }, terms: 'One visit a day' },
    { name: 'Second half sessions', benefitType: 'trainer_session', fundingType: 'full', usagePeriod: 'unlimited', startDate: `${TODAY.slice(0, 4)}-07-01`, eligibility: { groups: ['Gold'] } },
    { name: 'Pro pass', benefitType: 'sponsored_pass', passTier: 'pro', fundingType: 'sponsor_percentage', sponsorShareBps: 6000 },
  ]);
  await b2bProgramService.updateProgram({ access: a, programId, body: { discountBps: 1000 }, actorId: OPERATOR });
  const svc = onDay().svc;

  // An organisation's own user prepares it: the discount FitFlex gave is not theirs to renew.
  const owner = await orgUser(orgId, 'owner');
  const ownerAccess = await access(orgId, { userType: 'member', userId: owner.sub });
  const out = await svc.prepareRenewal({ access: ownerAccess, programId, actorId: owner.sub });
  const next = Number(TODAY.slice(0, 4)) + 1;
  assert.deepEqual([out.program.status, out.program.startDate, out.program.endDate, out.program.name, out.program.budgetTzs, out.program.description, out.program.renewedFromProgramId, out.discountNotCarriedOver, out.skipped],
    ['draft', `${next}-01-01`, `${next}-12-31`, 'Staff Wellness', 5000000, 'For head office', programId, true, []]);
  assert.deepEqual([out.program.eligibility.scope, out.program.eligibility.groups, out.program.discountBps ?? 0], ['groups', ['Gold'], 0]);
  assert.deepEqual(out.benefits.map(b => [b.name, b.status, b.benefitType, b.usageLimit, b.usagePeriod, b.startDate, b.passTier, b.sponsorShareBps, b.terms ?? null]), [
    ['Gym visits', 'draft', 'gym_access', 8, 'month', null, null, null, 'One visit a day'],
    ['Second half sessions', 'draft', 'trainer_session', null, 'unlimited', `${next}-07-01`, null, null, null],
    ['Pro pass', 'draft', 'sponsored_pass', null, 'unlimited', null, 'pro', 6000, null],
  ]);
  assert.deepEqual([out.benefits[0].providerRules.gymIds, out.benefits[1].eligibility.groups], [[g], ['Gold']]);
  // The original is untouched and still running.
  const original = await b2bPrograms.findByIdAsync(programId);
  assert.deepEqual([original.status, original.endDate, original.discountBps, (await b2bBenefits.filterByColumnAsync('programId', programId)).map(b => b.status)], ['active', end, 1000, ['active', 'active', 'active']]);
  assert.deepEqual(benefitIds.length, 3);

  // Asked again, and five times at once: the same draft.
  const again = await svc.prepareRenewal({ access: ownerAccess, programId, actorId: owner.sub });
  assert.deepEqual([again.existing, again.program.id], [true, out.program.id]);
  const many = await Promise.all(Array.from({ length: 5 }, () => svc.prepareRenewal({ access: a, programId, actorId: OPERATOR })));
  assert.deepEqual([new Set(many.map(r => r.program.id)).size, (await db('B2BWellnessProgram').where({ renewedFromProgramId: programId })).length], [1, 1]);
  assert.equal((await db('AuditLog').where({ action: 'b2b.program.renewal_prepared', target: out.program.id })).length, 1);

  const life = await svc.programLifecycle({ access: ownerAccess });
  const row = id => life.items.find(i => i.programId === id);
  assert.deepEqual([row(programId).canRenew, row(programId).renewal.programId, row(programId).renewal.status, row(out.program.id).renewalOf, row(out.program.id).canRenew], [false, out.program.id, 'draft', programId, false]);

  // A cancelled renewal makes room for another; FitFlex staff carry the discount over.
  await b2bProgramService.setProgramStatus({ access: a, programId: out.program.id, status: 'cancelled', reason: 'Not this year', actorId: OPERATOR });
  const byStaff = await svc.prepareRenewal({ access: a, programId, actorId: OPERATOR });
  assert.deepEqual([byStaff.existing ?? false, byStaff.program.id !== out.program.id, byStaff.program.discountBps, byStaff.discountNotCarriedOver], [false, true, 1000, false]);

  // What cannot be renewed.
  assert.equal((await svc.prepareRenewal({ access: a, programId: byStaff.program.id, actorId: OPERATOR })).error, 'program_not_renewable');   // a draft
  const open = await programme(orgId, {}, [VISITS]);
  assert.equal((await svc.prepareRenewal({ access: a, programId: open.programId, actorId: OPERATOR })).error, 'program_has_no_end_date');
  assert.equal((await svc.prepareRenewal({ access: await access(await sponsor('Elsewhere')), programId, actorId: OPERATOR })).error, 'program_not_found');
  assert.equal((await svc.prepareRenewal({ access: a, programId })).error, 'actor_required');
});

test('renewal: a benefit that can no longer be set up is left out and named; the rest are copied', async () => {
  const g = uid('gym');
  await gyms.insertAsync({ id: g, name: 'Closing Gym', tier: 'standard', location: 'Dar es Salaam', status: 'active', ratePerDay: 5000 });
  const orgId = await sponsor('Skip Co');
  const { programId } = await programme(orgId, { endDate: addDays(TODAY, 10) }, [VISITS, { ...VISITS, name: 'At the closing gym', providerRules: { scope: 'selected', gymIds: [g] } }]);
  await gyms.removeAsync(x => x.id === g);                                                // the gym has left FitFlex
  const out = await onDay().svc.prepareRenewal({ access: await access(orgId), programId, actorId: OPERATOR });
  assert.deepEqual([out.benefits.map(b => b.name), out.skipped.map(s => s.name), out.skipped.every(s => typeof s.reason === 'string')], [['Gym visits'], ['At the closing gym'], true]);
});

// ── Routes, jobs and security ────────────────────────────────────────────────

test('security and wiring: who may prepare a renewal, and the jobs run through the operations service', async () => {
  const orgA = await sponsor('SecA');
  const orgB = await sponsor('SecB');
  const { programId } = await programme(orgA, { endDate: addDays(TODAY, 15) }, [VISITS]);
  const manager = await orgUser(orgA, 'manager');
  for (const role of ['hr', 'finance', 'analyst', 'viewer']) {
    const claims = await orgUser(orgA, role);
    assert.deepEqual((await call(prepareB2BProgramRenewal, { claims, params: { id: orgA, programId } })).body.requiredPermission, 'programs.manage', role);
  }
  assert.equal((await call(getB2BProgramLifecycle, { claims: await orgUser(orgA, 'viewer'), params: { id: orgA } })).statusCode, 200);
  const outsider = await orgUser(orgB, 'owner');
  assert.equal((await call(prepareB2BProgramRenewal, { claims: outsider, params: { id: orgA, programId } })).statusCode, 404);
  assert.equal((await call(prepareB2BProgramRenewal, { claims: outsider, params: { id: orgB, programId } })).body.error, 'program_not_found');
  assert.equal((await call(getB2BProgramLifecycle, { claims: outsider, params: { id: orgA } })).statusCode, 404);
  assert.equal((await call(prepareB2BProgramRenewal, { params: { id: orgA, programId } })).statusCode, 401);

  const made1 = await call(prepareB2BProgramRenewal, { claims: manager, params: { id: orgA, programId }, body: { startDate: '2020-01-01', status: 'active', discountBps: 9000 } });
  assert.deepEqual([made1.statusCode, made1.body.program.status, made1.body.program.startDate, made1.body.program.discountBps ?? 0], [201, 'draft', addDays(TODAY, 16), 0]);
  assert.equal((await call(prepareB2BProgramRenewal, { claims: manager, params: { id: orgA, programId } })).statusCode, 200);
  const life = await call(getB2BProgramLifecycle, { claims: manager, params: { id: orgA } });
  const row = life.body.items.find(i => i.programId === programId);
  assert.deepEqual([row.daysLeft, row.endingSoon, row.canRenew, row.renewal.status], [15, true, false, 'draft']);

  // The two jobs, as the operations service runs them.
  const ops = createOpsService({ db, logger: { warn() {}, error() {}, log() {} } });
  const stub = {};
  const h = onDay();
  registerB2BJobs({ ops, db, programs: { filterByColumnAsync: async () => [] }, promotionService: stub, promotionEventsService: stub, b2bProgramService: stub, b2bConsumptionService: stub, b2bBillingService: stub, b2bFinanceService: stub,
    b2bSponsorRefundService: stub, b2bCollectionsService: stub, b2bAnalyticsService: stub, b2bLifecycleService: h.svc });
  const daily = await ops.runJob('b2b-lifecycle-notices', { trigger: 'manual', actorId: OPERATOR });
  assert.deepEqual([daily.status, daily.failed, typeof daily.stats.memberNotices, typeof daily.stats.organisationNotices], ['ok', 0, 'number', 'number']);
  assert.ok(h.sent.inbox.some(m => m.userId === manager.sub && m.type === 'b2b_program_ending'));
  const quick = await ops.runJob('b2b-allowance-notices', { trigger: 'manual', actorId: OPERATOR });
  assert.deepEqual([quick.status, quick.failed], ['ok', 0]);
});
