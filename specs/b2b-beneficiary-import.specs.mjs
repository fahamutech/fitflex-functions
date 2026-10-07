// B2B Phase 7, slice 2 against the CI database: bulk import, invites for
// people who have not joined yet, enrolment when they do, invitation emails
// and reminders, and who may do what.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { purgeB2BBilling } from './fixtures/ledger-cleanup.mjs';
import { b2bService, b2bProgramService, corporateService, signJwt as sign } from '../src/bootstrap/services.mjs';
import {
  createB2BBeneficiaryImportService, parseImportText, readImportRow, MAX_IMPORT_ROWS, MAX_EMAILS_PER_INVITE,
} from '../src/services/b2b-beneficiary-import-service.mjs';
import { createOpsService } from '../src/services/ops-service.mjs';
import { registerB2BJobs } from '../src/services/b2b-jobs.mjs';
import {
  importB2BBeneficiaries, listB2BBeneficiaryInvites, cancelB2BBeneficiaryInvite, resendB2BBeneficiaryInvite, listB2BBeneficiaryImports,
} from '../functions/b2b.mjs';
import * as b2bRoutes from '../functions/b2b.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const tag = randomUUID().slice(0, 6);
const made = { users: [], orgs: [], corporates: [] };
let phoneSeq = Math.floor(Math.random() * 800000) + 100000;
const phone = () => `+255712${String(phoneSeq += 1).padStart(6, '0')}`;
const mail = name => `${name}.${tag}@import.test`;

async function user({ userType = 'member', email = null, phone: p = null, name = null } = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: name ?? `Import ${id.slice(-4)}`, email, phone: p, updatedAt: new Date() });
  made.users.push(id);
  return id;
}
const OPERATOR = await user({ userType: 'admin' });
const ADMIN = { userType: 'admin', userId: OPERATOR };
const access = organizationId => b2bService.resolveAccess({ organizationId, ...ADMIN });
async function sponsor(name = 'org') {
  const { organization } = await b2bService.createOrganization({ body: { organizationType: 'employer', legalName: `Import ${name} ${uid('o')}`, tradingName: `Import ${name}` }, actorId: OPERATOR });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: OPERATOR });
  return organization.id;
}
async function orgUser(orgId, role) {
  const sub = await user();
  const out = await b2bService.addOrganizationUser({ access: await access(orgId), body: { userId: sub, role }, actorId: OPERATOR });
  assert.ok(!out.error, JSON.stringify(out));
  return { sub, userType: 'member' };
}

/** The service on a clock the test moves, with the emails and notices it sent kept. */
function harness({ configured = true, at = new Date() } = {}) {
  const clock = { now: new Date(at) };
  const sent = { email: [], inbox: [], failNext: 0 };
  const svc = createB2BBeneficiaryImportService({
    db, b2bService, now: () => clock.now, appLink: () => 'https://example.test/get-fitflex',
    emailSender: () => (configured ? { configured: true, send: async (to, m) => { if (sent.failNext > 0) { sent.failNext -= 1; return { ok: false, error: 'provider_rejected' }; } sent.email.push({ to, ...m }); return { ok: true }; } } : { configured: false }),
    notify: async (userId, m) => { sent.inbox.push({ userId, ...m }); },
  });
  const days = (n) => { clock.now = new Date(+clock.now + n * 86_400_000); };
  return { svc, sent, clock, days };
}
const invitesOf = (orgId, status = 'invited') => db('B2BBeneficiaryInvite').where({ organizationId: orgId, status }).orderBy('email');
const peopleOf = async orgId => (await b2bService.allBeneficiaries((await access(orgId)).org));

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
  const orgIds = [...made.orgs, ...(made.corporates.length ? await db('B2BOrganization').whereIn('legacyCorporateId', made.corporates).pluck('id') : [])];
  await db('B2BBeneficiaryInvite').whereIn('organizationId', orgIds).del();
  await db('B2BBeneficiaryImport').whereIn('organizationId', orgIds).del();
  await db('OpsException').where('job', 'b2b-beneficiary-invites').whereIn('jobRunId', db('JobRun').whereIn('triggeredBy', made.users).select('id')).del();
  await db('JobRun').whereIn('triggeredBy', made.users).del();
  await db('Notification').whereIn('userId', made.users).del().catch(() => {});
  await purgeB2BBilling(db, orgIds);
  if (orgIds.length) {
    await db('B2BBeneficiary').whereIn('organizationId', orgIds).del();
    await db('B2BOrganizationUser').whereIn('organizationId', orgIds).del().catch(() => {});
    const programIds = await db('B2BWellnessProgram').whereIn('organizationId', orgIds).pluck('id');
    await db('B2BBenefit').whereIn('programId', programIds).del();
    await db('B2BWellnessProgram').whereIn('organizationId', orgIds).del();
    await db('B2BOrganization').whereIn('id', orgIds).del();
  }
  if (made.corporates.length) {
    await db('CorporateEmployee').whereIn('corporateId', made.corporates).del();
    await db('CorporateAccount').whereIn('id', made.corporates).del();
  }
  await db('AuditLog').whereIn('actor', [...made.users, 'system:b2b-beneficiary-invites']).del();
  await db('User').whereIn('id', made.users).del();
});

