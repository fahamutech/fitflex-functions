// Vendor business tools · S4 — vendor customers, pay-later (credit) sales, customer payments,
// balances and aging. Against the CI database: over-payment refused (also under concurrency),
// continuous PMT numbers, allocations that keep each sale's CHECKs, void rules, EAT aging
// boundaries with a fixed clock, A-02 privacy, tenancy and permissions.
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
import { users, gyms, partnerGate, trainers, shopService, adminPaymentService, vendorSaleService, accountService } from '../src/bootstrap/services.mjs';
import { partnerSettlementAccounts } from '../src/bootstrap/collections.mjs';
import { createPayoutEligibility } from '../src/services/payout-eligibility.mjs';
import { createVendorSettlementService } from '../src/services/vendor-settlement-service.mjs';
import { createPgVendorCustomerStore } from '../src/infra/vendor-customer-store-pg.mjs';
import { createPgVendorSaleStore } from '../src/infra/vendor-sale-store-pg.mjs';
import { createVendorCustomerService } from '../src/services/vendor-customer-service.mjs';
import { createPartnerNotifier } from '../src/services/partner-notifier.mjs';
import { vendorToolsOptionsRoute, vendorCreateProduct, vendorOrders, vendorPayments } from '../functions/shop.mjs';
import { vendorRecordSale, vendorListSales, vendorGetSale, vendorVoidSale, resetVendorSalesLimits } from '../functions/vendor-sales.mjs';
import {
  vendorCustomersList, vendorCustomersCreate, vendorCustomerGet, vendorCustomerUpdate, vendorCustomerSales, vendorCustomerSale,
  vendorCustomerOrders, vendorCustomerPayments, vendorCustomerRecordPayment, vendorCustomerPayment, vendorCustomerVoidPayment, vendorReceivablesAging,
  resetVendorCustomerLimits, VENDOR_CUSTOMER_LIMITS,
} from '../functions/vendor-customers.mjs';
import { createVendorLimiter } from '../src/shared/vendor-rate-limit.mjs';
import { vendorCustomersOverdueDigest } from '../functions/jobs.mjs';
import {
  normalisePhone, agingBucket, daysBetween, addDays, allocateOldestFirst, parsePayment, parseCustomer, dueDateOutOfRange, eatToday, paymentNumber, paymentFingerprint,
} from '../src/shared/vendor-customer.mjs';
import { priceSale, parseSale, saleFingerprint } from '../src/shared/vendor-sale.mjs';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';

const migration = createRequire(import.meta.url)('../db/migrations/20270101090000-vendor-customers.cjs');

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [], orders: [] };
const FLAGS = ['VENDOR_TOOLS', 'VENDOR_WALKIN_SALES', 'VENDOR_CUSTOMERS'];
const on = () => { for (const f of FLAGS) process.env[f] = '1'; };
afterEach(() => { for (const f of FLAGS) delete process.env[f]; resetVendorSalesLimits(); resetVendorCustomerLimits(); });

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
  return Object.defineProperty({ status: out.statusCode, body: out.body }, 'headers', { value: out.headers });
}

