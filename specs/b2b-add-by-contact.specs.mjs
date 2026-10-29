// Adding people by the email or mobile number of their FitFlex account,
// instead of a user id: organisation users, beneficiaries and a company
// employee's link to their member account. Against the CI database.
// Only a VERIFIED email / number finds someone (LoginIdentifier rows); one
// typed onto a profile (User.email / User.phone) finds nobody.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { b2bService, corporateService, verifiedContacts } from '../src/bootstrap/services.mjs';
import { verifyContacts, purgeIdentity } from './fixtures/verified-contacts.mjs';
import { users } from '../src/bootstrap/collections.mjs';
import { findUserByContact } from '../src/shared/user-contact.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [], corporates: [] };
const tag = randomUUID().slice(0, 6);
let seq = 0;
const phoneNo = () => `+2557${String(10000000 + Math.floor(Math.random() * 89999999)).slice(0, 8)}`;

// `verified`: the person has proven the email / number. `samePersonAs`: another
// account (persona) of the same person, who already holds the contacts.
async function account(userType, { email = null, phone = null, verified = true, samePersonAs = null } = {}) {
  const id = uid('usr');
  seq += 1;
  const personId = samePersonAs ? (await db('User').where({ id: samePersonAs }).first('personId')).personId : undefined;
  await db('User').insert({ id, userType, displayName: `Contact ${userType} ${seq}`, email, phone, updatedAt: new Date(), ...(personId ? { personId } : {}) });
  made.users.push(id);
  if (verified && !samePersonAs && (email || phone)) await verifyContacts(db, id, { email, phone });
  return id;
}
const find = (contact, opts = {}) => findUserByContact(users, contact, { contacts: verifiedContacts, ...opts });
const ADMIN = { userType: 'admin', userId: await account('admin') };

async function sponsor() {
  const { organization } = await b2bService.createOrganization({ body: { organizationType: 'insurer', legalName: `Contact insurer ${uid('o')}` }, actorId: ADMIN.userId });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: ADMIN.userId });
  return organization.id;
}
const access = orgId => b2bService.resolveAccess({ organizationId: orgId, ...ADMIN });

after(async () => {
  if (made.corporates.length) {
    await db('B2BOrganization').whereIn('legacyCorporateId', made.corporates).del();
    await db('CorporateEmployee').whereIn('corporateId', made.corporates).del();
    await db('CorporateAccount').whereIn('id', made.corporates).del();
  }
  if (made.orgs.length) await db('B2BOrganization').whereIn('id', made.orgs).del();
  await db('AuditLog').whereIn('actor', made.users).del();
  const persons = await purgeIdentity(db, made.users);
  await db('User').whereIn('id', made.users).del();
  if (persons?.length) await db('Person').whereIn('id', persons).del().catch(() => {});
});

test('finding an account by email or mobile number: one contact, normalised, the right kind of account', async () => {
  const email = `grace.${tag}@contact.test`;
  const phone = phoneNo();
  const member = await account('member', { email, phone });
  const trainer = await account('trainer', { email, samePersonAs: member });

  assert.equal((await find({})).error, 'user_contact_required');
  assert.equal((await find({ email, phone })).error, 'one_user_contact_only');
  assert.equal((await find({ email: 'not-an-email' })).error, 'invalid_email');
  assert.equal((await find({ phone: '12' })).error, 'invalid_phone');
  assert.deepEqual(await find({ email: `nobody.${tag}@contact.test` }).then(r => [r.error, r.status]), ['user_not_found', 404]);

  // Case and spacing don't matter; local and international forms of a number are the same number.
  assert.equal((await find({ email: `  GRACE.${tag}@Contact.Test ` }, { prefer: 'member' })).user.id, member);
  const local = `0${phone.slice(4, 7)} ${phone.slice(7, 10)} ${phone.slice(10)}`;
  // The number is verified by the person, who has a member and a trainer account: the member account is preferred.
  for (const p of [phone, local, phone.slice(1), phone.slice(4)]) assert.equal((await find({ phone: p }, { prefer: 'member' })).user.id, member, p);
  assert.equal((await find({ userId: trainer })).user.id, trainer);

  // Two accounts share the email: a member account is preferred, or required; without either the caller must say which.
  assert.equal((await find({ email }, { require: 'member' })).user.id, member);
  const which = await find({ email });
  assert.deepEqual([which.error, which.status, which.found.map(f => f.userType).sort()], ['ambiguous_user', 409, ['member', 'trainer']]);
  const onlyTrainer = `coach.${tag}@contact.test`;
  const coach = await account('trainer', { email: onlyTrainer });
  assert.equal((await find({ email: onlyTrainer }, { prefer: 'member' })).user.id, coach);
  assert.deepEqual(await find({ email: onlyTrainer }, { require: 'member' }).then(r => [r.error, r.found]), ['member_account_required', ['trainer']]);
});

