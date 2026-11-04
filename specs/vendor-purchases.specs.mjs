// Vendor business tools · S9 — suppliers, receiving stock (GRN) and payables with instalments (design spec
// docs/design/vendor-purchases-s9.md §12). Against the CI database: gating and the new `purchases` permission,
// the backfill, suppliers, receive (stock, ledger once, cost price O-9/P-6), payments covering instalments oldest
// due first, plan changes, voids (all or nothing, cost put back only where untouched), concurrency, gap-free GRN
// numbers, payables aging at the EAT boundary, reports, and settlement left untouched. FitFlex moves no money.
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
import { createPartnerNotifier } from '../src/services/partner-notifier.mjs';
import { createPgVendorPurchaseStore } from '../src/infra/vendor-purchase-store-pg.mjs';
import { createVendorPurchaseService } from '../src/services/vendor-purchase-service.mjs';
import { vendorToolsOptionsRoute, vendorCreateProduct, vendorUpdateProduct, vendorStockAdjustment, vendorMyProducts, vendorStockMovements, vendorPayments, vendorMeRoute as vendorMe } from '../functions/shop.mjs';
import { vendorRecordSale, vendorGetSale, resetVendorSalesLimits } from '../functions/vendor-sales.mjs';
import { vendorReportPaymentMethods, vendorReportStockValue, vendorReportProfit, resetVendorReportCache, resetVendorReportLimits } from '../functions/vendor-reports.mjs';
import {
  vendorListSuppliers, vendorCreateSupplier, vendorGetSupplier, vendorUpdateSupplier, vendorReceiveStock, vendorListPurchases, vendorPurchaseLastCosts,
  vendorGetPurchase, vendorVoidPurchase, vendorRecordPurchasePayment, vendorVoidPurchasePayment, vendorChangePurchasePlan, vendorPayablesAging,
  resetVendorPurchaseLimits, VENDOR_PURCHASES_LIMITS,
} from '../functions/vendor-purchases.mjs';
import {
  grnNumber, parseReceive, planPurchaseMoney, coverInstalments, coveredBy, planChange, supplierPhone, parseSupplier, purchaseFingerprint,
} from '../src/shared/vendor-purchase.mjs';
import { eatToday, addDays } from '../src/shared/vendor-customer.mjs';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';

const migration = createRequire(import.meta.url)('../db/migrations/20270202090500-vendor-purchases.cjs');

await ensureInit();

