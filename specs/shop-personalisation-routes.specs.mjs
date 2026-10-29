// Shop personalisation (Phase 2 · slice 2) against the CI database: /shop/preferences with its
// audit, the vendor product target fields, the admin filters, buyer rows, and /shop/home reading
// purchase history with the real query.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { getShopPreferences, putShopPreferences, allowPreferenceSave, resetPreferenceLimits, SHOP_PREFERENCE_LIMIT } from '../functions/shop-preferences.mjs';
import { shopHome, resetShopHomeLimits } from '../functions/shop-home.mjs';
import {
  vendorCreateProduct, vendorUpdateProduct, vendorMyProducts, vendorDuplicateProduct, adminListProducts, adminCreateProduct,
  adminUpdateProductListing, listShopProducts, getShopProduct, vendorToolsOptionsRoute,
} from '../functions/shop.mjs';
import { shopHomeService, identityLinkService, accountService } from '../src/bootstrap/services.mjs';
import { updateMemberProfile } from '../functions/subscriptions.mjs';
import { adminUpsertMember } from '../functions/admin-members.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
// The switch and availability only (the body also carries historyDays and uses).
const pa = body => ({ personalised: body.personalised, available: body.available });
const made = { users: [], products: [], persons: [], orders: [], linked: [] };
function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(route, claims, { query = {}, body = {}, params = {} } = {}) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params, query, body, get: () => null };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}
async function person() {
  const id = uid('per');
  await db('Person').insert({ id, updatedAt: new Date() });
  made.persons.push(id);
  return id;
}
async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Personalisation ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
const old = new Date('2026-01-01T00:00:00Z'); // vendors created before KYC enforcement: exempt
async function product(vendorId, extra = {}) {
  const id = uid('prd');
  await db('Product').insert({ id, vendorId, name: 'Personalisation test', category: 'equipment', priceTzs: 20_000, stock: 4, status: 'active', approvalStatus: 'approved', updatedAt: new Date(), ...extra });
  made.products.push(id);
  return id;
}
async function shopOrder(buyerId, items, extra = {}) {
  const id = uid('ord');
  await db('ShopOrder').insert({ id, buyerId, buyerRole: 'member', items: JSON.stringify(items), totalTzs: 20_000, status: 'delivered', paymentStatus: 'paid', createdAt: new Date(Date.now() - 5 * 86_400_000), updatedAt: new Date(), ...extra });
  made.orders.push(id);
  return id;
}
const member = (profile = {}, extra = {}) => user('member', { memberProfile: JSON.stringify({ gender: 'female', dateOfBirth: '1990-04-01', ...profile }), ...extra });
const asMember = id => ({ sub: id, userType: 'member' });

beforeEach(() => {
  process.env.SHOP_HOME_V2 = '1';
  process.env.SHOP_HOME_MIN_ITEMS = '1';
  process.env.SHOP_HOME_CACHE_SECONDS = '1';
  delete process.env.SHOP_PERSONALISATION;
  delete process.env.SHOP_HOME_SECTIONS;
  shopHomeService.clearCache();
  resetShopHomeLimits();
  resetPreferenceLimits();
});
after(async () => {
  for (const k of ['SHOP_HOME_V2', 'SHOP_HOME_MIN_ITEMS', 'SHOP_HOME_CACHE_SECONDS', 'SHOP_HOME_SECTIONS', 'SHOP_PERSONALISATION']) delete process.env[k];
  const keys = [...made.persons, ...made.users];
  await db('AuditLog').whereIn('target', [...keys, ...made.products]).del();
  await db('ShopPreference').whereIn('personId', keys).del();
  await db('ShopOrder').whereIn('id', made.orders).del();
  await db('Product').whereIn('id', made.products).del();
  await db('User').whereIn('id', made.users).del();
  if (made.persons.length) await db('Person').whereIn('id', made.persons).del();
  // Persons of the link specs stay (IdentityEvent is append-only, as in identity-i2-linking.specs.mjs);
  // their ShopPreference rows and audit rows are removed.
  await db('ShopPreference').whereIn('personId', made.linked).del();
  await db('AuditLog').whereIn('target', made.linked).del();
  await db.destroy();
});

