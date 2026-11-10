// Vendor walk-in sale extras (design spec docs/design/vendor-sale-extras-1110.md, approved 2026-11-10 with Q-1..Q-13
// as recommended): the backend part of #1 (a reference is optional for every method on a sale, cash references kept)
// and #2 (customerType on a sale). Against the CI database.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { shopService } from '../src/bootstrap/services.mjs';
import { vendorToolsOptionsRoute, vendorCreateProduct, vendorMeRoute } from '../functions/shop.mjs';
import { vendorRecordSale, vendorListSales, vendorGetSale, resetVendorSalesLimits } from '../functions/vendor-sales.mjs';
import { vendorCustomersCreate, vendorCustomerSales, vendorCustomerSale, vendorCustomerRecordPayment, resetVendorCustomerLimits } from '../functions/vendor-customers.mjs';
import {
  parseSale, saleFingerprint, PAYMENT_METHODS, REFERENCE_REQUIRED, SALE_REFERENCE_REQUIRED, SALE_CUSTOMER_TYPES,
} from '../src/shared/vendor-sale.mjs';
import { parsePayment } from '../src/shared/vendor-customer.mjs';
import { refundMethod } from '../src/shared/vendor-refund.mjs';
import { methodAndReference } from '../src/shared/vendor-purchase.mjs';
import { VENDOR_TOOLS_FLAGS, vendorToolsOptions } from '../src/shared/feature-flags.mjs';
import fs from 'node:fs';
import { createPgVendorSaleStore } from '../src/infra/vendor-sale-store-pg.mjs';
import { createPgVendorDocumentStore } from '../src/infra/vendor-document-store-pg.mjs';
import { saleDocument } from '../src/shared/vendor-documents.mjs';
import { renderDocumentHtml } from '../src/shared/vendor-document-html.mjs';
import { renderDocumentPdf } from '../src/shared/vendor-document-pdf.mjs';

