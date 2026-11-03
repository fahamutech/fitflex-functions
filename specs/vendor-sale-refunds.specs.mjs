// Vendor business tools · S7 — partial and revertible refunds on walk-in sales (design spec
// docs/design/vendor-refunds-s7.md §12). Against the CI database: cumulative rounding that never gives back
// more than was paid, credit sales (balance first), undo, the void guard, gap-free CN numbers, the stock ledger
// written exactly once, reports, the credit-note document and settlement left untouched.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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
import { vendorToolsOptionsRoute, vendorCreateProduct, vendorStockMovements, createShopOrder, vendorPayments } from '../functions/shop.mjs';
import { vendorRecordSale, vendorGetSale, vendorListSales, vendorVoidSale, resetVendorSalesLimits, allowVendorSale, VENDOR_SALES_LIMIT } from '../functions/vendor-sales.mjs';
import { vendorRefundSale, vendorRevertRefund, vendorListRefunds, vendorGetRefund } from '../functions/vendor-refunds.mjs';
import { vendorCustomersCreate, vendorCustomerGet, vendorCustomerUpdate, vendorCustomerRecordPayment, vendorCustomerVoidPayment, vendorReceivablesAging, resetVendorCustomerLimits } from '../functions/vendor-customers.mjs';
import { vendorShareRefund, vendorShareSale, vendorDocumentView, resetVendorDocumentLimits } from '../functions/vendor-documents.mjs';
import { vendorReportSales, vendorReportProfit, vendorReportRefunds, vendorReportPaymentMethods, vendorReportCustomers, vendorReportProducts, resetVendorReportCache, resetVendorReportLimits } from '../functions/vendor-reports.mjs';
import { cumulativeShare, refundLineAmounts, splitRefund, refundMethod, parseRefund, refundFingerprint, creditNoteNumber, refundStateOf } from '../src/shared/vendor-refund.mjs';
import { creditNoteDocument, saleDocumentStatus } from '../src/shared/vendor-documents.mjs';
import { renderDocumentHtml } from '../src/shared/vendor-document-html.mjs';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';

const migration = createRequire(import.meta.url)('../db/migrations/20270202090400-vendor-sale-refunds.cjs');

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [], orders: [] };
const FLAGS = ['VENDOR_TOOLS', 'VENDOR_WALKIN_SALES', 'VENDOR_REFUNDS', 'VENDOR_CUSTOMERS', 'VENDOR_DOCUMENTS', 'VENDOR_REPORTS', 'VENDOR_STOCK_LEDGER'];
const PUBLIC = 'https://docs.fitflex.example';
const on = (list = FLAGS) => { for (const f of list) process.env[f] = '1'; process.env.PUBLIC_API_URL = PUBLIC; };
afterEach(() => {
  for (const f of FLAGS) delete process.env[f];
  delete process.env.PUBLIC_API_URL;
  resetVendorSalesLimits(); resetVendorCustomerLimits(); resetVendorDocumentLimits(); resetVendorReportCache(); resetVendorReportLimits();
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
  await db('User').insert({ id, userType, displayName: `S7 ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
async function vendor(extra = {}) {
  const id = await user('vendor', { createdAt: new Date('2026-01-01T00:00:00Z'), displayName: 'Asha Owner', vendorProfile: JSON.stringify({ businessName: 'Refund Shop', status: 'published' }), ...extra });
  const caseId = uid('kyc');
  await db('PartnerKycCase').insert({ id: caseId, partnerType: 'vendor', userId: id, status: 'approved', tier: 3, updatedAt: new Date() });
  await db('PartnerSettlementAccount').insert({
    id: uid('psa'), caseId, method: 'bank', provider: 'CRDB', accountName: 'Refund Shop', accountNumber: '0150001234',
    status: 'verified', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z'), cooldownUntil: new Date('2026-09-03T00:00:00Z'), updatedAt: new Date(),
  });
  return id;
}
const as = id => ({ sub: id, userType: 'vendor' });
const staffOf = (id, vendorId) => ({ sub: id, userType: 'vendor_staff', vendorId });
const staff = (vendorId, permissions, extra = {}) => user('vendor_staff', { vendorId, vendorPermissions: permissions, accountStatus: 'active', vendorRole: 'sales', displayName: 'Juma Seller', ...extra });

async function product(vendorId, body = {}) {
  const out = await call(vendorCreateProduct, as(vendorId), { body: { name: 'Whey 1kg', category: 'supplements_nutrition', priceTzs: 45_000, stock: 50, ...body } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  made.products.push(out.body.id);
  await shopService.adminUpdateProductListing({ productId: out.body.id, body: { approvalStatus: 'approved' }, actorId: 'adm_s7' });
  return out.body;
}
const cash = amountTzs => [{ method: 'cash', amountTzs }];
async function sell(claims, lines, payments, extra = {}) {
  const out = await call(vendorRecordSale, claims, { body: { clientRef: randomUUID(), lines, payments, ...extra } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.sale;
}
const body = (lines, extra = {}) => ({ clientRef: randomUUID(), reason: 'Customer returned it', method: 'cash', ...extra, lines });
const refund = (claims, saleId, b) => call(vendorRefundSale, claims, { params: { id: saleId }, body: b });
async function refundOk(claims, saleId, b) {
  const out = await refund(claims, saleId, b);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body;
}
const undo = (claims, refundId, reason = 'Refunded by mistake') => call(vendorRevertRefund, claims, { params: { id: refundId }, body: { reason } });
const getSale = async (vendorId, id) => (await call(vendorGetSale, as(vendorId), { params: { id } })).body.sale;
const row = id => db('Product').where({ id }).first();
const lineOf = (sale, productId, i = 0) => sale.lines.filter(l => l.productId === productId)[i];
const ledger = (productId, reasons) => db('ShopStockMovement').where({ productId }).whereIn('reason', reasons).orderBy([{ column: 'createdAt' }, { column: 'id' }]);
/** Every money CHECK of a sale, read back from the database (and the line counters against the refunds). */
async function assertAddsUp(saleId) {
  const s = await db('VendorSale').where({ id: saleId }).first();
  assert.equal(s.paidTzs - s.changeTzs + s.balanceTzs + s.balanceReducedTzs, s.totalTzs, `sale ${s.number} adds up`);
  const active = await db('VendorSaleRefund').where({ saleId, status: 'active' });
  assert.equal(s.refundedTzs, active.reduce((t, r) => t + r.amountTzs, 0), 'refundedTzs = Σ active refunds');
  assert.equal(s.balanceReducedTzs, active.reduce((t, r) => t + r.balanceReducedTzs, 0), 'balanceReducedTzs = Σ active');
  for (const l of await db('VendorSaleLine').where({ saleId })) {
    const rl = await db('VendorSaleRefundLine as rl').join('VendorSaleRefund as r', 'r.id', 'rl.refundId').where({ 'rl.saleLineId': l.id, 'r.status': 'active' }).select('rl.qty', 'rl.amountTzs');
    assert.equal(l.refundedQty, rl.reduce((t, x) => t + x.qty, 0));
    assert.equal(l.refundedTzs, rl.reduce((t, x) => t + x.amountTzs, 0));
    assert.ok(l.refundedTzs <= l.lineTotalTzs - l.saleDiscountShareTzs, 'never more than the line paid');
  }
  return s;
}
/** Route-level specs compare EAT "today" with the server's: never start one in the last 15 s before 00:00 EAT. */
async function awayFromEatMidnight() {
  const msToMidnight = (21 * 3_600_000 - (Date.now() % 86_400_000) + 86_400_000) % 86_400_000;
  if (msToMidnight < 15_000) await new Promise(resolve => setTimeout(resolve, msToMidnight + 250));
}
const addCustomer = async (claims, extra = {}) => {
  const out = await call(vendorCustomersCreate, claims, { body: { name: 'Juma Mussa', ...extra } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.customer;
};
const pay = (claims, customerId, b) => call(vendorCustomerRecordPayment, claims, { params: { id: customerId }, body: { clientRef: randomUUID(), method: 'cash', ...b } });
const streamData = (s, dictStart, start) => s.slice(start, start + Number(s.slice(dictStart, start).match(/\/Length (\d+)/)[1]));
/** Text drawn in a pdfkit PDF (inflates the content streams, decodes the hex strings). */
function pdfText(buffer) {
  const s = buffer.toString('latin1');
  let out = '';
  for (let i = s.indexOf('\nstream\n'); i !== -1;) {
    const dictStart = s.lastIndexOf(' 0 obj', i);
    const start = i + '\nstream\n'.length;
    const raw = streamData(s, dictStart, start);
    i = s.indexOf('\nstream\n', start + raw.length);
    if (!/\/Filter \/FlateDecode/.test(s.slice(dictStart, start))) continue;
    const data = zlib.inflateSync(Buffer.from(raw, 'latin1')).toString('latin1');
    for (const t of data.matchAll(/\[(.*?)\]\s*TJ/g)) out += `${[...t[1].matchAll(/<([0-9a-fA-F]*)>/g)].map(h => Buffer.from(h[1], 'hex').toString('latin1')).join('')}\n`;
  }
  return out;
}

after(async () => {
  for (const s of servers) s.close();
  const vendors = made.users;
  const saleIds = (await db('VendorSale').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  const refundIds = (await db('VendorSaleRefund').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  const paymentIds = (await db('VendorCustomerPayment').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  const customerIds = (await db('VendorCustomer').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  const linkIds = (await db('VendorDocumentLink').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  await db('AuditLog').whereIn('target', [...saleIds, ...refundIds, ...paymentIds, ...customerIds, ...linkIds, ...made.orders, ...made.products, ...vendors]).del();
  await db('VendorDocumentLink').whereIn('vendorId', vendors).del();
  await db('VendorOrderInvoice').whereIn('vendorId', vendors).del();
  await db('VendorSaleRefund').whereIn('vendorId', vendors).del(); // lines go with it
  await db('VendorCustomerPayment').whereIn('vendorId', vendors).del();
  await db('VendorSale').whereIn('vendorId', vendors).del();
  await db('VendorCustomer').whereIn('vendorId', vendors).del();
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
  await db('ProductPrivate').whereIn('productId', made.products).del();
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
async function hit(method, url, claims, payload) {
  const r = await fetch(`${base}${url}`, {
    method, headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.7.0.${Math.floor(Math.random() * 200) + 1}`, ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const buffer = Buffer.from(await r.arrayBuffer());
  let parsed = buffer.toString('utf8');
  try { parsed = JSON.parse(parsed); } catch { /* not JSON */ }
  return { status: r.status, body: parsed, buffer };
}

// ── pure rules ───────────────────────────────────────────────────────────────

test('rules: M-2 cumulative rounding (3,333 / 3,333 / 3,334), the last unit takes the rest, undo in the middle never exceeds; M-3 VAT; M-4 balance first; M-6 method rules', () => {
  // lineNet 10,000 (3 × 3,500 − 500), Q 3.
  const line = { qty: 3, lineTotalTzs: 10_000, saleDiscountShareTzs: 0, vatTzs: 1_525, refundedQty: 0, refundedTzs: 0, refundedVatTzs: 0 };
  const one = refundLineAmounts(line, 1);
  const two = refundLineAmounts({ ...line, refundedQty: 1, refundedTzs: one.amountTzs, refundedVatTzs: one.vatTzs }, 1);
  const three = refundLineAmounts({ ...line, refundedQty: 2, refundedTzs: one.amountTzs + two.amountTzs, refundedVatTzs: one.vatTzs + two.vatTzs }, 1);
  assert.deepEqual([one.amountTzs, two.amountTzs, three.amountTzs], [3_333, 3_333, 3_334]);
  assert.deepEqual([one.vatTzs, two.vatTzs, three.vatTzs], [508, 508, 509], 'VAT by the same rule; a full refund reverses it exactly');
  assert.equal(refundLineAmounts(line, 3).amountTzs, 10_000, 'everything at once = lineNet');
  // The worked check (§1 M-2): lineNet 100, Q 3: A 2 → 66; B 1 → 34; undo A; C 2 → 66; active total 100.
  const A = cumulativeShare({ total: 100, Q: 3, a: 0, A: 0, q: 2 });
  const B = cumulativeShare({ total: 100, Q: 3, a: 2, A, q: 1 });
  const C = cumulativeShare({ total: 100, Q: 3, a: 1, A: B, q: 2 });
  assert.deepEqual([A, B, C, B + C], [66, 34, 66, 100]);
  // Never above what is left, never below 0: a strange history (more given back than the floor) still stops at lineNet.
  assert.equal(cumulativeShare({ total: 100, Q: 3, a: 1, A: 90, q: 1 }), 0);
  assert.equal(cumulativeShare({ total: 0, Q: 1, a: 0, A: 0, q: 1 }), 0, 'zero-net line');
  assert.deepEqual(splitRefund(30_000, { kind: 'credit', balanceTzs: 50_000 }), { balanceReducedTzs: 30_000, paidOutTzs: 0 });
  assert.deepEqual(splitRefund(40_000, { kind: 'credit', balanceTzs: 20_000 }), { balanceReducedTzs: 20_000, paidOutTzs: 20_000 });
  assert.deepEqual(splitRefund(40_000, { kind: 'cash', balanceTzs: 0 }), { balanceReducedTzs: 0, paidOutTzs: 40_000 });
  assert.deepEqual(refundMethod({ method: 'mpesa', reference: null }, 0), { method: null, reference: null }, 'nothing paid back → method ignored');
  assert.deepEqual(refundMethod({ method: null }, 1), { error: 'method_required', status: 400 });
  assert.equal(refundMethod({ method: 'cheque' }, 1).error, 'invalid_method');
  assert.deepEqual(refundMethod({ method: 'mpesa', reference: null }, 1), { error: 'reference_required', status: 400, method: 'mpesa' });
  assert.deepEqual(refundMethod({ method: 'card', reference: null }, 1), { method: 'card', reference: null });
  assert.deepEqual(refundMethod({ method: 'cash', reference: 'ignored' }, 1), { method: 'cash', reference: null });
  assert.deepEqual(refundMethod({ method: 'bank', reference: 'x'.repeat(101) }, 1), { error: 'reference_too_long', status: 400, max: 100 });
  assert.equal(creditNoteNumber(4), 'CN-000004');
  assert.equal(refundStateOf([{ qty: 2, refundedQty: 0 }]), 'none');
  assert.equal(refundStateOf([{ qty: 2, refundedQty: 1 }, { qty: 1, refundedQty: 1 }]), 'partial');
  assert.equal(refundStateOf([{ qty: 2, refundedQty: 2 }]), 'full');
  assert.equal(parseRefund({ clientRef: 'r'.repeat(10), lines: [{ saleLineId: 'a', qty: 1 }], reason: 'ok!' }).lines[0].restock, true, 'restock defaults to true');
  assert.equal(refundFingerprint('s1', { lines: [{ saleLineId: 'a', qty: 1 }, { saleLineId: 'b', qty: 2 }], reason: ' x y ' }),
    refundFingerprint('s1', { lines: [{ saleLineId: 'b', qty: 2 }, { saleLineId: 'a', qty: 1, restock: true }], reason: 'x y' }), 'order and defaults do not change the fingerprint');
  assert.notEqual(refundFingerprint('s1', { lines: [] }), refundFingerprint('s2', { lines: [] }), 'another sale is another request');
});

// ── gating and access ────────────────────────────────────────────────────────

test('flags off: every refund route answers 404 feature_disabled and nothing moves; one refund already made stays readable (detail, credit note) with walk-in sales; options.refunds', async () => {
  const v = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 5 });
  on(['VENDOR_TOOLS', 'VENDOR_WALKIN_SALES']);
  const sale = await sell(as(v), [{ productId: p.id, qty: 2 }], cash(2_000));
  for (const f of FLAGS) delete process.env[f];
  const routes = [
    [vendorRefundSale, { params: { id: sale.id }, body: body([{ saleLineId: sale.lines[0].id, qty: 1 }]) }],
    [vendorRevertRefund, { params: { id: 'vrf_x' }, body: { reason: 'nope nope' } }],
    [vendorListRefunds, {}], [vendorGetRefund, { params: { id: 'vrf_x' } }],
    [vendorShareRefund, { params: { id: 'vrf_x' }, body: {} }],
  ];
  for (const [route, opts] of routes) assert.deepEqual(await call(route, as(v), opts), { status: 404, body: { error: 'feature_disabled' } }, route.path);
  // VENDOR_REFUNDS without walk-in sales, or without the umbrella: still off.
  for (const set of [['VENDOR_TOOLS', 'VENDOR_REFUNDS'], ['VENDOR_WALKIN_SALES', 'VENDOR_REFUNDS']]) {
    on(set);
    assert.equal((await refund(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }]))).status, 404, set.join('+'));
    for (const f of FLAGS) delete process.env[f];
  }
  assert.equal((await row(p.id)).stock, 3);
  assert.equal(await db('VendorSaleRefund').where({ vendorId: v }).count('* as n').first().then(r => Number(r.n)), 0);
  on(['VENDOR_TOOLS', 'VENDOR_WALKIN_SALES', 'VENDOR_REFUNDS']);
  assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.refunds, true);
  const made1 = await refundOk(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }]));
  // VENDOR_REFUNDS goes off: the sale still shows its refunds; the refund detail and its credit note stay (read-only,
  // AC-2); the list and every write are off (security review #318 L1).
  process.env.VENDOR_DOCUMENTS = '1';
  delete process.env.VENDOR_REFUNDS;
  assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.refunds, false);
  const s = await getSale(v, sale.id);
  assert.deepEqual([s.refundedTzs, s.netAfterRefundsTzs, s.refundState, s.refunds.map(r => r.number)], [1_000, 1_000, 'partial', ['CN-000001']]);
  assert.equal((await call(vendorGetRefund, as(v), { params: { id: made1.refund.id } })).status, 200);
  assert.deepEqual(await call(vendorListRefunds, as(v)), { status: 404, body: { error: 'feature_disabled' } });
  assert.equal((await call(vendorDocumentView, as(v), { params: { docType: 'credit_note', docId: made1.refund.id } })).body.doc.number, 'CN-000001');
  assert.equal((await undo(as(v), made1.refund.id)).status, 404);
  assert.equal((await refund(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }]))).status, 404);
  delete process.env.VENDOR_WALKIN_SALES;
  assert.equal((await call(vendorGetRefund, as(v), { params: { id: made1.refund.id } })).status, 404, 'reads need walk-in sales');
  assert.deepEqual(await call(vendorDocumentView, as(v), { params: { docType: 'credit_note', docId: made1.refund.id } }), { status: 404, body: { error: 'feature_disabled' } }, 'credit notes need walk-in sales');
  assert.equal((await call(vendorDocumentView, as(v), { params: { docType: 'sale', docId: sale.id } })).status, 200, 'other documents unaffected');
});

