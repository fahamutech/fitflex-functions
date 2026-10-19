// Owner decision 2026-10-19: PUT /admin/settings may not remove, rename or switch off
// a pass tier that members still hold (active/pending/suspended pass, pending upgrade,
// corporate seats, active sponsored-pass benefit, current B2B pass entitlement).
// → 409 { error: 'tier_in_use', tier, holders } and nothing is saved. Editing a held
// tier's price / visits / gym access to other valid values still works.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSettingsService } from '../src/services/settings-service.mjs';
import { createTierHolders } from '../src/services/tier-holders.mjs';
import { memoryPlatformSettings, TEST_TIERS } from './fixtures/tier-settings.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { ensureInit } from '../functions/index.mjs';
import { adminUpdateSettings } from '../functions/admin-settings.mjs';

await ensureInit();

function service(held = {}) {
  const platformSettings = memoryPlatformSettings(TEST_TIERS);
  const asked = [];
  const s = createSettingsService({
    platformSettings, auditLog: { async insertAsync(r) { return r; } },
    tierHolders: async (key) => { asked.push(key); return held[key] ?? 0; },
  });
  return { s, asked, saved: () => platformSettings.rows[0].subscriptionTiers };
}
const tiers = () => TEST_TIERS.map(t => ({ ...t }));
const without = (key) => tiers().filter(t => t.key !== key);
const withRow = (key, patch) => tiers().map(t => (t.key === key ? { ...t, ...patch } : t));

test('removing a held tier is 409 tier_in_use with the holder count; nothing is saved', async () => {
  const { s, saved } = service({ pro: 3 });
  const before = JSON.stringify(saved());
  const out = await s.adminUpdate({ body: { subscriptionTiers: without('pro') }, actorId: 'adm' });
  assert.deepEqual(out, { error: 'tier_in_use', status: 409, tier: 'pro', holders: 3 });
  assert.equal(JSON.stringify(saved()), before);
});

test('renaming a held tier key is refused the same way', async () => {
  const { s } = service({ premium: 1 });
  const out = await s.adminUpdate({ body: { subscriptionTiers: withRow('premium', { key: 'premium_plus' }) }, actorId: 'adm' });
  assert.deepEqual(out, { error: 'tier_in_use', status: 409, tier: 'premium', holders: 1 });
});

test('switching off a held tier (active:false or enabled:false) is refused', async () => {
  for (const patch of [{ active: false }, { enabled: false }]) {
    const { s } = service({ basic: 2 });
    const out = await s.adminUpdate({ body: { subscriptionTiers: withRow('basic', patch) }, actorId: 'adm' });
    assert.deepEqual(out, { error: 'tier_in_use', status: 409, tier: 'basic', holders: 2 }, JSON.stringify(patch));
  }
});

test('an invalid price / visits / gymAccess on a held tier stays a 400 (checked first)', async () => {
  const { s } = service({ basic: 2 });
  for (const [patch, field] of [[{ monthlyPrice: 0 }, 'monthlyPrice'], [{ visits: 0 }, 'visits'], [{ gymAccess: 'x' }, 'gymAccess']]) {
    const out = await s.adminUpdate({ body: { subscriptionTiers: withRow('basic', patch) }, actorId: 'adm' });
    assert.deepEqual([out.error, out.status, out.tier, out.field], ['invalid_subscription_tier', 400, 'basic', field]);
  }
});

test('changing a held tier\'s price, visits, gym access and label to other valid values is saved', async () => {
  const { s, saved, asked } = service({ basic: 5, pro: 5, premium: 5, executive: 5 });
  const rows = withRow('basic', { monthlyPrice: 65_000, visits: -1, gymAccess: 'midtier', label: 'Basic+' });
  const out = await s.adminUpdate({ body: { subscriptionTiers: rows }, actorId: 'adm' });
  assert.equal(out.error, undefined);
  assert.deepEqual(saved().find(t => t.key === 'basic'), { key: 'basic', label: 'Basic+', monthlyPrice: 65_000, visits: -1, gymAccess: 'midtier' });
  assert.deepEqual(asked, [], 'no tier was taken away, so no holder lookup');
  // Reordering and adding a new tier is fine too.
  const more = [...[...rows].reverse(), { key: 'student', label: 'Student', monthlyPrice: 30_000, visits: 8, gymAccess: 'standard' }];
  assert.equal((await s.adminUpdate({ body: { subscriptionTiers: more }, actorId: 'adm' })).error, undefined);
});

test('a tier nobody holds can be removed or switched off', async () => {
  const { s, saved, asked } = service({});
  assert.equal((await s.adminUpdate({ body: { subscriptionTiers: without('executive') }, actorId: 'adm' })).error, undefined);
  assert.deepEqual(asked, ['executive']);
  assert.equal(saved().some(t => t.key === 'executive'), false);
  // Already switched off and held: saving again unchanged is not blocked (it is not being taken away now).
  const pro = { ...TEST_TIERS[1], active: false };
  const off = createSettingsService({
    platformSettings: memoryPlatformSettings([TEST_TIERS[0], pro]), auditLog: { async insertAsync(r) { return r; } },
    tierHolders: async () => 4,
  });
  assert.equal((await off.adminUpdate({ body: { subscriptionTiers: [TEST_TIERS[0], pro] }, actorId: 'adm' })).error, undefined);
});

// ── Database: what counts as holding a tier ──────────────────────────────────

