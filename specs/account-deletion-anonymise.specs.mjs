// DELETE /me keeps payment and check-in records, anonymised (owner decision 2026-10-30).
// Against the CI database only: everything here writes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { deleteMyAccount } from '../functions/subscriptions.mjs';
import {
  portalFirebaseAdmin, gymReviewService, shopService, adminPaymentService, trainerBookingService, trainers,
} from '../src/bootstrap/services.mjs';
import { checkins, users } from '../src/bootstrap/collections.mjs';
import { createFinanceService } from '../src/services/finance-service.mjs';
import { createAccountErasure } from '../src/infra/account-erasure-store-pg.mjs';
import { createSettlementConfigService } from '../src/services/settlement-config-service.mjs';
import { createSettlementService, periodForMonth } from '../src/services/settlement-service.mjs';
import { DELETED_PERSON_LABEL } from '../src/shared/deleted-person.mjs';
import { firebaseAdminConfigured } from '../src/shared/firebase-identity.mjs';

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const PERSON_NAME = 'Asha Kipengele';
const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
async function del(id, userType = 'member') {
  const out = res();
  await deleteMyAccount.onRequest({ user: { sub: id, userType } }, out);
  return out;
}

// Firebase: a fake, so nothing here can reach a real project.
const firebase = { deleted: [], failNext: null };
const original = { ...portalFirebaseAdmin };
before(async () => {
  const { rows } = await db.raw('select current_database() as name');
  assert.match(rows[0].name, /^fitflex_ci/, 'refusing to run against a database that is not a CI database');
  portalFirebaseAdmin.init = () => {};
  portalFirebaseAdmin.configured = () => true;
  portalFirebaseAdmin.auth = () => ({
    deleteUser: async (uidToDelete) => {
      if (firebase.failNext) { const err = firebase.failNext; firebase.failNext = null; throw err; }
      firebase.deleted.push(uidToDelete);
    },
  });
});
after(() => { Object.assign(portalFirebaseAdmin, original); });

const ROLLBACK = Symbol('rollback');
async function inRollback(fn) {
  try { await db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; }); } catch (err) { if (err !== ROLLBACK) throw err; }
}

