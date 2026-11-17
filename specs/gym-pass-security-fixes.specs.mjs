// Custom gym passes — security-review fixes for PR #355 (CI database only: everything here writes).
// Masked owner add, Members-list masking, who may resume a suspension, owner-removed / left contacts, abuse caps and
// 429s, generic checkout error, no account oracle, account erasure, claim clearing contacts, redacted SMS log,
// activation eligibility, invite-expiry semantics, audit failures at error level.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import * as routes from '../functions/gym-passes.mjs';
import { gyms, users, subscriptions, paymentRequests, auditLog } from '../src/bootstrap/collections.mjs';
import { verifiedContacts, gymPassStore, checkInService, memberManagement } from '../src/bootstrap/services.mjs';
import { createGymPassService, safeDisplayName, gymPassLimits } from '../src/services/gym-pass-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { createAccountErasure } from '../src/infra/account-erasure-store-pg.mjs';
import { normalizePhone } from '../src/shared/identifiers.mjs';
import { verifyContacts, purgeIdentity } from './fixtures/verified-contacts.mjs';

await ensureInit();

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const tag = randomUUID().slice(0, 6);
const made = { users: [], gyms: [] };
let seq = 0;
const phoneNo = () => `+2557${String(10000000 + Math.floor(Math.random() * 89999999)).slice(0, 8)}`;
const sha = (type, value) => createHash('sha256').update(`${type}:${value}`).digest('hex');
const LIMIT_ENV = ['GYM_PASS_OWNER_ADDS_PER_GYM_PER_HOUR', 'GYM_PASS_BUYER_ADDS_PER_HOUR', 'GYM_PASS_TARGET_PER_DAY',
  'GYM_PASS_ADD_ATTEMPTS_PER_HOUR', 'GYM_PASS_SENDS_PER_PURCHASE', 'GYM_CUSTOM_PASSES'];

before(async () => {
  const { rows } = await db.raw('select current_database() as name');
  assert.match(rows[0].name, /^fitflex_ci/, 'refusing to run against a database that is not a CI database');
});
afterEach(() => { for (const k of LIMIT_ENV) delete process.env[k]; routes.resetGymPassLimits(); });

async function member({ phone = phoneNo(), email = null, name = null, accountStatus = 'active', userType = 'member' } = {}) {
  const id = uid('usr');
  seq += 1;
  await db('User').insert({ id, userType, displayName: name ?? `Fix Member ${seq}`, accountStatus, updatedAt: new Date() });
  made.users.push(id);
  await verifyContacts(db, id, { phone, email });
  return { id, phone, email };
}
async function gym() {
  const id = uid('gym');
  await gyms.insertAsync({ id, name: `Fix Gym ${tag}`, tier: 'standard', location: 'Dar es Salaam', status: 'active' });
  made.gyms.push(id);
  return id;
}
async function owner(gymIds) {
  const id = uid('own');
  await db('User').insert({ id, userType: 'gym_operator', displayName: 'Fix Owner', gymIds, gymId: gymIds[0], updatedAt: new Date() });
  made.users.push(id);
  return { id, gymIds, userType: 'gym_operator' };
}

