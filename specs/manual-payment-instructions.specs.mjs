// Slice A3: manual mobile-money payment instructions + a required transaction ID.
//
// Behind MANUAL_PAY_INSTRUCTIONS (off by default). Off: nothing changes — no
// `manual` block on /payments/options, subscribe / upgrade take no reference.
// On without a Lipa Namba configured: still not enabled. On with details: the
// member must give the mobile-money transaction ID, which is validated, stored
// on the payment request (memberReference) and never accepted twice.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  validateManualPaymentSettings, manualPaymentOptions, manualPaymentConfigured, normalizePaymentReference, referenceKey, normalizePayerPhone,
  DUPLICATE_ATTEMPT_ACTION,
} from '../src/shared/manual-payment.mjs';
import { createPaymentReferenceStore } from '../src/infra/payment-reference-store.mjs';
import { manualPayInstructionsOn } from '../src/shared/feature-flags.mjs';
import { createSubscriptionService } from '../src/services/subscription-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { createSettingsService } from '../src/services/settings-service.mjs';
import { createMobileMoneyService } from '../src/services/mobile-money-service.mjs';
import { db } from '../src/infra/knex-store.mjs';
import * as collections from '../src/bootstrap/collections.mjs';
import { ensureInit } from '../functions/index.mjs';
import { paymentOptions } from '../functions/mobile-money.mjs';
import { adminUpdateSettings } from '../functions/admin-settings.mjs';
import { settingsService } from '../src/bootstrap/services.mjs';

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
const fakeSettings = { priceForTier: (t) => PRICES[t] ?? 0, visitCapForTier: () => null, publicTiers: () => tiers };
const gym = { id: 'gym_m1', name: 'Gym', status: 'active', ratePerDay: 5_000, ratePerWeek: 25_000, ratePerMonth: 80_000 };
const DAY = 86_400_000;
const PHONE = '0712 345 678';

function setup({ required = false, subs = [], requests = [] } = {}) {
  const subscriptions = memStore(subs);
  const paymentRequests = memStore(requests);
  const service = createSubscriptionService({
    subscriptions, paymentRequests, checkins: memStore(), gyms: [gym], settingsService: fakeSettings,
    publicUserId: async () => 'FF-1', manualPayment: { required: () => required },
  });
  return { service, subscriptions, paymentRequests };
}

const activePass = (memberId = 'm1') => ({
  id: `sub_${memberId}`, memberId, type: 'platform_pass', tier: 'basic', status: 'active',
  startedAt: new Date(Date.now() - 5 * DAY).toISOString(), cycleStartedAt: new Date(Date.now() - 5 * DAY).toISOString(),
  expiresAt: new Date(Date.now() + 25 * DAY).toISOString(), renewsAt: new Date(Date.now() + 25 * DAY).toISOString(),
});

const DETAILS = { lipaNamba: '5 123-456', accountName: '  FitFlex Africa Ltd ', network: 'M-Pesa', instructions: { en: 'Pay then enter the ID', sw: 'Lipa kisha weka namba ya muamala' } };

// ── pure rules ─────────────────────────────────────────────────────────────

test('flag: MANUAL_PAY_INSTRUCTIONS is off unless set', () => {
  const before = process.env.MANUAL_PAY_INSTRUCTIONS;
  try {
    delete process.env.MANUAL_PAY_INSTRUCTIONS;
    assert.equal(manualPayInstructionsOn(), false);
    process.env.MANUAL_PAY_INSTRUCTIONS = '0';
    assert.equal(manualPayInstructionsOn(), false);
    process.env.MANUAL_PAY_INSTRUCTIONS = 'true';
    assert.equal(manualPayInstructionsOn(), true);
  } finally {
    if (before === undefined) delete process.env.MANUAL_PAY_INSTRUCTIONS; else process.env.MANUAL_PAY_INSTRUCTIONS = before;
  }
});