/** A member with something in nearly every table this change touches. */
async function world() {
  const at = new Date();
  const id = uid('usr_del');
  const phone = `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const email = `${id}@example.com`;
  const firebaseUid = uid('fb');
  const gymId = uid('gym_del');
  const vendorId = uid('usr_vendor');
  await db('Gym').insert({ id: gymId, name: 'Deletion Gym', tier: 'standard', location: 'Dar', updatedAt: at });
  await db('User').insert({ id: vendorId, userType: 'vendor', displayName: 'Shop', accountStatus: 'active', approvalStatus: 'approved', updatedAt: at });
  await db('User').insert({ id, userType: 'member', displayName: PERSON_NAME, phone, email, firebaseUid, photoUrl: '/storage/x/asha.jpg', accountStatus: 'active', updatedAt: at });
  const { personId } = await db('User').where({ id }).first('personId');
  await db('Person').where({ id: personId }).update({ pinHash: 'hash', displayName: PERSON_NAME, dateOfBirth: '1990-01-01', gender: 'female' });
  await db('LoginIdentifier').insert([
    { id: uid('lid'), personId, type: 'phone', value: phone, normalizedValue: phone, verifiedAt: at, provider: 'phone' },
    { id: uid('lid'), personId, type: 'email', value: email, normalizedValue: email, verifiedAt: at, provider: 'firebase' },
  ]);
  const subId = uid('sub');
  const passEnds = new Date(+at + 30 * 86_400_000);
  const payId = uid('pay');
  const upgradePayId = uid('pay');
  const checkinId = uid('chk');
  const bookingGym = gymId;
  await db('Subscription').insert({ id: subId, memberId: id, type: 'platform_pass', tier: 'premium', status: 'active', startedAt: at, cycleStartedAt: at, renewsAt: passEnds, expiresAt: passEnds });
  await db('PaymentRequest').insert([
    { id: payId, memberId: id, subscriptionId: subId, tier: 'premium', amountTzs: 250000, status: 'approved', provider: 'admin_approved', payerPhone: phone, note: 'called Asha on her mobile', requestedAt: at, memberReference: 'QGH7XK2L9P' },
    { id: upgradePayId, memberId: id, subscriptionId: subId, tier: 'premium', amountTzs: 50000, status: 'approved', provider: 'admin_approved', note: `upgrade:${subId}:pro`, requestedAt: at },
  ]);
  await db('Checkin').insert({
    id: checkinId, memberId: id, gymId, timestamp: at, method: 'gym_scanned', subscriptionType: 'platform_pass', passTier: 'premium', visitNumberInCycle: 1, gymTier: 'standard',
    creditsDeductedTzs: 0, visitConsumed: true, status: 'valid', subscriptionId: subId, businessDate: '2026-10-30', source: 'member_qr_by_staff', authSessionId: 'sess', clientMeta: JSON.stringify({ platform: 'web' }),
  });
  await db('Refund').insert({ id: uid('rfd'), memberId: id, kind: 'subscription', paymentRequestId: payId, amountTzs: 1000, reasonCode: 'other', note: 'Asha asked', paidTo: phone, status: 'requested', createdAt: at, updatedAt: at });
  await db('TrainerSession').insert({ id: uid('ses'), trainerId: uid('trn'), memberId: id, customerName: PERSON_NAME, customerEmail: email, customerPhone: phone, date: '2026-10-30', slot: '10:00', source: 'manual', status: 'scheduled', amountTzs: 20000 });
  const orderId = uid('ord');
  await db('ShopOrder').insert({ id: orderId, buyerId: id, buyerRole: 'member', items: JSON.stringify([{ productId: uid('prd'), vendorId, name: 'Mat', qty: 1, priceTzs: 30000 }]), totalTzs: 30000, status: 'delivered', paymentStatus: 'paid', deliveryMethod: 'home_delivery', deliveryAddress: 'Plot 12, Sinza', note: 'Call Asha at the gate', paidAt: at, updatedAt: at });
  const gymReview = uid('grev');
  await db('GymReview').insert({ id: gymReview, gymId, memberId: id, rating: 4, text: 'Asha loves this gym', status: 'published', updatedAt: at });
  await db('DeviceToken').insert({ id: uid('dvc'), userId: id, token: uid('token'), platform: 'android' });
  await db('Notification').insert({ id: uid('ntf'), userId: id, type: 't', title: 't', body: 'b' });
  await db('Activity').insert({ id: uid('act'), userId: id, type: 'run', source: 'manual', startedAt: at, durationMinutes: 30, createdAt: at });
  const activity = await db('Activity').where({ userId: id }).first('id');
  await db('ActivityRoute').insert({ id: activity.id, userId: id, segments: JSON.stringify([[[-6.8, 39.2]]]) });
  await db('TrainerEngagement').insert({ id: uid('eng'), memberId: id, trainerId: uid('trn'), type: 'enquiry', message: 'Hi, this is Asha', messages: JSON.stringify([]) });
  await db('MarketplaceEnquiry').insert({ id: uid('enq'), buyerId: id, vendorId, status: 'open', messages: JSON.stringify([{ message: 'Hi' }]), updatedAt: at });
  await db('SmsLog').insert({ id: uid('sms'), userId: id, phone, category: 'x', message: `Hello ${PERSON_NAME}`, status: 'sent' });
  await db('VerificationCode').insert({ id: uid('vcd'), purpose: 'login', personId, requestedBy: 'member', identifierType: 'phone', identifierValue: phone, channel: 'sms', codeHash: 'h', attempts: 0, expiresAt: at });
  await db('FriendInvitation').insert({ id: uid('fin'), inviterId: vendorId, identifierType: 'phone', identifierValue: phone, tokenHash: uid('tok'), status: 'pending', expiresAt: at, updatedAt: at });
  const recovery = uid('arc');
  await db('AccountRecovery').insert({ id: recovery, personId, oldIdentifierType: 'phone', oldIdentifierValue: phone, newIdentifierType: 'email', newIdentifierValue: email, claimedName: PERSON_NAME, evidence: JSON.stringify({ q: 'a' }), waitUntil: at, requestIp: '10.0.0.1' });
  await db('AccountRecoveryEvent').insert({ id: uid('are'), recoveryId: recovery, kind: 'note', detail: JSON.stringify({ note: 'spoke to Asha' }) });
  await db('IdentityEvent').insert({ id: uid('ide'), kind: 'link', personId, trigger: 'test', identifierType: 'phone', normalizedValue: phone, details: JSON.stringify({ phone }) });
  await db('AuditLog').insert({ id: randomUUID(), at, actor: 'admin', action: 'member_updated', target: id, before: JSON.stringify({ email, phone, displayName: PERSON_NAME, userType: 'member' }), after: JSON.stringify({ phone }) });
  return { id, phone, email, firebaseUid, personId, gymId, vendorId, subId, payId, upgradePayId, checkinId, orderId, gymReview, recovery };
}

/** Every string in these rows, for a plain "is it still in there" search. */
const flat = rows => JSON.stringify(rows);

test('a member\'s payments, pass, check-ins and order stay with the same amounts; the person is gone from them', async () => {
  const w = await world();
  const totals = async () => ({
    payments: Number((await db('PaymentRequest').where({ memberId: w.id }).sum('amountTzs as s').first()).s),
    checkins: Number((await db('Checkin').where({ gymId: w.gymId }).count('id as c').first()).c),
    subs: (await db('Subscription').where({ id: w.subId }).first('tier', 'status', 'expiresAt')),
    order: (await db('ShopOrder').where({ id: w.orderId }).first('totalTzs', 'status', 'paymentStatus', 'items')),
    refunds: Number((await db('Refund').where({ memberId: w.id }).sum('amountTzs as s').first()).s),
    rating: (await db('GymReview').where({ gymId: w.gymId }).first('rating')).rating,
  });
  const beforeDelete = await totals();

  const out = await del(w.id);
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.body, { ok: true, message: 'Your account and personal data have been deleted.' });
  assert.deepEqual(firebase.deleted.at(-1), w.firebaseUid);

  assert.deepEqual(await totals(), beforeDelete);
  assert.equal(await db('User').where({ id: w.id }).first(), undefined);

  const pay = await db('PaymentRequest').where({ id: w.payId }).first();
  assert.equal(pay.payerPhone, null);
  assert.equal(pay.note, null);
  assert.equal(pay.memberReference, 'QGH7XK2L9P', 'the transaction reference stays: it is how a payment is reconciled');
  assert.equal((await db('PaymentRequest').where({ id: w.upgradePayId }).first()).note, `upgrade:${w.subId}:pro`, 'settlement reads this note');

  const checkin = await db('Checkin').where({ id: w.checkinId }).first();
  assert.equal(checkin.clientMeta, null);
  assert.equal(checkin.authSessionId, null);
  assert.equal(checkin.status, 'valid');

  const order = await db('ShopOrder').where({ id: w.orderId }).first();
  assert.equal(order.deliveryAddress, null);
  assert.equal(order.note, null);

  const refund = await db('Refund').where({ memberId: w.id }).first();
  assert.deepEqual([refund.note, refund.paidTo], [null, null]);

  const session = await db('TrainerSession').where({ memberId: w.id }).first();
  assert.deepEqual([session.customerName, session.customerEmail, session.customerPhone], [DELETED_PERSON_LABEL, null, null]);

  assert.equal((await db('GymReview').where({ id: w.gymReview }).first()).text, null);

  // Nothing with the name or a contact survives in anything kept about this account.
  const kept = flat([
    await db('PaymentRequest').where({ memberId: w.id }), await db('Refund').where({ memberId: w.id }),
    await db('Checkin').where({ memberId: w.id }), await db('Subscription').where({ memberId: w.id }),
    await db('ShopOrder').where({ buyerId: w.id }), await db('TrainerSession').where({ memberId: w.id }),
    await db('GymReview').where({ memberId: w.id }), await db('AuditLog').where({ target: w.id }),
    await db('AccountRecovery').where({ id: w.recovery }), await db('AccountRecoveryEvent').where({ recoveryId: w.recovery }),
    await db('IdentityEvent').where({ personId: w.personId }), await db('Person').where({ id: w.personId }),
  ]);
  for (const secret of [PERSON_NAME, 'Asha', w.phone, w.email, 'Sinza', '10.0.0.1']) assert.ok(!kept.includes(secret), `${secret} is still stored`);
});

test('sign-in material, tokens, contacts, messages and personal activity are removed', async () => {
  const w = await world();
  assert.equal((await del(w.id)).statusCode, 200);
  for (const [table, where] of [
    ['DeviceToken', { userId: w.id }], ['Notification', { userId: w.id }], ['Activity', { userId: w.id }], ['ActivityRoute', { userId: w.id }],
    ['TrainerEngagement', { memberId: w.id }], ['MarketplaceEnquiry', { buyerId: w.id }], ['SmsLog', { phone: w.phone }],
    ['LoginIdentifier', { personId: w.personId }], ['VerificationCode', { personId: w.personId }], ['FriendInvitation', { identifierValue: w.phone }],
  ]) assert.equal((await db(table).where(where)).length, 0, `${table} still has rows`);
  const person = await db('Person').where({ id: w.personId }).first();
  assert.deepEqual([person.status, person.pinHash, person.displayName, person.dateOfBirth, person.gender], ['closed', null, null, null, null]);
  assert.equal((await db('AccountRecovery').where({ id: w.recovery }).first()).status, 'cancelled');
});

test('the audit row keeps who, what and when, and no contact details', async () => {
  const w = await world();
  assert.equal((await del(w.id)).statusCode, 200);
  const row = await db('AuditLog').where({ target: w.id, action: 'self_account_deleted' }).first();
  assert.equal(row.actor, w.id);
  assert.ok(row.at);
  assert.deepEqual(row.before, { userType: 'member' });
  assert.equal(row.after, null);
  const older = await db('AuditLog').where({ target: w.id, action: 'member_updated' }).first();
  assert.deepEqual(older.before, { userType: 'member' }, 'an earlier audit row loses the personal fields too');
});

test('Firebase refusing rolls everything back and says so; a retry finishes; a third press is 404', async () => {
  const w = await world();
  firebase.failNext = Object.assign(new Error('service unavailable'), { code: 'auth/internal-error' });
  const failed = await del(w.id);
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.error, 'account_deletion_failed');
  assert.ok(failed.body.messageSw);

  const user = await db('User').where({ id: w.id }).first();
  assert.equal(user.phone, w.phone, 'the account is untouched');
  assert.equal((await db('PaymentRequest').where({ id: w.payId }).first()).payerPhone, w.phone);
  assert.equal((await db('DeviceToken').where({ userId: w.id })).length, 1);
  assert.equal((await db('LoginIdentifier').where({ personId: w.personId })).length, 3);
  assert.equal((await db('Person').where({ id: w.personId }).first()).status, 'active');

  assert.equal((await del(w.id)).statusCode, 200);
  assert.equal(await db('User').where({ id: w.id }).first(), undefined);
  const third = await del(w.id);
  assert.equal(third.statusCode, 404);
  assert.equal(third.body.error, 'user_not_found');
});

test('a Firebase user that is already gone counts as done', async () => {
  const w = await world();
  firebase.failNext = Object.assign(new Error('no such user'), { code: 'auth/user-not-found' });
  assert.equal((await del(w.id)).statusCode, 200);
  assert.equal(await db('User').where({ id: w.id }).first(), undefined);
});

test('a failure in the database rolls back too: nothing half done', async () => {
  const w = await world();
  const before = firebase.deleted.length;
  await db.raw(`CREATE OR REPLACE FUNCTION spec_refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused by spec'; END; $$`);
  await db.raw(`CREATE TRIGGER spec_refuse BEFORE DELETE ON "DeviceToken" FOR EACH ROW WHEN (OLD."userId" = '${w.id}') EXECUTE FUNCTION spec_refuse_delete()`);
  try {
    assert.equal((await del(w.id)).statusCode, 503);
    assert.equal((await db('User').where({ id: w.id }).first()).phone, w.phone);
    assert.equal((await db('ShopOrder').where({ id: w.orderId }).first()).deliveryAddress, 'Plot 12, Sinza');
    assert.equal(firebase.deleted.length, before, 'Firebase is not touched when the database step failed');
  } finally {
    await db.raw('DROP TRIGGER spec_refuse ON "DeviceToken"');
    await db.raw('DROP FUNCTION spec_refuse_delete()');
  }
  assert.equal((await del(w.id)).statusCode, 200);
});

