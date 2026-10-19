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
  validateManualPaymentSettings, manualPaymentOptions, manualPaymentConfigured, normalizePaymentReference,
} from '../src/shared/manual-payment.mjs';
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
  const off = { enabled: false, lipaNamba: null, accountName: null, network: null, instructions: null, referenceRequired: false };
  assert.deepEqual(manualPaymentOptions(saved, false), off, 'flag off');
  assert.deepEqual(manualPaymentOptions(null, true), off, 'flag on, nothing configured');
  assert.deepEqual(manualPaymentOptions({ lipaNamba: '123456' }, true), off, 'flag on, no account name');
  assert.deepEqual(manualPaymentOptions(saved, true), {
    enabled: true, lipaNamba: '5123456', accountName: 'FitFlex Africa Ltd', network: 'M-Pesa',
    instructions: saved.instructions, referenceRequired: true,
  });
  assert.equal(manualPaymentConfigured(saved), true);
  assert.equal(manualPaymentConfigured(null), false);
});

test('reference: trimmed and upper-cased; 6–40 of letters, digits and . _ -, with a digit', () => {
  assert.deepEqual(normalizePaymentReference('  qgh7xk2l9p '), { reference: 'QGH7XK2L9P' });
  assert.deepEqual(normalizePaymentReference(1234567890), { reference: '1234567890' });
  assert.deepEqual(normalizePaymentReference('MP241019.1234-AB_c'), { reference: 'MP241019.1234-AB_C' });
  for (const missing of [undefined, null, '', '   ']) assert.equal(normalizePaymentReference(missing).error, 'payment_reference_required', String(missing));
  for (const bad of ['AB12', 'ABCDEFGH', 'QGH7 XK2L9P', '-QGH7XK2L9P', 'QGH7XK2L9P;--', 'pending:123456', 'A1'.repeat(21), { id: 1 }, ['QGH7XK2L9P'], true]) {
    assert.equal(normalizePaymentReference(bad).error, 'payment_reference_invalid', JSON.stringify(bad));
  }
});

// ── subscription service ───────────────────────────────────────────────────

test('flag off (not required): pass, gym plan and upgrade work exactly as before and store no member reference', async () => {
  const { service } = setup();
  const pass = await service.subscribe({ memberId: 'm1', tier: 'basic' });
  assert.equal(pass.status, 202, JSON.stringify(pass));
  assert.equal(pass.paymentRequest.reference, null);
  assert.equal('memberReference' in pass.paymentRequest, false);
  // A reference sent anyway is ignored, not stored.
  const plan = await service.subscribe({ memberId: 'm2', type: 'direct_sub', homeGymId: gym.id, plan: 'daily', reference: 'QGH7XK2L9P' });
  assert.equal(plan.status, 202, JSON.stringify(plan));
  assert.equal('memberReference' in plan.paymentRequest, false);
  const up = setup({ subs: [activePass('m3')] });
  const upgrade = await up.service.upgradePass({ memberId: 'm3', tier: 'pro' });
  assert.equal(upgrade.status, 202, JSON.stringify(upgrade));
  assert.equal('memberReference' in upgrade.paymentRequest, false);
});

test('required: a pass needs the transaction ID — missing 400, invalid 400, valid stored upper-cased', async () => {
  const { service, subscriptions, paymentRequests } = setup({ required: true });
  assert.deepEqual(await service.subscribe({ memberId: 'm1', tier: 'basic' }), { error: 'payment_reference_required', status: 400 });
  assert.deepEqual(await service.subscribe({ memberId: 'm1', tier: 'basic', reference: 'abc' }), { error: 'payment_reference_invalid', status: 400 });
  assert.equal(subscriptions.rows.length, 0, 'a refused request leaves no plan behind');
  assert.equal(paymentRequests.rows.length, 0);
  const ok = await service.subscribe({ memberId: 'm1', tier: 'basic', reference: ' qgh7xk2l9p ' });
  assert.equal(ok.status, 202, JSON.stringify(ok));
  assert.equal(ok.paymentRequest.memberReference, 'QGH7XK2L9P');
  assert.equal(ok.paymentRequest.reference, null, 'the admin/provider reference is left alone');
  assert.equal(ok.paymentRequest.provider, 'admin_approved');
});

