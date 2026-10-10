// Adding people by the email or mobile number of their FitFlex account,
// instead of a user id: organisation users, beneficiaries and a company
// employee's link to their member account. Against the CI database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { b2bService, corporateService } from '../src/bootstrap/services.mjs';
import { users } from '../src/bootstrap/collections.mjs';
import { findUserByContact } from '../src/shared/user-contact.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [], corporates: [] };
const tag = randomUUID().slice(0, 6);
let seq = 0;
const phoneNo = () => `+2557${String(10000000 + Math.floor(Math.random() * 89999999)).slice(0, 8)}`;

async function account(userType, { email = null, phone = null } = {}) {
  const id = uid('usr');
  seq += 1;
  await db('User').insert({ id, userType, displayName: `Contact ${userType} ${seq}`, email, phone, updatedAt: new Date() });
  made.users.push(id);
  return id;
}
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
  await db('User').whereIn('id', made.users).del();
});

test('finding an account by email or mobile number: one contact, normalised, the right kind of account', async () => {
  const email = `grace.${tag}@contact.test`;
  const phone = phoneNo();
  const member = await account('member', { email, phone });
  const trainer = await account('trainer', { email });

  assert.equal((await findUserByContact(users, {})).error, 'user_contact_required');
  assert.equal((await findUserByContact(users, { email, phone })).error, 'one_user_contact_only');
  assert.equal((await findUserByContact(users, { email: 'not-an-email' })).error, 'invalid_email');
  assert.equal((await findUserByContact(users, { phone: '12' })).error, 'invalid_phone');
  assert.deepEqual(await findUserByContact(users, { email: `nobody.${tag}@contact.test` }).then(r => [r.error, r.status]), ['user_not_found', 404]);

  // Case and spacing don't matter; local and international forms of a number are the same number.
  assert.equal((await findUserByContact(users, { email: `  GRACE.${tag}@Contact.Test ` }, { prefer: 'member' })).user.id, member);
  const local = `0${phone.slice(4, 7)} ${phone.slice(7, 10)} ${phone.slice(10)}`;
  for (const p of [phone, local, phone.slice(1), phone.slice(4)]) assert.equal((await findUserByContact(users, { phone: p })).user.id, member, p);
  assert.equal((await findUserByContact(users, { userId: trainer })).user.id, trainer);

  // Two accounts share the email: a member account is preferred, or required; without either the caller must say which.
  assert.equal((await findUserByContact(users, { email }, { require: 'member' })).user.id, member);
  const which = await findUserByContact(users, { email });
  assert.deepEqual([which.error, which.status, which.found.map(f => f.userType).sort()], ['ambiguous_user', 409, ['member', 'trainer']]);
  const onlyTrainer = `coach.${tag}@contact.test`;
  const coach = await account('trainer', { email: onlyTrainer });
  assert.equal((await findUserByContact(users, { email: onlyTrainer }, { prefer: 'member' })).user.id, coach);
  assert.deepEqual(await findUserByContact(users, { email: onlyTrainer }, { require: 'member' }).then(r => [r.error, r.found]), ['member_account_required', ['trainer']]);
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

  const link = body => corporateService.linkEmployeeUser({ corporateId: corp.id, employeeId: employee.id, actorId: ADMIN.userId, ...body });
  assert.equal((await link({ email: `nobody.${tag}@contact.test` })).error, 'user_not_found');
  assert.equal((await link({ email })).employee.userId, memberId);
  assert.equal((await link({ userId: null })).employee.userId, null);   // unlink, as before
  assert.equal((await link({ userId: memberId })).employee.userId, memberId);
  const trainerEmail = `trainer.${tag}@contact.test`;
  await account('trainer', { email: trainerEmail });
  assert.equal((await link({ email: trainerEmail })).error, 'user_must_be_member');
});