test('multi-persona: only this persona goes; the shared login, PIN and details stay', async () => {
  const w = await world();
  const otherId = uid('usr_other');
  await db('User').insert({ id: otherId, userType: 'trainer', displayName: PERSON_NAME, phone: w.phone, email: w.email, firebaseUid: w.firebaseUid, personId: w.personId, accountStatus: 'active', updatedAt: new Date() });
  const deletedBefore = firebase.deleted.length;

  assert.equal((await del(w.id)).statusCode, 200);
  assert.equal(firebase.deleted.length, deletedBefore, 'the Firebase login is shared');
  assert.equal(await db('User').where({ id: w.id }).first(), undefined);
  assert.ok(await db('User').where({ id: otherId }).first());
  const person = await db('Person').where({ id: w.personId }).first();
  assert.deepEqual([person.status, person.pinHash, person.displayName], ['active', 'hash', PERSON_NAME]);
  assert.equal((await db('LoginIdentifier').where({ personId: w.personId })).length, 3);
  assert.equal((await db('SmsLog').where({ phone: w.phone })).length, 0, 'this persona\'s own message log still goes');
  assert.equal((await db('FriendInvitation').where({ identifierValue: w.phone })).length, 1, 'contact-keyed rows stay: the person is still here');
  // This persona's records are still anonymised.
  assert.equal((await db('PaymentRequest').where({ id: w.payId }).first()).payerPhone, null);
});