const made = [];
after(async () => {
  for (const [table, id] of made.reverse()) await db(table).where({ id }).del();
});
// B2B ledger rows (entitlements) can never be deleted, and they pin their benefit, programme and
// organisation: those are left in the throwaway CI database under a one-off tier key.
const KEEP = new Set(['B2BOrganization', 'B2BWellnessProgram', 'B2BBenefit', 'B2BPassEntitlement']);
const put = async (table, row) => { await db(table).insert(row); if (!KEEP.has(table)) made.push([table, row.id]); return row; };

test('db: tierHolders counts held passes, pending upgrades, corporate seats, sponsored passes and current entitlements', async () => {
  const tag = randomUUID().slice(0, 8);
  const key = `tst_${tag}`;
  const count = createTierHolders({ db, now: () => new Date('2026-10-19T09:00:00Z') });
  const n = () => count(key);
  assert.equal(await n(), 0);

  const now = new Date();
  const member = await put('User', { id: `u_tiu_${tag}`, userType: 'member', displayName: 'TIU', updatedAt: now });
  const sub = (status, i) => put('Subscription', { id: `sub_tiu_${tag}_${i}`, memberId: member.id, type: 'platform_pass', tier: key, status,
    startedAt: now, cycleStartedAt: now, renewsAt: now, expiresAt: now });
  await sub('active', 1);
  await sub('payment_pending', 2);
  await sub('suspended', 3);
  assert.equal(await n(), 3);
  await sub('expired', 4);
  await sub('payment_rejected', 5);
  await sub('cancelled', 6);
  assert.equal(await n(), 3, 'ended or refused passes do not hold the tier');

  // A pending upgrade to the tier (from another tier's pass).
  await put('PaymentRequest', { id: `pr_tiu_${tag}_1`, memberId: member.id, tier: key, amountTzs: 1_000, status: 'pending', provider: 'admin_approved', note: `upgrade:sub_x:basic` });
  await put('PaymentRequest', { id: `pr_tiu_${tag}_2`, memberId: member.id, tier: key, amountTzs: 1_000, status: 'rejected', provider: 'admin_approved', note: `upgrade:sub_x:basic` });
  assert.equal(await n(), 4);

  // Corporate seats.
  const corp = { companyName: 'TIU Ltd', industrySector: 'tech', workforceBracket: '1-50', subsidyModel: 'full', passTier: key };
  await put('CorporateAccount', { id: `corp_tiu_${tag}_1`, ...corp, status: 'active' });
  await put('CorporateAccount', { id: `corp_tiu_${tag}_2`, ...corp, status: 'terminated' });
  assert.equal(await n(), 5);

  // B2B sponsored pass: active benefit + an entitlement for this month or later.
  const org = await put('B2BOrganization', { id: `org_tiu_${tag}`, organizationType: 'employer', legalName: 'TIU Org' });
  const prog = await put('B2BWellnessProgram', { id: `prog_tiu_${tag}`, organizationId: org.id, name: 'TIU', startDate: '2026-10-01', eligibility: JSON.stringify({}) });
  const benefit = (id, status) => put('B2BBenefit', { id, programId: prog.id, name: 'Pass', benefitType: 'sponsored_pass', fundingType: 'full',
    usagePeriod: 'month', providerRules: JSON.stringify({}), passTier: key, status });
  const b1 = await benefit(`ben_tiu_${tag}_1`, 'active');
  await benefit(`ben_tiu_${tag}_2`, 'inactive');
  assert.equal(await n(), 6);
  const ent = (i, period, status) => put('B2BPassEntitlement', { id: `ent_tiu_${tag}_${i}`, organizationId: org.id, programId: prog.id, benefitId: b1.id,
    beneficiaryId: `bf_${i}`, beneficiarySource: 'b2b', period, passTier: key, listPriceTzs: 60_000, feeTzs: 60_000, sponsorTzs: 60_000, memberTzs: 0, status });
  await ent(1, '2026-10', 'invoiced');
  await ent(2, '2026-11', 'scheduled');
  await ent(3, '2026-09', 'invoiced');
  await ent(4, '2026-10', 'void');
  assert.equal(await n(), 8, 'past months and void entitlements do not hold the tier');
});

test('db + route: PUT /admin/settings removing a held tier answers 409 tier_in_use and saves nothing', async () => {
  const row = await db('PlatformSettings').where({ id: 'platform' }).first();
  const current = typeof row.subscriptionTiers === 'string' ? JSON.parse(row.subscriptionTiers) : row.subscriptionTiers;
  const target = current.find(t => t.key && t.active !== false && t.enabled !== false);
  assert.ok(target, 'the seeded settings have a tier on sale');
  const tag = randomUUID().slice(0, 8);
  const now = new Date();
  await put('User', { id: `u_tiu_r_${tag}`, userType: 'member', displayName: 'TIU route', updatedAt: now });
  await put('Subscription', { id: `sub_tiu_r_${tag}`, memberId: `u_tiu_r_${tag}`, type: 'platform_pass', tier: target.key, status: 'active',
    startedAt: now, cycleStartedAt: now, renewsAt: now, expiresAt: now });

  let code = 200; let body;
  const res = { status(c) { code = c; return res; }, json(b) { body = b; return res; } };
  await adminUpdateSettings.onRequest({ user: { sub: 'adm' }, body: { subscriptionTiers: current.filter(t => t.key !== target.key) } }, res);
  assert.equal(code, 409);
  assert.equal(body.error, 'tier_in_use');
  assert.equal(body.tier, target.key);
  assert.ok(body.holders >= 1);
  assert.equal(body.status, undefined);
  const afterRow = await db('PlatformSettings').where({ id: 'platform' }).first();
  assert.deepEqual(afterRow.subscriptionTiers, row.subscriptionTiers);
});
