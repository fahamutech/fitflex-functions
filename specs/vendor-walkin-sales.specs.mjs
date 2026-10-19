// Vendor business tools · S3 — walk-in (counter) sales.
// Against the CI database: no oversell against app reservations, a retried sale recorded once,
// continuous receipt numbers and a void that gives stock back once are the database's guarantees.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { users, gyms, partnerGate, trainers, shopService, adminPaymentService } from '../src/bootstrap/services.mjs';
import { partnerSettlementAccounts } from '../src/bootstrap/collections.mjs';
import { createPayoutEligibility } from '../src/services/payout-eligibility.mjs';
import { createVendorSettlementService } from '../src/services/vendor-settlement-service.mjs';
import { vendorToolsOptionsRoute, vendorCreateProduct, vendorStockMovements, vendorCreateStaff, createShopOrder, vendorPayments } from '../functions/shop.mjs';
import { vendorRecordSale, vendorListSales, vendorGetSale, vendorVoidSale, allowVendorSale, resetVendorSalesLimits, VENDOR_SALES_LIMIT } from '../functions/vendor-sales.mjs';
import { allocate, priceSale, parseSale, walkInPrice } from '../src/shared/vendor-sale.mjs';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';

const migration = createRequire(import.meta.url)('../db/migrations/20261230120000-vendor-walkin-sales.cjs');

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [], orders: [], persons: [] };
const FLAGS = ['VENDOR_TOOLS', 'VENDOR_WALKIN_SALES', 'VENDOR_STOCK_LEDGER'];
const salesOn = () => { process.env.VENDOR_TOOLS = '1'; process.env.VENDOR_WALKIN_SALES = '1'; };
const ledgerOn = () => { salesOn(); process.env.VENDOR_STOCK_LEDGER = '1'; };
afterEach(() => { for (const f of FLAGS) delete process.env[f]; });

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    type() { return this; },
    send(b) { this.body = b; return this; },
  };
}
async function call(route, claims, { params = {}, query = {}, body = {} } = {}) {
  const all = { authorization: `Bearer ${sign(claims)}` };
  const req = { headers: all, params, query, body, get: name => all[String(name).toLowerCase()] ?? null };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return { status: out.statusCode, body: out.body };
  }
  await route.onRequest(req, out);
  // headers are kept off the enumerable keys, so results compare as { status, body }.
  return Object.defineProperty({ status: out.statusCode, body: out.body }, 'headers', { value: out.headers });
}

async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Walk-in ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
/** A vendor who may sell on the app too: created before KYC enforcement, approved KYC, verified payout account. */
async function vendor(extra = {}) {
  const id = await user('vendor', { createdAt: new Date('2026-01-01T00:00:00Z'), displayName: 'Asha Owner', vendorProfile: JSON.stringify({ businessName: 'Counter Shop', status: 'published' }), ...extra });
  const caseId = uid('kyc');
  await db('PartnerKycCase').insert({ id: caseId, partnerType: 'vendor', userId: id, status: 'approved', tier: 3, updatedAt: new Date() });
  await db('PartnerSettlementAccount').insert({
    id: uid('psa'), caseId, method: 'bank', provider: 'CRDB', accountName: 'Counter Shop', accountNumber: '0150001234',
    status: 'verified', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z'), cooldownUntil: new Date('2026-09-03T00:00:00Z'), updatedAt: new Date(),
  });
  return id;
}
const as = id => ({ sub: id, userType: 'vendor' });
const staffOf = (id, vendorId) => ({ sub: id, userType: 'vendor_staff', vendorId });
const staff = (vendorId, permissions, extra = {}) => user('vendor_staff', { vendorId, vendorPermissions: permissions, accountStatus: 'active', vendorRole: 'sales', displayName: 'Juma Seller', ...extra });