async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `S4 ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
async function vendor(extra = {}) {
  const id = await user('vendor', { createdAt: new Date('2026-01-01T00:00:00Z'), displayName: 'Asha Owner', vendorProfile: JSON.stringify({ businessName: 'Credit Shop', status: 'published' }), ...extra });
  const caseId = uid('kyc');
  await db('PartnerKycCase').insert({ id: caseId, partnerType: 'vendor', userId: id, status: 'approved', tier: 3, updatedAt: new Date() });
  await db('PartnerSettlementAccount').insert({
    id: uid('psa'), caseId, method: 'bank', provider: 'CRDB', accountName: 'Credit Shop', accountNumber: '0150001234',
    status: 'verified', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z'), cooldownUntil: new Date('2026-09-03T00:00:00Z'), updatedAt: new Date(),
  });
  return id;
}
const as = id => ({ sub: id, userType: 'vendor' });
const staffOf = (id, vendorId) => ({ sub: id, userType: 'vendor_staff', vendorId });
const staff = (vendorId, permissions, extra = {}) => user('vendor_staff', { vendorId, vendorPermissions: permissions, accountStatus: 'active', vendorRole: 'sales', displayName: 'Neema Staff', ...extra });

async function product(vendorId, body = {}) {
  const out = await call(vendorCreateProduct, as(vendorId), { body: { name: 'Whey 1kg', category: 'supplements_nutrition', priceTzs: 45_000, stock: 50, ...body } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  made.products.push(out.body.id);
  await shopService.adminUpdateProductListing({ productId: out.body.id, body: { approvalStatus: 'approved' }, actorId: 'adm_s4' });
  return out.body;
}
const saleBody = (lines, payments, extra = {}) => ({ clientRef: randomUUID(), lines, payments, ...extra });
const cash = amountTzs => [{ method: 'cash', amountTzs }];
const sell = (claims, body) => call(vendorRecordSale, claims, { body });
const cart = items => ({ items, deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni Plot 12, Dar', paymentMethod: 'mpesa' });
const addCustomer = async (claims, body) => {
  const out = await call(vendorCustomersCreate, claims, { body: { name: 'Juma Mussa', ...body } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.customer;
};
const credit = (claims, customerId, total, productId, paid = [], extra = {}) => sell(claims, saleBody([{ productId, qty: 1, unitPriceTzs: total }], paid, { kind: 'credit', customerId, ...extra }));
const pay = (claims, customerId, body) => call(vendorCustomerRecordPayment, claims, { params: { id: customerId }, body: { clientRef: randomUUID(), method: 'cash', ...body } });
const profile = (claims, id) => call(vendorCustomerGet, claims, { params: { id } });
const saleRow = id => db('VendorSale').where({ id }).first();
/** Every money CHECK of a sale, read back from the database. */
async function assertSaleAddsUp(id) {
  const s = await saleRow(id);
  assert.equal(s.paidTzs - s.changeTzs + s.balanceTzs, s.totalTzs, `sale ${s.number} adds up`);
  assert.ok(s.allocatedTzs >= 0 && s.allocatedTzs <= s.paidTzs, 'allocated within paid');
  const live = await db('VendorPaymentAllocation').where({ saleId: id }).whereNull('voidedAt').sum({ n: 'amountTzs' }).first();
  assert.equal(Number(live.n || 0), s.allocatedTzs, 'allocatedTzs = Σ live allocations');
  return s;
}
/** Place an app order and confirm its payment (as S3's settlement spec does). */
async function paidOrder(buyerId, items) {
  const placed = await shopService.createOrder({ buyerId, body: cart(items) });
  assert.equal(placed.status, 202, JSON.stringify(placed));
  made.orders.push(placed.order.id);
  const paid = await adminPaymentService.decide({ id: placed.paymentRequest.id, decision: 'approve', reference: `MP-${randomUUID().slice(0, 8)}`, amountTzs: placed.order.totalTzs, actorId: uid('adm') });
  assert.equal(paid.paymentRequest.status, 'approved');
  return placed.order;
}
/** A credit sale written straight to the table (aging boundaries need chosen due dates). */
let seqBase = 900_000;
async function creditRow(vendorId, customerId, { total, dueDate, soldAt = new Date('2026-06-01T09:00:00Z'), paid = 0 }) {
  const id = uid('sal');
  seqBase += 1;
  await db('VendorSale').insert({
    id, vendorId, seq: seqBase, number: `T-${seqBase}`, kind: 'credit', status: 'completed', customerId, soldAt, subtotalTzs: total, totalTzs: total,
    paidTzs: paid, changeTzs: 0, balanceTzs: total - paid, dueDate, clientRef: uid('ref'), fingerprint: 'spec', createdBy: vendorId,
  });
  return id;
}
/**
 * Route-level specs compare with "today" in EAT, which the server computes again per request. Never
 * start one in the last 15 s before 00:00 EAT (21:00 UTC): wait until the new EAT day has begun, so a
 * day boundary can never fall between the spec's "today" and the server's (the 21:00–22:00 UTC flake).
 */
async function awayFromEatMidnight() {
  const msToMidnight = (21 * 3_600_000 - (Date.now() % 86_400_000) + 86_400_000) % 86_400_000;
  if (msToMidnight < 15_000) await new Promise(resolve => setTimeout(resolve, msToMidnight + 250));
}
const store = createPgVendorCustomerStore({ db });
const saleStore = createPgVendorSaleStore({ db });
/** The customer service on a fixed clock: aging never depends on when the suite runs (no 21:00 UTC flake). */
const atClock = (iso, extra = {}) => createVendorCustomerService({ store, saleStore, saleService: vendorSaleService, now: () => new Date(iso), customersOn: () => true, ...extra });

after(async () => {
  for (const s of servers) s.close();
  const vendors = made.users;
  const saleIds = (await db('VendorSale').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  const paymentIds = (await db('VendorCustomerPayment').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  const customerIds = (await db('VendorCustomer').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  await db('AuditLog').whereIn('target', [...saleIds, ...paymentIds, ...customerIds, ...made.orders, ...made.products]).del();
  await db('VendorCustomerPayment').whereIn('vendorId', vendors).del(); // allocations go with it
  await db('VendorSale').whereIn('vendorId', vendors).del();
  await db('VendorCustomer').whereIn('vendorId', vendors).del();
  await db('VendorOverdueDigest').whereIn('vendorId', vendors).del();
  await db('VendorDocumentSequence').whereIn('vendorId', vendors).del();
  await db('VendorBuyerRef').whereIn('vendorId', vendors).del();
  await db('VendorSettlementLine').whereIn('vendorId', vendors).del();
  await db('VendorSettlement').whereIn('vendorId', vendors).del();
  await db('ShopOrderLineCost').whereIn('orderId', made.orders).del();
  await db('ShopStockMovement').whereIn('productId', made.products).del();
  await db('MarketplaceNotification').whereIn('userId', vendors).del();
  await db('Notification').whereIn('userId', vendors).del();
  await db('PaymentRequest').whereIn('orderId', made.orders).del();
  await db('ShopOrder').whereIn('id', made.orders).del();
  await db('Product').whereIn('id', made.products).del();
  await db('PartnerSettlementAccount').whereIn('caseId', db('PartnerKycCase').whereIn('userId', vendors).select('id')).del();
  await db('PartnerKycCase').whereIn('userId', vendors).del();
  await db('User').whereIn('id', vendors).del().catch(() => {});
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

test('rules: phone normalised to +255, EAT aging buckets, oldest-first allocation, payment and customer parsing, credit pricing', () => {
  for (const raw of ['0712345678', '712345678', '+255712345678', '255 712 345 678', '0712-345-678']) assert.equal(normalisePhone(raw), '+255712345678', raw);
  assert.equal(normalisePhone('0612345678'), '+255612345678');
  for (const bad of ['0812345678', '12345', '+254712345678', '07123456789', '']) assert.equal(normalisePhone(bad), null, bad);
  assert.deepEqual([0, -3, 1, 30, 31, 60, 61, 90, 91, 400].map(agingBucket), ['current', 'current', 'd1_30', 'd1_30', 'd31_60', 'd31_60', 'd61_90', 'd61_90', 'd90plus', 'd90plus']);
  assert.equal(daysBetween('2026-10-20', '2026-07-21'), 91);
  assert.equal(daysBetween('2026-10-20', '2026-09-19'), 31);
  assert.equal(addDays('2026-12-28', 7), '2027-01-04');
  // 20:59:59 UTC is still the EAT day 23:59:59; 21:00 UTC is the next EAT day.
  assert.equal(eatToday(new Date('2026-10-20T20:59:59Z')), '2026-10-20');
  assert.equal(eatToday(new Date('2026-10-20T21:00:00Z')), '2026-10-21');
  assert.deepEqual(allocateOldestFirst([{ id: 'r1', balanceTzs: 20_000 }, { id: 'r2', balanceTzs: 30_000 }], 25_000), [{ saleId: 'r1', amountTzs: 20_000 }, { saleId: 'r2', amountTzs: 5_000 }]);
  assert.deepEqual(allocateOldestFirst([{ id: 'r1', balanceTzs: 20_000 }], 20_000), [{ saleId: 'r1', amountTzs: 20_000 }]);
  assert.equal(paymentNumber(1), 'PMT-000001');
  // L6: a retry without receivedOn that crosses 00:00 EAT has the same fingerprint (it replays).
  const noDate = { clientRef: 'abcdefgh', amountTzs: 5_000, method: 'cash' };
  assert.equal(paymentFingerprint('c1', parsePayment(noDate, { today: '2026-10-20' })), paymentFingerprint('c1', parsePayment(noDate, { today: '2026-10-21' })));
  assert.notEqual(paymentFingerprint('c1', parsePayment(noDate, { today: '2026-10-20' })), paymentFingerprint('c1', parsePayment({ ...noDate, receivedOn: '2026-10-20' }, { today: '2026-10-20' })));
  const limiter = createVendorLimiter({ perMinute: 2 });
  assert.deepEqual([limiter.allow('v', 0).ok, limiter.allow('v', 1).ok, limiter.allow('v', 2), limiter.allow('w', 2).ok, limiter.allow('v', 60_000).ok], [true, true, { ok: false, retryAfterSeconds: 60 }, true, true]);

  const today = '2026-10-20';
  const ok = parsePayment({ clientRef: 'abcdefgh', amountTzs: 5_000, method: 'mpesa', reference: ' qk12 ', receivedOn: '2026-09-20' }, { today });
  assert.deepEqual([ok.reference, ok.receivedOn, ok.allocations], ['qk12', '2026-09-20', null]);
  assert.deepEqual(parsePayment({ clientRef: 'abcdefgh', amountTzs: 5_000, method: 'cash', receivedOn: '2026-09-19' }, { today }), { error: 'received_on_invalid', status: 400, earliest: '2026-09-20', latest: today });
  assert.equal(parsePayment({ clientRef: 'abcdefgh', amountTzs: 5_000, method: 'cash', receivedOn: '2026-10-21' }, { today }).error, 'received_on_invalid', 'never in the future');
  assert.equal(parsePayment({ clientRef: 'abcdefgh', amountTzs: 5_000, method: 'bank' }, { today }).error, 'reference_required');
  assert.equal(parsePayment({ clientRef: 'abcdefgh', amountTzs: 5_000, method: 'cash' }, { today }).receivedOn, today, 'default today');
  assert.deepEqual(parsePayment({ clientRef: 'abcdefgh', amountTzs: 5_000, method: 'cash', allocations: [{ saleId: 'a', amountTzs: 4_000 }] }, { today }), { error: 'allocation_mismatch', status: 400, amountTzs: 5_000, allocatedTzs: 4_000 });
  assert.equal(parsePayment({ clientRef: 'abcdefgh', amountTzs: 5_000, method: 'cash', allocations: [{ saleId: 'a', amountTzs: 2_500 }, { saleId: 'a', amountTzs: 2_500 }] }, { today }).reason, 'duplicate_sale');

  assert.deepEqual(parseCustomer({ name: 'Juma', phone: '0712345678' }).fields, { name: 'Juma', phone: '+255712345678' });
  assert.equal(parseCustomer({ name: 'J' }).error, 'name_invalid');
  assert.equal(parseCustomer({ name: 'Juma', phone: '123' }).error, 'phone_invalid');
  assert.equal(parseCustomer({ name: 'Juma', email: 'not-an-email' }).error, 'email_invalid');
  assert.deepEqual(parseCustomer({ phone: '0712345678' }, { partial: true, source: 'marketplace' }), { error: 'field_not_editable', status: 400, field: 'phone' });
  assert.deepEqual(parseCustomer({ note: 'ok', archived: true }, { partial: true, source: 'marketplace' }), { fields: { note: 'ok' }, archived: true, expectUpdatedAt: null });
  assert.deepEqual(parseCustomer({ name: 'Juma', email: 'a@b.co' }, { fields: ['name', 'phone'] }), { error: 'vendor_permission_forbidden', status: 403, requiredPermission: 'customers', field: 'email' });

  const priced = [{ productId: 'a', variant: null, qty: 1, unitPriceTzs: null, discountTzs: 0, listPriceTzs: 95_000 }];
  assert.deepEqual([priceSale(priced, 0, cash(20_000), { credit: true }).balanceTzs, priceSale(priced, 0, [], { credit: true }).balanceTzs], [75_000, 95_000]);
  assert.equal(priceSale(priced, 0, cash(95_000), { credit: true }).error, 'credit_fully_paid');
  assert.equal(priceSale(priced, 0, cash(96_000), { credit: true }).error, 'change_not_allowed');
  assert.equal(priceSale(priced, 0, cash(96_000)).balanceTzs, 0, 'a cash sale owes nothing');
  assert.equal(parseSale({ clientRef: 'abcdefgh', lines: [{ productId: 'a', qty: 1 }], kind: 'credit' }).error, 'customer_required');
  assert.equal(parseSale({ clientRef: 'abcdefgh', lines: [{ productId: 'a', qty: 1 }], dueDate: '2026-10-27' }).field, 'dueDate', 'a due date is for pay later only');
  assert.equal(parseSale({ clientRef: 'abcdefgh', lines: [{ productId: 'a', qty: 1 }], kind: 'credit', customerId: 'c', dueDate: '2026-02-30' }).field, 'dueDate');
  assert.deepEqual(dueDateOutOfRange('2026-10-19', '2026-10-20'), { error: 'due_date_out_of_range', status: 400, earliest: '2026-10-20', latest: '2027-10-20' });
  assert.equal(dueDateOutOfRange('2027-10-20', '2026-10-20'), null);
  // S3 fingerprints do not change (retries of sales recorded before S4 still replay).
  const s3 = parseSale({ clientRef: 'abcdefgh', lines: [{ productId: 'a', qty: 1 }], payments: cash(1) });
  assert.equal(saleFingerprint(s3), saleFingerprint({ ...s3, kind: undefined, customerId: undefined, dueDate: undefined }));
});

// ── flag and discovery ───────────────────────────────────────────────────────

test('flag off: every customer endpoint answers 404 feature_disabled, sales refuse a customer or pay later, /vendor/orders?customerId 404; options show customers only with both flags', async () => {
  const v = await vendor();
  const p = await product(v);
  const routes = [
    [vendorCustomersList, {}], [vendorCustomersCreate, { body: { name: 'Juma' } }], [vendorCustomerGet, { params: { id: 'cus_x' } }],
    [vendorCustomerUpdate, { params: { id: 'cus_x' }, body: { note: 'x' } }], [vendorCustomerSales, { params: { id: 'cus_x' } }],
    [vendorCustomerSale, { params: { id: 'cus_x', saleId: 'sal_x' } }], [vendorCustomerOrders, { params: { id: 'cus_x' } }],
    [vendorCustomerPayments, { params: { id: 'cus_x' } }], [vendorCustomerRecordPayment, { params: { id: 'cus_x' }, body: {} }],
    [vendorCustomerPayment, { params: { id: 'cus_x', paymentId: 'cpm_x' } }], [vendorCustomerVoidPayment, { params: { id: 'cus_x', paymentId: 'cpm_x' }, body: { reason: 'xyz' } }],
    [vendorReceivablesAging, {}],
  ];
  for (const [route, opts] of routes) assert.deepEqual(await call(route, as(v), opts), { status: 404, body: { error: 'feature_disabled' } }, route.path);
  assert.deepEqual((await call(vendorOrders, as(v), { query: { customerId: 'cus_x' } })).body, { error: 'feature_disabled' });
  assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.customers, false);

  process.env.VENDOR_TOOLS = '1';
  process.env.VENDOR_WALKIN_SALES = '1';
  const refused = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(45_000), { customerId: 'cus_x' }));
  assert.deepEqual([refused.status, refused.body], [404, { error: 'feature_disabled', feature: 'customers' }]);
  assert.equal((await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], [], { kind: 'credit', customerId: 'cus_x' }))).status, 404);
  assert.equal((await call(vendorListSales, as(v), { query: { customerId: 'cus_x' } })).status, 404);
  assert.equal((await db('Product').where({ id: p.id }).first()).stock, 50, 'nothing sold');
  process.env.VENDOR_CUSTOMERS = '1';
  delete process.env.VENDOR_TOOLS;
  assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.customers, false, 'no umbrella, no tool');
  assert.equal((await call(vendorCustomersList, as(v))).status, 404);
  process.env.VENDOR_TOOLS = '1';
  assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.customers, true);
  assert.equal((await call(vendorCustomersList, as(v))).status, 200);
});

// ── customers: create, edit, archive ─────────────────────────────────────────

test('walk-in customers: phone saved as +255…, duplicate phone warns but saves, edit with updatedAt check, archive refused while owing, archived leave the picker and cannot buy', async () => {
  on();
  const v = await vendor();
  const p = await product(v);
  const juma = await call(vendorCustomersCreate, as(v), { body: { name: '  Juma Mussa ', phone: '0712 345 678', email: 'Juma@Example.com', address: 'Sinza', note: 'Pays monthly' } });
  assert.equal(juma.status, 201, JSON.stringify(juma.body));
  assert.deepEqual(Object.keys(juma.body.customer).sort(), ['address', 'archived', 'archivedAt', 'createdAt', 'email', 'forgotten', 'id', 'name', 'note', 'phone', 'source', 'updatedAt']);
  assert.deepEqual([juma.body.customer.name, juma.body.customer.phone, juma.body.customer.email, juma.body.customer.source, juma.body.phoneDuplicate], ['Juma Mussa', '+255712345678', 'juma@example.com', 'manual', null]);
  assert.match(juma.body.customer.id, /^cus_[0-9a-f]{16}$/, 'unguessable id');
  const twin = await call(vendorCustomersCreate, as(v), { body: { name: 'Juma M. (shop 2)', phone: '+255712345678' } });
  assert.equal(twin.status, 201);
  assert.deepEqual(twin.body.phoneDuplicate, { id: juma.body.customer.id, name: 'Juma Mussa' }, 'Q-7: warned, not blocked');
  for (const [body, error] of [[{ name: 'J' }, 'name_invalid'], [{ name: 'Juma', phone: '0812345678' }, 'phone_invalid'], [{ name: 'Juma', email: 'x' }, 'email_invalid'], [{ name: 'Juma', note: 'x'.repeat(501) }, 'note_too_long']]) {
    assert.equal((await call(vendorCustomersCreate, as(v), { body })).body.error, error);
  }

  const id = juma.body.customer.id;
  const stale = juma.body.customer.updatedAt;
  const edited = await call(vendorCustomerUpdate, as(v), { params: { id }, body: { address: 'Mwenge', updatedAt: stale } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.customer.address, 'Mwenge');
  const conflict = await call(vendorCustomerUpdate, as(v), { params: { id }, body: { note: 'other device', updatedAt: stale } });
  assert.deepEqual([conflict.status, conflict.body.error, conflict.body.updatedAt], [409, 'customer_changed', edited.body.customer.updatedAt]);

  // Owing → archive refused; paid off → archived, out of the picker, cannot be put on a sale; restore brings it back.
  const owing = await credit(as(v), id, 10_000, p.id);
  assert.equal(owing.status, 201, JSON.stringify(owing.body));
  assert.deepEqual((await call(vendorCustomerUpdate, as(v), { params: { id }, body: { archived: true } })).body, { error: 'customer_has_balance', owedTzs: 10_000 });
  assert.equal((await pay(as(v), id, { amountTzs: 10_000 })).status, 201);
  const archived = await call(vendorCustomerUpdate, as(v), { params: { id }, body: { archived: true } });
  assert.deepEqual([archived.status, archived.body.customer.archived], [200, true]);
  const picker = await call(vendorCustomersList, as(v), { query: { q: 'Juma' } });
  assert.deepEqual(picker.body.customers.map(c => c.id), [twin.body.customer.id]);
  assert.deepEqual((await call(vendorCustomersList, as(v), { query: { filter: 'archived' } })).body.customers.map(c => c.id), [id]);
  const blocked = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(45_000), { customerId: id }));
  assert.deepEqual([blocked.status, blocked.body.error], [409, 'customer_archived']);
  assert.equal((await pay(as(v), id, { amountTzs: 1 })).body.error, 'customer_archived');
  assert.equal((await call(vendorCustomerUpdate, as(v), { params: { id }, body: { archived: false } })).body.customer.archived, false);
  assert.equal((await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(45_000), { customerId: id }))).status, 201);
  assert.ok(await db('AuditLog').where({ target: id, action: 'vendor_customer_archived' }).first(), 'archive audited');
  const audit = await db('AuditLog').where({ target: id, action: 'vendor_customer_created' }).first();
  assert.doesNotMatch(JSON.stringify(audit), /712345678|example\.com|Sinza/, 'audit rows carry field names, never the personal data');
});

test('list: search by name and by phone digits, filters and sorts, paging; summary money per row', async () => {
  on();
  const v = await vendor();
  const p = await product(v);
  const a = await addCustomer(as(v), { name: 'Amina Ally', phone: '0754111222' });
  const b = await addCustomer(as(v), { name: 'Baraka Bakari' });
  const c = await addCustomer(as(v), { name: 'Chausiku 100%_x' });
  assert.equal((await credit(as(v), b.id, 30_000, p.id)).status, 201);
  assert.equal((await credit(as(v), a.id, 10_000, p.id)).status, 201);
  await creditRow(v, c.id, { total: 5_000, dueDate: '2026-01-01' }); // long overdue
  const list = q => call(vendorCustomersList, as(v), { query: q });
  assert.deepEqual((await list({ q: '0754 111' })).body.customers.map(x => x.id), [a.id], 'phone digits, typed with the leading 0');
  assert.deepEqual((await list({ q: '111222' })).body.customers.map(x => x.id), [a.id]);
  assert.deepEqual((await list({ q: 'bakari' })).body.customers.map(x => x.id), [b.id], 'name, any case');
  assert.deepEqual((await list({ q: '100%' })).body.customers.map(x => x.id), [c.id], 'LIKE wildcards are matched literally');
  assert.deepEqual((await list({ q: '%' })).body.customers.map(x => x.id), [c.id]);
  assert.deepEqual((await list({})).body.customers.map(x => x.id), [a.id, b.id, c.id], 'name A–Z');
  assert.deepEqual((await list({ sort: 'owed' })).body.customers.map(x => x.id), [b.id, a.id, c.id]);
  assert.deepEqual((await list({ sort: 'overdue' })).body.customers.map(x => x.id)[0], c.id);
  assert.deepEqual((await list({ filter: 'overdue' })).body.customers.map(x => x.id), [c.id]);
  assert.deepEqual((await list({ filter: 'owes' })).body.customers.map(x => x.id).sort(), [a.id, b.id, c.id].sort());
  assert.deepEqual((await list({ bucket: 'd90plus' })).body.customers.map(x => x.id), [c.id]);
  const row = (await list({ q: 'Baraka' })).body.customers[0];
  assert.deepEqual(Object.keys(row).sort(), ['aging', 'archived', 'forgotten', 'id', 'lastPurchaseAt', 'maxDaysOverdue', 'name', 'oldestDueDate', 'overdueTzs', 'owedTzs', 'phone', 'source'].sort());
  assert.deepEqual([row.owedTzs, row.overdueTzs, row.aging.current], [30_000, 0, 30_000]);
  assert.ok(row.lastPurchaseAt, 'last purchase from the shop sale');
  const first = await list({ limit: 2 });
  assert.equal(first.body.customers.length, 2);
  const second = await list({ limit: 2, cursor: first.body.nextCursor });
  assert.deepEqual([second.body.customers.map(x => x.id), second.body.nextCursor], [[c.id], null]);
  for (const [q, error] of [[{ filter: 'x' }, 'invalid_filter'], [{ sort: 'x' }, 'invalid_sort'], [{ bucket: 'x' }, 'invalid_bucket'], [{ cursor: '!!' }, 'invalid_cursor'], [{ limit: '0' }, 'invalid_limit'], [{ q: 'x'.repeat(81) }, 'invalid_query']]) {
    assert.equal((await list(q)).body.error, error);
  }
});

// ── permissions ──────────────────────────────────────────────────────────────

test('permissions: `sales` only gets the picker without amounts and quick-add (name + phone); pay later needs sales AND customers; payments need customers; staff of a suspended vendor are refused', async () => {
  on();
  const v = await vendor();
  const p = await product(v);
  const seller = await staff(v, ['sales']);
  const keeper = await staff(v, ['customers']);
  const both = await staff(v, ['sales', 'customers']);
  const orders = await staff(v, ['orders']);
  const owed = await addCustomer(as(v), { name: 'Rehema Owes', phone: '0712000999' });
  assert.equal((await credit(as(v), owed.id, 40_000, p.id)).status, 201);

  // Picker: names and the last 3 phone digits, never money (also not on the wire).
  const picker = await call(vendorCustomersList, staffOf(seller, v), { query: { q: 'Rehema' } });
  assert.equal(picker.status, 200, JSON.stringify(picker.body));
  assert.deepEqual(picker.body, { customers: [{ id: owed.id, source: 'manual', name: 'Rehema Owes', phoneLast3: '999', forgotten: false }], nextCursor: null });
  assert.doesNotMatch(JSON.stringify(picker.body), /owed|Tzs|aging|712000/);
  // L7: the picker searches phones by the start of the number, ≥ 7 digits; never a short substring.
  const pick = async q => (await call(vendorCustomersList, staffOf(seller, v), { query: { q } })).body.customers.map(c => c.id);
  // ≥ 7 digits of the local number (after a leading 0 or 255): 0712000 is 6, 07120009 is 7.
  assert.deepEqual([await pick('999'), await pick('000999'), await pick('0712000'), await pick('07120009'), await pick('+255712000999')], [[], [], [], [owed.id], [owed.id]]);
  assert.deepEqual((await call(vendorCustomersList, as(v), { query: { q: '000999' } })).body.customers.map(c => c.id), [owed.id], 'customers: digit substring still works');
  for (const query of [{ filter: 'owes' }, { filter: 'archived' }, { sort: 'owed' }, { bucket: 'd1_30' }]) {
    assert.equal((await call(vendorCustomersList, staffOf(seller, v), { query })).body.error, 'vendor_permission_forbidden', JSON.stringify(query));
  }
  const quick = await call(vendorCustomersCreate, staffOf(seller, v), { body: { name: 'Quick Add', phone: '0713000111' } });
  assert.deepEqual([quick.status, quick.body.customer], [201, { id: quick.body.customer.id, source: 'manual', name: 'Quick Add', phoneLast3: '111', forgotten: false }]);
  assert.deepEqual((await call(vendorCustomersCreate, staffOf(seller, v), { body: { name: 'Quick Add', address: 'Kariakoo' } })).body, { error: 'vendor_permission_forbidden', requiredPermission: 'customers', field: 'address' });
  for (const [route, opts] of [[vendorCustomerGet, { params: { id: owed.id } }], [vendorCustomerUpdate, { params: { id: owed.id }, body: { note: 'x' } }], [vendorReceivablesAging, {}], [vendorCustomerPayments, { params: { id: owed.id } }]]) {
    assert.equal((await call(route, staffOf(seller, v), opts)).status, 403, route.path);
  }
  const sellerPays = await pay(staffOf(seller, v), owed.id, { amountTzs: 1_000 });
  assert.deepEqual([sellerPays.status, sellerPays.body.requiredPermission], [403, 'customers'], 'Q-3: only customers records payments');
  // A paid sale with a customer: `sales` is enough. Pay later: refused without `customers`.
  assert.equal((await sell(staffOf(seller, v), saleBody([{ productId: p.id, qty: 1 }], cash(45_000), { customerId: owed.id }))).status, 201);
  assert.deepEqual((await credit(staffOf(seller, v), owed.id, 9_000, p.id)).body, { error: 'credit_not_allowed', requiredPermission: 'customers' });
  const bothSale = await credit(staffOf(both, v), owed.id, 9_000, p.id);
  assert.equal(bothSale.status, 201, 'sales + customers may sell on credit');
  assert.ok(Array.isArray(bothSale.body.sale.allocations));
  // M3: `sales` without `customers` sees each sale's balance and due date, never payment allocations,
  // the customerId filter or the pay-later summary.
  const seen = (await call(vendorGetSale, staffOf(seller, v), { params: { id: bothSale.body.sale.id } })).body.sale;
  assert.deepEqual([seen.allocations, seen.balanceTzs, seen.dueDate != null, seen.customer.id], [undefined, 9_000, true, owed.id]);
  const sellerList = await call(vendorListSales, staffOf(seller, v));
  assert.equal(sellerList.status, 200);
  assert.deepEqual([sellerList.body.summary.owedTzs, sellerList.body.summary.payLaterTzs, typeof sellerList.body.sales[0].balanceTzs], [undefined, undefined, 'number']);
  assert.deepEqual((await call(vendorListSales, staffOf(seller, v), { query: { customerId: owed.id } })).body, { error: 'vendor_permission_forbidden', requiredPermission: 'customers', field: 'customerId' });
  assert.equal((await call(vendorListSales, staffOf(both, v), { query: { customerId: owed.id } })).body.summary.owedTzs > 0, true);
  // `customers` only: everything about customers, no POS.
  assert.equal((await call(vendorCustomerGet, staffOf(keeper, v), { params: { id: owed.id } })).status, 200);
  assert.equal((await pay(staffOf(keeper, v), owed.id, { amountTzs: 1_000 })).status, 201);
  assert.equal((await call(vendorCustomerSales, staffOf(keeper, v), { params: { id: owed.id } })).status, 200, 'profile activity without `sales`');
  assert.equal((await credit(staffOf(keeper, v), owed.id, 9_000, p.id)).status, 403);
  // Neither permission; disabled staff; staff of a suspended vendor.
  assert.equal((await call(vendorCustomersList, staffOf(orders, v))).status, 403);
  await db('User').where({ id: keeper }).update({ accountStatus: 'disabled' });
  assert.equal((await call(vendorCustomerGet, staffOf(keeper, v), { params: { id: owed.id } })).status, 403);
  await db('User').where({ id: v }).update({ accountStatus: 'suspended' });
  assert.deepEqual((await call(vendorCustomersList, staffOf(both, v))).body, { error: 'vendor_suspended' });
  await db('User').where({ id: v }).update({ accountStatus: 'active' });

  // Mounted with prefix guards: a route's guard never leaks onto its sub-paths or other methods.
  assert.equal((await hit('GET', '/vendor/customers?q=Rehema', staffOf(seller, v))).status, 200);
  assert.equal((await hit('GET', `/vendor/customers/${owed.id}`, staffOf(seller, v))).status, 403);
  assert.equal((await hit('GET', `/vendor/customers/${owed.id}/payments`, staffOf(both, v))).status, 200);
  assert.equal((await hit('POST', `/vendor/customers/${owed.id}/payments`, staffOf(seller, v), { clientRef: randomUUID(), amountTzs: 1, method: 'cash' })).status, 403);
  assert.equal((await hit('GET', '/vendor/receivables/aging', staffOf(both, v))).status, 200);
});

// ── pay-later sales ──────────────────────────────────────────────────────────

test('pay later: paid now + balance, default due = sale EAT day + 7, range checks, zero paid now, receipt fields; never change', async () => {
  on();
  await awayFromEatMidnight();
  const v = await vendor();
  const p = await product(v, { priceTzs: 95_000, stock: 10 });
  const c = await addCustomer(as(v), { name: 'Juma M.', phone: '0712345678' });
  const out = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(20_000), { kind: 'credit', customerId: c.id }));
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const s = out.body.sale;
  const day = eatToday(new Date(s.soldAt));
  assert.deepEqual([s.kind, s.totalTzs, s.paidTzs, s.paidAtSaleTzs, s.balanceTzs, s.changeTzs, s.dueDate, s.customer, s.allocations], ['credit', 95_000, 20_000, 20_000, 75_000, 0, addDays(day, 7), { id: c.id, name: 'Juma M.', forgotten: false }, []]);
  // Contract check #224 item 7: a replay is answered before the customers flag is checked.
  delete process.env.VENDOR_CUSTOMERS;
  const queued = await sell(as(v), { clientRef: s.clientRef, lines: [{ productId: p.id, qty: 1 }], payments: cash(20_000), kind: 'credit', customerId: c.id });
  assert.deepEqual([queued.status, queued.body.sale?.id], [200, s.id], 'replayed with the flag off');
  assert.equal((await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(20_000), { kind: 'credit', customerId: c.id }))).body.error, 'feature_disabled', 'a new one is still refused');
  process.env.VENDOR_CUSTOMERS = '1';
  assert.doesNotMatch(JSON.stringify(s), /712345678/, 'no customer phone on the sale');
  assert.equal((await db('Product').where({ id: p.id }).first()).stock, 9, 'stock left as for any sale');
  await assertSaleAddsUp(s.id);

  // Every later sale here is dated like the first one, so its EAT day (and due-date window) is `day`.
  const zero = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], [], { kind: 'credit', customerId: c.id, dueDate: addDays(day, 30), soldAt: s.soldAt }));
  assert.deepEqual([zero.status, zero.body.sale.balanceTzs, zero.body.sale.dueDate], [201, 95_000, addDays(day, 30)]);
  const replay = await sell(as(v), { clientRef: zero.body.sale.clientRef, soldAt: s.soldAt, lines: [{ productId: p.id, qty: 1 }], payments: [], kind: 'credit', customerId: c.id, dueDate: addDays(day, 30) });
  assert.deepEqual([replay.status, replay.body.sale.id], [200, zero.body.sale.id], 'a retried credit sale is recorded once');

  const refuse = async (payments, extra) => (await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], payments, { kind: 'credit', customerId: c.id, soldAt: s.soldAt, ...extra }))).body;
  assert.deepEqual(await refuse([], { dueDate: addDays(day, -1) }), { error: 'due_date_out_of_range', earliest: day, latest: addDays(day, 365) });
  assert.equal((await refuse([], { dueDate: addDays(day, 366) })).error, 'due_date_out_of_range');
  assert.equal((await refuse(cash(95_000), {})).error, 'credit_fully_paid');
  assert.equal((await refuse(cash(100_000), {})).error, 'change_not_allowed');
  assert.equal((await refuse([], { customerId: undefined })).error, 'customer_required');
  assert.equal((await refuse([], { customerId: 'cus_doesnotexist0000' })).error, 'customer_not_found');
  assert.equal((await refuse([{ method: 'mpesa', amountTzs: 1_000 }], {})).error, 'reference_required', 'S3 reference rules still apply');
  assert.equal((await db('Product').where({ id: p.id }).first()).stock, 8, 'refusals moved nothing');

  const list = await call(vendorListSales, as(v), { query: { kind: 'credit' } });
  assert.deepEqual(list.body.sales.map(r => [r.kind, r.balanceTzs, r.customer?.name]).sort(), [['credit', 75_000, 'Juma M.'], ['credit', 95_000, 'Juma M.']]);
  assert.deepEqual([list.body.summary.totalTzs, list.body.summary.payLaterTzs, list.body.summary.owedTzs], [190_000, 170_000, 170_000]);
  const byMethod = list.body.summary.byMethod.reduce((sum, m) => sum + m.amountTzs, 0);
  assert.equal(byMethod + list.body.summary.payLaterTzs, list.body.summary.totalTzs, 'methods + left owing = total');
  assert.equal((await call(vendorListSales, as(v), { query: { customerId: c.id } })).body.sales.length, 2);
  assert.equal((await call(vendorListSales, as(v), { query: { kind: 'x' } })).body.error, 'invalid_kind');
});

// ── payments and allocation ──────────────────────────────────────────────────

test('payments: oldest due first (AC 24), PMT numbers continue, manual allocation, over-payment and stale allocation refused, replay records once', async () => {
  on();
  await awayFromEatMidnight();
  const v = await vendor();
  const p = await product(v);
  const c = await addCustomer(as(v), { name: 'Juma M.' });
  const today = eatToday();
  const r1 = (await credit(as(v), c.id, 20_000, p.id, [], { dueDate: addDays(today, 3) })).body.sale;
  const r2 = (await credit(as(v), c.id, 30_000, p.id, [], { dueDate: addDays(today, 10) })).body.sale;
  const first = await pay(as(v), c.id, { amountTzs: 25_000, method: 'mpesa', reference: 'QK12AB34', note: 'At the counter' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const pm = first.body.payment;
  assert.deepEqual([pm.number, pm.status, pm.amountTzs, pm.reference, pm.receivedOn, pm.recordedBy, pm.allocations], [
    'PMT-000001', 'recorded', 25_000, 'QK12AB34', today, { id: v, name: 'Asha Owner' },
    [{ saleId: r1.id, saleNumber: r1.number, amountTzs: 20_000 }, { saleId: r2.id, saleNumber: r2.number, amountTzs: 5_000 }],
  ]);
  assert.deepEqual([first.body.customer.owedTzs, first.body.customer.aging.current], [25_000, 25_000]);
  assert.deepEqual([(await saleRow(r1.id)).balanceTzs, (await saleRow(r2.id)).balanceTzs], [0, 25_000]);
  for (const id of [r1.id, r2.id]) await assertSaleAddsUp(id);
  const r1View = (await call(vendorGetSale, as(v), { params: { id: r1.id } })).body.sale;
  assert.deepEqual([r1View.balanceTzs, r1View.paidTzs, r1View.paidAtSaleTzs, r1View.allocations.map(a => [a.number, a.amountTzs, a.voided])], [0, 20_000, 0, [['PMT-000001', 20_000, false]]]);

  // Replays: same body → 200, the same payment; same clientRef, other body → 409.
  const again = await call(vendorCustomerRecordPayment, as(v), { params: { id: c.id }, body: { clientRef: pm.clientRef, amountTzs: 25_000, method: 'mpesa', reference: 'QK12AB34', note: 'At the counter' } });
  assert.deepEqual([again.status, again.body.payment.id, again.headers['Idempotent-Replay']], [200, pm.id, 'true']);
  assert.equal((await call(vendorCustomerRecordPayment, as(v), { params: { id: c.id }, body: { clientRef: pm.clientRef, amountTzs: 1, method: 'cash' } })).body.error, 'client_ref_reused');
  assert.equal(await db('VendorCustomerPayment').where({ vendorId: v }).count('* as n').first().then(r => Number(r.n)), 1);

  // O-8: more than owed → refused whole; nothing recorded, no number used.
  assert.deepEqual((await pay(as(v), c.id, { amountTzs: 25_001 })).body, { error: 'overpayment', owedTzs: 25_000 });
  // Manual allocation: must add up, each within that sale's balance.
  const r3 = (await credit(as(v), c.id, 8_000, p.id, [], { dueDate: addDays(today, 1) })).body.sale;
  assert.equal((await pay(as(v), c.id, { amountTzs: 9_000, allocations: [{ saleId: r3.id, amountTzs: 9_000 }] })).body.error, 'allocation_stale');
  assert.equal((await pay(as(v), c.id, { amountTzs: 9_000, allocations: [{ saleId: r1.id, amountTzs: 9_000 }] })).body.error, 'allocation_stale', 'a paid-off sale');
  assert.equal((await pay(as(v), c.id, { amountTzs: 9_000, allocations: [{ saleId: r2.id, amountTzs: 8_000 }] })).body.error, 'allocation_mismatch');
  const manual = await pay(as(v), c.id, { amountTzs: 25_000, allocations: [{ saleId: r2.id, amountTzs: 25_000 }] });
  assert.equal(manual.status, 201, JSON.stringify(manual.body));
  assert.deepEqual([manual.body.payment.number, manual.body.payment.allocations.map(a => a.saleId), (await saleRow(r3.id)).balanceTzs], ['PMT-000002', [r2.id], 8_000], 'not oldest-first when chosen; refusals used no number');
  assert.equal((await pay(as(v), c.id, { amountTzs: 1_000, method: 'airtel_money' })).body.error, 'reference_required');
  assert.equal((await pay(as(v), c.id, { amountTzs: 1_000, receivedOn: addDays(today, -31) })).body.error, 'received_on_invalid');
  const backdated = await pay(as(v), c.id, { amountTzs: 1_000, receivedOn: addDays(today, -30) });
  assert.deepEqual([backdated.status, backdated.body.payment.receivedOn], [201, addDays(today, -30)], 'Q-4: up to 30 days back');

  const listed = await call(vendorCustomerPayments, as(v), { params: { id: c.id }, query: { limit: 2 } });
  assert.deepEqual(listed.body.payments.map(x => x.number), ['PMT-000003', 'PMT-000002']);
  const rest = await call(vendorCustomerPayments, as(v), { params: { id: c.id }, query: { cursor: listed.body.nextCursor } });
  assert.deepEqual([rest.body.payments.map(x => x.number), rest.body.nextCursor], [['PMT-000001'], null]);
  assert.deepEqual((await call(vendorCustomerPayments, as(v), { params: { id: c.id }, query: { from: today } })).body.payments.map(x => x.number), ['PMT-000002', 'PMT-000001']);
  assert.equal((await call(vendorCustomerPayment, as(v), { params: { id: c.id, paymentId: pm.id } })).body.payment.number, 'PMT-000001');
  for (const id of [r1.id, r2.id, r3.id]) await assertSaleAddsUp(id);
});

test('concurrency: two payments racing for the same debt — one wins, the other gets overpayment; parallel payments get continuous PMT numbers; a racing retry is recorded once', async () => {
  on();
  const v = await vendor();
  const p = await product(v);
  const c = await addCustomer(as(v), { name: 'Race Customer' });
  const s = (await credit(as(v), c.id, 50_000, p.id)).body.sale;
  const raced = await Promise.all([pay(as(v), c.id, { amountTzs: 30_000 }), pay(as(v), c.id, { amountTzs: 30_000 })]);
  assert.deepEqual(raced.map(r => r.status).sort(), [201, 409]);
  assert.deepEqual(raced.find(r => r.status === 409).body, { error: 'overpayment', owedTzs: 20_000 });
  assert.equal((await assertSaleAddsUp(s.id)).balanceTzs, 20_000);

  const many = await Promise.all(Array.from({ length: 10 }, () => pay(as(v), c.id, { amountTzs: 2_000 })));
  assert.deepEqual(many.map(r => r.status), Array(10).fill(201));
  const numbers = (await db('VendorCustomerPayment').where({ vendorId: v }).orderBy('seq')).map(r => r.number);
  assert.deepEqual(numbers, Array.from({ length: 11 }, (_, i) => paymentNumber(i + 1)), 'gap-free, no duplicates');
  assert.equal((await assertSaleAddsUp(s.id)).balanceTzs, 0);

  const s2 = (await credit(as(v), c.id, 5_000, p.id)).body.sale;
  const body = { clientRef: randomUUID(), amountTzs: 5_000, method: 'cash' };
  const twice = await Promise.all([1, 2].map(() => call(vendorCustomerRecordPayment, as(v), { params: { id: c.id }, body })));
  assert.deepEqual(twice.map(r => r.status).sort(), [200, 201]);
  assert.equal(twice[0].body.payment.id, twice[1].body.payment.id);
  assert.equal((await assertSaleAddsUp(s2.id)).balanceTzs, 0);
  assert.equal(await db('VendorCustomerPayment').where({ vendorId: v }).count('* as n').first().then(r => Number(r.n)), 12);
});

// ── voids ────────────────────────────────────────────────────────────────────

test('voids: a credit sale with live payments is refused (sale_has_payments); voiding the payment reopens the balance, then the sale can be voided and leaves Owed; staff void notifies the vendor', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { stock: 10 });
  const keeper = await staff(v, ['customers'], { displayName: 'Neema Keeper' });
  const c = await addCustomer(as(v), { name: 'Void Customer' });
  const s = (await credit(as(v), c.id, 30_000, p.id, cash(5_000))).body.sale;
  const pm = (await pay(staffOf(keeper, v), c.id, { amountTzs: 10_000 })).body.payment;
  const refused = await call(vendorVoidSale, as(v), { params: { id: s.id }, body: { reason: 'customer returned it' } });
  assert.deepEqual([refused.status, refused.body], [409, { error: 'sale_has_payments', payments: [{ id: pm.id, number: pm.number }] }]);
  assert.equal((await saleRow(s.id)).status, 'completed');
  assert.equal((await db('Product').where({ id: p.id }).first()).stock, 9, 'nothing restocked');

  assert.equal((await call(vendorCustomerVoidPayment, staffOf(keeper, v), { params: { id: c.id, paymentId: pm.id }, body: { reason: 'no' } })).body.error, 'reason_required');
  const voided = await call(vendorCustomerVoidPayment, staffOf(keeper, v), { params: { id: c.id, paymentId: pm.id }, body: { reason: 'Wrong customer' } });
  assert.equal(voided.status, 200, JSON.stringify(voided.body));
  assert.deepEqual([voided.body.payment.status, voided.body.payment.voidedBy, voided.body.payment.voidReason, voided.body.customer.owedTzs], ['voided', { id: keeper, name: 'Neema Keeper' }, 'Wrong customer', 25_000]);
  const reopened = await assertSaleAddsUp(s.id);
  assert.deepEqual([reopened.balanceTzs, reopened.paidTzs, reopened.allocatedTzs], [25_000, 5_000, 0]);
  assert.deepEqual((await call(vendorCustomerVoidPayment, as(v), { params: { id: c.id, paymentId: pm.id }, body: { reason: 'again' } })).body.error, 'already_voided');
  // M2: other staff void only their own payments, on the EAT day received; vendor-admin staff any.
  const other = await staff(v, ['customers'], { displayName: 'Other Keeper' });
  const admin = await staff(v, ['customers'], { vendorRole: 'admin', displayName: 'Admin Staff' });
  const byVendor = (await pay(as(v), c.id, { amountTzs: 1_000 })).body.payment;
  const backdated = (await pay(staffOf(keeper, v), c.id, { amountTzs: 1_000, receivedOn: addDays(eatToday(), -1) })).body.payment;
  const voidAs = (claims, payment) => call(vendorCustomerVoidPayment, claims, { params: { id: c.id, paymentId: payment.id }, body: { reason: 'Mistake here' } });
  assert.deepEqual((await voidAs(staffOf(keeper, v), byVendor)).body, { error: 'void_not_allowed', reason: 'not_own' });
  assert.deepEqual((await voidAs(staffOf(other, v), backdated)).body, { error: 'void_not_allowed', reason: 'not_own' });
  assert.deepEqual((await voidAs(staffOf(keeper, v), backdated)).body, { error: 'void_not_allowed', reason: 'too_old' });
  assert.equal((await voidAs(staffOf(keeper, v), pm)).body.error, 'already_voided', 'own payment, already voided');
  assert.equal((await voidAs(staffOf(admin, v), byVendor)).status, 200, 'vendor-admin staff void any');
  assert.equal((await voidAs(as(v), backdated)).status, 200, 'the vendor account voids any');
  const note = await db('MarketplaceNotification').where({ userId: v, type: 'vendor_customer_payment_voided' }).first();
  assert.equal(note?.data?.number ?? JSON.parse(note?.data || '{}').number, pm.number, 'a staff void is reported to the vendor');
  const saleView = (await call(vendorGetSale, as(v), { params: { id: s.id } })).body.sale;
  assert.equal(saleView.allocations[0].number, pm.number);
  assert.equal(saleView.allocations.every(a => a.voided), true, 'every payment towards it is voided');

  const ok = await call(vendorVoidSale, as(v), { params: { id: s.id }, body: { reason: 'customer returned it' } });
  assert.deepEqual([ok.status, ok.body.sale.status, ok.body.sale.balanceTzs], [200, 'voided', 25_000], 'the balance it had is kept, never counted');
  assert.equal((await db('Product').where({ id: p.id }).first()).stock, 10, 'restocked once');
  const prof = (await profile(as(v), c.id)).body.customer;
  assert.deepEqual([prof.owedTzs, prof.openSales], [0, []]);
  assert.equal((await call(vendorReceivablesAging, as(v))).body.rows.length, 0);
  assert.equal((await pay(as(v), c.id, { amountTzs: 1 })).body.error, 'overpayment', 'nothing left to pay');

  // L4: an archived customer's payments cannot be voided; restore first.
  const d = await addCustomer(as(v), { name: 'Archived Payer' });
  assert.equal((await credit(as(v), d.id, 4_000, p.id)).status, 201);
  const dp = (await pay(as(v), d.id, { amountTzs: 4_000 })).body.payment;
  assert.equal((await call(vendorCustomerUpdate, as(v), { params: { id: d.id }, body: { archived: true } })).status, 200);
  assert.deepEqual((await call(vendorCustomerVoidPayment, as(v), { params: { id: d.id, paymentId: dp.id }, body: { reason: 'Mistake here' } })).body, { error: 'customer_archived' });
  await call(vendorCustomerUpdate, as(v), { params: { id: d.id }, body: { archived: false } });
  assert.equal((await call(vendorCustomerVoidPayment, as(v), { params: { id: d.id, paymentId: dp.id }, body: { reason: 'Mistake here' } })).status, 200);
});

test('add customer: optional clientRef replays (200, same customer), another body → 409; per-vendor write limit → 429 with Retry-After', async () => {
  on();
  const v = await vendor();
  const body = { clientRef: randomUUID(), name: 'Idem Potent', phone: '0715000111' };
  const both = await Promise.all([1, 2].map(() => call(vendorCustomersCreate, as(v), { body })));
  assert.deepEqual(both.map(r => r.status).sort(), [200, 201]);
  assert.equal(both[0].body.customer.id, both[1].body.customer.id);
  const again = await call(vendorCustomersCreate, as(v), { body });
  assert.deepEqual([again.status, again.headers['Idempotent-Replay'], again.body.customer.id], [200, 'true', both[0].body.customer.id]);
  assert.deepEqual((await call(vendorCustomersCreate, as(v), { body: { ...body, name: 'Other Name' } })).body, { error: 'client_ref_reused' });
  assert.equal((await call(vendorCustomersCreate, as(v), { body: { clientRef: 'short', name: 'Bad Ref' } })).body.error, 'invalid_client_ref');
  assert.equal(await db('VendorCustomer').where({ vendorId: v, name: 'Idem Potent' }).count('* as n').first().then(r => Number(r.n)), 1);
  resetVendorCustomerLimits();
  for (let i = 0; i < VENDOR_CUSTOMER_LIMITS.writesPerMinute; i += 1) assert.equal((await call(vendorCustomersCreate, as(v), { body: { name: `Bulk ${i}` } })).status, 201);
  const limited = await call(vendorCustomersCreate, as(v), { body: { name: 'One too many' } });
  assert.deepEqual([limited.status, limited.body.error, Number(limited.headers['Retry-After']) > 0], [429, 'rate_limited', true]);
  const otherVendor = await vendor();
  assert.equal((await call(vendorCustomersCreate, as(otherVendor), { body: { name: 'Other Shop' } })).status, 201, 'per vendor');
  // Searches (with q) are limited; plain page loads are not (contract check #224 item 8).
  for (let i = 0; i < VENDOR_CUSTOMER_LIMITS.searchesPerMinute; i += 1) assert.equal((await call(vendorCustomersList, as(otherVendor), { query: { q: 'Oth' } })).status, 200);
  assert.equal((await call(vendorCustomersList, as(otherVendor), { query: { q: 'Oth' } })).status, 429);
  assert.equal((await call(vendorCustomersList, as(otherVendor), { query: { limit: '20' } })).status, 200, 'a page load is not a search');
  assert.equal(await db('VendorCustomer').where({ vendorId: v, name: 'One too many' }).first(), undefined, 'nothing written');
});

test('account deletion (H1): the buyer is forgotten at every vendor — name cleared; link dropped unless money is owed, then dropped once paid off; never recreated', async () => {
  on();
  const owes = await vendor();
  const clear = await vendor();
  const po = await product(owes, { priceTzs: 10_000 });
  const pc = await product(clear, { priceTzs: 10_000 });
  const buyer = await user('member', { displayName: 'Deleting Buyer', phone: '+255766000222' });
  await paidOrder(buyer, [{ productId: po.id, qty: 1 }, { productId: pc.id, qty: 1 }]);
  const atOwes = await db('VendorCustomer').where({ vendorId: owes, buyerUserId: buyer }).first();
  const atClear = await db('VendorCustomer').where({ vendorId: clear, buyerUserId: buyer }).first();
  assert.ok(atOwes && atClear);
  assert.equal((await credit(as(owes), atOwes.id, 6_000, po.id)).status, 201);
  for (const [vendorId, id] of [[owes, atOwes.id], [clear, atClear.id]]) {
    assert.equal((await call(vendorCustomerUpdate, as(vendorId), { params: { id }, body: { note: 'Asked for delivery after 6pm' } })).status, 200);
  }
  assert.equal(await db('VendorBuyerRef').where({ buyerId: buyer }).count('* as n').first().then(r => Number(r.n)), 2);

  const deleted = await accountService.deleteMyAccount({ id: buyer, userType: 'member' });
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  const [o, c] = await Promise.all([db('VendorCustomer').where({ id: atOwes.id }).first(), db('VendorCustomer').where({ id: atClear.id }).first()]);
  assert.deepEqual([o.name, o.note, o.buyerUserId, o.forgottenAt != null], [null, null, buyer, true], 'money owed: nameless, note cleared, still linked');
  assert.deepEqual([c.name, c.note, c.buyerUserId, c.forgottenAt != null], [null, null, null, true], 'nothing owed: nameless, note cleared, unlinked');
  assert.equal(await db('VendorBuyerRef').where({ buyerId: buyer }).count('* as n').first().then(r => Number(r.n)), 0, 'S2 buyer pseudonyms deleted at every vendor');
  // Reading the vendor's orders (S2) does not create a new pseudonym for the deleted buyer.
  const orderRows = (await call(vendorOrders, as(clear))).body;
  assert.equal(orderRows.length, 1);
  assert.deepEqual([orderRows[0].buyer.customerId, orderRows[0].buyer.displayName], [null, null]);
  assert.equal(await db('VendorBuyerRef').where({ buyerId: buyer }).first(), undefined, 'still none after an order read');
  const prof = (await profile(as(owes), atOwes.id)).body.customer;
  assert.deepEqual([prof.name, prof.forgotten, prof.owedTzs], [null, true, 6_000]);
  assert.equal((await call(vendorReceivablesAging, as(owes))).body.rows.find(r => r.customerId === atOwes.id).forgotten, true, 'aging row says deleted');
  const owedSale = (await call(vendorCustomerSales, as(owes), { params: { id: atOwes.id } })).body.sales[0];
  assert.deepEqual(owedSale.customer, { id: atOwes.id, name: null, forgotten: true });
  assert.equal((await call(vendorGetSale, as(owes), { params: { id: owedSale.id } })).body.sale.customer.forgotten, true);
  assert.equal((await call(vendorCustomersList, as(clear))).body.customers.find(x => x.id === atClear.id).forgotten, true);
  assert.ok(await db('AuditLog').where({ target: atClear.id, action: 'vendor_customer_forgotten' }).first());

  assert.equal((await pay(as(owes), atOwes.id, { amountTzs: 6_000 })).status, 201);
  assert.equal((await db('VendorCustomer').where({ id: atOwes.id }).first()).buyerUserId, null, 'paid off → unlinked');
  // The backfill and the paid-order hook never bring a deleted buyer back, nor reuse a forgotten id.
  await migration.backfillMarketplaceCustomers(db);
  await store.marketplaceOrderPaid({ buyerId: buyer, items: [{ vendorId: clear }] });
  const rows = await db('VendorCustomer').whereIn('vendorId', [owes, clear]);
  assert.deepEqual(rows.map(r => [r.name, r.note, r.buyerUserId]).sort(), [[null, null, null], [null, null, null]]);
});

// ── aging (fixed clock) ──────────────────────────────────────────────────────

test('aging in EAT on a fixed clock: due today = not due yet, 30/31, 60/61, 90/91 days; the same at 23:59 EAT and flips at 00:00 EAT (21:00 UTC); profile, list and aging agree', async () => {
  const v = await vendor();
  const c = (await store.create({ vendorId: v, actorId: v, fields: { name: 'Aging Customer' } })).customer;
  const d = await store.create({ vendorId: v, actorId: v, fields: { name: 'Second Customer' } });
  const due = { '2026-10-20': 1_000, '2026-10-19': 2_000, '2026-09-20': 4_000, '2026-09-19': 8_000, '2026-08-21': 16_000, '2026-08-20': 32_000, '2026-07-22': 64_000, '2026-07-21': 128_000 };
  for (const [dueDate, total] of Object.entries(due)) await creditRow(v, c.id, { total, dueDate });
  await creditRow(v, d.customer.id, { total: 500, dueDate: '2026-12-01' });
  const expected = { current: 1_000, d1_30: 2_000 + 4_000, d31_60: 8_000 + 16_000, d61_90: 32_000 + 64_000, d90plus: 128_000 };
  // 2026-10-20 in EAT from 00:00 (2026-10-19T21:00Z) to 23:59:59 (2026-10-20T20:59:59Z).
  for (const clock of ['2026-10-19T21:00:00Z', '2026-10-20T12:00:00Z', '2026-10-20T20:59:59Z']) {
    const svc = atClock(clock);
    const prof = (await svc.getCustomer({ vendorId: v, customerId: c.id })).customer;
    assert.deepEqual([prof.asOf, prof.aging], ['2026-10-20', expected], clock);
    assert.deepEqual([prof.owedTzs, prof.overdueTzs, prof.oldestDueDate, prof.maxDaysOverdue], [255_000, 254_000, '2026-07-21', 91]);
    assert.deepEqual(prof.openSales.map(s => [s.dueDate, s.daysOverdue]).slice(0, 2), [['2026-07-21', 91], ['2026-07-22', 90]], 'oldest due first');
    assert.deepEqual(prof.openSales.at(-1).daysOverdue, 0);
    const aging = await svc.aging({ vendorId: v, query: {} });
    assert.deepEqual(aging.rows.map(r => r.customerId), [c.id, d.customer.id], 'most overdue first');
    assert.deepEqual({ current: aging.rows[0].current, d1_30: aging.rows[0].d1_30, d31_60: aging.rows[0].d31_60, d61_90: aging.rows[0].d61_90, d90plus: aging.rows[0].d90plus }, expected);
    const sum = k => aging.rows.reduce((s, r) => s + r[k], 0);
    for (const k of ['owedTzs', 'overdueTzs', 'current', 'd1_30', 'd31_60', 'd61_90', 'd90plus']) assert.equal(aging.totals[k], sum(k), `totals.${k} = Σ rows`);
    assert.deepEqual([aging.totals.customerCount, aging.totals.overdueCustomerCount, aging.totals.overdueSaleCount, aging.totals.openSaleCount], [2, 1, 7, 9]);
    const list = await svc.listCustomers({ vendorId: v, access: { customers: true }, query: { filter: 'owes' } });
    assert.deepEqual(list.customers.find(r => r.id === c.id).aging, expected);
    assert.deepEqual((await svc.aging({ vendorId: v, query: { bucket: 'current' } })).rows.map(r => r.customerId), [c.id, d.customer.id]);
    assert.deepEqual((await svc.aging({ vendorId: v, query: { bucket: 'd90plus' } })).rows.map(r => r.customerId), [c.id]);
  }
  // From 00:00 EAT on the 21st every sale is a day older.
  const next = (await atClock('2026-10-20T21:00:00Z').getCustomer({ vendorId: v, customerId: c.id })).customer;
  // 10-20 → 1, 10-19 → 2, 09-20 → 31, 09-19 → 32, 08-21 → 61, 08-20 → 62, 07-22 → 91, 07-21 → 92 days.
  assert.deepEqual([next.asOf, next.aging], ['2026-10-21', { current: 0, d1_30: 1_000 + 2_000, d31_60: 4_000 + 8_000, d61_90: 16_000 + 32_000, d90plus: 64_000 + 128_000 }]);
});

// ── A-02 privacy ─────────────────────────────────────────────────────────────

test('A-02: a paid app order makes an app customer with only a name; no phone, email, address or user id in any customer response; unpaid orders make none; the name refreshes on the next paid order', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { priceTzs: 20_000 });
  const buyer = await user('member', { displayName: 'Halima Buyer', phone: '+255799111222', email: 'halima.private@example.com' });
  const unpaidBuyer = await user('member', { displayName: 'Unpaid Buyer' });
  const placed = await shopService.createOrder({ buyerId: unpaidBuyer, body: cart([{ productId: p.id, qty: 1 }]) });
  made.orders.push(placed.order.id);
  assert.equal(await db('VendorCustomer').where({ vendorId: v, buyerUserId: unpaidBuyer }).first(), undefined, 'an unpaid order makes no customer');

  const order = await paidOrder(buyer, [{ productId: p.id, qty: 1 }]);
  const row = await db('VendorCustomer').where({ vendorId: v, buyerUserId: buyer }).first();
  assert.deepEqual([row.source, row.name, row.phone, row.email, row.address], ['marketplace', 'Halima Buyer', null, null, null]);
  const ref = await db('VendorBuyerRef').where({ vendorId: v, buyerId: buyer }).first();
  assert.equal(row.id, ref.customerId, 'the customer id is the buyer.customerId vendors already see on orders');
  const fromOrder = (await call(vendorOrders, as(v))).body.find(o => o.id === order.id);
  assert.deepEqual([fromOrder.buyer.customerId, fromOrder.buyer.customerLinked], [row.id, true], 'the profile link opens');
  const unpaidRow = (await call(vendorOrders, as(v))).body.find(o => o.id === placed.order.id);
  assert.deepEqual([typeof unpaidRow.buyer.customerId, unpaidRow.buyer.customerLinked], ['string', false], 'no customer record yet: no link');
  delete process.env.VENDOR_CUSTOMERS;
  assert.equal((await call(vendorOrders, as(v))).body.find(o => o.id === order.id).buyer.customerLinked, false, 'flag off: never linked');
  process.env.VENDOR_CUSTOMERS = '1';

  // Pay later and a payment for the app customer, so every view has something in it.
  assert.equal((await credit(as(v), row.id, 12_000, p.id)).status, 201);
  assert.equal((await pay(as(v), row.id, { amountTzs: 2_000 })).status, 201);
  const seller = await staff(v, ['sales']);
  const responses = [
    await call(vendorCustomersList, as(v)), await call(vendorCustomersList, staffOf(seller, v), { query: { q: 'Halima' } }),
    await profile(as(v), row.id), await call(vendorCustomerOrders, as(v), { params: { id: row.id } }),
    await call(vendorCustomerPayments, as(v), { params: { id: row.id } }), await call(vendorReceivablesAging, as(v)),
    await call(vendorCustomerSales, as(v), { params: { id: row.id } }), await call(vendorListSales, as(v), { query: { customerId: row.id } }),
  ];
  for (const r of responses) {
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const text = JSON.stringify(r.body);
    assert.doesNotMatch(text, /799111222|halima\.private|Mikocheni|buyerUserId/, text.slice(0, 200));
    assert.equal(text.includes(buyer), false, 'never the buyer\'s user id');
  }
  const prof = responses[2].body.customer;
  assert.deepEqual([prof.source, prof.name, prof.phone, prof.email, prof.address], ['marketplace', 'Halima Buyer', null, null, null]);
  assert.deepEqual([prof.totals.appOrdersCount, prof.totals.appOrdersTzs, prof.totals.shopSalesCount], [1, 20_000, 1]);
  assert.deepEqual(responses[3].body.orders.map(o => [o.id, o.totalTzs, o.tab]), [[order.id, 20_000, 'open']]);
  assert.deepEqual(Object.keys(responses[3].body.orders[0]).sort(), ['createdAt', 'id', 'itemCount', 'orderStatus', 'paymentStatus', 'shortRef', 'status', 'tab', 'totalTzs']);
  // Only note and archived can change on an app customer; the database refuses contact data outright.
  assert.deepEqual((await call(vendorCustomerUpdate, as(v), { params: { id: row.id }, body: { phone: '0712345678' } })).body, { error: 'field_not_editable', field: 'phone' });
  assert.equal((await call(vendorCustomerUpdate, as(v), { params: { id: row.id }, body: { note: 'Likes chocolate' } })).body.customer.note, 'Likes chocolate');
  await assert.rejects(db('VendorCustomer').where({ id: row.id }).update({ phone: '+255712345678' }), /vendorcustomer_a02/);

  // The name snapshot follows the buyer's FitFlex name on the next paid order.
  await db('User').where({ id: buyer }).update({ displayName: 'Halima B. Juma' });
  await paidOrder(buyer, [{ productId: p.id, qty: 1 }]);
  assert.equal((await profile(as(v), row.id)).body.customer.name, 'Halima B. Juma');
  assert.equal(await db('VendorCustomer').where({ vendorId: v, buyerUserId: buyer }).count('* as n').first().then(r => Number(r.n)), 1);

  // GET /vendor/orders?customerId: only that customer's orders, paged shape.
  const filtered = await call(vendorOrders, as(v), { query: { customerId: row.id } });
  assert.equal(filtered.status, 200, JSON.stringify(filtered.body));
  assert.deepEqual([filtered.body.orders.length, filtered.body.counts.all, filtered.body.orders.every(o => o.buyer.customerId === row.id)], [2, 2, true]);
  const walkIn = await addCustomer(as(v), { name: 'Walk In' });
  assert.deepEqual((await call(vendorOrders, as(v), { query: { customerId: walkIn.id } })).body.orders, []);
});

test('backfill: one app customer per (vendor, buyer) with a paid order, id = the buyer ref, safe to run twice', async () => {
  const v = await vendor();
  const p = await product(v);
  const buyer = await user('member', { displayName: 'Backfill Buyer', phone: '+255788000111' });
  await paidOrder(buyer, [{ productId: p.id, qty: 1 }]);
  await db('VendorCustomer').where({ vendorId: v }).del(); // as before the migration
  const unpaid = await user('member', { displayName: 'Never Paid' });
  made.orders.push((await shopService.createOrder({ buyerId: unpaid, body: cart([{ productId: p.id, qty: 1 }]) })).order.id);
  const first = await migration.backfillMarketplaceCustomers(db);
  assert.ok(first.created >= 1);
  const rows = await db('VendorCustomer').where({ vendorId: v });
  assert.deepEqual(rows.map(r => [r.source, r.buyerUserId, r.name, r.phone, r.createdBy]), [['marketplace', buyer, 'Backfill Buyer', null, 'system:backfill']]);
  assert.equal(rows[0].id, (await db('VendorBuyerRef').where({ vendorId: v, buyerId: buyer }).first()).customerId);
  await migration.backfillMarketplaceCustomers(db);
  assert.deepEqual((await db('VendorCustomer').where({ vendorId: v })).map(r => [r.id, r.name]), rows.map(r => [r.id, r.name]), 'idempotent');
});

// ── tenancy ──────────────────────────────────────────────────────────────────

test('tenancy: another vendor cannot see, edit, pay, void, sell to or filter by my customer; the database refuses cross-vendor links', async () => {
  on();
  const a = await vendor();
  const b = await vendor();
  const pa = await product(a);
  const pb = await product(b);
  const c = await addCustomer(as(a), { name: 'Mine Only', phone: '0711222333' });
  const s = (await credit(as(a), c.id, 10_000, pa.id)).body.sale;
  const pm = (await pay(as(a), c.id, { amountTzs: 1_000 })).body.payment;
  for (const [route, opts] of [
    [vendorCustomerGet, { params: { id: c.id } }], [vendorCustomerUpdate, { params: { id: c.id }, body: { note: 'x' } }],
    [vendorCustomerSales, { params: { id: c.id } }], [vendorCustomerOrders, { params: { id: c.id } }], [vendorCustomerPayments, { params: { id: c.id } }],
    [vendorCustomerSale, { params: { id: c.id, saleId: s.id } }],
  ]) assert.deepEqual((await call(route, as(b), opts)).body, { error: 'customer_not_found' }, route.path);
  assert.equal((await pay(as(b), c.id, { amountTzs: 1_000 })).body.error, 'customer_not_found');
  assert.equal((await call(vendorCustomerPayment, as(b), { params: { id: c.id, paymentId: pm.id } })).body.error, 'payment_not_found');
  assert.equal((await call(vendorCustomerVoidPayment, as(b), { params: { id: c.id, paymentId: pm.id }, body: { reason: 'steal' } })).body.error, 'customer_not_found');
  assert.equal((await sell(as(b), saleBody([{ productId: pb.id, qty: 1 }], cash(45_000), { customerId: c.id }))).body.error, 'customer_not_found');
  assert.equal((await call(vendorOrders, as(b), { query: { customerId: c.id } })).body.error, 'customer_not_found');
  assert.deepEqual((await call(vendorListSales, as(b), { query: { customerId: c.id } })).body.sales, []);
  assert.equal((await call(vendorCustomersList, as(b), { query: { q: 'Mine' } })).body.customers.length, 0);
  assert.equal((await call(vendorReceivablesAging, as(b))).body.totals.owedTzs, 0);
  // Own customer, other's sale/payment ids: not found either.
  const cb = await addCustomer(as(b), { name: 'B customer' });
  assert.equal((await call(vendorCustomerSale, as(b), { params: { id: cb.id, saleId: s.id } })).body.error, 'sale_not_found');
  assert.equal((await call(vendorCustomerPayment, as(b), { params: { id: cb.id, paymentId: pm.id } })).body.error, 'payment_not_found');
  assert.equal((await call(vendorCustomerVoidPayment, as(b), { params: { id: cb.id, paymentId: pm.id }, body: { reason: 'steal' } })).body.error, 'payment_not_found');
  assert.equal((await pay(as(b), cb.id, { amountTzs: 1_000, allocations: [{ saleId: s.id, amountTzs: 1_000 }] })).body.error, 'overpayment');
  // The database: (customerId, vendorId) and (saleId, vendorId) must match.
  await assert.rejects(creditRow(b, c.id, { total: 1_000, dueDate: '2026-12-01' }), /vendorsale_customer_fk/);
  const bSale = await creditRow(b, cb.id, { total: 1_000, dueDate: '2026-12-01' });
  await assert.rejects(db('VendorPaymentAllocation').insert({ id: uid('pal'), vendorId: b, paymentId: pm.id, saleId: bSale, position: 9, amountTzs: 1 }), /vendorpaymentallocation_payment_fk/);
  await assert.rejects(db('VendorPaymentAllocation').insert({ id: uid('pal'), vendorId: a, paymentId: pm.id, saleId: bSale, position: 9, amountTzs: 1 }), /vendorpaymentallocation_sale_fk/);
  assert.equal((await assertSaleAddsUp(s.id)).balanceTzs, 9_000);
});

// ── settlement untouched ─────────────────────────────────────────────────────

test('pay-later sales and customer payments are not in VendorSettlement prepare, /vendor/payments or the statement CSV', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { name: 'Bottle', priceTzs: 50_000, stock: 20 });
  const buyer = await user('member', { displayName: 'Settle Buyer' });
  const order = await paidOrder(buyer, [{ productId: p.id, qty: 1 }]);
  for (const status of ['accepted', 'dispatched', 'delivered']) assert.equal((await shopService.updateOrderStatus({ orderId: order.id, status, actorId: v })).order.status, status);
  const paymentsBefore = await call(vendorPayments, as(v));
  const csvBefore = await shopService.vendorStatement(v);
  const clock = new Date(Date.now() + 7 * 86_400_000);
  const settlements = createVendorSettlementService({ users, payoutEligibility: createPayoutEligibility({ users, gyms, partnerGate, partnerSettlementAccounts, trainers }), now: () => clock });
  const statement = async () => {
    const s = await db('VendorSettlement').where({ vendorId: v }).whereNot('status', 'voided');
    const lines = await db('VendorSettlementLine').where({ vendorId: v, voided: false });
    return { statements: s.map(x => [x.orderCount, x.salesTzs, x.commissionTzs, x.finalNetTzs]), lines: lines.map(l => [l.orderId, l.salesTzs, l.commissionTzs, l.payoutTzs]) };
  };
  assert.equal((await settlements.prepare({ actorId: 'adm_s4' })).error, undefined);
  const before = await statement();
  assert.deepEqual(before.statements, [[1, 50_000, 5_000, 45_000]]);

  const requestsBefore = await db('PaymentRequest').count('* as n').first().then(r => Number(r.n));
  const appCustomer = (await db('VendorCustomer').where({ vendorId: v, buyerUserId: buyer }).first()).id;
  const walkIn = await addCustomer(as(v), { name: 'Walk In' });
  for (const id of [appCustomer, walkIn.id]) {
    const s = (await credit(as(v), id, 40_000, p.id, cash(10_000))).body.sale;
    assert.equal((await pay(as(v), id, { amountTzs: 15_000, method: 'mpesa', reference: 'SETTLE1' })).status, 201);
    assert.equal((await assertSaleAddsUp(s.id)).balanceTzs, 15_000);
  }
  const voidMe = (await pay(as(v), walkIn.id, { amountTzs: 1_000 })).body.payment;
  await call(vendorCustomerVoidPayment, as(v), { params: { id: walkIn.id, paymentId: voidMe.id }, body: { reason: 'test void' } });

  assert.equal((await settlements.prepare({ actorId: 'adm_s4' })).error, undefined);
  assert.deepEqual(await statement(), before, 'the statement, rebuilt, is exactly the app order');
  assert.deepEqual(await call(vendorPayments, as(v)), paymentsBefore, '/vendor/payments ignores pay-later sales and customer payments');
  assert.equal(await shopService.vendorStatement(v), csvBefore);
  assert.equal(await db('PaymentRequest').count('* as n').first().then(r => Number(r.n)), requestsBefore, 'no PaymentRequest for pay-later sales or customer payments');
  const columns = Object.keys(await db('VendorCustomerPayment').where({ vendorId: v }).first());
  assert.equal(columns.some(c => /commission|payout|settle/i.test(c)), false);
});

// ── overdue digest ───────────────────────────────────────────────────────────

test('overdue digest at 09:00 EAT: sales that became overdue today (due yesterday), to the vendor and active staff with `customers`, once per day; off with the flag; message in EN/SW', async () => {
  const v = await vendor();
  const keeper = await staff(v, ['customers']);
  const seller = await staff(v, ['sales']);
  const gone = await staff(v, ['customers'], { accountStatus: 'disabled' });
  const c = (await store.create({ vendorId: v, actorId: v, fields: { name: 'Late Payer' } })).customer;
  await creditRow(v, c.id, { total: 30_000, dueDate: '2026-10-19' }); // became overdue on the 20th
  await creditRow(v, c.id, { total: 20_000, dueDate: '2026-10-19', paid: 5_000 });
  await creditRow(v, c.id, { total: 7_000, dueDate: '2026-10-18' }); // overdue since yesterday: not new today
  await creditRow(v, c.id, { total: 9_000, dueDate: '2026-10-20' }); // due today: not overdue yet
  const sent = [];
  const svc = atClock('2026-10-20T06:00:00Z', { notifyPerson: async (userId, type, data) => { sent.push([userId, type, data]); } });
  const out = await svc.sendOverdueDigests();
  const mine = sent.filter(([userId]) => [v, keeper, seller, gone].includes(userId));
  assert.deepEqual(mine.map(([u]) => u).sort(), [v, keeper].sort(), 'vendor + active staff with customers only');
  assert.deepEqual(mine[0].slice(1), ['vendor_customers_overdue', { count: 2, totalTzs: 45_000, day: '2026-10-20' }]);
  assert.equal(out.day, '2026-10-20');
  const again = [];
  await atClock('2026-10-20T07:00:00Z', { notifyPerson: async (u) => { again.push(u); } }).sendOverdueDigests();
  assert.equal(again.filter(u => [v, keeper].includes(u)).length, 0, 'once per vendor per EAT day');
  assert.deepEqual(await atClock('2026-10-21T06:00:00Z', { customersOn: () => false, notifyPerson: async () => assert.fail('flag off') }).sendOverdueDigests(), { skipped: 'feature_disabled', vendors: 0, sent: 0 });
  // The job itself is dormant with the flag off.
  const before = await db('VendorOverdueDigest').count('* as n').first();
  await vendorCustomersOverdueDigest.onJob();
  assert.deepEqual(await db('VendorOverdueDigest').count('* as n').first(), before, 'flag off: nothing claimed');

  const texts = [];
  const notifier = createPartnerNotifier({ users, gyms, notify: async (userId, m) => { texts.push(m); }, preferences: { findByIdAsync: async id => (id === 'en_user' ? { locale: 'en' } : null) } });
  await notifier.vendorEvent('en_user', 'vendor_customers_overdue', { count: 2, totalTzs: 45_000 });
  await notifier.vendorEvent('sw_user', 'vendor_customers_overdue', { count: 1, totalTzs: 9_000 });
  assert.match(texts[0].title, /^2 pay-later sales are now overdue$/);
  assert.match(texts[0].body, /45,000 is past its due date/);
  assert.match(texts[1].title, /^Mauzo 1 ya mkopo yamechelewa$/, 'Swahili when no language is set');
  assert.match(texts[1].body, /9,000 imepita tarehe ya mwisho\. Ona wateja wanaodaiwa\.$/, 'customers who owe the vendor (Swahili audit #224; draft)');
  assert.doesNotMatch(texts[0].data.bodySw, /wanaokudai\b/, 'never "wanaokudai" (people the vendor owes)');
  assert.deepEqual([texts[0].data.open, texts[0].data.view, texts[0].type], ['customers', 'owed', 'vendor_customers_overdue']);
});