test('access: staff without `sales` 403; staff of a suspended vendor 403 vendor_suspended; tenancy (another vendor 404 everywhere); mounted routes reach their own guards', async () => {
  on();
  const v = await vendor();
  const other = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 5 });
  const sale = await sell(as(v), [{ productId: p.id, qty: 2 }], cash(2_000));
  const r = await refundOk(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }]));
  const ordersOnly = await staff(v, ['orders']);
  assert.deepEqual(await refund(staffOf(ordersOnly, v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }])), { status: 403, body: { error: 'vendor_permission_forbidden', requiredPermission: 'sales' } });
  assert.equal((await call(vendorGetRefund, staffOf(ordersOnly, v), { params: { id: r.refund.id } })).status, 403);
  const suspendedVendor = await vendor({ accountStatus: 'suspended' });
  const pausedStaff = await staff(suspendedVendor, ['sales']);
  assert.deepEqual(await call(vendorListRefunds, staffOf(pausedStaff, suspendedVendor)), { status: 403, body: { error: 'vendor_suspended' } });

  assert.deepEqual(await refund(as(other), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }])), { status: 404, body: { error: 'sale_not_found' } });
  assert.deepEqual(await call(vendorGetRefund, as(other), { params: { id: r.refund.id } }), { status: 404, body: { error: 'refund_not_found' } });
  assert.deepEqual(await undo(as(other), r.refund.id), { status: 404, body: { error: 'refund_not_found' } });
  assert.deepEqual((await call(vendorListRefunds, as(other))).body.refunds, []);
  assert.deepEqual(await call(vendorDocumentView, as(other), { params: { docType: 'credit_note', docId: r.refund.id } }), { status: 404, body: { error: 'refund_not_found' } });
  assert.equal((await row(p.id)).stock, 4, 'refused calls moved nothing');

  // Mounted the way bfast-function mounts them: GET /vendor/refunds's guard must not block its sub-paths, and back.
  const seller = await staff(v, ['sales']);
  const sale2 = await sell(staffOf(seller, v), [{ productId: p.id, qty: 1 }], cash(1_000));
  const viaHttp = await hit('POST', `/vendor/sales/${sale2.id}/refunds`, staffOf(seller, v), body([{ saleLineId: sale2.lines[0].id, qty: 1 }]));
  assert.equal(viaHttp.status, 201, JSON.stringify(viaHttp.body));
  assert.equal((await hit('GET', '/vendor/refunds', staffOf(seller, v))).status, 200);
  assert.equal((await hit('GET', `/vendor/refunds/${viaHttp.body.refund.id}`, staffOf(seller, v))).body.refund.number, viaHttp.body.refund.number);
  assert.equal((await hit('POST', `/vendor/refunds/${viaHttp.body.refund.id}/revert`, staffOf(seller, v), { reason: 'wrong sale' })).status, 200);
  assert.equal((await hit('GET', `/vendor/sales/${sale2.id}`, staffOf(seller, v))).body.sale.refunds[0].status, 'reverted');
});