test('a persona on its own Firebase login loses that login; the person\'s other sign-in stays', async () => {
  const w = await world();
  const otherId = uid('usr_other');
  await db('User').insert({ id: otherId, userType: 'trainer', firebaseUid: uid('fb_other'), personId: w.personId, accountStatus: 'active', updatedAt: new Date() });
  assert.equal((await db('LoginIdentifier').where({ personId: w.personId, type: 'firebase_uid', normalizedValue: w.firebaseUid })).length, 1);
  assert.equal((await del(w.id)).statusCode, 200);
  assert.equal(firebase.deleted.at(-1), w.firebaseUid);
  assert.equal((await db('LoginIdentifier').where({ personId: w.personId, type: 'firebase_uid', normalizedValue: w.firebaseUid })).length, 0);
  assert.equal((await db('Person').where({ id: w.personId }).first()).status, 'active');
});

test('off production with no Firebase credentials there is no login to delete; in production that is a fault', async () => {
  assert.equal(firebaseAdminConfigured({ NODE_ENV: 'production' }), true);
  assert.equal(firebaseAdminConfigured({ FIREBASE_SERVICE_ACCOUNT_JSON: '{}' }), true);
  const w = await world();
  const calls = firebase.deleted.length;
  portalFirebaseAdmin.configured = () => false;
  try {
    assert.equal((await del(w.id)).statusCode, 200);
  } finally {
    portalFirebaseAdmin.configured = () => true;
  }
  assert.equal(firebase.deleted.length, calls);
});