/** A product of the vendor, listed and approved (so app buyers can order it too). */
async function product(vendorId, body = {}, { approve = true } = {}) {
  const out = await call(vendorCreateProduct, as(vendorId), { body: { name: 'Whey 1kg', category: 'supplements_nutrition', priceTzs: 45_000, stock: 10, ...body } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  made.products.push(out.body.id);
  if (approve) await shopService.adminUpdateProductListing({ productId: out.body.id, body: { approvalStatus: 'approved' }, actorId: 'adm_walkin' });
  return out.body;
}
const row = id => db('Product').where({ id }).first();
const saleBody = (lines, payments, extra = {}) => ({ clientRef: randomUUID(), soldAt: new Date().toISOString(), lines, payments, ...extra });
const cash = amountTzs => [{ method: 'cash', amountTzs }];
const sell = (claims, body) => call(vendorRecordSale, claims, { body });
const ledgerOf = productId => db('ShopStockMovement').where({ productId }).orderBy([{ column: 'createdAt' }, { column: 'id' }]);
const cart = items => ({ items, deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni', paymentMethod: 'mpesa' });
async function appOrder(buyerId, items) {
  const out = await call(createShopOrder, { sub: buyerId, userType: 'member' }, { body: cart(items) });
  if (out.body?.id) made.orders.push(out.body.id);
  return out;
}
const saleIdsOf = vendorIds => db('VendorSale').whereIn('vendorId', vendorIds).select('id');

after(async () => {
  for (const s of servers) s.close();
  const saleIds = (await saleIdsOf(made.users)).map(r => r.id);
  await db('AuditLog').whereIn('target', [...saleIds, ...made.orders, ...made.products]).del();
  await db('VendorSale').whereIn('vendorId', made.users).del(); // lines and payments go with it (ON DELETE CASCADE)
  await db('VendorDocumentSequence').whereIn('vendorId', made.users).del();
  await db('VendorSettlementLine').whereIn('vendorId', made.users).del();
  await db('VendorSettlement').whereIn('vendorId', made.users).del();
  await db('ShopOrderLineCost').whereIn('orderId', made.orders).del();
  await db('ShopStockMovement').whereIn('productId', made.products).del();
  await db('MarketplaceNotification').whereIn('userId', made.users).del();
  await db('Notification').whereIn('userId', made.users).del();
  await db('CommunicationPreference').whereIn('id', made.users).del();
  await db('PaymentRequest').whereIn('orderId', made.orders).del();
  await db('ShopOrder').whereIn('id', made.orders).del();
  await db('Product').whereIn('id', made.products).del();
  await db('Invitation').whereIn('vendorId', made.users).del();
  await db('OrgMembership').whereIn('vendorId', made.users).del();
  await db('Vendor').whereIn('id', made.users).del();
  await db('Person').whereIn('id', made.persons).del();
  await db('PartnerSettlementAccount').whereIn('caseId', db('PartnerKycCase').whereIn('userId', made.users).select('id')).del();
  await db('PartnerKycCase').whereIn('userId', made.users).del();
  await db('User').whereIn('id', made.users).del().catch(() => {});
  await db.destroy();
});

// ── mounted as bfast-function mounts it (guards by path prefix) ──────────────

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const express = createRequire(path.join(root, 'package.json'))('express');
const functionsDir = path.join(root, 'functions');
const functions = {};
for (const file of fs.readdirSync(functionsDir).filter(f => f.endsWith('.mjs') && f !== 'index.mjs').sort()) {
  const mod = await import(path.join(functionsDir, file));
  for (const [name, d] of Object.entries(mod)) if (d && typeof d === 'object' && (d.onRequest || d.onGuard)) functions[`${file}:${name}`] = d;
}
const app = express();
app.use(express.json());
mountGuards(Object.keys(functions).filter(k => functions[k].onGuard), functions, app);
mountHttpRoutes(Object.keys(functions).filter(k => functions[k].onRequest), functions, app);
const servers = [];
const server = app.listen(0);
servers.push(server);
const base = `http://127.0.0.1:${server.address().port}`;
async function hit(method, url, claims, body) {
  const r = await fetch(`${base}${url}`, {
    method, headers: { 'content-type': 'application/json', ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: parsed };
}

// ── pure rules ───────────────────────────────────────────────────────────────

test('rules: walk-in price, line discount for the whole line, subtotal before discounts, sale discount allocated exactly, cash-only change', () => {
  assert.equal(walkInPrice({ priceTzs: 20_000, discountPriceTzs: 18_000 }), 18_000);
  assert.equal(walkInPrice({ priceTzs: 20_000, discountPriceTzs: 25_000 }), 20_000, 'a discount price above the price is ignored');
  assert.equal(walkInPrice({ priceTzs: 20_000 }), 20_000);
  const priced = [
    { productId: 'a', variant: 'Chocolate', qty: 2, unitPriceTzs: null, discountTzs: 5_000, listPriceTzs: 45_000 },
    { productId: 'b', variant: null, qty: 1, unitPriceTzs: null, discountTzs: 0, listPriceTzs: 10_000 },
  ];
  const out = priceSale(priced, 0, [{ method: 'cash', amountTzs: 60_000 }, { method: 'mpesa', amountTzs: 40_000, reference: 'QK12AB34' }]);
  assert.deepEqual([out.subtotalTzs, out.lineDiscountTzs, out.discountTzs, out.totalTzs, out.paidTzs, out.changeTzs], [100_000, 5_000, 0, 95_000, 100_000, 5_000]);
  assert.deepEqual(out.lines.map(l => l.lineTotalTzs), [85_000, 10_000]);
  const withSale = priceSale(priced, 1_001, [{ method: 'cash', amountTzs: 93_999 }]);
  assert.equal(withSale.totalTzs, 93_999);
  assert.equal(withSale.lines.reduce((s, l) => s + l.saleDiscountShareTzs, 0), 1_001, 'the sale discount is split exactly');
  assert.deepEqual(allocate(10, [10, 10, 10]), [4, 3, 3]);
  assert.deepEqual(allocate(3, [1, 1, 1]), [1, 1, 1], 'no share above its line');
  assert.deepEqual(allocate(0, [5, 5]), [0, 0]);
  assert.equal(priceSale(priced, 95_001, []).error, 'discount_exceeds_price');
  assert.deepEqual(priceSale([{ ...priced[1], discountTzs: 10_001 }], 0, []), { error: 'discount_exceeds_price', status: 400, productId: 'b', variant: null, maxTzs: 10_000 });
  assert.equal(priceSale(priced, 0, [{ method: 'mpesa', amountTzs: 100_000, reference: 'X' }]).reason, 'non_cash_over_total');
  assert.deepEqual(priceSale(priced, 0, cash(90_000)), { error: 'payment_short', status: 409, totalTzs: 95_000, paidTzs: 90_000, shortTzs: 5_000 });
  // L2: change at most total + 1,000,000; paid at most 100,000,000.
  assert.equal(priceSale(priced, 0, cash(95_000 + 95_000 + 1_000_000)).changeTzs, 1_095_000);
  assert.deepEqual(priceSale(priced, 0, cash(95_000 + 95_000 + 1_000_001)), { error: 'invalid_payment', status: 400, reason: 'change_too_large', maxChangeTzs: 1_095_000 });
  assert.equal(priceSale(priced, 0, [{ method: 'cash', amountTzs: 60_000_000 }, { method: 'cash', amountTzs: 60_000_000 }]).reason, 'paid_too_large');
  assert.equal(parseSale({ clientRef: 'x'.repeat(10), lines: [{ productId: 'a', qty: 1 }], payments: [{ method: 'bank', amountTzs: 1 }] }).error, 'reference_required');
  assert.equal(parseSale({ clientRef: 'x'.repeat(10), lines: [{ productId: 'a', qty: 1 }], payments: [{ method: 'card', amountTzs: 1 }] }).error, undefined, 'card: reference optional');
  assert.equal(parseSale({ clientRef: 'x'.repeat(10), lines: [{ productId: 'a', qty: 1 }], payments: [{ method: 'cheque', amountTzs: 1 }] }).error, 'invalid_payment');
});

// ── flag and discovery ───────────────────────────────────────────────────────

test('flag off: every /vendor/sales endpoint answers 404 feature_disabled and nothing moves; options show walkInSales only with both flags', async () => {
  const v = await vendor();
  const p = await product(v, { stock: 3 });
  for (const [route, opts] of [[vendorRecordSale, { body: saleBody([{ productId: p.id, qty: 1 }], cash(45_000)) }], [vendorListSales, {}], [vendorGetSale, { params: { id: 'sal_x' } }], [vendorVoidSale, { params: { id: 'sal_x' }, body: { reason: 'test' } }]]) {
    assert.deepEqual(await call(route, as(v), opts), { status: 404, body: { error: 'feature_disabled' } });
  }
  assert.equal((await row(p.id)).stock, 3);
  assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.walkInSales, false);
  process.env.VENDOR_WALKIN_SALES = '1';
  assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.walkInSales, false, 'no umbrella, no tool');
  assert.equal((await call(vendorRecordSale, as(v), { body: saleBody([{ productId: p.id, qty: 1 }], cash(45_000)) })).status, 404);
  process.env.VENDOR_TOOLS = '1';
  assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.walkInSales, true);
});

// ── recording ────────────────────────────────────────────────────────────────

test('POST /vendor/sales: split payment with change, R-000001 then R-000002, stock leaves with a `sale` ledger row, cost snapshotted but never sent, no ShopOrder / PaymentRequest', async () => {
  salesOn();
  const v = await vendor();
  const whey = await product(v, { name: 'Whey 1kg', priceTzs: 45_000, stock: 10 });
  const shaker = await product(v, { name: 'Shaker', priceTzs: 10_000, stock: 5 });
  await db('ProductPrivate').insert({ productId: whey.id, variant: '', vendorId: v, costTzs: 30_000, updatedAt: new Date() });
  const orders = Number((await db('ShopOrder').count({ n: '*' }).first()).n);
  const requests = Number((await db('PaymentRequest').count({ n: '*' }).first()).n);

  const body = saleBody([{ productId: whey.id, qty: 2, discountTzs: 5_000 }, { productId: shaker.id, qty: 1 }],
    [{ method: 'cash', amountTzs: 60_000 }, { method: 'mpesa', amountTzs: 40_000, reference: ' qk12ab34 ' }], { note: 'Regular customer' });
  const out = await sell(as(v), body);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const s = out.body.sale;
  assert.equal(s.number, 'R-000001');
  assert.deepEqual([s.status, s.kind, s.subtotalTzs, s.lineDiscountTzs, s.discountTzs, s.totalTzs, s.paidTzs, s.changeTzs], ['completed', 'cash', 100_000, 5_000, 0, 95_000, 100_000, 5_000]);
  assert.deepEqual(s.createdBy, { id: v, name: 'Asha Owner' });
  assert.equal(s.voidedBy, null);
  assert.equal(s.note, 'Regular customer');
  assert.equal(s.clientRef, body.clientRef);
  assert.ok(s.recordedAt && s.soldAt);
  assert.deepEqual(s.lines.map(l => [l.productId, l.nameSnapshot, l.qty, l.listPriceTzs, l.unitPriceTzs, l.priceChanged, l.discountTzs, l.lineTotalTzs]),
    [[whey.id, 'Whey 1kg', 2, 45_000, 45_000, false, 5_000, 85_000], [shaker.id, 'Shaker', 1, 10_000, 10_000, false, 0, 10_000]]);
  assert.deepEqual(s.payments, [{ method: 'cash', amountTzs: 60_000, reference: null }, { method: 'mpesa', amountTzs: 40_000, reference: 'qk12ab34' }]);
  assert.equal(JSON.stringify(out.body).includes('unitCost'), false, 'the cost price never leaves the server in S3');
  assert.equal(JSON.stringify(out.body).includes('fingerprint'), false);

  const lines = await db('VendorSaleLine').where({ saleId: s.id }).orderBy('lineNo');
  assert.deepEqual(lines.map(l => l.unitCostTzs), [30_000, null], 'cost snapshot from ProductPrivate (null when unknown)');
  assert.equal((await row(whey.id)).stock, 8);
  assert.equal((await row(shaker.id)).stock, 4);
  assert.equal(Number((await row(whey.id)).soldCount || 0), 0, 'walk-in sales do not count toward marketplace popularity');
  const moves = (await ledgerOf(whey.id)).filter(m => m.reason === 'sale');
  assert.deepEqual(moves.map(m => [m.kind, Number(m.delta), Number(m.stockAfter), m.sourceId, m.vendorId, m.actorId, m.orderId]), [['sale', -2, 8, s.id, v, v, null]]);
  assert.equal(Number((await db('ShopOrder').count({ n: '*' }).first()).n), orders, 'no ShopOrder');
  assert.equal(Number((await db('PaymentRequest').count({ n: '*' }).first()).n), requests, 'no PaymentRequest');

  const second = await sell(as(v), saleBody([{ productId: shaker.id, qty: 1 }], cash(10_000)));
  assert.equal(second.body.sale.number, 'R-000002');
  const other = await vendor();
  const otherProduct = await product(other, { stock: 1 });
  assert.equal((await sell(as(other), saleBody([{ productId: otherProduct.id, qty: 1 }], cash(45_000)))).body.sale.number, 'R-000001', 'numbers are per vendor');
});

test('prices and discounts (O-14): walk-in price = discount price; a changed price and any discount are kept with who did it and audited; limits enforced', async () => {
  salesOn();
  const v = await vendor();
  const seller = await staff(v, ['sales']);
  const p = await product(v, { name: 'Gloves', priceTzs: 20_000, discountPriceTzs: 18_000, stock: 10 });
  const out = await sell(staffOf(seller, v), saleBody([{ productId: p.id, qty: 2, unitPriceTzs: 17_000, discountTzs: 1_000 }], cash(30_000), { discountTzs: 3_000 }));
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const line = out.body.sale.lines[0];
  assert.deepEqual([line.listPriceTzs, line.unitPriceTzs, line.priceChanged, line.discountTzs, line.lineTotalTzs], [18_000, 17_000, true, 1_000, 33_000]);
  assert.deepEqual(line.priceChangedBy, { id: seller, name: 'Juma Seller' });
  assert.deepEqual([out.body.sale.subtotalTzs, out.body.sale.lineDiscountTzs, out.body.sale.discountTzs, out.body.sale.totalTzs], [34_000, 1_000, 3_000, 30_000]);
  const stored = await db('VendorSaleLine').where({ saleId: out.body.sale.id }).first();
  assert.deepEqual([stored.priceChangedBy, stored.discountBy, stored.saleDiscountShareTzs], [seller, seller, 3_000]);
  const audit = await db('AuditLog').where({ target: out.body.sale.id, action: 'vendor_sale_price_override' });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, seller);

  const listed = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(18_000)));
  assert.equal(listed.body.sale.lines[0].unitPriceTzs, 18_000, 'no price sent → the server decides');
  assert.equal(await db('AuditLog').where({ target: listed.body.sale.id }).first(), undefined, 'nothing to audit');

  const tooBig = await sell(as(v), saleBody([{ productId: p.id, qty: 2, discountTzs: 36_001 }], []));
  assert.deepEqual(tooBig, { status: 400, body: { error: 'discount_exceeds_price', productId: p.id, variant: null, maxTzs: 36_000 } });
  const saleTooBig = await sell(as(v), saleBody([{ productId: p.id, qty: 1, discountTzs: 1_000 }], [], { discountTzs: 17_001 }));
  assert.deepEqual(saleTooBig, { status: 400, body: { error: 'discount_exceeds_price', maxTzs: 17_000 } });
  assert.equal((await sell(as(v), saleBody([{ productId: p.id, qty: 1, unitPriceTzs: 0 }], []))).body.error, 'invalid_price');
  assert.equal((await row(p.id)).stock, 7, 'refused sales took nothing');
});

