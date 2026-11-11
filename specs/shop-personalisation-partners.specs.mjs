// Partner DOB · slice 4: shop personalisation in trainer and owner mode (SHOP_PERSONALISATION_PARTNERS).
// Contract: docs/shop-personalisation-api.md "Trainer and owner mode". In memory; the CI database
// version is shop-personalisation-partners-routes.specs.mjs.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  partnerEligibility, personDobVerdict, blockedByVerdict, partnerGender, partnerAudienceFrom, audienceFrom, reorderForAudience,
} from '../src/services/shop-personalisation.mjs';
import { buildShopHome } from '../src/services/shop-recommendations.mjs';
import { createShopService } from '../src/services/shop-service.mjs';
import { createShopHomeService, shopHomeConfigFromEnv } from '../src/services/shop-home-service.mjs';
import { createShopPreferenceService } from '../src/services/shop-preference-service.mjs';
import { createMemoryShopPreferenceStore } from '../src/infra/shop-preference-store-pg.mjs';
import { shopPersonalisationPartnersOn } from '../src/shared/feature-flags.mjs';

const NOW = new Date('2026-11-10T08:00:00Z');
const DAY = 86_400_000;
const ago = days => new Date(NOW - days * DAY).toISOString();
const ADULT_DOB = '1990-05-01'; // 36 → band 30_44
const MINOR_DOB = '2010-03-01'; // 16
const PERSONAL_CODES = ['bought_category', 'bought_product', 'profile_gender', 'profile_age'];
const PERSONAL_SIGNALS = ['purchase_history', 'profile_gender', 'profile_age'];
const GENDER_AGE_WORDS = /\b(women|woman|men|man|female|male|ladies|her|his|wanawake|wanaume|mwanamke|mwanamume|kike|kiume|over \d+|under \d+|\d+\s*[-–]\s*\d+|60\+|umri)\b/i;
const order = (buyerId, items, extra = {}) => ({ id: `ord_${Math.random().toString(36).slice(2, 8)}`, buyerId, items, paymentStatus: 'paid', status: 'delivered', createdAt: ago(5), ...extra });
const line = (productId, name = productId) => ({ productId, name, qty: 1 });
const sec = (body, key) => body.sections.find(s => s.key === key);
const claimsOf = u => ({ sub: u.id, userType: u.userType });
const pa = body => ({ personalised: body.personalised, available: body.available });

afterEach(() => { delete process.env.SHOP_PERSONALISATION; delete process.env.SHOP_PERSONALISATION_PARTNERS; });

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async filterByColumnInAsync(col, values) { return rows.filter(r => values.includes(r[col])); },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) { const i = rows.findIndex(r => r.id === id); if (i >= 0) rows[i] = { ...rows[i], ...patch }; return rows[i] || null; },
  };
}

/**
 * users: [{ id, userType, personId?, memberProfile? }]; persons: { personId: { dateOfBirth, gender } };
 * trainerProfiles: { userId: { gender, specialties } }. Builds:
 *   service  — both flags as given (`flag`, `partners`), with the slice 4 dependencies;
 *   legacy   — the service exactly as before slice 4 (no partnersOn / personDetailsOf given);
 *   phase1   — no personalisation dependencies at all.
 * `reads` records every Person read, so "never read with the flag off" can be checked.
 */
function setup({ users = [], persons = {}, trainerProfiles = {}, orders = [], flag = true, partners = true, env = {} } = {}) {
  const products = memStore();
  const userStore = memStore(users.map(u => ({ ...u })));
  const shopService = createShopService({
    products, shopOrders: memStore(), users: userStore, auditLog: { insertAsync: async () => {} },
    partnerGate: { operationalUserIds: async ids => new Set(ids), isOperational: async () => true, exempt: () => true },
    publicGate: { blocked: async () => new Set(), isBlocked: async () => false },
  });
  const identityLink = { personasOf: async personId => userStore.rows.filter(u => u.personId === personId) };
  const store = createMemoryShopPreferenceStore();
  const flags = { on: flag, partners };
  const reads = [];
  const trainerProfileOf = userId => trainerProfiles[userId] || null;
  const common = { store, users: userStore, identityLink, flagOn: () => flags.on, now: () => NOW, trainerProfileOf };
  const preferences = createShopPreferenceService({
    ...common, partnersOn: () => flags.on && flags.partners,
    personDetailsOf: async (personId) => { reads.push(personId); return persons[personId] || null; },
  });
  const legacyPreferences = createShopPreferenceService(common);
  const seen = [];
  const deps = {
    shopService,
    discoveryService: { discover: async () => ({ featured: [] }) },
    promotionService: { listLive: async () => [] },
    users: userStore, trainerService: { findProfileByUser: trainerProfileOf }, identityLink,
    recentPaidOrders: async () => orders.map(o => ({ ...o, buyerRole: 'member' })),
    config: () => shopHomeConfigFromEnv({ SHOP_HOME_MIN_ITEMS: '1', SHOP_HOME_CACHE_SECONDS: '300', ...env }),
    now: () => NOW,
  };
  const history = { personalisationOn: () => flags.on, buyerPaidOrders: async ({ buyerIds }) => { seen.push([...buyerIds]); return orders; } };
  const service = createShopHomeService({ ...deps, ...history, preferences });
  const legacy = createShopHomeService({ ...deps, ...history, preferences: legacyPreferences });
  const phase1 = createShopHomeService(deps);
  let n = 0;
  const add = (extra = {}) => {
    n += 1;
    const row = {
      id: `prd_${String(n).padStart(3, '0')}`, vendorId: 'v1', name: `P${n}`, category: 'equipment', priceTzs: 10_000, discountPriceTzs: null,
      stock: 3, status: 'active', approvalStatus: 'approved', visibility: 'visible', homepageVisible: true, homepagePriority: 0,
      rating: 0, reviewCount: 0, soldCount: 0, createdAt: new Date(NOW - n * 60_000).toISOString(), targetGender: null, targetAgeBands: [], ...extra,
    };
    products.rows.push(row);
    return row;
  };
  return { service, legacy, phase1, preferences, legacyPreferences, store, add, seen, reads, flags };
}

