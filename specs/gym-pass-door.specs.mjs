// Custom gym passes, phase 5A: door and check-in correctness (GYM_CUSTOM_PASSES). Manual check-in attributes the visit to the pass, a removed
// person is no longer the gym's member, and the door preview shows the pass (name, category, dates only) and a paused pass as inactive.
// Against the CI database; channels are fakes, money is staff approval of a manual payment through the real payment service.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { ensureInit } from '../functions/index.mjs';
import { gyms, users, subscriptions, paymentRequests, auditLog } from '../src/bootstrap/collections.mjs';
import { verifiedContacts, gymPassStore, checkInService, operatorService, memberManagement } from '../src/bootstrap/services.mjs';
import { createGymPassService } from '../src/services/gym-pass-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { issue as issueQr } from '../src/auth/qr-token.mjs';
import { latestDirectSubscriptionsByMember } from '../src/shared/member-status.mjs';
import { verifyContacts } from './fixtures/verified-contacts.mjs';

await ensureInit();

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], gyms: [] };
const DAY = 86_400_000;
let seq = 0;
const phoneNo = () => `+2557${String(10000000 + Math.floor(Math.random() * 89999999)).slice(0, 8)}`;

afterEach(() => { delete process.env.GYM_CUSTOM_PASSES; });

async function member() {
  const id = uid('usr'); const phone = phoneNo();
  seq += 1;
  await db('User').insert({ id, userType: 'member', displayName: `Door Member ${seq}`, phone: null, updatedAt: new Date() });
  made.users.push(id);
  await verifyContacts(db, id, { phone, email: null });
  return { id, phone };
}
async function gym() {
  const id = uid('gym');
  await gyms.insertAsync({ id, name: 'Door Gym', tier: 'standard', location: 'Dar es Salaam', status: 'active' });
  made.gyms.push(id);
  return id;
}
async function owner(gymIds) {
  const id = uid('own');
  await db('User').insert({ id, userType: 'gym_operator', displayName: 'Door Owner', gymIds, gymId: gymIds[0], updatedAt: new Date() });
  made.users.push(id);
  return { id, gymIds, gymId: gymIds[0], userType: 'gym_operator' };
}
function kit() {
  const svc = createGymPassService({
    store: gymPassStore, gyms, users, auditLog,
    contacts: { findMember: verifiedContacts.findMember, contactsFor: verifiedContacts.contactsFor },
    notify: async () => ({}),
    channels: { whatsapp: async () => ({ status: 'skipped:whatsapp_not_available' }), sms: async () => ({ status: 'sent' }) },
    baseLink: () => 'https://app.test',
  });
  const pay = createAdminPaymentService({
    paymentRequests, subscriptions, users, auditLog, gyms,
    onPassPayment: (request, status, opts) => svc.onPaymentStatus(request, status, opts),
  });
  return { svc, pay };
}
async function plan(k, own, gymId, body = {}) {
  const out = await k.svc.createPlan({ owner: own, gymId, actorId: own.id, body: { name: 'Door Pass', category: 'individual', durationValue: 30, durationUnit: 'days', priceTzs: 50_000, ...body } });
  assert.equal(out.status, 201, JSON.stringify(out));
  return out.plan;
}
async function buy(k, buyer, planId, extra = {}) {
  const out = await k.svc.purchase({ memberId: buyer.id, planId, ...extra });
  assert.equal(out.status, 202, JSON.stringify(out));
  return out;
}
const approve = (k, out) => k.pay.decide({ id: out.paymentRequest.id, decision: 'approve', actorId: 'adm_door', reference: `DR${randomUUID().slice(0, 8).toUpperCase()}` });
const personOf = (purchaseId, userId) => db('GymPassBeneficiary').where({ purchaseId, userId }).first();

after(async () => {
  const purchaseIds = await db('GymPassPurchase').whereIn('gymId', made.gyms).pluck('id');
  const paymentIds = await db('PaymentRequest').whereIn('gymId', made.gyms).pluck('id');
  await db('Checkin').whereIn('gymId', made.gyms).del();
  await db('Subscription').whereIn('memberId', made.users).del();
  await db('GymPassBeneficiary').whereIn('purchaseId', purchaseIds).del();
  await db('GymPassPurchase').whereIn('id', purchaseIds).del();
  await db('PaymentRequest').whereIn('id', paymentIds).del();
  await db('GymPassPlan').whereIn('gymId', made.gyms).del();
  await db('Gym').whereIn('id', made.gyms).del();
  await db('AuditLog').whereIn('actor', [...made.users, 'adm_door']).del().catch(() => {});
  await db('User').whereIn('id', made.users).del();
});