test('who may refund and undo (Q-1, M2): vendor and admin staff any; other staff their own sale on its EAT day, their own refund on its day; staff actions notify the vendor account in EN/SW', async () => {
  await awayFromEatMidnight();
  on();
  const v = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 50 });
  const juma = await staff(v, ['sales']);
  const asha = await staff(v, ['sales'], { displayName: 'Asha Seller' });
  const neema = await staff(v, ['sales'], { vendorRole: 'admin', displayName: 'Admin Neema' });
  const one = (claims, extra = {}) => sell(claims, [{ productId: p.id, qty: 3 }], cash(3_000), extra);
  const lineBody = (sale, qty = 1) => body([{ saleLineId: sale.lines[0].id, qty }]);
  const jumas = await one(staffOf(juma, v));
  const owners = await one(as(v));
  const old = await one(staffOf(juma, v), { soldAt: new Date(Date.now() - 2 * 86_400_000).toISOString() });
  assert.deepEqual(await refund(staffOf(asha, v), jumas.id, lineBody(jumas)), { status: 403, body: { error: 'refund_not_allowed', reason: 'not_own' } });
  assert.deepEqual(await refund(staffOf(juma, v), owners.id, lineBody(owners)), { status: 403, body: { error: 'refund_not_allowed', reason: 'not_own' } });
  assert.deepEqual(await refund(staffOf(juma, v), old.id, lineBody(old)), { status: 403, body: { error: 'refund_not_allowed', reason: 'too_old' } });
  const alerts = type => db('MarketplaceNotification').where({ userId: v, type });
  assert.equal((await alerts('vendor_sale_refunded')).length, 0);

  const own = await refundOk(staffOf(juma, v), jumas.id, lineBody(jumas));
  const byAdmin = await refundOk(staffOf(neema, v), old.id, lineBody(old));
  const byOwner = await refundOk(as(v), owners.id, lineBody(owners));
  assert.equal((await alerts('vendor_sale_refunded')).length, 2, 'one per staff refund; none for the vendor account');
  const data = (await alerts('vendor_sale_refunded')).map(a => (typeof a.data === 'string' ? JSON.parse(a.data) : a.data));
  assert.deepEqual(data.map(d => d.number).sort(), [own.refund.number, byAdmin.refund.number].sort());
  assert.ok(data.every(d => d.saleId && d.refundId && d.saleNumber && d.amountTzs === 1_000 && d.reason === 'Customer returned it' && d.createdByName));

  // Undo: own refund on its day; not another's; not one made yesterday; admin and owner any.
  assert.deepEqual(await undo(staffOf(asha, v), own.refund.id), { status: 403, body: { error: 'revert_not_allowed', reason: 'not_own' } });
  const second = await refundOk(staffOf(juma, v), jumas.id, lineBody(jumas));
  await db('VendorSaleRefund').where({ id: second.refund.id }).update({ createdAt: new Date(Date.now() - 86_400_000) });
  assert.deepEqual(await undo(staffOf(juma, v), second.refund.id), { status: 403, body: { error: 'revert_not_allowed', reason: 'too_old' } });
  assert.equal((await undo(staffOf(juma, v), own.refund.id)).status, 200);
  assert.equal((await undo(staffOf(neema, v), second.refund.id)).status, 200);
  assert.equal((await undo(as(v), byAdmin.refund.id)).status, 200);
  assert.equal((await alerts('vendor_refund_reverted')).length, 2, 'staff undos only');
  const undone = (await alerts('vendor_refund_reverted')).map(a => (typeof a.data === 'string' ? JSON.parse(a.data) : a.data));
  assert.ok(undone.every(d => d.refundId && d.number && d.reason === 'Refunded by mistake' && d.revertedByName));
  // Audit rows, in the refund's transaction.
  const audit = await db('AuditLog').where({ target: own.refund.id }).orderBy('at');
  assert.deepEqual(audit.map(a => a.action), ['vendor_sale_refunded', 'vendor_sale_refund_reverted']);
  const after0 = typeof audit[0].after === 'string' ? JSON.parse(audit[0].after) : audit[0].after;
  assert.deepEqual([after0.number, after0.amountTzs, after0.paidOutTzs, after0.method, after0.lines[0].restock, after0.vendorId], [own.refund.number, 1_000, 1_000, 'cash', true, v]);
  assert.ok(byOwner.refund.id);

  // The messages, in the person's language (Swahili when none is set). Drafts for native review.
  const texts = [];
  const notifier = createPartnerNotifier({ users, gyms, notify: async (_id, m) => { texts.push(m); }, preferences: { findByIdAsync: async id => (id === 'en_user' ? { locale: 'en' } : null) } });
  const d = { saleId: 's', refundId: 'r', number: 'CN-000004', saleNumber: 'R-000123', amountTzs: 6_666, createdByName: 'Juma', revertedByName: 'Juma', reason: 'Faulty' };
  await notifier.vendorEvent('en_user', 'vendor_sale_refunded', d);
  await notifier.vendorEvent('sw_user', 'vendor_sale_refunded', d);
  await notifier.vendorEvent('en_user', 'vendor_refund_reverted', d);
  await notifier.vendorEvent('sw_user', 'vendor_refund_reverted', { ...d, revertedByName: null });
  assert.equal(texts[0].title, 'Refund CN-000004 on sale R-000123');
  assert.match(texts[0].body, /^Juma refunded TSh 6,666 on sale R-000123\. Reason: Faulty$/);
  assert.equal(texts[1].title, 'Marejesho CN-000004 kwenye mauzo R-000123');
  assert.match(texts[1].body, /^Juma amefanya marejesho ya TSh 6,666 kwenye mauzo R-000123\. Sababu: Faulty$/);
  assert.equal(texts[2].title, 'Refund CN-000004 undone');
  assert.match(texts[3].body, /^Mfanyakazi ametendua marejesho CN-000004 \(TSh 6,666\)\. Sababu: Faulty$/);
  assert.deepEqual([texts[0].type, texts[0].data.refundId, texts[2].type], ['vendor_sale_refunded', 'r', 'vendor_refund_reverted']);
});

// ── validation ───────────────────────────────────────────────────────────────

test('validation: every 400 (shape, line_not_on_sale, duplicate_line, reason, method, reference, restock_unavailable), checked before anything moves', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 20 });
  const gone = await product(v, { name: 'Gone', priceTzs: 2_000, stock: 5 });
  const sale = await sell(as(v), [{ productId: p.id, qty: 2 }, { productId: gone.id, qty: 1 }], cash(4_000));
  const [l1, l2] = sale.lines;
  const other = await sell(as(v), [{ productId: p.id, qty: 1 }], cash(1_000));
  const cases = [
    [{ ...body([{ saleLineId: l1.id, qty: 1 }]), clientRef: 'short' }, { error: 'invalid_client_ref' }],
    [body([]), { error: 'lines_required' }],
    [body(Array.from({ length: 101 }, (_, i) => ({ saleLineId: `x${i}`, qty: 1 }))), { error: 'too_many_lines', max: 100 }],
    [body([{ qty: 1 }]), { error: 'invalid_line', index: 0, field: 'saleLineId' }],
    [body([{ saleLineId: l1.id, qty: 0 }]), { error: 'invalid_quantity', index: 0, max: 1000 }],
    [body([{ saleLineId: l1.id, qty: 1.5 }]), { error: 'invalid_quantity', index: 0, max: 1000 }],
    [body([{ saleLineId: l1.id, qty: 1, restock: 'yes' }]), { error: 'invalid_line', index: 0, field: 'restock' }],
    [body([{ saleLineId: l1.id, qty: 1 }, { saleLineId: l1.id, qty: 1 }]), { error: 'duplicate_line', saleLineId: l1.id }],
    [body([{ saleLineId: l1.id, qty: 1 }], { reason: ' a ' }), { error: 'reason_required', min: 3 }],
    [body([{ saleLineId: l1.id, qty: 1 }], { reason: 'y'.repeat(201) }), { error: 'reason_too_long', max: 200 }],
    [body([{ saleLineId: l1.id, qty: 1 }], { method: 5 }), { error: 'invalid_method', allowed: ['cash', 'mpesa', 'airtel_money', 'mixx', 'halopesa', 'card', 'bank', 'other'] }],
    [body([{ saleLineId: other.lines[0].id, qty: 1 }]), { error: 'line_not_on_sale', saleLineId: other.lines[0].id }],
    [body([{ saleLineId: l1.id, qty: 1 }], { method: undefined }), { error: 'method_required' }],
    [body([{ saleLineId: l1.id, qty: 1 }], { method: 'cheque' }), { error: 'invalid_method', allowed: ['cash', 'mpesa', 'airtel_money', 'mixx', 'halopesa', 'card', 'bank', 'other'] }],
    [body([{ saleLineId: l1.id, qty: 1 }], { method: 'mpesa' }), { error: 'reference_required', method: 'mpesa' }],
    [body([{ saleLineId: l1.id, qty: 1 }], { method: 'bank', reference: 'r'.repeat(101) }), { error: 'reference_too_long', max: 100 }],
  ];
  for (const [b, expected] of cases) {
    const out = await refund(as(v), sale.id, b);
    assert.deepEqual(out, { status: 400, body: expected }, JSON.stringify(expected));
  }
  assert.deepEqual(await refund(as(v), 'sal_missing', body([{ saleLineId: l1.id, qty: 1 }])), { status: 404, body: { error: 'sale_not_found' } });
  // M-7: a deleted product cannot take units back; with restock off the refund goes through.
  await db('Product').where({ id: gone.id }).update({ deletedAt: new Date() });
  assert.deepEqual(await refund(as(v), sale.id, body([{ saleLineId: l1.id, qty: 1 }, { saleLineId: l2.id, qty: 1 }])), { status: 400, body: { error: 'restock_unavailable', saleLineId: l2.id, productId: gone.id } });
  assert.equal((await row(p.id)).stock, 17, 'nothing moved for the other line either');
  assert.equal(await db('VendorDocumentSequence').where({ vendorId: v, docType: 'credit_note' }).first(), undefined, 'no CN number used');
  const ok = await refundOk(as(v), sale.id, body([{ saleLineId: l1.id, qty: 1 }, { saleLineId: l2.id, qty: 1, restock: false }]));
  assert.deepEqual([ok.refund.number, ok.refund.amountTzs, (await row(p.id)).stock, (await row(gone.id)).stock], ['CN-000001', 3_000, 18, 4], 'the deleted product\'s unit stays out');
  // M-6: a reference with cash is dropped; mobile money keeps its reference.
  const mp = await refundOk(as(v), sale.id, body([{ saleLineId: l1.id, qty: 1 }], { method: 'mpesa', reference: ' QK12AB34 ' }));
  assert.deepEqual([mp.refund.method, mp.refund.reference, mp.refund.paidOutTzs], ['mpesa', 'QK12AB34', 1_000]);
});

// ── money ────────────────────────────────────────────────────────────────────

