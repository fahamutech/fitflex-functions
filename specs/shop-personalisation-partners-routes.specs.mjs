// Partner DOB · slice 4 against the CI database: GET /shop/preferences and GET /shop/home in trainer and
// owner mode read the Person's own declared date of birth and gender (Person.dateOfBirth / Person.gender,
// migration 20270110091000) and TrainerProfile.gender, only with SHOP_PERSONALISATION_PARTNERS on.
// Contract: docs/shop-personalisation-api.md "Trainer and owner mode".
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { getShopPreferences, putShopPreferences, resetPreferenceLimits } from '../functions/shop-preferences.mjs';
import { shopHome, resetShopHomeLimits } from '../functions/shop-home.mjs';
import { shopHomeService } from '../src/bootstrap/services.mjs';
import { trainers } from '../src/bootstrap/collections.mjs';
import { eatToday } from '../src/shared/date-of-birth.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], persons: [], products: [], orders: [], trainers: [] };
const ENV = ['SHOP_HOME_V2', 'SHOP_HOME_MIN_ITEMS', 'SHOP_HOME_CACHE_SECONDS', 'SHOP_HOME_SECTIONS', 'SHOP_PERSONALISATION', 'SHOP_PERSONALISATION_PARTNERS'];
const PERSONAL_SIGNALS = ['purchase_history', 'profile_gender', 'profile_age'];

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(route, claims, { query = {}, body = {} } = {}) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params: {}, query, body, get: () => null };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}
async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Partners ${userType}`, accountStatus: 'active', approvalStatus: 'approved', updatedAt: new Date(), ...extra });
  made.users.push(id);
  const row = await db('User').where({ id }).first('personId');
  if (row.personId && !extra.personId) made.persons.push(row.personId);
  return { id, personId: row.personId };
}
/** Sets the Person's declared date of birth and gender directly (as PUT /me/personal-details would). */
const declare = (personId, { dateOfBirth = null, gender = null }) => db('Person').where({ id: personId }).update({ dateOfBirth, gender, declaredProfileUpdatedAt: new Date(), updatedAt: new Date() });
async function trainerProfile(userId, gender) {
  const id = uid('trp');
  await trainers.insertAsync({ id, userId, displayName: 'Partners trainer', status: 'active', gender, specialties: [], gymIds: [] });
  made.trainers.push(id);
}
const old = new Date('2026-01-01T00:00:00Z'); // vendors created before KYC enforcement: exempt
async function product(vendorId, extra = {}) {
  const id = uid('prd');
  await db('Product').insert({ id, vendorId, name: 'Partners test', category: 'equipment', priceTzs: 20_000, stock: 4, status: 'active', approvalStatus: 'approved', updatedAt: new Date(), ...extra });
  made.products.push(id);
  return id;
}
async function shopOrder(buyerId, items) {
  const id = uid('ord');
  await db('ShopOrder').insert({ id, buyerId, buyerRole: 'trainer', items: JSON.stringify(items), totalTzs: 20_000, status: 'delivered', paymentStatus: 'paid', createdAt: new Date(Date.now() - 5 * 86_400_000), updatedAt: new Date() });
  made.orders.push(id);
}
function yearsAgo(n) {
  const [y, m, d] = eatToday().split('-').map(Number);
  const dt = new Date(Date.UTC(y - n, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) dt.setUTCDate(0);
  return dt.toISOString().slice(0, 10);
}
const as = (u, userType) => ({ sub: u.id, userType });
const prefs = async (claims, mode) => (await call(getShopPreferences, claims, { query: mode ? { mode } : {} })).body;
async function home(claims, mode) {
  shopHomeService.clearCache();
  const out = await call(shopHome, claims, { query: mode ? { mode } : {} });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  return out.body;
}

beforeEach(() => {
  process.env.SHOP_HOME_V2 = '1';
  process.env.SHOP_HOME_MIN_ITEMS = '1';
  process.env.SHOP_HOME_CACHE_SECONDS = '1';
  process.env.SHOP_HOME_SECTIONS = 'recommended';
  process.env.SHOP_PERSONALISATION = '1';
  delete process.env.SHOP_PERSONALISATION_PARTNERS;
  shopHomeService.clearCache();
  resetShopHomeLimits();
  resetPreferenceLimits();
});
after(async () => {
  for (const k of ENV) delete process.env[k];
  const keys = [...made.persons, ...made.users];
  await db('AuditLog').whereIn('target', keys).del();
  await db('ShopPreference').whereIn('personId', keys).del();
  await db('ShopOrder').whereIn('id', made.orders).del();
  await db('Product').whereIn('id', made.products).del();
  for (const id of made.trainers) await trainers.removeAsync(t => t.id === id);
  await db('User').whereIn('id', made.users).del();
  if (made.persons.length) await db('Person').whereIn('id', made.persons).del();
  await db.destroy();
});

test('flag off: a trainer-only and an owner-only account are not available (as before), even with an adult Person date of birth', async () => {
  const t = await user('trainer');
  await declare(t.personId, { dateOfBirth: yearsAgo(30), gender: 'female' });
  const o = await user('gym_operator');
  await declare(o.personId, { dateOfBirth: yearsAgo(30), gender: 'male' });
  for (const [claims, mode] of [[as(t, 'trainer'), 'trainer'], [as(o, 'gym_operator'), 'owner']]) {
    assert.deepEqual(await prefs(claims), { personalised: true, available: false, historyDays: 365, mode, uses: [] });
    const body = await home(claims);
    assert.deepEqual(body.personalisation, { available: false, enabled: false });
    assert.ok(!body.signalsUsed.some(x => PERSONAL_SIGNALS.includes(x)));
  }
  // SHOP_PERSONALISATION_PARTNERS on without SHOP_PERSONALISATION: still nothing.
  delete process.env.SHOP_PERSONALISATION;
  process.env.SHOP_PERSONALISATION_PARTNERS = '1';
  assert.deepEqual(await prefs(as(t, 'trainer')), { personalised: true, available: false, historyDays: 365, mode: 'trainer', uses: [] });
  assert.ok(!('personalisation' in (await home(as(t, 'trainer')))));
});

test('trainer-only, flag on: Person date of birth from the database; TrainerProfile.gender NULL falls back to Person.gender; reorder only', async () => {
  process.env.SHOP_PERSONALISATION_PARTNERS = '1';
  const vendor = await user('vendor', { createdAt: old });
  const plain = await product(vendor.id, { category: 'accessories_gear', createdAt: new Date(Date.now() - 1000) });
  const forHer = await product(vendor.id, { category: 'accessories_gear', targetGender: 'women', targetAgeBands: ['30_44'], createdAt: new Date(Date.now() - 60_000) });
  const t = await user('trainer');
  await trainerProfile(t.id, null);
  await declare(t.personId, { dateOfBirth: yearsAgo(35), gender: 'female' });
  assert.deepEqual(await prefs(as(t, 'trainer')), { personalised: true, available: true, historyDays: 365, mode: 'trainer', uses: ['purchase_history', 'profile_gender', 'profile_age'], profileSignals: true });
  const on = await home(as(t, 'trainer'));
  assert.deepEqual(on.personalisation, { available: true, enabled: true });
  const rec = on.sections.find(s => s.key === 'recommended');
  assert.ok(rec.productIds.indexOf(forHer) >= 0 && rec.productIds.indexOf(forHer) < rec.productIds.indexOf(plain), 'the tagged product moved ahead');
  assert.ok(rec.reasonCodes.includes('profile_gender') && rec.reasonCodes.includes('profile_age'));
  // Same products as the flag-off page; only the order differs.
  delete process.env.SHOP_PERSONALISATION_PARTNERS;
  const off = await home(as(t, 'trainer'));
  assert.deepEqual([...rec.productIds].sort(), [...off.sections.find(s => s.key === 'recommended').productIds].sort());
  assert.deepEqual(rec.title, off.sections.find(s => s.key === 'recommended').title);
});

test('trainer-only: TrainerProfile.gender wins over Person.gender; "other" gives no gender signal', async () => {
  process.env.SHOP_PERSONALISATION_PARTNERS = '1';
  const t = await user('trainer');
  await trainerProfile(t.id, 'other');
  await declare(t.personId, { dateOfBirth: yearsAgo(40), gender: 'female' });
  assert.deepEqual((await prefs(as(t, 'trainer'))).uses, ['purchase_history', 'profile_age']);
});

test('owner-only: no date of birth → purchase history only; invalid (future) and under 18 → nothing; adult with gender NULL → age only', async () => {
  process.env.SHOP_PERSONALISATION_PARTNERS = '1';
  const vendor = await user('vendor', { createdAt: old });
  const p1 = await product(vendor.id, { category: 'equipment' });
  await product(vendor.id, { category: 'health_recovery' });
  const o = await user('gym_operator');
  await shopOrder(o.id, [{ productId: p1, name: 'Rack', qty: 1 }]);
  const claims = as(o, 'gym_operator');

  await declare(o.personId, { dateOfBirth: null, gender: 'female' });
  assert.deepEqual((await prefs(claims)).uses, ['purchase_history'], 'no date of birth: never gender (even though one is declared) or age');
  const noDob = await home(claims);
  assert.deepEqual(noDob.personalisation, { available: true, enabled: true });
  assert.ok(!noDob.signalsUsed.includes('profile_gender') && !noDob.signalsUsed.includes('profile_age'));

  // A date in the future cannot be saved through the API (strict parser), but the column allows it: fail closed.
  const future = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
  for (const dob of [future, yearsAgo(17)]) {
    await declare(o.personId, { dateOfBirth: dob, gender: 'female' });
    assert.deepEqual(await prefs(claims), { personalised: true, available: false, historyDays: 365, mode: 'owner', uses: [], profileSignals: true }, dob);
    const body = await home(claims);
    assert.deepEqual(body.personalisation, { available: false, enabled: false });
    assert.ok(!body.signalsUsed.some(x => PERSONAL_SIGNALS.includes(x)));
  }

  await declare(o.personId, { dateOfBirth: yearsAgo(50), gender: null });
  assert.deepEqual((await prefs(claims)).uses, ['purchase_history', 'profile_age']);
});

test('M1 (CI DB): Person adult + member persona under 18 → nothing in every mode, member mode included; flag off member mode as before', async () => {
  process.env.SHOP_PERSONALISATION_PARTNERS = '1';
  const m = await user('member', { memberProfile: JSON.stringify({ gender: 'male', dateOfBirth: yearsAgo(16) }) });
  const t = await user('trainer', { personId: m.personId });
  await user('gym_operator', { personId: m.personId });
  await trainerProfile(t.id, 'female');
  await declare(m.personId, { dateOfBirth: yearsAgo(30), gender: null });
  for (const mode of ['member', 'trainer', 'owner']) {
    const body = await prefs(as(m, 'member'), mode);
    assert.deepEqual([body.available, body.uses], [false, []], mode);
    assert.deepEqual((await home(as(t, 'trainer'), mode)).personalisation, { available: false, enabled: false }, mode);
  }
  delete process.env.SHOP_PERSONALISATION_PARTNERS;
  assert.deepEqual(await prefs(as(m, 'member'), 'member'), { personalised: true, available: false, historyDays: 365, mode: 'member', uses: [] });
});

test('M1 (CI DB): Person under 18 + member persona adult → nothing in every mode while the flag is on; flag off member mode is available as before', async () => {
  process.env.SHOP_PERSONALISATION_PARTNERS = '1';
  const m = await user('member', { memberProfile: JSON.stringify({ gender: 'female', dateOfBirth: yearsAgo(30) }) });
  await user('trainer', { personId: m.personId });
  await declare(m.personId, { dateOfBirth: yearsAgo(17), gender: 'female' });
  for (const mode of ['member', 'trainer']) assert.deepEqual((await prefs(as(m, 'member'), mode)).uses, [], mode);
  assert.equal((await prefs(as(m, 'member'), 'member')).available, false);
  delete process.env.SHOP_PERSONALISATION_PARTNERS;
  const off = await prefs(as(m, 'member'), 'member');
  assert.deepEqual([off.available, off.uses.slice(0, 3)], [true, ['purchase_history', 'profile_gender', 'profile_age']]);
  assert.ok(!('profileSignals' in off));
});

test('M1 (CI DB): a suspended member persona under 18 blocks the trainer', async () => {
  process.env.SHOP_PERSONALISATION_PARTNERS = '1';
  const t = await user('trainer');
  await declare(t.personId, { dateOfBirth: yearsAgo(30), gender: 'male' });
  assert.equal((await prefs(as(t, 'trainer'))).available, true);
  await user('member', { personId: t.personId, accountStatus: 'suspended', memberProfile: JSON.stringify({ dateOfBirth: yearsAgo(15) }) });
  assert.deepEqual(await prefs(as(t, 'trainer')), { personalised: true, available: false, historyDays: 365, mode: 'trainer', uses: [], profileSignals: true });
});

test('member + trainer + owner, all adult: member mode keeps the member profile; trainer/owner use the Person; one opt-out for all', async () => {
  process.env.SHOP_PERSONALISATION_PARTNERS = '1';
  const m = await user('member', { memberProfile: JSON.stringify({ gender: 'male', dateOfBirth: yearsAgo(40) }) });
  const t = await user('trainer', { personId: m.personId });
  const o = await user('gym_operator', { personId: m.personId });
  await trainerProfile(t.id, 'female');
  await declare(m.personId, { dateOfBirth: yearsAgo(30), gender: null });
  const member = await prefs(as(m, 'member'), 'member');
  assert.deepEqual(member.uses, ['purchase_history', 'profile_gender', 'profile_age']);
  assert.ok(!('profileSignals' in member), 'not in member mode');
  // Trainer mode: trainer profile gender (female). Owner mode: Person gender NULL → age only.
  assert.deepEqual((await prefs(as(m, 'member'), 'trainer')).uses, ['purchase_history', 'profile_gender', 'profile_age']);
  assert.deepEqual((await prefs(as(t, 'trainer'), 'owner')).uses, ['purchase_history', 'profile_age']);
  // One switch per Person: off from owner mode → off in every mode.
  const put = await call(putShopPreferences, as(o, 'gym_operator'), { body: { personalised: false, source: 'privacy_page' } });
  assert.equal(put.statusCode, 200, JSON.stringify(put.body));
  assert.deepEqual([put.body.personalised, put.body.available, put.body.uses, put.body.profileSignals], [false, true, [], true]);
  for (const mode of ['member', 'trainer', 'owner']) assert.deepEqual((await prefs(as(t, 'trainer'), mode)).uses, [], mode);
  assert.equal((await db('ShopPreference').where({ personId: m.personId })).length, 1);
});

test('L2 (CI DB): /shop/home with a mode the person does not hold is 403 mode_not_allowed', async () => {
  process.env.SHOP_PERSONALISATION_PARTNERS = '1';
  const t = await user('trainer');
  shopHomeService.clearCache();
  const out = await call(shopHome, as(t, 'trainer'), { query: { mode: 'owner' } });
  assert.deepEqual([out.statusCode, out.body], [403, { error: 'mode_not_allowed' }]);
});
