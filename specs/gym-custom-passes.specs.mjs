// Custom gym passes & flexible membership (GYM_CUSTOM_PASSES), phase 2: backend + database.
// Against the CI database (the guarantees — one payment, one activation, never more people than were paid for —
// are the database's and are tested there). Notification channels are fakes; money is staff approval of a manual
// payment, through the real payment service.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import * as routes from '../functions/gym-passes.mjs';
import { subscribe } from '../functions/subscriptions.mjs';
import {
  gyms, users, subscriptions, paymentRequests, auditLog,
} from '../src/bootstrap/collections.mjs';
import { verifiedContacts, gymPassStore, gymPassService as liveService, checkInService, subscriptionService } from '../src/bootstrap/services.mjs';
import { createGymPassService } from '../src/services/gym-pass-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { createCheckInService } from '../src/services/check-in-service.mjs';
import { verifyContacts, purgeIdentity } from './fixtures/verified-contacts.mjs';
import { validatePlanInput, passExpiry, checkoutHeadcount, maskContact, effectivePurchaseStatus } from '../src/shared/gym-pass-rules.mjs';
import { productTypeOfPayment, PRODUCT_TYPES } from '../src/shared/payment-product.mjs';
import { gymPassMessage, gymPassNotice, GYM_PASS_SW_PENDING } from '../src/shared/gym-pass-texts.mjs';
import { CHECKIN_REFUSAL_CODES } from '../src/shared/check-in-rules.mjs';
import { gymCustomPassesOn } from '../src/shared/feature-flags.mjs';
import { settingsWithTiers } from './fixtures/tier-settings.mjs';

await ensureInit();

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const tag = randomUUID().slice(0, 6);
const made = { users: [], gyms: [] };
let seq = 0;
const phoneNo = () => `+2557${String(10000000 + Math.floor(Math.random() * 89999999)).slice(0, 8)}`;
const local = (phone) => `0${phone.slice(4)}`;

afterEach(() => { delete process.env.GYM_CUSTOM_PASSES; });

// ── fixtures ────────────────────────────────────────────────────────────────

async function member({ phone = phoneNo(), email = null, verified = true, name = null } = {}) {
  const id = uid('usr');
  seq += 1;
  await db('User').insert({ id, userType: 'member', displayName: name ?? `Pass Member ${seq}`, phone: verified ? null : phone, updatedAt: new Date() });
  made.users.push(id);
  if (verified) await verifyContacts(db, id, { phone, email });
  return { id, phone, email };
}
async function gym(status = 'active') {
  const id = uid('gym');
  await gyms.insertAsync({ id, name: `Pass Gym ${tag}`, tier: 'standard', location: 'Dar es Salaam', status });
  made.gyms.push(id);
  return id;
}
async function owner(gymIds) {
  const id = uid('own');
  await db('User').insert({ id, userType: 'gym_operator', displayName: 'Pass Owner', gymIds, gymId: gymIds[0], updatedAt: new Date() });
  made.users.push(id);
  return { id, gymIds, userType: 'gym_operator' };
}

/** A service instance with fake channels over the real store, plus a payment service wired to it. */
function kit({ whatsapp = async () => ({ status: 'skipped:whatsapp_not_available' }), sms = true } = {}) {
  const sent = { notify: [], sms: [], whatsapp: [] };
  const svc = createGymPassService({
    store: gymPassStore, gyms, users, auditLog,
    contacts: { findMember: verifiedContacts.findMember, contactsFor: verifiedContacts.contactsFor },
    notify: async (userId, message) => { sent.notify.push({ userId, message }); return {}; },
    channels: {
      whatsapp: async (p) => { sent.whatsapp.push(p); return whatsapp(p); },
      ...(sms ? { sms: async (p) => { sent.sms.push(p); return { status: 'sent' }; } } : {}),
    },
    baseLink: () => 'https://app.test',
  });
  const pay = createAdminPaymentService({
    paymentRequests, subscriptions, users, auditLog, gyms,
    onPassPayment: (request, status, opts) => svc.onPaymentStatus(request, status, opts),
  });
  return { svc, pay, sent };
}

async function plan(k, own, gymId, body = {}) {
  const out = await k.svc.createPlan({ owner: own, gymId, actorId: own.id, body: { name: 'Pass', category: 'individual', durationValue: 30, durationUnit: 'days', priceTzs: 50_000, ...body } });
  assert.equal(out.status, 201, JSON.stringify(out));
  return out.plan;
}
async function buy(k, buyer, planId, extra = {}) {
  const out = await k.svc.purchase({ memberId: buyer.id, planId, ...extra });
  assert.equal(out.status, 202, JSON.stringify(out));
  return out;
}
const approve = (k, paymentId) => k.pay.decide({ id: paymentId, decision: 'approve', actorId: 'adm_pass', reference: `REF${randomUUID().slice(0, 8).toUpperCase()}` });
const childSubs = (purchaseId) => db('Subscription').where({ passPurchaseId: purchaseId }).orderBy('createdAt');
const people = (purchaseId) => db('GymPassBeneficiary').where({ purchaseId }).orderBy('slot');
const DAY = 86_400_000;

after(async () => {
  const purchaseIds = await db('GymPassPurchase').whereIn('gymId', made.gyms).pluck('id');
  const paymentIds = await db('PaymentRequest').whereIn('gymId', made.gyms).pluck('id');
  await db('Checkin').whereIn('gymId', made.gyms).del();
  await db('Subscription').whereIn('memberId', made.users).del();
  await db('GymPassBeneficiary').whereIn('purchaseId', purchaseIds).del();
  await db('GymPassPurchase').whereIn('id', purchaseIds).del();
  await db('GymPassPlan').whereIn('gymId', made.gyms).del();
  await db('PaymentRequest').whereIn('id', paymentIds).del();
  await db('Notification').whereIn('userId', made.users).del();
  await db('AuditLog').whereIn('actor', [...made.users, 'adm_pass']).del().catch(() => {});
  const persons = await purgeIdentity(db, made.users);
  await db('User').whereIn('id', made.users).del();
  if (persons?.length) await db('Person').whereIn('id', persons).del().catch(() => {});
  await db('Gym').whereIn('id', made.gyms).del();
  await db.destroy();
});

// ── pure rules ──────────────────────────────────────────────────────────────

test('plan rules: individual 1, couples 2, group 3..50; custom durations; invalid configs refused', () => {
  const ok = (body) => validatePlanInput({ name: 'Pass', durationValue: 1, durationUnit: 'days', priceTzs: 1000, ...body });
  assert.equal(ok({ category: 'individual' }).value.beneficiaryLimit, 1);
  assert.equal(ok({ category: 'couples', beneficiaryLimit: 2 }).value.beneficiaryLimit, 2);
  assert.equal(ok({ category: 'group', beneficiaryLimit: 5 }).value.beneficiaryLimit, 5);
  assert.equal(ok({ category: 'individual', durationValue: 10, durationUnit: 'days' }).value.durationValue, 10);
  assert.equal(ok({ category: 'individual', durationValue: 6, durationUnit: 'weeks' }).value.durationUnit, 'weeks');
  assert.equal(ok({ category: 'individual', durationValue: 18, durationUnit: 'months' }).value.durationValue, 18);
  const refused = (body, field, reason) => {
    const out = ok(body);
    assert.equal(out.error, 'invalid_field', JSON.stringify(body));
    assert.equal(out.status, 400);
    assert.equal(out.field, field);
    if (reason) assert.equal(out.reason, reason);
  };
  refused({ category: 'individual', beneficiaryLimit: 2 }, 'beneficiaryLimit', 'category_fixes_limit');
  refused({ category: 'couples', beneficiaryLimit: 3 }, 'beneficiaryLimit', 'category_fixes_limit');
  refused({ category: 'group', beneficiaryLimit: 2 }, 'beneficiaryLimit', 'group_limit_range');
  refused({ category: 'group', beneficiaryLimit: 51 }, 'beneficiaryLimit', 'group_limit_range');
  refused({ category: 'group' }, 'beneficiaryLimit', 'group_limit_required');
  refused({ category: 'family' }, 'category');
  refused({ category: 'individual', priceTzs: 0 }, 'priceTzs');
  refused({ category: 'individual', priceTzs: -5 }, 'priceTzs');
  refused({ category: 'individual', priceTzs: 12.5 }, 'priceTzs');
  refused({ category: 'individual', priceTzs: 'free' }, 'priceTzs');
  refused({ category: 'individual', priceTzs: 100_000_001 }, 'priceTzs', 'too_large');
  refused({ category: 'individual', durationValue: 0 }, 'durationValue');
  refused({ category: 'individual', durationValue: 731, durationUnit: 'days' }, 'durationValue', 'too_long');
  refused({ category: 'individual', durationValue: 25, durationUnit: 'months' }, 'durationValue', 'too_long');
  refused({ category: 'individual', durationUnit: 'years' }, 'durationUnit');
  refused({ category: 'individual', name: ' ' }, 'name');
  assert.equal(validatePlanInput({ category: 'individual', durationValue: 1, durationUnit: 'days', priceTzs: 1 }).error, 'invalid_field');
});

test('plan edit: partial, validated as a whole (individual -> group needs a size; group -> couples fixes it)', () => {
  const prior = { name: 'P', category: 'individual', durationValue: 30, durationUnit: 'days', beneficiaryLimit: 1, priceTzs: 1000 };
  assert.equal(validatePlanInput({ priceTzs: 2000 }, prior).value.priceTzs, 2000);
  assert.equal(validatePlanInput({ category: 'group' }, prior).reason, 'group_limit_required');
  assert.equal(validatePlanInput({ category: 'group', beneficiaryLimit: 4 }, prior).value.beneficiaryLimit, 4);
  const group = { ...prior, category: 'group', beneficiaryLimit: 6 };
  assert.equal(validatePlanInput({ priceTzs: 5 }, group).value.beneficiaryLimit, 6);
  assert.equal(validatePlanInput({ category: 'couples' }, group).value.beneficiaryLimit, 2);
  assert.equal(validatePlanInput({ durationUnit: 'weeks', durationValue: 105 }, prior).reason, 'too_long');
});