// ── /shop/preferences ───────────────────────────────────────────────────────

test('preferences: flag off — GET says available false, PUT is 404 feature_disabled; signed out is 401', async () => {
  const m = await member();
  const get = await call(getShopPreferences, asMember(m));
  assert.equal(get.statusCode, 200);
  assert.deepEqual(pa(get.body), { personalised: true, available: false });
  const put = await call(putShopPreferences, asMember(m), { body: { personalised: false, source: 'why_sheet' } });
  assert.equal(put.statusCode, 404);
  assert.deepEqual(put.body, { error: 'feature_disabled' });
  assert.equal(await db('ShopPreference').where({ personId: m }).first(), undefined);
  process.env.SHOP_PERSONALISATION = '1';
  assert.equal((await call(getShopPreferences, null)).statusCode, 401);
  assert.equal((await call(putShopPreferences, null, { body: { personalised: false, source: 'why_sheet' } })).statusCode, 401);
});

test('preferences: on by default; a change is saved per Person, shared by every role, audited once', async () => {
  process.env.SHOP_PERSONALISATION = '1';
  const per = await person();
  const m = await member({}, { personId: per });
  const owner = await user('gym_operator', { personId: per });
  assert.deepEqual(pa((await call(getShopPreferences, asMember(m))).body), { personalised: true, available: true });
  const put = await call(putShopPreferences, asMember(m), { body: { personalised: false, source: 'why_sheet' } });
  assert.equal(put.statusCode, 200, JSON.stringify(put.body));
  assert.deepEqual(pa(put.body), { personalised: false, available: true });
  const row = await db('ShopPreference').where({ personId: per }).first();
  assert.deepEqual([row.subjectType, row.personalised, row.source, row.updatedBy], ['person', false, 'why_sheet', m]);
  // Another role of the same person sees the same switch, and it is still off on reload.
  assert.deepEqual(pa((await call(getShopPreferences, { sub: owner, userType: 'gym_operator' })).body), { personalised: false, available: true });
  // Same value again: nothing new written.
  await call(putShopPreferences, { sub: owner, userType: 'gym_operator' }, { body: { personalised: false, source: 'privacy_page' } });
  let audit = await db('AuditLog').where({ target: per, action: 'shop_preference_changed' }).orderBy('at');
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].actor, audit[0].before, audit[0].after], [m, { personalised: true }, { personalised: false, source: 'why_sheet' }]);
  // Back on from the Privacy page, by the owner persona.
  await call(putShopPreferences, { sub: owner, userType: 'gym_operator' }, { body: { personalised: true, source: 'privacy_page' } });
  audit = await db('AuditLog').where({ target: per, action: 'shop_preference_changed' }).orderBy('at');
  assert.deepEqual(audit.map(a => [a.actor, a.after.personalised, a.after.source]), [[m, false, 'why_sheet'], [owner, true, 'privacy_page']]);
  assert.equal((await db('ShopPreference').where({ personId: per }).first()).source, 'privacy_page');
});

test('preferences: every new account gets a Person (identity trigger), so the row is keyed by it', async () => {
  // The user-id fallback (subjectType 'user') is covered in shop-personalisation.specs.mjs: the
  // database gives every new User a Person, so it cannot be built here.
  process.env.SHOP_PERSONALISATION = '1';
  const m = await member();
  const { personId } = await db('User').where({ id: m }).first();
  made.persons.push(personId);
  await call(putShopPreferences, asMember(m), { body: { personalised: false, source: 'privacy_page' } });
  const row = await db('ShopPreference').where({ personId }).first();
  assert.deepEqual([row.subjectType, row.personalised], ['person', false]);
});

