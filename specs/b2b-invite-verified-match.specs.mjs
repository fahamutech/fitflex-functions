// B2B invites and bulk import match people by VERIFIED contacts only
// (security fix, 20 Oct 2026). Against the CI database.
//
// An email or number someone typed onto their own profile (User.email /
// User.phone) never gets them asked into another person's sponsored programme:
// not by the matching job, not when they open Benefits, not by an import.
// The invite stays "invited" until a member who has verified that contact
// (LoginIdentifier.verifiedAt) appears; since consent slice (a) that member is
// asked in the app and enrolled only on accepting. Suspended / closed Persons
// and deleted accounts are skipped.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { purgeB2BBilling } from './fixtures/ledger-cleanup.mjs';
import { verifyContacts, purgeIdentity } from './fixtures/verified-contacts.mjs';
import { b2bService, b2bBeneficiaryImportService, b2bMemberRequestService, signJwt as sign } from '../src/bootstrap/services.mjs';
import { createB2BBeneficiaryImportService, SMS_MAX_LENGTH } from '../src/services/b2b-beneficiary-import-service.mjs';
import { myB2BBenefits } from '../functions/b2b.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const tag = randomUUID().slice(0, 6);
const made = { users: [], orgs: [] };
let phoneSeq = Math.floor(Math.random() * 800000) + 100000;
const phone = () => `+255713${String(phoneSeq += 1).padStart(6, '0')}`;
const mail = name => `${name}.${tag}@verified-match.test`;

async function user({ userType = 'member', email = null, phone: p = null, accountStatus = null } = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `VM ${id.slice(-4)}`, email, phone: p, ...(accountStatus ? { accountStatus } : {}), updatedAt: new Date() });
  made.users.push(id);
  return id;
}
const OPERATOR = await user({ userType: 'admin' });
const ADMIN = { userType: 'admin', userId: OPERATOR };
const access = organizationId => b2bService.resolveAccess({ organizationId, ...ADMIN });
async function sponsor(name = 'Acme') {
  const { organization } = await b2bService.createOrganization({ body: { organizationType: 'employer', legalName: `VM ${name} ${uid('o')}`, tradingName: name }, actorId: OPERATOR });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: OPERATOR });
  return organization.id;
}
function service({ emailCodes = false } = {}) {
  const sent = { email: [], sms: [] };
  const svc = createB2BBeneficiaryImportService({
    db, b2bService, memberRequests: b2bMemberRequestService, emailCodes: () => emailCodes, appLink: () => 'https://example.test/app',
    emailSender: () => ({ configured: true, send: async (to, m) => { sent.email.push({ to, ...m }); return { ok: true }; } }),
    smsSender: () => ({ configured: true, send: async (to, m) => { sent.sms.push({ to, ...m }); return { ok: true }; } }),
    smsEnabled: () => true,
  });
  return { svc, sent };
}
const enrolled = async (orgId, userId) => Number((await db('B2BBeneficiary').where({ organizationId: orgId, userId }).count('* as n').first()).n);
/** Requests this organisation's invites made to this person. */
const asked = async (orgId, userId) => Number((await db('B2BMemberRequest').where({ organizationId: orgId, userId }).count('* as n').first()).n);
async function accept(orgId, userId) {
  const row = await db('B2BMemberRequest').where({ organizationId: orgId, userId, status: 'pending' }).first();
  assert.ok(row, 'an open request');
  const out = await b2bMemberRequestService.accept({ userId, requestId: row.id });
  assert.ok(out.beneficiary, JSON.stringify(out));
}
const inviteOf = (orgId, where) => db('B2BBeneficiaryInvite').where({ organizationId: orgId, ...where }).first();
const personOf = async userId => (await db('User').where({ id: userId }).first('personId')).personId;

async function openBenefits(userId) {
  const req = { headers: { authorization: `Bearer ${sign({ sub: userId, userType: 'member' })}` }, params: {}, body: {}, query: {} };
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  for (const guard of [myB2BBenefits.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, res, () => { passed = true; });
    if (!passed) return res;
  }
  await myB2BBenefits.onRequest(req, res);
  return res;
}