test('rounding end to end (AC-6, AC-7): 3,333 / 3,333 / 3,334 add up to the line; everything left with a sale discount = the sale total; sale view fields; refunding beyond what is left → 409 with fresh numbers, nothing written', async () => {
  on();
  const v = await vendor();
  const a = await product(v, { name: 'Bar', priceTzs: 3_500, stock: 30 });
  const b = await product(v, { name: 'Shaker', priceTzs: 5_000, stock: 30 });
  const sale = await sell(as(v), [{ productId: a.id, qty: 3, discountTzs: 500 }, { productId: b.id, qty: 2 }], cash(20_000));
  const [la, lb] = sale.lines;
  assert.deepEqual([sale.refundedTzs, sale.refundableTzs, sale.netAfterRefundsTzs, sale.refundState, sale.refunds, la.lineNetTzs, la.refundableQty], [0, 20_000, 20_000, 'none', [], 10_000, 3]);
  const r1 = await refundOk(as(v), sale.id, body([{ saleLineId: la.id, qty: 1 }]));
  assert.deepEqual([r1.refund.amountTzs, r1.refund.paidOutTzs, r1.refund.balanceReducedTzs, r1.refund.status, r1.refund.saleNumber, r1.refund.saleKind], [3_333, 3_333, 0, 'active', sale.number, 'cash']);
  assert.deepEqual(r1.refund.lines.map(l => [l.saleLineId, l.qty, l.amountTzs, l.restock, l.nameSnapshot, l.unitPriceTzs]), [[la.id, 1, 3_333, true, 'Bar', 3_500]]);
  assert.equal('unitCostTzs' in r1.refund.lines[0] || 'fingerprint' in r1.refund, false, 'never cost or internals');
  const s1 = r1.sale;
  assert.deepEqual([s1.refundedTzs, s1.refundableTzs, s1.netAfterRefundsTzs, s1.refundState, s1.refunds.length], [3_333, 16_667, 16_667, 'partial', 1]);
  assert.deepEqual([lineOf(s1, a.id).refundedQty, lineOf(s1, a.id).refundableQty, lineOf(s1, a.id).refundedTzs], [1, 2, 3_333]);
  const r2 = await refundOk(as(v), sale.id, body([{ saleLineId: la.id, qty: 1 }]));
  assert.equal(r2.refund.amountTzs, 3_333);
  const tooMany = await refund(as(v), sale.id, body([{ saleLineId: la.id, qty: 2 }, { saleLineId: lb.id, qty: 2 }]));
  assert.deepEqual(tooMany, { status: 409, body: { error: 'refund_exceeds_sold', lines: [{ saleLineId: la.id, soldQty: 3, refundedQty: 2, refundableQty: 1 }] } });
  assert.equal((await row(a.id)).stock, 29, 'the refused refund moved nothing');
  const r3 = await refundOk(as(v), sale.id, body([{ saleLineId: la.id, qty: 1 }, { saleLineId: lb.id, qty: 2 }]));
  assert.deepEqual(r3.refund.lines.map(l => l.amountTzs), [3_334, 10_000]);
  assert.equal(r1.refund.amountTzs + r2.refund.amountTzs + r3.refund.amountTzs, sale.totalTzs);
  assert.deepEqual([r3.sale.refundState, r3.sale.refundableTzs, r3.sale.netAfterRefundsTzs], ['full', 0, 0]);
  assert.deepEqual(r3.sale.refunds.map(r => r.number), ['CN-000001', 'CN-000002', 'CN-000003']);
  assert.deepEqual([(await row(a.id)).stock, (await row(b.id)).stock], [30, 30]);
  await assertAddsUp(sale.id);
  assert.equal((await refund(as(v), sale.id, body([{ saleLineId: lb.id, qty: 1 }]))).body.error, 'refund_exceeds_sold');

  // A sale-level discount: Σ credit notes = the sale's totalTzs exactly.
  const disc = await sell(as(v), [{ productId: a.id, qty: 3 }, { productId: b.id, qty: 1 }], cash(14_499), { discountTzs: 1_001 });
  assert.equal(disc.totalTzs, 14_499);
  const [da, db2] = disc.lines;
  assert.deepEqual([da.lineNetTzs, db2.lineNetTzs], [9_822, 4_677], 'the sale discount share comes off each line');
  const d1 = await refundOk(as(v), disc.id, body([{ saleLineId: da.id, qty: 1 }]));
  const d2 = await refundOk(as(v), disc.id, body([{ saleLineId: da.id, qty: 2 }, { saleLineId: db2.id, qty: 1 }]));
  assert.deepEqual([d1.refund.amountTzs, d2.refund.amountTzs, d1.refund.amountTzs + d2.refund.amountTzs], [3_274, 11_225, 14_499]);
  await assertAddsUp(disc.id);

  // The DB CHECKs are the last defence against a forced over-refund.
  await assert.rejects(db('VendorSaleLine').where({ id: la.id }).update({ refundedQty: 4 }), /vendorsaleline_refunded_qty_range/);
  await assert.rejects(db('VendorSaleLine').where({ id: la.id }).update({ refundedTzs: 10_001 }), /vendorsaleline_refunded_tzs_range/);
  await assert.rejects(db('VendorSale').where({ id: sale.id }).update({ refundedTzs: 20_001 }), /vendorsale_refunded_range/);
  await assert.rejects(db('VendorSale').where({ id: sale.id }).update({ balanceReducedTzs: 1 }), /vendorsale_(paid_adds_up|cash_no_balance_reduced)/);

  // List rows and the summary (refunds by refund date; money paid back by method).
  const list = await call(vendorListSales, as(v));
  const lrow = list.body.sales.find(s => s.id === sale.id);
  assert.deepEqual([lrow.refundedTzs, lrow.refundState], [20_000, 'full']);
  assert.deepEqual([list.body.summary.refundCount, list.body.summary.refundTzs, list.body.summary.netTzs, list.body.summary.refundsByMethod],
    [5, 34_499, 34_499 - 34_499, [{ method: 'cash', amountTzs: 34_499 }]]);
  assert.equal(list.body.summary.totalTzs, 34_499, 'byMethod / totalTzs stay money received');
});

test('undo in the middle never exceeds the line (worked check); zero-amount refunds need no method and still restock; an undo reverses exactly', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { name: 'Gel', priceTzs: 34, stock: 10 });
  const sale = await sell(as(v), [{ productId: p.id, qty: 3, discountTzs: 2 }], cash(100));
  const l = sale.lines[0];
  const A = await refundOk(as(v), sale.id, body([{ saleLineId: l.id, qty: 2 }]));
  const B = await refundOk(as(v), sale.id, body([{ saleLineId: l.id, qty: 1 }]));
  assert.deepEqual([A.refund.amountTzs, B.refund.amountTzs], [66, 34]);
  assert.equal((await row(p.id)).stock, 10);
  const undone = await undo(as(v), A.refund.id);
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.deepEqual([undone.body.refund.status, undone.body.refund.revertReason, undone.body.refund.revertedBy.id, undone.body.refund.number], ['reverted', 'Refunded by mistake', v, A.refund.number]);
  assert.deepEqual([undone.body.sale.refundedTzs, lineOf(undone.body.sale, p.id).refundedQty, undone.body.sale.refundState], [34, 1, 'partial']);
  assert.equal((await row(p.id)).stock, 8, 'the two restocked units left stock again');
  const C = await refundOk(as(v), sale.id, body([{ saleLineId: l.id, qty: 2 }]));
  assert.equal(C.refund.amountTzs, 66);
  const s = await assertAddsUp(sale.id);
  assert.equal(s.refundedTzs, 100);
  assert.deepEqual(C.sale.refunds.map(r => [r.number, r.status, r.amountTzs]), [['CN-000001', 'reverted', 66], ['CN-000002', 'active', 34], ['CN-000003', 'active', 66]]);
  assert.deepEqual(await undo(as(v), A.refund.id), { status: 409, body: { error: 'already_reverted', revertedAt: undone.body.refund.revertedAt } });
  assert.equal((await ledger(p.id, ['refund_revert'])).length, 1, 'no second ledger row for a second undo');

  // M-9: a free item comes back: TSh 0, no method needed, stock still moves.
  const free = await product(v, { name: 'Sample', priceTzs: 1_000, stock: 4 });
  const zero = await sell(as(v), [{ productId: free.id, qty: 1, discountTzs: 1_000 }], []);
  const z = await refundOk(as(v), zero.id, { clientRef: randomUUID(), reason: 'Sample back', lines: [{ saleLineId: zero.lines[0].id, qty: 1 }] });
  assert.deepEqual([z.refund.amountTzs, z.refund.method, z.refund.paidOutTzs, (await row(free.id)).stock], [0, null, 0, 4]);
});

test('VAT (M-3): cumulative per line, a full refund reverses exactly the line\'s VAT, grouped by the sale line\'s snapshot code and rate', async () => {
  on();
  const v = await vendor();
  const a = await product(v, { name: 'Bar', priceTzs: 3_500, stock: 10 });
  const e = await product(v, { name: 'Book', priceTzs: 2_000, stock: 10 });
  const sale = await sell(as(v), [{ productId: a.id, qty: 3, discountTzs: 500 }, { productId: e.id, qty: 1 }], cash(12_000));
  // The VAT snapshot as S5 writes it on a VAT-verified vendor's sale (A 18%: 10,000 × 18/118 = 1,525; E exempt).
  await db('VendorSaleLine').where({ id: sale.lines[0].id }).update({ vatCode: 'A', vatRatePct: 18, vatTzs: 1_525 });
  await db('VendorSaleLine').where({ id: sale.lines[1].id }).update({ vatCode: 'E', vatRatePct: 0, vatTzs: 0 });
  const r1 = await refundOk(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }]));
  const r2 = await refundOk(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 2 }, { saleLineId: sale.lines[1].id, qty: 1 }]));
  assert.deepEqual([r1.refund.vatTzs, r2.refund.vatTzs, r1.refund.vatTzs + r2.refund.vatTzs], [508, 1_017, 1_525]);
  // netTzs = before VAT (the S5 VAT summary): 3,333 − 508.
  assert.deepEqual(r1.refund.vatSummary, [{ code: 'A', ratePct: 18, netTzs: 2_825, vatTzs: 508 }]);
  assert.deepEqual(r2.refund.vatSummary.map(x => [x.code, x.netTzs, x.vatTzs]), [['A', 5_650, 1_017], ['E', 2_000, 0]]);
  assert.deepEqual(r2.refund.lines.map(l => l.vatCode), ['A', 'E']);
  const line = await db('VendorSaleLine').where({ id: sale.lines[0].id }).first();
  assert.deepEqual([line.refundedVatTzs, line.vatTzs], [1_525, 1_525]);
  await assert.rejects(db('VendorSaleLine').where({ id: line.id }).update({ refundedVatTzs: 1_526 }), /vendorsaleline_refunded_vat_range/);
});

// ── credit sales ─────────────────────────────────────────────────────────────

