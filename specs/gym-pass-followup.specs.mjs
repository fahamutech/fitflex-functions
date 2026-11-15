// Custom gym passes — follow-up to PR #355 (CI database only: everything here writes).
// Invite link host (portal, never the Flutter web host; no dead link when unset), per-locale name fallback,
// "send again" that does not reveal whether a person has an account, optional expectedPriceTzs at checkout.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import * as routes from '../functions/gym-passes.mjs';
import { gyms, users, subscriptions, paymentRequests, auditLog } from '../src/bootstrap/collections.mjs';
import { verifiedContacts, gymPassStore, checkInService, memberManagement } from '../src/bootstrap/services.mjs';
import { createGymPassService } from '../src/services/gym-pass-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { createAccountErasure } from '../src/infra/account-erasure-store-pg.mjs';
import { normalizePhone } from '../src/shared/identifiers.mjs';
import { verifyContacts, purgeIdentity } from './fixtures/verified-contacts.mjs';

await ensureInit();

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const tag = randomUUID().slice(0, 6);
const made = { users: [], gyms: [] };
let seq = 0;
const localeById = new Map();
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

function kit({ blocks = null, auditLogImpl = auditLog, baseLink = () => 'https://portal.test', envLink = false, whatsapp = async () => ({ status: 'skipped:whatsapp_not_available' }) } = {}) {
  const sent = { notify: [], sms: [], whatsapp: [] };
  const svc = createGymPassService({
    store: gymPassStore, gyms, users, auditLog: auditLogImpl, blocks,
    contacts: { findMember: verifiedContacts.findMember, contactsFor: verifiedContacts.contactsFor },
    notify: async (userId, message) => { sent.notify.push({ userId, message }); return {}; },
    channels: {
      whatsapp: async (p) => { sent.whatsapp.push(p); return whatsapp(p); },
      sms: async (p) => { sent.sms.push(p); return { status: 'sent' }; },
    },
    ...(envLink ? {} : { baseLink }),
    localeOf: async (id) => localeById.get(id) ?? null,
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


const smsTo = (k, phone) => k.sent.sms.filter(s => s.phone === phone);
const ENV = ['GYM_PASS_INVITE_BASE_URL', 'PORTAL_PUBLIC_URL'];
const savedEnv = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } });

// ── 1. invite link host ──────────────────────────────────────────────────────────────────────────────────────