// Rolled back: another spec counts companies that have no organisation yet.
test('sponsor list: the person leaves it, the seat is freed, invoices and consumption stay', () => inRollback(async (trx) => {
  const w = await world();
  const at = new Date();
  const orgId = uid('b2bo');
  const corpId = uid('corp');
  await trx('B2BOrganization').insert({ id: orgId, organizationType: 'employer', legalName: 'Co', status: 'active', updatedAt: at });
  const beneficiaryId = uid('b2bb');
  await trx('B2BBeneficiary').insert({ id: beneficiaryId, organizationId: orgId, userId: w.id, externalReference: 'EMP-77', beneficiaryType: 'employee', status: 'active', updatedAt: at });
  await trx('B2BBeneficiaryInvite').insert({ id: uid('b2bi'), organizationId: orgId, phone: w.phone, displayName: PERSON_NAME, invitedBy: 'hr', status: 'invited', updatedAt: at });
  await trx('CorporateAccount').insert({ id: corpId, companyName: 'Co', industrySector: 'it', workforceBracket: '1-50', hrContactName: 'HR', hrContactPhone: '+255700000000', hrContactEmail: 'hr@example.com', subsidyModel: 'full', passTier: 'starter', seatLimit: 5, seatsUsed: 2, lipaNamba: '1', updatedAt: at });
  const employeeId = uid('emp');
  await trx('CorporateEmployee').insert({ id: employeeId, corporateId: corpId, userId: w.id, displayName: PERSON_NAME, phone: w.phone, email: w.email, pinHash: 'p', status: 'active', updatedAt: at });

  assert.equal((await createAccountErasure({ db: trx }).erase(w.id)).ok, true);

  const b = await trx('B2BBeneficiary').where({ id: beneficiaryId }).first();
  assert.deepEqual([b.userId, b.externalReference, b.status], [null, null, 'inactive']);
  assert.equal((await trx('B2BBeneficiaryInvite').where({ phone: w.phone })).length, 0);
  const e = await trx('CorporateEmployee').where({ id: employeeId }).first();
  assert.deepEqual([e.userId, e.displayName, e.phone, e.email, e.pinHash, e.status], [null, DELETED_PERSON_LABEL, null, null, null, 'exited']);
  assert.equal((await trx('CorporateAccount').where({ id: corpId }).first()).seatsUsed, 1);
}));

// Rolled back: the events schema specs refuse to migrate down over rows.
test('event registration: the money stays, the person does, and the board shows nothing', () => inRollback(async (trx) => {
  const w = await world();
  const at = new Date();
  const organizerId = uid('org');
  const ownerId = uid('usr_owner');
  await trx('User').insert({ id: ownerId, userType: 'member', accountStatus: 'active', updatedAt: at });
  await trx('EventOrganizer').insert({ id: organizerId, ownerUserId: ownerId, name: 'Org', updatedAt: at });
  const eventId = `evt-${randomUUID().slice(0, 8)}`;
  await trx('Event').insert({ id: eventId, organizerId, slug: eventId, title: 'Run', eventType: 'road', status: 'published', publishedAt: at, startsAt: at, endsAt: at, updatedAt: at });
  const categoryId = uid('cat');
  await trx('EventCategory').insert({ id: categoryId, eventId, name: '5K', distanceMeters: 5000, updatedAt: at });
  const ticketTypeId = uid('tkt');
  await trx('EventTicketType').insert({ id: ticketTypeId, eventId, categoryId, name: 'Std', priceTzs: 10000, capacity: 10, updatedAt: at });
  const orderId = uid('eor');
  await trx('EventOrder').insert({ id: orderId, eventId, purchaserUserId: w.id, organizerId, status: 'confirmed', subtotalTzs: 10000, totalTzs: 10000, purchaserReference: 'Asha team', updatedAt: at, reference: uid('ref') });
  const lineId = uid('eol');
  await trx('EventOrderLine').insert({ id: lineId, orderId, eventId, ticketTypeId, quantity: 1, unitPriceTzs: 10000, lineTotalTzs: 10000 });
  const regId = uid('reg');
  await trx('EventRegistration').insert({ id: regId, eventId, categoryId, ticketTypeId, orderId, orderLineId: lineId, participantUserId: w.id, purchaserUserId: w.id, firstName: 'Asha', lastName: 'Kipengele', phone: w.phone, email: w.email, dateOfBirth: '1990-01-01', gender: 'female', emergencyContact: JSON.stringify({ name: 'Mama', phone: '+255700000000' }), consentBasis: 'self', status: 'confirmed', paidAmountTzs: 10000, claimedAt: at, updatedAt: at });

  assert.equal((await createAccountErasure({ db: trx }).erase(w.id)).ok, true);

  const r = await trx('EventRegistration').where({ id: regId }).first();
  assert.equal(`${r.firstName} ${r.lastName}`, DELETED_PERSON_LABEL);
  assert.deepEqual([r.phone, r.email, r.dateOfBirth, r.gender, r.emergencyContact, r.participantUserId, r.purchaserUserId, r.claimedAt], Array(8).fill(null));
  assert.equal(r.resultsVisibility, 'hidden');
  assert.equal(r.paidAmountTzs, 10000);
  const o = await trx('EventOrder').where({ id: orderId }).first();
  assert.deepEqual([o.totalTzs, o.purchaserUserId, o.purchaserReference], [10000, null, null]);
}));