test('settings: Lipa Namba digits only, account name required, optional network and bilingual instructions; null clears', () => {
  assert.deepEqual(validateManualPaymentSettings(DETAILS).value, {
    lipaNamba: '5123456', accountName: 'FitFlex Africa Ltd', network: 'M-Pesa',
    instructions: { en: 'Pay then enter the ID', sw: 'Lipa kisha weka namba ya muamala' },
  });
  assert.deepEqual(validateManualPaymentSettings({ lipaNamba: 123456, accountName: 'FitFlex' }).value,
    { lipaNamba: '123456', accountName: 'FitFlex', network: null, instructions: null });
  assert.deepEqual(validateManualPaymentSettings(null), { value: null });
  const field = (input) => validateManualPaymentSettings(input).field;
  assert.equal(field('x'), 'manualPayment');
  assert.equal(field([]), 'manualPayment');
  assert.equal(field({ accountName: 'FitFlex' }), 'lipaNamba');
  assert.equal(field({ lipaNamba: '12AB34', accountName: 'FitFlex' }), 'lipaNamba');
  assert.equal(field({ lipaNamba: '123', accountName: 'FitFlex' }), 'lipaNamba');
  assert.equal(field({ lipaNamba: '123456' }), 'accountName');
  assert.equal(field({ lipaNamba: '123456', accountName: 'x'.repeat(161) }), 'accountName');
  assert.equal(field({ lipaNamba: '123456', accountName: 'FitFlex', network: 5 }), 'network');
  assert.equal(field({ lipaNamba: '123456', accountName: 'FitFlex', instructions: 'pay' }), 'instructions');
  assert.equal(field({ lipaNamba: '123456', accountName: 'FitFlex', instructions: { sw: 'x'.repeat(1001) } }), 'instructions.sw');
  assert.equal(validateManualPaymentSettings({ lipaNamba: '123456', accountName: 'FitFlex' }).error, undefined);
  assert.equal(validateManualPaymentSettings({ accountName: 'FitFlex' }).error, 'manual_payment_invalid');
});

test('options: enabled only with the flag on AND a Lipa Namba and account name; details hidden otherwise', () => {
  const saved = validateManualPaymentSettings(DETAILS).value;
  const off = { enabled: false, lipaNamba: null, accountName: null, network: null, instructions: null, referenceRequired: false, payerPhoneRequired: false };
  assert.deepEqual(manualPaymentOptions(saved, false), off, 'flag off');
  assert.deepEqual(manualPaymentOptions(null, true), off, 'flag on, nothing configured');
  assert.deepEqual(manualPaymentOptions({ lipaNamba: '123456' }, true), off, 'flag on, no account name');
  assert.deepEqual(manualPaymentOptions(saved, true), {
    enabled: true, lipaNamba: '5123456', accountName: 'FitFlex Africa Ltd', network: 'M-Pesa',
    instructions: saved.instructions, referenceRequired: true, payerPhoneRequired: true,
  });
  assert.equal(manualPaymentConfigured(saved), true);
  assert.equal(manualPaymentConfigured(null), false);
});

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

test('flag off (not required): pass, gym plan and upgrade work exactly as before and store no member reference', async () => {
  const { service } = setup();
  const pass = await service.subscribe({ memberId: 'm1', tier: 'basic' });
  assert.equal(pass.status, 202, JSON.stringify(pass));
  assert.equal(pass.paymentRequest.reference, null);
  assert.equal('memberReference' in pass.paymentRequest, false);
  // A reference sent anyway is ignored, not stored.
  const plan = await service.subscribe({ memberId: 'm2', type: 'direct_sub', homeGymId: gym.id, plan: 'daily', payerPhone: PHONE, reference: 'QGH7XK2L9P' });
  assert.equal(plan.status, 202, JSON.stringify(plan));
  assert.equal('memberReference' in plan.paymentRequest, false);
  const up = setup({ subs: [activePass('m3')] });
  const upgrade = await up.service.upgradePass({ memberId: 'm3', tier: 'pro' });
  assert.equal(upgrade.status, 202, JSON.stringify(upgrade));
  assert.equal('memberReference' in upgrade.paymentRequest, false);
});