// Fail closed: these specs write; they must never run against anything but an isolated CI database.
{
  const dbName = (await db.raw('SELECT current_database() AS d')).rows[0].d;
  assert.equal(process.env.FITFLEX_USE_CI_DB, '1', 'specs run only with FITFLEX_USE_CI_DB=1');
  assert.match(dbName, /ci|test/i, `refusing to run against database ${dbName}`);
}

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [], orders: [], persons: [] };
const FLAGS = ['VENDOR_TOOLS', 'VENDOR_STOCK_LEDGER', 'VENDOR_PURCHASES', 'VENDOR_WALKIN_SALES', 'VENDOR_REPORTS', 'VENDOR_PORTAL'];
const on = (list = FLAGS) => { for (const f of list) process.env[f] = '1'; };
afterEach(() => {
  for (const f of FLAGS) delete process.env[f];
  resetVendorPurchaseLimits(); resetVendorSalesLimits(); resetVendorReportCache(); resetVendorReportLimits();
});

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    type() { return this; },
    send(b) { this.body = b; return this; },
    end(b) { this.body = b; return this; },
  };
}
async function call(route, claims, { params = {}, query = {}, body = {} } = {}) {
  const all = claims ? { authorization: `Bearer ${sign(claims)}` } : {};
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
  await db('User').insert({ id, userType, displayName: `S9 ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
async function vendor(extra = {}) {
  const id = await user('vendor', { createdAt: new Date('2026-01-01T00:00:00Z'), displayName: 'Asha Owner', vendorProfile: JSON.stringify({ businessName: 'Supply Shop', status: 'published' }), ...extra });
  const caseId = uid('kyc');
  await db('PartnerKycCase').insert({ id: caseId, partnerType: 'vendor', userId: id, status: 'approved', tier: 3, updatedAt: new Date() });
  await db('PartnerSettlementAccount').insert({
    id: uid('psa'), caseId, method: 'bank', provider: 'CRDB', accountName: 'Supply Shop', accountNumber: '0150001234',
    status: 'verified', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z'), cooldownUntil: new Date('2026-09-03T00:00:00Z'), updatedAt: new Date(),
  });
  return id;
}
const as = id => ({ sub: id, userType: 'vendor' });
const staffOf = (id, vendorId) => ({ sub: id, userType: 'vendor_staff', vendorId });
const staff = (vendorId, permissions, extra = {}) => user('vendor_staff', { vendorId, vendorPermissions: permissions, accountStatus: 'active', vendorRole: 'inventory_manager', displayName: 'Juma Storekeeper', ...extra });

async function product(vendorId, body = {}) {
  const full = Object.fromEntries(Object.entries({ name: 'Whey 1kg', category: 'supplements_nutrition', priceTzs: 45_000, stock: 3, ...body }).filter(([, x]) => x !== undefined));
  const out = await call(vendorCreateProduct, as(vendorId), { body: full });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  made.products.push(out.body.id);
  await shopService.adminUpdateProductListing({ productId: out.body.id, body: { approvalStatus: 'approved' }, actorId: 'adm_s9' });
  return out.body;
}
async function supplier(claims, body = {}) {
  const out = await call(vendorCreateSupplier, claims, { body: { name: `Juma Supplies ${randomUUID().slice(0, 4)}`, phone: '0712 345 678', ...body } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.supplier;
}
const receiveBody = (lines, extra = {}) => ({ clientRef: randomUUID(), lines, ...extra });
const receive = (claims, b) => call(vendorReceiveStock, claims, { body: b });
async function receiveOk(claims, b) {
  const out = await receive(claims, b);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body;
}
const pay = (claims, purchaseId, b) => call(vendorRecordPurchasePayment, claims, { params: { id: purchaseId }, body: { clientRef: randomUUID(), method: 'cash', ...b } });
const voidP = (claims, purchaseId, reason = 'Wrong delivery') => call(vendorVoidPurchase, claims, { params: { id: purchaseId }, body: { reason } });
const voidPay = (claims, purchaseId, paymentId, reason = 'Recorded twice') => call(vendorVoidPurchasePayment, claims, { params: { id: purchaseId, paymentId }, body: { reason } });
const getP = async (claims, id) => (await call(vendorGetPurchase, claims, { params: { id } })).body.purchase;
const row = id => db('Product').where({ id }).first();
const cost = async (productId, variant = '') => (await db('ProductPrivate').where({ productId, variant }).first()) || null;
const ledger = (productId, reasons) => db('ShopStockMovement').where({ productId }).whereIn('reason', reasons).orderBy([{ column: 'createdAt' }, { column: 'id' }]);
const cash = amountTzs => [{ method: 'cash', amountTzs }];
const today = () => eatToday(new Date());
/** Route-level specs compare EAT "today" with the server's: never start one in the last 15 s before 00:00 EAT. */
async function awayFromEatMidnight() {
  const msToMidnight = (21 * 3_600_000 - (Date.now() % 86_400_000) + 86_400_000) % 86_400_000;
  if (msToMidnight < 15_000) await new Promise(resolve => setTimeout(resolve, msToMidnight + 250));
}
/** Every money CHECK of a purchase, read back from the database. */
async function assertAddsUp(purchaseId) {
  const p = await db('VendorPurchase').where({ id: purchaseId }).first();
  assert.equal(p.paidTzs + p.balanceTzs, p.totalTzs, `${p.number} paid + balance = total`);
  const pays = await db('VendorPurchasePayment').where({ purchaseId, status: 'recorded' });
  if (p.status === 'received') assert.equal(p.paidTzs, pays.reduce((s, x) => s + x.amountTzs, 0), 'paidTzs = Σ recorded payments');
  const inst = await db('VendorPurchaseInstalment').where({ purchaseId, status: 'active' });
  assert.equal(inst.reduce((s, x) => s + x.amountTzs, 0), p.totalTzs, 'active instalments = total');
  const lines = await db('VendorPurchaseLine').where({ purchaseId });
  assert.equal(lines.reduce((s, l) => s + l.lineTotalTzs, 0), p.totalTzs, 'Σ lines = total');
  return p;
}

after(async () => {
  for (const s of servers) s.close();
  const vendors = made.users;
  const purchaseIds = (await db('VendorPurchase').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  const paymentIds = (await db('VendorPurchasePayment').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  const supplierIds = (await db('VendorSupplier').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  const saleIds = (await db('VendorSale').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  await db('AuditLog').whereIn('target', [...purchaseIds, ...paymentIds, ...supplierIds, ...saleIds, ...made.orders, ...made.products, ...vendors]).del();
  await db('VendorPurchase').whereIn('vendorId', vendors).del(); // lines, instalments, payments go with it
  await db('VendorSupplier').whereIn('vendorId', vendors).del();
  await db('VendorSale').whereIn('vendorId', vendors).del();
  await db('VendorDocumentSequence').whereIn('vendorId', vendors).del();
  await db('VendorSettlementLine').whereIn('vendorId', vendors).del();
  await db('VendorSettlement').whereIn('vendorId', vendors).del();
  await db('VendorBuyerRef').whereIn('vendorId', vendors).del().catch(() => {});
  await db('VendorOrderInvoice').whereIn('vendorId', vendors).del().catch(() => {});
  await db('ShopOrderLineCost').whereIn('orderId', made.orders).del();
  await db('ShopStockMovement').whereIn('productId', made.products).del();
  await db('MarketplaceNotification').whereIn('userId', vendors).del();
  await db('Notification').whereIn('userId', vendors).del();
  await db('PaymentRequest').whereIn('orderId', made.orders).del();
  await db('ShopOrder').whereIn('id', made.orders).del();
  await db('ProductPrivate').whereIn('productId', made.products).del();
  await db('Product').whereIn('id', made.products).del();
  await db('OrgMembership').whereIn('personaId', vendors).del().catch(() => {});
  await db('Invitation').whereIn('vendorId', vendors).del().catch(() => {});
  await db('Person').whereIn('id', made.persons).del().catch(() => {});
  await db('Vendor').whereIn('id', vendors).del().catch(() => {});
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
async function hit(method, url, claims, payload) {
  const r = await fetch(`${base}${url}`, {
    method, headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.0.${Math.floor(Math.random() * 200) + 1}`, ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await r.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: parsed, text };
}

// ── pure rules ───────────────────────────────────────────────────────────────

test('rules: GRN numbers, parse codes, P-3/P-4/P-5 money plan, coverage oldest due first (partial instalment), plan change split, supplier phone', () => {
  assert.equal(grnNumber(1), 'GRN-000001');
  assert.equal(grnNumber(1234567), 'GRN-1234567');
  const day = '2026-11-04';
  const ok = parseReceive({ clientRef: 'abcdefgh-1', lines: [{ productId: 'p1', qty: 10, unitCostTzs: 9_500 }, { productId: 'p1', variant: 'M', qty: 3, unitCostTzs: 0 }] }, { today: day });
  assert.deepEqual([ok.totalTzs, ok.receivedOn, ok.lines[0].lineTotalTzs, ok.lines[1].variant], [95_000, day, 95_000, 'M']);
  const bad = b => parseReceive({ clientRef: 'abcdefgh-1', lines: [{ productId: 'p1', qty: 1, unitCostTzs: 1 }], ...b }, { today: day });
  assert.equal(bad({ clientRef: 'x' }).error, 'invalid_client_ref');
  assert.equal(bad({ lines: [] }).error, 'lines_required');
  assert.deepEqual(bad({ lines: Array.from({ length: 201 }, (_, i) => ({ productId: `p${i}`, qty: 1, unitCostTzs: 1 })) }), { error: 'too_many_lines', status: 400, max: 200 });
  assert.deepEqual(bad({ lines: [{ productId: 'p1', qty: 0, unitCostTzs: 1 }] }), { error: 'invalid_quantity', status: 400, index: 0, max: 100_000 });
  assert.deepEqual(bad({ lines: [{ productId: 'p1', qty: 1, unitCostTzs: -1 }] }), { error: 'invalid_cost', status: 400, index: 0, max: 100_000_000 });
  assert.deepEqual(bad({ lines: [{ productId: 'p1', qty: 1, unitCostTzs: 1 }, { productId: 'p1', qty: 2, unitCostTzs: 1 }] }), { error: 'duplicate_line', status: 400, productId: 'p1', variant: null });
  assert.deepEqual(bad({ lines: [{ qty: 1, unitCostTzs: 1 }] }), { error: 'invalid_line', status: 400, index: 0, field: 'productId' });
  assert.deepEqual(bad({ lines: [{ productId: 'a', qty: 100_000, unitCostTzs: 100_000_000 }] }), { error: 'total_too_large', status: 400, max: 1_000_000_000 });
  assert.deepEqual(bad({ receivedOn: '2026-11-05' }), { error: 'received_on_out_of_range', status: 400, earliest: '2026-10-05', latest: day });
  assert.deepEqual(bad({ receivedOn: '2026-10-04' }).error, 'received_on_out_of_range');
  assert.equal(bad({ receivedOn: '2026-10-05' }).receivedOn, '2026-10-05');
  assert.deepEqual(bad({ supplierInvoiceRef: 'x'.repeat(61) }), { error: 'supplier_invoice_ref_too_long', status: 400, max: 60 });
  assert.deepEqual(bad({ note: 'x'.repeat(201) }), { error: 'note_too_long', status: 400, max: 200 });
  assert.deepEqual(bad({ paidNow: { amountTzs: 1, method: 'mpesa' } }), { error: 'reference_required', status: 400, method: 'mpesa' });
  assert.equal(bad({ paidNow: { amountTzs: 1, method: 'barter' } }).error, 'invalid_method');
  assert.deepEqual(bad({ paidNow: { amountTzs: 1.5, method: 'cash' } }), { error: 'invalid_payment', status: 400, field: 'amountTzs' });
  assert.deepEqual(bad({ paidNow: { amountTzs: 1, method: 'bank', reference: 'x'.repeat(101) } }), { error: 'reference_too_long', status: 400, max: 100 });
  assert.deepEqual(bad({ dueDate: '2026-12-01', schedule: [] }), { error: 'invalid_field', status: 400, field: 'schedule' });
  assert.deepEqual(bad({ schedule: [] }), { error: 'invalid_schedule', status: 400, reason: 'count', max: 12 });
  assert.equal(bad({ schedule: [{ dueDate: '2026-02-30', amountTzs: 1 }] }).reason, 'date');
  assert.equal(bad({ schedule: [{ dueDate: day, amountTzs: 0 }] }).reason, 'amount');
  assert.deepEqual(bad({ schedule: [{ dueDate: '2027-11-05', amountTzs: 1 }] }), { error: 'due_date_out_of_range', status: 400, earliest: day, latest: '2027-11-04' });
  assert.equal(bad({ paidNow: { amountTzs: 0, method: 'nonsense' } }).paidNow, null, 'nothing paid: method ignored');

  // P-3 / P-4 / P-5.
  const parsed = { totalTzs: 200_000, receivedOn: day, paidNow: { amountTzs: 50_000 }, schedule: [{ dueDate: '2026-12-04', amountTzs: 50_000 }, { dueDate: '2027-01-04', amountTzs: 100_000 }] };
  assert.deepEqual(planPurchaseMoney(parsed, { hasSupplier: true }).instalments, [
    { dueDate: day, amountTzs: 50_000 }, { dueDate: '2026-12-04', amountTzs: 50_000 }, { dueDate: '2027-01-04', amountTzs: 100_000 },
  ]);
  assert.deepEqual(planPurchaseMoney({ ...parsed, schedule: [{ dueDate: day, amountTzs: 1 }] }, { hasSupplier: true }), { error: 'schedule_mismatch', status: 400, expectedTzs: 150_000, scheduledTzs: 1 });
  assert.deepEqual(planPurchaseMoney(parsed, { hasSupplier: false }), { error: 'supplier_required', status: 400 });
  assert.deepEqual(planPurchaseMoney({ ...parsed, paidNow: { amountTzs: 200_001 } }, { hasSupplier: true }), { error: 'overpayment', status: 400, totalTzs: 200_000 });
  assert.deepEqual(planPurchaseMoney({ totalTzs: 10, receivedOn: day, paidNow: { amountTzs: 10 }, dueDate: 'ignored' }, { hasSupplier: false }), { paidNowTzs: 10, balanceTzs: 0, instalments: [{ dueDate: day, amountTzs: 10 }] });
  assert.deepEqual(planPurchaseMoney({ totalTzs: 0, receivedOn: day, paidNow: null }, { hasSupplier: false }), { paidNowTzs: 0, balanceTzs: 0, instalments: [] });
  assert.deepEqual(planPurchaseMoney({ totalTzs: 7, receivedOn: day, paidNow: null }, { hasSupplier: true }).instalments, [{ dueDate: addDays(day, 30), amountTzs: 7 }], 'default due date receivedOn + 30');

  // Coverage: 50 + 50 + 50 with 120 paid → paid, paid, part paid 20.
  const plan = [{ dueDate: '2026-11-01', amountTzs: 50 }, { dueDate: '2026-11-02', amountTzs: 50 }, { dueDate: '2026-11-10', amountTzs: 50 }];
  const c = coverInstalments(plan, 120, day);
  assert.deepEqual(c.map(x => [x.coveredTzs, x.openTzs, x.state, x.daysOverdue]), [[50, 0, 'paid', 0], [50, 0, 'paid', 0], [20, 30, 'part_paid', 0]]);
  assert.deepEqual(coverInstalments(plan, 30, day).map(x => [x.state, x.daysOverdue]), [['part_paid', 3], ['overdue', 2], ['due', 0]]);
  assert.deepEqual(coverInstalments([{ dueDate: day, amountTzs: 5 }], 0, day)[0].state, 'due', 'due today is not overdue');
  assert.deepEqual(coveredBy(plan, 50, 70), [{ index: 1, amountTzs: 50 }, { index: 2, amountTzs: 20 }]);
  const change = planChange(c);
  assert.deepEqual([change.keep.length, change.replace.length, change.splitCoveredTzs, change.splitFrom.dueDate], [2, 1, 20, '2026-11-10']);

  // Supplier phone and fields.
  assert.equal(supplierPhone('0712 345 678'), '+255712345678');
  assert.equal(supplierPhone('+254 712 345678'), '+254712345678', 'a supplier abroad keeps their own number');
  assert.equal(supplierPhone('12'), null);
  assert.deepEqual(parseSupplier({ name: 'J' }), { error: 'name_required', status: 400, min: 2 });
  assert.deepEqual(parseSupplier({ name: 'x'.repeat(121) }), { error: 'name_too_long', status: 400, max: 120 });
  assert.deepEqual(parseSupplier({ name: 'Juma', tin: 'x'.repeat(21) }), { error: 'field_too_long', status: 400, field: 'tin', max: 20 });
  assert.deepEqual(parseSupplier({ name: 'Juma', email: 'nope' }), { error: 'invalid_email', status: 400 });
  assert.deepEqual(parseSupplier({ name: 'Juma', phone: 'abc' }), { error: 'invalid_phone', status: 400 });
  assert.deepEqual(parseSupplier({ name: 5 }), { error: 'invalid_field', status: 400, field: 'name' });
  assert.deepEqual(parseSupplier({ phone: null, archived: true }, { partial: true }), { fields: { phone: null }, archived: true });
  assert.deepEqual(parseSupplier({ name: null }, { partial: true }), { error: 'name_required', status: 400, min: 2 });
  // The fingerprint ignores line order.
  assert.equal(purchaseFingerprint({ lines: [{ productId: 'a', qty: 1, unitCostTzs: 1 }, { productId: 'b', qty: 2, unitCostTzs: 2 }] }),
    purchaseFingerprint({ lines: [{ productId: 'b', qty: 2, unitCostTzs: 2 }, { productId: 'a', qty: 1, unitCostTzs: 1 }] }));
});

// ── gating and access ────────────────────────────────────────────────────────

test('flags: every S9 route answers 404 feature_disabled (before sign-in) with any of VENDOR_TOOLS / VENDOR_STOCK_LEDGER / VENDOR_PURCHASES off; tools.purchases needs the ledger flag; data comes back when on', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { stock: 2 });
  const s = await supplier(as(v));
  const { purchase } = await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 4, unitCostTzs: 1_000 }], { supplierId: s.id }));
  const routes = [
    ['GET', '/vendor/suppliers'], ['POST', '/vendor/suppliers', { name: 'Nope' }], ['GET', `/vendor/suppliers/${s.id}`], ['PUT', `/vendor/suppliers/${s.id}`, { note: 'x' }],
    ['POST', '/vendor/purchases', receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 1 }])], ['GET', '/vendor/purchases'], ['GET', `/vendor/purchases/last-costs?productIds=${p.id}`],
    ['GET', `/vendor/purchases/${purchase.id}`], ['POST', `/vendor/purchases/${purchase.id}/void`, { reason: 'nope nope' }],
    ['POST', `/vendor/purchases/${purchase.id}/payments`, { clientRef: randomUUID(), amountTzs: 1, method: 'cash' }],
    ['POST', `/vendor/purchases/${purchase.id}/payments/vpp_x/void`, { reason: 'nope nope' }],
    ['PUT', `/vendor/purchases/${purchase.id}/instalments`, { schedule: [{ dueDate: today(), amountTzs: 4_000 }] }], ['GET', '/vendor/payables/aging'],
  ];
  for (const off of ['VENDOR_TOOLS', 'VENDOR_STOCK_LEDGER', 'VENDOR_PURCHASES']) {
    on();
    delete process.env[off];
    for (const [method, url, payload] of routes) {
      assert.deepEqual(await hit(method, url, as(v), payload).then(r => [r.status, r.body]), [404, { error: 'feature_disabled' }], `${off} off: ${method} ${url}`);
      assert.deepEqual((await hit(method, url, null, payload)).status, 404, `${off} off, no token: ${method} ${url}`);
    }
    assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.purchases, false, `${off} off → tools.purchases false`);
  }
  // Nothing moved while off; everything is back, unchanged, when on.
  on();
  assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.purchases, true);
  assert.equal((await call(vendorMe, as(v))).body.tools.purchases, true);
  assert.equal((await row(p.id)).stock, 6);
  assert.deepEqual((await getP(as(v), purchase.id)).number, purchase.number);
  // The stock history keeps the purchase link whatever the flag (the apps show plain text when off).
  delete process.env.VENDOR_PURCHASES;
  const history = await call(vendorStockMovements, as(v), { params: { id: p.id } });
  assert.deepEqual(history.body.rows.find(r => r.reason === 'stock_in').document, { type: 'purchase', id: purchase.id, number: purchase.number });
});