test('payments: reference required for mobile money and bank, optional for card/other; short → 409; non-cash over the total → 400; zero-total sale with no payments', async () => {
  salesOn();
  const v = await vendor();
  const p = await product(v, { priceTzs: 10_000, stock: 20 });
  const one = [{ productId: p.id, qty: 1 }];
  for (const method of ['mpesa', 'airtel_money', 'mixx', 'halopesa', 'bank']) {
    assert.deepEqual(await sell(as(v), saleBody(one, [{ method, amountTzs: 10_000, reference: '  ' }])), { status: 400, body: { error: 'reference_required', index: 0, method } }, method);
  }
  for (const method of ['card', 'other']) assert.equal((await sell(as(v), saleBody(one, [{ method, amountTzs: 10_000 }]))).status, 201, method);
  assert.equal((await sell(as(v), saleBody(one, [{ method: 'mpesa', amountTzs: 4_000, reference: 'A1' }, { method: 'halopesa', amountTzs: 6_000, reference: 'B2' }]))).status, 201, 'two mobile-money payments');
  assert.deepEqual(await sell(as(v), saleBody(one, [{ method: 'cash', amountTzs: 9_999 }])), { status: 409, body: { error: 'payment_short', totalTzs: 10_000, paidTzs: 9_999, shortTzs: 1 } });
  assert.deepEqual(await sell(as(v), saleBody(one, [])), { status: 409, body: { error: 'payment_short', totalTzs: 10_000, paidTzs: 0, shortTzs: 10_000 } });
  // The card alone covers the total: the 1,000 cash all goes back as change (allowed).
  assert.equal((await sell(as(v), saleBody(one, [{ method: 'cash', amountTzs: 1_000 }, { method: 'card', amountTzs: 10_000 }]))).body.sale.changeTzs, 1_000);
  const over = await sell(as(v), saleBody(one, [{ method: 'cash', amountTzs: 1_000 }, { method: 'card', amountTzs: 10_001 }]));
  assert.deepEqual([over.status, over.body.error, over.body.reason], [400, 'invalid_payment', 'non_cash_over_total']);
  assert.equal((await sell(as(v), saleBody(one, [{ method: 'cash', amountTzs: 0 }]))).body.error, 'invalid_payment');
  assert.equal((await sell(as(v), saleBody(one, [{ method: 'cash', amountTzs: 10_000, reference: 'x'.repeat(101) }]))).status, 201, 'a reference on cash is ignored');
  assert.equal((await sell(as(v), saleBody(one, [{ method: 'card', amountTzs: 10_000, reference: 'x'.repeat(101) }]))).body.error, 'invalid_payment');

  const giveaway = await sell(as(v), saleBody([{ productId: p.id, qty: 1, discountTzs: 10_000 }], []));
  assert.equal(giveaway.status, 201, JSON.stringify(giveaway.body));
  assert.deepEqual([giveaway.body.sale.totalTzs, giveaway.body.sale.paidTzs, giveaway.body.sale.payments], [0, 0, []]);
  const paidForNothing = await sell(as(v), saleBody([{ productId: p.id, qty: 1, discountTzs: 10_000 }], cash(1_000)));
  assert.deepEqual([paidForNothing.status, paidForNothing.body.reason], [400, 'nothing_to_pay']);
  const sum = await db('VendorSalePayment').where({ vendorId: v }).sum({ s: 'amountTzs' }).first();
  const sales = await db('VendorSale').where({ vendorId: v });
  assert.equal(Number(sum.s), sales.reduce((t, s) => t + s.paidTzs, 0), 'payments add up to paidTzs');
  for (const s of sales) assert.equal(s.paidTzs - s.changeTzs, s.totalTzs);
});

test('what may be sold (Q-4): paused, pending and rejected listings, a pending vendor; not archived, deleted or another vendor\'s products; a suspended vendor records nothing (M1)', async () => {
  salesOn();
  const v = await vendor();
  const paused = await product(v, { name: 'Paused', stock: 2 });
  await db('Product').where({ id: paused.id }).update({ status: 'paused' });
  const pending = await product(v, { name: 'Pending', stock: 2 }, { approve: false });
  const rejected = await product(v, { name: 'Rejected', stock: 2 });
  await db('Product').where({ id: rejected.id }).update({ approvalStatus: 'rejected', visibility: 'hidden' });
  for (const p of [paused, pending, rejected]) {
    const out = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(45_000)));
    assert.equal(out.status, 201, `${p.name}: ${JSON.stringify(out.body)}`);
  }
  const archived = await product(v, { name: 'Archived', stock: 2 });
  await db('Product').where({ id: archived.id }).update({ status: 'archived' });
  assert.deepEqual(await sell(as(v), saleBody([{ productId: archived.id, qty: 1 }], cash(45_000))), { status: 400, body: { error: 'product_unavailable', productId: archived.id } });
  const deleted = await product(v, { name: 'Deleted', stock: 2 });
  await db('Product').where({ id: deleted.id }).update({ deletedAt: new Date() });
  assert.deepEqual(await sell(as(v), saleBody([{ productId: deleted.id, qty: 1 }], cash(45_000))), { status: 404, body: { error: 'product_not_found', productId: deleted.id } });
  const stranger = await vendor();
  const theirs = await product(stranger, { stock: 2 });
  assert.deepEqual(await sell(as(v), saleBody([{ productId: theirs.id, qty: 1 }], cash(45_000))), { status: 404, body: { error: 'product_not_found', productId: theirs.id } });
  assert.equal((await row(theirs.id)).stock, 2, 'another vendor\'s stock is untouched');
  assert.equal((await sell(as(v), saleBody([{ productId: 'prd_nope', qty: 1 }], cash(45_000)))).body.error, 'product_not_found');

  // A vendor still waiting for approval sells at the counter.
  const newcomer = await vendor({ approvalStatus: 'pending_approval' });
  const np = await product(newcomer, { stock: 1 }, { approve: false });
  assert.equal((await sell(as(newcomer), saleBody([{ productId: np.id, qty: 1 }], cash(45_000)))).status, 201);

  // A suspended vendor (security review M1, fail closed): the account is stopped by the platform sign-in
  // check (403 account_suspended, unchanged); their active staff get 403 vendor_suspended on every route.
  // (The product is made by another vendor and handed over, so the suspended account never signs in while active.)
  const suspended = await vendor({ accountStatus: 'suspended' });
  const sp = await product(await vendor(), { stock: 3 });
  await db('Product').where({ id: sp.id }).update({ vendorId: suspended });
  const seller = await staff(suspended, ['sales'], { vendorRole: 'admin' });
  const earlier = uid('sal');
  await db('VendorSale').insert({ id: earlier, vendorId: suspended, seq: 1, number: 'R-000001', soldAt: new Date(), subtotalTzs: 0, totalTzs: 0, paidTzs: 0, clientRef: uid('ref'), fingerprint: 'x', createdBy: seller });
  await db('VendorDocumentSequence').insert({ vendorId: suspended, docType: 'receipt', next: 2 }); // as if recorded through the API
  for (const [route, opts] of [[vendorRecordSale, { body: saleBody([{ productId: sp.id, qty: 1 }], cash(45_000)) }], [vendorListSales, {}], [vendorGetSale, { params: { id: earlier } }], [vendorVoidSale, { params: { id: earlier }, body: { reason: 'while suspended' } }]]) {
    assert.deepEqual(await call(route, staffOf(seller, suspended), opts), { status: 403, body: { error: 'vendor_suspended' } });
  }
  assert.deepEqual(await sell(as(suspended), saleBody([{ productId: sp.id, qty: 1 }], cash(45_000))), { status: 403, body: { error: 'account_suspended' } });
  assert.equal((await row(sp.id)).stock, 3, 'nothing recorded');
  assert.equal((await db('VendorSale').where({ id: earlier }).first()).status, 'completed');
  // Back to active: the same staff member records again.
  await db('User').where({ id: suspended }).update({ accountStatus: 'active' });
  assert.equal((await sell(staffOf(seller, suspended), saleBody([{ productId: sp.id, qty: 1 }], cash(45_000)))).status, 201);
});