test('read paths survive a missing person: reviews, vendor orders, admin payments, finance', async () => {
  const w = await world();
  assert.equal((await del(w.id)).statusCode, 200);

  const reviews = await gymReviewService.listForGym(w.gymId);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].rating, 4);
  assert.equal(reviews[0].text, null);
  assert.equal(reviews[0].memberName, 'FitFlex member');
  assert.equal(reviews[0].memberPhotoUrl, null);
  assert.equal((await gymReviewService.summary(w.gymId)).reviewCount, 1);

  const page = await shopService.vendorOrdersPage(w.vendorId, { limit: 10 });
  const order = page.orders.find(o => o.id === w.orderId);
  assert.ok(order, 'the vendor still sees the order');
  assert.deepEqual([order.buyer.displayName, order.buyer.forgotten], [null, true]);
  assert.equal(order.deliveryAddress ?? null, null);

  const payments = await adminPaymentService.list({});
  const rows = Array.isArray(payments) ? payments : (payments.payments ?? payments.items ?? []);
  const payment = rows.find(p => p.id === w.payId);
  assert.ok(payment, 'the payment is still listed');
  assert.equal(payment.member ?? null, null);

  const finance = createFinanceService({ gyms: { find: () => ({ id: w.gymId, name: 'Deletion Gym' }) }, checkins, users, settingsService: {} });
  const visit = (await finance.gymVisitDetails(w.gymId)).records.find(r => r.memberId === w.id);
  assert.equal(visit.memberName, DELETED_PERSON_LABEL);
  assert.equal(visit.memberEmail, null);
});

test('a trainer still sees a past booking of a deleted member, with no person on it', async () => {
  const at = new Date();
  const memberId = uid('usr_booker');
  const trainerUser = uid('usr_trn');
  const trainerId = uid('trn');
  await db('User').insert({ id: memberId, userType: 'member', displayName: PERSON_NAME, accountStatus: 'active', updatedAt: at });
  await db('User').insert({ id: trainerUser, userType: 'trainer', accountStatus: 'active', updatedAt: at });
  await trainers.insertAsync({ id: trainerId, userId: trainerUser, displayName: 'Coach', status: 'active', gymIds: [] });
  const bookingId = uid('bkg');
  const gymId = uid('gym_bkg');
  await db('Gym').insert({ id: gymId, name: 'Booking Gym', tier: 'standard', location: 'Dar', updatedAt: at });
  await db('TrainerBooking').insert({ id: bookingId, memberId, trainerId, gymId, date: '2026-10-30', slot: '10:00', amountTzs: 20000, trainerPayoutTzs: 18000, status: 'confirmed', updatedAt: at });

  assert.equal((await del(memberId)).statusCode, 200);

  const booking = await db('TrainerBooking').where({ id: bookingId }).first();
  assert.deepEqual([booking.amountTzs, booking.trainerPayoutTzs, booking.status], [20000, 18000, 'confirmed']);
  const day = await trainerBookingService.trainerSessionsForDate({ userId: trainerUser, date: '2026-10-30' });
  const row = (day.sessions ?? day).find(s => s.id === bookingId);
  assert.ok(row, 'the session is still on the trainer\'s day');
  assert.equal(row.member, null);
  // The trainer's own deletion stays blocked by this booking.
  const blocked = await del(trainerUser, 'trainer');
  assert.deepEqual([blocked.statusCode, blocked.body.error], [409, 'trainer_has_bookings']);
});