test('required: the paying phone is required with the reference (pass, gym plan, upgrade) and stored as +255…', async () => {
  const { service } = setup({ required: true, subs: [activePass('m3')] });
  assert.deepEqual(await service.subscribe({ memberId: 'm1', tier: 'basic', reference: 'QGH7XK2L9P' }), { error: 'payer_phone_required', status: 400 });
  assert.deepEqual(await service.subscribe({ memberId: 'm1', tier: 'basic', reference: 'QGH7XK2L9P', payerPhone: '0812345678' }), { error: 'payer_phone_invalid', status: 400 });
  assert.equal((await service.subscribe({ memberId: 'm2', type: 'direct_sub', homeGymId: gym.id, plan: 'daily', reference: 'GYM1234567' })).error, 'payer_phone_required');
  assert.equal((await service.upgradePass({ memberId: 'm3', tier: 'pro', reference: 'UPG1234567', payerPhone: '+254712345678' })).error, 'payer_phone_invalid');
  const ok = await service.subscribe({ memberId: 'm1', tier: 'basic', reference: 'QGH7XK2L9P', payerPhone: '255 754 000 111' });
  assert.equal(ok.status, 202, JSON.stringify(ok));
  assert.equal(ok.paymentRequest.payerPhone, '+255754000111');
  // Flag off: a phone sent anyway is ignored, not stored.
  const off = setup();
  const plain = await off.service.subscribe({ memberId: 'm1', tier: 'basic', reference: 'QGH7XK2L9P', payerPhone: '0712345678' });
  assert.equal('payerPhone' in plain.paymentRequest, false);
});

test('required: a pass needs the transaction ID — missing 400, invalid 400, valid stored upper-cased', async () => {
  const { service, subscriptions, paymentRequests } = setup({ required: true });
  assert.deepEqual(await service.subscribe({ memberId: 'm1', tier: 'basic' }), { error: 'payment_reference_required', status: 400 });
  assert.deepEqual(await service.subscribe({ memberId: 'm1', tier: 'basic', payerPhone: PHONE, reference: 'abc' }), { error: 'payment_reference_invalid', status: 400 });
  assert.equal(subscriptions.rows.length, 0, 'a refused request leaves no plan behind');
  assert.equal(paymentRequests.rows.length, 0);
  const ok = await service.subscribe({ memberId: 'm1', tier: 'basic', payerPhone: PHONE, reference: ' qgh7xk2l9p ' });
  assert.equal(ok.status, 202, JSON.stringify(ok));
  assert.equal(ok.paymentRequest.memberReference, 'QGH7XK2L9P');
  assert.equal(ok.paymentRequest.reference, null, 'the admin/provider reference is left alone');
  assert.equal(ok.paymentRequest.provider, 'admin_approved');
});

test('required: a transaction ID on another pending or approved request is refused (409); rejected / cancelled ones release it', async () => {
  const taken = (status, over = {}) => ({ id: `pay_${status}`, memberId: 'other', status, provider: 'admin_approved', reference: null, memberReference: 'QGH7XK2L9P', ...over });
  for (const status of ['pending', 'approved']) {
    const { service, subscriptions } = setup({ required: true, requests: [taken(status)] });
    assert.deepEqual(await service.subscribe({ memberId: 'm1', tier: 'basic', payerPhone: PHONE, reference: 'qgh7xk2l9p' }), { error: 'payment_reference_duplicate', status: 409 }, status);
    assert.equal(subscriptions.rows.length, 0);
  }
  // An admin-entered reference counts too.
  const viaAdmin = setup({ required: true, requests: [taken('approved', { memberReference: null, reference: 'QGH7XK2L9P' })] });
  assert.equal((await viaAdmin.service.subscribe({ memberId: 'm1', tier: 'basic', payerPhone: PHONE, reference: 'QGH7XK2L9P' })).error, 'payment_reference_duplicate');
  for (const status of ['rejected', 'cancelled']) {
    const { service } = setup({ required: true, requests: [taken(status)] });
    assert.equal((await service.subscribe({ memberId: 'm1', tier: 'basic', payerPhone: PHONE, reference: 'QGH7XK2L9P' })).status, 202, status);
  }
});