test('soldAt: from 7 days ago to 24 hours ahead (a fast device clock is clamped to now, its value kept as clientSoldAt); default now; numbers follow the order sales reach FitFlex', async () => {
  salesOn();
  const v = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 10 });
  const at = ms => new Date(Date.now() + ms).toISOString();
  const tooOld = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(1_000), { soldAt: at(-7 * 86_400_000 - 60_000) }));
  assert.equal(tooOld.status, 400);
  assert.equal(tooOld.body.error, 'sold_at_out_of_range');
  assert.ok(tooOld.body.earliest && tooOld.body.latest);
  assert.equal((await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(1_000), { soldAt: at(24 * 3_600_000 + 60_000) }))).body.error, 'sold_at_out_of_range', 'more than 24 hours ahead');
  assert.equal((await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(1_000), { soldAt: 'yesterday' }))).body.error, 'invalid_field');
  const late = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(1_000), { soldAt: at(-6 * 86_400_000) }));
  assert.equal(late.status, 201);
  const now = await sell(as(v), { clientRef: randomUUID(), lines: [{ productId: p.id, qty: 1 }], payments: cash(1_000) });
  assert.equal(now.status, 201);
  assert.ok(Math.abs(Date.parse(now.body.sale.soldAt) - Date.now()) < 60_000);
  assert.deepEqual([late.body.sale.number, now.body.sale.number], ['R-000001', 'R-000002']);
  assert.ok(Date.parse(late.body.sale.recordedAt) - Date.parse(late.body.sale.soldAt) > 5 * 86_400_000, 'recorded offline: recordedAt well after soldAt');
  assert.deepEqual([late.body.sale.lateRecorded, late.body.sale.clientSoldAt, now.body.sale.clientSoldAt], [true, null, null]);

  // A device clock 3 hours fast: accepted, soldAt is the server's now, the device value is kept for audit.
  const aheadAt = at(3 * 3_600_000);
  const aheadBody = saleBody([{ productId: p.id, qty: 1 }], cash(1_000), { soldAt: aheadAt });
  const ahead = await sell(as(v), aheadBody);
  assert.equal(ahead.status, 201, JSON.stringify(ahead.body));
  assert.ok(Math.abs(Date.parse(ahead.body.sale.soldAt) - Date.now()) < 60_000, 'clamped to the server\'s now');
  assert.ok(Date.parse(ahead.body.sale.soldAt) <= Date.parse(ahead.body.sale.recordedAt));
  assert.equal(ahead.body.sale.clientSoldAt, new Date(aheadAt).toISOString());
  assert.equal(ahead.body.sale.lateRecorded, false);
  assert.equal(new Date((await db('VendorSale').where({ id: ahead.body.sale.id }).first()).clientSoldAt).toISOString(), new Date(aheadAt).toISOString());
  const replay = await sell(as(v), aheadBody);
  assert.deepEqual([replay.status, replay.body.sale.id], [200, ahead.body.sale.id], 'a retry with the same (future) soldAt is the same sale');
  assert.equal((await row(p.id)).stock, 7);
});

test('variants: a variant that keeps stock is taken in the same statement; variant required; insufficient → 409 { productId, variant, available }', async () => {
  ledgerOn();
  const v = await vendor();
  const tee = await product(v, { name: 'Tee', priceTzs: 15_000, variants: [{ name: 'S', stock: 3 }, { name: 'M', stock: 1 }] });
  assert.equal((await row(tee.id)).stock, 4);
  const out = await sell(as(v), saleBody([{ productId: tee.id, variant: 'S', qty: 2 }, { productId: tee.id, variant: 'M', qty: 1 }], cash(45_000)));
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const after1 = await row(tee.id);
  assert.equal(after1.stock, 1);
  assert.deepEqual(after1.variants.map(x => [x.name, x.stock]), [['S', 1], ['M', 0]]);
  const short = await sell(as(v), saleBody([{ productId: tee.id, variant: 'S', qty: 2 }], cash(30_000)));
  assert.deepEqual(short, { status: 409, body: { error: 'insufficient_stock', productId: tee.id, variant: 'S', available: 1 } });
  assert.deepEqual(await sell(as(v), saleBody([{ productId: tee.id, qty: 1 }], cash(15_000))), { status: 400, body: { error: 'variant_required', productId: tee.id, variants: ['S', 'M'] } });
  assert.equal((await sell(as(v), saleBody([{ productId: tee.id, variant: 'XL', qty: 1 }], cash(15_000)))).body.error, 'variant_not_found');
  const plain = await product(v, { stock: 1 });
  assert.deepEqual(await sell(as(v), saleBody([{ productId: plain.id, qty: 2 }], cash(90_000))), { status: 409, body: { error: 'insufficient_stock', productId: plain.id, variant: null, available: 1 } });
  // A two-product sale refused on its second product leaves the first untouched (all or nothing).
  const plenty = await product(v, { stock: 9 });
  assert.equal((await sell(as(v), saleBody([{ productId: plenty.id, qty: 1 }, { productId: plain.id, qty: 5 }], cash(270_000)))).body.error, 'insufficient_stock');
  assert.equal((await row(plenty.id)).stock, 9);
  assert.equal((await ledgerOf(plenty.id)).filter(m => m.reason === 'sale').length, 0);
});

test('the table CHECK refusing a stock change (not the conditional update) → 409 insufficient_stock { productId, variant, available }, nothing recorded', async () => {
  salesOn();
  const v = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 4 });
  const other = await product(v, { priceTzs: 1_000, stock: 4 });
  const fn = `walkin_check_${randomUUID().slice(0, 8)}`;
  // Stand-in for the database's own refusal: product_stock_non_negative raised for this one product.
  await db.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id = '${p.id}' AND NEW.stock < OLD.stock THEN
      RAISE EXCEPTION 'new row violates check constraint' USING ERRCODE = '23514', CONSTRAINT = 'product_stock_non_negative';
    END IF; RETURN NEW; END $$`);
  await db.raw(`CREATE TRIGGER ${fn} BEFORE UPDATE ON "Product" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    const out = await sell(as(v), saleBody([{ productId: other.id, qty: 1 }, { productId: p.id, qty: 1 }], cash(2_000)));
    assert.deepEqual(out, { status: 409, body: { error: 'insufficient_stock', productId: p.id, variant: null, available: 4 } });
  } finally {
    await db.raw(`DROP TRIGGER IF EXISTS ${fn} ON "Product"`);
    await db.raw(`DROP FUNCTION IF EXISTS ${fn}()`);
  }
  assert.deepEqual([(await row(p.id)).stock, (await row(other.id)).stock], [4, 4], 'all or nothing');
  assert.equal(await db('VendorSale').where({ vendorId: v }).first(), undefined);
  assert.equal(await db('VendorDocumentSequence').where({ vendorId: v }).first(), undefined, 'no number used');
});