test('preferences: validation, availability (under 18, no member persona) and the per-user save limit', async () => {
  process.env.SHOP_PERSONALISATION = '1';
  const m = await member();
  for (const [body, field] of [[{ source: 'why_sheet' }, 'personalised'], [{ personalised: 'false', source: 'why_sheet' }, 'personalised'], [{ personalised: false }, 'source'], [{ personalised: false, source: 'admin' }, 'source']]) {
    const out = await call(putShopPreferences, asMember(m), { body });
    assert.equal(out.statusCode, 400, JSON.stringify(body));
    assert.equal(out.body.error, 'invalid_field');
    assert.equal(out.body.field, field);
  }
  assert.deepEqual((await call(putShopPreferences, asMember(m), { body: { personalised: false, source: 'x' } })).body.allowed, ['privacy_page', 'why_sheet']);
  const kid = await member({ dateOfBirth: '2011-01-01' });
  assert.deepEqual(pa((await call(getShopPreferences, asMember(kid))).body), { personalised: true, available: false });
  const noDob = await user('member', { memberProfile: JSON.stringify({ gender: 'male' }) });
  assert.equal((await call(getShopPreferences, asMember(noDob))).body.available, true);
  const trainer = await user('trainer');
  assert.deepEqual(pa((await call(getShopPreferences, { sub: trainer, userType: 'trainer' })).body), { personalised: true, available: false });
  // Limit.
  const fresh = await member();
  const t = Date.now();
  for (let i = 0; i < SHOP_PREFERENCE_LIMIT.perMinute; i += 1) assert.equal(allowPreferenceSave(fresh, t), true);
  assert.equal(allowPreferenceSave(fresh, t + 60_001), true, 'a new minute starts again');
  resetPreferenceLimits();
  for (let i = 0; i < SHOP_PREFERENCE_LIMIT.perMinute; i += 1) allowPreferenceSave(m);
  const limited = await call(putShopPreferences, asMember(m), { body: { personalised: true, source: 'why_sheet' } });
  assert.equal(limited.statusCode, 429);
  assert.deepEqual(limited.body, { error: 'rate_limited' });
});

// ── product target fields ───────────────────────────────────────────────────