test('required: a transaction ID on another pending or approved request is refused (409); rejected / cancelled ones release it', async () => {
  const taken = (status, over = {}) => ({ id: `pay_${status}`, memberId: 'other', status, provider: 'admin_approved', reference: null, memberReference: 'QGH7XK2L9P', ...over });
  for (const status of ['pending', 'approved']) {
    const { service, subscriptions } = setup({ required: true, requests: [taken(status)] });
    assert.deepEqual(await service.subscribe({ memberId: 'm1', tier: 'basic', reference: 'qgh7xk2l9p' }), { error: 'payment_reference_duplicate', status: 409 }, status);
    assert.equal(subscriptions.rows.length, 0);
  }
  // An admin-entered reference counts too.
  const viaAdmin = setup({ required: true, requests: [taken('approved', { memberReference: null, reference: 'QGH7XK2L9P' })] });
  assert.equal((await viaAdmin.service.subscribe({ memberId: 'm1', tier: 'basic', reference: 'QGH7XK2L9P' })).error, 'payment_reference_duplicate');
  for (const status of ['rejected', 'cancelled']) {
    const { service } = setup({ required: true, requests: [taken(status)] });
    assert.equal((await service.subscribe({ memberId: 'm1', tier: 'basic', reference: 'QGH7XK2L9P' })).status, 202, status);
  }
});

test('required: a direct gym plan needs the transaction ID too; an already pending payment still answers first', async () => {
  const { service } = setup({ required: true });
  const body = { memberId: 'm1', type: 'direct_sub', homeGymId: gym.id, plan: 'weekly' };
  assert.equal((await service.subscribe(body)).error, 'payment_reference_required');
  assert.equal((await service.subscribe({ ...body, reference: '!!' })).error, 'payment_reference_invalid');
  const ok = await service.subscribe({ ...body, reference: 'MP1234567' });
  assert.equal(ok.status, 202);
  assert.equal(ok.paymentRequest.memberReference, 'MP1234567');
  assert.equal(ok.paymentRequest.amountTzs, 25_000);
  assert.equal((await service.subscribe({ ...body, reference: 'MP7654321' })).error, 'payment_already_pending');
});

test('required: a pass upgrade needs the transaction ID; stored on the upgrade request', async () => {
  const { service } = setup({ required: true, subs: [activePass('m1')] });
  assert.equal((await service.upgradePass({ memberId: 'm1', tier: 'pro' })).error, 'payment_reference_required');
  const ok = await service.upgradePass({ memberId: 'm1', tier: 'pro', reference: 'UPG123456' });
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
  assert.deepEqual(await service.subscribe({ memberId: 'm1', tier: 'basic', reference: 'QGH7XK2L9P' }), { error: 'payment_reference_duplicate', status: 409 });
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
async function member() {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'member', displayName: 'Manual Pay', updatedAt: new Date() });
  made.users.push(id);
  return id;
}

after(async () => {
  if (made.users.length) {
    await db('PaymentRequest').whereIn('memberId', made.users).del();
    await db('Subscription').whereIn('memberId', made.users).del();
    await db('User').whereIn('id', made.users).del();
  }
  if (made.audits.length) await db('AuditLog').whereIn('actor', made.audits).del();
  await db.destroy();
});

test('db: the migration added PaymentRequest.memberReference, PlatformSettings.manualPayment and a partial unique index', async () => {
  assert.equal(await db.schema.hasColumn('PaymentRequest', 'memberReference'), true);
  assert.equal(await db.schema.hasColumn('PlatformSettings', 'manualPayment'), true);
  const { rows } = await db.raw(`SELECT indexdef FROM pg_indexes WHERE indexname = 'paymentrequest_member_reference_unique'`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].indexdef, /UNIQUE/);
  assert.match(rows[0].indexdef, /"memberReference" IS NOT NULL/);
});