// ── idempotency ──────────────────────────────────────────────────────────────

test('clientRef: a replay returns the same sale (200) and moves nothing; a different body → 409 client_ref_reused; five at once → one sale', async () => {
  salesOn();
  const v = await vendor();
  const p = await product(v, { priceTzs: 5_000, stock: 10 });
  const body = saleBody([{ productId: p.id, qty: 2 }], cash(10_000));
  const first = await sell(as(v), body);
  assert.equal(first.status, 201);
  const again = await sell(as(v), body);
  assert.equal(again.status, 200);
  assert.equal(again.headers['Idempotent-Replay'], 'true');
  assert.deepEqual(again.body, first.body);
  assert.equal((await row(p.id)).stock, 8);
  assert.deepEqual(await sell(as(v), { ...body, lines: [{ productId: p.id, qty: 3 }], payments: cash(15_000) }), { status: 409, body: { error: 'client_ref_reused' } });
  // A replay after the stock ran out still gets the sale (the units were taken the first time).
  await db('Product').where({ id: p.id }).update({ stock: 0 });
  assert.equal((await sell(as(v), body)).status, 200);
  await db('Product').where({ id: p.id }).update({ stock: 10 });

  const burst = saleBody([{ productId: p.id, qty: 1 }], cash(5_000));
  const results = await Promise.all(Array.from({ length: 5 }, () => sell(as(v), burst)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 200, 200, 201], JSON.stringify(results.map(r => r.body)));
  assert.equal(new Set(results.map(r => r.body.sale.id)).size, 1);
  assert.equal((await row(p.id)).stock, 9);
  assert.equal(await db('VendorSale').where({ vendorId: v, clientRef: burst.clientRef }).count({ n: '*' }).first().then(r => Number(r.n)), 1);
  const numbers = (await db('VendorSale').where({ vendorId: v }).orderBy('seq')).map(s => s.number);
  assert.deepEqual(numbers, ['R-000001', 'R-000002'], 'the rolled-back duplicates gave their numbers back');
});

// ── concurrency ──────────────────────────────────────────────────────────────

test('shared pool under concurrency: walk-in sales and app reservations together never oversell; numbers stay continuous', async () => {
  salesOn();
  const v = await vendor();
  const p = await product(v, { priceTzs: 2_000, stock: 6 });
  const buyers = await Promise.all(Array.from({ length: 6 }, () => user('member')));
  const attempts = [
    ...Array.from({ length: 8 }, () => sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(2_000)))),
    ...buyers.map(b => appOrder(b, [{ productId: p.id, qty: 1 }])),
  ];
  const results = await Promise.all(attempts);
  const walkIns = results.slice(0, 8);
  const apps = results.slice(8);
  const okSales = walkIns.filter(r => r.status === 201).length;
  const okApps = apps.filter(r => r.status === 201).length;
  assert.equal(okSales + okApps, 6, `exactly the 6 units were sold: ${JSON.stringify(results.map(r => [r.status, r.body?.error]))}`);
  for (const r of walkIns.filter(x => x.status !== 201)) assert.deepEqual([r.status, r.body.error, r.body.productId, r.body.available], [409, 'insufficient_stock', p.id, 0]);
  for (const r of apps.filter(x => x.status !== 201)) assert.equal(r.body.error, 'insufficient_stock');
  const current = await row(p.id);
  assert.equal(current.stock, 0);
  const moves = await ledgerOf(p.id);
  assert.equal(moves.filter(m => m.reason === 'sale').length, okSales);
  assert.equal(moves.filter(m => m.reason === 'reserve').length, okApps);
  assert.equal(moves.filter(m => ['sale', 'reserve'].includes(m.reason)).reduce((s, m) => s + Number(m.delta), 0), -6, 'the ledger accounts for every unit');
  const seqs = (await db('VendorSale').where({ vendorId: v }).orderBy('seq')).map(s => s.seq);
  assert.deepEqual(seqs, Array.from({ length: okSales }, (_, i) => i + 1));
});

test('gap-free numbers under concurrency: 30 sales by two sellers at once, with refusals and duplicate retries mixed in → R-000001…R-0000NN, no gaps, no repeats', async () => {
  salesOn();
  const v = await vendor();
  const seller = await staff(v, ['sales']);
  const p = await product(v, { priceTzs: 1_000, stock: 20 });
  const dup = saleBody([{ productId: p.id, qty: 1 }], cash(1_000));
  const jobs = [];
  for (let i = 0; i < 30; i += 1) {
    const who = i % 2 ? staffOf(seller, v) : as(v);
    if (i % 7 === 0) jobs.push(sell(who, saleBody([{ productId: p.id, qty: 1 }], cash(500)))); // payment_short
    else if (i % 5 === 0) jobs.push(sell(as(v), dup)); // the same sale retried
    else jobs.push(sell(who, saleBody([{ productId: p.id, qty: 1 }], cash(1_000))));
  }
  const results = await Promise.all(jobs);
  const created = results.filter(r => r.status === 201);
  const sales = await db('VendorSale').where({ vendorId: v }).orderBy('seq');
  assert.equal(sales.length, created.length);
  assert.deepEqual(sales.map(s => s.seq), Array.from({ length: sales.length }, (_, i) => i + 1));
  assert.deepEqual(sales.map(s => s.number), sales.map((_, i) => `R-${String(i + 1).padStart(6, '0')}`));
  assert.equal((await row(p.id)).stock, 20 - sales.length);
  assert.ok(sales.length >= 15, `most sales went through (${sales.length})`);
  assert.equal(Number((await db('VendorDocumentSequence').where({ vendorId: v, docType: 'receipt' }).first()).next), sales.length + 1);
});

// ── void ─────────────────────────────────────────────────────────────────────

test('void: every unit back once (sale_void), audited, 409 already_voided, reason required, concurrent voids → one; stock history links both rows to the receipt', async () => {
  ledgerOn();
  const v = await vendor();
  const seller = await staff(v, ['sales'], { vendorRole: 'admin', displayName: 'Admin Neema' });
  const tee = await product(v, { name: 'Tee', priceTzs: 15_000, variants: [{ name: 'S', stock: 3 }, { name: 'M', stock: 3 }] });
  const bar = await product(v, { name: 'Bar', priceTzs: 2_000, stock: 5 });
  const sold = await sell(as(v), saleBody([{ productId: tee.id, variant: 'S', qty: 1 }, { productId: tee.id, variant: 'S', qty: 1, unitPriceTzs: 14_000 }, { productId: bar.id, qty: 2 }], cash(33_000)));
  assert.equal(sold.status, 201, JSON.stringify(sold.body));
  const id = sold.body.sale.id;
  assert.deepEqual((await row(tee.id)).variants.map(x => x.stock), [1, 3]);
  assert.equal((await ledgerOf(tee.id)).filter(m => m.reason === 'sale').length, 1, 'one ledger row per product/variant, not per line');

  assert.deepEqual(await call(vendorVoidSale, as(v), { params: { id }, body: { reason: ' x ' } }), { status: 400, body: { error: 'reason_required', min: 3 } });
  assert.equal((await call(vendorVoidSale, as(v), { params: { id }, body: { reason: 'y'.repeat(201) } })).body.error, 'reason_too_long');
  // Admin staff may void a sale someone else recorded (M2); two voids at once → one wins.
  const both = await Promise.all([
    call(vendorVoidSale, staffOf(seller, v), { params: { id }, body: { reason: 'Customer changed mind' } }),
    call(vendorVoidSale, as(v), { params: { id }, body: { reason: 'Rang up twice' } }),
  ]);
  assert.deepEqual(both.map(r => r.status).sort(), [200, 409]);
  const won = both.find(r => r.status === 200).body.sale;
  const lost = both.find(r => r.status === 409).body;
  assert.equal(lost.error, 'already_voided');
  assert.equal(won.status, 'voided');
  assert.ok(won.voidedAt && won.voidReason);
  assert.ok([seller, v].includes(won.voidedBy.id));
  assert.equal((await call(vendorVoidSale, as(v), { params: { id }, body: { reason: 'again please' } })).body.error, 'already_voided');

  assert.deepEqual((await row(tee.id)).variants.map(x => x.stock), [3, 3]);
  assert.equal((await row(tee.id)).stock, 6);
  assert.equal((await row(bar.id)).stock, 5);
  const back = (await ledgerOf(tee.id)).filter(m => m.reason === 'sale_void');
  assert.deepEqual(back.map(m => [m.kind, m.variant, Number(m.delta), Number(m.stockAfter), m.sourceId]), [['sale_void', 'S', 2, 3, id]]);
  assert.equal((await db('AuditLog').where({ target: id, action: 'vendor_sale_voided' })).length, 1);
  await assert.rejects(db('ShopStockMovement').insert({ ...back[0], id: uid('stk') }), /shopstockmovement_source_unique/, 'the ledger refuses a second give-back');

  const history = await call(vendorStockMovements, as(v), { params: { id: tee.id }, query: { variant: 'S' } });
  assert.equal(history.status, 200, JSON.stringify(history.body));
  const docs = history.body.rows.filter(r => ['sale', 'sale_void'].includes(r.reason)).map(r => [r.reason, r.document]);
  assert.deepEqual(docs, [['sale_void', { type: 'sale', id, number: 'R-000001' }], ['sale', { type: 'sale', id, number: 'R-000001' }]]);

  const gone = await call(vendorGetSale, as(v), { params: { id } });
  assert.equal(gone.body.sale.status, 'voided');
  assert.deepEqual(gone.body.sale.lines[1].priceChangedBy, { id: v, name: 'Asha Owner' });
  assert.equal((await call(vendorVoidSale, as(v), { params: { id: 'sal_unknown' }, body: { reason: 'nope nope' } })).status, 404);
});