test('M2: variants of a taken ID (case, dots, dashes, underscores) are duplicates — against member IDs and admin references alike', async () => {
  const taken = [
    { id: 'pay_m', memberId: 'other', status: 'pending', provider: 'admin_approved', reference: null, memberReference: 'QGH7XK2L9P', memberReferenceKey: 'QGH7XK2L9P' },
    { id: 'pay_a', memberId: 'other2', status: 'approved', provider: 'admin_approved', reference: 'mp 555-111-222' },
  ];
  for (const variant of ['qgh7xk2l9p', 'QGH7XK2L9P.', 'QGH7-XK2L9P', 'QGH7_XK2L9P', 'Q.GH7XK2L9P', 'MP555111222', 'mp555.111.222']) {
    const { service } = setup({ required: true, requests: taken.map(r => ({ ...r })) });
    assert.equal((await service.subscribe({ memberId: `m_${variant}`, tier: 'basic', payerPhone: PHONE, reference: variant })).error, 'payment_reference_duplicate', variant);
  }
  // An extra digit is another transaction.
  const { service } = setup({ required: true, requests: taken.map(r => ({ ...r })) });
  const ok = await service.subscribe({ memberId: 'm9', tier: 'basic', payerPhone: PHONE, reference: 'QGH7XK2L9P_1' });
  assert.equal(ok.status, 202, JSON.stringify(ok));
  assert.deepEqual([ok.paymentRequest.memberReference, ok.paymentRequest.memberReferenceKey], ['QGH7XK2L9P_1', 'QGH7XK2L9P1']);
});

test('M1: each refused duplicate is audited; after 5 in an hour the member gets 429 too_many_attempts, even with a fresh ID', async () => {
  let clock = Date.parse('2026-10-19T10:00:00Z');
  const audit = memStore();
  const subscriptions = memStore();
  const paymentRequests = memStore([{ id: 'pay_x', memberId: 'victim', status: 'approved', reference: null, memberReference: 'TAKEN12345', memberReferenceKey: 'TAKEN12345' }]);
  const service = createSubscriptionService({
    subscriptions, paymentRequests, checkins: memStore(), gyms: [gym], settingsService: fakeSettings,
    publicUserId: async () => 'FF-1', manualPayment: { required: () => true }, auditLog: audit, now: () => clock,
  });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await service.subscribe({ memberId: 'prober', tier: 'basic', payerPhone: PHONE, reference: 'taken-12345' })).error, 'payment_reference_duplicate');
    clock += 60_000;
  }
  assert.equal(audit.rows.length, 5);
  assert.deepEqual(audit.rows.map(a => [a.actor, a.action, a.after.referenceKey, a.after.product])[0], ['prober', DUPLICATE_ATTEMPT_ACTION, 'TAKEN12345', 'fitflex_pass']);
  assert.deepEqual(await service.subscribe({ memberId: 'prober', tier: 'basic', payerPhone: PHONE, reference: 'FRESH99999' }), { error: 'too_many_attempts', status: 429 });
  assert.deepEqual(await service.upgradePass({ memberId: 'prober', tier: 'pro', payerPhone: PHONE, reference: 'FRESH99999' }), { error: 'no_active_pass', status: 409 }, 'other checks still come first');
  // Another member is not affected.
  assert.equal((await service.subscribe({ memberId: 'honest', tier: 'basic', payerPhone: PHONE, reference: 'FRESH99999' })).status, 202);
  // An hour after the first refusals the member can try again.
  clock += 60 * 60_000;
  assert.equal((await service.subscribe({ memberId: 'prober', tier: 'basic', payerPhone: PHONE, reference: 'OTHER88888' })).status, 202);
});

test('required: a direct gym plan needs the transaction ID too; an already pending payment still answers first', async () => {
  const { service } = setup({ required: true });
  const body = { memberId: 'm1', type: 'direct_sub', homeGymId: gym.id, plan: 'weekly' };
  assert.equal((await service.subscribe(body)).error, 'payment_reference_required');
  assert.equal((await service.subscribe({ ...body, payerPhone: PHONE, reference: '!!' })).error, 'payment_reference_invalid');
  const ok = await service.subscribe({ ...body, payerPhone: PHONE, reference: 'MP1234567' });
  assert.equal(ok.status, 202);
  assert.equal(ok.paymentRequest.memberReference, 'MP1234567');
  assert.equal(ok.paymentRequest.amountTzs, 25_000);
  assert.equal((await service.subscribe({ ...body, payerPhone: PHONE, reference: 'MP7654321' })).error, 'payment_already_pending');
});