function kit({ blocks = null, auditLogImpl = auditLog } = {}) {
  const sent = { notify: [], sms: [], whatsapp: [] };
  const svc = createGymPassService({
    store: gymPassStore, gyms, users, auditLog: auditLogImpl, blocks,
    contacts: { findMember: verifiedContacts.findMember, contactsFor: verifiedContacts.contactsFor },
    notify: async (userId, message) => { sent.notify.push({ userId, message }); return {}; },
    channels: {
      whatsapp: async (p) => { sent.whatsapp.push(p); return { status: 'skipped:whatsapp_not_available' }; },
      sms: async (p) => { sent.sms.push(p); return { status: 'sent' }; },
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
  const out = await k.svc.createPlan({ owner: own, gymId, actorId: own.id, body: { name: 'Pass', category: 'group', beneficiaryLimit: 6, durationValue: 30, durationUnit: 'days', priceTzs: 50_000, ...body } });
  assert.equal(out.status, 201, JSON.stringify(out));
  return out.plan;
}
async function buy(k, buyer, planId, beneficiaries = []) {
  const out = await k.svc.purchase({ memberId: buyer.id, planId, beneficiaries });
  assert.equal(out.status, 202, JSON.stringify(out));
  return out;
}
const approve = (k, paymentId) => k.pay.decide({ id: paymentId, decision: 'approve', actorId: 'adm_fix', reference: `REF${randomUUID().slice(0, 8).toUpperCase()}` });
const people = (purchaseId) => db('GymPassBeneficiary').where({ purchaseId }).orderBy('slot');
/** A running group pass with `n` extra people (accounts or phones). */
async function running(k, { extra = [], limit = 6 } = {}) {
  const g = await gym();
  const o = await owner([g]);
  const p = await plan(k, o, g, { beneficiaryLimit: limit });
  const buyer = await member({ name: 'Buyer Bee' });
  // A group needs 3 in all at checkout: the buyer plus two.
  const people_ = extra.length ? extra : [{ phone: phoneNo() }, { phone: phoneNo() }];
  const out = await buy(k, buyer, p.id, people_);
  await approve(k, out.paymentRequest.id);
  return { g, o, p, buyer, purchaseId: out.purchase.id };
}

after(async () => {
  const purchaseIds = await db('GymPassPurchase').whereIn('gymId', made.gyms).pluck('id');
  const paymentIds = await db('PaymentRequest').whereIn('gymId', made.gyms).pluck('id');
  await db('Checkin').whereIn('gymId', made.gyms).del();
  await db('Subscription').whereIn('memberId', made.users).del();
  await db('GymPassContactBlock').whereIn('buyerId', made.users).del();
  await db('GymPassBeneficiary').whereIn('purchaseId', purchaseIds).del();
  await db('GymPassPurchase').whereIn('id', purchaseIds).del();
  await db('GymPassPlan').whereIn('gymId', made.gyms).del();
  await db('PaymentRequest').whereIn('id', paymentIds).del();
  await db('Notification').whereIn('userId', made.users).del();
  await db('AuditLog').whereIn('actor', [...made.users, 'adm_fix']).del().catch(() => {});
  const persons = await purgeIdentity(db, made.users);
  await db('User').whereIn('id', made.users).del();
  if (persons?.length) await db('Person').whereIn('id', persons).del().catch(() => {});
  await db('Gym').whereIn('id', made.gyms).del();
  await db.destroy();
});

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
  const req = { headers, params, query, body, user: claims ? { sub: claims.sub } : undefined, get: name => headers[String(name).toLowerCase()] ?? null };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return { status: out.statusCode, body: out.body, headers: out.headers };
  }
  await route.onRequest(req, out);
  return { status: out.statusCode, body: out.body, headers: out.headers };
}

// ── finding 1: owner add is masked; Members list hides full phone/photo until a first visit ──────────────────

test('F1 owner add: masked contact and "invited" only, for an account and for a stranger alike; no id, no name', async () => {
  const k = kit();
  const base = await running(k, { extra: [{ phone: phoneNo() }, { phone: phoneNo() }], limit: 10 });
  const account = await member({ name: 'Secret Name' });
  const stranger = phoneNo();
  const a = await k.svc.addBeneficiary({ purchaseId: base.purchaseId, actor: { owner: base.o }, body: { phone: account.phone } });
  const s = await k.svc.addBeneficiary({ purchaseId: base.purchaseId, actor: { owner: base.o }, body: { phone: stranger } });
  for (const out of [a, s]) {
    assert.equal(out.status, 201, JSON.stringify(out));
    assert.deepEqual(Object.keys(out.beneficiary).sort(), ['contact', 'contactType', 'id', 'isPurchaser', 'slot', 'status']);
    assert.equal(out.beneficiary.status, 'invited');
    assert.equal(out.beneficiary.contactType, 'phone');
    assert.ok(out.beneficiary.contact.includes('•'));
  }
  const text = JSON.stringify([a, s]);
  assert.equal(text.includes(account.id), false);
  assert.equal(text.includes('Secret Name'), false);
  assert.equal(text.includes(account.phone), false);
  assert.equal(text.includes(stranger), false);
  // yet the account really was attached
  assert.equal((await db('GymPassBeneficiary').where({ id: a.beneficiary.id }).first()).status, 'active');
  assert.equal((await db('GymPassBeneficiary').where({ id: s.beneficiary.id }).first()).status, 'pending_registration');
  // a buyer's add reads the same for both
  const b1 = await member(); const buyerAdd1 = await k.svc.addBeneficiary({ purchaseId: base.purchaseId, actor: { userId: base.buyer.id }, body: { phone: b1.phone } });
  const buyerAdd2 = await k.svc.addBeneficiary({ purchaseId: base.purchaseId, actor: { userId: base.buyer.id }, body: { phone: phoneNo() } });
  const shape = (o) => ({ ...o.beneficiary, id: undefined, slot: undefined, contact: undefined });
  assert.deepEqual(shape(buyerAdd1), shape(buyerAdd2), 'the buyer cannot tell an account from a stranger');
  assert.equal(buyerAdd1.beneficiary.status, 'invited');
});

test('F1 owner adds are rate-limited per owner, per gym, per hour (429 rate_limited + retryAfterSeconds)', async () => {
  process.env.GYM_PASS_OWNER_ADDS_PER_GYM_PER_HOUR = '2';
  const k = kit();
  const base = await running(k, { extra: [{ phone: phoneNo() }, { phone: phoneNo() }], limit: 10 });
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await k.svc.addBeneficiary({ purchaseId: base.purchaseId, actor: { owner: base.o }, body: { phone: phoneNo() } })).status, 201);
  }
  const third = await k.svc.addBeneficiary({ purchaseId: base.purchaseId, actor: { owner: base.o }, body: { phone: phoneNo() } });
  assert.equal(third.error, 'rate_limited');
  assert.equal(third.status, 429);
  assert.ok(third.retryAfterSeconds >= 1 && third.retryAfterSeconds <= 3600);
  // another owner of another gym is not affected (the count is per owner and per gym)
  const other = await running(k, { extra: [{ phone: phoneNo() }, { phone: phoneNo() }], limit: 10 });
  assert.equal((await k.svc.addBeneficiary({ purchaseId: other.purchaseId, actor: { owner: other.o }, body: { phone: phoneNo() } })).status, 201);
  // and the route answers the 429 with a Retry-After header
  process.env.GYM_CUSTOM_PASSES = '1';
  const out = await call(routes.ownerGymPassAddPerson, { sub: base.o.id, userType: 'gym_operator' }, { params: { gymId: base.g, purchaseId: base.purchaseId }, body: { phone: phoneNo() } });
  assert.equal(out.status, 429);
  assert.equal(out.body.error, 'rate_limited');
  assert.ok(out.headers['Retry-After']);
});