// ── Rules ────────────────────────────────────────────────────────────────────

test('rules: reading a pasted list, with or without a header, and what makes a row usable', () => {
  assert.deepEqual(parseImportText('Asha Mollel, asha@x.test, 0712 345 678, Finance, EMP-1, employee\n\n"Juma, Omari";juma@x.test'), [
    { line: 1, name: 'Asha Mollel', email: 'asha@x.test', phone: '0712 345 678', group: 'Finance', reference: 'EMP-1', type: 'employee' },
    { line: 2, name: 'Juma, Omari', email: 'juma@x.test' },
  ]);
  // A header line decides the columns, in any order and under the names people use.
  assert.deepEqual(parseImportText('﻿Email Address,Department,Full Name,Mobile\nasha@x.test,Finance,Asha,\n,Ops,Neema,0713000111'), [
    { line: 2, email: 'asha@x.test', group: 'Finance', name: 'Asha' },
    { line: 3, group: 'Ops', name: 'Neema', phone: '0713000111' },
  ]);
  assert.deepEqual(parseImportText('  \n'), []);
  assert.deepEqual(readImportRow({ name: ' Asha ', email: ' Asha@X.Test ', phone: '0712 345 678', group: 'Finance', type: 'Employee' }).person,
    { email: 'asha@x.test', phone: '+255712345678', displayName: 'Asha', groupName: 'Finance', externalReference: null, beneficiaryType: 'employee' });
  assert.equal(readImportRow({ phone: '0712345678' }).person.beneficiaryType, 'member');
  assert.deepEqual([{ name: 'x' }, { email: 'not-an-email' }, { phone: '12' }, { email: 'a@b.co', type: 'vip' }].map(r => readImportRow(r).problem),
    ['email_or_phone_required', 'invalid_email', 'invalid_phone', 'invalid_type']);
});

// ── Import ───────────────────────────────────────────────────────────────────

