// Invitation SMS as it is wired in production: through the shared SMS
// service, so each one is a row in SmsLog of kind `invitation`.
process.env.SMS_PROVIDER = 'fake';   // before the services are built; ignored in production

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { ensureInit } = await import('../functions/index.mjs');
const { db } = await import('../src/infra/knex-store.mjs');
const { b2bService, b2bBeneficiaryImportService: people, smsService } = await import('../src/bootstrap/services.mjs');
const { SMS_CATEGORIES } = await import('../src/services/sms-service.mjs');

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [], phones: [] };
after(async () => {
  await db('SmsLog').whereIn('phone', made.phones).del();
  await db('B2BBeneficiaryInvite').whereIn('organizationId', made.orgs).del();
  await db('B2BBeneficiaryImport').whereIn('organizationId', made.orgs).del();
  await db('AuditLog').whereIn('actor', made.users).del();
  await db('B2BOrganization').whereIn('id', made.orgs).del();
  await db('User').whereIn('id', made.users).del();
});

test('an invitation SMS goes through the shared SMS service and is logged as an invitation', async () => {
  const operator = uid('usr');
  await db('User').insert({ id: operator, userType: 'admin', displayName: 'Wiring operator', updatedAt: new Date() });
  made.users.push(operator);
  const { organization } = await b2bService.createOrganization({ body: { organizationType: 'employer', legalName: `Wiring ${uid('o')}`, tradingName: 'Wiring Co' }, actorId: operator });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: operator });
  const access = await b2bService.resolveAccess({ organizationId: organization.id, userType: 'admin', userId: operator });
  const phone = `+2557139${String(Math.floor(Math.random() * 90000) + 10000)}`;
  made.phones.push(phone);

  const out = await people.importPeople({ access, body: { rows: [{ name: 'Wired Person', phone }] }, actorId: operator });
  assert.deepEqual([out.invited, out.smsConfigured], [1, true]);
  const invite = await db('B2BBeneficiaryInvite').where({ organizationId: organization.id, phone }).first();
  const sent = await people.sendDue({ inviteIds: [invite.id] });
  assert.deepEqual([sent.sms.sent, sent.sms.failed], [1, 0]);

  const [log] = await db('SmsLog').where({ phone });
  assert.deepEqual([log.category, log.status, /^Wiring Co added you to its wellness programme on FitFlex\./.test(log.message)], ['invitation', 'accepted', true]);
  assert.ok(SMS_CATEGORIES.includes('invitation'));
  // The admin SMS log can be filtered to invitations.
  const listed = await smsService.logs({ category: 'invitation', limit: 5 });
  assert.ok(!listed.error && Array.isArray(listed.items ?? listed.logs ?? listed.rows ?? []));
  assert.equal((await db('B2BBeneficiaryInvite').where({ id: invite.id }).first()).smsSent, 1);
});
