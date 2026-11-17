// Transaction IDs typed by a person, after AzamPay became the only payment method (owner decision 2026-11-17).
//
// Members no longer pay by hand and type a transaction ID: subscribe / upgrade ignore `reference` and `payerPhone`,
// and GET /payments/options has no `manual` block. What stays: the reference rules themselves (an organisation's
// payment notice for an event order uses them), the admin approval that records and checks a reference, the
// database's one-ID-per-request index, and requests made by hand before the change (they keep `memberReference`
// and are never sent to a phone as a prompt).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  normalizePaymentReference, referenceKey, normalizePayerPhone, DUPLICATE_ATTEMPT_ACTION,
} from '../src/shared/manual-payment.mjs';
import { createPaymentReferenceStore } from '../src/infra/payment-reference-store.mjs';
import { createSubscriptionService } from '../src/services/subscription-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { createMobileMoneyService } from '../src/services/mobile-money-service.mjs';
import { db } from '../src/infra/knex-store.mjs';
import * as collections from '../src/bootstrap/collections.mjs';
import { ensureInit } from '../functions/index.mjs';

await ensureInit();

// ── in-memory stores ───────────────────────────────────────────────────────

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find((r) => r.id === id) || null; },
    async allAsync() { return [...rows]; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
  };
}

const PRICES = { online_free: 0, basic: 60_000, pro: 120_000 };
const tiers = Object.keys(PRICES).map((key) => ({ key, label: key, monthlyPrice: PRICES[key], visits: 8, gymAccess: 'standard' }));
// Like settingsService after functions#189: only a tier with a positive price is sold (the free online tier is not).
const sellableTier = (t) => (PRICES[t] > 0 ? { key: t, label: t, price: PRICES[t], visitCap: null, gymAccess: 'standard' } : null);
const fakeSettings = {
  priceForTier: (t) => PRICES[t] ?? 0, visitCapForTier: () => null, publicTiers: () => tiers,
  sellableTier, isTierSellable: (t) => sellableTier(t) !== null, sellableTierKeys: () => Object.keys(PRICES).filter((t) => sellableTier(t)),
};
const gym = { id: 'gym_m1', name: 'Gym', status: 'active', ratePerDay: 5_000, ratePerWeek: 25_000, ratePerMonth: 80_000 };
const DAY = 86_400_000;
const PHONE = '0712 345 678';

function setup({ subs = [], requests = [] } = {}) {
  const subscriptions = memStore(subs);
  const paymentRequests = memStore(requests);
  const service = createSubscriptionService({
    subscriptions, paymentRequests, checkins: memStore(), gyms: [gym], settingsService: fakeSettings,
    publicUserId: async () => 'FF-1',
  });
  return { service, subscriptions, paymentRequests };
}

const activePass = (memberId = 'm1') => ({
  id: `sub_${memberId}`, memberId, type: 'platform_pass', tier: 'basic', status: 'active',
  startedAt: new Date(Date.now() - 5 * DAY).toISOString(), cycleStartedAt: new Date(Date.now() - 5 * DAY).toISOString(),
  expiresAt: new Date(Date.now() + 25 * DAY).toISOString(), renewsAt: new Date(Date.now() + 25 * DAY).toISOString(),
});

// ── members no longer type a transaction ID ────────────────────────────────

test('subscribe, a gym plan and an upgrade take no transaction ID: `reference` / `payerPhone` are ignored and nothing is stored', async () => {
  const w = setup({ subs: [] });
  const pass = await w.service.subscribe({ memberId: 'm1', tier: 'basic', reference: 'QGH7XK2L9P', payerPhone: PHONE });
  assert.equal(pass.status, 202);
  const plan = await w.service.subscribe({ memberId: 'm2', type: 'direct_sub', homeGymId: gym.id, plan: 'monthly', reference: 'QGH7XK2L9P', payerPhone: PHONE });
  assert.equal(plan.status, 202, 'the same ID is not a duplicate: it is not read at all');
  const up = setup({ subs: [activePass('m3')] });
  const upgrade = await up.service.upgradePass({ memberId: 'm3', tier: 'pro', reference: 'QGH7XK2L9P', payerPhone: PHONE });
  assert.equal(upgrade.status, 202);
  for (const r of [pass.paymentRequest, plan.paymentRequest, upgrade.paymentRequest]) {
    assert.deepEqual([r.memberReference, r.memberReferenceKey, r.payerPhone, r.reference, r.provider], [undefined, undefined, undefined, null, 'admin_approved']);
  }
});

// ── pure rules ─────────────────────────────────────────────────────────────