test('import: members are enrolled, people who have not joined are invited, bad rows are named, and nobody is added twice', async () => {
  const orgId = await sponsor();
  const h = harness();
  const a = await access(orgId);
  const p1 = phone();
  await user({ email: mail('asha'), name: 'Asha Mollel' });
  await user({ phone: p1, name: 'Baraka Juma' });
  await user({ userType: 'trainer', email: mail('trainer') });                        // not a member account: treated as not joined yet
  const already = await user({ email: mail('onlist') });
  await b2bService.enrollBeneficiary({ access: a, body: { userId: already, status: 'active' }, actorId: OPERATOR });
  const rawText = [
    'name,email,phone,group,reference,type',
    `Asha Mollel,${mail('asha').toUpperCase()},,Finance,EMP-1,employee`,
    `Baraka Juma,,${p1.replace('+255', '0')},Ops,EMP-2,employee`,
    `On List,${mail('onlist')},,Ops,,`,
    `Neema Said,${mail('neema')},,Finance,EMP-3,employee`,
    `Juma Omari,,${phone()},Ops,,`,
    `Coach,${mail('trainer')},,Ops,,`,
    'No Contact,,,Ops,,',
    'Bad Email,not-an-email,,Ops,,',
    `Twice,${mail('neema')},,Ops,,`,
  ].join('\n');

  // A dry run says what would happen and changes nothing.
  const dry = await h.svc.importPeople({ access: a, body: { rawText, dryRun: true }, actorId: OPERATOR });
  assert.deepEqual([dry.dryRun, dry.total, dry.enrolled, dry.invited, dry.unchanged, dry.rejected, dry.withoutEmail], [true, 9, 2, 3, 1, 3, 2]);
  assert.deepEqual([(await peopleOf(orgId)).length, (await invitesOf(orgId)).length, (await db('B2BBeneficiaryImport').where({ organizationId: orgId })).length], [1, 0, 0]);

  const done = await h.svc.importPeople({ access: a, body: { rawText }, actorId: OPERATOR });
  assert.deepEqual([done.total, done.enrolled, done.invited, done.unchanged, done.rejected], [9, 2, 3, 1, 3]);
  assert.deepEqual(done.problems.map(p => [p.line, p.problem]), [[8, 'email_or_phone_required'], [9, 'invalid_email'], [10, 'listed_twice']]);
  const list = await peopleOf(orgId);
  assert.deepEqual(list.map(b => [b.displayName, b.groupName, b.externalReference, b.beneficiaryType, b.status]).sort((x, y) => String(x[0]).localeCompare(String(y[0]))).slice(0, 2),
    [['Asha Mollel', 'Finance', 'EMP-1', 'employee', 'active'], ['Baraka Juma', 'Ops', 'EMP-2', 'employee', 'active']]);
  const invites = await invitesOf(orgId);
  assert.deepEqual(invites.map(i => [i.displayName, i.email, !!i.phone, i.groupName, i.externalReference, !!i.nextEmailAt]).sort((x, y) => x[0].localeCompare(y[0])),
    [['Coach', mail('trainer'), false, 'Ops', null, true], ['Juma Omari', null, true, 'Ops', null, false], ['Neema Said', mail('neema'), false, 'Finance', 'EMP-3', true]]);
  const [record] = await db('B2BBeneficiaryImport').where({ organizationId: orgId });
  assert.deepEqual([record.total, record.enrolled, record.invited, record.unchanged, record.rejected, record.problems.length, record.createdBy], [9, 2, 3, 1, 3, 3, OPERATOR]);
  assert.equal((await db('AuditLog').where({ action: 'b2b.beneficiaries.import', target: orgId })).length, 1);

  // The same file again: everyone is already there. Changed details on an invite are taken.
  const again = await h.svc.importPeople({ access: a, body: { rawText: rawText.replace('Neema Said', 'Neema S. Said').replace(`${mail('neema')},,Finance`, `${mail('neema')},,Sales`) }, actorId: OPERATOR });
  assert.deepEqual([again.enrolled, again.invited, again.unchanged, again.rejected], [0, 0, 6, 3]);
  assert.deepEqual([(await peopleOf(orgId)).length, (await invitesOf(orgId)).length], [3, 3]);
  assert.deepEqual((await invitesOf(orgId)).filter(i => i.email === mail('neema')).map(i => [i.displayName, i.groupName]), [['Neema S. Said', 'Sales']]);
  // Two uploads at the same moment do not double anyone either.
  const fresh = `x,${mail('race')}`;
  const both = await Promise.all([h.svc.importPeople({ access: a, body: { rawText: fresh }, actorId: OPERATOR }), h.svc.importPeople({ access: a, body: { rawText: fresh }, actorId: OPERATOR })]);
  assert.deepEqual([both[0].invited + both[1].invited, both[0].unchanged + both[1].unchanged, (await invitesOf(orgId)).filter(i => i.email === mail('race')).length], [1, 1, 1]);

  // Limits and refusals.
  assert.equal((await h.svc.importPeople({ access: a, body: { rawText: ' ' }, actorId: OPERATOR })).error, 'nothing_to_import');
  const tooMany = await h.svc.importPeople({ access: a, body: { rows: Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({ email: `p${i}@many.test` })) }, actorId: OPERATOR });
  assert.deepEqual([tooMany.error, tooMany.maxRows], ['too_many_rows', 2000]);
  const pendingOrg = (await b2bService.createOrganization({ body: { organizationType: 'club', legalName: `Import pending ${uid('o')}` }, actorId: OPERATOR })).organization.id;
  made.orgs.push(pendingOrg);
  assert.equal((await h.svc.importPeople({ access: await access(pendingOrg), body: { rawText: fresh }, actorId: OPERATOR })).error, 'organization_not_active');
});