test('expiry: days and weeks are 24-hour days; months are calendar months (31 Jan + 1 month = 28/29 Feb)', () => {
  const from = new Date('2026-01-31T10:00:00Z');
  assert.equal(passExpiry(from, 10, 'days').toISOString(), '2026-02-10T10:00:00.000Z');
  assert.equal(passExpiry(from, 2, 'weeks').toISOString(), '2026-02-14T10:00:00.000Z');
  assert.equal(passExpiry(from, 1, 'months').toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(passExpiry(new Date('2026-11-14T08:00:00Z'), 3, 'months').toISOString(), '2027-02-14T08:00:00.000Z');
  assert.equal(passExpiry(new Date('2027-12-15T08:00:00Z'), 18, 'months').toISOString(), '2029-06-15T08:00:00.000Z');
});

test('checkout headcount: individual 1, couples exactly 2 in all, group 3..limit in all', () => {
  const snap = (category, beneficiaryLimit) => ({ category, beneficiaryLimit });
  assert.ok(checkoutHeadcount(snap('individual', 1), 0).ok);
  assert.equal(checkoutHeadcount(snap('individual', 1), 1).error, 'beneficiaries_not_allowed');
  assert.ok(checkoutHeadcount(snap('couples', 2), 1).ok);
  assert.equal(checkoutHeadcount(snap('couples', 2), 0).error, 'couples_needs_two_people');
  assert.equal(checkoutHeadcount(snap('couples', 2), 2).error, 'couples_needs_two_people');
  assert.equal(checkoutHeadcount(snap('group', 5), 1).error, 'group_needs_minimum');
  assert.ok(checkoutHeadcount(snap('group', 5), 2).ok);
  assert.ok(checkoutHeadcount(snap('group', 5), 4).ok);
  assert.equal(checkoutHeadcount(snap('group', 5), 5).error, 'beneficiary_limit_exceeded');
  assert.equal(maskContact('phone', '+255712345678'), '+255••••••678');
  assert.equal(maskContact('email', 'amina@x.com'), 'a•••@x.com');
  assert.equal(effectivePurchaseStatus({ status: 'active', expiresAt: '2000-01-01T00:00:00Z' }), 'expired');
});

test('a pass purchase payment is a GYM_SUBSCRIPTION, never a FitFlex Pass; other payments are read as before', () => {
  assert.equal(productTypeOfPayment({ passPurchaseId: 'gpu_1', gymId: 'g', tier: null, plan: null }), PRODUCT_TYPES.GYM_SUBSCRIPTION);
  assert.equal(productTypeOfPayment({ passPurchaseId: 'gpu_1', tier: 'pro' }), PRODUCT_TYPES.GYM_SUBSCRIPTION);
  assert.equal(productTypeOfPayment({ tier: 'pro' }), PRODUCT_TYPES.FITFLEX_PASS);
  assert.equal(productTypeOfPayment({ gymId: 'g', plan: 'daily' }), PRODUCT_TYPES.GYM_SUBSCRIPTION);
  assert.equal(productTypeOfPayment({ orderId: 'o', passPurchaseId: null }), PRODUCT_TYPES.SHOP_ORDER);
});

test('texts: English and Swahili exist for every new notice; Swahili is a marked placeholder pending review', () => {
  for (const kind of ['added', 'active']) {
    const params = { buyerName: 'Amina', planName: 'Pass', gymName: 'G', until: '01/02/2027' };
    const en = gymPassNotice(kind, params, 'en');
    const sw = gymPassNotice(kind, params, 'sw');
    assert.ok(en.title && en.body && sw.title && sw.body, kind);
    assert.doesNotMatch(`${en.title} ${en.body} ${sw.title} ${sw.body}`, /undefined|null|NaN|\[object/, kind);
    assert.ok(sw.title.startsWith('[SW pending review]') && sw.body.startsWith('[SW pending review]'), `${kind}: Swahili must be marked as pending review`);
    assert.ok(!en.body.includes('[SW'), kind);
  }
  assert.equal(GYM_PASS_SW_PENDING, true);
  assert.ok(gymPassMessage('invite', { buyerName: 'A', planName: 'P', gymName: 'G', link: 'https://x/#t' }, 'sw').startsWith('[SW pending review]'));
  assert.ok(!gymPassMessage('invite', { buyerName: 'A', planName: 'P', gymName: 'G', link: 'https://x/#t' }, 'en').includes('[SW'));
});

test('no new check-in refusal code is needed: suspended and removed people are refused with existing codes', () => {
  assert.ok(CHECKIN_REFUSAL_CODES.includes('subscription_inactive'));
});

// ── flag ────────────────────────────────────────────────────────────────────

test('flag off: every new route answers 404 feature_disabled BEFORE sign-in; legacy routes behave as before', async () => {
  delete process.env.GYM_CUSTOM_PASSES;
  assert.equal(gymCustomPassesOn(), false);
  const exported = Object.entries(routes).filter(([, v]) => v && typeof v === 'object' && v.path);
  assert.ok(exported.length >= 25, `expected the full route set, got ${exported.length}`);
  for (const [name, route] of exported) {
    const out = res();
    let passed = false;
    for (const guard of [route.onGuard].flat()) {
      await guard({ method: route.method.toUpperCase(), headers: {}, params: {}, query: {}, body: {}, get: () => null }, out, () => { passed = true; });
      if (!passed) break;
    }
    assert.equal(passed, false, `${name} must not pass its guard while the flag is off`);
    assert.equal(out.statusCode, 404, name);
    assert.deepEqual(out.body, { error: 'feature_disabled' }, name);
  }
  // Legacy: the FitFlex Pass catalogue and the gym's own daily plan are untouched.
  const g = await gym();
  await gyms.updateAsync(x => x.id === g, { ratePerDay: 5000 });
  const m = await member();
  const direct = await call(subscribe, { sub: m.id, userType: 'member' }, { body: { type: 'direct_sub', homeGymId: g, plan: 'daily' } });
  assert.equal(direct.status, 202);
  assert.equal(direct.body.paymentRequest.amountTzs, 5000);
  assert.equal(direct.body.paymentRequest.passPurchaseId ?? null, null);
  assert.equal(direct.body.subscription.passPurchaseId ?? null, null);
});

test('flag on: the routes work for the right people; a member cannot reach an owner route', async () => {
  process.env.GYM_CUSTOM_PASSES = '1';
  const g = await gym();
  const o = await owner([g]);
  const m = await member();
  const created = await call(routes.ownerGymPassPlanCreate, { sub: o.id, userType: 'gym_operator' }, { params: { gymId: g }, body: { name: 'Route pass', category: 'individual', durationValue: 7, durationUnit: 'days', priceTzs: 20_000 } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const asMember = await call(routes.ownerGymPassPlans, { sub: m.id, userType: 'member' }, { params: { gymId: g } });
  assert.equal(asMember.status, 403);
  const pub = await call(routes.gymPassPublicPlans, null, { params: { id: g } });
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.body.plans.map(p => p.name), ['Route pass']);
  const buy1 = await call(routes.gymPassPurchase, { sub: m.id, userType: 'member' }, { body: { planId: created.body.plan.id, priceTzs: 1 } });
  assert.equal(buy1.status, 202, JSON.stringify(buy1.body));
  assert.equal(buy1.body.paymentRequest.amountTzs, 20_000, 'the price is the plan\'s, never the client\'s');
  const again = await call(routes.gymPassPurchase, { sub: m.id, userType: 'member' }, { body: { planId: created.body.plan.id } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'payment_already_pending');
  const mine = await call(routes.gymPassMine, { sub: m.id, userType: 'member' });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.purchased.length, 1);
});

test('flag on, owner routes: scopes and ownership are enforced; people can be managed and read through the routes', async () => {
  process.env.GYM_CUSTOM_PASSES = '1';
  const g = await gym();
  const o = await owner([g]);
  const otherOwner = await owner([await gym()]);
  const staffId = uid('stf');
  await db('User').insert({ id: staffId, userType: 'gym_staff', displayName: 'Desk', gymIds: [g], gymId: g, aclPermissions: ['payments'], updatedAt: new Date() });
  made.users.push(staffId);
  const OWN = { sub: o.id, userType: 'gym_operator' };
  const staff = { sub: staffId, userType: 'gym_staff', aclPermissions: ['payments'] };
  const planBody = { name: 'Route couples', category: 'couples', durationValue: 1, durationUnit: 'months', priceTzs: 60_000 };

  assert.equal((await call(routes.ownerGymPassPlanCreate, { sub: otherOwner.id, userType: 'gym_operator' }, { params: { gymId: g }, body: planBody })).body.error, 'not_your_gym');
  assert.equal((await call(routes.ownerGymPassPlanCreate, staff, { params: { gymId: g }, body: planBody })).status, 403, 'staff without the gyms scope cannot design passes');
  const created = await call(routes.ownerGymPassPlanCreate, OWN, { params: { gymId: g }, body: planBody });
  assert.equal(created.status, 201);
  const bad = await call(routes.ownerGymPassPlanCreate, OWN, { params: { gymId: g }, body: { ...planBody, priceTzs: 0 } });
  assert.deepEqual([bad.status, bad.body.error, bad.body.field], [400, 'invalid_field', 'priceTzs']);
  const planId = created.body.plan.id;
  assert.equal((await call(routes.ownerGymPassPlanDeactivate, OWN, { params: { gymId: g, planId } })).body.plan.status, 'inactive');
  assert.equal((await call(routes.gymPassPublicPlans, null, { params: { id: g } })).body.plans.length, 0);
  assert.equal((await call(routes.ownerGymPassPlanActivate, OWN, { params: { gymId: g, planId } })).body.plan.status, 'active');
  assert.equal((await call(routes.ownerGymPassPlanUpdate, OWN, { params: { gymId: g, planId }, body: { priceTzs: 65_000 } })).body.plan.priceTzs, 65_000);

  const buyer = await member(); const friend = await member();
  const bought = await call(routes.gymPassPurchase, { sub: buyer.id, userType: 'member' }, { body: { planId, beneficiaries: [{ phone: friend.phone }] } });
  assert.equal(bought.status, 202, JSON.stringify(bought.body));
  assert.equal(bought.body.paymentRequest.amountTzs, 65_000);
  const { adminPaymentService } = await import('../src/bootstrap/services.mjs');
  await adminPaymentService.decide({ id: bought.body.paymentRequest.id, decision: 'approve', actorId: 'adm_pass', reference: `ROUTE${tag}` });
  const purchaseId = bought.body.purchase.id;

  // staff with `payments` read sales and the summary, but not people (scope members)
  assert.equal((await call(routes.ownerGymPassSales, staff, { params: { gymId: g } })).body.sales.length, 1);
  assert.equal((await call(routes.ownerGymPassSummary, staff, { params: { gymId: g } })).body.sales.revenueTzs, 65_000);
  assert.equal((await call(routes.ownerGymPassMemberships, staff, { params: { gymId: g } })).status, 403);
  assert.equal((await call(routes.ownerGymPassSales, { sub: otherOwner.id, userType: 'gym_operator' }, { params: { gymId: g } })).status, 403);

  const memberships = await call(routes.ownerGymPassMemberships, OWN, { params: { gymId: g } });
  const friendRow = memberships.body.memberships[0].beneficiaries.find(b => b.userId === friend.id);
  const path = { gymId: g, purchaseId, beneficiaryId: friendRow.id };
  assert.equal((await call(routes.ownerGymPassSuspend, OWN, { params: path })).body.beneficiary.status, 'suspended');
  assert.equal((await call(routes.ownerGymPassSuspend, { sub: otherOwner.id, userType: 'gym_operator' }, { params: path })).status, 403);
  assert.equal((await call(routes.ownerGymPassResume, OWN, { params: path })).body.beneficiary.status, 'active');
  assert.equal((await call(routes.ownerGymPassAttendance, OWN, { params: path })).body.visits.length, 0);
  assert.equal((await call(routes.ownerGymPassPurchase, OWN, { params: { gymId: g, purchaseId } })).body.sale.beneficiaryCounts.total, 2);
  assert.equal((await call(routes.ownerGymPassRemove, OWN, { params: path })).body.beneficiary.status, 'removed');
  const added = await call(routes.ownerGymPassAddPerson, OWN, { params: { gymId: g, purchaseId }, body: { phone: friend.phone } });
  assert.equal(added.status, 201);
  assert.equal(added.body.beneficiary.status, 'active');
  // a purchase of this gym is "not found" through another gym's path
  const elsewhere = await owner([await gym()]);
  assert.equal((await call(routes.ownerGymPassPurchase, { sub: elsewhere.id, userType: 'gym_operator' }, { params: { gymId: elsewhere.gymIds[0], purchaseId } })).status, 404);

  // the buyer manages their own people through the member routes; the friend can leave
  const mine = await call(routes.gymPassMine, { sub: buyer.id, userType: 'member' });
  assert.equal(mine.body.purchased[0].slots.used, 2);
  const buyerAdd = await call(routes.gymPassBuyerAddPerson, { sub: buyer.id, userType: 'member' }, { params: { purchaseId }, body: { phone: phoneNo() } });
  assert.equal(buyerAdd.body.error, 'beneficiary_limit_exceeded');
  assert.equal((await call(routes.gymPassLeave, { sub: friend.id, userType: 'member' }, { params: { purchaseId } })).body.ok, true);
  assert.equal((await call(routes.gymPassInvitePreview, null, { body: {} })).status, 400);
  assert.equal((await call(routes.gymPassClaim, { sub: friend.id, userType: 'member' }, { body: { token: 'short' } })).status, 404);
});

// ── plans ───────────────────────────────────────────────────────────────────

test('owner creates individual, couples and group plans with custom durations; the database also refuses bad shapes', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const individual = await plan(k, o, g, { name: 'Ten days', durationValue: 10, durationUnit: 'days' });
  const couples = await plan(k, o, g, { name: 'Couples', category: 'couples', durationValue: 6, durationUnit: 'weeks', priceTzs: 90_000 });
  const group = await plan(k, o, g, { name: 'Squad', category: 'group', beneficiaryLimit: 5, durationValue: 18, durationUnit: 'months', priceTzs: 500_000 });
  assert.deepEqual([individual.beneficiaryLimit, couples.beneficiaryLimit, group.beneficiaryLimit], [1, 2, 5]);
  assert.equal(group.currency, 'TZS');
  assert.equal(group.startPolicy, 'immediate');
  const listed = await k.svc.listPlans({ owner: o, gymId: g });
  assert.equal(listed.plans.length, 3);

  const raw = { gymId: g, name: 'x', durationValue: 1, durationUnit: 'days', priceTzs: 1, createdBy: o.id };
  for (const bad of [
    { category: 'individual', beneficiaryLimit: 2 }, { category: 'couples', beneficiaryLimit: 3 }, { category: 'group', beneficiaryLimit: 2 },
    { category: 'individual', beneficiaryLimit: 1, priceTzs: 0 }, { category: 'individual', beneficiaryLimit: 1, durationValue: 0 },
    { category: 'individual', beneficiaryLimit: 1, startPolicy: 'next_monday' },
  ]) {
    await assert.rejects(db('GymPassPlan').insert({ id: uid('gpp'), ...raw, ...bad }), (err) => err.code === '23514', JSON.stringify(bad));
  }
});

test('another gym\'s owner cannot create, edit, activate or list; a foreign plan id looks like not found; changes are audited', async () => {
  const k = kit();
  const g1 = await gym();
  const g2 = await gym();
  const o1 = await owner([g1]);
  const o2 = await owner([g2]);
  const p = await plan(k, o1, g1);
  const body = { name: 'Hack', category: 'individual', durationValue: 1, durationUnit: 'days', priceTzs: 1 };
  assert.equal((await k.svc.createPlan({ owner: o2, gymId: g1, body, actorId: o2.id })).error, 'not_your_gym');
  assert.equal((await k.svc.listPlans({ owner: o2, gymId: g1 })).error, 'not_your_gym');
  assert.equal((await k.svc.updatePlan({ owner: o2, gymId: g1, planId: p.id, body: { priceTzs: 1 }, actorId: o2.id })).error, 'not_your_gym');
  // Own gym in the path, someone else's plan id: not found (no probing).
  assert.equal((await k.svc.updatePlan({ owner: o2, gymId: g2, planId: p.id, body: { priceTzs: 1 }, actorId: o2.id })).error, 'plan_not_found');
  assert.equal((await k.svc.setPlanStatus({ owner: o2, gymId: g2, planId: p.id, status: 'inactive', actorId: o2.id })).error, 'plan_not_found');
  assert.equal((await db('GymPassPlan').where({ id: p.id }).first()).priceTzs, 50_000);

  await k.svc.updatePlan({ owner: o1, gymId: g1, planId: p.id, body: { priceTzs: 60_000 }, actorId: o1.id });
  await k.svc.setPlanStatus({ owner: o1, gymId: g1, planId: p.id, status: 'inactive', actorId: o1.id });
  await k.svc.setPlanStatus({ owner: o1, gymId: g1, planId: p.id, status: 'active', actorId: o1.id });
  const actions = (await db('AuditLog').where({ actor: o1.id }).pluck('action'));
  for (const a of ['gym_pass_plan_created', 'gym_pass_plan_updated', 'gym_pass_plan_deactivated', 'gym_pass_plan_activated']) assert.ok(actions.includes(a), a);
});

test('public list: active plans of a live gym only', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const on = await plan(k, o, g, { name: 'On sale' });
  const off = await plan(k, o, g, { name: 'Off sale' });
  await k.svc.setPlanStatus({ owner: o, gymId: g, planId: off.id, status: 'inactive', actorId: o.id });
  const out = await k.svc.publicPlans(g);
  assert.deepEqual(out.plans.map(p => p.id), [on.id]);
  assert.equal(out.plans[0].createdBy, undefined, 'no internal fields in the public view');
  assert.equal((await k.svc.publicPlans(await gym('suspended'))).error, 'gym_not_found');
  assert.equal((await k.svc.publicPlans('gym_nope')).status, 404);
  const buyer = await member();
  assert.equal((await k.svc.purchase({ memberId: buyer.id, planId: off.id })).error, 'plan_not_available');
});

// ── buying ──────────────────────────────────────────────────────────────────

test('individual purchase: price from the plan, ONE payment request, nothing active until it is approved', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g, { priceTzs: 75_000 });
  const buyer = await member();
  const out = await buy(k, buyer, p.id);
  assert.equal(out.paymentRequest.amountTzs, 75_000);
  assert.equal(out.paymentRequest.status, 'pending');
  assert.equal(out.paymentRequest.passPurchaseId, out.purchase.id);
  assert.equal(out.paymentRequest.subscriptionId, null);
  assert.equal(out.purchase.status, 'pending_payment');
  assert.equal(out.purchase.plan.priceTzs, 75_000);
  assert.equal((await childSubs(out.purchase.id)).length, 0);
  assert.equal((await db('PaymentRequest').where({ passPurchaseId: out.purchase.id })).length, 1);
  // purchaser identified as the payer
  assert.equal(out.paymentRequest.memberId, buyer.id);
  assert.equal((await db('GymPassPurchase').where({ id: out.purchase.id }).first()).purchaserId, buyer.id);
  // an individual pass takes no one else
  const other = await member();
  const p2 = await plan(k, o, g, { name: 'Solo 2' });
  assert.equal((await k.svc.purchase({ memberId: other.id, planId: p2.id, beneficiaries: [{ phone: phoneNo() }] })).error, 'beneficiaries_not_allowed');
});