test('a sale lowers stock to the reorder level → one low-stock alert (ledger on); a void raises it again', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 4, reorderLevel: 2 });
  const alerts = () => db('MarketplaceNotification').where({ userId: v, type: 'vendor_low_stock' });
  const s1 = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(1_000)));
  assert.equal((await alerts()).length, 0);
  await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(1_000)));
  assert.equal((await alerts()).length, 1);
  await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(1_000)));
  assert.equal((await alerts()).length, 1, 'once per crossing');
  await call(vendorVoidSale, as(v), { params: { id: s1.body.sale.id }, body: { reason: 'wrong item' } });
  assert.equal((await row(p.id)).stock, 2);
});

// ── history ──────────────────────────────────────────────────────────────────

test('GET /vendor/sales: newest first, paged, filters (dates, status, createdBy=me), itemCount, methods, summary over the range with cash net of change', async () => {
  salesOn();
  const v = await vendor();
  const seller = await staff(v, ['sales']);
  const p = await product(v, { priceTzs: 1_000, stock: 100 });
  const hour = 3_600_000;
  const t0 = Date.now() - 5 * hour;
  const mk = async (claims, i, qty, payments) => (await sell(claims, saleBody([{ productId: p.id, qty }], payments, { soldAt: new Date(t0 + i * 60_000).toISOString() }))).body.sale;
  const a = await mk(as(v), 0, 2, cash(5_000)); // change 3,000
  const b = await mk(staffOf(seller, v), 1, 3, [{ method: 'cash', amountTzs: 1_000 }, { method: 'mpesa', amountTzs: 2_000, reference: 'MP1' }]);
  const c = await mk(as(v), 2, 1, [{ method: 'card', amountTzs: 1_000 }]);
  const d = await mk(staffOf(seller, v), 3, 4, [{ method: 'mpesa', amountTzs: 4_000, reference: 'MP2' }]);
  await call(vendorVoidSale, as(v), { params: { id: c.id }, body: { reason: 'test void' } });
  // Sold now (not late), at a changed price and with a line discount.
  const e = (await sell(as(v), saleBody([{ productId: p.id, qty: 1, unitPriceTzs: 900, discountTzs: 100 }], [{ method: 'card', amountTzs: 800 }]))).body.sale;
  assert.equal(e.lateRecorded, false);
  assert.equal((await call(vendorGetSale, as(v), { params: { id: a.id } })).body.sale.lateRecorded, true);

  const all = await call(vendorListSales, as(v));
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.sales.map(s => s.number), [e.number, d.number, c.number, b.number, a.number]);
  assert.deepEqual(Object.keys(all.body.sales[0]).sort(), ['createdBy', 'discountTzs', 'hasOverride', 'id', 'itemCount', 'lateRecorded', 'methods', 'number', 'recordedAt', 'soldAt', 'status', 'totalTzs']);
  const bRow = all.body.sales.find(s => s.id === b.id);
  assert.deepEqual([bRow.itemCount, bRow.methods, bRow.createdBy, bRow.totalTzs, bRow.hasOverride, bRow.discountTzs, bRow.lateRecorded], [3, ['cash', 'mpesa'], { id: seller, name: 'Juma Seller' }, 3_000, false, 0, true]);
  const eRow = all.body.sales[0];
  assert.deepEqual([eRow.hasOverride, eRow.discountTzs, eRow.lateRecorded], [true, 100, false]);
  assert.deepEqual(all.body.summary, {
    count: 4, totalTzs: 9_800, voidedCount: 1, discountTzs: 100, overrideCount: 1, lateCount: 4,
    byMethod: [{ method: 'cash', amountTzs: 3_000 }, { method: 'mpesa', amountTzs: 6_000 }, { method: 'card', amountTzs: 800 }],
  });
  assert.equal(all.body.summary.byMethod.reduce((s, m) => s + m.amountTzs, 0), all.body.summary.totalTzs);
  assert.equal(all.body.nextCursor, null);

  const page1 = await call(vendorListSales, as(v), { query: { limit: '3' } });
  assert.equal(page1.body.sales.length, 3);
  assert.ok(page1.body.nextCursor);
  const page2 = await call(vendorListSales, as(v), { query: { limit: '3', cursor: page1.body.nextCursor } });
  assert.deepEqual(page2.body.sales.map(s => s.id), [b.id, a.id]);
  assert.equal(page2.body.nextCursor, null);
  assert.deepEqual(page2.body.summary, all.body.summary, 'the summary is the range, not the page');

  const mine = await call(vendorListSales, staffOf(seller, v), { query: { createdBy: 'me' } });
  assert.deepEqual(mine.body.sales.map(s => s.id), [d.id, b.id]);
  assert.deepEqual([mine.body.summary.count, mine.body.summary.totalTzs], [2, 7_000]);
  assert.deepEqual((await call(vendorListSales, as(v), { query: { status: 'voided' } })).body.sales.map(s => s.id), [c.id]);
  assert.equal((await call(vendorListSales, as(v), { query: { status: 'completed' } })).body.sales.length, 4);

  const eatDay = ms => new Date(ms + 3 * hour).toISOString().slice(0, 10);
  const today = eatDay(Date.now());
  const inRange = await call(vendorListSales, as(v), { query: { from: eatDay(t0), to: today } });
  assert.equal(inRange.body.sales.length, 5);
  const longAgo = await call(vendorListSales, as(v), { query: { from: '2026-01-01', to: '2026-01-02' } });
  assert.deepEqual([longAgo.body.sales, longAgo.body.summary], [[], { count: 0, totalTzs: 0, voidedCount: 0, discountTzs: 0, overrideCount: 0, lateCount: 0, byMethod: [] }]);

  for (const [query, error] of [[{ from: '2026-13-01' }, 'invalid_date'], [{ from: '2026-10-02', to: '2026-10-01' }, 'invalid_date'], [{ status: 'refunded' }, 'invalid_status'], [{ createdBy: seller }, 'invalid_created_by'], [{ limit: '0' }, 'invalid_limit'], [{ cursor: 'garbage' }, 'invalid_cursor']]) {
    const out = await call(vendorListSales, as(v), { query });
    assert.deepEqual([out.status, out.body.error], [400, error], JSON.stringify(query));
  }
  assert.equal((await call(vendorListSales, as(v), { query: { limit: '999' } })).status, 200, 'above 200 is capped');
});