test('F1 Members list: a person attached by a pass shows a masked phone and no photo until a first valid visit; rows without a pass are unchanged', async () => {
  const k = kit();
  const base = await running(k);
  const passPhone = '+255712345678';
  const friend = await member({ phone: passPhone });
  await db('User').where({ id: friend.id }).update({ phone: passPhone, photoUrl: '/storage/x/friend.jpg' });
  const added = await k.svc.addBeneficiary({ purchaseId: base.purchaseId, actor: { owner: base.o }, body: { phone: passPhone } });
  assert.equal(added.status, 201);

  // a legacy direct member of the same gym, with the same kind of profile data
  const legacy = await member({ phone: phoneNo() });
  const legacyPhone = '+255755555555';
  await db('User').where({ id: legacy.id }).update({ phone: legacyPhone, photoUrl: '/storage/x/legacy.jpg' });
  const start = new Date();
  await db('Subscription').insert({
    id: uid('sub'), memberId: legacy.id, type: 'direct_sub', tier: 'basic', plan: 'monthly', status: 'active', startedAt: start, cycleStartedAt: start,
    renewsAt: new Date(+start + 30 * 86_400_000), expiresAt: new Date(+start + 30 * 86_400_000), homeGymId: base.g,
  });

  const list = async () => (await memberManagement.listMembers({ owner: base.o, query: { gymId: base.g } })).members;
  let rows = await list();
  const passRow = rows.find(r => r.id === friend.id);
  const legacyRow = rows.find(r => r.id === legacy.id);
  assert.ok(passRow && legacyRow);
  assert.equal(passRow.photoUrl, null);
  assert.ok(passRow.phone.includes('•') && passRow.phone !== passPhone, passRow.phone);
  // searching by the full number finds nothing: the search cannot be used to confirm who a number belongs to
  assert.equal((await memberManagement.listMembers({ owner: base.o, query: { gymId: base.g, search: passPhone } })).members.some(r => r.id === friend.id), false);
  // legacy row: exactly as before (full phone, photo)
  assert.equal(legacyRow.phone, legacyPhone);
  assert.equal(legacyRow.photoUrl, '/storage/x/legacy.jpg');
  assert.deepEqual(Object.keys(legacyRow).sort(), ['daysLeft', 'displayName', 'expiresAt', 'id', 'lastCheckinAt', 'memberType', 'phone', 'photoUrl', 'publicId', 'startDate', 'status', 'tier'].sort());
  // the detail view follows the same rule
  const detail = (await memberManagement.getMemberDetail({ owner: base.o, memberId: friend.id })).detail;
  assert.equal(detail.photoUrl, null);
  assert.ok(detail.phone.includes('•'));
  assert.equal((await memberManagement.getMemberDetail({ owner: base.o, memberId: legacy.id })).detail.phone, legacyPhone);

  // after one valid check-in at this gym the owner sees them as for any other member
  const visit = await checkInService.perform({ memberId: friend.id, gymId: base.g });
  assert.equal(visit.ok, true, JSON.stringify(visit));
  rows = await list();
  const after = rows.find(r => r.id === friend.id);
  assert.equal(after.phone, passPhone);
  assert.equal(after.photoUrl, '/storage/x/friend.jpg');
});

// ── finding 2: who suspended; owner-removed contacts ───────────────────────────────────────────────────────

test('F2 a buyer may resume only what the buyer suspended; the owner may resume anything; the buyer is not told the real state', async () => {
  const k = kit();
  const a = await member(); const b = await member();
  const base = await running(k, { extra: [{ phone: a.phone }, { phone: b.phone }] });
  const rowOf = async (m) => (await people(base.purchaseId)).find(r => r.userId === m.id);
  const buyerActor = { userId: base.buyer.id };
  const ownerActor = { owner: base.o };
  const ids = { purchaseId: base.purchaseId };

  // buyer suspends A, buyer resumes A
  assert.equal((await k.svc.suspendBeneficiary({ ...ids, beneficiaryId: (await rowOf(a)).id, actor: buyerActor })).beneficiary.status, 'suspended');
  assert.equal((await rowOf(a)).suspendedByRole, 'buyer');
  assert.equal((await k.svc.resumeBeneficiary({ ...ids, beneficiaryId: (await rowOf(a)).id, actor: buyerActor })).beneficiary.status, 'invited', 'buyer view: resumed, no first visit yet');
  assert.equal((await rowOf(a)).status, 'active');
  assert.equal((await rowOf(a)).suspendedByRole, null);

  // owner suspends B: the buyer cannot undo it
  assert.equal((await k.svc.suspendBeneficiary({ ...ids, beneficiaryId: (await rowOf(b)).id, actor: ownerActor })).beneficiary.status, 'suspended');
  assert.equal((await rowOf(b)).suspendedByRole, 'owner');
  const refused = await k.svc.resumeBeneficiary({ ...ids, beneficiaryId: (await rowOf(b)).id, actor: buyerActor });
  assert.deepEqual([refused.error, refused.status], ['suspended_by_other', 403]);
  assert.equal((await rowOf(b)).status, 'suspended');
  assert.equal((await db('Subscription').where({ id: (await rowOf(b)).subscriptionId }).first()).status, 'suspended');
  // a buyer's suspend over an owner's suspension is just an invalid transition, and carries no state detail
  const again = await k.svc.suspendBeneficiary({ ...ids, beneficiaryId: (await rowOf(b)).id, actor: buyerActor });
  assert.equal(again.error, 'invalid_transition');
  assert.equal(again.from, undefined, 'the buyer is not told the state');
  // the owner can resume
  assert.equal((await k.svc.resumeBeneficiary({ ...ids, beneficiaryId: (await rowOf(b)).id, actor: ownerActor })).beneficiary.status, 'active');
  assert.equal((await rowOf(b)).suspendedByRole, null);
  // and the owner can lift a suspension the buyer made
  await k.svc.suspendBeneficiary({ ...ids, beneficiaryId: (await rowOf(a)).id, actor: buyerActor });
  assert.equal((await k.svc.resumeBeneficiary({ ...ids, beneficiaryId: (await rowOf(a)).id, actor: ownerActor })).beneficiary.status, 'active');
});