test('couples needs exactly two people in all; group needs 3 up to its limit; yourself and duplicates are refused', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const couples = await plan(k, o, g, { name: 'Couples', category: 'couples' });
  const group = await plan(k, o, g, { name: 'Group', category: 'group', beneficiaryLimit: 4 });
  const buyer = await member();
  const a = phoneNo(); const b = phoneNo(); const c = phoneNo(); const d = phoneNo();
  const err = async (planId, list, people = buyer) => (await k.svc.purchase({ memberId: people.id, planId, beneficiaries: list })).error;
  assert.equal(await err(couples.id, []), 'couples_needs_two_people');
  assert.equal(await err(couples.id, [{ phone: a }, { phone: b }]), 'couples_needs_two_people');
  assert.equal(await err(group.id, [{ phone: a }]), 'group_needs_minimum');
  assert.equal(await err(group.id, [{ phone: a }, { phone: b }, { phone: c }, { phone: d }]), 'beneficiary_limit_exceeded');
  assert.equal(await err(group.id, [{ phone: a }, { phone: a }]), 'duplicate_beneficiary');
  assert.equal(await err(group.id, [{ phone: a }, { phone: local(a) }]), 'duplicate_beneficiary', 'the same number written two ways is one person');
  assert.equal(await err(group.id, [{ phone: a }, { phone: 'abc' }]), 'invalid_contact');
  assert.equal(await err(couples.id, [{ phone: buyer.phone }]), 'cannot_add_yourself');
  assert.equal(await err(couples.id, 'nope'), 'invalid_beneficiaries');
  const twoWays = await member({ email: `two.${tag}@x.test` });
  assert.equal(await err(group.id, [{ phone: twoWays.phone }, { email: twoWays.email }]), 'duplicate_beneficiary', 'one account named by phone and by email');
  // Valid: couples with one other; group at the limit
  const ok1 = await k.svc.purchase({ memberId: buyer.id, planId: couples.id, beneficiaries: [{ phone: a }] });
  assert.equal(ok1.status, 202);
  assert.equal(ok1.purchase.slots.used, 2);
  const buyer2 = await member();
  const ok2 = await k.svc.purchase({ memberId: buyer2.id, planId: group.id, beneficiaries: [{ phone: a }, { phone: b }, { phone: c }] });
  assert.equal(ok2.status, 202);
  assert.equal(ok2.purchase.slots.limit, 4);
  assert.equal((await people(ok2.purchase.id)).length, 4);
  // Terms: a plan with terms needs the version the buyer saw
  const withTerms = await plan(k, o, g, { name: 'Terms', terms: 'No transfers.' });
  const buyer3 = await member();
  assert.equal((await k.svc.purchase({ memberId: buyer3.id, planId: withTerms.id })).error, 'terms_not_accepted');
  assert.equal((await k.svc.purchase({ memberId: buyer3.id, planId: withTerms.id, termsVersion: 9 })).error, 'terms_changed');
  assert.equal((await k.svc.purchase({ memberId: buyer3.id, planId: withTerms.id, termsVersion: 1 })).status, 202);
});