test('who may void (M2): vendor and admin staff any sale; other staff only their own, on the EAT day it was sold; staff voids notify the vendor account', async () => {
  salesOn();
  const v = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 20 });
  const juma = await staff(v, ['sales']);
  const asha = await staff(v, ['sales'], { displayName: 'Asha Seller' });
  const neema = await staff(v, ['sales'], { vendorRole: 'admin', displayName: 'Admin Neema' });
  const one = (claims, extra = {}) => sell(claims, saleBody([{ productId: p.id, qty: 1 }], cash(1_000), extra)).then(r => r.body.sale);
  const voidAs = (claims, id) => call(vendorVoidSale, claims, { params: { id }, body: { reason: 'counted twice' } });
  const voidAlerts = () => db('MarketplaceNotification').where({ userId: v, type: 'vendor_sale_voided' });

  const jumas = await one(staffOf(juma, v));
  const ownersSale = await one(as(v));
  const old = await one(staffOf(juma, v), { soldAt: new Date(Date.now() - 2 * 86_400_000).toISOString() });
  assert.deepEqual(await voidAs(staffOf(asha, v), jumas.id), { status: 403, body: { error: 'void_not_allowed', reason: 'not_own' } });
  assert.deepEqual(await voidAs(staffOf(juma, v), ownersSale.id), { status: 403, body: { error: 'void_not_allowed', reason: 'not_own' } });
  assert.deepEqual(await voidAs(staffOf(juma, v), old.id), { status: 403, body: { error: 'void_not_allowed', reason: 'too_old' } });
  assert.equal((await row(p.id)).stock, 17, 'refused voids gave nothing back');
  assert.equal((await voidAlerts()).length, 0);

  const own = await voidAs(staffOf(juma, v), jumas.id);
  assert.equal(own.status, 200, JSON.stringify(own.body));
  // A refused staff void of a voided sale still says why it is not theirs (checked first).
  assert.deepEqual(await voidAs(staffOf(asha, v), jumas.id), { status: 403, body: { error: 'void_not_allowed', reason: 'not_own' } });
  assert.equal((await voidAs(staffOf(neema, v), old.id)).status, 200, 'admin staff: any sale, any day');
  assert.equal((await voidAs(as(v), ownersSale.id)).status, 200, 'the vendor account: any sale');
  assert.equal((await row(p.id)).stock, 20);

  const alerts = await voidAlerts();
  assert.equal(alerts.length, 2, 'one per staff void; none when the vendor account voids');
  const data = alerts.map(a => (typeof a.data === 'string' ? JSON.parse(a.data) : a.data));
  assert.deepEqual(data.map(d => d.number).sort(), [jumas.number, old.number].sort());
  assert.ok(data.every(d => d.saleId && d.reason === 'counted twice' && d.voidedByName));
});

test('rate limit (L5): more than 120 sales a minute for one vendor → 429 rate_limited { retryAfterSeconds }, nothing recorded; other vendors unaffected', async () => {
  salesOn();
  const v = await vendor();
  const other = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 5 });
  const q = await product(other, { priceTzs: 1_000, stock: 5 });
  for (let i = 0; i < VENDOR_SALES_LIMIT.perMinute; i += 1) assert.equal(allowVendorSale(v).ok, true);
  const limited = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(1_000)));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(limited.body.retryAfterSeconds >= 1 && limited.body.retryAfterSeconds <= 60);
  assert.equal(limited.headers['Retry-After'], String(limited.body.retryAfterSeconds));
  assert.equal((await row(p.id)).stock, 5);
  assert.equal((await sell(as(other), saleBody([{ productId: q.id, qty: 1 }], cash(1_000)))).status, 201);
  assert.equal(allowVendorSale(v, Date.now() + 61_000).ok, true, 'a new minute, a new allowance');
  resetVendorSalesLimits();
  assert.equal((await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(1_000)))).status, 201);
});

// ── permissions and tenancy ──────────────────────────────────────────────────

test('permissions: `sales` needed for staff (read from the staff record); disabled or moved staff refused; members and admins refused; tenancy by vendor', async () => {
  salesOn();
  const v = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 10 });
  const sold = (await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(1_000)))).body.sale;
  const ordersOnly = await staff(v, ['orders', 'products']);
  const seller = await staff(v, ['sales']);
  const disabled = await staff(v, ['sales'], { accountStatus: 'suspended' });
  const otherVendor = await vendor();
  const moved = await staff(otherVendor, ['sales']);

  for (const [route, opts] of [[vendorRecordSale, { body: saleBody([{ productId: p.id, qty: 1 }], cash(1_000)) }], [vendorListSales, {}], [vendorGetSale, { params: { id: sold.id } }], [vendorVoidSale, { params: { id: sold.id }, body: { reason: 'not allowed' } }]]) {
    assert.deepEqual(await call(route, staffOf(ordersOnly, v), opts), { status: 403, body: { error: 'vendor_permission_forbidden', requiredPermission: 'sales' } });
    assert.equal((await call(route, staffOf(disabled, v), opts)).status, 403);
    assert.equal((await call(route, staffOf(moved, v), opts)).status, 403, 'a token naming another vendor than the staff record');
    assert.equal((await call(route, { sub: uid('m'), userType: 'member' }, opts)).status, 403);
    assert.equal((await call(route, { sub: uid('a'), userType: 'admin' }, opts)).status, 403);
  }
  assert.equal((await call(vendorGetSale, staffOf(seller, v), { params: { id: sold.id } })).status, 200);
  assert.equal((await row(p.id)).stock, 9, 'refused callers moved nothing');

  // Another vendor (and their staff) cannot see, list or void this vendor's sale.
  const theirSeller = await staff(otherVendor, ['sales']);
  for (const claims of [as(otherVendor), staffOf(theirSeller, otherVendor)]) {
    assert.deepEqual(await call(vendorGetSale, claims, { params: { id: sold.id } }), { status: 404, body: { error: 'sale_not_found' } });
    assert.deepEqual(await call(vendorVoidSale, claims, { params: { id: sold.id }, body: { reason: 'hijack attempt' } }), { status: 404, body: { error: 'sale_not_found' } });
    assert.deepEqual((await call(vendorListSales, claims)).body.sales, []);
  }
  assert.equal((await db('VendorSale').where({ id: sold.id }).first()).status, 'completed');
  // A vendor token carrying someone else's vendorId acts only for itself.
  assert.deepEqual(await call(vendorGetSale, { sub: otherVendor, userType: 'vendor', vendorId: v }, { params: { id: sold.id } }), { status: 404, body: { error: 'sale_not_found' } });
});

test('as mounted by bfast-function: each /vendor/sales route lets in exactly who its own guard lets in (no guard borrowed from another path)', async () => {
  salesOn();
  const v = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 5 });
  const seller = await staff(v, ['sales']);
  const productsOnly = await staff(v, ['products']);
  const created = await hit('POST', '/vendor/sales', staffOf(seller, v), saleBody([{ productId: p.id, qty: 1 }], cash(1_000)));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.sale.id;
  assert.equal((await hit('GET', '/vendor/sales', staffOf(seller, v))).status, 200);
  assert.equal((await hit('GET', `/vendor/sales/${id}`, staffOf(seller, v))).status, 200);
  assert.equal((await hit('POST', `/vendor/sales/${id}/void`, staffOf(seller, v), { reason: 'mounted void' })).status, 200);
  for (const [method, url, body] of [['GET', '/vendor/sales'], ['GET', `/vendor/sales/${id}`], ['POST', `/vendor/sales/${id}/void`, { reason: 'nope nope' }], ['POST', '/vendor/sales', saleBody([{ productId: p.id, qty: 1 }], cash(1_000))]]) {
    assert.deepEqual(await hit(method, url, staffOf(productsOnly, v), body), { status: 403, body: { error: 'vendor_permission_forbidden', requiredPermission: 'sales' } }, `${method} ${url}`);
    assert.equal((await hit(method, url, null, body)).status, 401);
  }
  assert.equal((await hit('GET', '/vendor/products', staffOf(productsOnly, v))).status, 200);
});

test('GET /vendor/products: staff with only `sales` may load products for the POS (same list, no cost); every product write and stock route still needs `products`', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 5, costTzs: 600, variants: [{ name: 'S', stock: 2, costTzs: 650 }, { name: 'M', stock: 3 }] });
  const seller = await staff(v, ['sales']);
  const nothing = await staff(v, ['orders']);
  const productsStaff = await staff(v, ['products']);
  const list = await hit('GET', '/vendor/products', staffOf(seller, v));
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const mine = list.body.find(x => x.id === p.id);
  assert.ok(mine, 'the vendor\'s product is listed');
  assert.deepEqual(mine.variants.map(x => [x.name, x.stock]), [['S', 2], ['M', 3]]);
  assert.equal(JSON.stringify(list.body).includes('costTzs'), false, 'no cost fields without cost rights');
  assert.equal(JSON.stringify(list.body).includes('CostTzs'), false);
  // Same response as staff with `products` (also without cost rights).
  assert.deepEqual((await hit('GET', '/vendor/products', staffOf(productsStaff, v))).body, list.body);
  // The vendor account still sees the cost.
  assert.equal((await hit('GET', '/vendor/products', as(v))).body.find(x => x.id === p.id).costTzs, 600);
  assert.deepEqual(await hit('GET', '/vendor/products', staffOf(nothing, v)), { status: 403, body: { error: 'vendor_permission_forbidden', requiredPermission: 'products', acceptedPermissions: ['products', 'sales'] } });

  const productsOnly = { status: 403, body: { error: 'vendor_permission_forbidden', requiredPermission: 'products' } };
  for (const [method, url, body] of [
    ['PUT', `/vendor/products/${p.id}`, { name: 'Renamed by sales' }],
    ['POST', `/vendor/products/${p.id}/stock-adjustments`, { reason: 'restock', quantity: 1, clientRef: randomUUID() }],
    ['GET', `/vendor/products/${p.id}/stock-movements`],
    ['GET', '/vendor/stock/low'],
    ['POST', '/vendor/products', { name: 'New', category: 'supplements_nutrition', priceTzs: 1_000, stock: 1 }],
    ['POST', `/vendor/products/${p.id}/duplicate`, {}],
    ['DELETE', `/vendor/products/${p.id}`],
  ]) {
    assert.deepEqual(await hit(method, url, staffOf(seller, v), body), productsOnly, `${method} ${url}`);
  }
  const after = await row(p.id);
  assert.deepEqual([after.name, after.stock, after.deletedAt], ['Whey 1kg', 5, null], 'nothing changed');
});