test('F2 a contact the OWNER removed cannot be re-added by the buyer (by contact or by account); the owner may re-add', async () => {
  const k = kit();
  const friend = await member({ email: `friend.${tag}@x.test` });
  const base = await running(k, { extra: [{ phone: friend.phone }, { phone: phoneNo() }] });
  const row = (await people(base.purchaseId)).find(r => r.userId === friend.id);
  assert.equal((await k.svc.removeBeneficiary({ purchaseId: base.purchaseId, beneficiaryId: row.id, actor: { owner: base.o } })).beneficiary.status, 'removed');

  const byPhone = await k.svc.addBeneficiary({ purchaseId: base.purchaseId, actor: { userId: base.buyer.id }, body: { phone: friend.phone } });
  assert.deepEqual([byPhone.error, byPhone.status], ['removed_by_owner', 403]);
  const byEmail = await k.svc.addBeneficiary({ purchaseId: base.purchaseId, actor: { userId: base.buyer.id }, body: { email: friend.email } });
  assert.equal(byEmail.error, 'removed_by_owner', 'the same account through another contact is refused too');
  // the owner may bring them back
  const back = await k.svc.addBeneficiary({ purchaseId: base.purchaseId, actor: { owner: base.o }, body: { phone: friend.phone } });
  assert.equal(back.status, 201, JSON.stringify(back));
  // a contact the BUYER removed can be re-added by the buyer
  const other = await member();
  const added = await k.svc.addBeneficiary({ purchaseId: base.purchaseId, actor: { userId: base.buyer.id }, body: { phone: other.phone } });
  assert.equal(added.status, 201);
  await k.svc.removeBeneficiary({ purchaseId: base.purchaseId, beneficiaryId: added.beneficiary.id, actor: { userId: base.buyer.id } });
  assert.equal((await k.svc.addBeneficiary({ purchaseId: base.purchaseId, actor: { userId: base.buyer.id }, body: { phone: other.phone } })).status, 201);
});

// ── finding 3: leave cooldown, caps, send cap, sanitised buyer name ─────────────────────────────────────────

test('F3 a person who LEAVES cannot be re-attached to that purchase, or to any purchase of that buyer, by anyone', async () => {
  const k = kit();
  const leaver = await member({ email: `leaver.${tag}@x.test` });
  const base = await running(k, { extra: [{ phone: leaver.phone }, { phone: phoneNo() }] });
  const left = await k.svc.leave({ userId: leaver.id, purchaseId: base.purchaseId });
  assert.deepEqual(left, { ok: true });
  const row = (await people(base.purchaseId)).find(r => r.userId === leaver.id);
  assert.equal(row.status, 'removed');
  assert.equal(row.removedByRole, 'self');
  assert.equal(row.contactValue, null);
  const blocks = await db('GymPassContactBlock').where({ buyerId: base.buyer.id });
  assert.ok(blocks.length >= 1);
  assert.ok(blocks.some(b => b.contactHash === sha('phone', normalizePhone(leaver.phone))) && blocks.every(b => b.userId === leaver.id));

  for (const actor of [{ userId: base.buyer.id }, { owner: base.o }]) {
    for (const body of [{ phone: leaver.phone }, { email: leaver.email }]) {
      const out = await k.svc.addBeneficiary({ purchaseId: base.purchaseId, actor, body });
      assert.deepEqual([out.error, out.status], ['cannot_add_person', 409], JSON.stringify(body));
    }
  }
  // another purchase of the same buyer (a new checkout): the generic error
  const g2 = await gym(); const o2 = await owner([g2]); const p2 = await plan(k, o2, g2, { beneficiaryLimit: 4 });
  const co = await k.svc.purchase({ memberId: base.buyer.id, planId: p2.id, beneficiaries: [{ phone: leaver.phone }, { phone: phoneNo() }] });
  assert.deepEqual([co.error, co.status], ['invalid_beneficiaries', 400]);
  // a different buyer is not affected
  const other = await member();
  const c3 = await k.svc.purchase({ memberId: other.id, planId: p2.id, beneficiaries: [{ phone: leaver.phone }, { phone: phoneNo() }] });
  assert.equal(c3.status, 202, JSON.stringify(c3));
});