test('default link base: GYM_PASS_INVITE_BASE_URL, else PORTAL_PUBLIC_URL (trailing slashes stripped); never the Flutter web host', async () => {
  const stranger = phoneNo();
  const run = async (env) => {
    for (const k of ENV) delete process.env[k];
    Object.assign(process.env, env);
    process.env.FRIEND_INVITE_BASE_URL = 'https://friend.test'; process.env.APP_DOWNLOAD_LINK = 'https://download.test';
    try {
      const k = kit({ envLink: true });
      const g = await gym(); const o = await owner([g]); const p = await plan(k, o, g, { beneficiaryLimit: 3 });
      const buyer = await member();
      const to = phoneNo();
      const out = await buy(k, buyer, p.id, [{ phone: to }, { phone: phoneNo() }]);
      await approve(k, out.paymentRequest.id);
      return smsTo(k, to)[0]?.text ?? '';
    } finally { delete process.env.FRIEND_INVITE_BASE_URL; delete process.env.APP_DOWNLOAD_LINK; }
  };
  void stranger;
  assert.match(await run({ PORTAL_PUBLIC_URL: ' https://portal.example/// ' }), /https:\/\/portal\.example\/gym-pass\/#[A-Za-z0-9_-]{20,}/);
  assert.match(await run({ PORTAL_PUBLIC_URL: 'https://portal.example', GYM_PASS_INVITE_BASE_URL: 'https://pass.example/' }), /https:\/\/pass\.example\/gym-pass\/#/);
  const none = await run({});
  assert.ok(none.includes('Sign up on FitFlex'), none);
  assert.equal(/https?:|friend\.test|download\.test|fitflex-af-app/.test(none), false, `no dead link: ${none}`);
});

test('no host configured: invitation still created, person still attached by verified contact, text has no link, WhatsApp invite template is not used', async () => {
  const k = kit({ baseLink: () => '', whatsapp: async () => ({ status: 'sent' }) });
  const g = await gym(); const o = await owner([g]); const p = await plan(k, o, g, { beneficiaryLimit: 3 });
  const buyer = await member({ name: 'Buyer Bee' });
  const to = phoneNo();
  const out = await buy(k, buyer, p.id, [{ phone: to }, { phone: phoneNo() }]);
  await approve(k, out.paymentRequest.id);
  assert.equal(k.sent.whatsapp.some(w => w.kind === 'invite'), false, 'the invite template needs a link: not attempted');
  const sms = smsTo(k, to)[0];
  assert.ok(sms, 'SMS carries it instead');
  assert.equal(/https?:|#/.test(sms.text), false, sms.text);
  assert.ok(sms.text.endsWith('start using it.'), sms.text);
  assert.equal(/\[invite link removed\]/.test(sms.logText), false);
  const row = (await people(out.purchase.id)).find(r => r.contactHash === sha('phone', normalizePhone(to)));
  assert.equal(row.status, 'pending_registration');
  // the person signs up, verifies the number, and is attached without any link
  const joined = await member({ phone: to });
  const mine = await k.svc.myPasses(joined.id);
  assert.ok(JSON.stringify(mine).includes(out.purchase.id));
  // "send again" returns no link and a link-free text
  const third = (await people(out.purchase.id)).find(r => r.slot === 3);
  await db('GymPassBeneficiary').where({ id: third.id }).update({ inviteSentAt: new Date(Date.now() - 3 * 3600_000) });
  const again = await k.svc.resendInvite({ purchaseId: out.purchase.id, beneficiaryId: third.id, actor: { userId: buyer.id } });
  assert.ok(!again.error, JSON.stringify(again));
  assert.equal(again.share.link, null);
  assert.equal(/https?:/.test(again.share.text), false);
});

test('the Swahili invite text without a link is still the pending-review placeholder', async () => {
  const { gymPassMessage } = await import('../src/shared/gym-pass-texts.mjs');
  const sw = gymPassMessage('invite', { buyerName: 'Asha', planName: 'P', gymName: 'G', link: null }, 'sw');
  assert.ok(sw.startsWith('[SW pending review]') && !/https?:|null|undefined/.test(sw), sw);
});

// ── 2. buyer-name fallback per locale ─────────────────────────────────────────────────────────────────────────

test('a buyer with no usable name reads "A member" in English and the existing Swahili word in Swahili, in texts and notices', async () => {
  const { gymPassMessage, gymPassNotice } = await import('../src/shared/gym-pass-texts.mjs');
  const { aMemberWord } = await import('../src/shared/notification-texts.mjs');
  assert.equal(aMemberWord('sw'), 'Mwanachama');
  const params = { buyerName: null, planName: 'P', gymName: 'G', until: '2026-12-01', link: 'https://x/#t' };
  assert.ok(gymPassMessage('added', params, 'en').includes('A member added you'));
  assert.ok(gymPassMessage('added', params, 'sw').includes('Mwanachama'));
  assert.equal(/A member|A FitFlex member/.test(gymPassMessage('added', params, 'sw').replace('[SW pending review]', '')) , false, 'no English fallback name in Swahili');
  assert.ok(gymPassMessage('invite', params, 'sw').includes('Mwanachama'));
  assert.ok(gymPassNotice('added', params, 'sw').body.includes('Mwanachama'));
  assert.ok(gymPassNotice('added', params, 'en').body.startsWith('A member added you'));
});

test('end to end: a Swahili-speaking friend of a nameless buyer gets Mwanachama in the SMS and in-app notice', async () => {
  const k = kit();
  const g = await gym(); const o = await owner([g]); const p = await plan(k, o, g, { beneficiaryLimit: 3 });
  const buyer = await member({ name: '0712345678' });
  const friend = await member();
  localeById.set(friend.id, 'sw');
  const out = await buy(k, buyer, p.id, [{ phone: friend.phone }, { phone: phoneNo() }]);
  await approve(k, out.paymentRequest.id);
  const sms = smsTo(k, friend.phone)[0];
  assert.ok(sms.text.includes('Mwanachama') && !sms.text.includes('A FitFlex member'), sms.text);
  const note = k.sent.notify.find(n => n.userId === friend.id).message;
  assert.ok(note.body.includes('Mwanachama') && note.data.bodyEn.startsWith('A member added you'));
});

// ── 3. "send again" does not reveal an account ────────────────────────────────────────────────────────────────

test('POST …/invite answers the same shape for a person with an account and one without (and the same pacing)', async () => {
  const k = kit();
  const g = await gym(); const o = await owner([g]); const p = await plan(k, o, g, { beneficiaryLimit: 4 });
  const buyer = await member({ name: 'Buyer Bee' });
  const acct = await member(); const nobody = phoneNo();
  const out = await buy(k, buyer, p.id, [{ phone: acct.phone }, { phone: nobody }]);
  await approve(k, out.paymentRequest.id);
  const rows = await people(out.purchase.id);
  const acctRow = rows.find(r => r.userId === acct.id); const nobodyRow = rows.find(r => r.status === 'pending_registration');
  assert.ok(acctRow && nobodyRow);
  const smsBefore = k.sent.sms.length;

  const shape = (r) => ({ keys: Object.keys(r).sort(), shareKeys: Object.keys(r.share ?? {}).sort(), linkShape: String(r.share?.link).replace(/#.*/, '#T'), delivery: r.delivery, error: r.error, status: r.status });
  // Through the test kit's service (its channels are fakes), not the route's real-channel singleton.
  const asRoute = async (row) => {
    const r = await k.svc.resendInvite({ purchaseId: out.purchase.id, beneficiaryId: row.id, actor: { userId: buyer.id } });
    return r.error ? { status: r.status, body: r } : { status: 200, body: r };
  };

  // announce stamped both (SMS went to both) → both are paced identically
  const a1 = await asRoute(acctRow); const n1 = await asRoute(nobodyRow);
  assert.equal(a1.status, n1.status); assert.equal(a1.status, 429);
  assert.deepEqual(a1.body, n1.body);

  // after the wait both succeed with the same shape
  const past = new Date(Date.now() - 3 * 3600_000);
  await db('GymPassBeneficiary').whereIn('id', [acctRow.id, nobodyRow.id]).update({ inviteSentAt: past });
  const a2 = await asRoute(acctRow); const n2 = await asRoute(nobodyRow);
  assert.equal(a2.status, 200, JSON.stringify(a2.body)); assert.equal(n2.status, 200, JSON.stringify(n2.body));
  assert.deepEqual(shape(a2.body), shape(n2.body));
  assert.deepEqual(a2.body.delivery, ['sms']);
  assert.equal(a2.body.share.text.replace(/#\S+/, '#T'), n2.body.share.text.replace(/#\S+/, '#T'));
  assert.equal(k.sent.sms.length, smsBefore + 2, 'each got exactly one text');
  // only the waiting person has a working token; the decoy for the account matches nothing
  const tokenOf = (r) => r.body.share.link.split('#')[1];
  assert.equal((await k.svc.previewInvite(tokenOf(n2))).invitation.status, 'pending');
  assert.equal((await k.svc.previewInvite(tokenOf(a2))).error, 'invalid_invitation');
  // the account holder was sent the normal "added" text, not an invite
  const lastToAcct = smsTo(k, acct.phone).at(-1);
  assert.ok(lastToAcct.text.includes('Show your FitFlex QR') && !/gym-pass\/#/.test(lastToAcct.text), lastToAcct.text);
  // the account row was not altered into a pending one and holds no token
  const after = await db('GymPassBeneficiary').where({ id: acctRow.id }).first();
  assert.equal(after.status, 'active'); assert.equal(after.inviteTokenHash, null);
  // paced again, identically
  assert.equal((await asRoute(acctRow)).status, (await asRoute(nobodyRow)).status);
});

test('POST …/invite: the same 404 for a removed person, another purchase\'s person, and the buyer themself', async () => {
  const k = kit();
  const g = await gym(); const o = await owner([g]); const p = await plan(k, o, g, { beneficiaryLimit: 4 });
  const buyer = await member(); const friend = await member();
  const out = await buy(k, buyer, p.id, [{ phone: friend.phone }, { phone: phoneNo() }]);
  await approve(k, out.paymentRequest.id);
  const rows = await people(out.purchase.id);
  const self = rows.find(r => r.isPurchaser);
  const fr = rows.find(r => r.userId === friend.id);
  await k.svc.removeBeneficiary({ purchaseId: out.purchase.id, beneficiaryId: fr.id, actor: { userId: buyer.id } });
  const a = await k.svc.resendInvite({ purchaseId: out.purchase.id, beneficiaryId: fr.id, actor: { userId: buyer.id } });
  const b = await k.svc.resendInvite({ purchaseId: out.purchase.id, beneficiaryId: self.id, actor: { userId: buyer.id } });
  const c = await k.svc.resendInvite({ purchaseId: out.purchase.id, beneficiaryId: 'gpb_nope', actor: { userId: buyer.id } });
  assert.deepEqual([a, b, c], [{ error: 'not_found', status: 404 }, { error: 'not_found', status: 404 }, { error: 'not_found', status: 404 }]);
});

// ── 4. optional expectedPriceTzs ──────────────────────────────────────────────────────────────────────────────

test('expectedPriceTzs: matching or absent buys as before; a different price is 409 price_changed with the current price and creates nothing', async () => {
  const k = kit();
  const g = await gym(); const o = await owner([g]);
  const p = await plan(k, o, g, { category: 'individual', beneficiaryLimit: 1, priceTzs: 40_000 });
  const buyer = await member();
  const stale = await k.svc.purchase({ memberId: buyer.id, planId: p.id, expectedPriceTzs: 35_000 });
  assert.deepEqual([stale.status, stale.error, stale.priceTzs, stale.currency], [409, 'price_changed', 40_000, 'TZS']);
  assert.equal(await db('GymPassPurchase').where({ planId: p.id }).count().first().then(r => +r.count), 0, 'nothing created');
  assert.equal((await k.svc.purchase({ memberId: buyer.id, planId: p.id, expectedPriceTzs: 'abc' })).error, 'price_changed');
  const ok = await k.svc.purchase({ memberId: buyer.id, planId: p.id, expectedPriceTzs: 40_000 });
  assert.equal(ok.status, 202, JSON.stringify(ok));
  const buyer2 = await member();
  assert.equal((await k.svc.purchase({ memberId: buyer2.id, planId: p.id })).status, 202, 'absent: no check');
  const buyer3 = await member();
  assert.equal((await k.svc.purchase({ memberId: buyer3.id, planId: p.id, expectedPriceTzs: null })).status, 202, 'null: no check');
});

test('expectedPriceTzs through the route: 409 body carries priceTzs', async () => {
  const k = kit();
  const g = await gym(); const o = await owner([g]);
  const p = await plan(k, o, g, { category: 'individual', beneficiaryLimit: 1, priceTzs: 40_000 });
  const buyer = await member();
  process.env.GYM_CUSTOM_PASSES = '1';
  const r = await call(routes.gymPassPurchase, { sub: buyer.id, role: 'member', userType: 'member' }, { body: { planId: p.id, expectedPriceTzs: 1 } });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, 'price_changed'); assert.equal(r.body.priceTzs, 40_000);
});