test('db: one transaction ID per pending/approved request; NULLs and rejected requests do not collide', async () => {
  const [a, b] = [await member(), await member()];
  const ref = `DB${randomUUID().slice(0, 8).toUpperCase()}1`;
  const row = (memberId, over = {}) => ({ id: uid('pay'), memberId, subscriptionId: null, tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', requestedAt: new Date(), ...over });
  await db('PaymentRequest').insert([row(a), row(a), row(b)]); // many NULL references
  await db('PaymentRequest').insert(row(a, { memberReference: ref, status: 'rejected' }));
  await db('PaymentRequest').insert(row(a, { memberReference: ref }));
  await assert.rejects(db('PaymentRequest').insert(row(b, { memberReference: ref })), (err) => err.code === '23505');
  await assert.rejects(db('PaymentRequest').insert(row(b, { memberReference: ref, status: 'approved' })), (err) => err.code === '23505');
});

test('db: subscribe stores the member reference; a second member with it is refused; racing pair → exactly one wins', async () => {
  const service = createSubscriptionService({
    subscriptions: collections.subscriptions, paymentRequests: collections.paymentRequests, checkins: collections.checkins,
    gyms: [gym], settingsService: fakeSettings, publicUserId: async () => 'FF-1', manualPayment: { required: () => true },
  });
  const [a, b, c, d] = [await member(), await member(), await member(), await member()];
  const ref = `QG${randomUUID().slice(0, 8).toUpperCase()}7`;
  const ok = await service.subscribe({ memberId: a, tier: 'basic', reference: ref.toLowerCase() });
  assert.equal(ok.status, 202, JSON.stringify(ok));
  const stored = await db('PaymentRequest').where({ id: ok.paymentRequest.id }).first();
  assert.equal(stored.memberReference, ref);
  assert.equal(stored.reference, null);
  assert.deepEqual(await service.subscribe({ memberId: b, tier: 'basic', reference: ref }), { error: 'payment_reference_duplicate', status: 409 });

  const race = `RC${randomUUID().slice(0, 8).toUpperCase()}3`;
  const results = await Promise.all([c, d].map((m) => service.subscribe({ memberId: m, tier: 'basic', reference: race })));
  assert.deepEqual(results.map((r) => r.status).sort(), [202, 409], JSON.stringify(results));
  assert.equal((await db('PaymentRequest').where({ memberReference: race })).length, 1);
  const loser = [c, d][results.findIndex((r) => r.status === 409)];
  const loserSubs = await db('Subscription').where({ memberId: loser });
  assert.ok(loserSubs.every((s) => s.status === 'payment_cancelled'), 'no open plan is left without its payment');
});

test('db: the admin payment list shows the member reference', async () => {
  const m = await member();
  const id = uid('pay');
  await db('PaymentRequest').insert({ id, memberId: m, subscriptionId: null, tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', memberReference: `AL${randomUUID().slice(0, 6).toUpperCase()}9`, requestedAt: new Date() });
  const admin = createAdminPaymentService({ paymentRequests: collections.paymentRequests, subscriptions: collections.subscriptions, users: collections.users, auditLog: collections.auditLog });
  const listed = (await admin.list()).find((p) => p.id === id);
  assert.match(listed.memberReference, /^AL[0-9A-F]{6}9$/);
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
      { enabled: false, lipaNamba: null, accountName: null, network: null, instructions: null, referenceRequired: false });

    const bad = await call(adminUpdateSettings, { body: { manualPayment: { lipaNamba: '12', accountName: 'FitFlex' } }, user: { sub: actor } });
    assert.deepEqual([bad.code, bad.body], [400, { error: 'manual_payment_invalid', field: 'lipaNamba' }]);
    const good = await call(adminUpdateSettings, { body: { manualPayment: { lipaNamba: '987654', accountName: 'FitFlex Africa', network: 'M-Pesa' } }, user: { sub: actor } });
    assert.equal(good.code, 200);
    const stored = await db('PlatformSettings').where({ id: 'platform' }).first('manualPayment');
    assert.equal(stored.manualPayment.lipaNamba, '987654');
    assert.deepEqual((await call(paymentOptions)).body.manual,
      { enabled: true, lipaNamba: '987654', accountName: 'FitFlex Africa', network: 'M-Pesa', instructions: null, referenceRequired: true });
  } finally {
    await settingsService.adminUpdate({ body: { manualPayment: savedBefore }, actorId: actor });
    if (before === undefined) delete process.env.MANUAL_PAY_INSTRUCTIONS; else process.env.MANUAL_PAY_INSTRUCTIONS = before;
  }
});