test('required: a pass upgrade needs the transaction ID; stored on the upgrade request', async () => {
  const { service } = setup({ required: true, subs: [activePass('m1')] });
  assert.equal((await service.upgradePass({ memberId: 'm1', tier: 'pro' })).error, 'payment_reference_required');
  const ok = await service.upgradePass({ memberId: 'm1', tier: 'pro', payerPhone: PHONE, reference: 'UPG123456' });
  assert.equal(ok.status, 202, JSON.stringify(ok));
  assert.equal(ok.paymentRequest.memberReference, 'UPG123456');
  assert.equal(ok.paymentRequest.amountTzs, 60_000);
});

test('required: the free online tier and a trainer buying a gym member plan are not asked for a reference', async () => {
  const { service } = setup({ required: true });
  const free = await service.subscribe({ memberId: 'm1', tier: 'online_free' });
  assert.equal(free.status, 201, JSON.stringify(free));
  const trainerPlan = await service.trainerMemberPlanPurchase({ trainerUserId: 't1', gymId: gym.id, plan: 'daily', trainer: { gyms: [] } });
  assert.equal(trainerPlan.status, 202, JSON.stringify(trainerPlan));
  assert.equal('memberReference' in trainerPlan.paymentRequest, false);
});

test('required: when the database refuses a racing duplicate, the new plan is cancelled and the member gets 409', async () => {
  const { service, subscriptions, paymentRequests } = setup({ required: true });
  paymentRequests.insertAsync = async () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); };
  assert.deepEqual(await service.subscribe({ memberId: 'm1', tier: 'basic', payerPhone: PHONE, reference: 'QGH7XK2L9P' }), { error: 'payment_reference_duplicate', status: 409 });
  assert.equal(subscriptions.rows[0].status, 'payment_cancelled');
});

// ── settings, admin approval, mobile-money guard ───────────────────────────

function settingsSetup() {
  const rows = [];
  const platformSettings = {
    find: (fn) => rows.find(fn) || null,
    insert: (row) => { rows.push(row); return row; },
    async updateAsync(fn, patch) { const i = rows.findIndex(fn); rows[i] = { ...rows[i], ...patch }; return rows[i]; },
  };
  return createSettingsService({ platformSettings, auditLog: { async insertAsync() {} } });
}

test('admin settings: manualPayment validated (400 with field), saved normalised, readable, cleared with null; other keys unchanged', async () => {
  const settings = settingsSetup();
  assert.equal(settings.manualPaymentSettings(), null);
  assert.deepEqual(await settings.adminUpdate({ body: { manualPayment: { lipaNamba: 'abc', accountName: 'FitFlex' } }, actorId: 'a1' }),
    { error: 'manual_payment_invalid', field: 'lipaNamba', status: 400 });
  assert.equal(settings.manualPaymentSettings(), null, 'nothing saved on error');
  const saved = await settings.adminUpdate({ body: { manualPayment: DETAILS, currency: 'TZS' }, actorId: 'a1' });
  assert.equal(saved.manualPayment.lipaNamba, '5123456');
  assert.equal(settings.manualPaymentSettings().accountName, 'FitFlex Africa Ltd');
  assert.equal(settings.adminGet().manualPayment.network, 'M-Pesa');
  // An update without the key leaves it as it is.
  await settings.adminUpdate({ body: { paymentPeriodDays: 7 }, actorId: 'a1' });
  assert.equal(settings.manualPaymentSettings().lipaNamba, '5123456');
  await settings.adminUpdate({ body: { manualPayment: null }, actorId: 'a1' });
  assert.equal(settings.manualPaymentSettings(), null);
});

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