test('vendor product: target fields are stored, validated, not reviewed, on the vendor\'s rows only', async () => {
  const vendor = await user('vendor', { createdAt: old });
  const v = { sub: vendor, userType: 'vendor' };
  const created = await call(vendorCreateProduct, v, { body: { name: 'Women\'s tights', category: 'sportswear_footwear', priceTzs: 30_000, stock: 5, targetGender: 'women', targetAgeBands: ['45_59', '18_29'] } });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  made.products.push(created.body.id);
  assert.deepEqual([created.body.targetGender, created.body.targetAgeBands], ['women', ['18_29', '45_59']]);
  const plain = await call(vendorCreateProduct, v, { body: { name: 'Mat', category: 'accessories_gear', priceTzs: 10_000, stock: 5 } });
  made.products.push(plain.body.id);
  assert.deepEqual([plain.body.targetGender, plain.body.targetAgeBands], [null, []]);

  for (const [body, field] of [[{ targetGender: 'female' }, 'targetGender'], [{ targetGender: 'everyone' }, 'targetGender'], [{ targetAgeBands: ['kids'] }, 'targetAgeBands'], [{ targetAgeBands: '18_29' }, 'targetAgeBands'], [{ targetAgeBands: ['30_44', '30_44'] }, 'targetAgeBands']]) {
    const bad = await call(vendorCreateProduct, v, { body: { name: 'Bad', priceTzs: 1_000, ...body } });
    assert.equal(bad.statusCode, 400, JSON.stringify(body));
    assert.deepEqual([bad.body.error, bad.body.field], ['invalid_field', field]);
    assert.ok(Array.isArray(bad.body.allowed));
    const badUpdate = await call(vendorUpdateProduct, v, { params: { id: created.body.id }, body });
    assert.equal(badUpdate.statusCode, 400);
  }
  // An approved product stays approved when only the tags change.
  await db('Product').where({ id: created.body.id }).update({ approvalStatus: 'approved' });
  const updated = await call(vendorUpdateProduct, v, { params: { id: created.body.id }, body: { targetGender: 'men', targetAgeBands: [] } });
  assert.equal(updated.statusCode, 200, JSON.stringify(updated.body));
  const row = await db('Product').where({ id: created.body.id }).first();
  assert.deepEqual([row.approvalStatus, row.targetGender, row.targetAgeBands], ['approved', 'men', []]);
  // Leaving them out keeps them; null clears gender.
  await call(vendorUpdateProduct, v, { params: { id: created.body.id }, body: { stock: 6 } });
  assert.equal((await db('Product').where({ id: created.body.id }).first()).targetGender, 'men');
  await call(vendorUpdateProduct, v, { params: { id: created.body.id }, body: { targetGender: null, targetAgeBands: ['60_plus'] } });
  const cleared = await db('Product').where({ id: created.body.id }).first();
  assert.deepEqual([cleared.targetGender, cleared.targetAgeBands], [null, ['60_plus']]);
  // The database refuses bad values too.
  await assert.rejects(db('Product').where({ id: created.body.id }).update({ targetGender: 'female' }));
  await assert.rejects(db.raw('UPDATE "Product" SET "targetAgeBands" = ARRAY[\'kids\']::text[] WHERE id = ?', [created.body.id]));

  const mine = await call(vendorMyProducts, v);
  const listed = mine.body.find(p => p.id === created.body.id);
  assert.deepEqual([listed.targetGender, listed.targetAgeBands], [null, ['60_plus']]);
  const copy = await call(vendorDuplicateProduct, v, { params: { id: created.body.id } });
  made.products.push(copy.body.id);
  assert.deepEqual(copy.body.targetAgeBands, ['60_plus'], 'duplicate copies the tags');

  // Buyer rows never carry them.
  const list = await call(listShopProducts, asMember(await member()), { query: {} });
  const buyerRow = list.body.find(p => p.id === created.body.id);
  assert.ok(buyerRow, 'listed for buyers');
  assert.ok(!('targetGender' in buyerRow) && !('targetAgeBands' in buyerRow));
  const detail = await call(getShopProduct, asMember(await member()), { params: { id: created.body.id } });
  assert.equal(detail.statusCode, 200, JSON.stringify(detail.body));
  assert.ok(!('targetGender' in detail.body) && !('targetAgeBands' in detail.body));
  for (const similar of detail.body.similarProducts || []) assert.ok(!('targetGender' in similar));
});

test('admin: tags are read-only on GET /admin/products with filters; admin create and listing update ignore them', async () => {
  const vendor = await user('vendor', { createdAt: old });
  const w = await product(vendor, { targetGender: 'women', targetAgeBands: ['30_44'] });
  const m = await product(vendor, { targetGender: 'men', targetAgeBands: ['60_plus'] });
  const e = await product(vendor);
  const admin = { sub: await user('admin'), userType: 'admin' };
  const ids = rows => rows.map(r => r.id).filter(id => [w, m, e].includes(id)).sort();
  const all = await call(adminListProducts, admin);
  assert.equal(all.statusCode, 200);
  assert.deepEqual(all.body.filter(r => r.id === w).map(r => [r.targetGender, r.targetAgeBands]), [['women', ['30_44']]]);
  assert.deepEqual(ids((await call(adminListProducts, admin, { query: { targetGender: 'women' } })).body), [w]);
  assert.deepEqual(ids((await call(adminListProducts, admin, { query: { targetGender: 'everyone' } })).body), [e]);
  assert.deepEqual(ids((await call(adminListProducts, admin, { query: { targetAgeBand: '60_plus' } })).body), [m]);
  assert.deepEqual(ids((await call(adminListProducts, admin, { query: { targetAgeBand: 'all' } })).body), [e]);
  assert.deepEqual(ids((await call(adminListProducts, admin, { query: { targetGender: 'men', targetAgeBand: '30_44' } })).body), []);
  for (const query of [{ targetGender: 'female' }, { targetAgeBand: '18-29' }]) {
    const bad = await call(adminListProducts, admin, { query });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.error, 'invalid_filter');
  }
  const created = await call(adminCreateProduct, admin, { body: { vendorId: vendor, name: 'Admin made', priceTzs: 5_000, stock: 1, targetGender: 'women', targetAgeBands: ['18_29'] } });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  made.products.push(created.body.id);
  const row = await db('Product').where({ id: created.body.id }).first();
  assert.deepEqual([row.targetGender, row.targetAgeBands], [null, []]);
  await call(adminUpdateProductListing, admin, { params: { id: w }, body: { targetGender: 'men', homepagePriority: 2 } });
  assert.equal((await db('Product').where({ id: w }).first()).targetGender, 'women');
});