test('credit sales (AC-16..19): the balance comes off first, then money back; the CHECK holds after refund, payment, payment void and undo in any order; owed, aging and the profile follow; customer_archived on undo', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { name: 'Plates', priceTzs: 10_000, stock: 40 });
  const c = await addCustomer(as(v), { name: 'Juma Mussa', phone: '0712345678' });
  const sale = await sell(as(v), [{ productId: p.id, qty: 10 }], cash(20_000), { kind: 'credit', customerId: c.id });
  assert.equal((await pay(as(v), c.id, { amountTzs: 30_000 })).status, 201);
  const pmt = (await db('VendorCustomerPayment').where({ vendorId: v, customerId: c.id }).first());
  assert.equal((await assertAddsUp(sale.id)).balanceTzs, 50_000);
  const l = sale.lines[0];
  // 30,000: all of it off the balance, nothing paid back, no method asked (a method sent is ignored).
  const r1 = await refundOk(as(v), sale.id, body([{ saleLineId: l.id, qty: 3 }], { method: 'mpesa' }));
  assert.deepEqual([r1.refund.amountTzs, r1.refund.balanceReducedTzs, r1.refund.paidOutTzs, r1.refund.method, r1.refund.reference], [30_000, 30_000, 0, null, null]);
  assert.deepEqual([r1.sale.balanceTzs, r1.sale.balanceReducedTzs, r1.refund.customer.name, r1.refund.saleInvoiceNumber], [20_000, 30_000, 'Juma Mussa', sale.invoiceNumber]);
  await assertAddsUp(sale.id);
  const profile = async () => (await call(vendorCustomerGet, as(v), { params: { id: c.id } })).body;
  const aging = async () => (await call(vendorReceivablesAging, as(v))).body;
  assert.deepEqual([(await profile()).customer.owedTzs, (await aging()).totals.owedTzs], [20_000, 20_000]);
  // 40,000: 20,000 off the balance (now 0), 20,000 paid back by the chosen method.
  const r2 = await refundOk(as(v), sale.id, body([{ saleLineId: l.id, qty: 4 }], { method: 'cash' }));
  assert.deepEqual([r2.refund.balanceReducedTzs, r2.refund.paidOutTzs, r2.refund.method, r2.sale.balanceTzs], [20_000, 20_000, 'cash', 0]);
  await assertAddsUp(sale.id);
  const prof = (await profile()).customer;
  assert.deepEqual([prof.owedTzs, prof.openSales.length, (await aging()).totals.owedTzs], [0, 0, 0], 'leaves Owed to you');
  assert.equal(prof.totals.shopSalesTzs, 30_000, 'shop sales after refunds');
  // A payment voided later reopens its part (S4), the refunds stay; then undo both refunds.
  assert.equal((await call(vendorCustomerVoidPayment, as(v), { params: { id: c.id, paymentId: pmt.id }, body: { reason: 'bounced payment' } })).status, 200);
  assert.equal((await assertAddsUp(sale.id)).balanceTzs, 30_000);
  const u2 = await undo(as(v), r2.refund.id);
  assert.equal(u2.status, 200, JSON.stringify(u2.body));
  assert.deepEqual([u2.body.sale.balanceTzs, u2.body.sale.balanceReducedTzs], [50_000, 30_000]);
  await assertAddsUp(sale.id);
  assert.equal((await undo(as(v), r1.refund.id)).body.sale.balanceTzs, 80_000);
  const s = await assertAddsUp(sale.id);
  assert.deepEqual([s.balanceReducedTzs, s.refundedTzs, (await profile()).customer.owedTzs], [0, 0, 80_000]);

  // Archived customer: a refund can bring the balance to 0 and allow archiving; undo then refuses.
  const c2 = await addCustomer(as(v), { name: 'Neema' });
  const small = await sell(as(v), [{ productId: p.id, qty: 2 }], [], { kind: 'credit', customerId: c2.id });
  const all = await refundOk(as(v), small.id, body([{ saleLineId: small.lines[0].id, qty: 2 }]));
  assert.equal(all.sale.balanceTzs, 0);
  const archived = await call(vendorCustomerUpdate, as(v), { params: { id: c2.id }, body: { archived: true } });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(await undo(as(v), all.refund.id), { status: 409, body: { error: 'customer_archived', customerId: c2.id } });
  assert.equal((await db('VendorSaleRefund').where({ id: all.refund.id }).first()).status, 'active', 'nothing changed');
});

// ── concurrency ──────────────────────────────────────────────────────────────

test('concurrency: two refunds of the last unit (one 409 with fresh numbers); refund vs void (one wins); refund vs customer payment (serialised); identical requests at once → one refund', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 50 });
  const sale = await sell(as(v), [{ productId: p.id, qty: 2 }], cash(2_000));
  await refundOk(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }]));
  const race = await Promise.all([1, 2].map(() => refund(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }]))));
  assert.deepEqual(race.map(r => r.status).sort(), [201, 409]);
  assert.deepEqual(race.find(r => r.status === 409).body, { error: 'refund_exceeds_sold', lines: [{ saleLineId: sale.lines[0].id, soldQty: 2, refundedQty: 2, refundableQty: 0 }] });
  await assertAddsUp(sale.id);
  assert.equal((await row(p.id)).stock, 50);

  const s2 = await sell(as(v), [{ productId: p.id, qty: 2 }], cash(2_000));
  const rv = await Promise.all([
    refund(as(v), s2.id, body([{ saleLineId: s2.lines[0].id, qty: 1 }])),
    call(vendorVoidSale, as(v), { params: { id: s2.id }, body: { reason: 'rang up twice' } }),
  ]);
  const [rOut, vOut] = rv;
  if (rOut.status === 201) assert.deepEqual([vOut.status, vOut.body.error, vOut.body.refunds.map(x => x.id)], [409, 'has_refunds', [rOut.body.refund.id]]);
  else assert.deepEqual([rOut.status, rOut.body.error, vOut.status], [409, 'sale_voided', 200]);
  assert.equal((await row(p.id)).stock, rOut.status === 201 ? 49 : 50, 'stock counted once either way');

  // Identical requests at once (a retry racing the first): one refund, one number, one ledger row.
  const s3 = await sell(as(v), [{ productId: p.id, qty: 3 }], cash(3_000));
  const same = body([{ saleLineId: s3.lines[0].id, qty: 1 }]);
  const twins = await Promise.all([refund(as(v), s3.id, same), refund(as(v), s3.id, same)]);
  assert.deepEqual(twins.map(t => t.status).sort(), [200, 201]);
  assert.equal(twins[0].body.refund.id, twins[1].body.refund.id);
  assert.equal(await db('VendorSaleRefund').where({ saleId: s3.id }).count('* as n').first().then(r => Number(r.n)), 1);
  assert.equal((await db('ShopStockMovement').where({ sourceId: twins[0].body.refund.id })).length, 1);

  // Refund vs customer payment on one credit sale: serialised by the customer lock.
  const c = await addCustomer(as(v), { name: 'Race Customer' });
  const credit = await sell(as(v), [{ productId: p.id, qty: 5 }], [], { kind: 'credit', customerId: c.id });
  const both = await Promise.all([
    refund(as(v), credit.id, body([{ saleLineId: credit.lines[0].id, qty: 3 }], { method: 'cash' })),
    pay(as(v), c.id, { amountTzs: 3_000 }),
  ]);
  const [rf, pm] = both;
  assert.equal(rf.status, 201, JSON.stringify(rf.body));
  if (pm.status === 201) assert.deepEqual([rf.body.refund.balanceReducedTzs, rf.body.refund.paidOutTzs], [2_000, 1_000], 'payment first: the refund paid out the rest');
  else assert.deepEqual([pm.status, pm.body.error, pm.body.owedTzs], [409, 'overpayment', 2_000], 'refund first: the payment no longer fits');
  await assertAddsUp(credit.id);
});