// Six equipment products; prd_004..006 tagged for women aged 30–44, prd_003 for men 60+.
function tagged(s) {
  for (let i = 0; i < 6; i += 1) {
    s.add({ targetGender: i >= 3 ? 'women' : i === 2 ? 'men' : null, targetAgeBands: i >= 3 ? ['30_44'] : i === 2 ? ['60_plus'] : [] });
  }
}

const TRAINER = { id: 't1', userType: 'trainer', personId: 'pt' };
const OWNER = { id: 'o1', userType: 'gym_operator', personId: 'po' };

// ── the flag ────────────────────────────────────────────────────────────────

test('flag: SHOP_PERSONALISATION_PARTNERS has effect only with SHOP_PERSONALISATION on too', () => {
  for (const [base, partners, want] of [[undefined, '1', false], ['1', undefined, false], ['1', '0', false], ['1', 'true', true], [undefined, undefined, false]]) {
    if (base === undefined) delete process.env.SHOP_PERSONALISATION; else process.env.SHOP_PERSONALISATION = base;
    if (partners === undefined) delete process.env.SHOP_PERSONALISATION_PARTNERS; else process.env.SHOP_PERSONALISATION_PARTNERS = partners;
    assert.equal(shopPersonalisationPartnersOn(), want, `${base}/${partners}`);
  }
});

// ── pure rules ──────────────────────────────────────────────────────────────

test('rules (M1): one verdict per Person from Person.dateOfBirth and every member date of birth', () => {
  const v = (personDob, memberDobs = []) => { const r = personDobVerdict({ personDob, memberDobs, now: NOW }); return [r.status, r.age]; };
  assert.deepEqual(v(null), ['absent', null]);
  assert.deepEqual(v(null, [null, '', '  ']), ['absent', null], 'blank member dates are absent');
  assert.deepEqual(v('1980-01-01', ['1990-01-01']), ['adult', 46], 'age from the Person');
  assert.deepEqual(v(null, [null, '1990-01-01', '1970-01-01']), ['adult', 36], 'else the first valid member date');
  // Conflicts: any invalid or under-18 date anywhere → nothing.
  assert.deepEqual(v(ADULT_DOB, [MINOR_DOB]), ['under_18', 16], 'Person adult, member under 18');
  assert.deepEqual(v(MINOR_DOB, [ADULT_DOB]), ['under_18', 16], 'Person under 18, member adult');
  assert.deepEqual(v('2027-01-01', [ADULT_DOB]), ['invalid', null], 'future Person date never falls through');
  assert.deepEqual(v(ADULT_DOB, ['03/05/1990']), ['invalid', null], 'an invalid member date blocks an adult Person');
  assert.deepEqual(v(MINOR_DOB, ['bad']), ['invalid', null], 'invalid wins over under 18');
  assert.equal(blockedByVerdict({ status: 'adult', age: 30 }), null);
  assert.equal(blockedByVerdict({ status: 'absent' }), null);
  assert.equal(blockedByVerdict({ status: 'under_18', age: 16 }).reason, 'under_18');
  const e = verdict => { const r = partnerEligibility({ flagOn: true, verdict }); return [r.available, r.reason, r.audienceAllowed, r.age]; };
  assert.deepEqual(e({ status: 'absent', age: null }), [true, null, false, null], 'absent: history only');
  assert.deepEqual(e({ status: 'invalid', age: null }), [false, 'invalid_dob', false, null]);
  assert.deepEqual(e({ status: 'under_18', age: 16 }), [false, 'under_18', false, 16]);
  assert.deepEqual(e({ status: 'adult', age: 36 }), [true, null, true, 36]);
  assert.equal(partnerEligibility({ flagOn: false, verdict: { status: 'adult', age: 36 } }).reason, 'flag_off');
});