test('access: staff without `purchases` 403; suspended vendor 403 vendor_suspended; disabled staff 403; tenancy (vendor B gets 404 on supplier, purchase, payment, aging rows); GET /vendor/products with `purchases` only (no cost fields); admin staff and owner have `purchases`', async () => {
  on();
  const v = await vendor();
  const other = await vendor();
  const p = await product(v, { stock: 5, costTzs: 9_000 });
  const s = await supplier(as(v));
  const { purchase } = await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 9_500 }], { supplierId: s.id, paidNow: { amountTzs: 500, method: 'cash' } }));
  const payment = purchase.payments[0];

  const productsOnly = await staff(v, ['products']);
  for (const [route, opts] of [[vendorListSuppliers, {}], [vendorReceiveStock, { body: receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 1 }]) }], [vendorPayablesAging, {}], [vendorGetPurchase, { params: { id: purchase.id } }]]) {
    assert.deepEqual(await call(route, staffOf(productsOnly, v), opts), { status: 403, body: { error: 'vendor_permission_forbidden', requiredPermission: 'purchases' } });
  }
  const suspendedVendor = await vendor({ accountStatus: 'suspended' });
  const paused = await staff(suspendedVendor, ['purchases']);
  assert.deepEqual(await call(vendorListSuppliers, staffOf(paused, suspendedVendor)), { status: 403, body: { error: 'vendor_suspended' } });
  const disabled = await staff(v, ['purchases'], { accountStatus: 'disabled' });
  assert.equal((await call(vendorListSuppliers, staffOf(disabled, v))).status, 403);

  // Another vendor: 404 everywhere, and nothing of mine in their aging.
  assert.deepEqual(await call(vendorGetSupplier, as(other), { params: { id: s.id } }), { status: 404, body: { error: 'supplier_not_found' } });
  assert.deepEqual(await call(vendorUpdateSupplier, as(other), { params: { id: s.id }, body: { note: 'mine' } }), { status: 404, body: { error: 'supplier_not_found' } });
  assert.deepEqual(await call(vendorGetPurchase, as(other), { params: { id: purchase.id } }), { status: 404, body: { error: 'purchase_not_found' } });
  assert.equal((await voidP(as(other), purchase.id)).body.error, 'purchase_not_found');
  assert.equal((await pay(as(other), purchase.id, { amountTzs: 1 })).body.error, 'purchase_not_found');
  assert.equal((await voidPay(as(other), purchase.id, payment.id)).body.error, 'payment_not_found');
  assert.equal((await call(vendorChangePurchasePlan, as(other), { params: { id: purchase.id }, body: { schedule: [{ dueDate: today(), amountTzs: 9_000 }] } })).body.error, 'purchase_not_found');
  assert.deepEqual((await call(vendorPayablesAging, as(other))).body.rows, []);
  assert.deepEqual((await call(vendorListPurchases, as(other))).body.purchases, []);
  assert.deepEqual((await call(vendorPurchaseLastCosts, as(other), { query: { productIds: p.id } })).body.rows, []);
  // A purchase line naming another vendor's product → product_not_found (never locked or moved).
  const theirs = await product(other, { stock: 1 });
  assert.deepEqual((await receive(as(v), receiveBody([{ productId: theirs.id, qty: 1, unitCostTzs: 0 }]))).body, { error: 'product_not_found', productId: theirs.id });
  assert.equal((await row(theirs.id)).stock, 1);
  // Supplier of another vendor → supplier_not_found.
  const theirSupplier = await supplier(as(other));
  assert.equal((await receive(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 0 }], { supplierId: theirSupplier.id }))).body.error, 'supplier_not_found');

  // `purchases` only: the product list is readable, without cost fields; purchase lines carry unit costs but no previous cost.
  const buyerStaff = await staff(v, ['purchases']);
  const list = await call(vendorMyProducts, staffOf(buyerStaff, v));
  assert.equal(list.status, 200);
  const mine = list.body.find(x => x.id === p.id);
  assert.equal('costTzs' in mine, false, 'no cost price for `purchases` only (Q-1: canSeeCost unchanged)');
  const seen = await getP(staffOf(buyerStaff, v), purchase.id);
  assert.equal(seen.lines[0].unitCostTzs, 9_500);
  assert.equal('previousCostTzs' in seen.lines[0], false);
  assert.equal((await getP(as(v), purchase.id)).lines[0].previousCostTzs, 9_000);
  const r2 = await receiveOk(staffOf(buyerStaff, v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 9_800 }], { paidNow: { amountTzs: 9_800, method: 'cash' } }));
  assert.deepEqual(r2.costChanges, [{ productId: p.id, variant: null, name: p.name, toTzs: 9_800 }], 'no fromTzs without canSeeCost');

  // vendorMe lists the permission for the owner and for admin staff created now.
  assert.ok((await call(vendorMe, as(v))).body.permissions.includes('purchases'));
  const admin = await shopService.createVendorStaff({ vendorId: v, body: { name: 'Admin', email: `${uid('a')}@example.com`, phone: '0712000555', password: 'Secret123!', role: 'admin' } });
  const adminId = admin.staff?.id || admin.id || admin.body?.id;
  if (adminId) made.users.push(adminId);
  const adminRow = await db('User').where({ id: adminId }).first();
  assert.ok(adminRow.vendorPermissions.includes('purchases'), 'a new admin staff member gets `purchases`');
});

test('migration: backfill adds `purchases` to admin staff, their vendor memberships and pending admin invitations only; safe to repeat; down refuses while purchases exist (rolled back)', async () => {
  on();
  const v = await vendor();
  const admin = await staff(v, ['products', 'orders'], { vendorRole: 'admin' });
  const inv = await staff(v, ['products'], { vendorRole: 'inventory_manager' });
  await db('Vendor').insert({ id: v, name: 'Supply Shop', status: 'active' }).onConflict('id').ignore();
  const personId = uid('per');
  made.persons.push(personId);
  await db('Person').insert({ id: personId });
  await db('OrgMembership').insert({ id: uid('om'), personId, personaId: admin, orgType: 'vendor', vendorId: v, role: 'staff', status: 'active', aclPermissions: ['products'] });
  const inviteFor = role => ({
    id: uid('inv'), orgType: 'vendor', vendorId: v, role: 'staff', identifierType: 'email', identifierValue: `${uid('i')}@example.com`,
    tokenHash: randomUUID(), status: 'pending', aclPermissions: ['orders'], payload: JSON.stringify({ vendorRole: role }), invitedBy: v,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const adminInvite = inviteFor('admin');
  const invInvite = inviteFor('inventory_manager');
  await db('Invitation').insert([adminInvite, invInvite]);

  const first = await migration.addPurchasesPermission(db);
  assert.ok(first.users >= 1 && first.memberships >= 1 && first.invitations >= 1, JSON.stringify(first));
  const again = await migration.addPurchasesPermission(db);
  assert.deepEqual(again, { users: 0, memberships: 0, invitations: 0 }, 'safe to repeat');
  const perms = async id => (await db('User').where({ id }).first()).vendorPermissions;
  assert.deepEqual(await perms(admin), ['products', 'orders', 'purchases']);
  assert.deepEqual(await perms(inv), ['products'], 'inventory_manager only when ticked (Q-2)');
  assert.deepEqual((await db('OrgMembership').where({ personaId: admin }).first()).aclPermissions, ['products', 'purchases']);
  assert.deepEqual((await db('Invitation').where({ id: adminInvite.id }).first()).aclPermissions, ['orders', 'purchases']);
  assert.deepEqual((await db('Invitation').where({ id: invInvite.id }).first()).aclPermissions, ['orders']);
  assert.equal((await call(vendorListSuppliers, staffOf(admin, v))).status, 200, 'backfilled admin may open purchases');

  const p = await product(v, { stock: 1 });
  await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 0 }]));
  await assert.rejects(migration.down(db), /purchase\(s\) exist/);
  assert.ok((await db.raw(`SELECT to_regclass('"VendorPurchase"') AS t`)).rows[0].t, 'nothing dropped');
  const ROLLBACK = new Error('rollback');
  await assert.rejects(db.transaction(async (trx) => {
    await trx.raw('DELETE FROM "VendorPurchase"');
    await migration.down(trx);
    assert.equal((await trx.raw(`SELECT to_regclass('"VendorPurchase"') AS t`)).rows[0].t, null);
    const cols = (await trx.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ProductPrivate' AND column_name IN ('costSourceId', 'costUpdatedAt')`)).rows;
    assert.deepEqual(cols, []);
    assert.equal((await trx('User').where({ id: admin }).first()).vendorPermissions.includes('purchases'), false);
    await migration.up(trx);
    throw ROLLBACK;
  }), err => err === ROLLBACK);
  assert.equal(await db('VendorPurchase').where({ vendorId: v }).count('* as n').first().then(r => Number(r.n)), 1, 'rolled back');
});

// ── suppliers ────────────────────────────────────────────────────────────────

test('suppliers: validation codes, duplicate name among active suppliers (case-insensitive, also on restore), search by name / phone / contact person, filters and sorts, archive refused while owed, restore, audit', async () => {
  on();
  const v = await vendor();
  const mk = body => call(vendorCreateSupplier, as(v), { body });
  assert.deepEqual((await mk({ name: 'J' })).body, { error: 'name_required', min: 2 });
  assert.deepEqual((await mk({ name: 'Juma', phone: 'call me' })).body, { error: 'invalid_phone' });
  assert.deepEqual((await mk({ name: 'Juma', address: 'x'.repeat(301) })).body, { error: 'field_too_long', field: 'address', max: 300 });
  const juma = (await mk({ name: 'Juma Supplies', phone: '0712 345 678', contactPerson: 'Mzee Juma', email: 'Juma@Example.com', tin: '123-456-789' })).body.supplier;
  assert.deepEqual([juma.phone, juma.email, juma.archived], ['+255712345678', 'juma@example.com', false]);
  assert.deepEqual(await mk({ name: '  juma supplies ' }), { status: 409, body: { error: 'duplicate_supplier', supplierId: juma.id } });
  const kariakoo = (await mk({ name: 'Kariakoo Traders', contactPerson: 'Neema' })).body.supplier;

  const search = async q => (await call(vendorListSuppliers, as(v), { query: { q } })).body.suppliers.map(x => x.name);
  assert.deepEqual(await search('juma'), ['Juma Supplies']);
  assert.deepEqual(await search('0712345'), ['Juma Supplies'], 'phone digits, national 0 dropped');
  assert.deepEqual(await search('neem'), ['Kariakoo Traders'], 'contact person');
  assert.deepEqual(await search('%'), ['Juma Supplies', 'Kariakoo Traders'], 'a 1-character query is ignored');
  assert.deepEqual(await search('%_'), [], 'LIKE wildcards are matched literally');

  // Owed → archive refused; paid up → archive works; hidden from the active list; restore; duplicate on restore.
  const p = await product(v, { stock: 0 });
  const { purchase } = await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 2, unitCostTzs: 5_000 }], { supplierId: juma.id }));
  assert.deepEqual(await call(vendorUpdateSupplier, as(v), { params: { id: juma.id }, body: { archived: true } }), { status: 409, body: { error: 'supplier_has_balance', owedTzs: 10_000 } });
  const owing = (await call(vendorListSuppliers, as(v), { query: { filter: 'owing', sort: 'owed' } })).body.suppliers;
  assert.deepEqual(owing.map(x => [x.name, x.owedTzs, x.overdueTzs, x.nextDueDate, x.lastReceivedOn]), [['Juma Supplies', 10_000, 0, addDays(today(), 30), today()]]);
  assert.equal((await pay(as(v), purchase.id, { amountTzs: 10_000 })).status, 201);
  assert.equal((await call(vendorUpdateSupplier, as(v), { params: { id: juma.id }, body: { archived: true } })).body.supplier.archived, true);
  assert.deepEqual((await call(vendorListSuppliers, as(v))).body.suppliers.map(x => x.name), ['Kariakoo Traders']);
  assert.deepEqual((await call(vendorListSuppliers, as(v), { query: { filter: 'archived' } })).body.suppliers.map(x => x.name), ['Juma Supplies']);
  assert.deepEqual((await receive(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 0 }], { supplierId: juma.id }))).body, { error: 'supplier_archived', supplierId: juma.id });
  // Its purchases stay readable.
  assert.equal((await getP(as(v), purchase.id)).supplier.archived, true);
  const newJuma = (await mk({ name: 'JUMA SUPPLIES' })).body.supplier;
  assert.deepEqual(await call(vendorUpdateSupplier, as(v), { params: { id: juma.id }, body: { archived: false } }), { status: 409, body: { error: 'duplicate_supplier', supplierId: newJuma.id } });
  assert.equal((await call(vendorUpdateSupplier, as(v), { params: { id: newJuma.id }, body: { name: 'Juma Supplies 2' } })).status, 200);
  assert.equal((await call(vendorUpdateSupplier, as(v), { params: { id: juma.id }, body: { archived: false } })).body.supplier.archived, false);
  assert.deepEqual(await call(vendorUpdateSupplier, as(v), { params: { id: kariakoo.id }, body: { name: 'juma supplies' } }), { status: 409, body: { error: 'duplicate_supplier', supplierId: juma.id } });
  // Partial edit: null clears; name cannot be null.
  const edited = await call(vendorUpdateSupplier, as(v), { params: { id: juma.id }, body: { tin: null, note: 'Delivers Tuesdays' } });
  assert.deepEqual([edited.body.supplier.tin, edited.body.supplier.note, edited.body.supplier.phone], [null, 'Delivers Tuesdays', '+255712345678']);
  assert.equal((await call(vendorUpdateSupplier, as(v), { params: { id: juma.id }, body: { name: null } })).body.error, 'name_required');

  // Profile: totals exclude voided purchases.
  const prof = (await call(vendorGetSupplier, as(v), { params: { id: juma.id } })).body;
  assert.deepEqual([prof.totals.purchasedTzs, prof.totals.purchaseCount, prof.totals.paidTzs, prof.owedTzs, prof.openInstalments], [10_000, 1, 10_000, 0, []]);
  const actions = (await db('AuditLog').where({ target: juma.id }).orderBy('at')).map(a => a.action);
  assert.deepEqual(actions, ['vendor_supplier_created', 'vendor_supplier_archived', 'vendor_supplier_restored', 'vendor_supplier_updated']);
});