test('undo vs a later sale of the same units: POS sale or app checkout first → 409 insufficient_stock, nothing changes, stock never negative; a race leaves one winner', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { name: 'Last One', priceTzs: 1_000, stock: 1 });
  const sale = await sell(as(v), [{ productId: p.id, qty: 1 }], cash(1_000));
  const r = await refundOk(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }]));
  assert.equal((await row(p.id)).stock, 1);
  await sell(as(v), [{ productId: p.id, qty: 1 }], cash(1_000));
  assert.deepEqual(await undo(as(v), r.refund.id), { status: 409, body: { error: 'insufficient_stock', productId: p.id, variant: null, available: 0 } });
  assert.deepEqual([(await row(p.id)).stock, (await db('VendorSaleRefund').where({ id: r.refund.id }).first()).status], [0, 'active']);

  // App checkout reserves the restocked unit first.
  const q = await product(v, { name: 'App Item', priceTzs: 2_000, stock: 1 });
  const s2 = await sell(as(v), [{ productId: q.id, qty: 1 }], cash(2_000));
  const r2 = await refundOk(as(v), s2.id, body([{ saleLineId: s2.lines[0].id, qty: 1 }]));
  const buyer = await user('member', { displayName: 'App Buyer' });
  const order = await call(createShopOrder, { sub: buyer, userType: 'member' }, { body: { items: [{ productId: q.id, qty: 1 }], deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni', paymentMethod: 'mpesa' } });
  if (order.body?.id) made.orders.push(order.body.id);
  assert.ok([200, 201, 202].includes(order.status), JSON.stringify(order.body));
  assert.equal((await undo(as(v), r2.refund.id)).body.error, 'insufficient_stock');
  assert.equal((await row(q.id)).stock, 0);

  // A race between an undo and a sale of the one unit: exactly one wins.
  const z = await product(v, { name: 'Race Item', priceTzs: 1_000, stock: 1 });
  const s3 = await sell(as(v), [{ productId: z.id, qty: 1 }], cash(1_000));
  const r3 = await refundOk(as(v), s3.id, body([{ saleLineId: s3.lines[0].id, qty: 1 }]));
  const [u, s] = await Promise.all([undo(as(v), r3.refund.id), call(vendorRecordSale, as(v), { body: { clientRef: randomUUID(), lines: [{ productId: z.id, qty: 1 }], payments: cash(1_000) } })]);
  assert.ok((u.status === 200 && s.status === 409) || (u.status === 409 && u.body.error === 'insufficient_stock' && s.status === 201), JSON.stringify([u, s]));
  assert.equal((await row(z.id)).stock, 0);
});

// ── idempotency, ledger, void, numbering ─────────────────────────────────────

test('idempotency and the ledger: replay 200 same refund; client_ref_reused; one refund_restock per (refund, product, variant); none when restock is off; variant_gone fallback; stock history links the credit note', async () => {
  on();
  const v = await vendor();
  const tee = await product(v, { name: 'Tee', priceTzs: 15_000, variants: [{ name: 'S', stock: 5 }, { name: 'M', stock: 5 }] });
  // Two lines of the same product + variant: one ledger row for the group.
  const sale = await sell(as(v), [{ productId: tee.id, variant: 'S', qty: 2 }, { productId: tee.id, variant: 'S', qty: 1 }, { productId: tee.id, variant: 'M', qty: 2 }], cash(75_000));
  const [s1, s2, m1] = sale.lines;
  const b = body([{ saleLineId: s1.id, qty: 2 }, { saleLineId: s2.id, qty: 1 }, { saleLineId: m1.id, qty: 1, restock: false }]);
  const first = await refundOk(as(v), sale.id, b);
  const again = await refund(as(v), sale.id, b);
  assert.deepEqual([again.status, again.body.refund.id, again.body.refund.number, again.headers['Idempotent-Replay']], [200, first.refund.id, first.refund.number, 'true']);
  assert.deepEqual(await refund(as(v), sale.id, { ...b, reason: 'Another reason' }), { status: 409, body: { error: 'client_ref_reused' } });
  const rows = await ledger(tee.id, ['refund_restock']);
  assert.deepEqual(rows.map(m => [m.variant, Number(m.delta), m.kind, m.sourceId, m.note]), [['S', 3, 'refund', first.refund.id, null]], 'one row for S; none for M (not restocked)');
  const t = await row(tee.id);
  assert.deepEqual([t.variants.map(x => x.stock), t.stock], [[5, 3], 8]);
  await assert.rejects(db('ShopStockMovement').insert({ ...rows[0], id: uid('stk') }), /shopstockmovement_source_unique/, 'the ledger refuses a second row');
  // Stock history: the row points at the refund and its CN number.
  on(['VENDOR_STOCK_LEDGER']);
  const history = await call(vendorStockMovements, as(v), { params: { id: tee.id }, query: { variant: 'S' } });
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.deepEqual(history.body.rows.find(r => r.reason === 'refund_restock').document, { type: 'refund', id: first.refund.id, number: first.refund.number });

  // The variant stops keeping its own count: the unit goes to the product's count (note variant_gone), and back on undo.
  await db('Product').where({ id: tee.id }).update({ variants: JSON.stringify([{ name: 'S' }, { name: 'M' }]) });
  const gone = await refundOk(as(v), sale.id, body([{ saleLineId: m1.id, qty: 1 }]));
  const g = await ledger(tee.id, ['refund_restock']);
  assert.deepEqual(g.filter(m => m.sourceId === gone.refund.id).map(m => [m.variant, Number(m.delta), m.note]), [['M', 1, 'variant_gone']]);
  assert.equal((await row(tee.id)).stock, 9);
  assert.equal((await undo(as(v), gone.refund.id)).status, 200);
  const back = (await ledger(tee.id, ['refund_revert'])).filter(m => m.sourceId === gone.refund.id);
  assert.deepEqual(back.map(m => [m.variant, Number(m.delta), m.kind, m.note]), [['M', -1, 'refund_revert', 'variant_gone']]);
  assert.equal((await row(tee.id)).stock, 8);
  const history2 = await call(vendorStockMovements, as(v), { params: { id: tee.id } });
  assert.equal(history2.status, 200, JSON.stringify(history2.body));
  const revertDoc = history2.body.rows.find(r => r.reason === 'refund_revert');
  assert.deepEqual(revertDoc.document, { type: 'refund', id: gone.refund.id, number: gone.refund.number });
});

test('void (Q-3): 409 has_refunds while refunds are active (whatever the flag); allowed after every refund is undone, giving the full sold quantity back once; after a void, no refund or undo', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 10 });
  const sale = await sell(as(v), [{ productId: p.id, qty: 4 }], cash(4_000));
  const r1 = await refundOk(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }]));
  const r2 = await refundOk(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }]));
  delete process.env.VENDOR_REFUNDS;
  assert.deepEqual(await call(vendorVoidSale, as(v), { params: { id: sale.id }, body: { reason: 'counted twice' } }),
    { status: 409, body: { error: 'has_refunds', refunds: [{ id: r1.refund.id, number: r1.refund.number }, { id: r2.refund.id, number: r2.refund.number }] } });
  on();
  await undo(as(v), r1.refund.id);
  assert.deepEqual((await call(vendorVoidSale, as(v), { params: { id: sale.id }, body: { reason: 'counted twice' } })).body.refunds, [{ id: r2.refund.id, number: r2.refund.number }], 'only active refunds block');
  await undo(as(v), r2.refund.id);
  assert.equal((await row(p.id)).stock, 6);
  const voided = await call(vendorVoidSale, as(v), { params: { id: sale.id }, body: { reason: 'counted twice' } });
  assert.equal(voided.status, 200, JSON.stringify(voided.body));
  assert.equal((await row(p.id)).stock, 10, 'the full sold quantity back, once');
  assert.deepEqual((await ledger(p.id, ['sale_void'])).map(m => Number(m.delta)), [4]);
  assert.deepEqual(await refund(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }])), { status: 409, body: { error: 'sale_voided', voidedAt: voided.body.sale.voidedAt } });
  // An undone refund of a voided sale cannot be undone again or redone.
  assert.equal((await undo(as(v), r1.refund.id)).body.error, 'already_reverted');
});

test('CN numbers (O-6, M-10): CN-000001… per vendor, gap-free under concurrency and after a refund refused mid-way; an undo keeps its number; another vendor starts at CN-000001', async () => {
  on();
  const v = await vendor();
  const other = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 100 });
  const q = await product(other, { priceTzs: 1_000, stock: 10 });
  const sales = [];
  for (let i = 0; i < 6; i += 1) sales.push(await sell(as(v), [{ productId: p.id, qty: 1 }], cash(1_000)));
  const parallel = await Promise.all(sales.slice(0, 5).map(s => refund(as(v), s.id, body([{ saleLineId: s.lines[0].id, qty: 1 }]))));
  assert.ok(parallel.every(r => r.status === 201), JSON.stringify(parallel.map(r => r.body)));
  assert.deepEqual(parallel.map(r => r.body.refund.number).sort(), ['CN-000001', 'CN-000002', 'CN-000003', 'CN-000004', 'CN-000005']);
  // Refused AFTER the number was issued (a forced impossible state trips a CHECK): the whole refund rolls back, number included.
  const last = sales[5];
  await db('VendorSale').where({ id: last.id }).update({ refundedTzs: last.totalTzs });
  await assert.rejects(refund(as(v), last.id, body([{ saleLineId: last.lines[0].id, qty: 1 }])), /vendorsale_refunded_range/);
  await db('VendorSale').where({ id: last.id }).update({ refundedTzs: 0 });
  assert.equal((await row(p.id)).stock, 99, 'the refused refund restocked nothing');
  const sixth = await refundOk(as(v), last.id, body([{ saleLineId: last.lines[0].id, qty: 1 }]));
  assert.equal(sixth.refund.number, 'CN-000006', 'no gap');
  await undo(as(v), sixth.refund.id);
  const extra = await sell(as(v), [{ productId: p.id, qty: 1 }], cash(1_000));
  assert.equal((await refundOk(as(v), extra.id, body([{ saleLineId: extra.lines[0].id, qty: 1 }]))).refund.number, 'CN-000007', 'an undo frees no number');
  const os = await sell(as(other), [{ productId: q.id, qty: 1 }], cash(1_000));
  assert.equal((await refundOk(as(other), os.id, body([{ saleLineId: os.lines[0].id, qty: 1 }]))).refund.number, 'CN-000001');
  // GET /vendor/refunds: newest first, filters, paging.
  const list = await call(vendorListRefunds, as(v), { query: { limit: '3' } });
  assert.deepEqual(list.body.refunds.slice(0, 2).map(r => r.number), ['CN-000007', 'CN-000006']);
  assert.ok(list.body.nextCursor);
  // The five parallel refunds' times are not in number order; together the pages hold each refund once.
  const page2 = await call(vendorListRefunds, as(v), { query: { limit: '3', cursor: list.body.nextCursor } });
  const page3 = await call(vendorListRefunds, as(v), { query: { limit: '3', cursor: page2.body.nextCursor } });
  assert.deepEqual([...list.body.refunds, ...page2.body.refunds, ...page3.body.refunds].map(r => r.number).sort(), ['CN-000001', 'CN-000002', 'CN-000003', 'CN-000004', 'CN-000005', 'CN-000006', 'CN-000007']);
  assert.equal(page3.body.nextCursor, null);
  assert.deepEqual((await call(vendorListRefunds, as(v), { query: { status: 'reverted' } })).body.refunds.map(r => r.number), ['CN-000006']);
  assert.deepEqual((await call(vendorListRefunds, as(v), { query: { saleId: last.id } })).body.refunds.map(r => [r.number, r.status, r.restockedUnits, r.saleNumber]), [['CN-000006', 'reverted', 1, last.number]]);
  assert.deepEqual(Object.keys(list.body.refunds[0]).sort(), ['amountTzs', 'balanceReducedTzs', 'createdBy', 'id', 'method', 'number', 'paidOutTzs', 'refundedAt', 'restockedUnits', 'revertedAt', 'saleId', 'saleNumber', 'status']);
  for (const [query, error] of [[{ status: 'x' }, 'invalid_status'], [{ from: '2026-13-01' }, 'invalid_date'], [{ limit: '0' }, 'invalid_limit'], [{ cursor: 'junk' }, 'invalid_cursor']]) {
    assert.equal((await call(vendorListRefunds, as(v), { query })).body.error, error);
  }
});

// ── reports ──────────────────────────────────────────────────────────────────

test('reports (§2.11): refund rows on the refund date, Net = Gross − Discounts − Refunds; profit M-8 (restocked removes cost, not restocked keeps it, uncosted apart); Refunds view = Sales refunds; paid back by method; customers taken off', async () => {
  on();
  const v = await vendor();
  const a = await product(v, { name: 'Bar', priceTzs: 3_500, stock: 30, costTzs: 2_000 });
  const b = await product(v, { name: 'Shaker', priceTzs: 5_000, stock: 30 }); // no cost price
  const c = await product(v, { name: 'Band', priceTzs: 1_000, stock: 30, costTzs: 400 });
  const sale = await sell(as(v), [{ productId: a.id, qty: 3, discountTzs: 500 }, { productId: b.id, qty: 2 }, { productId: c.id, qty: 2 }], cash(22_000));
  await refundOk(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }, { saleLineId: sale.lines[1].id, qty: 1, restock: false }, { saleLineId: sale.lines[2].id, qty: 1, restock: false }]));
  const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  const q = { from: today, to: today };
  const sales = (await call(vendorReportSales, as(v), { query: q })).body;
  const w = sales.byChannel.walkIn;
  // Refunds: Bar 1 of 3 (3,333) + Shaker 1 of 2 (5,000) + Band 1 of 2 (1,000).
  assert.deepEqual([w.grossTzs, w.discountTzs, w.refundTzs, w.netTzs, w.itemsSold, w.count], [22_500, 500, 9_333, 12_667, 4, 1]);
  assert.equal(w.grossTzs - w.discountTzs - w.refundTzs, w.netTzs);
  for (const bk of sales.buckets) assert.equal(bk.walkIn.grossTzs - bk.walkIn.discountTzs - bk.walkIn.refundTzs, bk.walkIn.netTzs);
  const profit = (await call(vendorReportProfit, as(v), { query: q })).body;
  // Bar: (10,000 − 3,333) − (6,000 − 2,000) = 2,667; Band: (2,000 − 1,000) − 800 = 200 (the unit not put back keeps its cost).
  assert.deepEqual([profit.totals.profitTzs, profit.totals.costTzs], [2_867, 4_800]);
  assert.deepEqual(profit.byProduct.map(r => [r.name, r.profitTzs]).sort(), [['Band', 200], ['Bar', 2_667]]);
  assert.deepEqual([profit.uncosted.revenueTzs, profit.uncostedProducts.map(r => [r.name, r.units, r.revenueTzs])], [5_000, [['Shaker', 1, 5_000]]]);
  const refunds = (await call(vendorReportRefunds, as(v), { query: q })).body;
  assert.deepEqual(refunds.totals, { count: 1, amountTzs: 9_333, paidOutTzs: 9_333, balanceReducedTzs: 0, restockedUnits: 1, revertedCount: 0 });
  assert.equal(refunds.totals.amountTzs, w.refundTzs, 'Refunds view = Sales walk-in refunds');
  assert.deepEqual(refunds.rows.map(r => [r.type, r.number, r.date, r.saleNumber, r.amountTzs, r.method, r.restockedUnits, r.status]), [['refund', 'CN-000001', today, sale.number, 9_333, 'cash', 1, 'active']]);
  const methods = (await call(vendorReportPaymentMethods, as(v), { query: q })).body;
  assert.deepEqual(methods.paidBack, [{ method: 'cash', amountTzs: 9_333, count: 1 }]);
  assert.deepEqual(methods.byYou.map(r => [r.method, r.amountTzs]), [['cash', 22_000]], '"Collected by you" is unchanged (money in)');
  const products = (await call(vendorReportProducts, as(v), { query: q })).body;
  assert.deepEqual(products.rows.map(r => [r.name, r.unitsSold]).sort(), [['Band', 1], ['Bar', 2], ['Shaker', 1]], 'units net of refunds');
  const csv = await call(vendorReportRefunds, as(v), { query: { ...q, format: 'csv', lang: 'sw' } });
  assert.match(csv.body, /Hati ya marejesho,Tarehe,Mauzo,Aina,/);
  assert.match(csv.body, new RegExp(`CN-000001,${today},${sale.number},Marejesho,9333,9333,0,Taslimu,1`));

  // Customers: balance taken off by refunds in the period (not money).
  const cust = await addCustomer(as(v), { name: 'Report Customer' });
  const credit = await sell(as(v), [{ productId: c.id, qty: 5 }], [], { kind: 'credit', customerId: cust.id });
  await refundOk(as(v), credit.id, body([{ saleLineId: credit.lines[0].id, qty: 2 }]));
  const custReport = (await call(vendorReportCustomers, as(v), { query: q })).body;
  assert.deepEqual([custReport.refundedOffTzs, custReport.creditSales.totalTzs, custReport.owedTzs], [2_000, 5_000, 3_000], 'pay-later sales stay gross; owed follows the balance');
});