test('an organisation user and a beneficiary are added by email or mobile number', async () => {
  const orgId = await sponsor();
  const email = `finance.${tag}@contact.test`;
  const phone = phoneNo();
  const financeUser = await account('member', { email });
  const beneficiaryUser = await account('member', { phone });
  const a = await access(orgId);

  const added = await b2bService.addOrganizationUser({ access: a, body: { email: email.toUpperCase(), role: 'finance' }, actorId: ADMIN.userId });
  assert.deepEqual([added.organizationUser.userId, added.organizationUser.role, added.organizationUser.user.email], [financeUser, 'finance', email]);
  assert.equal((await b2bService.addOrganizationUser({ access: a, body: { email, role: 'viewer' }, actorId: ADMIN.userId })).error, 'already_organization_user');
  assert.equal((await b2bService.addOrganizationUser({ access: a, body: { email: `nobody.${tag}@contact.test`, role: 'viewer' }, actorId: ADMIN.userId })).error, 'user_not_found');
  assert.equal((await b2bService.addOrganizationUser({ access: a, body: { role: 'viewer' }, actorId: ADMIN.userId })).error, 'user_contact_required');
  // A user id still works.
  const byId = await account('member');
  assert.equal((await b2bService.addOrganizationUser({ access: a, body: { userId: byId, role: 'hr' }, actorId: ADMIN.userId })).organizationUser.userId, byId);

  const enrolled = await b2bService.enrollBeneficiary({ access: a, body: { phone: `0${phone.slice(4)}`, status: 'active' }, actorId: ADMIN.userId });
  assert.deepEqual([enrolled.beneficiary.userId, enrolled.beneficiary.status], [beneficiaryUser, 'active']);
  assert.equal((await b2bService.enrollBeneficiary({ access: a, body: { phone }, actorId: ADMIN.userId })).error, 'already_enrolled');
  // Only a member account can be a beneficiary.
  const coachEmail = `coach2.${tag}@contact.test`;
  const coach = await account('trainer', { email: coachEmail });
  assert.equal((await b2bService.enrollBeneficiary({ access: a, body: { email: coachEmail }, actorId: ADMIN.userId })).error, 'beneficiary_must_be_member');
  assert.equal((await b2bService.enrollBeneficiary({ access: a, body: { userId: coach }, actorId: ADMIN.userId })).error, 'beneficiary_must_be_member');
});

test('a company employee is linked to their member account by email or mobile number', async () => {
  const { account: corp } = await corporateService.onboard({ body: { companyName: `Contact Corp ${uid('c')}`, industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'fully_funded', passTier: 'pro', seatLimit: 5 }, actorId: ADMIN.userId });
  made.corporates.push(corp.id);
  await corporateService.setStatus({ corporateId: corp.id, status: 'active', actorId: ADMIN.userId });
  const { employee } = await corporateService.provisionStaff({ corporateId: corp.id, body: { displayName: 'Zawadi Kimaro', department: 'Finance' }, actorId: ADMIN.userId });
  const email = `zawadi.${tag}@contact.test`;
  const memberId = await account('member', { email });

  const link = body => corporateService.linkEmployeeUser({ corporateId: corp.id, employeeId: employee.id, actorId: ADMIN.userId, actorType: 'admin', ...body });
  assert.equal((await link({ email: `nobody.${tag}@contact.test` })).error, 'user_not_found');
  assert.equal((await link({ email })).employee.userId, memberId);
  assert.equal((await link({ userId: null })).employee.userId, null);   // unlink, as before
  assert.equal((await link({ userId: memberId })).employee.userId, memberId);
  const trainerEmail = `trainer.${tag}@contact.test`;
  await account('trainer', { email: trainerEmail });
  assert.equal((await link({ email: trainerEmail })).error, 'user_must_be_member');
});