test('rules: gender — trainer profile first, then Person; owner Person only; other / NULL give no signal', () => {
  assert.equal(partnerGender({ mode: 'trainer', trainerProfile: { gender: 'male' }, person: { gender: 'female' } }), 'male');
  assert.equal(partnerGender({ mode: 'trainer', trainerProfile: { gender: null }, person: { gender: 'female' } }), 'female');
  assert.equal(partnerGender({ mode: 'trainer', trainerProfile: null, person: { gender: 'male' } }), 'male');
  assert.equal(partnerGender({ mode: 'trainer', trainerProfile: { gender: 'other' }, person: { gender: 'female' } }), 'other', 'a declared "other" is not overridden');
  assert.equal(partnerGender({ mode: 'owner', trainerProfile: { gender: 'male' }, person: { gender: null } }), null, 'owner never reads the trainer profile');
  assert.equal(partnerGender({ mode: 'member', person: { gender: 'female' } }), null);
  assert.deepEqual(partnerAudienceFrom({ mode: 'owner', gender: 'other', age: 40 }), { gender: null, ageBand: '30_44' });
  assert.deepEqual(partnerAudienceFrom({ mode: 'trainer', gender: 'female', age: 40 }), { gender: 'women', ageBand: '30_44' });
  assert.deepEqual(partnerAudienceFrom({ mode: 'trainer', gender: 'female', age: 17 }), { gender: null, ageBand: null });
  assert.deepEqual(partnerAudienceFrom({ mode: 'vendor_personal', gender: 'female', age: 40 }), { gender: null, ageBand: null });
  assert.deepEqual(partnerAudienceFrom({ mode: 'member', gender: 'female', age: 40 }), { gender: null, ageBand: null });
  // Member-mode rule untouched.
  assert.deepEqual(audienceFrom({ mode: 'trainer', memberProfile: { gender: 'female' }, age: 40 }), { gender: null, ageBand: null });
});

test('reorder only: in trainer and owner mode the product set of every section is identical with and without the audience', () => {
  const products = [];
  for (let i = 0; i < 30; i += 1) {
    products.push({
      id: `p${i}`, vendorId: 'v', name: `P${i}`, category: ['equipment', 'accessories_gear', 'sportswear_footwear'][i % 3], priceTzs: 1000 + i, stock: 2, status: 'active',
      approvalStatus: 'approved', visibility: 'visible', createdAt: ago(i), targetGender: ['women', 'men', null][i % 3], targetAgeBands: i % 2 ? ['30_44'] : ['60_plus'],
    });
  }
  for (const mode of ['trainer', 'owner']) {
    for (const audience of [{ gender: 'women', ageBand: '30_44' }, { gender: 'men', ageBand: null }, { gender: null, ageBand: '60_plus' }]) {
      const base = { mode, sessionUserType: mode === 'owner' ? 'gym_operator' : 'trainer', heldUserTypes: [], products, featured: [], paidPlacementIds: [], orders: [], config: { minItems: 1 }, now: NOW };
      const without = buildShopHome({ ...base, personalisation: { optedOut: false, history: null, audienceFor: () => null } });
      const withAud = buildShopHome({ ...base, personalisation: { optedOut: false, history: null, audienceFor: () => audience } });
      assert.deepEqual(withAud.sections.map(s => s.key), without.sections.map(s => s.key));
      for (const s of withAud.sections) {
        const o = without.sections.find(x => x.key === s.key);
        assert.deepEqual([...s.productIds].sort(), [...o.productIds].sort(), `${mode} ${s.key}`);
        assert.deepEqual(s.title, o.title, 'titles never change');
        assert.ok(!GENDER_AGE_WORDS.test(`${s.title.en} ${s.title.sw} ${s.reason.en} ${s.reason.sw}`));
      }
      assert.equal(withAud.allProductsCount, without.allProductsCount);
      assert.deepEqual(withAud.categories, without.categories);
    }
  }
  // And the reorder itself never adds or drops.
  const ids = products.map(p => p.id);
  const rowOf = id => products.find(p => p.id === id);
  assert.deepEqual([...reorderForAudience(ids, rowOf, { gender: 'women', ageBand: '30_44' })].sort(), [...ids].sort());
});

// ── flag off: byte-identical ────────────────────────────────────────────────