test('reports: a refund in a closed period undone later leaves that period unchanged and flips on the undo day; the EAT day boundary (23:59 EAT vs 00:30 EAT = 21:30 UTC)', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { name: 'Dumbbell', priceTzs: 6_000, stock: 10, costTzs: 4_000 });
  const sale = await sell(as(v), [{ productId: p.id, qty: 2 }], cash(12_000));
  const r = await refundOk(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }]));
  await undo(as(v), r.refund.id);
  // Dated as if sold on 10 Oct, refunded at 23:59:59 EAT on 14 Oct (20:59:59Z) and undone at 00:30 EAT on 15 Oct (21:30Z).
  await db('VendorSale').where({ id: sale.id }).update({ soldAt: new Date('2026-10-10T09:00:00Z') });
  await db('VendorSaleRefund').where({ id: r.refund.id }).update({ createdAt: new Date('2026-10-14T20:59:59Z'), revertedAt: new Date('2026-10-14T21:30:00Z') });
  const walk = async (from, to) => (await call(vendorReportSales, as(v), { query: { from, to } })).body.byChannel.walkIn;
  const day10 = await walk('2026-10-10', '2026-10-10');
  assert.deepEqual([day10.netTzs, day10.refundTzs, day10.itemsSold], [12_000, 0, 2], 'the sale day is unchanged');
  const day14 = await walk('2026-10-14', '2026-10-14');
  assert.deepEqual([day14.refundTzs, day14.netTzs, day14.itemsSold], [6_000, -6_000, -1], '23:59:59 EAT is still the 14th');
  const day15 = await walk('2026-10-15', '2026-10-15');
  assert.deepEqual([day15.refundTzs, day15.netTzs, day15.itemsSold], [-6_000, 6_000, 1], 'the undo flips every sign on its own (EAT) day');
  const both = await walk('2026-10-14', '2026-10-15');
  assert.deepEqual([both.refundTzs, both.netTzs, both.itemsSold], [0, 0, 0], 'a refund and its undo in one period cancel');
  const rows = (await call(vendorReportRefunds, as(v), { query: { from: '2026-10-14', to: '2026-10-15' } })).body;
  assert.deepEqual(rows.rows.map(x => [x.type, x.date, x.amountTzs, x.paidOutTzs, x.restockedUnits]), [['refund', '2026-10-14', 6_000, 6_000, 1], ['revert', '2026-10-15', -6_000, -6_000, -1]]);
  assert.deepEqual([rows.totals.count, rows.totals.revertedCount, rows.totals.amountTzs], [1, 1, 0]);
  const profit14 = (await call(vendorReportProfit, as(v), { query: { from: '2026-10-14', to: '2026-10-14' } })).body.totals;
  assert.deepEqual([profit14.netExVatTzs, profit14.costTzs, profit14.profitTzs], [-6_000, -4_000, -2_000]);
  const paid = (await call(vendorReportPaymentMethods, as(v), { query: { from: '2026-10-14', to: '2026-10-15' } })).body.paidBack;
  assert.deepEqual(paid, [], 'paid back and its undo cancel in the period');
});

test('settlement untouched (§2.11): VendorSettlement prepare output, /vendor/payments and the statement CSV are identical with walk-in refunds present; no PaymentRequest', async () => {
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
    const s = await db('VendorSettlement').where({ vendorId: v }).whereNot('status', 'voided');
    const lines = await db('VendorSettlementLine').where({ vendorId: v, voided: false });
    return { statements: s.map(x => [x.orderCount, x.salesTzs, x.commissionTzs, x.finalNetTzs]), lines: lines.map(l => [l.orderId, l.salesTzs, l.commissionTzs, l.payoutTzs]) };
  };
  assert.equal((await settlements.prepare({ actorId: 'adm_s7' })).error, undefined);
  const before = await statement();
  assert.equal(before.statements.length, 1);
  const requestsBefore = await db('PaymentRequest').count('* as n').first().then(r => Number(r.n));

  const walkIn = await sell(as(v), [{ productId: p.id, qty: 3 }], cash(150_000));
  const r1 = await refundOk(as(v), walkIn.id, body([{ saleLineId: walkIn.lines[0].id, qty: 2 }]));
  await undo(as(v), r1.refund.id);
  await refundOk(as(v), walkIn.id, body([{ saleLineId: walkIn.lines[0].id, qty: 1 }], { method: 'mpesa', reference: 'MPX1' }));

  assert.equal((await settlements.prepare({ actorId: 'adm_s7' })).error, undefined);
  assert.deepEqual(await statement(), before, 'the statement, rebuilt, is exactly the app order');
  assert.deepEqual(await call(vendorPayments, as(v)), paymentsBefore);
  assert.equal(await shopService.vendorStatement(v), csvBefore);
  assert.equal(await db('PaymentRequest').count('* as n').first().then(r => Number(r.n)), requestsBefore, 'no PaymentRequest for refunds');
  const columns = Object.keys(await db('VendorSaleRefund').where({ vendorId: v }).first());
  assert.equal(columns.some(col => /commission|payout|settle/i.test(col)), false);
});

// ── documents ────────────────────────────────────────────────────────────────

test('credit note (§6): JSON / HTML / PDF content, EN + SW; A-02 (no phone, reason, cost or restock); the sale document lists active refunds; undone → Cancelled, watermark, 409 on new links, old links still open', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { name: 'Whey 1kg', priceTzs: 45_000, stock: 10, costTzs: 31_313 });
  const c = await addCustomer(as(v), { name: 'Juma Mussa', phone: '0712345678' });
  const sale = await sell(as(v), [{ productId: p.id, variant: undefined, qty: 2 }], [{ method: 'cash', amountTzs: 90_000 }], { customerId: c.id });
  const r = await refundOk(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1, restock: false }], { reason: 'Secret internal reason XYZ' }));
  const view = await call(vendorDocumentView, as(v), { params: { docType: 'credit_note', docId: r.refund.id } });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const doc = view.body.doc;
  assert.deepEqual([doc.docType, doc.number, doc.status, doc.saleRef.number, doc.customer, doc.totalTzs, doc.balanceReducedTzs, doc.paidOut, doc.lines],
    ['credit_note', 'CN-000001', 'issued', sale.number, { name: 'Juma Mussa' }, 45_000, 0, { method: 'cash', amountTzs: 45_000 }, [{ name: 'Whey 1kg', variant: null, qty: 1, amountTzs: 45_000 }]]);
  assert.equal(doc.seller.businessName, 'Refund Shop');
  const flat = JSON.stringify(doc);
  for (const banned of ['0712345678', '+255712345678', 'Secret internal reason', '31313', 'restock', 'buyerUserId', 'unitCostTzs', 'reason']) assert.equal(flat.includes(banned), false, `no ${banned}`);
  const html = await call(vendorDocumentView, as(v), { params: { docType: 'refund', docId: r.refund.id }, query: { format: 'html' } });
  for (const text of ['Credit note CN-000001', `For receipt ${sale.number}`, 'Returned items', '1 × Whey 1kg', 'Refund total', 'Refunded TSh 45,000 by Cash', 'Refund given by Refund Shop.', 'This is not a TRA fiscal receipt.', 'Issued']) {
    assert.ok(html.body.includes(text), `HTML has "${text}"`);
  }
  for (const banned of ['0712345678', 'Secret internal reason', 'Back in stock', '31,313']) assert.equal(html.body.includes(banned), false, `HTML has no ${banned}`);
  const sw = await call(vendorDocumentView, as(v), { params: { docType: 'credit_note', docId: r.refund.id }, query: { format: 'html', lang: 'sw' } });
  for (const text of ['Hati ya marejesho CN-000001', `Kwa risiti ${sale.number}`, 'Bidhaa zilizorudishwa', 'Jumla ya marejesho', 'Imerejeshwa TSh 45,000 kwa Taslimu', 'Marejesho yametolewa na Refund Shop.', 'Imetolewa']) {
    assert.ok(sw.body.includes(text), `SW HTML has "${text}"`);
  }
  const pdf = await call(vendorDocumentView, as(v), { params: { docType: 'credit_note', docId: r.refund.id }, query: { format: 'pdf' } });
  assert.equal(Buffer.from(pdf.body).subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.headers['Content-Disposition'], /CN-000001_refund-shop\.pdf/);
  const words = pdfText(Buffer.from(pdf.body));
  assert.match(words, /Credit note CN-000001/);
  assert.match(words, /Refund given by Refund Shop\./);
  assert.equal(/Secret internal reason|0712345678/.test(words), false);
  const thin = await call(vendorDocumentView, as(v), { params: { docType: 'credit_note', docId: r.refund.id }, query: { format: 'pdf', paper: '80mm', lang: 'sw' } });
  assert.match(pdfText(Buffer.from(thin.body)), /Hati ya marejesho CN-000001/);

  // The sale's own receipt lists the active credit note and the total after refunds.
  const receipt = (await call(vendorDocumentView, as(v), { params: { docType: 'sale', docId: sale.id } })).body.doc;
  assert.deepEqual([receipt.refunds.map(x => [x.number, x.amountTzs]), receipt.totalAfterRefundsTzs], [[['CN-000001', 45_000]], 45_000]);
  const receiptHtml = (await call(vendorDocumentView, as(v), { params: { docType: 'sale', docId: sale.id }, query: { format: 'html' } })).body;
  assert.ok(receiptHtml.includes('Total after refunds') && receiptHtml.includes('-TSh 45,000'));

  // Share, then undo: the credit note reads Cancelled; no new links; the old link still opens and says so.
  const shared = await call(vendorShareRefund, as(v), { params: { id: r.refund.id }, body: { lang: 'en' } });
  assert.equal(shared.status, 201, JSON.stringify(shared.body));
  assert.deepEqual([shared.body.docType, shared.body.number], ['credit_note', 'CN-000001']);
  assert.match(shared.body.whatsappText, /Credit note CN-000001, TSh 45,000/);
  await undo(as(v), r.refund.id);
  assert.deepEqual(await call(vendorShareRefund, as(v), { params: { id: r.refund.id }, body: {} }), { status: 409, body: { error: 'document_cancelled' } });
  const token = shared.body.url.split('/d/')[1].split('?')[0];
  const opened = await hit('GET', `/d/${token}`);
  assert.equal(opened.status, 200);
  assert.ok(opened.body.includes('Cancelled on') && opened.body.includes('Refund Shop cancelled this document.'));
  assert.equal(opened.body.includes('Secret internal reason') || opened.body.includes('Refunded by mistake'), false, 'never the reasons');
  assert.match(pdfText((await hit('GET', `/d/${token}.pdf?lang=sw`)).buffer), /CANCELLED ·[\s\S]*IMEBATILISHWA/);
  const afterUndo = (await call(vendorDocumentView, as(v), { params: { docType: 'sale', docId: sale.id } })).body.doc;
  assert.equal(afterUndo.refunds, undefined, 'undone credit notes are not listed on the receipt');

  // A credit sale's credit note reads "For invoice INV-…" and its settlement lines.
  const doc2 = creditNoteDocument({
    refund: { number: 'CN-000009', status: 'active', createdAt: '2026-11-03T11:05:00Z', amountTzs: 40_000, balanceReducedTzs: 20_000, paidOutTzs: 20_000, method: 'mpesa', reference: 'QK1' },
    lines: [{ nameSnapshot: 'Plates', variant: null, qty: 4, amountTzs: 40_000, vatTzs: 0, vatCode: null, vatRatePct: 0, lineNo: 1 }],
    sale: { number: 'R-000045', invoiceNumber: 'INV-000045', kind: 'credit', soldAt: '2026-11-01T08:00:00Z' }, customer: null, servedByName: 'Juma Mussa', seller: { businessName: 'Shop' },
  }, 'en');
  const html2 = renderDocumentHtml(doc2, { lang: 'en', mode: 'embedded' });
  for (const text of ['For invoice INV-000045', 'Taken off the balance TSh 20,000', 'Refunded TSh 20,000 by M-Pesa (QK1)', 'Sold on 1 Nov 2026', 'Served by Juma']) assert.ok(html2.includes(text), text);
  const nothing = renderDocumentHtml(creditNoteDocument({
    refund: { number: 'CN-000010', status: 'active', createdAt: '2026-11-03T11:05:00Z', amountTzs: 0, balanceReducedTzs: 0, paidOutTzs: 0 },
    lines: [{ nameSnapshot: 'Sample', variant: null, qty: 1, amountTzs: 0, vatTzs: 0, vatCode: null, vatRatePct: 0, lineNo: 1 }],
    sale: { number: 'R-000001', kind: 'cash', soldAt: '2026-11-01T08:00:00Z' }, customer: null, servedByName: null, seller: { businessName: 'Shop' },
  }, 'sw'), { lang: 'sw' });
  assert.ok(nothing.includes('Hakuna pesa iliyorudishwa.'));
});

