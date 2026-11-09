// Shop flash sales — the HTTP surface, the flag, the shop home rail, and what must NOT change
// (walk-in/POS prices, vendor settlement rules). Contract: docs/shop-flash-sales-api.md.
// Every function file is mounted the way bfast does (express + guards); the bootstrap services run
// on the real clock, so live sales are stored directly as approved rows around "now".
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { shopService, shopHomeService, users, gyms, partnerGate, trainers } from '../src/bootstrap/services.mjs';
import { partnerSettlementAccounts } from '../src/bootstrap/collections.mjs';
import { createShopHomeService, shopHomeConfigFromEnv } from '../src/services/shop-home-service.mjs';
import { createVendorSettlementService } from '../src/services/vendor-settlement-service.mjs';
import { createPayoutEligibility } from '../src/services/payout-eligibility.mjs';
import { resetShopHomeLimits } from '../functions/shop-home.mjs';
import { resetFlashSaleLimits, FLASH_SALE_RATE_LIMITS } from '../functions/shop-flash-sales.mjs';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';

await ensureInit();

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const express = createRequire(path.join(root, 'package.json'))('express');
const uid = p => `${p}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const FLAGS = ['SHOP_FLASH_SALES', 'SHOP_BANNERS', 'SHOP_HOME_V2', 'SHOP_HOME_MIN_ITEMS', 'SHOP_HOME_CACHE_SECONDS', 'VENDOR_TOOLS', 'VENDOR_WALKIN_SALES'];
const made = { users: [], products: [], orders: [] };
let server; let base;

async function user(userType, extra = {}) {
  const id = uid(userType === 'admin' ? 'adm' : 'usr');
  await db('User').insert({ id, userType, displayName: `Flash ${userType}`, accountStatus: 'active', updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
/** An approved vendor with approved KYC and a verified payout account (may sell and be paid). */
async function vendor(extra = {}) {
  const id = await user('vendor', { approvalStatus: 'approved', createdAt: new Date('2026-01-01T00:00:00Z'), vendorProfile: JSON.stringify({ businessName: `Flash Store ${randomUUID().slice(0, 4)}`, status: 'published' }), ...extra });
  const caseId = uid('kyc');
  await db('PartnerKycCase').insert({ id: caseId, partnerType: 'vendor', userId: id, status: 'approved', tier: 3, updatedAt: new Date() });
  await db('PartnerSettlementAccount').insert({
    id: uid('psa'), caseId, method: 'bank', provider: 'CRDB', accountName: 'Flash Ltd', accountNumber: '0150001234',
    status: 'verified', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z'), cooldownUntil: new Date('2026-09-03T00:00:00Z'), updatedAt: new Date(),
  });
  return id;
}
async function product(vendorId, extra = {}) {
  const id = uid('prd');
  await db('Product').insert({ id, vendorId, name: `Flash route ${id.slice(-4)}`, category: 'equipment', priceTzs: 85_000, discountPriceTzs: 79_000, stock: 10, soldCount: 0, status: 'active', approvalStatus: 'approved', updatedAt: new Date(), createdAt: new Date(), ...extra });
  made.products.push(id);
  // Listed 20 days ago (owner ruling (b): 14 days of price history before a sale may start).
  await db('ProductPriceChange').where({ productId: id }).update({ at: new Date(Date.now() - 20 * DAY) });
  return id;
}
/** A sale stored as approved and live now (a past start can't be sent through the API). */
async function liveSale(vendorId, productId, { salePriceTzs = 69_000, startsAt = new Date(Date.now() - HOUR), endsAt = new Date(Date.now() + DAY), wasPriceTzs = 85_000 } = {}) {
  const id = uid('fls');
  await db('FlashSale').insert({ id, origin: 'vendor', vendorId, productId, salePriceTzs, wasPriceTzs, startsAt, endsAt, status: 'approved', createdBy: vendorId, approvedBy: 'adm_direct', approvedAt: new Date(), editors: JSON.stringify([vendorId]) });
  return id;
}
async function hit(method, url, { claims, body, headers = {} } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}
const CAPS = { 'X-FF-Shop-Caps': 'flash_sale' };
const asVendor = id => ({ sub: id, userType: 'vendor' });
const asMember = id => ({ sub: id, userType: 'member' });
const asAdmin = (id, acl) => ({ sub: id, userType: 'admin', portalUser: true, aclPermissions: acl });
const cart = items => ({ items, deliveryMethod: 'home_delivery', deliveryAddress: 'Sinza', paymentMethod: 'mpesa' });

before(async () => {
  const functionsDir = path.join(root, 'functions');
  const functions = {};
  for (const file of fs.readdirSync(functionsDir).filter(f => f.endsWith('.mjs') && f !== 'index.mjs').sort()) {
    const mod = await import(path.join(functionsDir, file));
    for (const [name, d] of Object.entries(mod)) if (d && typeof d === 'object' && (d.onRequest || d.onGuard)) functions[name] = d;
  }
  const app = express();
  app.use(express.json());
  mountGuards(Object.keys(functions).filter(k => functions[k].onGuard), functions, app);
  mountHttpRoutes(Object.keys(functions).filter(k => functions[k].onRequest), functions, app);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const k of FLAGS) delete process.env[k];
  server?.close();
  await db('FlashSale').whereIn('productId', made.products).del();
  const saleIds = (await db('VendorSale').whereIn('vendorId', made.users).select('id')).map(r => r.id);
  await db('AuditLog').whereIn('target', [...saleIds, ...made.orders, ...made.products]).del();
  await db('AuditLog').where('action', 'like', 'flash_sale.%').whereIn('actor', made.users).del();
  await db('VendorSale').whereIn('vendorId', made.users).del();
  await db('VendorDocumentSequence').whereIn('vendorId', made.users).del();
  await db('VendorSettlementLine').whereIn('vendorId', made.users).del();
  await db('VendorSettlement').whereIn('vendorId', made.users).del();
  if (made.orders.length) {
    await db('ShopOrderLineCost').whereIn('orderId', made.orders).del();
    await db('ShopStockMovement').whereIn('orderId', made.orders).del();
    await db('PaymentRequest').whereIn('orderId', made.orders).del();
    await db('ShopOrder').whereIn('id', made.orders).del();
  }
  await db('ShopStockMovement').whereIn('productId', made.products).del();
  await db('ProductPriceChange').whereIn('productId', made.products).del();
  await db('MarketplaceNotification').whereIn('userId', made.users).del();
  await db('Notification').whereIn('userId', made.users).del();
  await db('Product').whereIn('id', made.products).del();
  const cases = (await db('PartnerKycCase').whereIn('userId', made.users).select('id')).map(r => r.id);
  await db('PartnerSettlementAccount').whereIn('caseId', cases).del();
  await db('PartnerKycCase').whereIn('id', cases).del();
  await db('User').whereIn('id', made.users).del();
  await db.destroy();
});

beforeEach(() => { for (const k of FLAGS) delete process.env[k]; resetFlashSaleLimits(); resetShopHomeLimits(); shopHomeService.clearCache(); });

// ── The flag ────────────────────────────────────────────────────────────────

test('flag off: every flash-sale route answers 404 feature_disabled before sign-in; the merch queue needs the flag for kind=flash_sale; tools options say merch.flashSales', async () => {
  for (const [m, u] of [['GET', '/vendor/flash-sales'], ['POST', '/vendor/flash-sales'], ['GET', '/vendor/flash-sales/price-check?productId=x'], ['GET', '/vendor/flash-sales/x'],
    ['PATCH', '/vendor/flash-sales/x'], ['POST', '/vendor/flash-sales/x/submit'], ['POST', '/vendor/flash-sales/x/withdraw'], ['POST', '/vendor/flash-sales/x/end'],
    ['GET', '/admin/flash-sales/x'], ['POST', '/admin/flash-sales'], ['PATCH', '/admin/flash-sales/x'], ['POST', '/admin/flash-sales/x/submit'],
    ['POST', '/admin/flash-sales/x/approve'], ['POST', '/admin/flash-sales/x/reject'], ['POST', '/admin/flash-sales/x/end'], ['GET', '/admin/shop-merch?kind=flash_sale']]) {
    const r = await hit(m, u, { body: m === 'GET' ? undefined : {} });
    assert.deepEqual([r.status, r.body], [404, { error: 'feature_disabled' }], `${m} ${u}`);
  }
  // Banners on, flash sales off: the banner queue works, the flash-sale kind does not.
  process.env.SHOP_BANNERS = '1';
  const admin = await user('admin');
  assert.equal((await hit('GET', '/admin/shop-merch', { claims: asAdmin(admin, ['promotions']) })).status, 200);
  assert.equal((await hit('GET', '/admin/shop-merch?kind=flash_sale', { claims: asAdmin(admin, ['promotions']) })).status, 404);
  delete process.env.SHOP_BANNERS;
  // Flash sales on, banners off: the flash-sale kind works, the banner queue does not.
  process.env.SHOP_FLASH_SALES = '1';
  assert.equal((await hit('GET', '/admin/shop-merch?kind=flash_sale', { claims: asAdmin(admin, ['promotions']) })).status, 200);
  assert.equal((await hit('GET', '/admin/shop-merch', { claims: asAdmin(admin, ['promotions']) })).status, 404);
  const v = await vendor();
  assert.equal((await hit('GET', '/vendor/tools/options', { claims: asVendor(v) })).body.merch.flashSales, true);
  delete process.env.SHOP_FLASH_SALES;
  assert.equal((await hit('GET', '/vendor/tools/options', { claims: asVendor(v) })).body.merch.flashSales, false);
});

test('flag off: product list, product page, store and checkout are byte-identical with a live approved sale stored', async () => {
  const v = await vendor();
  const p = await product(v);
  const member = await user('member');
  const snap = async () => ({
    list: JSON.stringify((await hit('GET', `/shop/products?vendorId=${v}`, { claims: asMember(member) })).body),
    filtered: JSON.stringify((await hit('GET', `/shop/products?vendorId=${v}&maxPrice=70000&flashSale=true&promotions=true&sort=price_asc`, { claims: asMember(member) })).body),
    detail: JSON.stringify((await hit('GET', `/shop/products/${p}`, { claims: asMember(member) })).body),
    store: JSON.stringify((await hit('GET', `/shop/vendors/${v}`, { claims: asMember(member) })).body),
  });
  const before = await snap();
  const saleId = await liveSale(v, p);
  const during = await snap();
  assert.deepEqual(during, before, 'nothing a buyer reads changes while the flag is off');
  assert.ok(!during.list.includes('effectivePriceTzs') && !during.list.includes(saleId));
  // Checkout: the standing price (79,000), expectedPriceTzs ignored, no flashSaleId.
  const out = await hit('POST', '/me/shop-orders', { claims: asMember(member), body: cart([{ productId: p, qty: 1, expectedPriceTzs: 1 }]) });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  made.orders.push(out.body.id);
  assert.deepEqual([out.body.totalTzs, out.body.items[0].priceTzs, 'flashSaleId' in out.body.items[0]], [79_000, 79_000, false]);
});

test('shop home: flag off byte-identical and the sale store never read; on: flash_sale rail first (≥ 4), endsAt, reasons, sale rows, not in Deals; 1–3 sales: no rail, price still shown', async () => {
  const at = new Date('2026-11-05T08:00:00.000Z');
  const prod = (i, extra = {}) => ({ id: `p${i}`, vendorId: 'v1', name: `Item ${i}`, category: 'equipment', priceTzs: 50_000, discountPriceTzs: 45_000, stock: 3, status: 'active', approvalStatus: 'approved', createdAt: '2026-10-01T00:00:00Z', ...extra });
  const catalogue = Array.from({ length: 10 }, (_, i) => prod(i));
  const sale = (i, endsIn) => ({ id: `s${i}`, productId: `p${i}`, vendorId: 'v1', status: 'approved', salePriceTzs: 40_000 - i * 1_000, wasPriceTzs: 50_000, startsAt: '2026-11-05T07:00:00.000Z', endsAt: new Date(at.getTime() + endsIn).toISOString() });
  let reads = 0;
  const deps = (live = []) => ({
    shopService: { listProducts: async () => catalogue },
    discoveryService: { discover: async () => ({ featured: [] }) },
    promotionService: { listLive: async () => [] },
    users: { findByIdAsync: async id => ({ id, userType: 'member' }), filterByColumnInAsync: async () => [] },
    trainerService: null, identityLink: null, recentPaidOrders: async () => [],
    config: () => shopHomeConfigFromEnv({ SHOP_HOME_MIN_ITEMS: '4' }), now: () => at,
    flashSales: { liveByProduct: async () => { reads += 1; return new Map(live.map(s => [s.productId, s])); } },
  });
  const claims = { sub: 'usr_m', userType: 'member' };
  const phase1 = createShopHomeService({ ...deps(), flashSales: null });
  const off = createShopHomeService({ ...deps([sale(1, HOUR)]), flashSalesOn: () => false });
  assert.equal(JSON.stringify((await off.home({ claims })).body), JSON.stringify((await phase1.home({ claims })).body), 'byte-identical');
  assert.equal(reads, 0, 'the sale store is not even read');

  const four = [sale(1, 5 * HOUR), sale(2, 2 * HOUR), sale(3, 9 * HOUR), sale(4, 3 * HOUR)];
  const caps = { flashSale: true };
  const on = (await createShopHomeService({ ...deps(four), flashSalesOn: () => true }).home({ claims, caps })).body;
  assert.deepEqual(on.flashSales, { enabled: true });
  const [first] = on.sections;
  assert.equal(first.key, 'flash_sale');
  assert.deepEqual(first.title, { en: 'Flash sale', sw: 'Ofa ya muda mfupi' });
  assert.deepEqual(first.reasonCodes, ['flash_sale_seller_discount']);
  assert.equal(first.endsAt, new Date(at.getTime() + 2 * HOUR).toISOString(), 'the earliest end shown');
  assert.deepEqual(first.productIds, ['p4', 'p3', 'p2', 'p1'], 'deepest discount first');
  assert.deepEqual(first.viewAll, { path: '/shop/products', query: { category: 'equipment', flashSale: 'true' } });
  assert.deepEqual(on.products.p4.sale, { id: 's4', salePriceTzs: 36_000, wasPriceTzs: 50_000, regularPriceTzs: 50_000, discountPct: 28, startsAt: '2026-11-05T07:00:00.000Z', endsAt: four[3].endsAt, serverNow: at.toISOString() });
  assert.equal(on.products.p4.effectivePriceTzs, 36_000);
  for (const s of on.sections.slice(1)) for (const id of ['p1', 'p2', 'p3', 'p4']) assert.ok(!s.productIds.includes(id), `${id} is in no other rail (${s.key})`);
  // Deals alone (SHOP_HOME_SECTIONS=deals): every seller-discounted product except those in a live sale.
  const dealsOnly = cfgSections => ({ config: () => shopHomeConfigFromEnv({ SHOP_HOME_MIN_ITEMS: '4', SHOP_HOME_SECTIONS: cfgSections }) });
  const d = (await createShopHomeService({ ...deps(four.slice(0, 3)), ...dealsOnly('deals'), flashSalesOn: () => true }).home({ claims, caps })).body;
  assert.deepEqual(d.sections.map(s => s.key), ['deals'], 'three live sales: no flash rail');
  assert.deepEqual([...d.sections[0].productIds].sort(), ['p0', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'], 'never a Deal while in a live sale, rail or not');
  const dOff = (await createShopHomeService({ ...deps(four.slice(0, 3)), ...dealsOnly('deals'), flashSalesOn: () => false }).home({ claims })).body;
  assert.equal(dOff.sections[0].productIds.length, 10, 'flag off: Deals as before');

  // Three live sales: no rail; the products still show their sale price wherever they appear; never in Deals.
  const three = (await createShopHomeService({ ...deps(four.slice(0, 3)), flashSalesOn: () => true }).home({ claims, caps })).body;
  assert.ok(!three.sections.some(s => s.key === 'flash_sale'));
  assert.ok(!three.sections.find(s => s.key === 'deals')?.productIds.some(id => ['p1', 'p2', 'p3'].includes(id)));
  for (const id of ['p1', 'p2', 'p3']) if (three.products[id]) assert.equal(three.products[id].sale.id, `s${id.slice(1)}`);
  // A scheduled sale (not live yet) shows nothing; a sale from another vendor id is ignored.
  const notYet = { ...sale(5, DAY), startsAt: '2026-11-05T09:00:00.000Z' };
  const foreign = { ...sale(6, DAY), vendorId: 'v2' };
  const odd = (await createShopHomeService({ ...deps([notYet, foreign]), flashSalesOn: () => true }).home({ claims, caps })).body;
  for (const id of ['p5', 'p6']) if (odd.products[id]) assert.equal(odd.products[id].sale, undefined);
  // A failed sale read leaves the page at stored prices.
  const broken = await createShopHomeService({ ...deps(), flashSales: { liveByProduct: async () => { throw new Error('db down'); } }, flashSalesOn: () => true, logger: { error() {} } }).home({ claims, caps });
  assert.ok(!broken.body.sections.some(s => s.key === 'flash_sale'));

  // Contract (1): a client without X-FF-Shop-Caps: flash_sale gets no flash_sale section and no `sale`
  // objects — but is still charged, and shown as effectivePriceTzs, the sale price; Deals still leaves them out.
  const plain = (await createShopHomeService({ ...deps(four), flashSalesOn: () => true }).home({ claims })).body;
  assert.ok(!plain.sections.some(s => s.key === 'flash_sale'));
  assert.ok(!JSON.stringify(plain.products).includes('"sale"'));
  for (const id of ['p1', 'p2', 'p3', 'p4']) if (plain.products[id]) assert.equal(plain.products[id].effectivePriceTzs, four.find(x => x.productId === id).salePriceTzs);
  const plainDeals = (await createShopHomeService({ ...deps(four), ...dealsOnly('deals'), flashSalesOn: () => true }).home({ claims })).body;
  assert.ok(!plainDeals.sections[0].productIds.some(id => ['p1', 'p2', 'p3', 'p4'].includes(id)));
});

// ── The HTTP surface with the flag on ───────────────────────────────────────

test('routes: vendor proposes (staff need `products`), price check, admin queue and two-person approval, price lock and checkout 409 through HTTP', async () => {
  process.env.SHOP_FLASH_SALES = '1';
  const v = await vendor();
  const p = await product(v, { discountPriceTzs: 0, priceTzs: 100_000 });
  const startsAt = new Date(Date.now() + 2 * HOUR).toISOString();
  const endsAt = new Date(Date.now() + 2 * HOUR + DAY).toISOString();
  const noPerm = await user('vendor_staff', { vendorId: v, vendorPermissions: ['orders'], vendorRole: 'sales' });
  assert.deepEqual((await hit('POST', '/vendor/flash-sales', { claims: { sub: noPerm, userType: 'vendor_staff', vendorId: v }, body: { productId: p, salePriceTzs: 80_000, startsAt, endsAt } })).body, { error: 'vendor_permission_forbidden', requiredPermission: 'products' });
  const staff = await user('vendor_staff', { vendorId: v, vendorPermissions: ['products'], vendorRole: 'inventory_manager' });
  const staffClaims = { sub: staff, userType: 'vendor_staff', vendorId: v };
  const created = await hit('POST', '/vendor/flash-sales', { claims: staffClaims, body: { productId: p, salePriceTzs: 80_000, startsAt, endsAt } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.sale.id;
  const check = await hit('GET', `/vendor/flash-sales/price-check?productId=${p}&startsAt=${encodeURIComponent(startsAt)}`, { claims: asVendor(v) });
  assert.deepEqual([check.status, check.body.ok, check.body.maxSalePriceTzs], [200, true, 95_000]);
  assert.equal((await hit('POST', `/vendor/flash-sales/${id}/submit`, { claims: asVendor(v) })).body.sale.effectiveStatus, 'pending_approval');

  const runner = await user('admin');
  const approver = await user('admin');
  const queue = await hit('GET', '/admin/shop-merch?kind=flash_sale&tab=requests', { claims: asAdmin(runner, ['promotions']) });
  assert.ok(queue.body.items.some(i => i.id === id));
  // Only promotions_approve decides.
  assert.equal((await hit('POST', `/admin/flash-sales/${id}/approve`, { claims: asAdmin(runner, ['promotions']), body: { revision: 1 } })).status, 403);
  const approved = await hit('POST', `/admin/flash-sales/${id}/approve`, { claims: asAdmin(approver, ['promotions_approve']), body: { revision: 1 } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual([approved.body.sale.effectiveStatus, approved.body.sale.wasPriceTzs, approved.body.sale.ownItem], ['approved', 100_000, false]);
  const inbox = await db('MarketplaceNotification').where({ userId: v, type: 'flash_sale_approved' });
  assert.equal(inbox.length, 1);

  // Price lock through PUT /vendor/products/:id.
  const locked = await hit('PUT', `/vendor/products/${p}`, { claims: asVendor(v), body: { priceTzs: 120_000 } });
  assert.deepEqual([locked.status, locked.body.error, locked.body.saleId, locked.body.reason], [409, 'sale_conflict', id, 'price_locked_by_flash_sale']);
  assert.equal((await hit('PUT', `/vendor/products/${p}`, { claims: asVendor(v), body: { priceTzs: 100_000, stock: 9 } })).status, 200);
  const mine = await hit('GET', '/vendor/products', { claims: asVendor(v) });
  assert.equal(mine.body.find(r => r.id === p).priceLock.saleId, id);

  // A live sale through checkout: the HTTP body carries the lines and totals.
  const q = await product(v);
  await liveSale(v, q);
  const member = await user('member');
  const list = await hit('GET', `/shop/products?vendorId=${v}&flashSale=true`, { claims: asMember(member), headers: CAPS });
  assert.deepEqual(list.body.map(r => [r.id, r.effectivePriceTzs, r.sale.salePriceTzs]), [[q, 69_000, 69_000]]);
  const conflict = await hit('POST', '/me/shop-orders', { claims: asMember(member), body: cart([{ productId: q, qty: 1, expectedPriceTzs: 79_000 }]) });
  assert.deepEqual({ status: conflict.status, body: conflict.body }, { status: 409, body: { error: 'price_changed', productId: q, currentPriceTzs: 69_000, lines: [{ productId: q, variant: null, expectedPriceTzs: 79_000, currentPriceTzs: 69_000, reason: 'sale_started' }], expectedTotalTzs: 79_000, totalTzs: 69_000 } });
  const ok = await hit('POST', '/me/shop-orders', { claims: asMember(member), body: cart([{ productId: q, qty: 1, expectedPriceTzs: 69_000 }]) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  made.orders.push(ok.body.id);
  assert.deepEqual([ok.body.totalTzs, ok.body.items[0].priceTzs, ok.body.items[0].commissionTzs], [69_000, 69_000, undefined], 'buyers never see the commission');
  const stored = await db('ShopOrder').where({ id: ok.body.id }).first();
  assert.deepEqual([stored.items[0].commissionTzs, stored.items[0].vendorPayoutTzs], [6_900, 62_100]);
});

test('rate limit: 20 creates a minute per vendor, then 429 rate_limited', async () => {
  process.env.SHOP_FLASH_SALES = '1';
  const v = await vendor();
  let last;
  for (let i = 0; i <= FLASH_SALE_RATE_LIMITS.create; i += 1) last = await hit('POST', '/vendor/flash-sales', { claims: asVendor(v), body: {} });
  assert.deepEqual([last.status, last.body.error], [429, 'rate_limited']);
});

// ── What must not change ────────────────────────────────────────────────────

test('walk-in (POS) prices are unaffected by a live flash sale', async () => {
  process.env.SHOP_FLASH_SALES = '1';
  process.env.VENDOR_TOOLS = '1';
  process.env.VENDOR_WALKIN_SALES = '1';
  const v = await vendor();
  const p = await product(v);
  await liveSale(v, p);
  const member = await user('member');
  assert.equal((await hit('GET', `/shop/products/${p}`, { claims: asMember(member) })).body.effectivePriceTzs, 69_000, 'the app price is the sale price');
  const sold = await hit('POST', '/vendor/sales', { claims: asVendor(v), body: { clientRef: randomUUID(), soldAt: new Date().toISOString(), lines: [{ productId: p, qty: 1 }], payments: [{ method: 'cash', amountTzs: 79_000 }] } });
  assert.equal(sold.status, 201, JSON.stringify(sold.body));
  assert.deepEqual([sold.body.sale.lines[0].listPriceTzs, sold.body.sale.lines[0].unitPriceTzs, sold.body.sale.totalTzs], [79_000, 79_000, 79_000]);
});

test('vendor settlement: an order placed in a flash sale is settled on its sale-price lines; no settlement rule changed', async () => {
  process.env.SHOP_FLASH_SALES = '1';
  const v = await vendor();
  const p = await product(v);
  await liveSale(v, p);
  const member = await user('member');
  const out = await hit('POST', '/me/shop-orders', { claims: asMember(member), body: cart([{ productId: p, qty: 2 }]) });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  made.orders.push(out.body.id);
  // Delivered and paid in the week of 1–7 March 2027 (an otherwise empty week).
  await db('ShopOrder').where({ id: out.body.id }).update({
    status: 'delivered', paymentStatus: 'paid', settlementStatus: 'pending',
    timeline: JSON.stringify([{ status: 'pending', at: '2027-03-02T08:00:00Z' }, { status: 'delivered', at: '2027-03-03T10:00:00Z' }]),
    fulfilments: JSON.stringify([{ vendorId: v, status: 'delivered', timeline: [{ status: 'delivered', at: '2027-03-03T10:00:00Z' }], updatedAt: '2027-03-03T10:00:00Z' }]),
  });
  const eligibility = createPayoutEligibility({ users, gyms, partnerGate, partnerSettlementAccounts, trainers });
  const settle = createVendorSettlementService({ users, payoutEligibility: eligibility, now: () => new Date('2027-03-10T09:00:00Z'), notify: async () => {} });
  const maker = await user('admin');
  const prepared = await settle.prepare({ actorId: maker });
  const mine = prepared.statements.filter(s => s.vendorId === v);
  assert.equal(mine.length, 1, JSON.stringify(prepared));
  const detail = await settle.get(mine[0].id);
  // 2 × 69,000 = 138,000 sales; 10 % commission 13,800; the vendor receives 124,200.
  assert.deepEqual([detail.statement.salesTzs, detail.statement.commissionTzs, detail.statement.finalNetTzs], [138_000, 13_800, 124_200]);
  assert.deepEqual(detail.lines.map(l => [l.orderId, l.salesTzs, l.payoutTzs]), [[out.body.id, 138_000, 124_200]]);
});

test('contract (1)(2): X-FF-Shop-Caps gates the `sale` object (tolerant parsing), everyone pays the sale price; serverNow on product answers', async () => {
  process.env.SHOP_FLASH_SALES = '1';
  const v = await vendor();
  const p = await product(v);
  await liveSale(v, p);
  const member = await user('member');
  const list = async headers => (await hit('GET', `/shop/products?vendorId=${v}`, { claims: asMember(member), headers })).body[0];
  const none = await list({});
  assert.deepEqual([none.effectivePriceTzs, 'sale' in none], [69_000, false], 'no header: the price, not the sale object');
  for (const value of ['flash_sale', ' Flash_Sale ', 'other,flash_sale', 'x; FLASH_SALE ;y', 'a b flash_sale']) {
    assert.equal((await list({ 'X-FF-Shop-Caps': value })).sale?.salePriceTzs, 69_000, JSON.stringify(value));
  }
  for (const value of ['flash-sale', 'flashsale', 'flash_sales', '']) assert.equal('sale' in (await list({ 'X-FF-Shop-Caps': value })), false, JSON.stringify(value));
  // serverNow: header on lists, top-level on the product page and inside each sale.
  const r = await hit('GET', `/shop/products?vendorId=${v}`, { claims: asMember(member), headers: CAPS });
  const stamped = r.headers.get('x-ff-server-now');
  assert.ok(Number.isFinite(new Date(stamped).getTime()));
  assert.ok(Math.abs(new Date(r.body[0].sale.serverNow).getTime() - Date.now()) < 60_000);
  const page = await hit('GET', `/shop/products/${p}`, { claims: asMember(member), headers: CAPS });
  assert.ok(page.body.serverNow && page.body.sale.serverNow);
  const pagePlain = await hit('GET', `/shop/products/${p}`, { claims: asMember(member) });
  assert.deepEqual([pagePlain.body.effectivePriceTzs, 'sale' in pagePlain.body, Boolean(pagePlain.body.serverNow)], [69_000, false, true]);
  assert.ok((pagePlain.body.similarProducts || []).every(x => !('sale' in x)));
  const store = await hit('GET', `/shop/vendors/${v}`, { claims: asMember(member) });
  assert.ok(store.body.products.every(x => !('sale' in x)) && store.body.serverNow);
  // Everyone is charged the sale price.
  const out = await hit('POST', '/me/shop-orders', { claims: asMember(member), body: cart([{ productId: p, qty: 1 }]) });
  made.orders.push(out.body.id);
  assert.equal(out.body.totalTzs, 69_000);
  // Flag off: no serverNow anywhere.
  delete process.env.SHOP_FLASH_SALES;
  const off = await hit('GET', `/shop/products/${p}`, { claims: asMember(member), headers: CAPS });
  assert.deepEqual(['serverNow' in off.body, off.headers.get('x-ff-server-now')], [false, null]);
});

test('contract (5): GET /admin/flash-sale-products — promotions or promotions_approve may read it, no `shop` scope needed', async () => {
  process.env.SHOP_FLASH_SALES = '1';
  const v = await vendor();
  const tag = randomUUID().slice(0, 6);
  const p = await product(v, { name: `Route picker ${tag}` });
  const admin = await user('admin');
  for (const acl of [['promotions'], ['promotions_approve']]) {
    const r = await hit('GET', `/admin/flash-sale-products?q=${encodeURIComponent(`route picker ${tag}`)}`, { claims: asAdmin(admin, acl) });
    assert.deepEqual([r.status, r.body.items.map(i => i.id)], [200, [p]], acl.join());
  }
  assert.equal((await hit('GET', '/admin/flash-sale-products', { claims: asAdmin(admin, ['shop']) })).status, 403);
});