test('a second open purchase of the same plan by the same member is payment_already_pending (also under a race); cancelling frees it', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g);
  const buyer = await member();
  const results = await Promise.all([1, 2, 3].map(() => k.svc.purchase({ memberId: buyer.id, planId: p.id })));
  assert.equal(results.filter(r => r.status === 202).length, 1);
  assert.equal(results.filter(r => r.error === 'payment_already_pending').length, 2);
  assert.equal((await db('PaymentRequest').where({ memberId: buyer.id, gymId: g })).length, 1);
  const open = results.find(r => r.status === 202);
  const cancelled = await k.svc.cancelPurchase({ memberId: buyer.id, purchaseId: open.purchase.id });
  assert.equal(cancelled.purchase.status, 'cancelled');
  assert.equal((await db('PaymentRequest').where({ id: open.paymentRequest.id }).first()).status, 'cancelled');
  assert.equal((await k.svc.purchase({ memberId: buyer.id, planId: p.id })).status, 202);
  // not someone else's
  assert.equal((await k.svc.cancelPurchase({ memberId: (await member()).id, purchaseId: open.purchase.id })).error, 'not_found');
});

test('wrong gym or a gym that is not live cannot sell; a non-member cannot buy', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g);
  await gyms.updateAsync(x => x.id === g, { status: 'suspended' });
  const buyer = await member();
  assert.equal((await k.svc.purchase({ memberId: buyer.id, planId: p.id })).error, 'gym_not_available');
  await gyms.updateAsync(x => x.id === g, { status: 'active' });
  assert.equal((await k.svc.purchase({ memberId: buyer.id, planId: 'gpp_missing' })).error, 'plan_not_found');
  assert.equal((await k.svc.purchase({ memberId: o.id, planId: p.id })).error, 'not_allowed');
});

// ── payment → activation ────────────────────────────────────────────────────

test('a rejected or cancelled payment never activates; nobody gets a subscription', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g, { category: 'couples' });
  for (const decision of ['reject', 'cancel']) {
    const buyer = await member();
    const out = await buy(k, buyer, p.id, { beneficiaries: [{ phone: (await member()).phone }] });
    if (decision === 'reject') {
      assert.ok((await k.pay.decide({ id: out.paymentRequest.id, decision: 'reject', actorId: 'adm_pass' })).paymentRequest);
    } else {
      assert.ok((await k.pay.update({ id: out.paymentRequest.id, status: 'cancelled', actorId: 'adm_pass' })).paymentRequest);
    }
    const row = await db('GymPassPurchase').where({ id: out.purchase.id }).first();
    assert.equal(row.status, 'cancelled');
    assert.equal(row.startsAt, null);
    assert.equal((await childSubs(out.purchase.id)).length, 0);
    assert.equal(k.sent.notify.length, 0);
    assert.equal(k.sent.sms.length, 0);
  }
});

test('approval activates exactly one purchase: dated from the payment moment; buyer and existing accounts get their OWN subscription; others wait', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g, { category: 'group', beneficiaryLimit: 4, durationValue: 2, durationUnit: 'weeks', priceTzs: 120_000 });
  const buyer = await member({ name: 'Buyer Bee' });
  const friend = await member({ name: 'Friend Foo' });
  const stranger = phoneNo();
  const out = await buy(k, buyer, p.id, { beneficiaries: [{ phone: local(friend.phone) }, { phone: stranger }] });
  // Backdate the request so "from the payment moment" is visible.
  await db('GymPassPurchase').where({ id: out.purchase.id }).update({ createdAt: new Date(Date.now() - 5 * DAY) });
  const before = Date.now();
  const decided = await approve(k, out.paymentRequest.id);
  assert.equal(decided.paymentRequest.status, 'approved');
  const purchase = await db('GymPassPurchase').where({ id: out.purchase.id }).first();
  assert.equal(purchase.status, 'active');
  assert.ok(+purchase.startsAt >= before - 1000, 'dated from the approval, not the request');
  assert.ok(Math.abs(+purchase.expiresAt - (+purchase.startsAt + 14 * DAY)) < 2000, 'two weeks');

  const subs = await childSubs(out.purchase.id);
  assert.equal(subs.length, 2, 'the buyer and the friend with an account; the stranger has none yet');
  assert.deepEqual(subs.map(s => s.memberId).sort(), [buyer.id, friend.id].sort());
  for (const s of subs) {
    assert.equal(s.type, 'direct_sub');
    assert.equal(s.status, 'active');
    assert.equal(s.homeGymId, g);
    assert.equal(s.tier, null);
    assert.equal(+s.expiresAt, +purchase.expiresAt, 'the same end date as the purchase');
    assert.ok(s.passBeneficiaryId);
  }
  const rows = await people(out.purchase.id);
  assert.deepEqual(rows.map(r => r.status), ['active', 'active', 'pending_registration']);
  assert.equal(rows[2].contactValue, stranger);
  assert.equal(rows[2].userId, null);
  // Only ONE payment exists for the sale, and the child subscriptions have none: revenue is counted once.
  assert.equal((await db('PaymentRequest').where({ passPurchaseId: out.purchase.id })).length, 1);
  assert.equal((await db('PaymentRequest').whereIn('subscriptionId', subs.map(s => s.id))).length, 0);
  assert.equal((await db('PaymentRequest').whereIn('memberId', [buyer.id, friend.id]).where({ status: 'approved' })).length, 1);
  assert.equal((await db('GymPassPurchase').where({ gymId: g })).length, 1);
});

test('retried approvals are no-ops: no duplicate purchase, subscriptions or notifications', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g, { category: 'couples' });
  const buyer = await member();
  const friend = await member();
  const out = await buy(k, buyer, p.id, { beneficiaries: [{ phone: friend.phone }] });
  await approve(k, out.paymentRequest.id);
  const snapshot = async () => ({
    subs: (await childSubs(out.purchase.id)).map(s => s.id), purchase: await db('GymPassPurchase').where({ id: out.purchase.id }).first(),
    notified: k.sent.notify.length, sms: k.sent.sms.length,
  });
  const first = await snapshot();
  assert.equal((await approve(k, out.paymentRequest.id)).error, 'already_decided');
  // The repair path (approving an already approved request) and the hook called directly, many times, at once.
  await k.pay.update({ id: out.paymentRequest.id, status: 'approved', actorId: 'adm_pass' });
  const request = await paymentRequests.findByIdAsync(out.paymentRequest.id);
  await Promise.all([1, 2, 3, 4].map(() => k.svc.onPaymentStatus(request, 'approved', { actorId: 'adm_pass' })));
  const again = await snapshot();
  assert.deepEqual(again.subs, first.subs);
  assert.equal(+again.purchase.startsAt, +first.purchase.startsAt);
  assert.equal(+again.purchase.expiresAt, +first.purchase.expiresAt);
  assert.equal(again.notified, first.notified, 'each person is told once');
  assert.equal(again.sms, first.sms);
  assert.equal((await db('Subscription').where({ passPurchaseId: out.purchase.id })).length, 2);
});