test('tools options: merch.productTargets follows SHOP_PERSONALISATION', async () => {
  const vendor = await user('vendor');
  assert.equal((await call(vendorToolsOptionsRoute, { sub: vendor, userType: 'vendor' })).body.merch.productTargets, false);
  process.env.SHOP_PERSONALISATION = '1';
  assert.equal((await call(vendorToolsOptionsRoute, { sub: vendor, userType: 'vendor' })).body.merch.productTargets, true);
});

// ── /shop/home with the real history query ──────────────────────────────────

test('home: history uses only my own paid, not cancelled orders — never another member\'s; flag off is the old page', async () => {
  process.env.SHOP_HOME_SECTIONS = 'recommended';
  const vendor = await user('vendor', { createdAt: old });
  const cat = {};
  for (const c of ['sportswear_footwear', 'health_recovery', 'events', 'food_drinks']) {
    cat[c] = [];
    for (let i = 0; i < 2; i += 1) cat[c].push(await product(vendor, { category: c, name: `${c} ${i}` }));
  }
  // No declared gender or date of birth: this test isolates purchase history (tagged products made by
  // earlier tests would otherwise move up for an adult woman, which is right but not what is checked here).
  const me = await member({ gender: 'other', dateOfBirth: null });
  const other = await member({ gender: 'other', dateOfBirth: null });
  const boughtElsewhere = await product(vendor, { category: 'sportswear_footwear', stock: 0, name: 'Old shoes' }); // not on the home itself
  await shopOrder(me, [{ productId: boughtElsewhere, name: 'Old shoes', qty: 1 }]);
  await shopOrder(me, [{ productId: cat.health_recovery[0], name: 'Pending', qty: 1 }], { paymentStatus: 'pending', status: 'pending' });
  await shopOrder(me, [{ productId: cat.events[0], name: 'Cancelled', qty: 1 }], { status: 'cancelled' });
  await shopOrder(me, [{ productId: cat.food_drinks[0], name: 'Too old', qty: 1 }], { createdAt: new Date(Date.now() - 400 * 86_400_000) });
  await shopOrder(other, [{ productId: cat.events[1], name: 'Theirs', qty: 1 }]);

  const off = await call(shopHome, asMember(me));
  assert.equal(off.statusCode, 200);
  assert.ok(!('personalisation' in off.body));
  assert.equal(off.body.personalised, false);
  assert.ok(!off.body.sections.flatMap(s => s.reasonCodes).includes('bought_category'));

  process.env.SHOP_PERSONALISATION = '1';
  shopHomeService.clearCache();
  const on = await call(shopHome, asMember(me));
  assert.equal(on.statusCode, 200, JSON.stringify(on.body));
  assert.deepEqual(on.body.personalisation, { available: true, enabled: true });
  const rec = on.body.sections.find(s => s.key === 'recommended');
  assert.deepEqual(rec.reasonParams, { category: 'sportswear_footwear' });
  assert.equal(rec.reasonCodes[0], 'bought_category');
  // Only the paid order's category leads: every sportswear product comes before anything else.
  const catOfId = id => on.body.products[id].category;
  const firstOther = rec.productIds.findIndex(id => catOfId(id) !== 'sportswear_footwear');
  assert.ok(firstOther > 0, `sportswear first: ${JSON.stringify(rec.productIds.map(id => [id, catOfId(id)]))}`);
  assert.ok(rec.productIds.slice(firstOther).every(id => catOfId(id) !== 'sportswear_footwear'));
  for (const id of cat.sportswear_footwear) assert.ok(rec.productIds.indexOf(id) < firstOther, id);
  assert.ok(on.body.signalsUsed.includes('purchase_history'));
  for (const row of Object.values(on.body.products)) assert.ok(!('targetGender' in row) && !('targetAgeBands' in row));

  // The other member bought only an event: their page leads with events, never my shoes.
  const theirs = await call(shopHome, asMember(other));
  const theirRec = theirs.body.sections.find(s => s.key === 'recommended');
  assert.deepEqual(theirRec.reasonParams, { category: 'events' });

  // Opted out: my orders are not used at all.
  await call(putShopPreferences, asMember(me), { body: { personalised: false, source: 'why_sheet' } });
  const optedOut = await call(shopHome, asMember(me));
  assert.deepEqual(optedOut.body.personalisation, { available: true, enabled: false });
  assert.equal(optedOut.body.personalised, false);
  assert.deepEqual(optedOut.body.sections.find(s => s.key === 'recommended').reasonCodes, ['generic', 'role_context']);
});

