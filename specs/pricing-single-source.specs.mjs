// Owner decision 2026-10-19: no FitFlex Pass tier may be sold unless it is
// configured in Settings — a positive price and an explicit visits value
// (-1 = unlimited, whole number > 0 = cap), and not switched off. Fail closed:
// no built-in price list, no "unknown tier = unlimited".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionService } from '../src/services/subscription-service.mjs';
import { createMobileMoneyService } from '../src/services/mobile-money-service.mjs';
import { PASS_TIERS } from '../src/shared/constants.mjs';
import { DEFAULT_SUBSCRIPTION_TIERS } from '../src/shared/default-subscription-tiers.mjs';
import { settingsWithTiers, memoryPlatformSettings, TEST_TIERS } from './fixtures/tier-settings.mjs';
import { createSettingsService } from '../src/services/settings-service.mjs';
import { PASS_GYM_ACCESS } from '../src/shared/check-in-rules.mjs';
import { adminUpdateSettings } from '../functions/admin-settings.mjs';

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find((r) => r.id === id) || null; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
  };
}

function subscriptionService(tierRows = TEST_TIERS) {
  const subscriptions = memStore();
  const paymentRequests = memStore();
  const service = createSubscriptionService({
    subscriptions, paymentRequests, checkins: memStore(), gyms: [],
    settingsService: settingsWithTiers(tierRows), publicUserId: async () => 'FF-1',
  });
  return { service, subscriptions, paymentRequests };
}

// ── the constants carry no price or cap any more ──

test('PASS_TIERS holds no price, visit cap or gym access (Settings is the only source)', () => {
  for (const [key, meta] of Object.entries(PASS_TIERS)) {
    for (const field of ['price', 'visitCap', 'gymTiers', 'monthlyPrice', 'visits']) {
      assert.equal(meta[field], undefined, `${key}.${field}`);
    }
  }
});

// ── settings service ──

test('getTierConfig / sellableTier: only Settings, never a built-in fallback', () => {
  const s = settingsWithTiers([
    { key: 'basic', label: 'Basic', monthlyPrice: 30_000, visits: 12, gymAccess: 'standard' },
    { key: 'pro', label: 'Pro', monthlyPrice: 60_000, visits: -1, gymAccess: 'midtier' },
    { key: 'premium', label: 'Premium', monthlyPrice: 100_000, gymAccess: 'premium' },          // no visits
    { key: 'executive', label: 'Executive', monthlyPrice: 0, visits: 30, gymAccess: 'luxury_executive' }, // no price
    { key: 'gold', label: 'Gold', monthlyPrice: 90_000, visits: 10, gymAccess: 'premium', active: false },
    { key: 'silver', label: 'Silver', monthlyPrice: 90_000, visits: 2.5, gymAccess: 'premium' },
  ]);
  assert.equal(s.getTierConfig('basic').visitCap, 12);
  assert.equal(s.getTierConfig('pro').visitCap, Infinity);
  assert.equal(s.getTierConfig('premium'), null, 'no visits value: not configured (was cap 0)');
  assert.equal(s.getTierConfig('gold'), null, 'switched off');
  assert.equal(s.getTierConfig('silver'), null, 'a fractional cap is not a usable setting');
  assert.equal(s.getTierConfig('online_free'), null, 'not in Settings');
  assert.ok(s.getTierConfig('executive'), 'configured for using a pass already held…');
  assert.equal(s.sellableTier('executive'), null, '…but not sold without a price');
  assert.deepEqual(s.sellableTierKeys(), ['basic', 'pro']);
  assert.equal(s.priceForTier('premium'), 0);
  assert.equal(s.priceForTier('online_free'), 0, 'no built-in price');
  assert.equal(s.visitCapForTier('pro'), null, 'unlimited');
  assert.equal(s.visitCapForTier('premium'), null);
  assert.deepEqual(s.publicTiers().map(t => t.key), ['basic', 'pro']);
});

test('a fresh install gets the same tiers as the start-up seed, and every one is sellable', () => {
  const platformSettings = memoryPlatformSettings(null);
  const s = createSettingsService({ platformSettings, auditLog: { async insertAsync() {} } });
  assert.deepEqual(s.ensureDefaultSettings().subscriptionTiers, DEFAULT_SUBSCRIPTION_TIERS.map(t => ({ ...t })));
  assert.deepEqual(s.sellableTierKeys(), ['basic', 'pro', 'premium', 'executive']);
});