test('import: a company managed under Companies keeps its own staff list', async () => {
  const { account } = await corporateService.onboard({ body: { companyName: `Import Co ${uid('c')}`, industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'copay_70_30', passTier: 'pro', seatLimit: 5 }, actorId: OPERATOR });
  made.corporates.push(account.id);
  await corporateService.setStatus({ corporateId: account.id, status: 'active', actorId: OPERATOR });
  const orgId = (await b2bService.organizationForCorporate({ corporateId: account.id })).organization.id;
  const out = await harness().svc.importPeople({ access: await access(orgId), body: { rawText: `x,${mail('corp')}` }, actorId: OPERATOR });
  assert.deepEqual([out.error, out.status, out.use], ['managed_by_corporate', 409, '/corporate/staff/bulk']);
  assert.equal((await db('B2BBeneficiaryInvite').where({ organizationId: orgId })).length, 0);
});

// ── Joining ──────────────────────────────────────────────────────────────────

test('an invited person is enrolled when they join, once, with what the organisation listed; other organisations\' invites are separate', async () => {
  const orgA = await sponsor('A');
  const orgB = await sponsor('B');
  const h = harness();
  const p = phone();
  await h.svc.importPeople({ access: await access(orgA), body: { rows: [{ name: 'Neema Said', email: mail('join'), group: 'Finance', reference: 'EMP-9', type: 'employee' }, { name: 'By Phone', phone: p }, { name: 'Never', email: mail('never') }] }, actorId: OPERATOR });
  await h.svc.importPeople({ access: await access(orgB), body: { rows: [{ name: 'Neema Said', email: mail('join'), group: 'Members' }] }, actorId: OPERATOR });

  // Nobody has joined: nothing happens.
  assert.deepEqual(await h.svc.matchInvites(), { ...(await h.svc.matchInvites()), enrolled: 0 });
  const neema = await user({ email: mail('join'), name: 'Neema Said' });
  const byPhone = await user({ phone: p });
  await user({ userType: 'trainer', email: mail('never') });                          // a trainer account is not the member being waited for

  const run = await h.svc.matchInvites();
  assert.deepEqual([run.enrolled >= 3, run.failed], [true, 0]);
  const inA = await peopleOf(orgA);
  assert.deepEqual(inA.map(b => [b.userId, b.groupName, b.externalReference, b.beneficiaryType, b.status]).sort((x, y) => x[0].localeCompare(y[0])),
    [[neema, 'Finance', 'EMP-9', 'employee', 'active'], [byPhone, null, null, 'member', 'active']].sort((x, y) => x[0].localeCompare(y[0])));
  assert.deepEqual((await peopleOf(orgB)).map(b => [b.userId, b.groupName]), [[neema, 'Members']]);
  assert.deepEqual([(await invitesOf(orgA)).map(i => i.email), (await invitesOf(orgA, 'enrolled')).length, (await invitesOf(orgB, 'enrolled'))[0].beneficiaryId !== null], [[mail('never')], 2, true]);
  // The member is told, once per organisation.
  assert.deepEqual(h.sent.inbox.filter(m => m.userId === neema).map(m => m.type), ['b2b_beneficiary_enrolled', 'b2b_beneficiary_enrolled']);
  assert.match(h.sent.inbox.find(m => m.userId === neema).body, /has added you to its wellness programme/);
  // Again, and many at once: nobody is enrolled twice.
  await Promise.all([h.svc.matchInvites(), h.svc.matchInvites(), h.svc.matchInvites({ userId: neema })]);
  assert.deepEqual([(await peopleOf(orgA)).length, (await peopleOf(orgB)).length, h.sent.inbox.filter(m => m.userId === neema).length], [2, 1, 2]);

  // Added by hand in the meantime: the invite closes without a second row.
  const late = await user({ email: mail('late') });
  await h.svc.importPeople({ access: await access(orgA), body: { rows: [{ email: mail('late2') }] }, actorId: OPERATOR });
  await db('B2BBeneficiaryInvite').where({ organizationId: orgA, email: mail('late2') }).update({ email: mail('late') });
  await b2bService.enrollBeneficiary({ access: await access(orgA), body: { userId: late, status: 'active' }, actorId: OPERATOR });
  await h.svc.matchInvites({ userId: late });
  assert.deepEqual([(await peopleOf(orgA)).filter(b => b.userId === late).length, (await db('B2BBeneficiaryInvite').where({ organizationId: orgA, email: mail('late') }).first()).status], [1, 'enrolled']);

  // Cancelled: joining later does not enrol.
  const orgC = await sponsor('C');
  const ac = await access(orgC);
  await h.svc.importPeople({ access: ac, body: { rows: [{ email: mail('cancelled') }] }, actorId: OPERATOR });
  const [inv] = await invitesOf(orgC);
  assert.equal((await h.svc.cancelInvite({ access: ac, inviteId: inv.id, actorId: OPERATOR })).invite.status, 'cancelled');
  assert.equal((await h.svc.cancelInvite({ access: ac, inviteId: inv.id, actorId: OPERATOR })).unchanged, true);
  const gone = await user({ email: mail('cancelled') });
  await h.svc.matchInvites({ userId: gone });
  assert.equal((await peopleOf(orgC)).length, 0);
  // And can be invited afresh.
  assert.equal((await h.svc.importPeople({ access: ac, body: { rows: [{ email: mail('cancelled') }] }, actorId: OPERATOR })).enrolled, 1);
});