/** A gym with a paid couples pass (buyer + friend) and a person on a legacy direct plan. */
async function world() {
  process.env.GYM_CUSTOM_PASSES = 'on';
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const pair = await plan(k, o, g, { name: 'Pair Pass', category: 'couples', durationValue: 1, durationUnit: 'months', priceTzs: 70_000 });
  const buyer = await member(); const friend = await member(); const legacy = await member();
  const sale = await buy(k, buyer, pair.id, { beneficiaries: [{ phone: friend.phone }] });
  await approve(k, sale);
  const legacySub = {
    id: uid('sub'), memberId: legacy.id, type: 'direct_sub', tier: null, plan: 'monthly', status: 'active', homeGymId: g,
    startedAt: new Date().toISOString(), cycleStartedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 20 * DAY).toISOString(), renewsAt: new Date(Date.now() + 20 * DAY).toISOString(),
  };
  await subscriptions.insertAsync(legacySub);
  return { k, g, o, pair, sale, buyer, friend, legacy, legacySub };
}

test('manual check-in of a pass person is attributed to the pass and the person, and shows in utilisation', async () => {
  const w = await world();
  const out = await memberManagement.checkInMember({ owner: w.o, memberId: w.friend.id, gymId: w.g });
  assert.equal(out.ok, true, JSON.stringify(out));
  const row = await db('Checkin').where({ id: out.checkin.id }).first();
  const person = await personOf(w.sale.purchase.id, w.friend.id);
  assert.equal(row.passPurchaseId, w.sale.purchase.id);
  assert.equal(row.beneficiaryId, person.id);
  assert.equal(row.source, 'owner_manual');
  const sum = await w.k.svc.summary({ owner: w.o, gymId: w.g });
  assert.equal(sum.utilisation.visits, 1);
  assert.equal(sum.utilisation.peopleWithVisit, 1);
  assert.equal(sum.utilisation.peopleNeverVisited, 1, 'the buyer has not visited');
  // a legacy direct plan checked in by hand records no pass
  const legacy = await memberManagement.checkInMember({ owner: w.o, memberId: w.legacy.id, gymId: w.g });
  assert.equal(legacy.ok, true);
  const legacyRow = await db('Checkin').where({ id: legacy.checkin.id }).first();
  assert.equal(legacyRow.passPurchaseId, null);
  assert.equal(legacyRow.beneficiaryId, null);
});

test('a removed pass person is no longer the gym\'s member: not checked in by hand, not in the member facts; legacy plans are unchanged', async () => {
  const w = await world();
  const person = await personOf(w.sale.purchase.id, w.friend.id);
  await w.k.svc.removeBeneficiary({ purchaseId: w.sale.purchase.id, beneficiaryId: person.id, actor: { userId: w.buyer.id } });
  const sub = await db('Subscription').where({ passBeneficiaryId: person.id }).first();
  assert.equal(sub.status, 'cancelled');
  const refused = await memberManagement.checkInMember({ owner: w.o, memberId: w.friend.id, gymId: w.g });
  assert.deepEqual([refused.error, refused.status], ['not_your_member', 403]);

  const all = await db('Subscription').whereIn('memberId', [w.friend.id, w.buyer.id, w.legacy.id]);
  const latest = latestDirectSubscriptionsByMember(all, [w.g]);
  assert.equal(latest.has(w.friend.id), false, 'the removed person is not a direct member');
  assert.equal(latest.has(w.buyer.id), true);
  assert.equal(latest.get(w.legacy.id).id, w.legacySub.id);

  // a legacy direct plan that was cancelled keeps today's behaviour (still listed)
  await db('Subscription').where({ id: w.legacySub.id }).update({ status: 'cancelled' });
  const afterCancel = latestDirectSubscriptionsByMember(await db('Subscription').where({ memberId: w.legacy.id }), [w.g]);
  assert.equal(afterCancel.has(w.legacy.id), true, 'legacy cancelled plans are unchanged');
});