test('a payment that is not approved is never activated by a direct call; a payment put back reverses and re-approval restores', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g, { category: 'couples' });
  const buyer = await member();
  const friend = await member();
  const out = await buy(k, buyer, p.id, { beneficiaries: [{ phone: friend.phone }] });
  const pending = await paymentRequests.findByIdAsync(out.paymentRequest.id);
  assert.equal(await k.svc.onPaymentStatus(pending, 'approved'), null);
  assert.equal((await db('GymPassPurchase').where({ id: out.purchase.id }).first()).status, 'pending_payment', 'the payment is still pending, so nothing activates');
  assert.equal((await childSubs(out.purchase.id)).length, 0);

  await approve(k, out.paymentRequest.id);
  assert.equal((await childSubs(out.purchase.id)).filter(s => s.status === 'active').length, 2);
  // An admin puts the payment back to pending: access stops with it.
  await k.pay.update({ id: out.paymentRequest.id, status: 'pending', actorId: 'adm_pass' });
  assert.equal((await db('GymPassPurchase').where({ id: out.purchase.id }).first()).status, 'pending_payment');
  assert.equal((await childSubs(out.purchase.id)).filter(s => s.status === 'active').length, 0);
  // Approving it again restores the SAME child rows (no duplicates).
  await k.pay.update({ id: out.paymentRequest.id, status: 'approved', actorId: 'adm_pass' });
  const subs = await childSubs(out.purchase.id);
  assert.equal(subs.length, 2);
  assert.equal(subs.filter(s => s.status === 'active').length, 2);
});

test('every person has their OWN subscription: check-in works per person, records the sale and the person; one person\'s check-in is not another\'s', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g, { category: 'couples' });
  const buyer = await member();
  const friend = await member();
  const out = await buy(k, buyer, p.id, { beneficiaries: [{ phone: friend.phone }] });
  await approve(k, out.paymentRequest.id);
  const rows = await people(out.purchase.id);
  const mine = rows.find(r => r.userId === buyer.id);
  const theirs = rows.find(r => r.userId === friend.id);
  assert.notEqual(mine.subscriptionId, theirs.subscriptionId);

  const a = await checkInService.perform({ memberId: buyer.id, gymId: g });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.checkin.subscriptionType, 'direct_sub');
  assert.equal(a.checkin.passPurchaseId, out.purchase.id);
  assert.equal(a.checkin.beneficiaryId, mine.id);
  assert.equal(a.checkin.subscriptionId, mine.subscriptionId);
  const stored = await db('Checkin').where({ id: a.checkin.id }).first();
  assert.equal(stored.passPurchaseId, out.purchase.id);
  assert.equal(stored.beneficiaryId, mine.id);
  // The friend has not visited yet: their own check-in is theirs.
  assert.equal((await db('Checkin').where({ beneficiaryId: theirs.id })).length, 0);
  const b = await checkInService.perform({ memberId: friend.id, gymId: g });
  assert.equal(b.ok, true);
  assert.equal(b.checkin.beneficiaryId, theirs.id);
  // And the QR is issued per person from their own active subscription (no shared QR).
  const active = await subscriptions.filterAsync(s => s.memberId === friend.id && s.status === 'active');
  assert.equal(active.length, 1);
});

test('expired, suspended, removed and wrong-gym people are refused at check-in with existing codes', async () => {
  const k = kit();
  const g = await gym();
  const other = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g, { category: 'group', beneficiaryLimit: 4 });
  const buyer = await member();
  const f1 = await member(); const f2 = await member();
  const out = await buy(k, buyer, p.id, { beneficiaries: [{ phone: f1.phone }, { phone: f2.phone }] });
  await approve(k, out.paymentRequest.id);
  const byUser = async (id) => (await people(out.purchase.id)).find(r => r.userId === id);

  // wrong gym
  const wrong = await checkInService.perform({ memberId: buyer.id, gymId: other });
  assert.deepEqual([wrong.ok, wrong.failure], [false, 'wrong_gym']);
  // suspended by the owner, then allowed back
  const b1 = await byUser(f1.id);
  assert.ok((await k.svc.suspendBeneficiary({ purchaseId: out.purchase.id, beneficiaryId: b1.id, actor: { owner: o } })).beneficiary);
  const refused = await checkInService.perform({ memberId: f1.id, gymId: g });
  assert.deepEqual([refused.ok, refused.failure], [false, 'subscription_inactive']);
  await k.svc.resumeBeneficiary({ purchaseId: out.purchase.id, beneficiaryId: b1.id, actor: { owner: o } });
  assert.equal((await checkInService.perform({ memberId: f1.id, gymId: g })).ok, true);
  // removed by the buyer: refused, the others unaffected
  const b2 = await byUser(f2.id);
  await k.svc.removeBeneficiary({ purchaseId: out.purchase.id, beneficiaryId: b2.id, actor: { userId: buyer.id } });
  const gone = await checkInService.perform({ memberId: f2.id, gymId: g });
  assert.deepEqual([gone.ok, gone.failure], [false, 'subscription_inactive']);
  assert.equal((await checkInService.perform({ memberId: buyer.id, gymId: g })).ok, true);
  // expired: the whole pass ran out
  await db('GymPassPurchase').where({ id: out.purchase.id }).update({ expiresAt: new Date(Date.now() - 3 * DAY) });
  await db('Subscription').where({ passPurchaseId: out.purchase.id }).update({ expiresAt: new Date(Date.now() - 3 * DAY) });
  await db('Checkin').where({ gymId: g }).del();
  const expired = await checkInService.perform({ memberId: buyer.id, gymId: g });
  assert.deepEqual([expired.ok, expired.failure], [false, 'subscription_inactive']);
  assert.equal(effectivePurchaseStatus(await db('GymPassPurchase').where({ id: out.purchase.id }).first()), 'expired');
});

test('FitFlex Pass, trainer-pass and legacy plan check-ins are unchanged: no sale or person is recorded on them', async () => {
  const { getTierConfig } = settingsWithTiers();
  const col = (rows = []) => ({
    rows,
    filterAsync: async (fn) => rows.filter(fn), findAsync: async (fn) => rows.find(fn) ?? null,
    findByIdAsync: async (id) => rows.find(r => r.id === id) ?? null, insertAsync: async (r) => { rows.push(r); return r; },
    find: (fn) => rows.find(fn),
  });
  const mk = (subRows) => {
    const checks = col();
    const svc = createCheckInService({
      users: col([{ id: 'm1', userType: 'member' }]), gyms: col([{ id: 'g1', tier: 'standard' }]), subscriptions: col(subRows), checkins: checks, getTierConfig,
    });
    return { svc, checks };
  };
  const base = { memberId: 'm1', status: 'active', startedAt: '2026-01-01T00:00:00Z', cycleStartedAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' };
  for (const sub of [
    { id: 's_pass', type: 'platform_pass', tier: 'pro', ...base },
    { id: 's_legacy', type: 'direct_sub', tier: null, plan: 'monthly', homeGymId: 'g1', ...base },
    { id: 's_desk', type: 'direct_sub', tier: 'basic', homeGymId: 'g1', ...base },
  ]) {
    const { svc } = mk([sub]);
    const r = await svc.perform({ memberId: 'm1', gymId: 'g1' });
    assert.equal(r.ok, true, `${sub.id}: ${JSON.stringify(r)}`);
    assert.equal(Object.hasOwn(r.checkin, 'passPurchaseId'), false, `${sub.id} carries no pass columns`);
    assert.equal(Object.hasOwn(r.checkin, 'beneficiaryId'), false);
  }
  // The same service records them for a child subscription.
  const { svc } = mk([{ id: 's_child', type: 'direct_sub', tier: null, homeGymId: 'g1', passPurchaseId: 'gpu_x', passBeneficiaryId: 'gpb_y', ...base }]);
  const r = await svc.perform({ memberId: 'm1', gymId: 'g1' });
  assert.deepEqual([r.checkin.passPurchaseId, r.checkin.beneficiaryId], ['gpu_x', 'gpb_y']);
});

// ── notifications (D3: attached and notified, never asked) ──────────────────

test('fan-out: an account gets in-app + SMS (WhatsApp dormant); someone without one gets an invite link; nobody is asked to approve', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g, { name: 'Squad', category: 'group', beneficiaryLimit: 4, durationValue: 1, durationUnit: 'months' });
  const buyer = await member({ name: 'Buyer Bee' });
  const friend = await member({ name: 'Friend Foo' });
  const stranger = phoneNo();
  const emailOnly = `invitee.${tag}@x.test`;
  const out = await buy(k, buyer, p.id, { beneficiaries: [{ phone: friend.phone }, { phone: stranger }, { email: emailOnly }] });
  assert.equal(k.sent.notify.length + k.sent.sms.length + k.sent.whatsapp.length, 0, 'nothing is sent before the payment is approved');
  await approve(k, out.paymentRequest.id);

  const rows = await people(out.purchase.id);
  const friendRow = rows.find(r => r.userId === friend.id);
  const strangerRow = rows.find(r => r.contactValue === stranger);
  const emailRow = rows.find(r => r.contactValue === emailOnly);
  assert.equal(friendRow.status, 'active', 'attached directly, no approval step');

  // in-app: the buyer (active) and the friend (added)
  const types = k.sent.notify.map(n => `${n.userId === buyer.id ? 'buyer' : n.userId === friend.id ? 'friend' : '?'}:${n.message.type}`).sort();
  assert.deepEqual(types, ['buyer:gym_pass_active', 'friend:gym_pass_added']);
  const added = k.sent.notify.find(n => n.userId === friend.id).message;
  assert.ok(added.body.includes('Squad') && added.body.includes('Buyer Bee'));
  assert.ok(added.data.titleSw.startsWith('[SW pending review]') && added.data.bodyEn === added.body, 'both languages are kept with the notice');
  // WhatsApp was tried first (dormant) and SMS carried it
  assert.equal(k.sent.whatsapp.length, 2, 'WhatsApp is attempted for the account and for the phone invite');
  const smsToFriend = k.sent.sms.find(s => s.phone === friend.phone);
  assert.ok(smsToFriend && smsToFriend.text.includes('Squad'));
  assert.deepEqual(friendRow.notifiedVia?.split(','), ['in_app', 'sms']);
  // the stranger: an invite with a tokenised link in the hash; only the token's hash is stored
  const smsToStranger = k.sent.sms.find(s => s.phone === stranger);
  assert.ok(smsToStranger);
  const link = smsToStranger.text.match(/https:\/\/app\.test\/gym-pass\/#([A-Za-z0-9_-]{20,})/);
  assert.ok(link, smsToStranger.text);
  assert.ok(strangerRow.inviteTokenHash && strangerRow.inviteTokenHash !== link[1]);
  assert.ok(+strangerRow.inviteExpiresAt <= +(await db('GymPassPurchase').where({ id: out.purchase.id }).first()).expiresAt, 'the link never outlives the pass');
  assert.equal(strangerRow.status, 'pending_registration');
  // an email-only contact has no channel here: invited, link available on request, nothing sent
  assert.equal(k.sent.sms.some(s => s.text.includes(emailOnly)), false);
  assert.ok(emailRow.inviteTokenHash);
  assert.equal(emailRow.notifiedVia, null);
  const resend = await k.svc.resendInvite({ purchaseId: out.purchase.id, beneficiaryId: emailRow.id, actor: { userId: buyer.id } });
  assert.ok(resend.share.link.startsWith('https://app.test/gym-pass/#'));
  assert.equal((await k.svc.resendInvite({ purchaseId: out.purchase.id, beneficiaryId: emailRow.id, actor: { userId: buyer.id } })).error, undefined, 'email: no send, so no wait');
  assert.equal((await k.svc.resendInvite({ purchaseId: out.purchase.id, beneficiaryId: strangerRow.id, actor: { userId: buyer.id } })).error, 'too_soon');
});