// ── receive ──────────────────────────────────────────────────────────────────

test('receive (AC-8, AC-9, AC-10): GRN created, stock +q with one stock_in ledger row linked to the GRN, cost price set (from → to for the owner), variant stock and its own cost (product cost unchanged), free and equal-cost lines change nothing, low stock cleared, paid in full shows Paid', async () => {
  on();
  await awayFromEatMidnight();
  const v = await vendor();
  const s = await supplier(as(v), { name: 'Juma Supplies' });
  const plain = await product(v, { name: 'Whey 1kg', stock: 3, costTzs: 9_000, reorderLevel: 5 });
  const tee = await product(v, { name: 'Tee', priceTzs: 15_000, stock: undefined, costTzs: 7_000, variants: [{ name: 'S', stock: 1 }, { name: 'M', stock: 2, costTzs: 8_000 }, { name: 'L', stock: 0 }] });
  const bar = await product(v, { name: 'Bar', priceTzs: 2_000, stock: 10, costTzs: 1_200 });
  const noCost = await product(v, { name: 'Bottle', priceTzs: 5_000, stock: 0 });
  // The low-stock crossing was reported once (stock 3 ≤ 5).
  assert.ok((await cost(plain.id)).lowStockAlertedAt);

  const out = await receiveOk(as(v), receiveBody([
    { productId: plain.id, qty: 10, unitCostTzs: 9_500 },
    { productId: tee.id, variant: 'M', qty: 4, unitCostTzs: 8_500 },
    { productId: bar.id, qty: 5, unitCostTzs: 0 },
    { productId: noCost.id, qty: 2, unitCostTzs: 3_000 },
  ], { supplierId: s.id, supplierInvoiceRef: 'INV-4471', paidNow: { amountTzs: 9_500 * 10 + 8_500 * 4 + 6_000, method: 'cash' } }));
  const p = out.purchase;
  assert.match(p.number, /^GRN-\d{6}$/);
  assert.deepEqual([p.status, p.totalTzs, p.paidTzs, p.balanceTzs, p.paymentState, p.nextDue, p.supplierInvoiceRef, p.receivedOn], ['received', 135_000, 135_000, 0, 'paid', null, 'INV-4471', today()]);
  assert.deepEqual(p.lines.map(l => [l.nameSnapshot, l.variant, l.qty, l.unitCostTzs, l.lineTotalTzs, l.costUpdated, l.free, l.previousCostTzs]), [
    ['Whey 1kg', null, 10, 9_500, 95_000, true, false, 9_000],
    ['Tee', 'M', 4, 8_500, 34_000, true, false, 8_000],
    ['Bar', null, 5, 0, 0, false, true, null],
    ['Bottle', null, 2, 3_000, 6_000, true, false, null],
  ]);
  assert.deepEqual(out.costChanges, [
    { productId: plain.id, variant: null, name: 'Whey 1kg', fromTzs: 9_000, toTzs: 9_500 },
    { productId: tee.id, variant: 'M', name: 'Tee', fromTzs: 8_000, toTzs: 8_500 },
    { productId: noCost.id, variant: null, name: 'Bottle', fromTzs: null, toTzs: 3_000 },
  ]);
  assert.deepEqual(p.instalments.map(i => [i.seq, i.dueDate, i.amountTzs, i.state]), [[1, today(), 135_000, 'paid']]);
  assert.deepEqual(p.payments.map(x => [x.amountTzs, x.method, x.atReceipt, x.paidOn, x.status]), [[135_000, 'cash', true, today(), 'recorded']]);
  assert.equal(JSON.stringify(p).includes('fingerprint') || JSON.stringify(p).includes('clientRef') || JSON.stringify(p).includes('costSourceId'), false, 'no internals');

  // Stock and the ledger.
  assert.equal((await row(plain.id)).stock, 13);
  const teeRow = await row(tee.id);
  const variants = typeof teeRow.variants === 'string' ? JSON.parse(teeRow.variants) : teeRow.variants;
  assert.deepEqual([teeRow.stock, variants.find(x => x.name === 'M').stock], [7, 6], 'variant +4, product = sum (O-1)');
  assert.equal((await row(bar.id)).stock, 15);
  const rows = await ledger(plain.id, ['stock_in']);
  assert.deepEqual(rows.map(r => [r.kind, r.delta, r.stockAfter, r.sourceId, r.note, r.actorId]), [['stock_in', 10, 13, p.id, p.number, v]]);
  assert.deepEqual((await ledger(tee.id, ['stock_in'])).map(r => [r.variant, r.delta, r.stockAfter]), [['M', 4, 6]]);
  const history = await call(vendorStockMovements, as(v), { params: { id: plain.id } });
  assert.deepEqual(history.body.rows[0].document, { type: 'purchase', id: p.id, number: p.number });

  // Cost prices (O-9, P-6).
  assert.deepEqual([(await cost(plain.id)).costTzs, (await cost(plain.id)).costSourceId], [9_500, p.id]);
  assert.ok((await cost(plain.id)).costUpdatedAt);
  assert.deepEqual([(await cost(tee.id, 'M')).costTzs, (await cost(tee.id)).costTzs], [8_500, 7_000], 'variant own cost; product cost unchanged');
  assert.deepEqual([(await cost(bar.id)).costTzs, (await cost(bar.id)).costSourceId], [1_200, null], 'a free line never changes the cost price');
  assert.equal((await cost(noCost.id)).costTzs, 3_000, 'a missing cost price is filled');
  // Low stock: back above its level clears the alert.
  assert.equal((await cost(plain.id)).lowStockAlertedAt, null);

  // Same cost as now → no change.
  const same = await receiveOk(as(v), receiveBody([{ productId: plain.id, qty: 1, unitCostTzs: 9_500 }], { paidNow: { amountTzs: 9_500, method: 'cash' } }));
  assert.deepEqual([same.purchase.lines[0].costUpdated, same.costChanges, (await cost(plain.id)).costSourceId], [false, [], p.id]);
  // The variant rule: a tracked-variant product needs a variant.
  assert.deepEqual((await receive(as(v), receiveBody([{ productId: tee.id, qty: 1, unitCostTzs: 1 }], { paidNow: { amountTzs: 1, method: 'cash' } }))).body, { error: 'variant_required', productId: tee.id, variants: ['S', 'M', 'L'] });
  assert.deepEqual((await receive(as(v), receiveBody([{ productId: tee.id, variant: 'XL', qty: 1, unitCostTzs: 1 }]))).body, { error: 'variant_not_found', productId: tee.id, variant: 'XL', variants: ['S', 'M', 'L'] });
  // Audit.
  const audit = await db('AuditLog').where({ target: p.id, action: 'vendor_purchase_received' }).first();
  const a = typeof audit.after === 'string' ? JSON.parse(audit.after) : audit.after;
  assert.deepEqual([a.number, a.totalTzs, a.paidNowTzs, a.costChanges.length, a.lines.length], [p.number, 135_000, 135_000, 3, 4]);
});

test('receive rules (AC-11..AC-13, P-2, P-3, P-14): archived → product_unavailable, deleted → product_not_found, paused/pending listings may be received, supplier required for a balance, received date 30 days back with both dates shown, nothing moves on a refusal', async () => {
  on();
  const v = await vendor();
  const s = await supplier(as(v));
  const p = await product(v, { stock: 2 });
  const archived = await product(v, { name: 'Archived', stock: 2 });
  await db('Product').where({ id: archived.id }).update({ status: 'archived' });
  const deleted = await product(v, { name: 'Deleted', stock: 2 });
  await db('Product').where({ id: deleted.id }).update({ deletedAt: new Date() });
  const pending = await product(v, { name: 'Pending', stock: 0 });
  await db('Product').where({ id: pending.id }).update({ approvalStatus: 'pending', status: 'paused' });

  assert.deepEqual((await receive(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 1 }, { productId: archived.id, qty: 1, unitCostTzs: 1 }], { supplierId: s.id }))).body, { error: 'product_unavailable', productId: archived.id });
  assert.deepEqual((await receive(as(v), receiveBody([{ productId: deleted.id, qty: 1, unitCostTzs: 1 }], { supplierId: s.id }))).body, { error: 'product_not_found', productId: deleted.id });
  assert.equal((await row(p.id)).stock, 2, 'a refusal moves nothing');
  assert.equal(await db('VendorPurchase').where({ vendorId: v }).count('* as n').first().then(r => Number(r.n)), 0);
  assert.equal((await receiveOk(as(v), receiveBody([{ productId: pending.id, qty: 3, unitCostTzs: 0 }]))).purchase.totalTzs, 0, 'a paused, pending listing; total 0 needs no supplier');

  // P-3.
  assert.deepEqual((await receive(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 1_000 }]))).body, { error: 'supplier_required' });
  assert.deepEqual((await receive(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 1_000 }], { paidNow: { amountTzs: 999, method: 'cash' } }))).body, { error: 'supplier_required' });
  const market = await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 1_000 }], { paidNow: { amountTzs: 1_000, method: 'cash' }, dueDate: '2099-01-01' }));
  assert.deepEqual([market.purchase.supplier, market.purchase.paymentState], [null, 'paid'], 'paid in full at the market: no supplier; dueDate ignored');
  assert.deepEqual((await receive(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 1_000 }], { supplierId: s.id, paidNow: { amountTzs: 1_001, method: 'cash' } }))).body, { error: 'overpayment', totalTzs: 1_000 });
  assert.deepEqual((await receive(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 1_000 }], { supplierId: s.id, schedule: [{ dueDate: today(), amountTzs: 999 }] }))).body, { error: 'schedule_mismatch', expectedTzs: 1_000, scheduledTzs: 999 });

  // P-14: received up to 30 days back; stock moves now.
  const back = addDays(today(), -30);
  const old = await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 1_000 }], { supplierId: s.id, receivedOn: back }));
  assert.deepEqual([old.purchase.receivedOn, old.purchase.recordedAt.slice(0, 4)], [back, String(new Date().getUTCFullYear())]);
  assert.equal(old.purchase.instalments[0].dueDate, addDays(back, 30), 'default due date = receivedOn + 30');
  assert.equal((await receive(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 1 }], { supplierId: s.id, receivedOn: addDays(today(), -31) }))).body.error, 'received_on_out_of_range');
  assert.equal((await receive(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 1 }], { supplierId: s.id, receivedOn: addDays(today(), 1) }))).body.error, 'received_on_out_of_range');
});

test('idempotency (AC-14): replay with the same body → 200 and the same purchase, one stock increase, one ledger row; a different body → 409 client_ref_reused; identical requests at once → one purchase', async () => {
  on();
  const v = await vendor();
  const s = await supplier(as(v));
  const p = await product(v, { stock: 0 });
  const b = receiveBody([{ productId: p.id, qty: 5, unitCostTzs: 2_000 }], { supplierId: s.id });
  const first = await receive(as(v), b);
  const again = await receive(as(v), b);
  assert.deepEqual([first.status, again.status, again.headers['Idempotent-Replay']], [201, 200, 'true']);
  assert.equal(again.body.purchase.id, first.body.purchase.id);
  assert.deepEqual(again.body.costChanges, first.body.costChanges);
  assert.equal((await row(p.id)).stock, 5);
  assert.equal((await ledger(p.id, ['stock_in'])).length, 1);
  assert.deepEqual((await receive(as(v), { ...b, lines: [{ productId: p.id, qty: 6, unitCostTzs: 2_000 }] })).body, { error: 'client_ref_reused' });

  const c = receiveBody([{ productId: p.id, qty: 2, unitCostTzs: 2_000 }], { supplierId: s.id });
  const both = await Promise.all([receive(as(v), c), receive(as(v), c), receive(as(v), c)]);
  assert.deepEqual(both.map(x => x.status).sort(), [200, 200, 201]);
  assert.equal(new Set(both.map(x => x.body.purchase.id)).size, 1);
  assert.equal((await row(p.id)).stock, 7);
  assert.equal((await ledger(p.id, ['stock_in'])).length, 2);
  assert.equal(await db('VendorPurchase').where({ vendorId: v }).count('* as n').first().then(r => Number(r.n)), 2);

  // Payments replay too.
  const id = first.body.purchase.id;
  const pb = { clientRef: randomUUID(), amountTzs: 1_000, method: 'cash' };
  const p1 = await call(vendorRecordPurchasePayment, as(v), { params: { id }, body: pb });
  const p2 = await call(vendorRecordPurchasePayment, as(v), { params: { id }, body: pb });
  assert.deepEqual([p1.status, p2.status, p2.body.payment.id], [201, 200, p1.body.payment.id]);
  assert.deepEqual((await call(vendorRecordPurchasePayment, as(v), { params: { id }, body: { ...pb, amountTzs: 2_000 } })).body, { error: 'client_ref_reused' });
  assert.equal((await assertAddsUp(id)).paidTzs, 1_000);
});