test('db: subscribe stores the member reference; a second member with it is refused; racing pair → exactly one wins', async () => {
  const service = createSubscriptionService({
    subscriptions: collections.subscriptions, paymentRequests: collections.paymentRequests, checkins: collections.checkins,
    gyms: [gym], settingsService: fakeSettings, publicUserId: async () => 'FF-1', manualPayment: { required: () => true },
    auditLog: collections.auditLog, referenceStore: createPaymentReferenceStore({ db }),
  });
  const [a, b, c, d] = [await member(), await member(), await member(), await member()];
  const ref = `QG${randomUUID().slice(0, 8).toUpperCase()}7`;
  const ok = await service.subscribe({ memberId: a, tier: 'basic', payerPhone: PHONE, reference: ref.toLowerCase() });
  assert.equal(ok.status, 202, JSON.stringify(ok));
  const stored = await db('PaymentRequest').where({ id: ok.paymentRequest.id }).first();
  assert.equal(stored.memberReference, ref);
  assert.equal(stored.memberReferenceKey, ref);
  assert.equal(stored.payerPhone, '+255712345678');
  assert.equal(stored.reference, null);
  assert.deepEqual(await service.subscribe({ memberId: b, tier: 'basic', payerPhone: PHONE, reference: ref }), { error: 'payment_reference_duplicate', status: 409 });
  // M2 on the database: punctuation variants are the same transaction.
  assert.deepEqual(await service.subscribe({ memberId: b, tier: 'basic', payerPhone: PHONE, reference: `${ref.slice(0, 4)}-${ref.slice(4)}.` }), { error: 'payment_reference_duplicate', status: 409 });
  // M1: both refusals are in the audit log under the member.
  assert.equal((await db('AuditLog').where({ actor: b, action: DUPLICATE_ATTEMPT_ACTION })).length, 2);

  const race = `RC${randomUUID().slice(0, 8).toUpperCase()}3`;
  const results = await Promise.all([c, d].map((m) => service.subscribe({ memberId: m, tier: 'basic', payerPhone: PHONE, reference: race })));
  assert.deepEqual(results.map((r) => r.status).sort(), [202, 409], JSON.stringify(results));
  assert.equal((await db('PaymentRequest').where({ memberReferenceKey: race })).length, 1);
  const loser = [c, d][results.findIndex((r) => r.status === 409)];
  const loserSubs = await db('Subscription').where({ memberId: loser });
  assert.ok(loserSubs.every((s) => s.status === 'payment_cancelled'), 'no open plan is left without its payment');
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

test('route: GET /payments/options has no `manual` with the flag off; enabled only once details are saved', async () => {
  const call = async (endpoint, req = {}) => {
    let code = 200, body;
    const res = { status(c) { code = c; return res; }, json(b) { body = b; return res; } };
    await endpoint.onRequest({ body: {}, params: {}, ...req }, res);
    return { code, body };
  };
  const actor = uid('adm');
  made.audits.push(actor);
  const before = process.env.MANUAL_PAY_INSTRUCTIONS;
  const savedBefore = settingsService.manualPaymentSettings();
  try {
    delete process.env.MANUAL_PAY_INSTRUCTIONS;
    await settingsService.adminUpdate({ body: { manualPayment: null }, actorId: actor });
    const off = await call(paymentOptions);
    assert.equal('manual' in off.body, false, 'flag off: response unchanged');
    assert.equal(typeof off.body.enabled, 'boolean');

    process.env.MANUAL_PAY_INSTRUCTIONS = '1';
    assert.deepEqual((await call(paymentOptions)).body.manual,
      { enabled: false, lipaNamba: null, accountName: null, network: null, instructions: null, referenceRequired: false, payerPhoneRequired: false });

    const bad = await call(adminUpdateSettings, { body: { manualPayment: { lipaNamba: '12', accountName: 'FitFlex' } }, user: { sub: actor } });
    assert.deepEqual([bad.code, bad.body], [400, { error: 'manual_payment_invalid', field: 'lipaNamba' }]);
    const good = await call(adminUpdateSettings, { body: { manualPayment: { lipaNamba: '987654', accountName: 'FitFlex Africa', network: 'M-Pesa' } }, user: { sub: actor } });
    assert.equal(good.code, 200);
    const stored = await db('PlatformSettings').where({ id: 'platform' }).first('manualPayment');
    assert.equal(stored.manualPayment.lipaNamba, '987654');
    assert.deepEqual((await call(paymentOptions)).body.manual,
      { enabled: true, lipaNamba: '987654', accountName: 'FitFlex Africa', network: 'M-Pesa', instructions: null, referenceRequired: true, payerPhoneRequired: true });
  } finally {
    await settingsService.adminUpdate({ body: { manualPayment: savedBefore }, actorId: actor });
    if (before === undefined) delete process.env.MANUAL_PAY_INSTRUCTIONS; else process.env.MANUAL_PAY_INSTRUCTIONS = before;
  }
});