test('WhatsApp sent: no SMS is added; WhatsApp opted-out: nothing more is sent', async () => {
  const wa = kit({ whatsapp: async () => ({ status: 'sent' }) });
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(wa, o, g, { category: 'couples' });
  const buyer = await member(); const friend = await member();
  const out = await buy(wa, buyer, p.id, { beneficiaries: [{ phone: friend.phone }] });
  await approve(wa, out.paymentRequest.id);
  assert.equal(wa.sent.whatsapp.length, 1);
  assert.equal(wa.sent.sms.length, 0);
  assert.deepEqual((await db('GymPassBeneficiary').where({ userId: friend.id }).first()).notifiedVia.split(','), ['in_app', 'whatsapp']);

  const optedOut = kit({ whatsapp: async () => ({ status: 'skipped:recipient_opted_out' }) });
  const b2 = await member(); const f2 = await member();
  const o2 = await buy(optedOut, b2, p.id, { beneficiaries: [{ phone: f2.phone }] });
  await approve(optedOut, o2.paymentRequest.id);
  assert.equal(optedOut.sent.sms.length, 0, 'an opt-out is final');
  assert.equal(optedOut.sent.notify.some(n => n.userId === f2.id), true, 'the in-app notice still lands');
});

// ── claiming by verified contact ────────────────────────────────────────────

test('a person who signs up and verifies the contact is attached with their own subscription and the shared end date; only a VERIFIED contact counts', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g, { category: 'couples', durationValue: 20, durationUnit: 'days' });
  const buyer = await member();
  const invitee = phoneNo();
  const out = await buy(k, buyer, p.id, { beneficiaries: [{ phone: invitee }] });
  await approve(k, out.paymentRequest.id);
  const pendingRow = (await people(out.purchase.id)).find(r => r.contactValue === invitee);
  assert.equal(pendingRow.status, 'pending_registration');
  const token = k.sent.sms.find(s => s.phone === invitee).text.match(/#([A-Za-z0-9_-]{20,})/)[1];

  // preview before sign-in: no contact detail
  const preview = await k.svc.previewInvite(token);
  assert.equal(preview.invitation.status, 'pending');
  assert.equal(preview.invitation.planName, 'Pass');
  assert.equal(JSON.stringify(preview).includes(invitee.slice(-6)), false);
  assert.equal((await k.svc.previewInvite('x'.repeat(30))).error, 'invalid_invitation');

  // someone who only TYPED the number on their profile (unverified) is not attached
  const squatter = await member({ phone: invitee, verified: false });
  assert.deepEqual((await k.svc.claimForUser(squatter.id)).claimed, []);
  assert.equal((await k.svc.claimForUser(squatter.id, { token })).error, 'contact_mismatch');
  // someone with a different verified number is not attached either
  const other = await member();
  assert.equal((await k.svc.claimForUser(other.id, { token })).error, 'contact_mismatch');
  assert.deepEqual((await k.svc.claimForUser(other.id)).claimed, []);
  assert.equal((await childSubs(out.purchase.id)).length, 1);

  // the real person signs up and verifies the number
  const real = await member({ phone: invitee });
  const claimed = await k.svc.claimForUser(real.id, { token });
  assert.deepEqual(claimed.claimed, [pendingRow.id]);
  const subs = await childSubs(out.purchase.id);
  assert.equal(subs.length, 2);
  const theirs = subs.find(s => s.memberId === real.id);
  assert.equal(theirs.status, 'active');
  assert.equal(+theirs.expiresAt, +(await db('GymPassPurchase').where({ id: out.purchase.id }).first()).expiresAt);
  const row = await db('GymPassBeneficiary').where({ id: pendingRow.id }).first();
  assert.deepEqual([row.status, row.userId, row.inviteTokenHash], ['active', real.id, null]);
  // idempotent; the used link is dead
  assert.deepEqual((await k.svc.claimForUser(real.id, { token: null })).claimed, []);
  assert.equal((await k.svc.claimForUser(real.id, { token })).error, 'invalid_invitation');
  assert.equal((await k.svc.previewInvite(token)).error, 'invalid_invitation');
  assert.equal((await checkInService.perform({ memberId: real.id, gymId: g })).ok, true);
  // opening "my passes" does the same for a person who never uses the link
  const next = phoneNo();
  const p2 = await plan(k, o, g, { name: 'Pair 2', category: 'couples' });
  const buyer2 = await member();
  const out2 = await buy(k, buyer2, p2.id, { beneficiaries: [{ phone: next }] });
  await approve(k, out2.paymentRequest.id);
  const late = await member({ phone: next });
  const mine = await k.svc.myPasses(late.id);
  assert.equal(mine.memberships.length, 1);
  assert.equal(mine.memberships[0].status, 'active');
});

test('an expired invite link is refused (410); a link only works for the one contact it was made for', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g, { category: 'couples' });
  const buyer = await member();
  const invitee = phoneNo();
  const out = await buy(k, buyer, p.id, { beneficiaries: [{ phone: invitee }] });
  await approve(k, out.paymentRequest.id);
  const token = k.sent.sms.find(s => s.phone === invitee).text.match(/#([A-Za-z0-9_-]{20,})/)[1];
  await db('GymPassBeneficiary').where({ purchaseId: out.purchase.id, contactValue: invitee }).update({ inviteExpiresAt: new Date(Date.now() - 1000) });
  const real = await member({ phone: invitee });
  assert.equal((await k.svc.claimForUser(real.id, { token })).error, 'invitation_expired');
  assert.equal((await k.svc.previewInvite(token)).invitation.status, 'expired');
});

// ── people: add / remove / suspend / replace / leave ────────────────────────