test('numbering (AC-15, P-13): GRN-000001… per vendor, gap-free under concurrency and after a receive refused part-way; another vendor starts at 000001; a void keeps the number', async () => {
  on();
  const v = await vendor();
  const v2 = await vendor();
  const s = await supplier(as(v));
  const p = await product(v, { stock: 0 });
  const archived = await product(v, { stock: 0, name: 'Gone' });
  await db('Product').where({ id: archived.id }).update({ status: 'archived' });
  const staffA = await staff(v, ['purchases']);
  const first = await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 100 }], { supplierId: s.id }));
  assert.equal(first.purchase.number, 'GRN-000001');
  assert.equal((await receive(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 1 }, { productId: archived.id, qty: 1, unitCostTzs: 1 }], { supplierId: s.id }))).status, 400);
  const many = await Promise.all(Array.from({ length: 6 }, (_, i) => receive(i % 2 ? as(v) : staffOf(staffA, v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 100 + i }], { supplierId: s.id }))));
  assert.ok(many.every(x => x.status === 201), JSON.stringify(many.map(x => x.body)));
  const numbers = (await db('VendorPurchase').where({ vendorId: v }).orderBy('seq')).map(x => x.number);
  assert.deepEqual(numbers, ['GRN-000001', 'GRN-000002', 'GRN-000003', 'GRN-000004', 'GRN-000005', 'GRN-000006', 'GRN-000007']);
  assert.equal((await voidP(as(v), first.purchase.id)).body.purchase.number, 'GRN-000001');
  const p2 = await product(v2, { stock: 0 });
  assert.equal((await receiveOk(as(v2), receiveBody([{ productId: p2.id, qty: 1, unitCostTzs: 0 }]))).purchase.number, 'GRN-000001');
});

// ── payments and the plan ────────────────────────────────────────────────────

test('payments and instalments (AC-16..AC-19, P-4, P-5, P-9..P-11): part paid at receipt, 3 monthly instalments, a payment covering one and part of the next, overpayment / nothing_owed, payment void reopens the earliest, plan change keeps paid rows and splits the partial one', async () => {
  on();
  await awayFromEatMidnight();
  const v = await vendor();
  const s = await supplier(as(v));
  const p = await product(v, { stock: 0 });
  const d0 = today();
  const sched = [1, 2, 3].map(m => ({ dueDate: addDays(d0, 30 * m), amountTzs: 50_000 }));
  assert.equal((await receive(as(v), receiveBody([{ productId: p.id, qty: 20, unitCostTzs: 10_000 }], { supplierId: s.id, paidNow: { amountTzs: 50_000, method: 'mpesa' }, schedule: sched }))).body.error, 'reference_required');
  const { purchase } = await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 20, unitCostTzs: 10_000 }], { supplierId: s.id, paidNow: { amountTzs: 50_000, method: 'mpesa', reference: 'QK12AB34' }, schedule: [...sched].reverse() }));
  assert.deepEqual(purchase.instalments.map(i => [i.seq, i.dueDate, i.amountTzs, i.state]), [
    [1, d0, 50_000, 'paid'], [2, sched[0].dueDate, 50_000, 'due'], [3, sched[1].dueDate, 50_000, 'due'], [4, sched[2].dueDate, 50_000, 'due'],
  ], 'sorted by the server; the receipt payment is instalment 1');
  assert.deepEqual([purchase.paymentState, purchase.balanceTzs, purchase.nextDue], ['part_paid', 150_000, { dueDate: sched[0].dueDate, openTzs: 50_000, daysOverdue: 0 }]);

  // 70,000: instalment 2 paid, 20,000 of instalment 3.
  const paid = await pay(as(v), purchase.id, { amountTzs: 70_000 });
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  assert.deepEqual(paid.body.covered, [{ seq: 2, dueDate: sched[0].dueDate, amountTzs: 50_000 }, { seq: 3, dueDate: sched[1].dueDate, amountTzs: 20_000 }]);
  assert.deepEqual(paid.body.purchase.instalments.map(i => [i.state, i.coveredTzs, i.openTzs]), [['paid', 50_000, 0], ['paid', 50_000, 0], ['part_paid', 20_000, 30_000], ['due', 0, 50_000]]);
  assert.equal(paid.body.purchase.balanceTzs, 80_000);
  assert.deepEqual((await pay(as(v), purchase.id, { amountTzs: 80_001 })).body, { error: 'overpayment', balanceTzs: 80_000 });
  assert.equal((await pay(as(v), purchase.id, { amountTzs: 1, paidOn: addDays(d0, 1) })).body.error, 'paid_on_out_of_range');
  assert.deepEqual((await pay(as(v), purchase.id, { amountTzs: 1, paidOn: addDays(d0, -1) })).body, { error: 'paid_on_out_of_range', earliest: d0, latest: d0 });
  assert.equal((await pay(as(v), purchase.id, { amountTzs: 0 })).body.error, 'invalid_amount');

  // Void the 70,000 payment: back to 150,000, instalments 2–3 due again.
  const voided = await voidPay(as(v), purchase.id, paid.body.payment.id);
  assert.equal(voided.status, 200, JSON.stringify(voided.body));
  assert.deepEqual([voided.body.purchase.balanceTzs, voided.body.purchase.instalments.map(i => i.state)], [150_000, ['paid', 'due', 'due', 'due']]);
  const vp = voided.body.purchase.payments.find(x => x.id === paid.body.payment.id);
  assert.deepEqual([vp.status, vp.voidReason, vp.voidedBy.id, vp.voidedWithPurchase], ['voided', 'Recorded twice', v, false]);
  assert.deepEqual((await voidPay(as(v), purchase.id, paid.body.payment.id)).body.error, 'already_voided');
  await assertAddsUp(purchase.id);

  // Plan change with 50,000 + 70,000 paid (re-record it): the paid rows stay, instalment 3 keeps its 20,000.
  await pay(as(v), purchase.id, { amountTzs: 70_000 });
  const badSum = await call(vendorChangePurchasePlan, as(v), { params: { id: purchase.id }, body: { schedule: [{ dueDate: addDays(d0, 10), amountTzs: 79_999 }] } });
  assert.deepEqual(badSum.body, { error: 'schedule_mismatch', expectedTzs: 80_000, scheduledTzs: 79_999 });
  assert.deepEqual((await call(vendorChangePurchasePlan, as(v), { params: { id: purchase.id }, body: { schedule: [{ dueDate: addDays(d0, -1), amountTzs: 80_000 }] } })).body,
    { error: 'due_date_out_of_range', earliest: d0, latest: addDays(d0, 365) });
  const changed = await call(vendorChangePurchasePlan, as(v), { params: { id: purchase.id }, body: { schedule: [{ dueDate: addDays(d0, 14), amountTzs: 40_000 }, { dueDate: addDays(d0, 7), amountTzs: 40_000 }] } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(changed.body.purchase.instalments.map(i => [i.seq, i.dueDate, i.amountTzs, i.state]), [
    [1, d0, 50_000, 'paid'], [2, sched[0].dueDate, 50_000, 'paid'], [3, sched[1].dueDate, 20_000, 'paid'],
    [4, addDays(d0, 7), 40_000, 'due'], [5, addDays(d0, 14), 40_000, 'due'],
  ], 'paid rows first, the covered part of instalment 3 kept with its date, then the new rows by date');
  assert.equal(await db('VendorPurchaseInstalment').where({ purchaseId: purchase.id, status: 'replaced' }).count('* as n').first().then(r => Number(r.n)), 2, 'replaced rows kept for history');
  await assertAddsUp(purchase.id);
  // Voiding the 70,000 again reopens the earliest rows first (with their own dates).
  const second = (await getP(as(v), purchase.id)).payments.filter(x => x.status === 'recorded' && !x.atReceipt)[0];
  const reopened = await voidPay(as(v), purchase.id, second.id);
  assert.deepEqual(reopened.body.purchase.instalments.map(i => i.state), ['paid', 'due', 'due', 'due', 'due']);
  await assertAddsUp(purchase.id);
  assert.deepEqual((await db('AuditLog').where({ target: purchase.id }).orderBy('at')).map(a => a.action), ['vendor_purchase_received', 'vendor_purchase_plan_changed']);

  // Paid off → nothing_owed (payment and plan).
  await pay(as(v), purchase.id, { amountTzs: 150_000, method: 'bank', reference: 'TT-99' });
  assert.deepEqual((await pay(as(v), purchase.id, { amountTzs: 1 })).body, { error: 'nothing_owed' });
  assert.deepEqual((await call(vendorChangePurchasePlan, as(v), { params: { id: purchase.id }, body: { schedule: [{ dueDate: d0, amountTzs: 1 }] } })).body, { error: 'nothing_owed' });
  assert.equal((await getP(as(v), purchase.id)).paymentState, 'paid');

  // A purchase without a supplier cannot go into debt: its payment cannot be voided.
  const market = await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 500 }], { paidNow: { amountTzs: 500, method: 'cash' } }));
  assert.deepEqual((await voidPay(as(v), market.purchase.id, market.purchase.payments[0].id)).body, { error: 'supplier_required' });
  // The database refuses an inconsistent balance or a debt without a supplier, whatever the code does.
  await assert.rejects(db('VendorPurchase').where({ id: purchase.id }).update({ balanceTzs: 1 }), /vendorpurchase_adds_up/);
  await assert.rejects(db('VendorPurchase').where({ id: market.purchase.id }).update({ paidTzs: 0, balanceTzs: 500 }), /vendorpurchase_debt_needs_supplier/);
  await assert.rejects(db('VendorPurchaseLine').where({ purchaseId: purchase.id }).update({ lineTotalTzs: 1 }), /vendorpurchaseline_total_exact/);
});

// ── void ─────────────────────────────────────────────────────────────────────