test('door preview: a pass holder shows the pass name, category and dates only; others show null; flag off adds no key', async () => {
  const w = await world();
  const operator = { id: w.o.id, gymIds: [w.g], gymId: w.g, userType: 'gym_operator' };
  const pv = await operatorService.verifyQr({ operator, gymId: w.g, qrToken: issueQr(w.friend.id).token });
  assert.equal(pv.status, 200);
  assert.equal(pv.body.eligible, true);
  assert.deepEqual(Object.keys(pv.body.pass).sort(), ['category', 'daysLeft', 'expiresAt', 'name', 'status']);
  assert.equal(pv.body.pass.name, 'Pair Pass');
  assert.equal(pv.body.pass.category, 'couples');
  assert.equal(pv.body.pass.status, 'active');
  assert.ok(pv.body.pass.daysLeft >= 29 && pv.body.pass.daysLeft <= 31);
  const text = JSON.stringify(pv.body);
  assert.ok(!text.includes(w.buyer.id) && !text.includes(w.buyer.phone) && !text.includes(w.friend.phone), 'no buyer, group-mate or contact data at the door');

  const legacy = await operatorService.verifyQr({ operator, gymId: w.g, qrToken: issueQr(w.legacy.id).token });
  assert.equal(legacy.body.pass, null);

  process.env.GYM_CUSTOM_PASSES = 'off';
  const off = await operatorService.verifyQr({ operator, gymId: w.g, qrToken: issueQr(w.friend.id).token });
  assert.equal('pass' in off.body, false, 'flag off: the body is as before');
});

test('door check-in response carries the pass; a legacy visit carries null', async () => {
  const w = await world();
  const operator = { id: w.o.id, gymIds: [w.g], gymId: w.g, userType: 'gym_operator' };
  const ci = await operatorService.checkIn({ operator, gymId: w.g, qrToken: issueQr(w.buyer.id).token });
  assert.equal(ci.status, 200, JSON.stringify(ci.body));
  assert.equal(ci.body.pass.name, 'Pair Pass');
  assert.equal(ci.body.checkin.passPurchaseId, w.sale.purchase.id);
  const legacy = await operatorService.checkIn({ operator, gymId: w.g, qrToken: issueQr(w.legacy.id).token });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.pass, null);
});

test('door preview of a paused pass says inactive, as the check-in does; a legacy paused plan and no pass at all keep today\'s answers', async () => {
  const w = await world();
  const operator = { id: w.o.id, gymIds: [w.g], gymId: w.g, userType: 'gym_operator' };
  const person = await personOf(w.sale.purchase.id, w.friend.id);
  assert.ok((await w.k.svc.suspendBeneficiary({ purchaseId: w.sale.purchase.id, beneficiaryId: person.id, actor: { owner: w.o } })).beneficiary);

  const pv = await operatorService.verifyQr({ operator, gymId: w.g, qrToken: issueQr(w.friend.id).token });
  assert.equal(pv.body.eligible, false);
  assert.equal(pv.body.reason, 'subscription_inactive');
  assert.deepEqual(pv.body.subscription, { tier: null, status: 'suspended' });
  assert.equal(pv.body.pass.status, 'suspended');
  const refused = await checkInService.perform({ memberId: w.friend.id, gymId: w.g });
  assert.deepEqual([refused.ok, refused.failure], [false, 'subscription_inactive'], 'the preview and the check-in agree');

  // a legacy direct plan the gym paused keeps the old preview
  await db('Subscription').where({ id: w.legacySub.id }).update({ status: 'suspended' });
  const old = await operatorService.verifyQr({ operator, gymId: w.g, qrToken: issueQr(w.legacy.id).token });
  assert.equal(old.body.reason, 'no_active_pass');
  assert.equal(old.body.subscription, null);
  // someone with no pass at all
  const nobody = await member();
  const none = await operatorService.verifyQr({ operator, gymId: w.g, qrToken: issueQr(nobody.id).token });
  assert.equal(none.body.reason, 'no_active_pass');
  assert.equal(none.body.pass, null);
});