test('reference: trimmed and upper-cased; 6–40 of letters, digits and . _ -, with a digit', () => {
  assert.deepEqual(normalizePaymentReference('  qgh7xk2l9p '), { reference: 'QGH7XK2L9P', key: 'QGH7XK2L9P' });
  assert.deepEqual(normalizePaymentReference(1234567890), { reference: '1234567890', key: '1234567890' });
  assert.deepEqual(normalizePaymentReference('MP241019.1234-AB_c'), { reference: 'MP241019.1234-AB_C', key: 'MP2410191234ABC' });
  // Fewer than 6 letters/digits once punctuation is dropped.
  for (const short of ['A-B-C-1-2', '1.2.3.4.5', 'AB_1-2.3']) assert.equal(normalizePaymentReference(short).error, 'payment_reference_invalid', short);
  for (const missing of [undefined, null, '', '   ']) assert.equal(normalizePaymentReference(missing).error, 'payment_reference_required', String(missing));
  for (const bad of ['AB12', 'ABCDEFGH', 'QGH7 XK2L9P', '-QGH7XK2L9P', 'QGH7XK2L9P;--', 'pending:123456', 'A1'.repeat(21), { id: 1 }, ['QGH7XK2L9P'], true]) {
    assert.equal(normalizePaymentReference(bad).error, 'payment_reference_invalid', JSON.stringify(bad));
  }
});

test('payer phone: +255 E.164 from 0…, 255… or +255… (spaces, dashes allowed); others invalid; missing required', () => {
  for (const ok of ['0712345678', '0712 345 678', '255712345678', '+255712345678', '+255 (712) 345-678', '0654.321.098', 255712345678]) {
    assert.match(normalizePayerPhone(ok).phone ?? '', /^\+255[67]\d{8}$/, String(ok));
  }
  assert.equal(normalizePayerPhone('0712345678').phone, '+255712345678');
  assert.equal(normalizePayerPhone('0654321098').phone, '+255654321098');
  for (const missing of [undefined, null, '', '  ']) assert.equal(normalizePayerPhone(missing).error, 'payer_phone_required', String(missing));
  for (const bad of ['712345678', '0812345678', '+254712345678', '07123456789', '071234567', '+2550712345678', 'abc', { n: 1 }, true]) {
    assert.equal(normalizePayerPhone(bad).error, 'payer_phone_invalid', JSON.stringify(bad));
  }
});

test('M2 key: case and punctuation do not make a new ID; an extra digit does', () => {
  for (const same of ['QGH7XK2L9P', 'qgh7xk2l9p', 'QGH7XK2L9P.', 'QGH7-XK2L9P', 'Q.G.H.7_X-K2L9P', ' qgh7 xk2l9p ']) {
    assert.equal(referenceKey(same), 'QGH7XK2L9P', same);
  }
  assert.equal(referenceKey('QGH7XK2L9P_1'), 'QGH7XK2L9P1');
  assert.equal(referenceKey(null), '');
});

// ── subscription service ───────────────────────────────────────────────────

test('admin: approving with no reference typed confirms the member\'s transaction ID; a typed one still wins', async () => {
  const subscriptions = memStore([{ id: 'sub_1', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'payment_pending' }, { id: 'sub_2', memberId: 'm2', type: 'platform_pass', tier: 'basic', status: 'payment_pending' }]);
  const paymentRequests = memStore([
    { id: 'pay_1', memberId: 'm1', subscriptionId: 'sub_1', tier: 'basic', status: 'pending', provider: 'admin_approved', reference: null, memberReference: 'QGH7XK2L9P' },
    { id: 'pay_2', memberId: 'm2', subscriptionId: 'sub_2', tier: 'basic', status: 'pending', provider: 'admin_approved', reference: null, memberReference: 'ABC123456' },
  ]);
  paymentRequests.updateByIdWhereAsync = async (id, where, patch) => {
    const row = paymentRequests.rows.find(r => r.id === id);
    if (!row || Object.entries(where).some(([k, v]) => row[k] !== v)) return null;
    return paymentRequests.updateByIdAsync(id, patch);
  };
  const admin = createAdminPaymentService({ paymentRequests, subscriptions, users: { async filterByColumnInAsync() { return []; } }, auditLog: { async insertAsync() {} } });
  const one = await admin.decide({ id: 'pay_1', decision: 'approve', actorId: 'adm' });
  assert.equal(one.paymentRequest.reference, 'QGH7XK2L9P');
  assert.equal(one.paymentRequest.memberReference, 'QGH7XK2L9P');
  assert.equal(subscriptions.rows[0].paymentRef, 'QGH7XK2L9P');
  const two = await admin.decide({ id: 'pay_2', decision: 'approve', reference: 'STATEMENT-99', actorId: 'adm' });
  assert.equal(two.paymentRequest.reference, 'STATEMENT-99');
  assert.equal(two.paymentRequest.memberReference, 'ABC123456', 'what the member typed is kept');
  // A reference already recorded on the request (e.g. by a verifying admin) is not replaced by the member's.
  paymentRequests.rows.push({ id: 'pay_3', memberId: 'm3', subscriptionId: null, tier: 'basic', status: 'pending', provider: 'admin_approved', reference: 'VERIFIED-1', memberReference: 'MEM123456' });
  const three = await admin.decide({ id: 'pay_3', decision: 'approve', actorId: 'adm' });
  assert.equal(three.error, undefined, JSON.stringify(three));
  assert.equal(three.paymentRequest.reference, 'VERIFIED-1');
  // Rejecting never copies the member's ID into reference.
  paymentRequests.rows.push({ id: 'pay_4', memberId: 'm4', subscriptionId: null, tier: 'basic', status: 'pending', provider: 'admin_approved', reference: null, memberReference: 'REJ123456' });
  assert.equal((await admin.decide({ id: 'pay_4', decision: 'reject', actorId: 'adm' })).paymentRequest.reference, null);
});