test('staff permission `sales`: new admin staff get it; the backfill adds it to existing admin- and sales-role staff, their vendor memberships and pending invitations, once', async () => {
  const v = await vendor();
  const created = await call(vendorCreateStaff, as(v), { body: { name: 'New Admin', email: `${uid('a')}@example.com`, phone: '0712000111', password: 'Secret123!', role: 'admin' } });
  if (created.status === 201) {
    made.users.push(created.body.id);
    assert.ok(created.body.vendorPermissions.includes('sales'), JSON.stringify(created.body));
  } else {
    assert.equal(created.body.error, 'credentials_not_accepted', 'staff are invited instead (V2_INVITES on)');
  }
  const picked = await call(vendorCreateStaff, as(v), { body: { name: 'Picked', email: `${uid('p')}@example.com`, phone: '0712000222', password: 'Secret123!', role: 'orders_manager', permissions: ['orders', 'sales', 'bogus'] } });
  if (picked.status === 201) {
    made.users.push(picked.body.id);
    assert.deepEqual(picked.body.vendorPermissions, ['orders', 'sales'], 'sales may be granted; unknown permissions dropped');
  }

  const salesRole = await call(vendorCreateStaff, as(v), { body: { name: 'Seller', email: `${uid('s')}@example.com`, phone: '0712000333', password: 'Secret123!', role: 'sales', permissions: ['orders'] } });
  if (salesRole.status === 201) {
    made.users.push(salesRole.body.id);
    assert.deepEqual(salesRole.body.vendorPermissions, ['orders', 'sales'], 'the sales role always carries `sales` (contract check #214)');
    const bare = await call(vendorCreateStaff, as(v), { body: { name: 'Seller 2', email: `${uid('s')}@example.com`, phone: '0712000444', password: 'Secret123!', role: 'sales' } });
    made.users.push(bare.body.id);
    assert.deepEqual(bare.body.vendorPermissions, ['sales']);
  }

  const admin = await staff(v, ['products', 'orders', 'customers', 'reports', 'payments', 'staff'], { vendorRole: 'admin' });
  const seller = await staff(v, [], { vendorRole: 'sales' });
  const ordersMgr = await staff(v, ['orders'], { vendorRole: 'orders_manager' });
  await db('Vendor').insert({ id: v, name: 'Counter Shop', status: 'active' }).onConflict('id').ignore();
  const person = uid('per');
  made.persons.push(person);
  await db('Person').insert({ id: person });
  await db('OrgMembership').insert({ id: uid('om'), personId: person, personaId: admin, orgType: 'vendor', vendorId: v, role: 'staff', status: 'active', aclPermissions: ['products'] });
  const inviteFor = role => ({
    id: uid('inv'), orgType: 'vendor', vendorId: v, role: 'staff', identifierType: 'email', identifierValue: `${uid('i')}@example.com`,
    tokenHash: randomUUID(), status: 'pending', aclPermissions: ['orders'], payload: JSON.stringify({ vendorRole: role }), invitedBy: v,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const adminInvite = inviteFor('admin');
  const custInvite = inviteFor('customer_care');
  await db('Invitation').insert([adminInvite, custInvite]);

  await migration.addSalesPermission(db);
  await migration.addSalesPermission(db); // safe to repeat
  const perms = async id => (await db('User').where({ id }).first()).vendorPermissions;
  assert.deepEqual(await perms(admin), ['products', 'orders', 'customers', 'reports', 'payments', 'staff', 'sales']);
  assert.deepEqual(await perms(seller), ['sales']);
  assert.deepEqual(await perms(ordersMgr), ['orders'], 'other roles are not given it');
  assert.deepEqual((await db('OrgMembership').where({ personaId: admin }).first()).aclPermissions, ['products', 'sales']);
  assert.deepEqual((await db('Invitation').where({ id: adminInvite.id }).first()).aclPermissions, ['orders', 'sales']);
  assert.deepEqual((await db('Invitation').where({ id: custInvite.id }).first()).aclPermissions, ['orders']);
  salesOn();
  assert.equal((await call(vendorListSales, staffOf(seller, v))).status, 200, 'the backfilled seller may now open sales');
});

// ── settlement and payouts are untouched ─────────────────────────────────────

test('walk-in sales are not in VendorSettlement prepare, /vendor/payments or the statement CSV, and carry no commission', async () => {
  salesOn();
  const v = await vendor();
  const onlyCounter = await vendor();
  const p = await product(v, { name: 'Bottle', priceTzs: 50_000, stock: 20 });
  const cp = await product(onlyCounter, { priceTzs: 10_000, stock: 20 });
  const buyer = await user('member');
  const placed = await shopService.createOrder({ buyerId: buyer, body: cart([{ productId: p.id, qty: 1 }]) });
  assert.equal(placed.status, 202, JSON.stringify(placed));
  made.orders.push(placed.order.id);
  const paid = await adminPaymentService.decide({ id: placed.paymentRequest.id, decision: 'approve', reference: `MP-${randomUUID().slice(0, 8)}`, amountTzs: placed.order.totalTzs, actorId: uid('adm') });
  assert.equal(paid.paymentRequest.status, 'approved');
  for (const status of ['accepted', 'dispatched', 'delivered']) {
    assert.equal((await shopService.updateOrderStatus({ orderId: placed.order.id, status, actorId: v })).order.status, status);
  }
  const paymentsBefore = await call(vendorPayments, as(v));
  const csvBefore = await shopService.vendorStatement(v);
  const clock = new Date(Date.now() + 7 * 86_400_000);
  const settlements = createVendorSettlementService({ users, payoutEligibility: createPayoutEligibility({ users, gyms, partnerGate, partnerSettlementAccounts, trainers }), now: () => clock });
  const statement = async (vendorId) => {
    const s = await db('VendorSettlement').where({ vendorId }).whereNot('status', 'voided');
    const lines = await db('VendorSettlementLine').where({ vendorId, voided: false });
    return { statements: s.map(x => [x.orderCount, x.salesTzs, x.commissionTzs, x.finalNetTzs]), lines: lines.map(l => [l.orderId, l.salesTzs, l.commissionTzs, l.payoutTzs]) };
  };
  assert.equal((await settlements.prepare({ actorId: 'adm_walkin' })).error, undefined);
  const before = await statement(v);
  assert.deepEqual(before.statements, [[1, 50_000, 5_000, 45_000]]);

  // Counter sales, a split one and a voided one, by both vendors.
  for (let i = 0; i < 3; i += 1) assert.equal((await sell(as(v), saleBody([{ productId: p.id, qty: 2 }], [{ method: 'cash', amountTzs: 50_000 }, { method: 'mpesa', amountTzs: 50_000, reference: `R${i}` }]))).status, 201);
  const voided = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(50_000)));
  await call(vendorVoidSale, as(v), { params: { id: voided.body.sale.id }, body: { reason: 'settlement test' } });
  assert.equal((await sell(as(onlyCounter), saleBody([{ productId: cp.id, qty: 5 }], cash(50_000)))).status, 201);

  assert.equal((await settlements.prepare({ actorId: 'adm_walkin' })).error, undefined);
  assert.deepEqual(await statement(v), before, 'the statement, rebuilt, is exactly the app order');
  assert.deepEqual(await statement(onlyCounter), { statements: [], lines: [] }, 'a vendor with only counter sales gets no statement');
  assert.deepEqual(await call(vendorPayments, as(v)), paymentsBefore, '/vendor/payments figures (todaySalesTzs too) ignore walk-in sales');
  assert.equal(await shopService.vendorStatement(v), csvBefore);
  const columns = Object.keys(await db('VendorSale').where({ vendorId: v }).first()).concat(Object.keys(await db('VendorSaleLine').where({ vendorId: v }).first()));
  assert.equal(columns.some(c => /commission|payout|settle/i.test(c)), false, 'no commission, payout or settlement fields on walk-in sales');
});