test('home: a 16-year-old member gets no personalisation even with orders and tagged products', async () => {
  process.env.SHOP_PERSONALISATION = '1';
  process.env.SHOP_HOME_SECTIONS = 'recommended,essentials';
  const vendor = await user('vendor', { createdAt: old });
  const tagged = await product(vendor, { targetGender: 'women', targetAgeBands: ['18_29'] });
  await product(vendor);
  const kid = await member({ dateOfBirth: `${new Date().getUTCFullYear() - 16}-01-01` });
  await shopOrder(kid, [{ productId: tagged, name: 'Tagged', qty: 1 }]);
  const out = await call(shopHome, asMember(kid));
  assert.deepEqual(out.body.personalisation, { available: false, enabled: false });
  assert.equal(out.body.personalised, false);
  const codes = out.body.sections.flatMap(s => s.reasonCodes);
  for (const c of ['bought_category', 'bought_product', 'profile_gender', 'profile_age']) assert.ok(!codes.includes(c), c);
});

// ── review round 1 (2026-10-22) ─────────────────────────────────────────────

const BYPASS_DOBS = ['2011/05/03', '03/05/2011', '2011-5-3', ' 2011-05-03', '2027-01-01', '2023-02-30', '1900-06-01'];
const dobOf = async id => (await db('User').where({ id }).first()).memberProfile?.dateOfBirth ?? null;

test('POST /me/profile: dateOfBirth must be a real YYYY-MM-DD from 1901 to today, else 400 and nothing saved; "" clears; null keeps', async () => {
  const m = await member({ dateOfBirth: '1990-04-01' });
  for (const bad of BYPASS_DOBS) {
    const out = await call(updateMemberProfile, asMember(m), { body: { dateOfBirth: bad, displayName: 'Changed' } });
    assert.equal(out.statusCode, 400, bad);
    assert.deepEqual(out.body, { error: 'invalid_field', field: 'dateOfBirth' }, bad);
  }
  const row = await db('User').where({ id: m }).first();
  assert.deepEqual([row.memberProfile.dateOfBirth, row.displayName], ['1990-04-01', 'Personalisation member'], 'nothing saved by a refused request');
  assert.equal((await call(updateMemberProfile, asMember(m), { body: { dateOfBirth: '1985-12-31' } })).statusCode, 200);
  assert.equal(await dobOf(m), '1985-12-31');
  await call(updateMemberProfile, asMember(m), { body: { dateOfBirth: null, fitnessGoal: 'stay_fit' } });
  assert.equal(await dobOf(m), '1985-12-31', 'null keeps it');
  await call(updateMemberProfile, asMember(m), { body: { fitnessGoal: 'stay_fit' } });
  assert.equal(await dobOf(m), '1985-12-31', 'left out keeps it');
  assert.equal((await call(updateMemberProfile, asMember(m), { body: { dateOfBirth: '' } })).statusCode, 200);
  assert.equal(await dobOf(m), null, '"" clears it');
  // Not a member: the field is not stored for other roles and is not checked.
  const trainer = await user('trainer');
  assert.equal((await call(updateMemberProfile, { sub: trainer, userType: 'trainer' }, { body: { dateOfBirth: '03/05/2011' } })).statusCode, 200);
});