test('F3 caps: attempts per actor, adds per buyer per hour, adds per contact per day, with 429 rate_limited', async () => {
  // adds per buyer per hour
  process.env.GYM_PASS_BUYER_ADDS_PER_HOUR = '2';
  let k = kit();
  let base = await running(k, { extra: [{ phone: phoneNo() }, { phone: phoneNo() }], limit: 10 });
  const add = (kk, b, body) => kk.svc.addBeneficiary({ purchaseId: b.purchaseId, actor: { userId: b.buyer.id }, body });
  assert.equal((await add(k, base, { phone: phoneNo() })).status, 201);
  assert.equal((await add(k, base, { phone: phoneNo() })).status, 201);
  const capped = await add(k, base, { phone: phoneNo() });
  assert.deepEqual([capped.error, capped.status], ['rate_limited', 429]);
  assert.ok(capped.retryAfterSeconds >= 1);
  delete process.env.GYM_PASS_BUYER_ADDS_PER_HOUR;

  // attempts per actor: failures count too (they are the oracle)
  process.env.GYM_PASS_ADD_ATTEMPTS_PER_HOUR = '3';
  k = kit();
  base = await running(k, { extra: [{ phone: phoneNo() }, { phone: phoneNo() }], limit: 10 });
  for (let i = 0; i < 3; i += 1) assert.equal((await add(k, base, { phone: 'abc' })).error, 'invalid_contact');
  const throttled = await add(k, base, { phone: 'abc' });
  assert.deepEqual([throttled.error, throttled.status], ['rate_limited', 429]);
  delete process.env.GYM_PASS_ADD_ATTEMPTS_PER_HOUR;
  assert.equal(gymPassLimits().attemptsPerHour, 40, 'default matches the friend lookup');

  // adds per contact per day: any actor, any purchase
  process.env.GYM_PASS_TARGET_PER_DAY = '2';
  k = kit();
  const target = phoneNo();
  const b1 = await running(k, { extra: [{ phone: phoneNo() }, { phone: phoneNo() }], limit: 10 });
  const b2 = await running(k, { extra: [{ phone: phoneNo() }, { phone: phoneNo() }], limit: 10 });
  const b3 = await running(k, { extra: [{ phone: phoneNo() }, { phone: phoneNo() }], limit: 10 });
  assert.equal((await add(k, b1, { phone: target })).status, 201);
  assert.equal((await add(k, b2, { phone: target })).status, 201);
  const spam = await add(k, b3, { phone: target });
  assert.deepEqual([spam.error, spam.status], ['rate_limited', 429]);
  // the same cap applies at checkout (per contact, not per account)
  const g = await gym(); const o = await owner([g]); const p = await plan(k, o, g, { beneficiaryLimit: 3 });
  const buyer = await member();
  const co = await k.svc.purchase({ memberId: buyer.id, planId: p.id, beneficiaries: [{ phone: target }, { phone: phoneNo() }] });
  assert.deepEqual([co.error, co.status], ['rate_limited', 429]);
});

test('F3 SMS/WhatsApp sends are capped per purchase; the invite link is still returned for the buyer to share', async () => {
  process.env.GYM_PASS_SENDS_PER_PURCHASE = '1';
  const k = kit();
  const base = await running(k, { extra: [{ phone: phoneNo() }, { phone: phoneNo() }] });
  assert.equal(k.sent.sms.length, 1, 'only one of the two invitations went out');
  const pending = (await people(base.purchaseId)).filter(r => r.status === 'pending_registration');
  assert.equal(pending.length, 2);
  assert.equal((await people(base.purchaseId)).reduce((n, r) => n + r.sendCount, 0), 1);
  const unsent = pending.find(r => !r.notifiedVia);
  assert.ok(unsent && unsent.inviteTokenHash, 'the second person still has a link');
  const resend = await k.svc.resendInvite({ purchaseId: base.purchaseId, beneficiaryId: unsent.id, actor: { userId: base.buyer.id } });
  assert.ok(resend.share.link.startsWith('https://app.test/gym-pass/#'));
  assert.deepEqual(resend.delivery, []);
  assert.equal(k.sent.sms.length, 1);
});

test('F3 the buyer\'s name in a text is sanitised: no links, no digit runs, 30 characters at most', async () => {
  assert.equal(safeDisplayName('Pay 0712345678 now'), 'Pay now');
  assert.equal(safeDisplayName('Click https://evil.example/x now'), 'Click now');
  assert.equal(safeDisplayName('visit www.evil.com for prizes'), 'visit for prizes');
  assert.equal(safeDisplayName('A'.repeat(80)).length, 30);
  assert.equal(safeDisplayName('<script>x</script>').includes('<'), false);
  assert.equal(safeDisplayName('0712345678'), null);
  assert.equal(safeDisplayName(null), null);
  assert.equal(safeDisplayName('Neema Abdallah'), 'Neema Abdallah');

  const k = kit();
  const g = await gym(); const o = await owner([g]); const p = await plan(k, o, g, { beneficiaryLimit: 3 });
  const buyer = await member({ name: '0712345678 https://evil.example/p' });
  const friend = await member(); const stranger = phoneNo();
  const out = await buy(k, buyer, p.id, [{ phone: friend.phone }, { phone: stranger }]);
  await approve(k, out.paymentRequest.id);
  const texts = k.sent.sms.map(s => s.text).join('\n');
  assert.equal(/evil|0712345678/.test(texts), false, texts);
  const notice = k.sent.notify.find(n => n.message.type === 'gym_pass_added').message;
  assert.equal(/evil|0712345678/.test(JSON.stringify(notice)), false);
  assert.ok(texts.includes('A member'), 'a name with nothing left falls back to a neutral one');
});