test('flag off: with SHOP_PERSONALISATION_PARTNERS off every /shop/home and /shop/preferences body is byte-identical to before; no Person read', async () => {
  const users = [
    TRAINER, OWNER,
    { id: 'm2', userType: 'member', personId: 'pm', memberProfile: { gender: 'female', dateOfBirth: ADULT_DOB } },
    { id: 't2', userType: 'trainer', personId: 'pm' }, { id: 'o2', userType: 'gym_operator', personId: 'pm' },
  ];
  const persons = { pt: { dateOfBirth: ADULT_DOB, gender: 'female' }, po: { dateOfBirth: ADULT_DOB, gender: 'female' }, pm: { dateOfBirth: '1970-01-01', gender: 'male' } };
  const trainerProfiles = { t1: { gender: 'female', specialties: ['strength'] }, t2: { gender: 'male', specialties: ['yoga'] } };
  const orders = [order('t1', [line('prd_001')]), order('o1', [line('prd_002')]), order('m2', [line('prd_003')])];
  const s = setup({ users, persons, trainerProfiles, orders, partners: false, env: { SHOP_HOME_SECTIONS: 'recommended,essentials,new_arrivals' } });
  tagged(s);
  const cases = [[TRAINER, undefined], [OWNER, undefined], [users[2], 'member'], [users[2], 'trainer'], [users[2], 'owner'], [users[3], undefined], [users[4], undefined]];
  for (const flagOn of [true, false]) {
    s.flags.on = flagOn;
    for (const [u, mode] of cases) {
      const a = await s.service.home({ claims: claimsOf(u), query: { mode } });
      const b = await s.legacy.home({ claims: claimsOf(u), query: { mode } });
      assert.equal(JSON.stringify(a.body), JSON.stringify(b.body), `home ${u.id} ${mode} flag ${flagOn}`);
      if (!flagOn) assert.equal(JSON.stringify(a.body), JSON.stringify((await s.phase1.home({ claims: claimsOf(u), query: { mode } })).body));
      const pa1 = await s.preferences.get({ claims: claimsOf(u), mode });
      const pb1 = await s.legacyPreferences.get({ claims: claimsOf(u), mode });
      assert.equal(JSON.stringify(pa1), JSON.stringify(pb1), `preferences ${u.id} ${mode} flag ${flagOn}`);
    }
  }
  // Partners on but SHOP_PERSONALISATION off: still nothing (the flag function requires both; the service checks both too).
  s.flags.on = false; s.flags.partners = true;
  for (const [u, mode] of cases) {
    const a = await s.service.home({ claims: claimsOf(u), query: { mode } });
    assert.equal(JSON.stringify(a.body), JSON.stringify((await s.phase1.home({ claims: claimsOf(u), query: { mode } })).body));
  }
  assert.deepEqual(s.reads, [], 'Person details never read while either flag is off');
  // The documented flag-off answers for a trainer-only account.
  s.flags.on = true; s.flags.partners = false;
  assert.deepEqual((await s.preferences.get({ claims: claimsOf(TRAINER) })).body, { personalised: true, available: false, historyDays: 365, mode: 'trainer', uses: [] });
});

// ── member mode and vendor_personal unchanged ───────────────────────────────

test('flag on: member mode and vendor_personal are unchanged (same bodies as with the flag off)', async () => {
  const users = [
    { id: 'm3', userType: 'member', personId: 'pm3', memberProfile: { gender: 'female', dateOfBirth: ADULT_DOB } },
    { id: 't3', userType: 'trainer', personId: 'pm3' }, { id: 'v3', userType: 'vendor', personId: 'pm3' },
    { id: 'm4', userType: 'member', personId: 'pm4', memberProfile: { gender: 'male', dateOfBirth: MINOR_DOB } },
    { id: 'v5', userType: 'vendor', personId: 'pv5' },
  ];
  // The Person says something else entirely: member mode must not use it.
  const persons = { pm3: { dateOfBirth: '1955-01-01', gender: 'male' }, pm4: { dateOfBirth: ADULT_DOB, gender: 'female' }, pv5: { dateOfBirth: ADULT_DOB, gender: 'female' } };
  const s = setup({ users, persons, orders: [order('m3', [line('prd_001')]), order('v5', [line('prd_002')])], env: { SHOP_HOME_SECTIONS: 'recommended,essentials' } });
  tagged(s);
  for (const [u, mode] of [[users[0], undefined], [users[0], 'vendor_personal'], [users[1], 'member'], [users[3], undefined], [users[4], undefined], [users[2], 'vendor_personal']]) {
    const a = await s.service.home({ claims: claimsOf(u), query: { mode } });
    const b = await s.legacy.home({ claims: claimsOf(u), query: { mode } });
    assert.equal(JSON.stringify(a.body), JSON.stringify(b.body), `home ${u.id} ${mode}`);
    assert.equal(JSON.stringify(await s.preferences.get({ claims: claimsOf(u), mode })), JSON.stringify(await s.legacyPreferences.get({ claims: claimsOf(u), mode })), `prefs ${u.id} ${mode}`);
  }
  const minor = await s.service.home({ claims: claimsOf(users[3]) });
  assert.deepEqual(minor.body.personalisation, { available: false, enabled: false }, 'an under-18 member stays off even with an adult Person date of birth');
  const vendorOnly = await s.preferences.get({ claims: claimsOf(users[4]) });
  assert.deepEqual(pa(vendorOnly.body), { personalised: true, available: false }, 'vendor-only: still no_member');
});

// ── trainer-only and owner-only ─────────────────────────────────────────────