test('a vendor who deletes their account goes off sale', async () => {
  const at = new Date();
  const id = uid('usr_vnd');
  const productId = uid('prd');
  await db('User').insert({ id, userType: 'vendor', displayName: 'Closing Shop', accountStatus: 'active', approvalStatus: 'approved', updatedAt: at });
  await db('Product').insert({ id: productId, vendorId: id, name: 'Bottle', priceTzs: 5000, stock: 5, status: 'active', approvalStatus: 'approved', updatedAt: at });
  assert.equal((await del(id, 'vendor')).statusCode, 200);
  const listed = await shopService.listProducts({ vendorId: id });
  assert.deepEqual((Array.isArray(listed) ? listed : listed.products ?? []).filter(p => p.id === productId), []);
  const order = await shopService.createOrder({ buyerId: uid('usr_b'), body: { items: [{ productId, qty: 1 }], deliveryMethod: 'home_delivery', deliveryAddress: 'Plot 1' } });
  assert.equal(order.error, 'product_not_found');
});

test('a trainer profile leaves the in-memory list too', async () => {
  const at = new Date();
  const id = uid('usr_trn');
  const profileId = uid('trn');
  await db('User').insert({ id, userType: 'trainer', displayName: 'T', accountStatus: 'active', updatedAt: at });
  await trainers.insertAsync({ id: profileId, userId: id, displayName: 'T', status: 'active', gymIds: [] });
  assert.equal((await del(id, 'trainer')).statusCode, 200);
  assert.equal(await db('TrainerProfile').where({ id: profileId }).first(), undefined);
  assert.equal(trainers.find(t => t.id === profileId) ?? null, null);
});

test('blocked cases are unchanged and touch nothing', async () => {
  const at = new Date();
  const ownerId = uid('usr_gymowner');
  const gymId = uid('gym_block');
  const memberId = uid('usr_visitor');
  await db('Gym').insert({ id: gymId, name: 'Busy', tier: 'standard', location: 'Dar', updatedAt: at });
  await db('User').insert({ id: ownerId, userType: 'gym_operator', gymId, gymIds: [gymId], phone: uid('+255'), accountStatus: 'active', updatedAt: at });
  await db('User').insert({ id: memberId, userType: 'member', accountStatus: 'active', updatedAt: at });
  await db('Checkin').insert({ id: uid('chk'), memberId, gymId, timestamp: at, method: 'gym_scanned', subscriptionType: 'platform_pass', passTier: 'starter', visitNumberInCycle: 1, gymTier: 'standard', creditsDeductedTzs: 0, visitConsumed: true, status: 'valid', businessDate: '2026-10-29', source: 'member_qr_by_staff' });
  const gymOwner = await del(ownerId, 'gym_operator');
  assert.equal(gymOwner.statusCode, 409);
  assert.equal(gymOwner.body.error, 'gym_owner_has_checkin_activity');
  assert.ok(await db('User').where({ id: ownerId }).first());

  const organizerOwner = uid('usr_orgowner');
  await db('User').insert({ id: organizerOwner, userType: 'member', accountStatus: 'active', updatedAt: at });
  const organizerRow = uid('org');
  await db('EventOrganizer').insert({ id: organizerRow, ownerUserId: organizerOwner, name: 'Org', updatedAt: at });
  try {
    const organizer = await del(organizerOwner);
    assert.equal(organizer.statusCode, 409);
    assert.equal(organizer.body.error, 'organizer_owner');
    assert.ok(organizer.body.messageSw);
  } finally {
    await db('EventOrganizer').where({ id: organizerRow }).del();
  }

  // A paid order on its way: blocked and nothing is touched, until it is finished.
  const buyer = uid('usr_buyer');
  await db('User').insert({ id: buyer, userType: 'member', accountStatus: 'active', updatedAt: at });
  const order = uid('ord');
  const placeOrder = { id: order, buyerId: buyer, buyerRole: 'member', items: '[]', totalTzs: 1000, deliveryMethod: 'home_delivery', deliveryAddress: 'Plot 7, Mikocheni', updatedAt: at };
  await db('ShopOrder').insert({ ...placeOrder, status: 'dispatched', paymentStatus: 'paid' });
  const open = await del(buyer);
  assert.deepEqual([open.statusCode, open.body.error], [409, 'open_paid_order']);
  assert.ok(open.body.messageSw);
  assert.ok(await db('User').where({ id: buyer }).first());
  assert.equal((await db('ShopOrder').where({ id: order }).first()).deliveryAddress, 'Plot 7, Mikocheni');

  // Unpaid, and each finished state, no longer stand in the way.
  await db('ShopOrder').where({ id: order }).update({ status: 'pending', paymentStatus: 'pending' });
  await db('ShopOrder').insert({ ...placeOrder, id: uid('ord'), status: 'cancelled', paymentStatus: 'paid' });
  await db('ShopOrder').insert({ ...placeOrder, id: uid('ord'), status: 'delivered', paymentStatus: 'paid' });
  await db('ShopOrder').insert({ ...placeOrder, id: uid('ord'), status: 'fulfilled', paymentStatus: 'paid' });
  assert.equal((await del(buyer)).statusCode, 200);
});