test('a member who opens their benefits is enrolled there and then', async () => {
  const orgId = await sponsor();
  const a = await access(orgId);
  const { program } = await b2bProgramService.createProgram({ access: a, body: { name: 'Import programme', startDate: '2026-01-01' }, actorId: OPERATOR });
  const { benefit } = await b2bProgramService.createBenefit({ access: a, programId: program.id, body: { name: 'Gym visits', benefitType: 'gym_access', fundingType: 'full', usagePeriod: 'unlimited' }, actorId: OPERATOR });
  await b2bProgramService.setBenefitStatus({ access: a, programId: program.id, benefitId: benefit.id, status: 'active', actorId: OPERATOR });
  await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'pending', actorId: OPERATOR });
  await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'active', actorId: OPERATOR });
  const done = await call(importB2BBeneficiaries, { claims: { sub: OPERATOR, userType: 'admin' }, params: { id: orgId }, body: { rows: [{ name: 'Fresh Member', email: mail('fresh') }] } });
  assert.deepEqual([done.statusCode, done.body.invited], [200, 1]);
  const member = await user({ email: mail('fresh') });
  const mine = await call(b2bRoutes.myB2BBenefits ?? Object.values(b2bRoutes).find(r => r?.path === '/b2b/me/benefits'), { claims: { sub: member, userType: 'member' } });
  assert.equal(mine.statusCode, 200);
  assert.deepEqual(mine.body.benefits.map(b => b.name ?? b.benefit?.name), ['Gym visits']);
  assert.equal((await invitesOf(orgId)).length, 0);
});

// ── Email ────────────────────────────────────────────────────────────────────

test('emails: the invitation, a reminder after 3 days and another after 10, then no more; none once the person has joined or the invite is cancelled', async () => {
  const orgId = await sponsor('Mail');
  const h = harness();
  const a = await access(orgId);
  await h.svc.importPeople({ access: a, body: { rows: [{ name: 'Neema', email: mail('m1') }, { email: mail('m2') }, { email: mail('m3') }, { name: 'Phone Only', phone: phone() }] }, actorId: OPERATOR });
  const mine = () => h.sent.email.filter(e => /^m\d\./.test(e.to) && e.to.endsWith(`${tag}@import.test`));
  const run = () => h.svc.sendDue({ limit: 1000 });

  await run();
  assert.deepEqual(mine().map(e => e.to).sort(), [mail('m1'), mail('m2'), mail('m3')]);
  const first = mine().find(e => e.to === mail('m1'));
  assert.equal(first.subject, 'Import Mail has added you to FitFlex');
  for (const expected of [/^Hello Neema,/, /sign up as a member with this email address/, new RegExp(mail('m1').replace(/\./g, '\\.')), /Get the app: https:\/\/example\.test\/get-fitflex/, /What Import Mail can see/, /cannot see your weight, height/, /ask Import Mail to remove you/]) assert.match(first.text, expected);
  assert.match(mine().find(e => e.to === mail('m2')).text, /^Hello,/);
  await run();
  assert.equal(mine().length, 3);                                                     // nothing is due again yet

  // m2 joins; m3 is cancelled. Only m1 is reminded.
  const joined = await user({ email: mail('m2') });
  await h.svc.matchInvites({ userId: joined });
  const m3 = (await invitesOf(orgId)).find(i => i.email === mail('m3'));
  await h.svc.cancelInvite({ access: a, inviteId: m3.id, actorId: OPERATOR });
  h.days(2); await run();
  assert.equal(mine().length, 3);
  h.days(1.1); await run();
  assert.deepEqual(mine().slice(3).map(e => [e.to, e.subject]), [[mail('m1'), 'Reminder: your FitFlex benefits from Import Mail']]);
  h.days(5); await run();
  assert.equal(mine().length, 4);
  h.days(2); await run();
  assert.equal(mine().length, 5);
  h.days(60); await run();
  assert.equal(mine().length, 5);                                                     // the invitation and two reminders, no more
  const m1 = (await invitesOf(orgId)).find(i => i.email === mail('m1'));
  assert.deepEqual([m1.emailsSent, m1.nextEmailAt, m1.status], [3, null, 'invited']);

  // Two runs at once send one email.
  await h.svc.importPeople({ access: a, body: { rows: [{ email: mail('m9') }] }, actorId: OPERATOR });
  await Promise.all([run(), run(), run()]);
  assert.equal(mine().filter(e => e.to === mail('m9')).length, 1);
});