test('the live seed tiers (30k/60k/100k/200k, 12/30/30/30) all stay sellable: nothing changes in practice', () => {
  assert.deepEqual(
    DEFAULT_SUBSCRIPTION_TIERS.map(t => [t.key, t.monthlyPrice, t.visits, t.gymAccess]),
    [['basic', 30000, 12, 'standard'], ['pro', 60000, 30, 'midtier'], ['premium', 100000, 30, 'premium'], ['executive', 200000, 30, 'luxury_executive']],
  );
  const s = settingsWithTiers(DEFAULT_SUBSCRIPTION_TIERS);
  for (const t of DEFAULT_SUBSCRIPTION_TIERS) {
    const cfg = s.sellableTier(t.key);
    assert.ok(cfg, t.key);
    assert.equal(cfg.price, t.monthlyPrice);
    assert.equal(cfg.visitCap, t.visits);
  }
});

// ── GET /passes (legacy catalogue) ──

test('GET /passes reads Settings and lists only sellable tiers', () => {
  const { service } = subscriptionService([
    { key: 'basic', label: 'Basic', monthlyPrice: 30_000, visits: 12, gymAccess: 'standard' },
    { key: 'pro', label: 'Pro', monthlyPrice: 60_000, gymAccess: 'midtier' },                      // no visits
    { key: 'executive', label: 'Executive', monthlyPrice: 200_000, visits: -1, gymAccess: 'luxury_executive' },
    { key: 'online_free', label: 'Online', monthlyPrice: 5_000, visits: -1, gymAccess: 'online' },
  ]);
  const passes = service.listPasses();
  assert.deepEqual(passes.map(p => [p.id, p.price, p.visitCap, p.gymAccess]), [
    ['basic', 30_000, 12, 'standard'],
    ['executive', 200_000, null, 'luxury_executive'],
  ]);
  assert.equal(passes[0].key, 'basic');
  assert.equal(passes[0].monthlyPrice, 30_000);
  assert.equal(passes[0].label, 'Basic');
});

test('GET /passes is empty when Settings sells nothing', () => {
  assert.deepEqual(subscriptionService([]).service.listPasses(), []);
});

// ── subscribe ──

test('subscribe: a tier not sellable in Settings is refused with tier_not_available (409); nothing written', async () => {
  const { service, subscriptions, paymentRequests } = subscriptionService([
    { key: 'basic', label: 'Basic', monthlyPrice: 30_000, visits: 12, gymAccess: 'standard' },
    { key: 'pro', label: 'Pro', monthlyPrice: 60_000, gymAccess: 'midtier' },
    { key: 'premium', label: 'Premium', monthlyPrice: 0, visits: 30, gymAccess: 'premium' },
    { key: 'executive', label: 'Executive', monthlyPrice: 200_000, visits: 30, gymAccess: 'luxury_executive', active: false },
  ]);
  for (const tier of ['pro', 'premium', 'executive', 'gold', 'online_free']) {
    const out = await service.subscribe({ memberId: `m_${tier}`, tier, type: 'platform_pass' });
    assert.deepEqual([out.error, out.status], ['tier_not_available', 409], tier);
  }
  assert.equal((await service.subscribe({ memberId: 'm_none', type: 'platform_pass' })).error, 'invalid_tier');
  assert.equal(subscriptions.rows.length, 0);
  assert.equal(paymentRequests.rows.length, 0);
});

test('subscribe: a sellable tier is charged its Settings price', async () => {
  const { service } = subscriptionService(DEFAULT_SUBSCRIPTION_TIERS);
  const out = await service.subscribe({ memberId: 'm1', tier: 'premium', type: 'platform_pass' });
  assert.equal(out.status, 202);
  assert.equal(out.paymentRequest.amountTzs, 100_000);
  assert.equal(out.subscription.status, 'payment_pending');
});

// ── mobile money ──