test('an email or number only typed onto a profile finds nobody: same user_not_found for organisation users, beneficiaries and company links', async () => {
  // Someone puts a colleague's email and number on their own profile (POST /me/profile accepts any value).
  const plantedEmail = `planted.${tag}@contact.test`;
  const plantedPhone = phoneNo();
  const planter = await account('member', { email: plantedEmail, phone: plantedPhone, verified: false });

  assert.deepEqual(await find({ email: plantedEmail }).then(r => [r.error, r.status]), ['user_not_found', 404]);
  assert.deepEqual(await find({ phone: plantedPhone }, { require: 'member' }).then(r => [r.error, r.status]), ['user_not_found', 404]);
  // Without the verified-contacts helper nobody is found by contact at all (fail closed); a user id still works.
  const verifiedEmail = `real.${tag}@contact.test`;
  const real = await account('member', { email: verifiedEmail });
  assert.equal((await findUserByContact(users, { email: verifiedEmail })).error, 'user_not_found');
  assert.equal((await findUserByContact(users, { userId: real })).user.id, real);

  const orgId = await sponsor();
  const a = await access(orgId);
  for (const body of [{ email: plantedEmail.toUpperCase() }, { phone: plantedPhone }]) {
    const role = await b2bService.addOrganizationUser({ access: a, body: { ...body, role: 'hr' }, actorId: ADMIN.userId });
    assert.deepEqual([role.error, role.status], ['user_not_found', 404], JSON.stringify(body));
    const ben = await b2bService.enrollBeneficiary({ access: a, body: { ...body, status: 'active' }, actorId: ADMIN.userId });
    assert.deepEqual([ben.error, ben.status], ['user_not_found', 404], JSON.stringify(body));
  }
  assert.equal(await db('B2BOrganizationUser').where({ organizationId: orgId, userId: planter }).count('* as n').first().then(r => Number(r.n)), 0);
  assert.equal(await db('B2BBeneficiary').where({ organizationId: orgId, userId: planter }).count('* as n').first().then(r => Number(r.n)), 0);

  const { account: corp } = await corporateService.onboard({ body: { companyName: `Planted Corp ${uid('c')}`, industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'fully_funded', passTier: 'pro', seatLimit: 5 }, actorId: ADMIN.userId });
  made.corporates.push(corp.id);
  await corporateService.setStatus({ corporateId: corp.id, status: 'active', actorId: ADMIN.userId });
  const { employee } = await corporateService.provisionStaff({ corporateId: corp.id, body: { displayName: 'Planted Target', department: 'Ops' }, actorId: ADMIN.userId });
  for (const body of [{ email: plantedEmail }, { phone: plantedPhone }]) {
    const out = await corporateService.linkEmployeeUser({ corporateId: corp.id, employeeId: employee.id, actorId: ADMIN.userId, actorType: 'admin', ...body });
    assert.deepEqual([out.error, out.status], ['user_not_found', 404], JSON.stringify(body));
  }

  // Once the real owner verifies the number, it finds them, not the planter.
  // (The planter's row still holds it in User.phone; the verified record lives in LoginIdentifier.)
  const owner = await account('member');
  await verifyContacts(db, owner, { phone: plantedPhone });
  assert.equal((await find({ phone: plantedPhone }, { require: 'member' })).user.id, owner);

  // A suspended or closed Person is not found by contact.
  const closedEmail = `closed.${tag}@contact.test`;
  const closed = await account('member', { email: closedEmail });
  await db('Person').where({ id: (await db('User').where({ id: closed }).first('personId')).personId }).update({ status: 'suspended' });
  assert.equal((await find({ email: closedEmail })).error, 'user_not_found');
});