test('F3 a member block (friends feature) keeps the buyer from attaching, notifying or inviting the blocker', async () => {
  const buyer = await member(); const blocker = await member();
  const blocks = { filterByColumnAsync: async (col, id) => (col === 'blockerId' && id === blocker.id ? [{ blockerId: blocker.id, blockedId: buyer.id }] : []) };
  const k = kit({ blocks });
  const g = await gym(); const o = await owner([g]); const p = await plan(k, o, g, { beneficiaryLimit: 3 });
  const out = await buy(k, buyer, p.id, [{ phone: blocker.phone }, { phone: phoneNo() }]);
  await approve(k, out.paymentRequest.id);
  const row = (await people(out.purchase.id)).find(r => !r.isPurchaser && r.contactHash === sha('phone', normalizePhone(blocker.phone)));
  assert.equal(row.status, 'pending_registration', 'never attached');
  assert.equal(k.sent.notify.some(n => n.userId === blocker.id), false);
  assert.equal(k.sent.sms.some(s => s.phone === blocker.phone), false, 'no text and no link to someone who blocked the buyer');
  const claimed = await k.svc.claimForUser(blocker.id);
  assert.deepEqual(claimed.claimed, [], 'a verified contact does not attach them across a block either');
});

// ── finding 4 / 5: generic checkout error, rate limit on the purchase route, no account existence ───────────

test('F4 checkout: every account-dependent refusal is the one generic error, with no index', async () => {
  const k = kit();
  const g = await gym(); const o = await owner([g]); const p = await plan(k, o, g, { beneficiaryLimit: 4 });
  const buyer = await member({ email: `buyer.${tag}@x.test` });
  const dual = await member({ email: `dual.${tag}@x.test` });
  const stranger = phoneNo();
  const err = async (list) => { const r = await k.svc.purchase({ memberId: buyer.id, planId: p.id, beneficiaries: list }); return r; };
  // one account typed by phone and by email  vs  two unrelated strangers typed the same way
  const same = await err([{ phone: dual.phone }, { email: dual.email }, { phone: stranger }]);
  assert.deepEqual([same.error, same.status, same.index], ['invalid_beneficiaries', 400, undefined]);
  // another of the buyer's own accounts' contacts
  const self = await err([{ email: buyer.email }, { phone: stranger }, { phone: phoneNo() }]);
  assert.equal(self.error, 'cannot_add_yourself', 'the buyer\'s own typed contact is independent of account lookup');
  // two different accounts: fine
  const okOut = await err([{ phone: dual.phone }, { phone: stranger }, { phone: phoneNo() }]);
  assert.equal(okOut.status, 202, JSON.stringify(okOut));
  // typed twice, identical: depends only on what was typed
  const g2 = await gym(); const p2 = await plan(k, await owner([g2]), g2, { beneficiaryLimit: 3 });
  const dup = await k.svc.purchase({ memberId: (await member()).id, planId: p2.id, beneficiaries: [{ phone: stranger }, { phone: stranger }] });
  assert.equal(dup.error, 'duplicate_beneficiary');
});

test('F4 POST /me/gym-pass-purchases is rate-limited per member (429 rate_limited, Retry-After)', async () => {
  process.env.GYM_CUSTOM_PASSES = '1';
  const m = await member();
  let last = null;
  for (let i = 0; i < 21; i += 1) {
    last = await call(routes.gymPassPurchase, { sub: m.id, userType: 'member' }, { body: { planId: 'gpp_missing' } });
    if (i < 20) assert.equal(last.status, 404, `attempt ${i + 1}`);
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.error, 'rate_limited');
  assert.ok(last.body.retryAfterSeconds >= 1);
  assert.ok(last.headers['Retry-After']);
  // another member is not limited
  const n = await member();
  assert.equal((await call(routes.gymPassPurchase, { sub: n.id, userType: 'member' }, { body: { planId: 'gpp_missing' } })).status, 404);
});

// ── finding 6 + low items: claim clears contact, activation eligibility, invite expiry, SMS log, audit level ─────

test('claim and activation clear the plain contact: only a mask and a hash remain; the owner still sees a masked contact', async () => {
  const k = kit();
  const signsUp = phoneNo();
  const base = await running(k, { extra: [{ phone: signsUp }, { phone: phoneNo() }] });
  let row = (await people(base.purchaseId)).find(r => r.contactHash === sha('phone', normalizePhone(signsUp)));
  assert.equal(row.status, 'pending_registration');
  assert.equal(row.contactValue, signsUp);
  assert.ok(row.contactMask.includes('•'));
  const person = await member({ phone: signsUp });
  assert.deepEqual((await k.svc.claimForUser(person.id)).claimed, [row.id]);
  row = (await people(base.purchaseId)).find(r => r.id === row.id);
  assert.equal(row.status, 'active');
  assert.equal(row.contactValue, null);
  assert.equal(row.inviteTokenHash, null);
  assert.ok(row.contactHash && row.contactMask);
  const sale = (await k.svc.purchaseDetail({ owner: base.o, gymId: base.g, purchaseId: base.purchaseId })).sale;
  const shown = sale.beneficiaries.find(b => b.id === row.id);
  assert.equal(shown.contact, row.contactMask);
  // an account attached at activation has no plain contact either
  const acct = await member();
  const b2 = await running(k, { extra: [{ phone: acct.phone }, { phone: phoneNo() }] });
  const r2 = (await people(b2.purchaseId)).find(r => r.userId === acct.id);
  assert.equal(r2.contactValue, null);
  assert.ok(r2.contactHash);
});