test('emails: failures stop after three in a row; "send again" has its limits; with no sender set up, invites wait', async () => {
  const orgId = await sponsor('Mail2');
  const h = harness();
  const a = await access(orgId);
  await h.svc.importPeople({ access: a, body: { rows: [{ email: mail('f1') }, { name: 'Phone Only', phone: phone() }] }, actorId: OPERATOR });
  const invite = async () => (await db('B2BBeneficiaryInvite').where({ organizationId: orgId, email: mail('f1') }).first());
  h.sent.failNext = 3;
  for (let i = 1; i <= 3; i += 1) {
    const r = await h.svc.sendDue({ limit: 1000 });
    assert.equal(r.failed >= 1, true);
    const row = await invite();
    assert.deepEqual([row.emailFailures, row.lastEmailError, row.emailsSent, !!row.nextEmailAt], [i, 'provider_rejected', 0, i < 3]);
    h.days(0.05);                                                                     // just over an hour
  }
  h.days(5); await h.svc.sendDue({ limit: 1000 });
  assert.equal(h.sent.email.filter(e => e.to === mail('f1')).length, 0);                // it stopped
  assert.equal((await h.svc.pending()).invitesEmailFailed >= 1, true);

  // "Send again" starts it over.
  const id = (await invite()).id;
  const again = await h.svc.resendInvite({ access: a, inviteId: id, actorId: OPERATOR });
  assert.deepEqual([again.sent, again.invite.emailsSent, again.invite.emailFailures, h.sent.email.filter(e => e.to === mail('f1')).length], [true, 1, 0, 1]);
  assert.equal((await h.svc.resendInvite({ access: a, inviteId: id, actorId: OPERATOR })).error, 'sent_recently');
  for (let i = 2; i <= MAX_EMAILS_PER_INVITE; i += 1) {
    h.days(0.05);
    assert.equal((await h.svc.resendInvite({ access: a, inviteId: id, actorId: OPERATOR })).invite.emailsSent, i);
  }
  h.days(0.05);
  assert.deepEqual([(await h.svc.resendInvite({ access: a, inviteId: id, actorId: OPERATOR })).error, h.sent.email.filter(e => e.to === mail('f1')).length], ['email_limit_reached', 6]);
  const phoneOnly = (await db('B2BBeneficiaryInvite').where({ organizationId: orgId }).whereNull('email').first());
  assert.equal((await h.svc.resendInvite({ access: a, inviteId: phoneOnly.id, actorId: OPERATOR })).error, 'invite_has_no_email');
  assert.equal((await h.svc.resendInvite({ access: a, inviteId: 'b2bbi_none', actorId: OPERATOR })).error, 'invite_not_found');

  // No email sender: nothing is sent, nothing is lost, and the job says so.
  const off = harness({ configured: false });
  const org2 = await sponsor('Mail3');
  await off.svc.importPeople({ access: await access(org2), body: { rows: [{ email: mail('w1') }] }, actorId: OPERATOR });
  const waiting = await off.svc.sendDue({ limit: 1000 });
  assert.deepEqual([waiting.notConfigured, waiting.sent, waiting.due >= 1, !!(await invitesOf(org2))[0].nextEmailAt], [true, 0, true, true]);
  assert.equal((await off.svc.listInvites({ access: await access(org2) })).emailConfigured, false);
  const ops = createOpsService({ db, logger: { warn() {}, error() {}, log() {} } });
  const stub = { expireDue: async () => ({}) };
  registerB2BJobs({ ops, db, programs: { filterByColumnAsync: async () => [] }, b2bProgramService: stub, b2bConsumptionService: stub, b2bBillingService: stub, b2bFinanceService: stub, b2bSponsorRefundService: stub, b2bCollectionsService: stub, b2bAnalyticsService: stub, b2bBeneficiaryImportService: off.svc });
  const ran = await ops.runJob('b2b-beneficiary-invites', { trigger: 'manual', actorId: OPERATOR });
  assert.deepEqual([ran.status, ran.stats.emailsWaiting >= 1], ['ok', true]);
  const [x] = await db('OpsException').where({ dedupeKey: 'item:b2b-beneficiary-invites:email-setup' }).whereIn('status', ['open', 'investigating']);
  assert.deepEqual([x.severity, /email sender is not set up/.test(x.title)], ['low', true]);
  await db('OpsException').where({ id: x.id }).del();
});