test('append-only logs still refuse everything except clearing the personal value', async () => {
  const w = await world();
  const row = await db('IdentityEvent').where({ personId: w.personId }).first();
  await assert.rejects(db('IdentityEvent').where({ id: row.id }).update({ kind: 'merge' }), /append-only/);
  await assert.rejects(db('IdentityEvent').where({ id: row.id }).update({ kind: 'merge', normalizedValue: null, details: null }), /append-only/);
  await assert.rejects(db('IdentityEvent').where({ id: row.id }).del(), /append-only/);
  await assert.rejects(db('AccountRecoveryEvent').where({ recoveryId: w.recovery }).update({ kind: 'x' }), /append-only/);
  await assert.rejects(db('AccountRecoveryEvent').where({ recoveryId: w.recovery }).del(), /append-only/);
});

// ── settlement: the real engine, before and after ───────────────────────────────────────

test('a gym statement calculated after the deletion is identical to one calculated before', () => inRollback(async (trx) => {
  await trx('Subscription').update({ status: 'payment_cancelled' });
  await trx('B2BBenefitConsumption').whereIn('status', ['approved', 'pending']).update({ status: 'cancelled' });
  const configService = createSettlementConfigService({ db: trx, now: () => new Date('2026-09-01T09:00:00.000Z') });
  const settlement = createSettlementService({ db: trx, configService, now: () => new Date('2026-12-02T09:00:00.000Z'), logger: { error() {} } });
  const gymId = uid('gym_stl');
  await trx('Gym').insert({ id: gymId, name: 'Settlement premium', tier: 'premium', location: 'Dar es Salaam', updatedAt: new Date() });
  const card = (await configService.createRateCard({ gymId, retailDailyTzs: 20000, retailWeeklyTzs: 70000, retailMonthlyTzs: 250000, actorId: 'maker' }, { trx })).rateCard;
  assert.ok((await configService.activate({ kind: 'rate_card', id: card.id, effectiveFrom: '2026-10-01', actorId: 'checker' }, { trx })).rateCard);

  const memberId = uid('usr_stl');
  const subscriptionId = uid('sub');
  await trx('User').insert({ id: memberId, userType: 'member', displayName: PERSON_NAME, phone: uid('+255'), updatedAt: new Date() });
  await trx('Subscription').insert({ id: subscriptionId, memberId, type: 'platform_pass', tier: 'premium', status: 'expired', startedAt: new Date('2026-10-01T07:00:00Z'), cycleStartedAt: new Date('2026-10-01T07:00:00Z'), renewsAt: new Date('2026-10-31T07:00:00Z'), expiresAt: new Date('2026-10-31T07:00:00Z') });
  await trx('PaymentRequest').insert({ id: uid('pay'), memberId, subscriptionId, tier: 'premium', amountTzs: 250000, status: 'approved', provider: 'admin_approved', requestedAt: new Date('2026-10-01T06:00:00Z'), payerPhone: '+255700000001' });
  await trx('Checkin').insert(Array.from({ length: 15 }, (_, i) => ({
    id: uid('chk'), memberId, gymId, timestamp: new Date(Date.UTC(2026, 9, 1 + i, 12)), method: 'gym_scanned', subscriptionType: 'platform_pass', passTier: 'premium',
    visitNumberInCycle: 1 + i, gymTier: 'premium', creditsDeductedTzs: 0, visitConsumed: true, status: 'valid', subscriptionId,
    businessDate: `2026-10-${String(1 + i).padStart(2, '0')}`, source: 'member_qr_by_staff',
  })));

  const period = periodForMonth('2026-11');
  const statement = async (runId) => (await trx('GymSettlement').where({ runId }).select('gymId', 'preliminaryTzs', 'networkAdjustmentTzs', 'finalNetTzs', 'qualifyingVisitCount'));
  const first = await settlement.run({ ...period, mode: 'shadow' });
  assert.equal(first.stats.settledCycles, 1);
  const beforeDelete = await statement(first.run.id);

  const erased = await createAccountErasure({ db: trx }).erase(memberId);
  assert.equal(erased.ok, true);

  const second = await settlement.run({ ...period, mode: 'shadow' });
  assert.deepEqual(second.stats, first.stats);
  assert.equal(second.run.inputsHash, first.run.inputsHash);
  assert.deepEqual(await statement(second.run.id), beforeDelete);
}));