test('POST /admin/members: same date-of-birth rule', async () => {
  const admin = { sub: await user('admin'), userType: 'admin' };
  const m = await member({ dateOfBirth: '1990-04-01' });
  for (const bad of BYPASS_DOBS) {
    const out = await call(adminUpsertMember, admin, { body: { id: m, memberProfile: { dateOfBirth: bad } } });
    assert.equal(out.statusCode, 400, bad);
    assert.deepEqual(out.body, { error: 'invalid_field', field: 'dateOfBirth' }, bad);
  }
  assert.equal(await dobOf(m), '1990-04-01');
  assert.equal((await call(adminUpsertMember, admin, { body: { id: m, memberProfile: { dateOfBirth: '2000-01-31' } } })).statusCode, 200);
  assert.equal(await dobOf(m), '2000-01-31');
  await call(adminUpsertMember, admin, { body: { id: m, memberProfile: { dateOfBirth: '' } } });
  assert.equal(await dobOf(m), null);
  await db('AuditLog').whereIn('target', [m]).del();
});

test('home + preferences: a stored date in another format fails closed; no date of birth gives history only', async () => {
  process.env.SHOP_PERSONALISATION = '1';
  const vendor = await user('vendor', { createdAt: old });
  const p = await product(vendor, { category: 'health_recovery' });
  // Written straight to the database, as an old row might hold it.
  const legacy = await member({ dateOfBirth: '03/05/1990' });
  await shopOrder(legacy, [{ productId: p, name: 'Roller', qty: 1 }]);
  const out = await call(shopHome, asMember(legacy));
  assert.deepEqual(out.body.personalisation, { available: false, enabled: false });
  assert.deepEqual((await call(getShopPreferences, asMember(legacy))).body, { personalised: true, available: false, historyDays: 365, mode: 'member', uses: [] });
  const noDob = await user('member', { memberProfile: JSON.stringify({ gender: 'female' }) });
  await shopOrder(noDob, [{ productId: p, name: 'Roller', qty: 1 }]);
  assert.deepEqual((await call(getShopPreferences, asMember(noDob))).body, { personalised: true, available: true, historyDays: 365, mode: 'member', uses: ['purchase_history'] });
  process.env.SHOP_HISTORY_DAYS = '30';
  assert.equal((await call(getShopPreferences, asMember(noDob))).body.historyDays, 30);
  delete process.env.SHOP_HISTORY_DAYS;
});

test('admin list: a product stored with all four bands counts as all ages; vendors saving all four get []', async () => {
  const vendor = await user('vendor', { createdAt: old });
  const v = { sub: vendor, userType: 'vendor' };
  const created = await call(vendorCreateProduct, v, { body: { name: 'Every age', priceTzs: 5_000, stock: 1, targetAgeBands: ['18_29', '30_44', '45_59', '60_plus'] } });
  made.products.push(created.body.id);
  assert.deepEqual(created.body.targetAgeBands, []);
  const legacy = await product(vendor, { targetAgeBands: ['18_29', '30_44', '45_59', '60_plus'] });
  const admin = { sub: await user('admin'), userType: 'admin' };
  const all = (await call(adminListProducts, admin, { query: { targetAgeBand: 'all' } })).body.map(r => r.id);
  assert.ok(all.includes(created.body.id) && all.includes(legacy));
});