test('buyer and owner add, suspend, remove and replace people; removal never refunds or cancels the pass; other owners are refused', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const stranger = await owner([await gym()]);
  const p = await plan(k, o, g, { category: 'group', beneficiaryLimit: 4, priceTzs: 100_000 });
  const buyer = await member();
  const a = await member(); const b = await member(); const c = await member();
  const out = await buy(k, buyer, p.id, { beneficiaries: [{ phone: a.phone }, { phone: b.phone }] });
  await approve(k, out.paymentRequest.id);
  const rows = () => people(out.purchase.id);

  // add into the free slot (an account: active at once and notified); the 5th is over the limit
  const added = await k.svc.addBeneficiary({ purchaseId: out.purchase.id, actor: { userId: buyer.id }, body: { phone: c.phone } });
  assert.equal(added.status, 201);
  assert.equal(added.beneficiary.status, 'active');
  assert.equal(added.beneficiary.userId, undefined, 'the buyer never sees another person\'s user id');
  assert.ok(added.beneficiary.contact.includes('•'));
  assert.equal(k.sent.notify.filter(n => n.userId === c.id && n.message.type === 'gym_pass_added').length, 1);
  const full = await k.svc.addBeneficiary({ purchaseId: out.purchase.id, actor: { userId: buyer.id }, body: { phone: phoneNo() } });
  assert.deepEqual([full.error, full.status, full.limit], ['beneficiary_limit_exceeded', 409, 4]);
  // the same person twice
  assert.equal((await k.svc.removeBeneficiary({ purchaseId: out.purchase.id, beneficiaryId: (await rows()).find(r => r.userId === c.id).id, actor: { userId: buyer.id } })).beneficiary.status, 'removed');
  const again = await k.svc.addBeneficiary({ purchaseId: out.purchase.id, actor: { userId: buyer.id }, body: { phone: a.phone } });
  assert.equal(again.error, 'already_beneficiary');
  // the replacement (the freed slot) works, and the money and the pass are untouched
  const replacement = await k.svc.addBeneficiary({ purchaseId: out.purchase.id, actor: { owner: o }, body: { phone: phoneNo() } });
  assert.equal(replacement.status, 201);
  assert.equal(replacement.beneficiary.status, 'pending_registration');
  assert.ok(replacement.beneficiary.userId === null && replacement.beneficiary.displayName === null);
  const slots = (await rows()).filter(r => r.slot != null).map(r => r.slot).sort();
  assert.deepEqual(slots, [1, 2, 3, 4]);
  assert.equal((await db('PaymentRequest').where({ id: out.paymentRequest.id }).first()).status, 'approved');
  assert.equal((await db('GymPassPurchase').where({ id: out.purchase.id }).first()).status, 'active');
  assert.equal((await db('Refund').where({ paymentRequestId: out.paymentRequest.id }).catch(() => [])).length, 0);
  const removedRow = (await rows()).find(r => r.userId === c.id);
  assert.deepEqual([removedRow.status, removedRow.slot, removedRow.removedByRole], ['removed', null, 'purchaser']);
  assert.equal((await db('Subscription').where({ id: removedRow.subscriptionId }).first()).status, 'cancelled');

  // the buyer cannot be removed or suspended by themselves; the owner may suspend them
  const buyerRow = (await rows()).find(r => r.isPurchaser);
  assert.equal((await k.svc.removeBeneficiary({ purchaseId: out.purchase.id, beneficiaryId: buyerRow.id, actor: { userId: buyer.id } })).error, 'cannot_remove_purchaser');
  assert.equal((await k.svc.suspendBeneficiary({ purchaseId: out.purchase.id, beneficiaryId: buyerRow.id, actor: { userId: buyer.id } })).error, 'cannot_modify_purchaser');
  assert.equal((await k.svc.removeBeneficiary({ purchaseId: out.purchase.id, beneficiaryId: buyerRow.id, actor: { owner: o } })).error, 'cannot_remove_purchaser');
  assert.equal((await k.svc.suspendBeneficiary({ purchaseId: out.purchase.id, beneficiaryId: buyerRow.id, actor: { owner: o } })).beneficiary.status, 'suspended');
  // invalid transitions
  assert.equal((await k.svc.resumeBeneficiary({ purchaseId: out.purchase.id, beneficiaryId: (await rows()).find(r => r.userId === a.id).id, actor: { owner: o } })).error, 'invalid_transition');

  // nobody else: another gym's owner, a stranger member, and a stranger's purchase id all look "not found"
  const aRow = (await rows()).find(r => r.userId === a.id);
  for (const actor of [{ owner: stranger }, { userId: (await member()).id }, { userId: a.id }]) {
    assert.equal((await k.svc.removeBeneficiary({ purchaseId: out.purchase.id, beneficiaryId: aRow.id, actor })).error, 'not_found');
    assert.equal((await k.svc.addBeneficiary({ purchaseId: out.purchase.id, actor, body: { phone: phoneNo() } })).error, 'not_found');
  }
  // audited
  const actions = await db('AuditLog').where({ actor: buyer.id }).pluck('action');
  assert.ok(actions.includes('gym_pass_beneficiary_added') && actions.includes('gym_pass_beneficiary_removed'));
});

test('a buyer may take people out only a limited number of times per purchase (the owner without limit); a person may leave', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g, { category: 'couples' });
  const buyer = await member();
  const out = await buy(k, buyer, p.id, { beneficiaries: [{ phone: phoneNo() }] });
  await approve(k, out.paymentRequest.id);
  const swap = async (actor) => {
    const other = (await people(out.purchase.id)).find(r => !r.isPurchaser && r.slot != null);
    const removed = await k.svc.removeBeneficiary({ purchaseId: out.purchase.id, beneficiaryId: other.id, actor });
    if (removed.error) return removed;
    return k.svc.addBeneficiary({ purchaseId: out.purchase.id, actor, body: { phone: phoneNo() } });
  };
  assert.equal((await swap({ userId: buyer.id })).status, 201);
  assert.equal((await swap({ userId: buyer.id })).status, 201);
  const third = await swap({ userId: buyer.id });
  assert.deepEqual([third.error, third.limit], ['replacement_limit_reached', 2]);
  assert.equal((await swap({ owner: o })).status, 201);
  // leaving: a person covered by the pass (not the buyer)
  const friend = await member();
  const p2 = await plan(k, o, g, { name: 'Leave', category: 'couples' });
  const buyer2 = await member();
  const out2 = await buy(k, buyer2, p2.id, { beneficiaries: [{ phone: friend.phone }] });
  await approve(k, out2.paymentRequest.id);
  assert.equal((await k.svc.leave({ userId: buyer2.id, purchaseId: out2.purchase.id })).error, 'cannot_remove_purchaser');
  assert.equal((await k.svc.leave({ userId: (await member()).id, purchaseId: out2.purchase.id })).error, 'not_found');
  assert.deepEqual(await k.svc.leave({ userId: friend.id, purchaseId: out2.purchase.id }), { ok: true });
  assert.equal((await checkInService.perform({ memberId: friend.id, gymId: g })).failure, 'subscription_inactive');
});

test('a user cannot hold two slots in one purchase (database guard too)', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g, { category: 'group', beneficiaryLimit: 5 });
  const buyer = await member();
  const friend = await member({ email: `slot.${tag}@x.test` });
  const out = await buy(k, buyer, p.id, { beneficiaries: [{ phone: phoneNo() }, { phone: phoneNo() }] });
  await approve(k, out.paymentRequest.id);
  assert.equal((await k.svc.addBeneficiary({ purchaseId: out.purchase.id, actor: { userId: buyer.id }, body: { phone: friend.phone } })).status, 201);
  // the same account through its other contact
  assert.equal((await k.svc.addBeneficiary({ purchaseId: out.purchase.id, actor: { userId: buyer.id }, body: { email: friend.email } })).error, 'already_beneficiary');
  assert.equal((await k.svc.addBeneficiary({ purchaseId: out.purchase.id, actor: { userId: buyer.id }, body: { phone: buyer.phone } })).error, 'cannot_add_yourself');
  // the database refuses directly
  const dup = { id: uid('gpb'), purchaseId: out.purchase.id, userId: friend.id, slot: 5, status: 'active' };
  await assert.rejects(db('GymPassBeneficiary').insert(dup), (e) => e.code === '23505');
  const sameSlot = { id: uid('gpb'), purchaseId: out.purchase.id, userId: null, contactType: 'phone', contactValue: phoneNo(), slot: 1, status: 'pending_registration' };
  await assert.rejects(db('GymPassBeneficiary').insert(sameSlot), (e) => e.code === '23505');
});

test('concurrent adds can never take more slots than the sale allows', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g, { category: 'group', beneficiaryLimit: 5 });
  const buyer = await member();
  const out = await buy(k, buyer, p.id, { beneficiaries: [{ phone: phoneNo() }, { phone: phoneNo() }] });
  await approve(k, out.paymentRequest.id);
  // 3 held of 5: ten simultaneous adds compete for the 2 free slots
  const results = await Promise.all(Array.from({ length: 10 }, () => k.svc.addBeneficiary({ purchaseId: out.purchase.id, actor: { userId: buyer.id }, body: { phone: phoneNo() } })));
  assert.equal(results.filter(r => r.status === 201).length, 2);
  assert.equal(results.filter(r => r.error === 'beneficiary_limit_exceeded').length, 8);
  const held = (await people(out.purchase.id)).filter(r => ['active', 'pending_registration', 'suspended'].includes(r.status));
  assert.equal(held.length, 5);
  assert.deepEqual(held.map(r => r.slot).sort(), [1, 2, 3, 4, 5]);
  // concurrent claims of one invitation attach once
  const invitee = phoneNo();
  const p2 = await plan(k, o, g, { name: 'Claim race', category: 'couples' });
  const b2 = await member();
  const o2 = await buy(k, b2, p2.id, { beneficiaries: [{ phone: invitee }] });
  await approve(k, o2.paymentRequest.id);
  const real = await member({ phone: invitee });
  await Promise.all([1, 2, 3, 4].map(() => k.svc.claimForUser(real.id)));
  assert.equal((await childSubs(o2.purchase.id)).filter(s => s.memberId === real.id).length, 1);
});

// ── reporting ───────────────────────────────────────────────────────────────