after(async () => {
  await db('B2BMemberRequest').whereIn('organizationId', made.orgs).del();
  await db('B2BBeneficiaryInvite').whereIn('organizationId', made.orgs).del();
  await db('B2BBeneficiaryImport').whereIn('organizationId', made.orgs).del();
  await db('Notification').whereIn('userId', made.users).del().catch(() => {});
  await purgeB2BBilling(db, made.orgs);
  await db('B2BBeneficiary').whereIn('organizationId', made.orgs).del();
  await db('B2BOrganizationUser').whereIn('organizationId', made.orgs).del().catch(() => {});
  await db('B2BOrganization').whereIn('id', made.orgs).del();
  await db('B2BBeneficiaryInviteMatch').whereIn('organizationId', made.orgs).del();
  await db('AuditLog').whereIn('actor', [...made.users, 'system:b2b-beneficiary-invites']).del();
  const persons = await purgeIdentity(db, made.users);
  await db('User').whereIn('id', made.users).del();
  if (persons?.length) await db('Person').whereIn('id', persons).del().catch(() => {});
});

test('a planted email or number does not take an invite: not by the job, not by opening Benefits, not by an import', async () => {
  const orgId = await sponsor();
  const { svc } = service();
  const victimEmail = mail('victim');
  const victimPhone = phone();
  await svc.importPeople({ access: await access(orgId), body: { rows: [{ name: 'Victim', email: victimEmail }, { name: 'Victim Phone', phone: victimPhone }] }, actorId: OPERATOR });

  // Someone types the colleague's email and number onto their own profile; nothing verifies them.
  const planter = await user({ email: victimEmail, phone: victimPhone });

  const job = await svc.matchInvites();
  assert.deepEqual([await enrolled(orgId, planter), await asked(orgId, planter)], [0, 0], `job: ${JSON.stringify(job)}`);
  // The bootstrap job (what the scheduler runs) does the same.
  await b2bBeneficiaryImportService.matchInvites();
  assert.deepEqual([await enrolled(orgId, planter), await asked(orgId, planter)], [0, 0]);

  const opened = await openBenefits(planter);
  assert.equal(opened.statusCode, 200, JSON.stringify(opened.body));
  assert.deepEqual([await enrolled(orgId, planter), await asked(orgId, planter), opened.body.memberRequests.length], [0, 0, 0], 'opening Benefits asks nobody by a planted contact');
  assert.equal((await inviteOf(orgId, { email: victimEmail })).status, 'invited');
  assert.equal((await inviteOf(orgId, { phone: victimPhone })).status, 'invited');

  // An import listing the planted contacts invites them; it does not enrol the planter.
  const other = await sponsor('Other');
  const out = await svc.importPeople({ access: await access(other), body: { rows: [{ email: victimEmail.toUpperCase() }, { phone: victimPhone.replace('+255', '0') }] }, actorId: OPERATOR });
  assert.deepEqual([out.enrolled, out.invited], [0, 2]);
  assert.equal(await enrolled(other, planter), 0);
  const dry = await svc.importPeople({ access: await access(await sponsor('Dry')), body: { rows: [{ email: victimEmail }], dryRun: true }, actorId: OPERATOR });
  assert.deepEqual([dry.enrolled, dry.invited], [0, 1]);

  // The real owner verifies the email (with no User.email on their row): the job asks them, not the planter; they accept.
  const owner = await user();
  await verifyContacts(db, owner, { email: victimEmail });
  await svc.matchInvites();
  assert.deepEqual([await asked(orgId, owner), await asked(orgId, planter), await enrolled(orgId, owner)], [1, 0, 0]);
  assert.equal((await inviteOf(orgId, { email: victimEmail })).status, 'invited');
  await accept(orgId, owner);
  assert.deepEqual([await enrolled(orgId, owner), await enrolled(orgId, planter)], [1, 0]);
  assert.equal((await inviteOf(orgId, { email: victimEmail })).status, 'enrolled');
  assert.equal((await inviteOf(orgId, { phone: victimPhone })).status, 'invited', 'the number is still waiting for whoever verifies it');
});