// Link/merge: B's persona moves onto A's Person through a verified email; B's Person becomes a tombstone.
async function linkScenario({ anchorPref, otherPref }) {
  const uidA = uid('fb');
  const email = `${uid('merge')}@example.com`;
  const a = await user('member', { firebaseUid: uidA, email, accountStatus: 'active', approvalStatus: 'approved', memberProfile: JSON.stringify({ dateOfBirth: '1990-01-01' }) });
  const b = await user('vendor', { email, accountStatus: 'active', approvalStatus: 'approved' });
  const pa = (await db('User').where({ id: a }).first()).personId;
  const pb = (await db('User').where({ id: b }).first()).personId;
  made.linked.push(pa, pb);
  assert.notEqual(pa, pb);
  const at = new Date();
  if (anchorPref !== undefined) await db('ShopPreference').insert({ personId: pa, subjectType: 'person', personalised: anchorPref, source: 'why_sheet', updatedBy: a, updatedAt: at });
  if (otherPref !== undefined) await db('ShopPreference').insert({ personId: pb, subjectType: 'person', personalised: otherPref, source: 'privacy_page', updatedBy: b, updatedAt: at });
  const result = await identityLinkService.linkOnVerifiedSignIn({ anchorUserId: a, uid: uidA, email });
  return { a, b, pa, pb, result };
}

test('link/merge: an opt-out on the merged-in Person carries over (audited); the tombstone loses its row', async () => {
  const { a, pa, pb, result } = await linkScenario({ anchorPref: undefined, otherPref: false });
  assert.deepEqual(result.mergedPersonIds, [pb], JSON.stringify(result));
  assert.equal((await db('Person').where({ id: pb }).first()).mergedIntoId, pa);
  const row = await db('ShopPreference').where({ personId: pa }).first();
  assert.deepEqual([row.personalised, row.source], [false, 'identity_link']);
  assert.equal(await db('ShopPreference').where({ personId: pb }).first(), undefined);
  const audit = await db('AuditLog').where({ target: pa, action: 'shop_preference_changed' });
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].actor, audit[0].before, audit[0].after], [a, { personalised: true }, { personalised: false, source: 'identity_link', fromPersonId: pb }]);
  assert.equal((await call(getShopPreferences, asMember(a))).body.personalised, false);
});

test('link/merge: the anchor\'s opt-out stays; two "on" sides stay on; nothing is invented', async () => {
  const kept = await linkScenario({ anchorPref: false, otherPref: true });
  assert.equal((await db('ShopPreference').where({ personId: kept.pa }).first()).personalised, false);
  assert.equal(await db('ShopPreference').where({ personId: kept.pb }).first(), undefined);
  assert.equal((await db('AuditLog').where({ target: kept.pa, action: 'shop_preference_changed' })).length, 0);
  const none = await linkScenario({});
  assert.equal(await db('ShopPreference').where({ personId: none.pa }).first(), undefined);
  assert.equal((await call(getShopPreferences, asMember(none.a))).body.personalised, true);
});

test('account deletion: the switch is deleted once the Person has no personas left, kept while one remains', async () => {
  const per = await person();
  const m = await member({}, { personId: per });
  const t = await user('trainer', { personId: per });
  await db('ShopPreference').insert({ personId: per, subjectType: 'person', personalised: false, source: 'why_sheet', updatedBy: m, updatedAt: new Date() });
  const deleted = await accountService.deleteMyAccount(await db('User').where({ id: m }).first());
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.ok(await db('ShopPreference').where({ personId: per }).first(), 'the trainer persona still holds the Person');
  const again = await accountService.deleteMyAccount(await db('User').where({ id: t }).first());
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(await db('ShopPreference').where({ personId: per }).first(), undefined);
  await db('AuditLog').whereIn('target', [m, t]).del();
});