for (const [label, u, mode] of [['trainer-only', TRAINER, 'trainer'], ['owner-only', OWNER, 'owner']]) {
  test(`${label}: no date of birth → purchase history only, never gender or age`, async () => {
    const s = setup({ users: [u], persons: { [u.personId]: { dateOfBirth: null, gender: 'female' } }, orders: [order(u.id, [line('prd_007', 'Mat')], { createdAt: ago(60) })], env: { SHOP_HOME_SECTIONS: 'recommended' } });
    tagged(s);
    for (let i = 0; i < 3; i += 1) s.add({ category: 'accessories_gear' }); // prd_007..009
    const on = await s.service.home({ claims: claimsOf(u) });
    assert.equal(on.body.mode, mode);
    assert.deepEqual(on.body.personalisation, { available: true, enabled: true }, 'no longer no_member');
    assert.ok(on.body.signalsUsed.includes('purchase_history'));
    assert.ok(!on.body.signalsUsed.includes('profile_gender') && !on.body.signalsUsed.includes('profile_age'));
    assert.ok(!on.body.sections.flatMap(x => x.reasonCodes).some(c => c === 'profile_gender' || c === 'profile_age'));
    const prefs = (await s.preferences.get({ claims: claimsOf(u) })).body;
    assert.deepEqual([prefs.available, prefs.mode, prefs.uses], [true, mode, ['purchase_history']]);
  });

  for (const [what, dob] of [['invalid (future) date of birth', '2027-01-01'], ['under 18', MINOR_DOB]]) {
    test(`${label}: ${what} → nothing at all (Phase 1 page, uses [], orders not read)`, async () => {
      const s = setup({ users: [u], persons: { [u.personId]: { dateOfBirth: dob, gender: 'female' } }, orders: [order(u.id, [line('prd_001')])], env: { SHOP_HOME_SECTIONS: 'recommended,essentials' } });
      tagged(s);
      const on = await s.service.home({ claims: claimsOf(u) });
      const off = await s.phase1.home({ claims: claimsOf(u) });
      assert.deepEqual(on.body.personalisation, { available: false, enabled: false });
      assert.equal(on.body.personalised, false);
      assert.deepEqual(on.body.sections, off.body.sections);
      assert.ok(!on.body.signalsUsed.some(x => PERSONAL_SIGNALS.includes(x)));
      assert.deepEqual(s.seen, [], 'orders not even read');
      const prefs = (await s.preferences.get({ claims: claimsOf(u) })).body;
      assert.deepEqual([prefs.available, prefs.uses], [false, []]);
    });
  }

  test(`${label}: an invalid member-profile date of birth (no Person one) fails closed too`, async () => {
    const withMember = [{ ...u }, { id: `${u.id}m`, userType: 'member', personId: u.personId, memberProfile: { gender: 'female', dateOfBirth: '1990/05/01' } }];
    const s = setup({ users: withMember, persons: { [u.personId]: { dateOfBirth: null, gender: null } } });
    tagged(s);
    assert.deepEqual(pa((await s.preferences.get({ claims: claimsOf(u) })).body), { personalised: true, available: false });
  });

  test(`${label}: adult → purchase history plus gender and age reorder; nothing added or removed; no gender word`, async () => {
    const s = setup({ users: [u], persons: { [u.personId]: { dateOfBirth: ADULT_DOB, gender: 'female' } }, env: { SHOP_HOME_SECTIONS: 'recommended' } });
    tagged(s);
    const off = await s.legacy.home({ claims: claimsOf(u) });
    const on = await s.service.home({ claims: claimsOf(u) });
    const a = sec(off.body, 'recommended').productIds;
    const b = sec(on.body, 'recommended').productIds;
    assert.deepEqual([...b].sort(), [...a].sort(), 'same products');
    assert.deepEqual(b.slice(0, 3).sort(), ['prd_004', 'prd_005', 'prd_006'], 'women 30–44 first');
    assert.ok(b.includes('prd_003'), 'the men-tagged product is still shown');
    assert.deepEqual(on.body.signalsUsed.filter(x => PERSONAL_SIGNALS.includes(x)), ['profile_gender', 'profile_age']);
    assert.ok(sec(on.body, 'recommended').reasonCodes.includes('profile_gender'));
    assert.ok(sec(on.body, 'recommended').reasonCodes.includes('profile_age'));
    assert.deepEqual(sec(on.body, 'recommended').title, sec(off.body, 'recommended').title);
    for (const x of on.body.sections) assert.ok(!GENDER_AGE_WORDS.test(`${x.title.en} ${x.title.sw} ${x.reason.en} ${x.reason.sw}`), x.key);
    assert.equal(on.body.personalised, true);
    const prefs = (await s.preferences.get({ claims: claimsOf(u) })).body;
    assert.deepEqual(prefs.uses, ['purchase_history', 'profile_gender', 'profile_age']);
  });
}