test('void (AC-22, AC-23, P-8): full reversal once (stock, ledger, cost put back, payments voided with it), insufficient_stock lists every short line and changes nothing, already_voided, no longer owed', async () => {
  on();
  const v = await vendor();
  const s = await supplier(as(v));
  const a = await product(v, { name: 'Whey 1kg', stock: 3, costTzs: 9_000 });
  const b = await product(v, { name: 'Tee', priceTzs: 15_000, stock: undefined, variants: [{ name: 'S', stock: 0, costTzs: 7_000 }] });
  const { purchase } = await receiveOk(as(v), receiveBody([{ productId: a.id, qty: 10, unitCostTzs: 9_500 }, { productId: b.id, variant: 'S', qty: 2, unitCostTzs: 7_500 }],
    { supplierId: s.id, paidNow: { amountTzs: 50_000, method: 'cash' } }));
  await pay(as(v), purchase.id, { amountTzs: 10_000 });

  // Sell 9 of the 13 Whey and 1 of the 2 Tee S → both short.
  await call(vendorRecordSale, as(v), { body: { clientRef: randomUUID(), lines: [{ productId: a.id, qty: 9 }, { productId: b.id, variant: 'S', qty: 1 }], payments: cash(45_000 * 9 + 15_000) } });
  const refused = await voidP(as(v), purchase.id);
  assert.deepEqual(refused, { status: 409, body: { error: 'insufficient_stock', lines: [
    { productId: a.id, variant: null, name: 'Whey 1kg', receivedQty: 10, available: 4 },
    { productId: b.id, variant: 'S', name: 'Tee', receivedQty: 2, available: 1 },
  ].sort((x, y) => (`${x.productId}\u0000${x.variant || ''}` < `${y.productId}\u0000${y.variant || ''}` ? -1 : 1)) } });
  assert.deepEqual([(await row(a.id)).stock, (await row(b.id)).stock, (await getP(as(v), purchase.id)).status], [4, 1, 'received'], 'nothing changed');
  assert.equal((await ledger(a.id, ['stock_in_void'])).length, 0);

  // Count the stock back up (S1 Found), then void.
  for (const [pid, variant, qty] of [[a.id, null, 6], [b.id, 'S', 1]]) {
    const adj = await call(vendorStockAdjustment, as(v), { params: { id: pid }, body: { clientRef: randomUUID(), reason: 'found', quantity: qty, ...(variant ? { variant } : {}) } });
    assert.ok([200, 201].includes(adj.status), JSON.stringify(adj.body));
  }
  const done = await voidP(as(v), purchase.id, 'Wrong supplier');
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.paymentsVoided, done.body.costRestored.length, done.body.costKept], [2, 2, []]);
  assert.deepEqual([done.body.purchase.status, done.body.purchase.voidReason, done.body.purchase.overdueTzs, done.body.purchase.nextDue], ['voided', 'Wrong supplier', 0, null]);
  assert.ok(done.body.purchase.payments.every(x => x.status === 'voided' && x.voidedWithPurchase && x.voidReason === 'Wrong supplier'));
  assert.deepEqual(done.body.purchase.lines.map(l => l.costRestoredOnVoid), [true, true]);
  assert.deepEqual([(await row(a.id)).stock, (await row(b.id)).stock], [0, 0]);
  assert.deepEqual((await ledger(a.id, ['stock_in_void'])).map(r => [r.delta, r.stockAfter, r.sourceId]), [[-10, 0, purchase.id]]);
  assert.deepEqual([(await cost(a.id)).costTzs, (await cost(a.id)).costSourceId, (await cost(b.id, 'S')).costTzs], [9_000, null, 7_000], 'cost prices put back');
  assert.deepEqual((await voidP(as(v), purchase.id)).body.error, 'already_voided');
  assert.equal((await pay(as(v), purchase.id, { amountTzs: 1 })).body.error, 'purchase_voided');
  assert.deepEqual((await call(vendorGetSupplier, as(v), { params: { id: s.id } })).body.owedTzs, 0, 'a voided purchase is not owed');
  assert.deepEqual((await call(vendorPayablesAging, as(v))).body.totals.owedTzs, 0);
  const p = await assertAddsUp(purchase.id);
  assert.equal(p.paidTzs, 60_000, 'paidTzs kept as history');
  // Notifications: the vendor's own void tells nobody.
  assert.equal(await db('MarketplaceNotification').where({ userId: v, type: 'vendor_purchase_voided' }).count('* as n').first().then(r => Number(r.n)), 0);
});

test('cost price on void (AC-24, P-6): a later receive keeps its cost; a manual product-form edit keeps it; voiding the later one walks back past a voided source; form saves that re-send the same cost do not break restoring', async () => {
  on();
  const v = await vendor();
  const s = await supplier(as(v));
  const p = await product(v, { stock: 0, costTzs: 9_000 });
  const A = (await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 5, unitCostTzs: 9_500 }], { supplierId: s.id }))).purchase;
  const B = (await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 5, unitCostTzs: 9_800 }], { supplierId: s.id }))).purchase;
  const voidA = await voidP(as(v), A.id);
  assert.deepEqual([voidA.body.costRestored, voidA.body.costKept], [[], [{ productId: p.id, variant: null, name: p.name }]]);
  assert.equal((await cost(p.id)).costTzs, 9_800, 'cost price kept (changed since)');
  assert.equal(voidA.body.purchase.lines[0].costRestoredOnVoid, false);
  // Voiding B: its previous source A is voided → walk back to what A replaced (9,000, set by hand).
  const voidB = await voidP(as(v), B.id);
  assert.equal(voidB.body.costRestored.length, 1);
  assert.deepEqual([(await cost(p.id)).costTzs, (await cost(p.id)).costSourceId], [9_000, null]);

  // Manual form edit after a receive: kept on void. A form save that re-sends the same cost is not an edit.
  const C = (await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 5, unitCostTzs: 9_900 }], { supplierId: s.id }))).purchase;
  const same = await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { description: 'Now with a description', costTzs: 9_900 } });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal((await cost(p.id)).costSourceId, C.id, 'same cost re-sent: source unchanged');
  const edit = await call(vendorUpdateProduct, as(v), { params: { id: p.id }, body: { costTzs: 10_500 } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.deepEqual([(await cost(p.id)).costTzs, (await cost(p.id)).costSourceId], [10_500, null], 'manual edit: costSourceId null');
  assert.deepEqual((await voidP(as(v), C.id)).body.costKept.length, 1);
  assert.equal((await cost(p.id)).costTzs, 10_500);
  // A free line is never a cost change, so there is nothing to put back.
  const D = (await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 0 }]))).purchase;
  assert.deepEqual((await voidP(as(v), D.id)).body, { purchase: (await getP(as(v), D.id)), costRestored: [], costKept: [], paymentsVoided: 0 });
});

test('who may void (AC-25, M2): owner and admin staff any; other `purchases` staff their own purchase / payment on the EAT day they recorded it (not_own / too_old, checked first); staff voids notify the vendor account in EN/SW; audit rows', async () => {
  on();
  await awayFromEatMidnight();
  const v = await vendor();
  const s = await supplier(as(v));
  const p = await product(v, { stock: 0 });
  const clerk = await staff(v, ['purchases'], { displayName: 'Neema Clerk' });
  const other = await staff(v, ['purchases']);
  const admin = await staff(v, ['purchases'], { vendorRole: 'admin', displayName: 'Admin Ali' });
  const mine = (await receiveOk(staffOf(clerk, v), receiveBody([{ productId: p.id, qty: 2, unitCostTzs: 1_000 }], { supplierId: s.id }))).purchase;
  const owners = (await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 2, unitCostTzs: 1_000 }], { supplierId: s.id }))).purchase;
  assert.deepEqual(await voidP(staffOf(clerk, v), owners.id), { status: 403, body: { error: 'void_not_allowed', reason: 'not_own' } });
  const payment = (await pay(staffOf(clerk, v), owners.id, { amountTzs: 100 })).body.payment;
  assert.deepEqual(await voidPay(staffOf(other, v), owners.id, payment.id), { status: 403, body: { error: 'void_not_allowed', reason: 'not_own' } });
  // Yesterday's own record → too_old (moved back a day in the database).
  const old = (await receiveOk(staffOf(clerk, v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 1_000 }], { supplierId: s.id }))).purchase;
  await db('VendorPurchase').where({ id: old.id }).update({ createdAt: new Date(Date.now() - 86_400_000) });
  assert.deepEqual(await voidP(staffOf(clerk, v), old.id), { status: 403, body: { error: 'void_not_allowed', reason: 'too_old' } });
  // Own, same day: allowed, and the vendor account is told (staff actor only).
  assert.equal((await voidPay(staffOf(clerk, v), owners.id, payment.id)).status, 200);
  assert.equal((await voidP(staffOf(clerk, v), mine.id)).status, 200);
  assert.equal((await voidP(staffOf(admin, v), old.id)).status, 200, 'admin staff may void any');
  const alerts = async type => db('MarketplaceNotification').where({ userId: v, type });
  assert.equal((await alerts('vendor_purchase_voided')).length, 2);
  assert.equal((await alerts('vendor_purchase_payment_voided')).length, 1);
  const data = (await alerts('vendor_purchase_voided')).map(a => (typeof a.data === 'string' ? JSON.parse(a.data) : a.data));
  assert.ok(data.some(d => d.purchaseId === mine.id && d.number === mine.number && d.byName === 'Neema Clerk' && d.totalTzs === 2_000));
  assert.equal((await voidP(as(v), owners.id)).status, 200, 'the owner may void any');
  assert.equal((await alerts('vendor_purchase_voided')).length, 2, 'the owner\'s own void tells nobody');

  // EN / SW templates.
  const sent = [];
  const notifier = createPartnerNotifier({ users, gyms, notify: async (userId, m) => { sent.push([userId, m]); }, preferences: { findByIdAsync: async id => ({ locale: id === 'en_user' ? 'en' : 'sw' }) } });
  const d = { purchaseId: 'vpo_1', number: 'GRN-000012', totalTzs: 95_000, amountTzs: 45_000, byName: null, reason: 'Wrong' };
  await notifier.vendorEvent('en_user', 'vendor_purchase_voided', d);
  await notifier.vendorEvent('sw_user', 'vendor_purchase_voided', d);
  await notifier.vendorEvent('en_user', 'vendor_purchase_payment_voided', d);
  await notifier.vendorEvent('sw_user', 'vendor_purchase_payment_voided', d);
  const texts = sent.map(([, m]) => m);
  assert.equal(texts[0].title, 'Delivery GRN-000012 voided');
  assert.match(texts[0].body, /^A staff member voided delivery GRN-000012 \(TSh 95,000\)\. Reason: Wrong$/);
  assert.equal(texts[1].title, 'Mzigo GRN-000012 umebatilishwa');
  assert.match(texts[1].body, /^Mfanyakazi amebatilisha mzigo GRN-000012/);
  assert.equal(texts[2].title, 'Supplier payment voided');
  assert.equal(texts[3].title, 'Malipo kwa msambazaji yamebatilishwa');
  assert.deepEqual([texts[0].data.purchaseId, texts[0].data.number, texts[3].type], ['vpo_1', 'GRN-000012', 'vendor_purchase_payment_voided']);
  // Audit rows for each write.
  assert.deepEqual((await db('AuditLog').where({ target: mine.id }).orderBy('at')).map(x => x.action), ['vendor_purchase_received', 'vendor_purchase_voided']);
  assert.deepEqual((await db('AuditLog').where({ target: payment.id }).orderBy('at')).map(x => x.action), ['vendor_purchase_payment_recorded', 'vendor_purchase_payment_voided']);
});

// ── concurrency ──────────────────────────────────────────────────────────────