// ── Security ─────────────────────────────────────────────────────────────────

test('security: only people who manage the list can import, cancel or resend, and only in their own organisation', async () => {
  const orgA = await sponsor('SecA');
  const orgB = await sponsor('SecB');
  const hrA = await orgUser(orgA, 'hr');
  const body = { rows: [{ name: 'Sec Person', email: mail('sec') }] };
  const done = await call(importB2BBeneficiaries, { claims: hrA, params: { id: orgA }, body: { ...body, organizationId: orgB, status: 'enrolled' } });
  assert.deepEqual([done.statusCode, done.body.invited], [200, 1]);
  const listed = await call(listB2BBeneficiaryInvites, { claims: hrA, params: { id: orgA } });
  assert.deepEqual([listed.body.items.map(i => [i.email, i.status, i.organizationId]), 'invitedBy' in listed.body.items[0]], [[[mail('sec'), 'invited', orgA]], false]);
  const inviteId = listed.body.items[0].id;
  assert.equal((await db('B2BBeneficiaryInvite').where({ organizationId: orgB })).length, 0);

  for (const role of ['finance', 'analyst', 'viewer']) {
    const claims = await orgUser(orgA, role);
    assert.deepEqual((await call(importB2BBeneficiaries, { claims, params: { id: orgA }, body })).body.requiredPermission, 'beneficiaries.manage', role);
    assert.equal((await call(cancelB2BBeneficiaryInvite, { claims, params: { id: orgA, inviteId } })).statusCode, 403, role);
    assert.equal((await call(resendB2BBeneficiaryInvite, { claims, params: { id: orgA, inviteId } })).statusCode, 403, role);
  }
  // Analysts can see the list; finance and viewers cannot.
  assert.equal((await call(listB2BBeneficiaryInvites, { claims: await orgUser(orgA, 'analyst'), params: { id: orgA } })).statusCode, 200);
  assert.equal((await call(listB2BBeneficiaryInvites, { claims: await orgUser(orgA, 'viewer'), params: { id: orgA } })).body.requiredPermission, 'beneficiaries.read');

  // Another organisation's HR: not this organisation, and not this organisation's invite under their own.
  const hrB = await orgUser(orgB, 'hr');
  for (const route of [importB2BBeneficiaries, listB2BBeneficiaryInvites, listB2BBeneficiaryImports]) assert.equal((await call(route, { claims: hrB, params: { id: orgA }, body })).statusCode, 404, route.path);
  assert.equal((await call(cancelB2BBeneficiaryInvite, { claims: hrB, params: { id: orgB, inviteId } })).body.error, 'invite_not_found');
  assert.equal((await call(resendB2BBeneficiaryInvite, { claims: hrB, params: { id: orgB, inviteId } })).body.error, 'invite_not_found');
  assert.equal((await db('B2BBeneficiaryInvite').where({ id: inviteId }).first()).status, 'invited');
  assert.equal((await call(importB2BBeneficiaries, { params: { id: orgA }, body })).statusCode, 401);

  const imports = await call(listB2BBeneficiaryImports, { claims: hrA, params: { id: orgA } });
  assert.deepEqual([imports.body.items.length, imports.body.items[0].invited, 'createdBy' in imports.body.items[0]], [1, 1, false]);
  assert.equal((await call(cancelB2BBeneficiaryInvite, { claims: hrA, params: { id: orgA, inviteId } })).body.invite.status, 'cancelled');
  assert.deepEqual((await db('AuditLog').where({ target: inviteId, actor: hrA.sub })).map(r => r.action), ['b2b.beneficiary_invite.cancel']);
});