test('trainer gender: TrainerProfile.gender wins; NULL there falls back to Person.gender; "other" gives no gender signal', async () => {
  const persons = { pt: { dateOfBirth: ADULT_DOB, gender: 'female' } };
  // Person.gender is female throughout: it only counts when the trainer profile has no gender.
  for (const [profileGender, wantGender] of [[null, true], ['female', true], ['male', true], ['other', false]]) {
    const s = setup({ users: [TRAINER], persons, trainerProfiles: { t1: { gender: profileGender, specialties: ['strength'] } }, env: { SHOP_HOME_SECTIONS: 'recommended' } });
    tagged(s);
    const on = await s.service.home({ claims: claimsOf(TRAINER) });
    const prefs = (await s.preferences.get({ claims: claimsOf(TRAINER) })).body;
    const rec = sec(on.body, 'recommended');
    if (wantGender) {
      assert.ok(prefs.uses.includes('profile_gender'), `profile ${profileGender}`);
      assert.ok(on.body.signalsUsed.includes('profile_gender'), `profile ${profileGender}`);
    } else {
      assert.ok(!prefs.uses.includes('profile_gender'), `profile ${profileGender}`);
      // "other": no gender signal at all (a "male" trainer does get one — checked below).
      if (profileGender === 'other') assert.ok(!rec.reasonCodes.includes('profile_gender') && !on.body.signalsUsed.includes('profile_gender'));
    }
    assert.ok(prefs.uses.includes('profile_age'));
    assert.ok(prefs.uses.includes('specialty'), 'trainer mode keeps specialty');
    assert.deepEqual(prefs.uses.filter(x => x !== 'specialty'), ['purchase_history', ...(wantGender ? ['profile_gender'] : []), 'profile_age']);
  }
  // A male trainer: the men-tagged product (prd_003) moves up for gender.
  const s = setup({ users: [TRAINER], persons, trainerProfiles: { t1: { gender: 'male', specialties: [] } }, env: { SHOP_HOME_SECTIONS: 'recommended' } });
  tagged(s);
  const rec = sec((await s.service.home({ claims: claimsOf(TRAINER) })).body, 'recommended');
  assert.ok(rec.productIds.indexOf('prd_003') < rec.productIds.indexOf('prd_001'));
});

test('owner gender NULL ("prefer not to say") → profile_age only; owner never reads a trainer profile', async () => {
  const users = [OWNER, { id: 'o1t', userType: 'trainer', personId: 'po' }];
  const s = setup({ users, persons: { po: { dateOfBirth: ADULT_DOB, gender: null } }, trainerProfiles: { o1t: { gender: 'female', specialties: ['strength'] } }, env: { SHOP_HOME_SECTIONS: 'recommended' } });
  tagged(s);
  const on = await s.service.home({ claims: claimsOf(OWNER) });
  assert.deepEqual(on.body.signalsUsed.filter(x => PERSONAL_SIGNALS.includes(x)), ['profile_age']);
  assert.ok(!on.body.sections.flatMap(x => x.reasonCodes).includes('profile_gender'));
  const prefs = (await s.preferences.get({ claims: claimsOf(OWNER) })).body;
  assert.deepEqual([prefs.mode, prefs.uses], ['owner', ['purchase_history', 'profile_age']]);
  // The same person in trainer mode does use the trainer profile's gender.
  const asTrainer = (await s.preferences.get({ claims: claimsOf(OWNER), mode: 'trainer' })).body;
  assert.deepEqual(asTrainer.uses, ['purchase_history', 'profile_gender', 'profile_age', 'specialty']);
});

// ── member + trainer (+ owner) account in each mode ─────────────────────────

test('member + trainer + owner account: each mode uses its own rules', async () => {
  const M = { id: 'mx', userType: 'member', personId: 'px', memberProfile: { gender: 'male', dateOfBirth: '1960-01-01' } };
  const T = { id: 'tx', userType: 'trainer', personId: 'px' };
  const O = { id: 'ox', userType: 'gym_operator', personId: 'px' };
  const s = setup({ users: [M, T, O], persons: { px: { dateOfBirth: ADULT_DOB, gender: null } }, trainerProfiles: { tx: { gender: 'female', specialties: [] } }, env: { SHOP_HOME_SECTIONS: 'recommended' } });
  tagged(s);
  // Member mode: the member profile (male, 66 → 60_plus): prd_003 (men, 60+) first — exactly as with the flag off.
  for (const claims of [claimsOf(M), claimsOf(T)]) {
    const home = await s.service.home({ claims, query: { mode: 'member' } });
    assert.equal(sec(home.body, 'recommended').productIds[0], 'prd_003');
    assert.equal(JSON.stringify(home.body), JSON.stringify((await s.legacy.home({ claims, query: { mode: 'member' } })).body));
  }
  // Trainer mode: Person DOB (36 → 30_44) and the trainer profile's gender (female): women 30–44 first.
  const t = await s.service.home({ claims: claimsOf(M), query: { mode: 'trainer' } });
  assert.deepEqual(sec(t.body, 'recommended').productIds.slice(0, 3).sort(), ['prd_004', 'prd_005', 'prd_006']);
  assert.deepEqual((await s.preferences.get({ claims: claimsOf(M), mode: 'trainer' })).body.uses, ['purchase_history', 'profile_gender', 'profile_age']);
  // Owner mode: Person DOB, Person gender NULL → age only.
  const o = await s.service.home({ claims: claimsOf(T), query: { mode: 'owner' } });
  assert.deepEqual(o.body.signalsUsed.filter(x => PERSONAL_SIGNALS.includes(x)), ['profile_age']);
  assert.deepEqual((await s.preferences.get({ claims: claimsOf(T), mode: 'owner' })).body.uses, ['purchase_history', 'profile_age']);
  // A mode the person does not hold is still refused.
  const S = setup({ users: [T], persons: { px: { dateOfBirth: ADULT_DOB } } });
  assert.deepEqual(await S.preferences.get({ claims: claimsOf(T), mode: 'owner' }), { error: 'mode_not_allowed', status: 403 });
});