test('a verified member is asked (never enrolled) by an import, and by the job or Benefits once they verify; enrolled when they accept', async () => {
  const orgId = await sponsor();
  const { svc } = service();
  const a = await access(orgId);
  const verifiedEmail = mail('verified');
  const member = await user();
  await verifyContacts(db, member, { email: verifiedEmail });
  const out = await svc.importPeople({ access: a, body: { rows: [{ email: verifiedEmail.toUpperCase() }] }, actorId: OPERATOR });
  assert.deepEqual([out.enrolled, out.invited], [0, 1]);
  await svc.matchInvites();
  assert.deepEqual([await enrolled(orgId, member), await asked(orgId, member)], [0, 1]);
  await accept(orgId, member);
  assert.equal(await enrolled(orgId, member), 1);

  // Phone on the profile only, then verified later (Mobile number and email): Benefits matches them there and then.
  const p = phone();
  const late = await user({ phone: p });
  await svc.importPeople({ access: a, body: { rows: [{ phone: p }] }, actorId: OPERATOR });
  assert.equal((await inviteOf(orgId, { phone: p })).status, 'invited', 'an unverified number on the profile waits');
  await svc.matchInvites({ userId: late });
  assert.deepEqual([await enrolled(orgId, late), await asked(orgId, late)], [0, 0]);
  await verifyContacts(db, late, { phone: p });
  const opened = await openBenefits(late);
  assert.equal(opened.statusCode, 200);
  assert.deepEqual([await enrolled(orgId, late), opened.body.memberRequests.map(r => r.organization.id)], [0, [orgId]]);
  assert.equal((await inviteOf(orgId, { phone: p })).status, 'invited');
  await accept(orgId, late);
  assert.equal(await enrolled(orgId, late), 1);
  assert.equal((await inviteOf(orgId, { phone: p })).status, 'enrolled');
});

test('suspended or closed Persons, deleted accounts and non-member accounts are skipped', async () => {
  const orgId = await sponsor();
  const { svc } = service();
  const contacts = { suspended: mail('susp'), closed: mail('closed'), deleted: mail('deleted'), trainer: mail('trainer') };
  await svc.importPeople({ access: await access(orgId), body: { rows: Object.values(contacts).map(email => ({ email })) }, actorId: OPERATOR });

  const suspended = await user();
  await verifyContacts(db, suspended, { email: contacts.suspended });
  await db('Person').where({ id: await personOf(suspended) }).update({ status: 'suspended' });
  const closed = await user();
  await verifyContacts(db, closed, { email: contacts.closed });
  await db('Person').where({ id: await personOf(closed) }).update({ status: 'closed' });
  const deleted = await user({ accountStatus: 'deleted' });
  await verifyContacts(db, deleted, { email: contacts.deleted });
  const trainer = await user({ userType: 'trainer' });
  await verifyContacts(db, trainer, { email: contacts.trainer });

  await svc.matchInvites();
  for (const id of [suspended, closed]) await svc.matchInvites({ userId: id });
  for (const id of [suspended, closed, deleted, trainer]) assert.deepEqual([await enrolled(orgId, id), await asked(orgId, id)], [0, 0], id);
  for (const email of Object.values(contacts)) assert.equal((await inviteOf(orgId, { email })).status, 'invited', email);
  // An import doesn't enrol them either.
  const again = await svc.importPeople({ access: await access(await sponsor('Again')), body: { rows: Object.values(contacts).map(email => ({ email })) }, actorId: OPERATOR });
  assert.deepEqual([again.enrolled, again.invited], [0, 4]);
});

test('the import says whether email codes are available; the messages tell existing users to confirm their email or number', async () => {
  const orgId = await sponsor('Asha Ltd');
  const off = service({ emailCodes: false });
  const r1 = await off.svc.importPeople({ access: await access(orgId), body: { rows: [{ email: mail('codes1') }], dryRun: true }, actorId: OPERATOR });
  assert.equal(r1.emailCodesAvailable, false);
  const on = service({ emailCodes: true });
  const p = phone();
  const r2 = await on.svc.importPeople({ access: await access(orgId), body: { rows: [{ name: 'Neema', email: mail('codes2'), phone: p }] }, actorId: OPERATOR });
  assert.equal(r2.emailCodesAvailable, true);
  // Default (not wired): treated as unavailable.
  const bare = createB2BBeneficiaryImportService({ db, b2bService });
  assert.equal((await bare.importPeople({ access: await access(orgId), body: { rows: [{ email: mail('codes3') }], dryRun: true }, actorId: OPERATOR })).emailCodesAvailable, false);

  await on.svc.sendDue({ limit: 1000 });
  const email = on.sent.email.find(e => e.to === mail('codes2'));
  assert.match(email.text, /Already on FitFlex\? Confirm this email address or your mobile number under Mobile number and email in the FitFlex app/);
  // Email codes off: the email never promises that the address can be confirmed in the app.
  const offOrg = await sponsor('Off Ltd');
  const p2 = phone();
  await off.svc.importPeople({ access: await access(offOrg), body: { rows: [{ email: mail('off-email') }, { email: mail('off-both'), phone: p2 }] }, actorId: OPERATOR });
  await off.svc.sendDue({ limit: 1000 });
  const emailOnly = off.sent.email.find(e => e.to === mail('off-email')).text;
  const withPhone = off.sent.email.find(e => e.to === mail('off-both')).text;
  assert.match(emailOnly, /Already on FitFlex\? The app asks you once this email address is confirmed on your FitFlex account\./);
  assert.match(withPhone, /Already on FitFlex\? Confirm your mobile number under Mobile number and email in the FitFlex app/);
  for (const t of [emailOnly, withPhone]) assert.doesNotMatch(t, /Confirm this email address/);
  const sms = on.sent.sms.find(m => m.to === p);
  assert.ok(sms.text.length <= SMS_MAX_LENGTH, `${sms.text.length}: ${sms.text}`);
  assert.equal(sms.text, 'Asha Ltd invites you to its wellness programme on FitFlex. Join with this number (or confirm it under Mobile number and email): https://example.test/app');
});