test('concurrency (AC-20, AC-26, §2.8): receive vs POS sale (stock exact); void vs sale of the units (one wins, never negative); two payments (second sees the fresh balance); payment vs void; plan vs payment; archive vs receive; two receives on one cost row', async () => {
  on();
  const v = await vendor();
  const s = await supplier(as(v));
  const p = await product(v, { stock: 5, costTzs: 1_000 });
  const sale = () => call(vendorRecordSale, as(v), { body: { clientRef: randomUUID(), lines: [{ productId: p.id, qty: 1 }], payments: cash(45_000) } });
  // Receive vs sale: both succeed in some order; stock exact.
  const [r1, s1] = await Promise.all([receive(as(v), receiveBody([{ productId: p.id, qty: 3, unitCostTzs: 1_000 }], { supplierId: s.id })), sale()]);
  assert.deepEqual([r1.status, s1.status], [201, 201]);
  assert.equal((await row(p.id)).stock, 7);

  // Void vs a sale of the same units: one wins; stock never negative.
  const q = await product(v, { stock: 0 });
  const g = (await receiveOk(as(v), receiveBody([{ productId: q.id, qty: 1, unitCostTzs: 1_000 }], { supplierId: s.id }))).purchase;
  const [vd, sl] = await Promise.all([voidP(as(v), g.id), call(vendorRecordSale, as(v), { body: { clientRef: randomUUID(), lines: [{ productId: q.id, qty: 1 }], payments: cash(45_000) } })]);
  assert.ok((vd.status === 200 && sl.status === 409) || (vd.status === 409 && vd.body.error === 'insufficient_stock' && sl.status === 201), JSON.stringify([vd.body, sl.body]));
  assert.equal((await row(q.id)).stock, 0);

  // Two payments that together exceed the balance: one 201, one 409 overpayment with the fresh balance.
  const h = (await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 10_000 }], { supplierId: s.id }))).purchase;
  const both = await Promise.all([pay(as(v), h.id, { amountTzs: 7_000 }), pay(as(v), h.id, { amountTzs: 6_000 })]);
  const lost = both.find(x => x.status !== 201);
  assert.equal(both.filter(x => x.status === 201).length, 1);
  assert.equal(lost.body.error, 'overpayment');
  assert.ok([3_000, 4_000].includes(lost.body.balanceTzs));
  await assertAddsUp(h.id);

  // Payment vs void: either the payment lands and is voided with the purchase, or it gets purchase_voided.
  const k = (await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 10_000 }], { supplierId: s.id }))).purchase;
  const [pv, vv] = await Promise.all([pay(as(v), k.id, { amountTzs: 1_000 }), voidP(as(v), k.id)]);
  assert.equal(vv.status, 200);
  if (pv.status === 201) assert.ok((await db('VendorPurchasePayment').where({ purchaseId: k.id })).every(x => x.status === 'voided' && x.voidedWithPurchase));
  else assert.equal(pv.body.error, 'purchase_voided');

  // Plan vs payment: the plan is checked against the balance read under the lock.
  const m = (await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 10_000 }], { supplierId: s.id }))).purchase;
  const [plan, pm] = await Promise.all([
    call(vendorChangePurchasePlan, as(v), { params: { id: m.id }, body: { schedule: [{ dueDate: today(), amountTzs: 10_000 }] } }),
    pay(as(v), m.id, { amountTzs: 2_000 }),
  ]);
  assert.equal(pm.status, 201);
  assert.ok(plan.status === 200 || (plan.status === 400 && plan.body.error === 'schedule_mismatch' && plan.body.expectedTzs === 8_000), JSON.stringify(plan.body));
  await assertAddsUp(m.id);

  // Archive vs receive with a balance: either archived (receive gets supplier_archived) or supplier_has_balance.
  const s2 = await supplier(as(v));
  const [ar, rr] = await Promise.all([
    call(vendorUpdateSupplier, as(v), { params: { id: s2.id }, body: { archived: true } }),
    receive(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 500 }], { supplierId: s2.id })),
  ]);
  assert.ok((ar.status === 200 && rr.body.error === 'supplier_archived') || (ar.body.error === 'supplier_has_balance' && rr.status === 201), JSON.stringify([ar.body, rr.body]));

  // Two receives on one cost row: the later one wins and is the source; voiding the earlier keeps it.
  const c = await product(v, { stock: 0, costTzs: 100 });
  const [x1, x2] = await Promise.all([
    receive(as(v), receiveBody([{ productId: c.id, qty: 1, unitCostTzs: 200 }], { supplierId: s.id })),
    receive(as(v), receiveBody([{ productId: c.id, qty: 1, unitCostTzs: 300 }], { supplierId: s.id })),
  ]);
  const later = [x1, x2].sort((a, b) => a.body.purchase.number.localeCompare(b.body.purchase.number))[1].body.purchase;
  const earlier = [x1, x2].find(x => x.body.purchase.id !== later.id).body.purchase;
  assert.deepEqual([(await cost(c.id)).costTzs, (await cost(c.id)).costSourceId], [later.lines[0].unitCostTzs, later.id]);
  assert.equal(later.lines[0].previousCostTzs, earlier.lines[0].unitCostTzs, 'the later one saw the earlier one\'s cost');
  assert.equal((await voidP(as(v), earlier.id)).body.costKept.length, 1);
});

// ── reads, aging, reports, settlement ───────────────────────────────────────

test('lists and last costs: filters (status, payment, supplier, createdBy=me, dates), summary over the whole filter (received only), CSV in Swahili with formula-injection-safe cells; last purchase cost skips voided and free lines', async () => {
  on();
  const v = await vendor();
  const s = await supplier(as(v), { name: '=HYPERLINK("http://x")' });
  const s2 = await supplier(as(v), { name: 'Kariakoo Traders' });
  const clerk = await staff(v, ['purchases']);
  const p = await product(v, { stock: 0 });
  const g1 = (await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 2, unitCostTzs: 1_000 }], { supplierId: s.id, receivedOn: addDays(today(), -3) }))).purchase;
  const g2 = (await receiveOk(staffOf(clerk, v), receiveBody([{ productId: p.id, qty: 3, unitCostTzs: 2_000 }], { supplierId: s2.id, paidNow: { amountTzs: 6_000, method: 'cash' } }))).purchase;
  const g3 = (await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 3_000 }], { supplierId: s2.id }))).purchase;
  await voidP(as(v), g3.id);
  await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 0 }]));
  const list = async query => (await call(vendorListPurchases, as(v), { query })).body;
  const all = await list({});
  assert.deepEqual(all.purchases.map(x => x.number), ['GRN-000004', 'GRN-000003', 'GRN-000002', 'GRN-000001']);
  assert.deepEqual(all.summary, { count: 3, totalTzs: 8_000, paidTzs: 6_000, balanceTzs: 2_000, units: 6 });
  assert.deepEqual((await list({ status: 'voided' })).purchases.map(x => x.id), [g3.id]);
  assert.deepEqual((await list({ payment: 'open' })).purchases.map(x => x.id), [g1.id]);
  assert.deepEqual((await list({ payment: 'paid' })).purchases.map(x => x.number), ['GRN-000004', 'GRN-000002']);
  assert.deepEqual((await list({ supplierId: s2.id })).purchases.map(x => x.id), [g3.id, g2.id]);
  assert.deepEqual((await call(vendorListPurchases, staffOf(clerk, v), { query: { createdBy: 'me' } })).body.purchases.map(x => x.id), [g2.id]);
  assert.deepEqual((await list({ to: addDays(today(), -1) })).purchases.map(x => x.id), [g1.id]);
  const row1 = all.purchases.find(x => x.id === g1.id);
  assert.deepEqual([row1.lineCount, row1.units, row1.paymentState, row1.nextDueDate, row1.supplier.name], [1, 2, 'unpaid', addDays(g1.receivedOn, 30), s.name]);
  const page = await list({ limit: 2 });
  const next = await list({ limit: 2, cursor: page.nextCursor });
  assert.deepEqual([...page.purchases, ...next.purchases].map(x => x.number), all.purchases.map(x => x.number));
  assert.equal((await list({ status: 'nope' })).error, 'invalid_status');
  assert.equal((await list({ from: '2026-13-01' })).error, 'invalid_date');

  const csv = await call(vendorListPurchases, as(v), { query: { format: 'csv', lang: 'sw' } });
  assert.equal(csv.status, 200);
  assert.equal(csv.headers['Content-Type'], 'text/csv; charset=utf-8');
  const lines = csv.body.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0], 'Namba ya mzigo,Tarehe ya kupokea,Ilirekodiwa (EAT),Msambazaji,Hali,Malipo,Jumla (TZS),Imelipwa (TZS),Kiasi kilichobaki (TZS),Imechelewa (TZS),Tarehe ijayo ya kulipa,Bidhaa,Idadi,Imerekodiwa na');
  assert.ok(lines.some(l => l.startsWith('GRN-000001,') && l.includes(`"'=HYPERLINK(""http://x"")"`)), 'formula-injection safe');
  assert.ok(lines.some(l => l.startsWith('GRN-000003,') && l.includes('Imebatilishwa')));

  const last = (await call(vendorPurchaseLastCosts, as(v), { query: { productIds: `${p.id},nope` } })).body.rows;
  assert.deepEqual(last, [{ productId: p.id, variant: null, unitCostTzs: 2_000, receivedOn: today(), supplierName: 'Kariakoo Traders', number: 'GRN-000002' }], 'voided GRN-000003 and the free GRN-000004 skipped');
  assert.equal((await hit('GET', `/vendor/purchases/last-costs?productIds=${p.id}`, as(v))).body.rows.length, 1, 'mounted: last-costs is not taken for a purchase id');
  assert.equal((await call(vendorPurchaseLastCosts, as(v), { query: { productIds: Array.from({ length: 101 }, (_, i) => `p${i}`).join(',') } })).body.error, 'too_many_products');
});

test('payables aging (AC-27, §2.9): buckets at the EAT day boundary (clock pinned at 21:30 UTC and 23:59 EAT), due today is not due yet, totals = Σ rows, most overdue first, bucket filter, CSV; supplier profile buckets and open instalments', async () => {
  on();
  const v = await vendor();
  const s1 = await supplier(as(v), { name: 'Old Debts Ltd' });
  const s2 = await supplier(as(v), { name: 'New Debts Ltd' });
  const p = await product(v, { stock: 0 });
  let clock = new Date('2026-06-01T09:00:00Z');
  const store = createPgVendorPurchaseStore({ db, now: () => clock });
  const svc = createVendorPurchaseService({ store, now: () => clock });
  const rec = async (supplierId, schedule, total) => {
    const out = await svc.receive({ vendorId: v, actorId: v, body: { clientRef: randomUUID(), supplierId, lines: [{ productId: p.id, qty: 1, unitCostTzs: total }], schedule } });
    assert.equal(out.status, 201, JSON.stringify(out));
    return out.purchase;
  };
  // Received 2026-06-01; instalments due 06-01 (… 91+ later), 07-15, 08-20, 09-01.
  await rec(s1.id, [{ dueDate: '2026-06-01', amountTzs: 100 }, { dueDate: '2026-07-15', amountTzs: 200 }, { dueDate: '2026-08-20', amountTzs: 300 }, { dueDate: '2026-09-01', amountTzs: 400 }], 1_000);
  // 2026-09-02 21:30 UTC = 2026-09-03 00:30 EAT: due 09-03 is due today (not due yet), 09-02 is 1 day overdue.
  clock = new Date('2026-09-01T09:00:00Z');
  const g2 = await rec(s2.id, [{ dueDate: '2026-09-02', amountTzs: 50 }, { dueDate: '2026-09-03', amountTzs: 70 }, { dueDate: '2026-09-08', amountTzs: 30 }], 150);

  clock = new Date('2026-09-02T21:30:00Z'); // EAT 2026-09-03 00:30
  const a = await svc.aging({ vendorId: v });
  assert.equal(a.asOf, '2026-09-03');
  const r1 = a.rows.find(r => r.supplierId === s1.id);
  // Days overdue on 09-03: 06-01 → 94 (90+), 07-15 → 50 (31–60), 08-20 → 14 (1–30), 09-01 → 2 (1–30).
  assert.deepEqual([r1.d90plus, r1.d61_90, r1.d31_60, r1.d1_30, r1.current, r1.maxDaysOverdue, r1.oldestDueDate], [100, 0, 200, 700, 0, 94, '2026-06-01']);
  const r2 = a.rows.find(r => r.supplierId === s2.id);
  assert.deepEqual([r2.d1_30, r2.current, r2.overdueTzs, r2.owedTzs], [50, 100, 50, 150], 'due today (09-03) is not due yet');
  assert.deepEqual(a.rows.map(r => r.name), ['Old Debts Ltd', 'New Debts Ltd'], 'most overdue first');
  for (const k of ['owedTzs', 'overdueTzs', 'current', 'd1_30', 'd31_60', 'd61_90', 'd90plus']) assert.equal(a.totals[k], a.rows.reduce((s, r) => s + r[k], 0), `totals.${k} = Σ rows`);
  assert.deepEqual([a.totals.supplierCount, a.totals.overdueSupplierCount, a.totals.dueIn7DaysTzs], [2, 2, 100]);
  assert.deepEqual((await svc.aging({ vendorId: v, query: { bucket: 'd90plus' } })).rows.map(r => r.name), ['Old Debts Ltd']);
  assert.deepEqual((await svc.aging({ vendorId: v, query: { sort: 'name' } })).rows.map(r => r.name), ['New Debts Ltd', 'Old Debts Ltd']);

  // 23:59 EAT the same day: still 09-03.
  clock = new Date('2026-09-03T20:59:00Z');
  assert.equal((await svc.aging({ vendorId: v })).rows.find(r => r.supplierId === s2.id).current, 100);
  // 00:00 EAT next day: 09-03 becomes 1 day overdue.
  clock = new Date('2026-09-03T21:00:00Z');
  assert.equal((await svc.aging({ vendorId: v })).rows.find(r => r.supplierId === s2.id).d1_30, 120);

  // Payment on g2 covers the oldest first: 60 → instalment 1 paid, 10 of instalment 2.
  const paid = await svc.recordPayment({ vendorId: v, actorId: v, purchaseId: g2.id, body: { clientRef: randomUUID(), amountTzs: 60, method: 'cash' } });
  assert.deepEqual(paid.covered, [{ seq: 1, dueDate: '2026-09-02', amountTzs: 50 }, { seq: 2, dueDate: '2026-09-03', amountTzs: 10 }]);
  const prof = await svc.getSupplier({ vendorId: v, supplierId: s2.id });
  assert.deepEqual(prof.openInstalments.map(i => [i.seq, i.dueDate, i.openTzs, i.daysOverdue]), [[2, '2026-09-03', 60, 1], [3, '2026-09-08', 30, 0]]);
  assert.deepEqual([prof.owedTzs, prof.overdueTzs, prof.aging.d1_30, prof.aging.current, prof.asOf], [90, 60, 60, 30, '2026-09-04']);
  // The purchase view agrees with the aging SQL.
  const view = (await svc.getPurchase({ vendorId: v, purchaseId: g2.id })).purchase;
  assert.deepEqual([view.overdueTzs, view.nextDue, view.instalments.map(i => i.state)], [60, { dueDate: '2026-09-03', openTzs: 60, daysOverdue: 1 }, ['paid', 'part_paid', 'due']]);

  // CSV through the route (real clock): headers in English, one row per supplier.
  const csv = await call(vendorPayablesAging, as(v), { query: { format: 'csv' } });
  const lines = csv.body.replace(/^﻿/, '').split('\r\n').filter(Boolean);
  assert.equal(lines[0], 'Supplier,You owe (TZS),Overdue (TZS),Not due yet (TZS),1–30 days overdue (TZS),31–60 days overdue (TZS),61–90 days overdue (TZS),Over 90 days overdue (TZS),Oldest due date,Days overdue');
  assert.equal(lines.length, 3);
  assert.equal((await call(vendorPayablesAging, as(v), { query: { bucket: 'old' } })).body.error, 'invalid_bucket');
});