test('sale document status after refunds (security review #318 M1): fully refunded → refunded; a pay-later balance cleared by a refund → settled_by_credit_note, never "Paid in full"; paid off by the customer → paid_in_full; a cash sale stays paid', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { name: 'Plates', priceTzs: 10_000, stock: 60 });
  const c = await addCustomer(as(v), { name: 'Status Customer' });
  const docOf = async id => (await call(vendorDocumentView, as(v), { params: { docType: 'sale', docId: id } })).body.doc;
  const htmlOf = async (id, lang = 'en') => (await call(vendorDocumentView, as(v), { params: { docType: 'sale', docId: id }, query: { format: 'html', lang } })).body;

  // An unpaid pay-later sale, all of it refunded → refunded (not paid_in_full).
  const unpaid = await sell(as(v), [{ productId: p.id, qty: 2 }], [], { kind: 'credit', customerId: c.id });
  await refundOk(as(v), unpaid.id, body([{ saleLineId: unpaid.lines[0].id, qty: 2 }]));
  const d1 = await docOf(unpaid.id);
  assert.equal(d1.status, 'refunded');
  assert.equal(d1.liveStatus.paidInFullAt, undefined);
  assert.ok((await htmlOf(unpaid.id)).includes('>Refunded<'));
  assert.ok((await htmlOf(unpaid.id, 'sw')).includes('>Imerejeshwa<'));

  // 50,000 sale, 10,000 paid now, the other 40,000 taken off by a refund → settled_by_credit_note.
  const part = await sell(as(v), [{ productId: p.id, qty: 5 }], cash(10_000), { kind: 'credit', customerId: c.id });
  const r = await refundOk(as(v), part.id, body([{ saleLineId: part.lines[0].id, qty: 4 }]));
  assert.deepEqual([r.refund.balanceReducedTzs, r.refund.paidOutTzs, r.sale.balanceTzs], [40_000, 0, 0]);
  const d2 = await docOf(part.id);
  assert.equal(d2.status, 'settled_by_credit_note');
  assert.ok((await htmlOf(part.id)).includes('Settled by credit note'));
  assert.ok((await htmlOf(part.id, 'sw')).includes('Imelipwa kwa hati ya marejesho'));
  assert.equal((await htmlOf(part.id)).includes('Paid in full'), false);
  const pdf = await call(vendorDocumentView, as(v), { params: { docType: 'sale', docId: part.id }, query: { format: 'pdf' } });
  assert.match(pdfText(Buffer.from(pdf.body)), /Settled by credit note/);
  // Undo the refund: owed again → pay_later.
  await undo(as(v), r.refund.id);
  assert.equal((await docOf(part.id)).status, 'pay_later');

  // Paid off by the customer, then part refunded with money back → still paid_in_full.
  const paidOff = await sell(as(v), [{ productId: p.id, qty: 2 }], cash(5_000), { kind: 'credit', customerId: c.id });
  assert.equal((await pay(as(v), c.id, { amountTzs: 15_000 + 40_000 })).status, 201, 'pays this sale and the reopened one');
  await refundOk(as(v), paidOff.id, body([{ saleLineId: paidOff.lines[0].id, qty: 1 }]));
  const d3 = await docOf(paidOff.id);
  assert.equal(d3.status, 'paid_in_full');
  assert.ok(d3.liveStatus.paidInFullAt);

  // A fully paid cash sale, partly refunded → still paid; fully refunded → refunded.
  const cashSale = await sell(as(v), [{ productId: p.id, qty: 2 }], cash(20_000));
  await refundOk(as(v), cashSale.id, body([{ saleLineId: cashSale.lines[0].id, qty: 1 }]));
  assert.equal((await docOf(cashSale.id)).status, 'paid');
  await refundOk(as(v), cashSale.id, body([{ saleLineId: cashSale.lines[0].id, qty: 1 }]));
  assert.equal((await docOf(cashSale.id)).status, 'refunded');

  // The rule on its own (a free sale is never "refunded"; voided wins).
  assert.equal(saleDocumentStatus({ status: 'completed', kind: 'cash', totalTzs: 0, refundedTzs: 0 }), 'paid');
  assert.equal(saleDocumentStatus({ status: 'voided', kind: 'credit', totalTzs: 10, refundedTzs: 10, balanceTzs: 0 }), 'cancelled');
});

test('undo shares the sales rate limit (security review #318 L2): over 120 a minute → 429 rate_limited with Retry-After, nothing changes', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 5 });
  const sale = await sell(as(v), [{ productId: p.id, qty: 1 }], cash(1_000));
  const r = await refundOk(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }]));
  while (allowVendorSale(v).ok) { /* use up this minute's allowance */ }
  const limited = await undo(as(v), r.refund.id);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(limited.headers['Retry-After']);
  assert.equal((await db('VendorSaleRefund').where({ id: r.refund.id }).first()).status, 'active');
  assert.ok(VENDOR_SALES_LIMIT.perMinute >= 120);
  resetVendorSalesLimits();
  assert.equal((await undo(as(v), r.refund.id)).status, 200);
});

// ── migration ────────────────────────────────────────────────────────────────

test('migration: down refuses while refunds exist; up on a database with existing sales validates the replaced CHECK (run inside a rolled-back transaction)', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { priceTzs: 1_000, stock: 5 });
  const sale = await sell(as(v), [{ productId: p.id, qty: 2 }], cash(2_000));
  await refundOk(as(v), sale.id, body([{ saleLineId: sale.lines[0].id, qty: 1 }]));
  await assert.rejects(migration.down(db), /refund\(s\) exist/);
  assert.equal((await db.raw(`SELECT convalidated FROM pg_constraint WHERE conname = 'vendorsale_paid_adds_up'`)).rows[0].convalidated, true, 'nothing was dropped');
  const ROLLBACK = new Error('rollback');
  await assert.rejects(db.transaction(async (trx) => {
    // Bring every row back to a pre-S7 state, go down, add a legacy pay-later sale, then up again.
    await trx.raw(`UPDATE "VendorSale" SET "balanceTzs" = "balanceTzs" + "balanceReducedTzs", "balanceReducedTzs" = 0, "refundedTzs" = 0`);
    await trx.raw(`UPDATE "VendorSaleLine" SET "refundedQty" = 0, "refundedTzs" = 0, "refundedVatTzs" = 0`);
    await trx.raw(`DELETE FROM "VendorSaleRefund"`);
    await migration.down(trx);
    const cols = (await trx.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = 'VendorSale' AND column_name IN ('refundedTzs', 'balanceReducedTzs')`)).rows;
    assert.deepEqual(cols, []);
    await migration.up(trx);
    const checks = (await trx.raw(`SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('vendorsale_paid_adds_up', 'vendorsale_refunded_range', 'vendorsale_balance_reduced_range', 'vendorsale_cash_no_balance_reduced', 'vendorsaleline_refunded_qty_range') ORDER BY conname`)).rows;
    assert.equal(checks.length, 5);
    assert.ok(checks.every(x => x.convalidated), 'every new CHECK validated against the existing rows');
    throw ROLLBACK;
  }), err => err === ROLLBACK);
  assert.equal(await db('VendorSaleRefund').where({ vendorId: v }).count('* as n').first().then(r => Number(r.n)), 1, 'rolled back: the refund is still there');
});