test('activation attaches only an active member account: a suspended, deleted or non-member account stays pending with no subscription', async () => {
  const k = kit();
  const suspended = await member({ accountStatus: 'suspended' });
  const gone = await member({ accountStatus: 'deleted' });
  const trainer = await member({ userType: 'trainer' });
  const good = await member();
  const g = await gym(); const o = await owner([g]); const p = await plan(k, o, g, { beneficiaryLimit: 6 });
  const buyer = await member();
  const out = await buy(k, buyer, p.id, [{ phone: suspended.phone }, { phone: gone.phone }, { phone: trainer.phone }, { phone: good.phone }]);
  await approve(k, out.paymentRequest.id);
  const rows = await people(out.purchase.id);
  for (const m of [suspended, gone, trainer]) {
    const r = rows.find(x => x.contactHash === sha('phone', normalizePhone(m.phone)));
    assert.equal(r.status, 'pending_registration', m.id);
    assert.equal(r.userId, null);
    assert.equal(r.subscriptionId, null);
    assert.equal((await db('Subscription').where({ memberId: m.id, passPurchaseId: out.purchase.id })).length, 0);
  }
  assert.equal(rows.find(x => x.userId === good.id).status, 'active');
});

test('invite expiry: an expired LINK is refused (410) but a verified contact still attaches until the pass ends; preview says expired', async () => {
  const k = kit();
  const phone = phoneNo();
  const base = await running(k, { extra: [{ phone }, { phone: phoneNo() }] });
  const row = (await people(base.purchaseId)).find(r => r.contactHash === sha('phone', normalizePhone(phone)));
  const link = k.sent.sms.find(s => s.phone === phone).text.match(/#([A-Za-z0-9_-]{20,})/)[1];
  await db('GymPassBeneficiary').where({ id: row.id }).update({ inviteExpiresAt: new Date(Date.now() - 60_000) });
  assert.equal((await k.svc.previewInvite(link)).invitation.status, 'expired');
  const person = await member({ phone });
  const withToken = await k.svc.claimForUser(person.id, { token: link });
  assert.deepEqual([withToken.error, withToken.status], ['invitation_expired', 410]);
  assert.equal((await db('GymPassBeneficiary').where({ id: row.id }).first()).status, 'pending_registration');
  // without the link, the verified contact is enough
  assert.deepEqual((await k.svc.claimForUser(person.id)).claimed, [row.id]);
  // the store-level rule: a claim WITH a token excludes that token's row when its link has expired, others are not touched
  const other = phoneNo();
  const b2 = await running(k, { extra: [{ phone: other }, { phone: phoneNo() }] });
  const r2 = (await people(b2.purchaseId)).find(r => r.contactHash === sha('phone', normalizePhone(other)));
  await db('GymPassBeneficiary').where({ id: r2.id }).update({ inviteExpiresAt: new Date(Date.now() - 60_000) });
  const contactsOf = [{ type: 'phone', value: normalizePhone(other) }];
  const hash = r2.inviteTokenHash;
  assert.equal((await gymPassStore.pendingForContacts(contactsOf, new Date())).length, 1);
  assert.equal((await gymPassStore.pendingForContacts(contactsOf, new Date(), { tokenHash: hash })).length, 0);
});

test('the invite link is never written to the SMS log text (logText has it removed); the person still gets the link', async () => {
  const k = kit();
  const stranger = phoneNo();
  const base = await running(k, { extra: [{ phone: stranger }, { phone: phoneNo() }] });
  const sms = k.sent.sms.find(s => s.phone === stranger);
  assert.ok(/https:\/\/app\.test\/gym-pass\/#/.test(sms.text), 'the message itself carries the link');
  assert.equal(/gym-pass\/#|app\.test/.test(sms.logText), false, sms.logText);
  assert.ok(sms.logText.includes('Pass') && sms.logText.includes('[invite link removed]'));
  assert.ok(base.purchaseId);
});

test('a failing audit write is logged at ERROR level and never fails the action', async (t) => {
  const failing = { insertAsync: async () => { throw new Error('audit db down'); } };
  const errors = [];
  t.mock.method(console, 'error', (...args) => { errors.push(args.join(' ')); });
  const k = kit({ auditLogImpl: failing });
  const g = await gym(); const o = await owner([g]);
  const made1 = await k.svc.createPlan({ owner: o, gymId: g, actorId: o.id, body: { name: 'Audit', category: 'individual', durationValue: 1, durationUnit: 'days', priceTzs: 1000 } });
  assert.equal(made1.status, 201);
  assert.ok(errors.some(e => e.includes('AUDIT WRITE FAILED') && e.includes('gym_pass_plan_created')), errors.join('|'));
});

// ── finding 6: account erasure ───────────────────────────────────────────────────────────────────────────

test('erasure of a covered person: contact, hash, mask and token are cleared, the slot is freed, the pass runs on for the rest', async () => {
  const k = kit();
  const friend = await member();
  const stranger = phoneNo();
  const base = await running(k, { extra: [{ phone: friend.phone }, { phone: stranger }] });
  const rows = await people(base.purchaseId);
  const friendRow = rows.find(r => r.userId === friend.id);
  assert.ok(friendRow.contactHash);
  const out = await createAccountErasure({ db }).erase(friend.id);
  assert.equal(out.ok, true);
  const after = (await people(base.purchaseId));
  const gone = after.find(r => r.id === friendRow.id);
  assert.deepEqual([gone.status, gone.slot, gone.contactValue, gone.contactHash, gone.contactMask, gone.inviteTokenHash, gone.removedByRole], ['removed', null, null, null, null, null, 'erasure']);
  assert.equal((await db('Subscription').where({ id: friendRow.subscriptionId }).first())?.status ?? 'cancelled', 'cancelled');
  // everyone else untouched, and the slot can be used again
  const pend = after.find(r => r.contactValue === stranger);
  assert.equal(pend.status, 'pending_registration');
  assert.ok(pend.inviteTokenHash);
  assert.equal((await db('GymPassPurchase').where({ id: base.purchaseId }).first()).status, 'active');
  const re = await k.svc.addBeneficiary({ purchaseId: base.purchaseId, actor: { owner: base.o }, body: { phone: phoneNo() } });
  assert.equal(re.status, 201, JSON.stringify(re));
  made.users = made.users.filter(id => id !== friend.id);
});

test('erasure of a BUYER: contacts and tokens of the people on their purchases are cleared, pending people leave, blocks go, the sale and payment stay', async () => {
  const k = kit();
  const leaver = await member();
  const friend = await member();
  const stranger = phoneNo();
  const base = await running(k, { extra: [{ phone: leaver.phone }, { phone: friend.phone }, { phone: stranger }], limit: 6 });
  assert.deepEqual(await k.svc.leave({ userId: leaver.id, purchaseId: base.purchaseId }), { ok: true });
  assert.ok((await db('GymPassContactBlock').where({ buyerId: base.buyer.id })).length >= 1);
  const payment = await db('PaymentRequest').where({ id: (await db('GymPassPurchase').where({ id: base.purchaseId }).first()).paymentRequestId }).first();

  const out = await createAccountErasure({ db }).erase(base.buyer.id);
  assert.equal(out.ok, true);
  const after = await people(base.purchaseId);
  for (const r of after) {
    assert.equal(r.contactValue, null, r.id);
    assert.equal(r.contactHash, null, r.id);
    assert.equal(r.contactMask, null, r.id);
    assert.equal(r.inviteTokenHash, null, r.id);
  }
  const pend = after.find(r => r.removedByRole === 'erasure' && !r.userId);
  assert.ok(pend, 'the pending person was removed with the buyer');
  assert.equal(pend.status, 'removed');
  assert.equal(pend.slot, null);
  assert.equal(after.find(r => r.userId === friend.id).status, 'active', 'an attached person keeps their pass');
  assert.equal((await db('GymPassContactBlock').where({ buyerId: base.buyer.id })).length, 0);
  const purchase = await db('GymPassPurchase').where({ id: base.purchaseId }).first();
  assert.equal(purchase.status, 'active');
  const pay2 = await db('PaymentRequest').where({ id: payment.id }).first();
  assert.equal(pay2.amountTzs, payment.amountTzs);
  assert.equal(pay2.status, 'approved');
  made.users = made.users.filter(id => id !== base.buyer.id);
});

test('erasure of a person also drops other buyers\' pending invitations to that person\'s own number', async () => {
  const k = kit();
  const base = await running(k, { extra: [{ phone: phoneNo() }, { phone: phoneNo() }], limit: 6 });
  const person = await member();
  const phone = normalizePhone(person.phone);
  const added = await gymPassStore.addBeneficiary({
    purchaseId: base.purchaseId, userId: null, contact: { type: 'phone', value: phone }, contactHash: sha('phone', phone), contactMask: '+255•••', addedBy: base.buyer.id, addedByRole: 'buyer',
  });
  assert.equal(added.beneficiary.status, 'pending_registration');
  await gymPassStore.setInvite(added.beneficiary.id, { tokenHash: sha('tok', randomUUID()), expiresAt: new Date(Date.now() + 1e7) });
  await createAccountErasure({ db }).erase(person.id);
  const row = await db('GymPassBeneficiary').where({ id: added.beneficiary.id }).first();
  assert.deepEqual([row.status, row.slot, row.contactValue, row.contactHash, row.inviteTokenHash], ['removed', null, null, null, null]);
  made.users = made.users.filter(id => id !== person.id);
});

test('migration: the abuse-limit columns and the block table exist; existing rows are unaffected (nullable / defaults)', async () => {
  const cols = await db('information_schema.columns').where({ table_name: 'GymPassBeneficiary' }).pluck('column_name');
  for (const c of ['suspendedByRole', 'contactHash', 'contactMask', 'addedBy', 'addedByRole', 'sendCount']) assert.ok(cols.includes(c), c);
  assert.equal((await db.raw(`select to_regclass('"GymPassContactBlock"') as t`)).rows[0].t, '"GymPassContactBlock"');
  const col = await db('information_schema.columns').where({ table_name: 'GymPassBeneficiary', column_name: 'sendCount' }).first('column_default', 'is_nullable');
  assert.equal(col.is_nullable, 'NO');
  assert.equal(String(col.column_default), '0');
});