const MIGRATION = '../db/migrations/20270203090300-vendor-sale-customer-type.cjs';
const migration = createRequire(import.meta.url)(MIGRATION);

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [] };
const FLAGS = ['VENDOR_TOOLS', 'VENDOR_WALKIN_SALES', 'VENDOR_CUSTOMERS', 'VENDOR_PORTAL', 'VENDOR_SALE_REFERENCE_OPTIONAL', 'VENDOR_SALE_CUSTOMER_DETAILS'];
const salesOn = () => { process.env.VENDOR_TOOLS = '1'; process.env.VENDOR_WALKIN_SALES = '1'; };
const customersOn = () => { salesOn(); process.env.VENDOR_CUSTOMERS = '1'; };
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
  await db('User').insert({ id, userType, displayName: `Extras ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
async function vendor() {
  const id = await user('vendor', { createdAt: new Date('2026-01-01T00:00:00Z'), displayName: 'Asha Owner', vendorProfile: JSON.stringify({ businessName: 'Extras Shop', status: 'published' }) });
  const caseId = uid('kyc');
  await db('PartnerKycCase').insert({ id: caseId, partnerType: 'vendor', userId: id, status: 'approved', tier: 3, updatedAt: new Date() });
  await db('PartnerSettlementAccount').insert({
    id: uid('psa'), caseId, method: 'bank', provider: 'CRDB', accountName: 'Extras Shop', accountNumber: '0150001234',
    status: 'verified', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z'), cooldownUntil: new Date('2026-09-03T00:00:00Z'), updatedAt: new Date(),
  });
  return id;
}
const as = id => ({ sub: id, userType: 'vendor' });
const staffOf = (id, vendorId) => ({ sub: id, userType: 'vendor_staff', vendorId });
const staff = (vendorId, permissions) => user('vendor_staff', { vendorId, vendorPermissions: permissions, accountStatus: 'active', vendorRole: 'sales', displayName: 'Neema Staff' });
async function product(vendorId, body = {}) {
  const out = await call(vendorCreateProduct, as(vendorId), { body: { name: 'Whey 1kg', category: 'supplements_nutrition', priceTzs: 10_000, stock: 100, ...body } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  made.products.push(out.body.id);
  await shopService.adminUpdateProductListing({ productId: out.body.id, body: { approvalStatus: 'approved' }, actorId: 'adm_extras' });
  return out.body;
}
const saleBody = (lines, payments, extra = {}) => ({ clientRef: randomUUID(), lines, payments, ...extra });
const sell = (claims, body) => call(vendorRecordSale, claims, { body });
const getSale = (claims, id) => call(vendorGetSale, claims, { params: { id } });

/** The S3/S4 fingerprint exactly as it was before sale extras (a copy, so a change to the real one shows here). */
const fingerprintBefore = sale => createHash('sha256').update(JSON.stringify({
  soldAt: sale.soldAtInput == null ? null : new Date(sale.soldAtInput).toISOString(),
  lines: sale.lines.map(l => [l.productId, l.variant || null, l.qty, l.unitPriceTzs ?? null, l.discountTzs || 0]),
  discountTzs: sale.discountTzs || 0,
  payments: sale.payments.map(p => [p.method, p.amountTzs, p.reference || null]),
  note: sale.note || null,
  ...(sale.kind === 'credit' || sale.customerId ? { kind: sale.kind, customerId: sale.customerId, dueDate: sale.dueDate || null } : {}),
})).digest('hex');

/** Text drawn in a pdfkit PDF (the helper of specs/vendor-documents.specs.mjs). */
const streamData = (s, dictStart, start) => s.slice(start, start + Number(s.slice(dictStart, start).match(/\/Length (\d+)/)[1]));
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
  const vendors = made.users;
  const saleIds = (await db('VendorSale').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  const customerIds = (await db('VendorCustomer').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  const paymentIds = (await db('VendorCustomerPayment').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  await db('AuditLog').whereIn('target', [...saleIds, ...customerIds, ...paymentIds, ...made.products]).del();
  await db('VendorCustomerPayment').whereIn('vendorId', vendors).del();
  await db('VendorSale').whereIn('vendorId', vendors).del(); // lines and payments go with it (ON DELETE CASCADE)
  await db('VendorCustomer').whereIn('vendorId', vendors).del();
  await db('VendorDocumentSequence').whereIn('vendorId', vendors).del();
  await db('ShopStockMovement').whereIn('productId', made.products).del();
  await db('MarketplaceNotification').whereIn('userId', vendors).del();
  await db('Notification').whereIn('userId', vendors).del();
  await db('Product').whereIn('id', made.products).del();
  await db('PartnerSettlementAccount').whereIn('caseId', db('PartnerKycCase').whereIn('userId', vendors).select('id')).del();
  await db('PartnerKycCase').whereIn('userId', vendors).del();
  await db('User').whereIn('id', vendors).del().catch(() => {});
  await db.destroy();
});

// ── #1 reference: rules ──────────────────────────────────────────────────────

const base = { clientRef: 'extras-0001', lines: [{ productId: 'prd_a', qty: 1 }] };

test('rules #1: on a sale no method needs a reference; a reference on any method (cash too) is trimmed and kept; type and length still checked', () => {
  assert.equal(SALE_REFERENCE_REQUIRED.size, 0);
  for (const method of PAYMENT_METHODS) {
    for (const reference of [undefined, null, '', '   ']) {
      const out = parseSale({ ...base, payments: [{ method, amountTzs: 1_000, reference }] });
      assert.equal(out.error, undefined, `${method} ${JSON.stringify(reference)}`);
      assert.equal(out.payments[0].reference, null);
    }
    assert.equal(parseSale({ ...base, payments: [{ method, amountTzs: 1_000, reference: '  TILL-889 ' }] }).payments[0].reference, 'TILL-889', method);
    assert.equal(parseSale({ ...base, payments: [{ method, amountTzs: 1_000, reference: 'x'.repeat(100) }] }).payments[0].reference.length, 100, method);
    assert.deepEqual(parseSale({ ...base, payments: [{ method, amountTzs: 1_000, reference: 'x'.repeat(101) }] }), { error: 'invalid_payment', status: 400, index: 0, field: 'reference', max: 100 }, method);
    assert.deepEqual(parseSale({ ...base, payments: [{ method, amountTzs: 1_000, reference: 12345 }] }), { error: 'invalid_payment', status: 400, index: 0, field: 'reference' }, method);
  }
  // Pay later: the "paid now" rows follow the same rule.
  const credit = parseSale({ ...base, kind: 'credit', customerId: 'cus_x', payments: [{ method: 'mpesa', amountTzs: 1_000 }, { method: 'cash', amountTzs: 500, reference: 'C-1' }] });
  assert.deepEqual(credit.payments, [{ method: 'mpesa', amountTzs: 1_000, reference: null }, { method: 'cash', amountTzs: 500, reference: 'C-1' }]);
});

test('rules #1 (Q-1): customer payments, refunds and supplier payments still need a reference for mobile money and bank; the shared constant is unchanged', () => {
  assert.deepEqual([...REFERENCE_REQUIRED].sort(), ['airtel_money', 'bank', 'halopesa', 'mixx', 'mpesa']);
  const today = '2026-11-10';
  for (const method of REFERENCE_REQUIRED) {
    assert.equal(parsePayment({ clientRef: 'abcdefgh', amountTzs: 5_000, method }, { today }).error, 'reference_required', `customer payment ${method}`);
    assert.equal(refundMethod({ method, reference: null }, 1_000).error, 'reference_required', `refund ${method}`);
    assert.equal(methodAndReference(method, null).error, 'reference_required', `supplier payment ${method}`);
  }
  // …and still drop a cash reference, as before.
  assert.equal(parsePayment({ clientRef: 'abcdefgh', amountTzs: 5_000, method: 'cash', reference: 'C-1' }, { today }).reference, null);
  assert.deepEqual(refundMethod({ method: 'cash', reference: 'C-1' }, 1_000), { method: 'cash', reference: null });
  assert.deepEqual(methodAndReference('cash', 'C-1'), { method: 'cash', reference: null });
});

test('rules #1 (security review L-3): a sale reference holding a control character is refused (never stripped); other text is kept as typed', () => {
  for (const bad of ['QK1\u0000', 'QK\n12', 'QK\t12', 'QK\r12', 'A\u001bB', 'A\u007fB', 'A\u0085B', 'A\u009fB']) {
    for (const method of ['cash', 'mpesa', 'card']) {
      assert.deepEqual(parseSale({ ...base, payments: [{ method, amountTzs: 1_000, reference: bad }] }), { error: 'invalid_payment', status: 400, index: 0, field: 'reference' }, `${method} ${JSON.stringify(bad)}`);
    }
  }
  // The index points at the offending row.
  assert.deepEqual(parseSale({ ...base, payments: [{ method: 'cash', amountTzs: 1_000, reference: 'ok' }, { method: 'bank', amountTzs: 1, reference: 'B\u00001' }] }).index, 1);
  // Leading/trailing whitespace is trimmed as before (that trim already removed edge tabs/newlines); inside it is refused.
  assert.equal(parseSale({ ...base, payments: [{ method: 'cash', amountTzs: 1_000, reference: '\tTILL-889\n' }] }).payments[0].reference, 'TILL-889');
  for (const fine of ['TILL 889', 'Malipo ya Ñ/é – 12', 'CRDB TT 2026/10/20', 'نمبر ١٢', 'A\u00a0B']) {
    assert.equal(parseSale({ ...base, payments: [{ method: 'mpesa', amountTzs: 1_000, reference: fine }] }).payments[0].reference, fine, JSON.stringify(fine));
  }
});

// ── #2 customerType: rules ───────────────────────────────────────────────────

test('rules #2: customerType is one of the five, or none; anything else → 400 invalid_field { field, allowed, message en + sw }', () => {
  assert.deepEqual(SALE_CUSTOMER_TYPES, ['new', 'returning', 'walk_in', 'online', 'other']);
  for (const t of SALE_CUSTOMER_TYPES) assert.equal(parseSale({ ...base, payments: [], customerType: t }).customerType, t);
  for (const none of [undefined, null, '']) assert.equal(parseSale({ ...base, payments: [], customerType: none }).customerType, null);
  for (const bad of ['Walk-in', 'NEW', 'walkin', 'vip', 3, true, ['new'], { t: 'new' }]) {
    const out = parseSale({ ...base, payments: [], customerType: bad });
    assert.equal(out.error, 'invalid_field', JSON.stringify(bad));
    assert.equal(out.status, 400);
    assert.equal(out.field, 'customerType');
    assert.deepEqual(out.allowed, SALE_CUSTOMER_TYPES);
    assert.ok(out.message.en && out.message.sw, 'English and Swahili');
  }
});

test('fingerprint: unchanged for a sale without customerType (S3 and S4 shapes); customerType changes it only when set', () => {
  const shapes = [
    { ...base, soldAt: '2026-11-10T09:00:00+03:00', payments: [{ method: 'cash', amountTzs: 10_000 }, { method: 'mpesa', amountTzs: 5_000, reference: 'QK1' }], note: 'n' },
    { ...base, payments: [], discountTzs: 0 },
    { ...base, kind: 'credit', customerId: 'cus_x', dueDate: '2026-11-30', payments: [{ method: 'bank', amountTzs: 1_000, reference: 'B1' }] },
    { ...base, customerId: 'cus_y', payments: [{ method: 'card', amountTzs: 1_000 }] },
  ];
  for (const body of shapes) {
    const plain = parseSale(body);
    assert.equal(saleFingerprint(plain), fingerprintBefore(plain), 'same hash as before sale extras');
    assert.equal(saleFingerprint(parseSale({ ...body, customerType: null })), fingerprintBefore(plain), 'null = absent');
    assert.equal(saleFingerprint(parseSale({ ...body, customerType: '' })), fingerprintBefore(plain), 'empty = absent');
    const typed = saleFingerprint(parseSale({ ...body, customerType: 'walk_in' }));
    assert.notEqual(typed, fingerprintBefore(plain));
    assert.equal(typed, saleFingerprint(parseSale({ ...body, customerType: 'walk_in' })), 'stable');
    assert.notEqual(typed, saleFingerprint(parseSale({ ...body, customerType: 'online' })));
  }
});

// ── flags and discovery ──────────────────────────────────────────────────────

test('flags: referenceOptional and saleCustomerDetails in /vendor/tools/options and /vendor/me.tools, each on only with VENDOR_TOOLS and its own flag', async () => {
  assert.ok(VENDOR_TOOLS_FLAGS.includes('VENDOR_SALE_REFERENCE_OPTIONAL') && VENDOR_TOOLS_FLAGS.includes('VENDOR_SALE_CUSTOMER_DETAILS'));
  const v = await vendor();
  const opts = async () => (await call(vendorToolsOptionsRoute, as(v))).body;
  const off = await opts();
  assert.deepEqual([off.referenceOptional, off.saleCustomerDetails], [false, false]);
  process.env.VENDOR_SALE_REFERENCE_OPTIONAL = '1';
  process.env.VENDOR_SALE_CUSTOMER_DETAILS = '1';
  assert.deepEqual([(await opts()).referenceOptional, (await opts()).saleCustomerDetails], [false, false], 'no umbrella, no tool');
  process.env.VENDOR_TOOLS = '1';
  assert.deepEqual([(await opts()).referenceOptional, (await opts()).saleCustomerDetails], [true, true]);
  delete process.env.VENDOR_SALE_CUSTOMER_DETAILS;
  assert.deepEqual([(await opts()).referenceOptional, (await opts()).saleCustomerDetails], [true, false], 'independent');
  assert.equal(vendorToolsOptions().referenceOptional, true);
  // Staff with `sales` only read the same keys.
  process.env.VENDOR_SALE_CUSTOMER_DETAILS = '1';
  const seller = await staff(v, ['sales']);
  const forStaff = (await call(vendorToolsOptionsRoute, staffOf(seller, v))).body;
  assert.deepEqual([forStaff.referenceOptional, forStaff.saleCustomerDetails], [true, true]);
  process.env.VENDOR_PORTAL = '1';
  const me = await call(vendorMeRoute, as(v));
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.deepEqual([me.body.tools.referenceOptional, me.body.tools.saleCustomerDetails], [true, true]);
});

// ── #1 reference: recorded ───────────────────────────────────────────────────

test('POST /vendor/sales #1: every method records with no reference, flag on or off; a cash reference is stored and returned; pay-later paid-now rows too', async () => {
  const v = await vendor();
  const p = await product(v);
  const one = [{ productId: p.id, qty: 1 }];
  for (const flag of [false, true]) {
    salesOn();
    if (flag) process.env.VENDOR_SALE_REFERENCE_OPTIONAL = '1';
    for (const method of PAYMENT_METHODS) {
      const out = await sell(as(v), saleBody(one, [{ method, amountTzs: 10_000 }]));
      assert.equal(out.status, 201, `${method} flag ${flag}: ${JSON.stringify(out.body)}`);
      assert.deepEqual(out.body.sale.payments, [{ method, amountTzs: 10_000, reference: null }]);
    }
    delete process.env.VENDOR_SALE_REFERENCE_OPTIONAL;
  }
  salesOn();
  const tilled = await sell(as(v), saleBody(one, [{ method: 'cash', amountTzs: 10_000, reference: ' TILL-889 ' }]));
  assert.equal(tilled.status, 201, JSON.stringify(tilled.body));
  assert.deepEqual(tilled.body.sale.payments, [{ method: 'cash', amountTzs: 10_000, reference: 'TILL-889' }]);
  assert.deepEqual((await getSale(as(v), tilled.body.sale.id)).body.sale.payments, [{ method: 'cash', amountTzs: 10_000, reference: 'TILL-889' }]);
  assert.equal((await db('VendorSalePayment').where({ saleId: tilled.body.sale.id }).first()).reference, 'TILL-889', 'stored');
  assert.deepEqual((await sell(as(v), saleBody(one, [{ method: 'cash', amountTzs: 10_000, reference: 'x'.repeat(101) }]))).body, { error: 'invalid_payment', index: 0, field: 'reference', max: 100 });
  const stockBefore = (await db('Product').where({ id: p.id }).first()).stock;
  assert.deepEqual((await sell(as(v), saleBody(one, [{ method: 'mpesa', amountTzs: 10_000, reference: 'QK\u000012' }]))).body, { error: 'invalid_payment', index: 0, field: 'reference' }, 'L-3: control character refused');
  assert.equal((await db('Product').where({ id: p.id }).first()).stock, stockBefore, 'nothing recorded');

  // A retry with the same cash reference replays; with another reference it is a different sale.
  const body = saleBody(one, [{ method: 'cash', amountTzs: 10_000, reference: 'T-1' }]);
  const first = await sell(as(v), body);
  const again = await sell(as(v), body);
  assert.deepEqual([again.status, again.headers['Idempotent-Replay'], again.body.sale.id], [200, 'true', first.body.sale.id]);
  assert.deepEqual((await sell(as(v), { ...body, payments: [{ method: 'cash', amountTzs: 10_000, reference: 'T-2' }] })).body, { error: 'client_ref_reused' });

  // Pay later: the paid-now rows need no reference either.
  customersOn();
  const c = (await call(vendorCustomersCreate, as(v), { body: { name: 'Juma Mussa' } })).body.customer;
  const credit = await sell(as(v), saleBody(one, [{ method: 'mpesa', amountTzs: 2_000 }, { method: 'cash', amountTzs: 1_000, reference: 'C-9' }], { kind: 'credit', customerId: c.id }));
  assert.equal(credit.status, 201, JSON.stringify(credit.body));
  assert.deepEqual(credit.body.sale.payments, [{ method: 'mpesa', amountTzs: 2_000, reference: null }, { method: 'cash', amountTzs: 1_000, reference: 'C-9' }]);
  assert.equal(credit.body.sale.balanceTzs, 7_000);

  // Customer payments keep their rule (Q-1).
  const pay = await call(vendorCustomerRecordPayment, as(v), { params: { id: c.id }, body: { clientRef: randomUUID(), method: 'mpesa', amountTzs: 1_000 } });
  assert.deepEqual([pay.status, pay.body.error], [400, 'reference_required']);
});

test('documents #1: a cash reference prints as "Cash (TILL-889)" in the receipt page and both PDFs (A4, 80mm); the customer type never does', async () => {
  salesOn();
  const v = await vendor();
  const p = await product(v, { name: 'Gloves' });
  const out = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], [{ method: 'cash', amountTzs: 10_000, reference: 'TILL-889' }], { customerType: 'returning' }));
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const store = createPgVendorDocumentStore({ db, customerStore: null });
  const src = await store.saleSource(v, out.body.sale.id);
  for (const lang of ['en', 'sw']) {
    const doc = saleDocument(src, lang);
    assert.deepEqual(doc.payments, [{ method: 'cash', reference: 'TILL-889', amountTzs: 10_000 }]);
    const cashWord = lang === 'en' ? 'Cash' : 'Taslimu';
    const html = renderDocumentHtml(doc, { lang });
    assert.ok(html.includes(`${cashWord} (TILL-889)`), `${lang} page`);
    assert.match(pdfText(await renderDocumentPdf(doc, { lang })), new RegExp(`${cashWord} \\(TILL-889\\)`), `${lang} A4 PDF`);
    assert.match(pdfText(await renderDocumentPdf(doc, { lang, paper: '80mm' })), new RegExp(`${cashWord} TILL-889`), `${lang} 80mm PDF`);
    assert.equal(JSON.stringify(doc).includes('returning'), false, 'no customer type in the document');
    assert.equal(/returning|Anayerudi|walk_in/i.test(html), false, 'no customer type on the page');
  }
});

// ── #2 customerType: recorded and read ───────────────────────────────────────

test('POST /vendor/sales #2: customerType stored whatever the flags (customers off too), returned on detail, list rows and customer-sale reads; invalid → 400, nothing recorded', async () => {
  salesOn(); // VENDOR_SALE_CUSTOMER_DETAILS and VENDOR_CUSTOMERS off (Q-8: the flag is an app switch only)
  const v = await vendor();
  const p = await product(v, { stock: 50 });
  const one = [{ productId: p.id, qty: 1 }];
  const typed = await sell(as(v), saleBody(one, [{ method: 'cash', amountTzs: 10_000 }], { customerType: 'walk_in' }));
  assert.equal(typed.status, 201, JSON.stringify(typed.body));
  assert.equal(typed.body.sale.customerType, 'walk_in');
  assert.equal((await db('VendorSale').where({ id: typed.body.sale.id }).first()).customerType, 'walk_in');
  const plain = await sell(as(v), saleBody(one, [{ method: 'cash', amountTzs: 10_000 }]));
  assert.equal(plain.body.sale.customerType, null, 'not sent → null');
  assert.equal((await getSale(as(v), typed.body.sale.id)).body.sale.customerType, 'walk_in');
  assert.equal((await getSale(as(v), plain.body.sale.id)).body.sale.customerType, null);

  const bad = await sell(as(v), saleBody(one, [{ method: 'cash', amountTzs: 10_000 }], { customerType: 'vip' }));
  assert.equal(bad.status, 400);
  assert.deepEqual([bad.body.error, bad.body.field, bad.body.allowed], ['invalid_field', 'customerType', SALE_CUSTOMER_TYPES]);
  assert.equal(typeof bad.body.message.sw, 'string');
  assert.equal((await db('Product').where({ id: p.id }).first()).stock, 48, 'the refusal moved nothing');

  // Staff with `sales` only may send it.
  const seller = await staff(v, ['sales']);
  const byStaff = await sell(staffOf(seller, v), saleBody(one, [{ method: 'card', amountTzs: 10_000 }], { customerType: 'online' }));
  assert.deepEqual([byStaff.status, byStaff.body.sale.customerType], [201, 'online']);

  // With a customer and pay later (customers on), and the customer-sale reads.
  customersOn();
  const c = (await call(vendorCustomersCreate, as(v), { body: { name: 'Asha Mteja', phone: '0712 345 678' } })).body.customer;
  const credit = await sell(as(v), saleBody(one, [], { kind: 'credit', customerId: c.id, customerType: 'returning' }));
  assert.deepEqual([credit.status, credit.body.sale.customerType, credit.body.sale.customer.id], [201, 'returning', c.id]);

  const list = await call(vendorListSales, as(v), {});
  const types = new Map(list.body.sales.map(r => [r.id, r.customerType]));
  assert.deepEqual([types.get(typed.body.sale.id), types.get(plain.body.sale.id), types.get(byStaff.body.sale.id), types.get(credit.body.sale.id)], ['walk_in', null, 'online', 'returning']);
  assert.ok(list.body.sales.every(r => 'customerType' in r), 'every list row has the key');
  const staffList = await call(vendorListSales, staffOf(seller, v), {});
  assert.equal(staffList.body.sales.find(r => r.id === byStaff.body.sale.id).customerType, 'online', 'sales-only staff see it too');
  const ofCustomer = await call(vendorCustomerSales, as(v), { params: { id: c.id } });
  assert.deepEqual(ofCustomer.body.sales.map(r => r.customerType), ['returning']);
  const oneOfCustomer = await call(vendorCustomerSale, as(v), { params: { id: c.id, saleId: credit.body.sale.id } });
  assert.equal(oneOfCustomer.body.sale.customerType, 'returning');
});

test('replay #2 (AC-23): the same clientRef and type replays; a sale sent without a type (a pre-change queued sale) still replays; adding a type later is a different sale', async () => {
  salesOn();
  const v = await vendor();
  const p = await product(v);
  const one = [{ productId: p.id, qty: 1 }];
  const typedBody = saleBody(one, [{ method: 'cash', amountTzs: 10_000 }], { customerType: 'new' });
  const first = await sell(as(v), typedBody);
  const again = await sell(as(v), typedBody);
  assert.deepEqual([again.status, again.headers['Idempotent-Replay'], again.body.sale.id, again.body.sale.customerType], [200, 'true', first.body.sale.id, 'new']);
  assert.deepEqual((await sell(as(v), { ...typedBody, customerType: 'online' })).body, { error: 'client_ref_reused' });

  // A pre-change sale: its stored fingerprint is the old formula's; a retry without a type replays.
  const oldBody = saleBody(one, [{ method: 'mpesa', amountTzs: 10_000, reference: 'QK9' }]);
  const old = await sell(as(v), oldBody);
  assert.equal((await db('VendorSale').where({ id: old.body.sale.id }).first()).fingerprint, fingerprintBefore(parseSale(oldBody)));
  const retried = await sell(as(v), { ...oldBody, customerType: null });
  assert.deepEqual([retried.status, retried.body.sale.id], [200, old.body.sale.id]);
  assert.deepEqual((await sell(as(v), { ...oldBody, customerType: 'walk_in' })).body, { error: 'client_ref_reused' });
});

// ── migration ────────────────────────────────────────────────────────────────

test('migration: VendorSale.customerType (nullable text) with its CHECK; down drops both, up restores them', async () => {
  const col = q => q.raw(`SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name = 'VendorSale' AND column_name = 'customerType'`);
  const check = q => q.raw(`SELECT conname, convalidated FROM pg_constraint WHERE conname = 'vendorsale_customer_type_check'`);
  assert.deepEqual((await col(db)).rows, [{ is_nullable: 'YES', data_type: 'text' }]);
  assert.deepEqual((await check(db)).rows, [{ conname: 'vendorsale_customer_type_check', convalidated: true }], 'validated after up');
  // L-1: added NOT VALID, then VALIDATEd in its own statement, under a lock_timeout.
  const src = fs.readFileSync(new URL(MIGRATION, import.meta.url), 'utf8');
  assert.match(src, /CHECK \([^;]*\) NOT VALID`\);\s*await knex\.raw\('ALTER TABLE "VendorSale" VALIDATE CONSTRAINT vendorsale_customer_type_check'\)/);
  assert.match(src, /SET LOCAL lock_timeout/);
  salesOn();
  const v = await vendor();
  const p = await product(v);
  const sale = (await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], [{ method: 'cash', amountTzs: 10_000 }]))).body.sale;
  await assert.rejects(db('VendorSale').where({ id: sale.id }).update({ customerType: 'vip' }), /vendorsale_customer_type_check/);
  const ROLLBACK = new Error('rollback');
  await assert.rejects(db.transaction(async (trx) => {
    await trx('VendorSale').where({ id: sale.id }).update({ customerType: 'other' });
    await migration.down(trx);
    assert.deepEqual((await col(trx)).rows, []);
    assert.equal((await check(trx)).rows.length, 0);
    await migration.up(trx);
    assert.deepEqual((await col(trx)).rows, [{ is_nullable: 'YES', data_type: 'text' }]);
    assert.equal((await trx('VendorSale').where({ id: sale.id }).first()).customerType, null, 'no backfill');
    assert.deepEqual((await check(trx)).rows, [{ conname: 'vendorsale_customer_type_check', convalidated: true }]);
    throw ROLLBACK;
  }), err => err === ROLLBACK);
  assert.equal((await check(db)).rows.length, 1, 'rolled back');
});