test('reports (AC-29, AC-30, §2.11): stock value at cost follows the receive and the void; profit is never restated (earlier sale keeps its cost, a later sale and a paid app order snapshot the new one); "Paid to suppliers" by method on the paid date, voided payments out, only with `reports` + `purchases`', async () => {
  on();
  await awayFromEatMidnight();
  const v = await vendor();
  const s = await supplier(as(v));
  const p = await product(v, { name: 'Whey 1kg', stock: 10, costTzs: 9_000 });
  const noCost = await product(v, { name: 'Bottle', priceTzs: 5_000, stock: 4 });
  const q = { from: today(), to: today() };
  const stock = async () => (await call(vendorReportStockValue, as(v), { query: {} })).body;
  const before = await stock();
  assert.deepEqual([before.totals.atCostTzs, before.costUnknown.count], [90_000, 1]);
  const early = await call(vendorRecordSale, as(v), { body: { clientRef: randomUUID(), lines: [{ productId: p.id, qty: 1 }], payments: cash(45_000) } });

  const g = (await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 9_500 }, { productId: noCost.id, qty: 1, unitCostTzs: 2_000 }],
    { supplierId: s.id, paidNow: { amountTzs: 3_000, method: 'mpesa', reference: 'MP1' } }))).purchase;
  const after1 = await stock();
  assert.deepEqual([after1.totals.atCostTzs, after1.costUnknown?.count ?? 0], [10 * 9_500 + 5 * 2_000, 0], 'new cost × stock; the missing cost is filled');
  const later = await call(vendorRecordSale, as(v), { body: { clientRef: randomUUID(), lines: [{ productId: p.id, qty: 1 }], payments: cash(45_000) } });
  assert.deepEqual([(await db('VendorSaleLine').where({ saleId: early.body.sale.id }).first()).unitCostTzs, (await db('VendorSaleLine').where({ saleId: later.body.sale.id }).first()).unitCostTzs], [9_000, 9_500]);
  // A paid app order snapshots the new cost too.
  const buyer = await user('member', { displayName: 'App Buyer' });
  const placed = await shopService.createOrder({ buyerId: buyer, body: { items: [{ productId: p.id, qty: 1 }], deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni Plot 12, Dar', paymentMethod: 'mpesa' } });
  assert.equal(placed.status, 202, JSON.stringify(placed));
  made.orders.push(placed.order.id);
  await adminPaymentService.decide({ id: placed.paymentRequest.id, decision: 'approve', reference: `MP-${randomUUID().slice(0, 8)}`, amountTzs: placed.order.totalTzs, actorId: uid('adm') });
  assert.equal((await db('ShopOrderLineCost').where({ orderId: placed.order.id, productId: p.id }).first()).unitCostTzs, 9_500);
  const profitBefore = (await call(vendorReportProfit, as(v), { query: q })).body.totals;

  // Payment methods: paid to suppliers, its own group.
  const later2 = await pay(as(v), g.id, { amountTzs: 2_000, method: 'cash' });
  await pay(as(v), g.id, { amountTzs: 1_000, method: 'cash' });
  await voidPay(as(v), g.id, later2.body.payment.id);
  const methods = (await call(vendorReportPaymentMethods, as(v), { query: q })).body;
  assert.deepEqual(methods.paidToSuppliers, [{ method: 'mpesa', amountTzs: 3_000, count: 1 }, { method: 'cash', amountTzs: 1_000, count: 1 }]);
  assert.equal(methods.byYou.reduce((s2, r) => s2 + r.amountTzs, 0), 90_000, 'never summed with money in');
  const csv = await call(vendorReportPaymentMethods, as(v), { query: { ...q, format: 'csv', lang: 'sw' } });
  assert.ok(String(csv.body).includes('Uliyowalipa wasambazaji (wewe),M-Pesa,3000,1,'));
  const reportsOnly = await staff(v, ['reports']);
  assert.equal('paidToSuppliers' in (await call(vendorReportPaymentMethods, staffOf(reportsOnly, v), { query: q })).body, false, 'absent without `purchases`');
  const both = await staff(v, ['reports', 'purchases']);
  assert.equal((await call(vendorReportPaymentMethods, staffOf(both, v), { query: q })).body.paidToSuppliers.length, 2);
  delete process.env.VENDOR_PURCHASES;
  resetVendorReportCache();
  assert.equal('paidToSuppliers' in (await call(vendorReportPaymentMethods, as(v), { query: q })).body, false, 'absent with the flag off');
  on();

  // Void: units leave, cost put back; stock value follows; profit of the sales already made is unchanged.
  await call(vendorStockAdjustment, as(v), { params: { id: p.id }, body: { clientRef: randomUUID(), reason: 'found', quantity: 2 } });
  assert.equal((await voidP(as(v), g.id)).status, 200);
  resetVendorReportCache();
  const after2 = await stock();
  assert.deepEqual([after2.totals.atCostTzs, after2.costUnknown.count], [(await row(p.id)).stock * 9_000, 1]);
  assert.deepEqual((await call(vendorReportProfit, as(v), { query: q })).body.totals, profitBefore, 'profit never restated');
  assert.deepEqual((await call(vendorReportPaymentMethods, as(v), { query: q })).body.paidToSuppliers, [], 'payments voided with the purchase drop out');
});

test('settlement untouched (AC-31, §2.11): VendorSettlement prepare output, /vendor/payments and the statement CSV are identical with purchases, payments and voids present; no PaymentRequest; no commission or payout columns', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { name: 'Bottle', priceTzs: 50_000, stock: 20 });
  const buyer = await user('member', { displayName: 'Settle Buyer' });
  const placed = await shopService.createOrder({ buyerId: buyer, body: { items: [{ productId: p.id, qty: 1 }], deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni Plot 12, Dar', paymentMethod: 'mpesa' } });
  assert.equal(placed.status, 202, JSON.stringify(placed));
  made.orders.push(placed.order.id);
  const paid = await adminPaymentService.decide({ id: placed.paymentRequest.id, decision: 'approve', reference: `MP-${randomUUID().slice(0, 8)}`, amountTzs: placed.order.totalTzs, actorId: uid('adm') });
  assert.equal(paid.paymentRequest.status, 'approved');
  for (const status of ['accepted', 'dispatched', 'delivered']) assert.equal((await shopService.updateOrderStatus({ orderId: placed.order.id, status, actorId: v })).order.status, status);
  const paymentsBefore = await call(vendorPayments, as(v));
  const csvBefore = await shopService.vendorStatement(v);
  const clock = new Date(Date.now() + 7 * 86_400_000);
  const settlements = createVendorSettlementService({ users, payoutEligibility: createPayoutEligibility({ users, gyms, partnerGate, partnerSettlementAccounts, trainers }), now: () => clock });
  const statement = async () => {
    const st = await db('VendorSettlement').where({ vendorId: v }).whereNot('status', 'voided');
    const lines = await db('VendorSettlementLine').where({ vendorId: v, voided: false });
    return { statements: st.map(x => [x.orderCount, x.salesTzs, x.commissionTzs, x.finalNetTzs]), lines: lines.map(l => [l.orderId, l.salesTzs, l.commissionTzs, l.payoutTzs]) };
  };
  assert.equal((await settlements.prepare({ actorId: 'adm_s9' })).error, undefined);
  const before = await statement();
  assert.equal(before.statements.length, 1);
  const requestsBefore = await db('PaymentRequest').count('* as n').first().then(r => Number(r.n));

  const s = await supplier(as(v));
  const g = (await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 5, unitCostTzs: 20_000 }], { supplierId: s.id, paidNow: { amountTzs: 30_000, method: 'bank', reference: 'TT1' } }))).purchase;
  const pm = await pay(as(v), g.id, { amountTzs: 10_000 });
  await voidPay(as(v), g.id, pm.body.payment.id);
  await call(vendorChangePurchasePlan, as(v), { params: { id: g.id }, body: { schedule: [{ dueDate: today(), amountTzs: 70_000 }] } });
  const g2 = (await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 1, unitCostTzs: 1 }], { supplierId: s.id }))).purchase;
  await voidP(as(v), g2.id);

  assert.equal((await settlements.prepare({ actorId: 'adm_s9' })).error, undefined);
  assert.deepEqual(await statement(), before, 'the statement, rebuilt, is exactly the app order');
  assert.deepEqual(await call(vendorPayments, as(v)), paymentsBefore);
  assert.equal(await shopService.vendorStatement(v), csvBefore);
  assert.equal(await db('PaymentRequest').count('* as n').first().then(r => Number(r.n)), requestsBefore, 'no PaymentRequest for payables');
  for (const table of ['VendorPurchase', 'VendorPurchasePayment', 'VendorPurchaseInstalment', 'VendorPurchaseLine']) {
    const columns = Object.keys(await db(table).where({ vendorId: v }).first());
    assert.equal(columns.some(col => /commission|payout|settle/i.test(col)), false, table);
  }
});

test('low stock (§2.11): a receive crossing above the level clears the alert; a void crossing back below sends vendor_low_stock once', async () => {
  on();
  const v = await vendor();
  const s = await supplier(as(v));
  const p = await product(v, { stock: 2, reorderLevel: 3 });
  assert.ok((await cost(p.id)).lowStockAlertedAt, 'starts low (marked as reported)');
  const g = (await receiveOk(as(v), receiveBody([{ productId: p.id, qty: 5, unitCostTzs: 0 }], { supplierId: s.id }))).purchase;
  assert.equal((await cost(p.id)).lowStockAlertedAt, null);
  const lows = () => db('MarketplaceNotification').where({ userId: v, type: 'vendor_low_stock' });
  const n0 = (await lows()).length;
  assert.equal((await voidP(as(v), g.id)).status, 200);
  assert.equal((await lows()).length, n0 + 1, 'the void crossed below: one alert');
  assert.ok((await cost(p.id)).lowStockAlertedAt);
});

test('rate limit: writes share 120 a minute per vendor → 429 rate_limited with Retry-After; nothing changes', async () => {
  on();
  const v = await vendor();
  assert.equal(VENDOR_PURCHASES_LIMITS.writesPerMinute, 120);
  for (let i = 0; i < 120; i += 1) assert.notEqual((await call(vendorCreateSupplier, as(v), { body: { name: 'J' } })).status, 429);
  const limited = await call(vendorCreateSupplier, as(v), { body: { name: 'Juma Supplies' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(limited.headers['Retry-After']);
  assert.equal(await db('VendorSupplier').where({ vendorId: v }).count('* as n').first().then(r => Number(r.n)), 0);
  assert.equal((await call(vendorListSuppliers, as(v))).status, 200, 'reads are not limited by writes');
});