test('member + trainer account: no Person date of birth → the member profile one counts in trainer mode (adult and under-18 cases)', async () => {
  for (const [dob, available, ageUsed] of [[ADULT_DOB, true, true], [MINOR_DOB, false, false], [null, true, false]]) {
    const M = { id: 'my', userType: 'member', personId: 'py', memberProfile: { gender: 'female', dateOfBirth: dob } };
    const T = { id: 'ty', userType: 'trainer', personId: 'py' };
    const s = setup({ users: [M, T], persons: { py: { dateOfBirth: null, gender: null } }, trainerProfiles: { ty: { gender: null } }, env: { SHOP_HOME_SECTIONS: 'recommended' } });
    tagged(s);
    const prefs = (await s.preferences.get({ claims: claimsOf(T) })).body;
    assert.equal(prefs.available, available, String(dob));
    assert.equal(prefs.uses.includes('profile_age'), ageUsed, String(dob));
    assert.ok(!prefs.uses.includes('profile_gender'), 'trainer mode never uses the member profile gender');
  }
});

test('one opt-out per Person: switched off in trainer mode is off in owner and member mode too; nothing personal used', async () => {
  const M = { id: 'mz', userType: 'member', personId: 'pz', memberProfile: { gender: 'female', dateOfBirth: ADULT_DOB } };
  const T = { id: 'tz', userType: 'trainer', personId: 'pz' };
  const O = { id: 'oz', userType: 'gym_operator', personId: 'pz' };
  const s = setup({ users: [M, T, O], persons: { pz: { dateOfBirth: ADULT_DOB, gender: 'female' } }, orders: [order('tz', [line('prd_001')])], env: { SHOP_HOME_SECTIONS: 'recommended' } });
  tagged(s);
  const set = await s.preferences.set({ claims: claimsOf(T), body: { personalised: false, source: 'privacy_page' } });
  assert.deepEqual(pa(set.body), { personalised: false, available: true });
  for (const [claims, mode] of [[claimsOf(T), 'trainer'], [claimsOf(O), 'owner'], [claimsOf(M), 'member']]) {
    const prefs = (await s.preferences.get({ claims, mode })).body;
    assert.deepEqual([prefs.personalised, prefs.uses], [false, []], mode);
    const home = await s.service.home({ claims, query: { mode } });
    assert.deepEqual(home.body.personalisation, { available: true, enabled: false });
    assert.ok(!home.body.sections.flatMap(x => x.reasonCodes).some(c => PERSONAL_CODES.includes(c)), mode);
  }
});

// ── security review M1: one under-18 answer per Person, every mode ─────────

for (const [label, personDob, memberDob] of [
  ['Person adult, member persona under 18', ADULT_DOB, MINOR_DOB],
  ['Person under 18, member persona adult', MINOR_DOB, ADULT_DOB],
  ['Person date invalid (future), member persona adult', '2027-01-01', ADULT_DOB],
]) {
  test(`M1 conflict: ${label} → nothing in member, trainer and owner mode; flag off: member mode as before`, async () => {
    const M = { id: 'mc', userType: 'member', personId: 'pc', memberProfile: { gender: 'female', dateOfBirth: memberDob } };
    const T = { id: 'tc', userType: 'trainer', personId: 'pc' };
    const O = { id: 'oc', userType: 'gym_operator', personId: 'pc' };
    const s = setup({ users: [M, T, O], persons: { pc: { dateOfBirth: personDob, gender: 'female' } }, trainerProfiles: { tc: { gender: 'female' } }, orders: [order('mc', [line('prd_001')])], env: { SHOP_HOME_SECTIONS: 'recommended' } });
    tagged(s);
    for (const [claims, mode] of [[claimsOf(M), 'member'], [claimsOf(T), 'member'], [claimsOf(M), 'trainer'], [claimsOf(O), 'owner'], [claimsOf(T), undefined]]) {
      const prefs = (await s.preferences.get({ claims, mode })).body;
      assert.deepEqual([prefs.available, prefs.uses], [false, []], `${claims.sub} ${mode}`);
      const home = await s.service.home({ claims, query: { mode } });
      assert.deepEqual(home.body.personalisation, { available: false, enabled: false }, `${claims.sub} ${mode}`);
      assert.ok(!home.body.signalsUsed.some(x => PERSONAL_SIGNALS.includes(x)));
    }
    assert.deepEqual(s.seen, [], 'no orders read');
    // Partners flag off: member mode is exactly as before (it reads only the member profile).
    s.flags.partners = false;
    for (const mode of ['member', 'trainer']) {
      const a = await s.service.home({ claims: claimsOf(M), query: { mode } });
      const b = await s.legacy.home({ claims: claimsOf(M), query: { mode } });
      assert.equal(JSON.stringify(a.body), JSON.stringify(b.body), mode);
      assert.equal(JSON.stringify(await s.preferences.get({ claims: claimsOf(M), mode })), JSON.stringify(await s.legacyPreferences.get({ claims: claimsOf(M), mode })));
    }
  });
}