test('rollback order (security review L-2): with the column gone, a sale without customerType still records; one with a type is refused, nothing kept', async () => {
  salesOn();
  const v = await vendor();
  const p = await product(v);
  const parsed = body => Object.assign(parseSale(body), { soldAt: new Date(), clientSoldAt: null });
  const ROLLBACK = new Error('rollback');
  await assert.rejects(db.transaction(async (trx) => {
    await migration.down(trx);
    const store = createPgVendorSaleStore({ db: trx });
    const plainSale = parsed(saleBody([{ productId: p.id, qty: 1 }], [{ method: 'cash', amountTzs: 10_000 }]));
    const out = await store.record({ vendorId: v, actorId: v, sale: plainSale, fingerprint: saleFingerprint(plainSale) });
    assert.equal(out.error, undefined, JSON.stringify(out));
    assert.equal(out.sale.customerType, null, 'the view still answers null without the column');
    const typedSale = parsed(saleBody([{ productId: p.id, qty: 1 }], [{ method: 'cash', amountTzs: 10_000 }], { customerType: 'new' }));
    await assert.rejects(trx.transaction(t2 => createPgVendorSaleStore({ db: t2 }).record({ vendorId: v, actorId: v, sale: typedSale, fingerprint: saleFingerprint(typedSale) })), /customerType/);
    throw ROLLBACK;
  }), err => err === ROLLBACK);
  assert.equal((await db('VendorSale').where({ vendorId: v }).count({ n: '*' }).first()).n, '0', 'rolled back');
});