test('L1: approval checks the FINAL reference (after the member ID is copied in) against other requests, on the key', async () => {
  const subscriptions = memStore([{ id: 'sub_a', memberId: 'ma', type: 'platform_pass', tier: 'basic', status: 'payment_pending' }]);
  const paymentRequests = memStore([
    { id: 'pay_a', memberId: 'ma', subscriptionId: 'sub_a', tier: 'basic', status: 'pending', provider: 'admin_approved', reference: null, memberReference: 'QGH7XK2L9P', memberReferenceKey: 'QGH7XK2L9P' },
    // An older request an admin approved by hand with the same transaction, typed differently.
    { id: 'pay_old', memberId: 'mz', subscriptionId: null, tier: 'basic', status: 'approved', provider: 'admin_approved', reference: 'qgh7-xk2l9p' },
    { id: 'pay_plain', memberId: 'mp', subscriptionId: null, tier: 'basic', status: 'pending', provider: 'admin_approved', reference: null },
  ]);
  const make = (manualReferenceChecks) => createAdminPaymentService({
    paymentRequests, subscriptions, users: { async filterByColumnInAsync() { return []; } }, auditLog: { async insertAsync() {} }, manualReferenceChecks,
  });
  const admin = make(() => false);
  assert.deepEqual(await admin.decide({ id: 'pay_a', decision: 'approve', actorId: 'adm' }), { error: 'reference_already_used', status: 409 });
  assert.deepEqual(await admin.update({ id: 'pay_a', status: 'approved', actorId: 'adm' }), { error: 'reference_already_used', status: 409 });
  assert.equal(paymentRequests.rows[0].status, 'pending', 'nothing written');
  // Rejecting is never blocked.
  assert.equal((await admin.decide({ id: 'pay_a', decision: 'reject', actorId: 'adm' })).paymentRequest.status, 'rejected');
  // A request with no member ID: flag off → unchanged behaviour; flag on → the typed reference is checked too.
  assert.deepEqual(await make(() => true).decide({ id: 'pay_plain', decision: 'approve', reference: 'QGH7XK2L9P.', actorId: 'adm' }), { error: 'reference_already_used', status: 409 });
  assert.equal((await make(() => false).decide({ id: 'pay_plain', decision: 'approve', reference: 'QGH7XK2L9P.', actorId: 'adm' })).paymentRequest.status, 'approved');
});

test('mobile money: a request the member already paid manually cannot be sent as a phone prompt (no double charge)', async () => {
  const paymentRequests = memStore([{ id: 'pay_1', memberId: 'm1', subscriptionId: 'sub_1', tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', reference: null, memberReference: 'QGH7XK2L9P' }]);
  const svc = createMobileMoneyService({
    paymentRequests, subscriptions: memStore([{ id: 'sub_1', type: 'platform_pass' }]), adminPaymentService: {}, auditLog: null,
    client: { environment: 'live', initiatePayment: async () => { throw new Error('must not be called'); } },
    enabled: () => true,
  });
  assert.deepEqual(await svc.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' }), { error: 'manual_payment_submitted', status: 409 });
});

// ── against the isolated CI database ───────────────────────────────────────

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], audits: [] };
async function member(phone = null) {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'member', displayName: 'Manual Pay', phone, updatedAt: new Date() });
  made.users.push(id);
  return id;
}

after(async () => {
  if (made.users.length) {
    await db('PaymentRequest').whereIn('memberId', made.users).del();
    await db('Subscription').whereIn('memberId', made.users).del();
    await db('AuditLog').whereIn('actor', made.users).del();
    await db('User').whereIn('id', made.users).del();
  }
  if (made.audits.length) await db('AuditLog').whereIn('actor', made.audits).del();
  await db.destroy();
});