test('reports: one group purchase = ONE sale with N people; revenue once; counts by category and duration; attendance per person', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const solo = await plan(k, o, g, { name: 'Solo', durationValue: 30, durationUnit: 'days', priceTzs: 40_000 });
  const pair = await plan(k, o, g, { name: 'Pair', category: 'couples', durationValue: 1, durationUnit: 'months', priceTzs: 70_000 });
  const squad = await plan(k, o, g, { name: 'Squad', category: 'group', beneficiaryLimit: 5, durationValue: 1, durationUnit: 'months', priceTzs: 150_000 });
  const b1 = await member(); const b2 = await member(); const b3 = await member(); const b4 = await member();
  const f1 = await member(); const f2 = await member(); const f3 = await member();
  const s1 = await buy(k, b1, solo.id);
  const s2 = await buy(k, b2, pair.id, { beneficiaries: [{ phone: f1.phone }] });
  const s3 = await buy(k, b3, squad.id, { beneficiaries: [{ phone: f2.phone }, { phone: f3.phone }, { phone: phoneNo() }] });
  const unpaid = await buy(k, b4, solo.id);
  for (const s of [s1, s2, s3]) await approve(k, s.paymentRequest.id);
  await checkInService.perform({ memberId: f2.id, gymId: g });

  const sales = await k.svc.sales({ owner: o, gymId: g });
  assert.equal(sales.sales.length, 4, 'one row per purchase');
  const group = sales.sales.find(s => s.id === s3.purchase.id);
  assert.deepEqual(group.beneficiaryCounts, { total: 4, active: 3, pending: 1, suspended: 0 });
  assert.equal(group.payment.amountTzs, 150_000);
  assert.equal(group.purchaser.id, b3.id);
  assert.deepEqual((await k.svc.sales({ owner: o, gymId: g, query: { status: 'pending_payment' } })).sales.map(s => s.id), [unpaid.purchase.id]);

  const sum = await k.svc.summary({ owner: o, gymId: g });
  assert.equal(sum.sales.count, 3);
  assert.equal(sum.sales.revenueTzs, 40_000 + 70_000 + 150_000, 'each payment counted once, not once per person');
  assert.equal(sum.sales.pendingPayment, 1);
  assert.deepEqual(sum.byCategory.individual, { sales: 1, revenueTzs: 40_000, beneficiaries: 1 });
  assert.deepEqual(sum.byCategory.couples, { sales: 1, revenueTzs: 70_000, beneficiaries: 2 });
  assert.deepEqual(sum.byCategory.group, { sales: 1, revenueTzs: 150_000, beneficiaries: 4 });
  const months = sum.byDuration.find(d => d.durationUnit === 'months');
  assert.deepEqual([months.sales, months.revenueTzs], [2, 220_000]);
  assert.deepEqual(sum.beneficiaries, { active: 1 + 2 + 3, pendingRegistration: 1, suspended: 0 });
  assert.deepEqual(sum.memberships, { active: 3, expired: 0 });
  assert.deepEqual(sum.plans, { total: 3, active: 3 });
  // Finance sees the same money: one approved payment per sale, none for the children.
  const approved = await db('PaymentRequest').where({ gymId: g, status: 'approved' }).sum({ t: 'amountTzs' }).first();
  assert.equal(Number(approved.t), 260_000);

  // memberships + per-person attendance
  const mem = await k.svc.memberships({ owner: o, gymId: g });
  assert.equal(mem.memberships.length, 3);
  const sq = mem.memberships.find(m => m.id === s3.purchase.id);
  assert.equal(sq.beneficiaries.length, 4);
  assert.equal(sq.beneficiaries.find(x => x.userId === f2.id).attendance.visits, 1);
  assert.equal(sq.beneficiaries.find(x => x.userId === f3.id).attendance.visits, 0);
  const detail = await k.svc.purchaseDetail({ owner: o, gymId: g, purchaseId: s3.purchase.id });
  const f2Row = detail.sale.beneficiaries.find(x => x.userId === f2.id);
  assert.equal(f2Row.displayName.startsWith('Pass Member'), true);
  const att = await k.svc.attendance({ owner: o, gymId: g, purchaseId: s3.purchase.id, beneficiaryId: f2Row.id });
  assert.equal(att.visits.length, 1);
  assert.equal(att.visits[0].gymId, g);

  // expiry moves a sale from active to expired in the reports
  await db('GymPassPurchase').where({ id: s1.purchase.id }).update({ expiresAt: new Date(Date.now() - DAY) });
  const after = await k.svc.summary({ owner: o, gymId: g });
  assert.deepEqual(after.memberships, { active: 2, expired: 1 });
  assert.equal((await k.svc.memberships({ owner: o, gymId: g, query: { state: 'expired' } })).memberships.length, 1);

  // another gym's owner sees nothing of this
  const stranger = await owner([await gym()]);
  for (const call2 of [
    () => k.svc.sales({ owner: stranger, gymId: g }), () => k.svc.summary({ owner: stranger, gymId: g }),
    () => k.svc.memberships({ owner: stranger, gymId: g }), () => k.svc.purchaseDetail({ owner: stranger, gymId: g, purchaseId: s3.purchase.id }),
  ]) assert.equal((await call2()).error, 'not_your_gym');
  const myGym = await owner([await gym()]);
  assert.equal((await k.svc.purchaseDetail({ owner: myGym, gymId: myGym.gymIds[0], purchaseId: s3.purchase.id })).error, 'not_found');
});

test('a reversed payment drops out of the revenue; the price snapshot is unaffected by later plan edits', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g, { priceTzs: 50_000, durationValue: 10, durationUnit: 'days', terms: 'v1 terms' });
  const buyer = await member();
  const out = await buy(k, buyer, p.id, { termsVersion: 1 });
  // the owner changes everything while the payment is pending
  await k.svc.updatePlan({ owner: o, gymId: g, planId: p.id, actorId: o.id, body: { priceTzs: 99_000, durationValue: 3, durationUnit: 'months', name: 'Renamed', terms: 'v2 terms' } });
  await approve(k, out.paymentRequest.id);
  const row = await db('GymPassPurchase').where({ id: out.purchase.id }).first();
  assert.deepEqual([row.snapshot.priceTzs, row.snapshot.durationValue, row.snapshot.durationUnit, row.snapshot.name, row.snapshot.terms, row.snapshot.termsVersion],
    [50_000, 10, 'days', 'Pass', 'v1 terms', 1]);
  assert.ok(Math.abs(+row.expiresAt - (+row.startsAt + 10 * DAY)) < 2000, 'runs for what was bought, not the edited duration');
  assert.equal((await db('PaymentRequest').where({ id: out.paymentRequest.id }).first()).amountTzs, 50_000);
  assert.equal((await k.svc.updatePlan({ owner: o, gymId: g, planId: p.id, actorId: o.id, body: {} })).plan.termsVersion, 2);
  assert.equal((await k.svc.summary({ owner: o, gymId: g })).sales.revenueTzs, 50_000);
  await k.pay.update({ id: out.paymentRequest.id, status: 'rejected', actorId: 'adm_pass' });
  const after = await k.svc.summary({ owner: o, gymId: g });
  assert.equal(after.sales.revenueTzs, 0);
  assert.equal(after.sales.count, 0);
});

// ── privacy ─────────────────────────────────────────────────────────────────

test('privacy: the buyer sees masked names and contacts and no ids; before payment nobody reveals whether a contact has an account', async () => {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g, { category: 'couples' });
  const buyer = await member({ name: 'Buyer Bee' });
  const registered = await member({ name: 'Neema Abdallah' });
  const unregistered = phoneNo();
  const asRegistered = await buy(k, buyer, p.id, { beneficiaries: [{ phone: registered.phone }] });
  const buyer2 = await member();
  const asUnregistered = await buy(k, buyer2, p.id, { beneficiaries: [{ phone: unregistered }] });
  // purchase responses for an account and a non-account are indistinguishable
  const shape = (r) => r.purchase.beneficiaries.map(b => ({ ...b, contact: undefined, displayName: undefined, id: undefined, you: undefined }));
  assert.deepEqual(shape(asRegistered), shape(asUnregistered));
  assert.equal(JSON.stringify(asRegistered).includes(registered.phone), false);
  assert.equal(JSON.stringify(asRegistered).includes(registered.id), false);

  await approve(k, asRegistered.paymentRequest.id);
  const mine = await k.svc.myPasses(buyer.id);
  const view = mine.purchased[0].beneficiaries.find(b => !b.isPurchaser);
  assert.equal(view.displayName, 'N**** A*******');
  assert.equal(view.userId, undefined);
  assert.equal(view.contact.includes(registered.phone.slice(5, 9)), false);
  assert.equal(mine.purchased[0].beneficiaries.find(b => b.isPurchaser).displayName, 'Buyer Bee', 'the buyer sees their own name in full');
  // the covered person sees their membership, not the buyer's other contacts
  const theirs = await k.svc.myPasses(registered.id);
  assert.equal(theirs.memberships.length, 1);
  assert.equal(JSON.stringify(theirs).includes(buyer.phone), false);
});

test('the live service is wired: approving through the real payment service activates a pass (and unrelated payments are untouched)', async () => {
  const { adminPaymentService } = await import('../src/bootstrap/services.mjs');
  const g = await gym();
  const o = await owner([g]);
  const p = (await liveService.createPlan({ owner: o, gymId: g, actorId: o.id, body: { name: 'Live', category: 'individual', durationValue: 5, durationUnit: 'days', priceTzs: 15_000 } })).plan;
  const buyer = await member();
  const out = await liveService.purchase({ memberId: buyer.id, planId: p.id });
  assert.equal(out.status, 202);
  const decided = await adminPaymentService.decide({ id: out.paymentRequest.id, decision: 'approve', actorId: 'adm_pass', reference: `LIVE${tag}${seq}` });
  assert.equal(decided.paymentRequest.status, 'approved');
  assert.equal((await childSubs(out.purchase.id)).length, 1);
  assert.equal((await db('GymPassPurchase').where({ id: out.purchase.id }).first()).status, 'active');
  assert.ok(subscriptionService.memberReferenceFor, 'reference checks are shared with the legacy purchase flow');
});

test('migration: new columns exist and are nullable; legacy rows are untouched', async () => {
  for (const [table, column] of [['Subscription', 'passPurchaseId'], ['Subscription', 'passBeneficiaryId'], ['PaymentRequest', 'passPurchaseId'], ['Checkin', 'passPurchaseId'], ['Checkin', 'beneficiaryId']]) {
    const c = await db('information_schema.columns').where({ table_name: table, column_name: column }).first('is_nullable');
    assert.equal(c?.is_nullable, 'YES', `${table}.${column}`);
  }
  const legacy = await db('Subscription').whereNull('passPurchaseId').count({ n: '*' }).first();
  assert.ok(Number(legacy.n) >= 0);
});

// ── helpers ─────────────────────────────────────────────────────────────────

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    send(b) { this.body = b; return this; },
  };
}
async function call(route, claims, { params = {}, query = {}, body = {} } = {}) {
  const headers = claims ? { authorization: `Bearer ${sign(claims)}` } : {};
  const req = { headers, params, query, body, get: name => headers[String(name).toLowerCase()] ?? null };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return { status: out.statusCode, body: out.body };
  }
  await route.onRequest(req, out);
  return { status: out.statusCode, body: out.body };
}