test('mobile money: a pass request on a tier no longer sold is not sent to the phone', async () => {
  const paymentRequests = memStore([
    { id: 'pay_1', memberId: 'm1', subscriptionId: 'sub_1', tier: 'gold', amountTzs: 50_000, status: 'pending', provider: 'admin_approved', reference: null },
    { id: 'pay_2', memberId: 'm1', subscriptionId: 'sub_2', tier: 'basic', amountTzs: 30_000, status: 'pending', provider: 'admin_approved', reference: null },
  ]);
  const subscriptions = memStore([
    { id: 'sub_1', memberId: 'm1', type: 'platform_pass', tier: 'gold', status: 'payment_pending' },
    { id: 'sub_2', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'payment_pending' },
  ]);
  const sent = [];
  const client = { environment: 'sandbox', async initiatePayment(args) { sent.push(args); return { transactionId: 'tx_1' }; } };
  const settings = settingsWithTiers(DEFAULT_SUBSCRIPTION_TIERS);
  const svc = createMobileMoneyService({
    paymentRequests, subscriptions, adminPaymentService: {}, auditLog: { async insertAsync() {} },
    client, enabled: () => true, canSettle: () => true, tierSellable: settings.isTierSellable,
  });
  const refused = await svc.pay({ memberId: 'm1', paymentRequestId: 'pay_1', phone: '0712345678' });
  assert.deepEqual([refused.error, refused.status, refused.tier], ['tier_not_available', 409, 'gold']);
  assert.equal(sent.length, 0);
  assert.equal(paymentRequests.rows[0].provider, 'admin_approved', 'request untouched');
  const ok = await svc.pay({ memberId: 'm1', paymentRequestId: 'pay_2', phone: '0712345678' });
  assert.equal(ok.error, undefined);
  assert.equal(sent.length, 1);
});

// ── Security review M3: complete tier rows only ──

test('the live seed tiers all have a valid gymAccess', () => {
  for (const t of DEFAULT_SUBSCRIPTION_TIERS) assert.ok(PASS_GYM_ACCESS.includes(t.gymAccess), `${t.key}: ${t.gymAccess}`);
});

test('PUT /admin/settings refuses an incomplete tier row with 400, naming the tier and field; nothing is saved', async () => {
  const s = settingsWithTiers(DEFAULT_SUBSCRIPTION_TIERS);
  const good = DEFAULT_SUBSCRIPTION_TIERS.map(t => ({ ...t }));
  const cases = [
    [[{ ...good[0], monthlyPrice: 0 }], 'basic', 'monthlyPrice'],
    [[{ ...good[0], monthlyPrice: 1.5 }], 'basic', 'monthlyPrice'],
    [[{ ...good[0], monthlyPrice: undefined }], 'basic', 'monthlyPrice'],
    [[{ ...good[0], visits: undefined }], 'basic', 'visits'],
    [[{ ...good[0], visits: 0 }], 'basic', 'visits'],
    [[{ ...good[0], visits: -2 }], 'basic', 'visits'],
    [[good[0], { ...good[1], gymAccess: undefined }], 'pro', 'gymAccess'],
    [[good[0], { ...good[1], gymAccess: 'everything' }], 'pro', 'gymAccess'],
    [[good[0], { ...good[0] }], 'basic', 'key'],
    [[{ ...good[0], key: '' }], '#1', 'key'],
  ];
  for (const [rows, tier, field] of cases) {
    const out = await s.adminUpdate({ body: { subscriptionTiers: rows }, actorId: 'adm' });
    assert.deepEqual([out.error, out.status, out.tier, out.field], ['invalid_subscription_tier', 400, tier, field], JSON.stringify(rows));
  }
  assert.equal((await s.adminUpdate({ body: { subscriptionTiers: 'nope' }, actorId: 'adm' })).field, 'subscriptionTiers');
  assert.deepEqual(s.sellableTierKeys(), ['basic', 'pro', 'premium', 'executive'], 'unchanged');
  // A complete set is saved; other settings can still be saved on their own.
  const ok = await s.adminUpdate({ body: { subscriptionTiers: [{ ...good[0], visits: -1 }] }, actorId: 'adm' });
  assert.equal(ok.error, undefined);
  assert.deepEqual(s.sellableTierKeys(), ['basic']);
  assert.equal((await s.adminUpdate({ body: { paymentPeriodDays: 7 }, actorId: 'adm' })).paymentPeriodDays, 7);
});

test('the PUT /admin/settings route answers an incomplete tier with 400 and the problem', async () => {
  const out = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await adminUpdateSettings.onRequest({ user: { sub: 'adm' }, body: { subscriptionTiers: [{ key: 'basic', label: 'Basic', monthlyPrice: 30000, visits: 12 }] } }, out);
  assert.equal(out.statusCode, 400);
  assert.deepEqual([out.body.error, out.body.tier, out.body.field], ['invalid_subscription_tier', 'basic', 'gymAccess']);
});