test('M1: a suspended member persona with an under-18 date of birth still blocks every mode', async () => {
  const T = { id: 'ts', userType: 'trainer', personId: 'ps' };
  const M = { id: 'ms', userType: 'member', personId: 'ps', accountStatus: 'suspended', memberProfile: { dateOfBirth: MINOR_DOB } };
  const s = setup({ users: [T, M], persons: { ps: { dateOfBirth: ADULT_DOB, gender: 'male' } } });
  tagged(s);
  const prefs = (await s.preferences.get({ claims: claimsOf(T) })).body;
  assert.deepEqual([prefs.available, prefs.uses], [false, []]);
  // Without the suspended persona the same trainer is an adult.
  const s2 = setup({ users: [T], persons: { ps: { dateOfBirth: ADULT_DOB, gender: 'male' } } });
  assert.equal((await s2.preferences.get({ claims: claimsOf(T) })).body.available, true);
});

test('M1: two member personas, one adult and one invalid → nothing; both adult → age from the Person', async () => {
  const T = { id: 'tw', userType: 'trainer', personId: 'pw' };
  const M1 = { id: 'mw1', userType: 'member', personId: 'pw', memberProfile: { dateOfBirth: ADULT_DOB } };
  const M2 = { id: 'mw2', userType: 'member', personId: 'pw', memberProfile: { dateOfBirth: '1990-02-30' } };
  const s = setup({ users: [T, M1, M2], persons: { pw: { dateOfBirth: null } } });
  assert.equal((await s.preferences.get({ claims: claimsOf(T) })).body.available, false);
  assert.equal((await s.preferences.get({ claims: claimsOf(M1), mode: 'member' })).body.available, false, 'member mode too');
  // Both adult: Person 1960 (60_plus) vs member 1990 (30_44) → the Person's age band reorders.
  const ok = setup({ users: [T, { ...M2, memberProfile: { dateOfBirth: ADULT_DOB } }], persons: { pw: { dateOfBirth: '1960-01-01', gender: null } }, env: { SHOP_HOME_SECTIONS: 'recommended' } });
  tagged(ok);
  const rec = sec((await ok.service.home({ claims: claimsOf(T) })).body, 'recommended');
  assert.equal(rec.productIds[0], 'prd_003', 'the 60+ product first');
});

// ── contract check 1: profileSignals ────────────────────────────────────────

test('profileSignals: true in trainer and owner mode only with both flags on; absent otherwise (any availability)', async () => {
  const M = { id: 'mp', userType: 'member', personId: 'pp', memberProfile: { dateOfBirth: ADULT_DOB } };
  const T = { id: 'tp', userType: 'trainer', personId: 'pp' };
  const O = { id: 'op', userType: 'gym_operator', personId: 'pp' };
  const V = { id: 'vp', userType: 'vendor', personId: 'pp' };
  for (const personDob of [null, ADULT_DOB, MINOR_DOB]) {
    const s = setup({ users: [M, T, O, V], persons: { pp: { dateOfBirth: personDob } } });
    for (const mode of ['trainer', 'owner']) {
      const body = (await s.preferences.get({ claims: claimsOf(T), mode })).body;
      assert.equal(body.profileSignals, true, `${personDob} ${mode}`);
      const put = await s.preferences.set({ claims: claimsOf(T), mode, body: { personalised: true, source: 'privacy_page' } });
      assert.equal(put.body.profileSignals, true, 'PUT answer too');
    }
    for (const mode of ['member', 'vendor_personal']) assert.ok(!('profileSignals' in (await s.preferences.get({ claims: claimsOf(T), mode })).body), mode);
    s.flags.partners = false;
    for (const mode of ['trainer', 'owner']) assert.ok(!('profileSignals' in (await s.preferences.get({ claims: claimsOf(T), mode })).body));
    s.flags.on = false; s.flags.partners = true;
    for (const mode of ['trainer', 'owner']) assert.ok(!('profileSignals' in (await s.preferences.get({ claims: claimsOf(T), mode })).body), 'base flag off');
  }
});

// ── security review L2 ──────────────────────────────────────────────────────

test('L2: a refused ?mode is 403 mode_not_allowed before any preference, Person detail or order is read', async () => {
  const s = setup({ users: [TRAINER], persons: { pt: { dateOfBirth: ADULT_DOB } }, orders: [order('t1', [line('prd_001')])] });
  tagged(s);
  let storeReads = 0;
  const get = s.store.get.bind(s.store);
  s.store.get = async (...a) => { storeReads += 1; return get(...a); };
  for (const mode of ['owner', 'member', 'nonsense']) {
    const out = await s.service.home({ claims: claimsOf(TRAINER), query: { mode } });
    assert.deepEqual(out, { error: 'mode_not_allowed', status: 403 }, mode);
    assert.deepEqual(await s.preferences.get({ claims: claimsOf(TRAINER), mode }), { error: 'mode_not_allowed', status: 403 });
  }
  assert.deepEqual([s.reads, s.seen, storeReads], [[], [], 0]);
});