test('the audit script refuses without a database, reports counts only and changes nothing', async () => {
  const script = fileURLToPath(new URL('../scripts/unverified-contact-audit.mjs', import.meta.url));
  const run = (env, args = []) => promisify(execFile)(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env } });
  await assert.rejects(run({}), e => e.code === 2 && /Refusing to run/.test(e.stderr));
  const ciEnv = { FITFLEX_USE_CI_DB: '1', DATABASE_URL_CI: process.env.DATABASE_URL_CI };
  // The flag works but warns about shell history; the environment wins when both are given.
  const byFlag = await run({}, [`--database-url=${process.env.DATABASE_URL_CI}`]);
  assert.match(byFlag.stderr, /leaves the password in shell history/);
  assert.match((await run(ciEnv, ['--database-url=postgres://nobody@127.0.0.1:1/none'])).stderr, /--database-url= was ignored/);
  const count = (out, key) => Number(new RegExp(`^${key}\\s+(\\d+)$`, 'm').exec(out)?.[1]);

  // A number saved in local form on the row but verified (E.164) is not counted as unverified.
  const baseline = count((await run(ciEnv)).stdout, 'beneficiariesWithUnverifiedRowContact');
  const localForm = phone();
  const honest = await user({ phone: `0${localForm.slice(4, 7)} ${localForm.slice(7)}` });
  await verifyContacts(db, honest, { phone: localForm });
  const honestOrg = await sponsor('Honest');
  await b2bService.enrollBeneficiary({ access: await access(honestOrg), body: { userId: honest, status: 'active' }, actorId: OPERATOR });
  assert.equal(count((await run(ciEnv)).stdout, 'beneficiariesWithUnverifiedRowContact'), baseline, 'normalised phone compared');

  // A past enrolment made through a planted email: the invite's contact is not verified by the enrolled member.
  const orgId = await sponsor('Audit');
  const plantedEmail = mail('audit-planted');
  const planter = await user({ email: plantedEmail });
  const ben = await b2bService.enrollBeneficiary({ access: await access(orgId), body: { userId: planter, status: 'active' }, actorId: OPERATOR });
  const at = new Date();
  await db('B2BBeneficiaryInvite').insert({ id: uid('b2bbi'), organizationId: orgId, email: plantedEmail, beneficiaryType: 'member', status: 'enrolled', beneficiaryId: ben.beneficiary.id,
    invitedBy: OPERATOR, invitedAt: at, enrolledAt: at, createdAt: at, updatedAt: at });
  const before = await db('B2BBeneficiary').where({ organizationId: orgId }).select('id', 'status');

  const { stdout } = await run(ciEnv);
  const dbName = (await db.raw('SELECT current_database() AS name')).rows[0].name;
  assert.match(stdout, new RegExp(`^Database: ${dbName} \\(read only\\)`));
  const value = key => Number(new RegExp(`^${key}\\s+(\\d+)$`, 'm').exec(stdout)?.[1]);
  assert.ok(value('inviteMatchedWithoutVerifiedContact') >= 1, stdout);
  assert.ok(value('beneficiariesWithUnverifiedRowContact') >= 1, stdout);
  assert.ok(!stdout.includes(plantedEmail) && !stdout.includes(planter) && !stdout.includes(orgId), 'no personal data or ids in the output');
  assert.deepEqual(await db('B2BBeneficiary').where({ organizationId: orgId }).select('id', 'status'), before, 'nothing reversed');
});