test('db: the migration added memberReference, memberReferenceKey, manualPayment, a partial unique index on the key and a reference-key index', async () => {
  for (const c of ['memberReference', 'memberReferenceKey', 'payerPhone']) assert.equal(await db.schema.hasColumn('PaymentRequest', c), true, c);
  assert.equal(await db.schema.hasColumn('PlatformSettings', 'manualPayment'), true);
  const { rows } = await db.raw(`SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('paymentrequest_member_reference_key_unique', 'paymentrequest_reference_key_idx') ORDER BY indexname`);
  assert.equal(rows.length, 2);
  assert.match(rows[0].indexdef, /UNIQUE/);
  assert.match(rows[0].indexdef, /"memberReferenceKey" IS NOT NULL/);
  assert.match(rows[1].indexdef, /regexp_replace\(upper\(reference\)/);
});

test('db: one transaction ID per pending/approved request; NULLs and rejected requests do not collide', async () => {
  const [a, b] = [await member(), await member()];
  const ref = `DB${randomUUID().slice(0, 8).toUpperCase()}1`;
  const row = (memberId, over = {}) => ({ id: uid('pay'), memberId, subscriptionId: null, tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', requestedAt: new Date(), ...over });
  await db('PaymentRequest').insert([row(a), row(a), row(b)]); // many NULL references
  await db('PaymentRequest').insert(row(a, { memberReference: ref, memberReferenceKey: ref, status: 'rejected' }));
  await db('PaymentRequest').insert(row(a, { memberReference: ref, memberReferenceKey: ref }));
  // Same key, written differently: still refused by the database.
  await assert.rejects(db('PaymentRequest').insert(row(b, { memberReference: `${ref}.`, memberReferenceKey: ref })), (err) => err.code === '23505');
  await assert.rejects(db('PaymentRequest').insert(row(b, { memberReference: ref, memberReferenceKey: ref, status: 'approved' })), (err) => err.code === '23505');
});

test('db: the admin payment list shows the member reference, the paying phone and the registered phone', async () => {
  const m = await member('+255700000001');
  const id = uid('pay');
  await db('PaymentRequest').insert({ id, memberId: m, subscriptionId: null, tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', memberReference: `AL${randomUUID().slice(0, 6).toUpperCase()}9`, payerPhone: '+255754000111', requestedAt: new Date() });
  const admin = createAdminPaymentService({ paymentRequests: collections.paymentRequests, subscriptions: collections.subscriptions, users: collections.users, auditLog: collections.auditLog });
  const listed = (await admin.list()).find((p) => p.id === id);
  assert.match(listed.memberReference, /^AL[0-9A-F]{6}9$/);
  // M1: the member's registered phone is on the (admin-only) row, to compare with the till statement sender.
  assert.equal(listed.member.phone, '+255700000001');
  assert.equal(listed.payerPhone, '+255754000111');
});

test('db: an admin-entered reference is matched on the key, case-insensitively; rate limit counts audited refusals', async () => {
  const store = createPaymentReferenceStore({ db });
  const m = await member();
  const id = uid('pay');
  const tail = randomUUID().slice(0, 6).toUpperCase();
  await db('PaymentRequest').insert({ id, memberId: m, subscriptionId: null, tier: 'basic', amountTzs: 60_000, status: 'approved', provider: 'admin_approved', reference: `mp ${tail.toLowerCase()}-77`, requestedAt: new Date() });
  assert.deepEqual((await store.holders(`MP${tail}77`)).map(r => r.id), [id]);
  assert.deepEqual(await store.holders(`MP${tail}77`, { excludeId: id }), []);
  assert.deepEqual(await store.holders(`MP${tail}771`), []);
  await db('PaymentRequest').where({ id }).update({ status: 'rejected' });
  assert.deepEqual(await store.holders(`MP${tail}77`), [], 'a rejected request releases it');

  const since = new Date(Date.now() - 3_600_000);
  assert.equal(await store.duplicateAttemptsSince(m, since), 0);
  await db('AuditLog').insert([0, 1, 2].map(() => ({ id: randomUUID(), at: new Date(), actor: m, action: DUPLICATE_ATTEMPT_ACTION, target: m })));
  await db('AuditLog').insert({ id: randomUUID(), at: new Date(Date.now() - 2 * 3_600_000), actor: m, action: DUPLICATE_ATTEMPT_ACTION, target: m });
  assert.equal(await store.duplicateAttemptsSince(m, since), 3, 'only the last hour counts');
});

