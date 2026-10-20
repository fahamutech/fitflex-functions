// Vendor business tools · S5 — VAT: per-line half-up rounding inside VAT-inclusive prices, the S3 CHECK kept
// intact (vatIncludedTzs, vatTzs = 0), VAT only after the VRN is verified, tax profile (owner-only edits,
// KYC review, pushes), tax rates with maker ≠ checker, product VAT codes that never re-queue approval, and
// marketplace price / commission / payout unchanged for a VAT-registered vendor. Against the CI database.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { users, gyms, partnerGate, trainers, shopService, adminPaymentService } from '../src/bootstrap/services.mjs';
import { partnerSettlementAccounts } from '../src/bootstrap/collections.mjs';
import { createPayoutEligibility } from '../src/services/payout-eligibility.mjs';
import { createVendorSettlementService } from '../src/services/vendor-settlement-service.mjs';
import { createPartnerNotifier } from '../src/services/partner-notifier.mjs';
import { vendorToolsOptionsRoute, vendorCreateProduct, vendorUpdateProduct, vendorMyProducts, getShopProduct } from '../functions/shop.mjs';
import { vendorRecordSale, vendorGetSale, resetVendorSalesLimits } from '../functions/vendor-sales.mjs';
import { vendorDocumentView, resetVendorDocumentLimits } from '../functions/vendor-documents.mjs';
import {
  vendorGetTaxProfile, vendorPutTaxProfile, vendorTaxRates, adminListTaxRates, adminProposeTaxRate, adminApproveTaxRate, adminRejectTaxRate,
  adminWithdrawTaxRate, adminVendorVat, adminVerifyVendorVat, adminRejectVendorVat,
} from '../functions/vendor-tax.mjs';
import { includedVat, lineVat, vatForLines, vatSummary, normaliseVrn, normaliseTin, parseTaxRateProposal, rateStatuses } from '../src/shared/vendor-vat.mjs';
import { ratesOn, vatForSale } from '../src/infra/vendor-tax-store-pg.mjs';
import { eatDate } from '../src/shared/vendor-order-view.mjs';
import { addDays } from '../src/shared/vendor-customer.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [], orders: [], rates: [] };
const FLAGS = ['VENDOR_TOOLS', 'VENDOR_WALKIN_SALES', 'VENDOR_CUSTOMERS', 'VENDOR_DOCUMENTS', 'VENDOR_VAT'];
const on = (...only) => { for (const f of only.length ? only : FLAGS) process.env[f] = '1'; process.env.PUBLIC_API_URL = 'https://docs.fitflex.example'; };
afterEach(() => { for (const f of FLAGS) delete process.env[f]; delete process.env.PUBLIC_API_URL; resetVendorSalesLimits(); resetVendorDocumentLimits(); });

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; }, setHeader(k, v) { this.headers[k] = v; return this; },
    type() { return this; }, send(b) { this.body = b; return this; }, end(b) { this.body = b; return this; },
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
  return { status: out.statusCode, body: out.body };
}
async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `S5 ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
const as = id => ({ sub: id, userType: 'vendor' });
const staffOf = (id, vendorId) => ({ sub: id, userType: 'vendor_staff', vendorId });
const adminClaims = id => ({ sub: id, userType: 'admin' });
const portalAdmin = (id, scopes) => ({ sub: id, userType: 'admin', portalUser: true, aclPermissions: scopes });

/** A verified vendor with a KYC case (TIN on it) and an uploaded VAT certificate. */
async function vendor({ kycTin = '123456789' } = {}) {
  const id = await user('vendor', { createdAt: new Date('2026-01-01T00:00:00Z'), displayName: 'Vat Owner', vendorProfile: JSON.stringify({ businessName: 'VAT Shop', status: 'published', contactNumber: '+255700000001', address: 'Kariakoo, Dar' }) });
  const caseId = uid('kyc');
  await db('PartnerKycCase').insert({ id: caseId, partnerType: 'vendor', userId: id, status: 'approved', tier: 3, tin: kycTin, updatedAt: new Date() });
  await db('PartnerSettlementAccount').insert({
    id: uid('psa'), caseId, method: 'bank', provider: 'CRDB', accountName: 'VAT Shop', accountNumber: '0150009999',
    status: 'verified', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z'), cooldownUntil: new Date('2026-09-03T00:00:00Z'), updatedAt: new Date(),
  });
  const certId = uid('pdoc');
  await db('PartnerDocument').insert({
    id: certId, caseId, requirementKey: 'vat_certificate', docType: 'vat_certificate', storageProvider: 'spec', storageKey: `spec/${certId}.pdf`,
    mimeType: 'application/pdf', sizeBytes: 100, sha256: randomUUID().replace(/-/g, ''), status: 'pending', updatedAt: new Date(),
  });
  return { id, caseId, certId };
}
async function product(vendorId, body = {}) {
  const out = await call(vendorCreateProduct, as(vendorId), { body: { name: 'Whey 1kg', category: 'supplements_nutrition', priceTzs: 10_000, stock: 100, ...body } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  made.products.push(out.body.id);
  await shopService.adminUpdateProductListing({ productId: out.body.id, body: { approvalStatus: 'approved' }, actorId: 'adm_s5vat' });
  return out.body;
}
const saleBody = (lines, payments, extra = {}) => ({ clientRef: randomUUID(), lines, payments, ...extra });
const cash = amountTzs => [{ method: 'cash', amountTzs }];
async function sell(claims, body) {
  const out = await call(vendorRecordSale, claims, { body });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.sale;
}
async function registerAndVerify(v, admin = 'adm_kyc_reviewer') {
  const put = await call(vendorPutTaxProfile, as(v.id), { body: { vatRegistered: true, vrn: '40-012345-X' } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.taxProfile.status, 'pending');
  const ok = await call(adminVerifyVendorVat, adminClaims(admin), { params: { id: v.id } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  return ok.body;
}
const cart = items => ({ items, deliveryMethod: 'home_delivery', deliveryAddress: 'Kinondoni, Dar', paymentMethod: 'mpesa' });
async function paidOrder(buyerId, items) {
  const placed = await shopService.createOrder({ buyerId, body: cart(items) });
  assert.equal(placed.status, 202, JSON.stringify(placed));
  made.orders.push(placed.order.id);
  const paid = await adminPaymentService.decide({ id: placed.paymentRequest.id, decision: 'approve', reference: `MP-${randomUUID().slice(0, 8)}`, amountTzs: placed.order.totalTzs, actorId: uid('adm') });
  assert.equal(paid.paymentRequest.status, 'approved');
  return (await db('ShopOrder').where({ id: placed.order.id }).first());
}

after(async () => {
  const vendors = made.users;
  await db('AuditLog').whereIn('target', [...vendors, ...made.products, ...made.orders, ...made.rates]).del();
  await db('TaxRate').whereIn('id', made.rates).del();
  await db('VendorTaxProfile').whereIn('vendorId', vendors).del();
  await db('VendorDocumentLink').whereIn('vendorId', vendors).del();
  await db('VendorOrderInvoice').whereIn('vendorId', vendors).del();
  await db('VendorSettlementLine').whereIn('vendorId', vendors).del();
  await db('VendorSettlement').whereIn('vendorId', vendors).del();
  await db('VendorSale').whereIn('vendorId', vendors).del();
  await db('VendorCustomer').whereIn('vendorId', vendors).del();
  await db('VendorDocumentSequence').whereIn('vendorId', vendors).del();
  await db('VendorBuyerRef').whereIn('vendorId', vendors).del();
  await db('ShopOrderLineCost').whereIn('orderId', made.orders).del();
  await db('ShopStockMovement').whereIn('productId', made.products).del();
  await db('MarketplaceNotification').whereIn('userId', vendors).del();
  await db('Notification').whereIn('userId', vendors).del();
  await db('PaymentRequest').whereIn('orderId', made.orders).del();
  await db('ShopOrder').whereIn('id', made.orders).del();
  await db('ProductPrivate').whereIn('productId', made.products).del();
  await db('Product').whereIn('id', made.products).del();
  await db('PartnerDocument').whereIn('caseId', db('PartnerKycCase').whereIn('userId', vendors).select('id')).del();
  await db('PartnerSettlementAccount').whereIn('caseId', db('PartnerKycCase').whereIn('userId', vendors).select('id')).del();
  await db('PartnerKycCase').whereIn('userId', vendors).del();
  await db('User').whereIn('id', vendors).del().catch(() => {});
  await db.destroy();
});

// ── pure rules ───────────────────────────────────────────────────────────────

test('rounding (Q-6): VAT contained in the price, per line, half-up to a whole shilling', () => {
  assert.equal(includedVat(10_000, 18), 1525, '1,525.42 → 1,525');
  assert.equal(10_000 - includedVat(10_000, 18), 8475);
  assert.equal(includedVat(3, 100), 2, '1.5 → 2 (half-up)');
  assert.equal(includedVat(1, 100), 1, '0.5 → 1 (half-up)');
  assert.equal(includedVat(5, 100), 3, '2.5 → 3');
  assert.equal(includedVat(10_000, 0), 0);
  assert.equal(includedVat(10_000, null), 0, 'exempt');
  assert.equal(includedVat(0, 18), 0);
  assert.equal(includedVat(1_000, 16.5), Math.round((1_000 * 16.5) / 116.5), 'decimal rates in integer arithmetic');
  for (let net = 1; net < 20_000; net += 37) {
    const exact = (net * 18) / 118;
    assert.equal(includedVat(net, 18), Math.floor(exact + 0.5), `net ${net}`);
  }
  assert.deepEqual(lineVat(5_000, 'E', { ratePct: null, exempt: true }), { vatCode: 'E', vatRatePct: 0, vatTzs: 0, exempt: true });
  const rates = new Map([['A', { ratePct: 18, exempt: false }], ['C', { ratePct: 0, exempt: false }], ['E', { ratePct: null, exempt: true }]]);
  assert.deepEqual(vatForLines([{ productId: 'p', netTzs: 10_000 }, { productId: 'q', netTzs: 10_000 }], id => ({ p: 'B' })[id], rates).map(v => v.vatCode), ['A', 'A'],
    'no code → A; a code with no rate in force (B before counsel) → A');
  const s = vatSummary([
    { vatCode: 'A', vatRatePct: 18, vatTzs: 1373, netTzs: 9000 }, { vatCode: 'E', vatRatePct: 0, vatTzs: 0, netTzs: 4500 }, { vatCode: 'A', vatRatePct: 18, vatTzs: 153, netTzs: 1000 },
  ]);
  assert.deepEqual(s.rows, [{ code: 'A', ratePct: 18, netTzs: 8474, vatTzs: 1526 }, { code: 'E', ratePct: null, netTzs: 4500, vatTzs: 0 }]);
  assert.equal(s.totalVatTzs, 1526, 'document VAT = Σ line VAT');
  assert.equal(normaliseVrn('40-012345 x'), '40012345X');
  assert.equal(normaliseVrn('1234'), null);
  assert.equal(normaliseTin('123-456-789'), '123456789');
  assert.equal(normaliseTin('12345678'), null);
  const codes = new Map([['A', { exempt: false, inUse: true }], ['B', { exempt: false, inUse: false }], ['C', { exempt: false, inUse: true }], ['E', { exempt: true, inUse: true }]]);
  const p = b => parseTaxRateProposal({ reason: 'Finance Act', effectiveFrom: '2026-11-01', ...b }, { codes, tomorrow: '2026-10-21' });
  assert.deepEqual(p({ code: 'A', ratePct: 16 }), { code: 'A', ratePct: 16, effectiveFrom: '2026-11-01', reason: 'Finance Act' });
  assert.equal(p({ code: 'B', ratePct: 10 }).error, 'code_not_in_use');
  assert.equal(p({ code: 'C', ratePct: 5 }).error, 'invalid_rate');
  assert.equal(p({ code: 'E', ratePct: 0 }).error, 'invalid_rate');
  assert.deepEqual(p({ code: 'E', exempt: true }).ratePct, null);
  assert.equal(p({ code: 'A', ratePct: 16.555 }).error, 'invalid_rate');
  assert.equal(p({ code: 'A', ratePct: 16, effectiveFrom: '2026-10-20' }).error, 'effective_date_past');
  const st = rateStatuses([
    { id: '1', code: 'A', status: 'approved', effectiveFrom: '2000-01-01' }, { id: '2', code: 'A', status: 'approved', effectiveFrom: '2026-10-01' },
    { id: '3', code: 'A', status: 'approved', effectiveFrom: '2026-12-01' }, { id: '4', code: 'A', status: 'pending', effectiveFrom: '2027-01-01' },
  ], '2026-10-20');
  assert.deepEqual([...st.entries()].map(([id, x]) => [id, x.status, x.effectiveTo]), [
    ['1', 'ended', '2026-09-30'], ['2', 'active', '2026-11-30'], ['3', 'scheduled', null], ['4', 'pending', null]]);
});

test('notifications: vendor_vat_verified / vendor_vat_rejected in the vendor\'s language, Swahili in data', async () => {
  const sent = [];
  const notifier = createPartnerNotifier({
    users: { findByIdAsync: async () => null }, gyms: {}, trainers: {}, subscriptions: {}, paymentRequests: {},
    preferences: { findByIdAsync: async id => ({ locale: id === 'en_user' ? 'en' : 'sw' }) },
    notify: async (userId, message) => { sent.push({ userId, message }); },
  });
  await notifier.vendorEvent('en_user', 'vendor_vat_verified', { open: 'tax' });
  await notifier.vendorEvent('sw_user', 'vendor_vat_rejected', { reason: 'unreadable' });
  assert.equal(sent[0].message.title, 'VAT details verified');
  assert.equal(sent[0].message.body, 'Your TIN and VRN now show on your receipts and invoices.');
  assert.equal(sent[0].message.data.open, 'tax');
  assert.equal(sent[0].message.data.titleSw, 'Taarifa za VAT zimethibitishwa');
  assert.equal(sent[1].message.title, 'Taarifa za VAT hazikukubaliwa');
  assert.equal(sent[1].message.body, 'Fungua Taarifa za kodi uone sababu na uzitume tena.');
  assert.equal(sent[1].message.type, 'vendor_vat_rejected');
});

// ── gating ───────────────────────────────────────────────────────────────────

test('flags: VENDOR_VAT off → tax routes 404 feature_disabled, no VAT on sales even for a verified vendor; options report vat', async () => {
  const v = await vendor();
  for (const [route, claims, params] of [[vendorGetTaxProfile, as(v.id), {}], [vendorPutTaxProfile, as(v.id), {}], [vendorTaxRates, as(v.id), {}],
    [adminListTaxRates, adminClaims('adm_1'), {}], [adminProposeTaxRate, adminClaims('adm_1'), {}], [adminApproveTaxRate, adminClaims('adm_1'), { id: 'x' }],
    [adminVendorVat, adminClaims('adm_1'), { id: v.id }], [adminVerifyVendorVat, adminClaims('adm_1'), { id: v.id }]]) {
    assert.deepEqual((await call(route, claims, { params })).body, { error: 'feature_disabled' }, route.path);
  }
  on();
  assert.equal((await call(vendorToolsOptionsRoute, as(v.id))).body.vat, true);
  await registerAndVerify(v);
  const p = await product(v.id);
  delete process.env.VENDOR_VAT;
  const sale = await sell(as(v.id), saleBody([{ productId: p.id, qty: 1 }], cash(10_000)));
  const row = await db('VendorSale').where({ id: sale.id }).first();
  assert.deepEqual([row.vatIncludedTzs, row.vatTzs, row.sellerSnapshot.vrn], [0, 0, null], 'flag off: no VAT, no VRN');
});

// ── VAT on walk-in sales ─────────────────────────────────────────────────────

test('VRN before VAT (O-12): none or pending → VAT 0 and no TIN/VRN; verified → VAT from then on; earlier and back-dated sales unchanged', async () => {
  on();
  const v = await vendor();
  const p = await product(v.id, { name: 'Protein', priceTzs: 10_000 });
  const before = await sell(as(v.id), saleBody([{ productId: p.id, qty: 1 }], cash(10_000)));
  assert.deepEqual([before.vatIncludedTzs, before.vatSummary, before.lines[0].vatCode], [0, [], null]);
  const put = await call(vendorPutTaxProfile, as(v.id), { body: { vatRegistered: true, vrn: '40012345X' } });
  assert.equal(put.body.taxProfile.status, 'pending');
  assert.equal(put.body.taxProfile.inForce, false);
  assert.deepEqual([put.body.taxProfile.tin, put.body.taxProfile.tinFromKyc], ['123456789', true], 'TIN from the KYC case');
  const pending = await sell(as(v.id), saleBody([{ productId: p.id, qty: 1 }], cash(10_000)));
  assert.equal(pending.vatIncludedTzs, 0, 'pending → no VAT');
  const pendingDoc = (await call(vendorDocumentView, as(v.id), { params: { docType: 'sale', docId: pending.id } })).body.doc;
  assert.equal(pendingDoc.seller.vrn, undefined);
  assert.equal(pendingDoc.seller.tin, undefined);

  const verified = await call(adminVerifyVendorVat, adminClaims('adm_kyc'), { params: { id: v.id } });
  assert.equal(verified.body.taxProfile.inForce, true);
  assert.equal((await db('PartnerDocument').where({ id: v.certId }).first()).status, 'accepted', 'the certificate document is accepted');
  const pushed = await db('MarketplaceNotification').where({ userId: v.id, type: 'vendor_vat_verified' });
  assert.equal(pushed.length, 1, 'vendor told (push + inbox)');

  const after1 = await sell(as(v.id), saleBody([{ productId: p.id, qty: 1 }], cash(10_000)));
  assert.equal(after1.vatIncludedTzs, 1525, 'TSh 10,000 code A → includes VAT 1,525');
  assert.equal(after1.totalTzs, 10_000, 'the customer total does not change');
  assert.deepEqual(after1.vatSummary, [{ code: 'A', ratePct: 18, netTzs: 8475, vatTzs: 1525 }]);
  const doc = (await call(vendorDocumentView, as(v.id), { params: { docType: 'sale', docId: after1.id } })).body.doc;
  assert.deepEqual([doc.seller.tin, doc.seller.vrn, doc.vatIncludedTzs], ['123456789', '40012345X', 1525]);
  const html = (await call(vendorDocumentView, as(v.id), { params: { docType: 'sale', docId: after1.id }, query: { format: 'html' } })).body;
  assert.match(html, /Includes VAT TSh 1,525/);
  assert.match(html, /<td>A<\/td><td>18%<\/td><td class="n">TSh 8,475<\/td><td class="n">TSh 1,525<\/td>/);
  // Earlier sales keep VAT 0.
  for (const s of [before, pending]) assert.equal((await db('VendorSale').where({ id: s.id }).first()).vatIncludedTzs, 0);
  // A sale back-dated (offline) to before the verification gets no VAT.
  const verifiedAt = (await db('VendorTaxProfile').where({ vendorId: v.id }).first()).verifiedAt;
  const backdated = await sell(as(v.id), saleBody([{ productId: p.id, qty: 1 }], cash(10_000), { soldAt: new Date(+verifiedAt - 60_000).toISOString() }));
  assert.equal(backdated.vatIncludedTzs, 0);
  // Turning VAT off stops it on new sales at once; old documents keep theirs.
  const stop = await call(vendorPutTaxProfile, as(v.id), { body: { vatRegistered: false } });
  assert.deepEqual([stop.body.taxProfile.inForce, stop.body.taxProfile.status], [false, 'verified']);
  assert.equal((await sell(as(v.id), saleBody([{ productId: p.id, qty: 1 }], cash(10_000)))).vatIncludedTzs, 0);
  assert.equal((await call(vendorGetSale, as(v.id), { params: { id: after1.id } })).body.sale.vatIncludedTzs, 1525);
  // Back on with the same verified details: in force again, no review.
  const back = await call(vendorPutTaxProfile, as(v.id), { body: { vatRegistered: true, vrn: '40012345X' } });
  assert.deepEqual([back.body.taxProfile.status, back.body.taxProfile.inForce], ['verified', true]);
});

test('mixed sale: A 10,000 + E 5,000 with a 1,500 sale discount — shared, rounded per line, summary = Σ lines; CHECKs hold', async () => {
  on();
  const v = await vendor();
  await registerAndVerify(v);
  const a = await product(v.id, { name: 'Standard item', priceTzs: 10_000 });
  const e = await call(vendorCreateProduct, as(v.id), { body: { name: 'Exempt item', category: 'supplements_nutrition', priceTzs: 5_000, stock: 50, vatCode: 'E' } });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  assert.equal(e.body.vatCode, 'E');
  made.products.push(e.body.id);
  const sale = await sell(as(v.id), saleBody([{ productId: a.id, qty: 1 }, { productId: e.body.id, qty: 1 }], cash(13_500), { discountTzs: 1_500 }));
  assert.equal(sale.totalTzs, 13_500);
  const lines = await db('VendorSaleLine').where({ saleId: sale.id }).orderBy('lineNo');
  assert.deepEqual(lines.map(l => [l.vatCode, Number(l.vatRatePct), l.saleDiscountShareTzs, l.vatTzs]), [['A', 18, 1000, 1373], ['E', 0, 500, 0]],
    '9,000 × 18/118 = 1,372.88 → 1,373');
  const row = await db('VendorSale').where({ id: sale.id }).first();
  assert.equal(row.vatIncludedTzs, lines.reduce((s, l) => s + l.vatTzs, 0));
  assert.equal(row.vatTzs, 0, 'VAT added stays 0 (prices include VAT)');
  assert.equal(row.totalTzs, row.subtotalTzs - row.lineDiscountTzs - row.discountTzs + row.vatTzs, 'the S3 CHECK still adds up');
  assert.deepEqual(sale.vatSummary, [{ code: 'A', ratePct: 18, netTzs: 7627, vatTzs: 1373 }, { code: 'E', ratePct: null, netTzs: 4500, vatTzs: 0 }]);
  const html = (await call(vendorDocumentView, as(v.id), { params: { docType: 'sale', docId: sale.id }, query: { format: 'html' } })).body;
  assert.match(html, /<td>E<\/td><td>Exempt<\/td>/, 'E reads Exempt, never 0%');
  // The database refuses VAT added on top, and a line VAT above its net.
  await assert.rejects(db('VendorSale').where({ id: sale.id }).update({ vatTzs: 100, totalTzs: 13_600, paidTzs: 13_600 }), /vendorsale_vat_added_zero/);
  await assert.rejects(db('VendorSaleLine').where({ id: lines[0].id }).update({ vatTzs: 9_001 }), /vendorsaleline_vat_range/);
  await assert.rejects(db('VendorSale').where({ id: sale.id }).update({ vatIncludedTzs: 13_501 }), /vendorsale_vat_included_range/);
  await assert.rejects(db('VendorSaleLine').where({ id: lines[1].id }).update({ vatCode: 'Z' }), /vendorsaleline_vat_code_check/);
});

test('a pending change keeps the verified VRN in force until it is verified; rejection keeps it too and tells the vendor', async () => {
  on();
  const v = await vendor();
  await registerAndVerify(v);
  const p = await product(v.id);
  const change = await call(vendorPutTaxProfile, as(v.id), { body: { vatRegistered: true, vrn: '40099999Y' } });
  assert.deepEqual([change.body.taxProfile.status, change.body.taxProfile.changePending, change.body.taxProfile.inForce, change.body.taxProfile.vrn],
    ['pending', true, true, '40099999Y']);
  assert.equal(change.body.taxProfile.verified.vrn, '40012345X');
  const sale = await sell(as(v.id), saleBody([{ productId: p.id, qty: 1 }], cash(10_000)));
  assert.equal((await db('VendorSale').where({ id: sale.id }).first()).sellerSnapshot.vrn, '40012345X', 'documents keep the old VRN');
  assert.equal(sale.vatIncludedTzs, 1525);
  // Not accepted: reason "other" needs a note; the verified details stay in force.
  assert.equal((await call(adminRejectVendorVat, adminClaims('adm_kyc'), { params: { id: v.id }, body: { reason: 'other' } })).body.error, 'note_required');
  assert.equal((await call(adminRejectVendorVat, adminClaims('adm_kyc'), { params: { id: v.id }, body: { reason: 'nope' } })).body.error, 'invalid_reason');
  const rejected = await call(adminRejectVendorVat, adminClaims('adm_kyc'), { params: { id: v.id }, body: { reason: 'number_mismatch' } });
  assert.equal(rejected.status, 200);
  assert.deepEqual([rejected.body.taxProfile.status, rejected.body.taxProfile.rejectReason, rejected.body.taxProfile.inForce], ['rejected', 'number_mismatch', true]);
  assert.equal((await db('MarketplaceNotification').where({ userId: v.id, type: 'vendor_vat_rejected' })).length, 1);
  assert.deepEqual((await call(adminVerifyVendorVat, adminClaims('adm_kyc'), { params: { id: v.id } })).body, { error: 'nothing_to_review', currentStatus: 'rejected' });
  assert.equal((await sell(as(v.id), saleBody([{ productId: p.id, qty: 1 }], cash(10_000)))).vatIncludedTzs, 1525);
});

test('Q-10 setting (default off): the KYC TIN of a vendor who is not VAT-registered shows only with VENDOR_DOCUMENTS_TIN_WITHOUT_VAT', async () => {
  on();
  const v = await vendor({ kycTin: '555666777' });
  await db('PartnerDocument').insert({
    id: uid('pdoc'), caseId: v.caseId, requirementKey: 'tin_certificate', docType: 'tin_certificate', storageProvider: 'spec', storageKey: 'spec/tin.pdf',
    mimeType: 'application/pdf', sizeBytes: 100, sha256: randomUUID().replace(/-/g, ''), status: 'accepted', updatedAt: new Date(),
  });
  const p = await product(v.id);
  const offSale = await sell(as(v.id), saleBody([{ productId: p.id, qty: 1 }], cash(10_000)));
  assert.equal((await db('VendorSale').where({ id: offSale.id }).first()).sellerSnapshot.tin, null, 'default: no TIN without a verified VRN (O-12)');
  process.env.VENDOR_DOCUMENTS_TIN_WITHOUT_VAT = '1';
  try {
    const onSale = await sell(as(v.id), saleBody([{ productId: p.id, qty: 1 }], cash(10_000)));
    const snap = (await db('VendorSale').where({ id: onSale.id }).first()).sellerSnapshot;
    assert.deepEqual([snap.tin, snap.vrn, onSale.vatIncludedTzs], ['555666777', null, 0], 'TIN only; no VRN, no VAT');
  } finally { delete process.env.VENDOR_DOCUMENTS_TIN_WITHOUT_VAT; }
});

// ── tax profile rules ────────────────────────────────────────────────────────

test('tax profile: owner only edits (403 owner_only); staff with payments read; validation; 409 tax_profile_changed; KYC section', async () => {
  on();
  const v = await vendor({ kycTin: null });
  const payments = await user('vendor_staff', { vendorId: v.id, vendorPermissions: ['payments'], accountStatus: 'active', vendorRole: 'customer_care' });
  const salesOnly = await user('vendor_staff', { vendorId: v.id, vendorPermissions: ['sales'], accountStatus: 'active', vendorRole: 'sales' });
  assert.deepEqual((await call(vendorPutTaxProfile, staffOf(payments, v.id), { body: { vatRegistered: true, vrn: '40012345X' } })).body, { error: 'owner_only' });
  assert.equal((await call(vendorGetTaxProfile, staffOf(payments, v.id))).status, 200);
  assert.equal((await call(vendorGetTaxProfile, staffOf(salesOnly, v.id))).status, 403);
  assert.equal((await call(vendorGetTaxProfile, as(v.id))).body.taxProfile.status, 'none');
  const put = body => call(vendorPutTaxProfile, as(v.id), { body });
  assert.deepEqual((await put({ vatRegistered: true, vrn: '12' })).body, { error: 'vrn_invalid' });
  assert.deepEqual((await put({ vatRegistered: true, vrn: '40012345X' })).body, { error: 'tin_required' }, 'no KYC TIN: the vendor enters it');
  assert.deepEqual((await put({ vatRegistered: true, vrn: '40012345X', tin: '12' })).body, { error: 'tin_invalid' });
  assert.deepEqual((await put({ vatRegistered: true, vrn: '40012345X', tin: '987654321', pricesIncludeVat: false })).body, { error: 'prices_include_vat_locked' });
  assert.deepEqual((await put({ vatRegistered: 'yes' })).body, { error: 'invalid_field', field: 'vatRegistered' });
  await db('PartnerDocument').where({ id: v.certId }).update({ status: 'rejected' });
  assert.deepEqual((await put({ vatRegistered: true, vrn: '40012345X', tin: '987654321' })).body, { error: 'certificate_required' });
  await db('PartnerDocument').where({ id: v.certId }).update({ status: 'pending' });
  const ok = await put({ vatRegistered: true, vrn: '40012345X', tin: '987-654-321' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.taxProfile.tin, ok.body.taxProfile.tinFromKyc, ok.body.taxProfile.certificateDocumentId, ok.body.taxProfile.pricesIncludeVat], ['987654321', false, v.certId, true]);
  assert.deepEqual((await put({ vatRegistered: true, vrn: '40012345Z', tin: '987654321', updatedAt: '2020-01-01T00:00:00.000Z' })).body.error, 'tax_profile_changed');
  // KYC reviewer view: TIN mismatch when the case's TIN differs.
  await db('PartnerKycCase').where({ id: v.caseId }).update({ tin: '111222333' });
  const kyc = await call(adminVendorVat, adminClaims('adm_kyc'), { params: { id: v.id } });
  assert.deepEqual([kyc.body.kycTin, kyc.body.tinMismatch, kyc.body.certificate.id], ['111222333', true, v.certId]);
  assert.equal((await call(adminVendorVat, portalAdmin('adm_nokyc', ['payments']), { params: { id: v.id } })).status, 403, 'needs the kyc scope');
  assert.deepEqual((await call(adminVerifyVendorVat, adminClaims('adm_kyc'), { params: { id: (await vendor()).id } })).body, { error: 'tax_profile_not_found' });
});

// ── tax rates: maker ≠ checker ───────────────────────────────────────────────

test('tax rates: seeded A 18 / C 0 / E exempt, B and D not in use; maker ≠ checker (API and database); future dates only; history', async () => {
  on();
  const list = await call(adminListTaxRates, adminClaims('adm_maker'));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.codes.map(c => [c.code, c.status]), [['A', 'active'], ['B', 'unused'], ['C', 'active'], ['D', 'unused'], ['E', 'active']]);
  const seeded = list.body.rates.filter(r => r.id.startsWith('txr_seed_'));
  assert.deepEqual(seeded.map(r => [r.code, r.ratePct, r.exempt, r.status]), [['A', 18, false, 'active'], ['C', 0, false, 'active'], ['E', null, true, 'active']]);
  const vendorList = await call(vendorTaxRates, as((await vendor()).id));
  assert.deepEqual(vendorList.body.codes.map(c => [c.code, c.ratePct, c.exempt]), [['A', 18, false], ['C', 0, false], ['E', null, true]], 'B and D are not offered');

  const today = eatDate(new Date());
  const tomorrow = addDays(today, 1);
  assert.deepEqual((await call(adminProposeTaxRate, adminClaims('adm_maker'), { body: { code: 'A', ratePct: 16, effectiveFrom: today, reason: 'Test' } })).body,
    { error: 'effective_date_past', earliest: tomorrow });
  assert.equal((await call(adminProposeTaxRate, adminClaims('adm_maker'), { body: { code: 'B', ratePct: 10, effectiveFrom: tomorrow, reason: 'Test' } })).body.error, 'code_not_in_use');
  assert.equal((await call(adminProposeTaxRate, portalAdmin('adm_kyc_only', ['kyc']), { body: {} })).status, 403, 'needs the payments scope');
  const proposed = await call(adminProposeTaxRate, adminClaims('adm_maker'), { body: { code: 'A', ratePct: 16, effectiveFrom: tomorrow, reason: 'Spec: rate change from tomorrow' } });
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
  const id = proposed.body.rate.id;
  made.rates.push(id);
  assert.deepEqual((await call(adminApproveTaxRate, adminClaims('adm_maker'), { params: { id } })).body, { error: 'same_admin' });
  assert.deepEqual((await call(adminRejectTaxRate, adminClaims('adm_maker'), { params: { id }, body: { reason: 'x' } })).body, { error: 'same_admin' });
  assert.deepEqual((await call(adminWithdrawTaxRate, adminClaims('adm_checker'), { params: { id } })).body, { error: 'not_proposer' });
  // The database refuses it too.
  await assert.rejects(db('TaxRate').where({ id }).update({ status: 'approved', decidedBy: 'adm_maker', decidedAt: new Date() }), /taxrate_maker_checker/);
  const approved = await call(adminApproveTaxRate, adminClaims('adm_checker'), { params: { id } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual([approved.body.rate.status, approved.body.rate.decidedBy], ['approved', 'adm_checker']);
  const after1 = await call(adminListTaxRates, adminClaims('adm_maker'));
  const row = after1.body.rates.find(r => r.id === id);
  assert.equal(row.status, 'scheduled');
  assert.deepEqual(row.history.map(h => [h.action, h.actor]), [['tax_rate_proposed', 'adm_maker'], ['tax_rate_approved', 'adm_checker']]);
  assert.equal(after1.body.rates.find(r => r.id === 'txr_seed_a').effectiveTo, today, 'the old rate ends today');
  // Today's sales keep 18%; from tomorrow 16% (rates are read for the sale's EAT day).
  assert.equal((await ratesOn(db, today)).get('A').ratePct, 18);
  assert.equal((await ratesOn(db, tomorrow)).get('A').ratePct, 16);
  const v = await vendor();
  await registerAndVerify(v);
  const p = await product(v.id);
  assert.equal((await sell(as(v.id), saleBody([{ productId: p.id, qty: 1 }], cash(10_000)))).vatIncludedTzs, 1525, 'today: 18%');
  const tomorrowNoon = new Date(`${tomorrow}T09:00:00Z`);
  const next = await vatForSale(db, { vendorId: v.id, at: tomorrowNoon, lines: [{ productId: p.id, netTzs: 10_000 }], vatOn: true });
  assert.deepEqual([next.lines[0].vatRatePct, next.lines[0].vatTzs], [16, 1379], 'tomorrow: 16% (10,000 × 16/116 = 1,379.31)');
  // A second approved rate for the same code and day is refused; withdraw and reject work.
  const dup = await call(adminProposeTaxRate, adminClaims('adm_other'), { body: { code: 'A', ratePct: 15, effectiveFrom: tomorrow, reason: 'Duplicate day' } });
  made.rates.push(dup.body.rate.id);
  assert.equal((await call(adminApproveTaxRate, adminClaims('adm_checker'), { params: { id: dup.body.rate.id } })).body.error, 'rate_conflict');
  assert.equal((await call(adminRejectTaxRate, adminClaims('adm_checker'), { params: { id: dup.body.rate.id }, body: {} })).body.error, 'reason_required');
  assert.equal((await call(adminRejectTaxRate, adminClaims('adm_checker'), { params: { id: dup.body.rate.id }, body: { reason: 'Same day as another' } })).body.rate.status, 'rejected');
  const w = await call(adminProposeTaxRate, adminClaims('adm_other'), { body: { code: 'C', ratePct: 0, effectiveFrom: addDays(today, 30), reason: 'Withdraw me' } });
  made.rates.push(w.body.rate.id);
  assert.equal((await call(adminWithdrawTaxRate, adminClaims('adm_other'), { params: { id: w.body.rate.id } })).body.rate.status, 'withdrawn');
  const notPending = await call(adminApproveTaxRate, adminClaims('adm_checker'), { params: { id: w.body.rate.id } });
  assert.deepEqual([notPending.status, notPending.body], [409, { error: 'tax_rate_not_pending', currentStatus: 'withdrawn' }]);
  // Clean up the scheduled change now, so no other spec meets a 16% rate tomorrow.
  await db('TaxRate').whereIn('id', made.rates).del();
});

// ── products ─────────────────────────────────────────────────────────────────

test('product VAT code: private, never re-queues approval or delists, never on /shop; invalid → 400; ignored with VAT off', async () => {
  on();
  const v = await vendor();
  const p = await product(v.id, { name: 'Coded' });
  assert.equal(p.vatCode, 'A', 'default A');
  const put = await call(vendorUpdateProduct, as(v.id), { params: { id: p.id }, body: { name: 'Coded', priceTzs: 10_000, vatCode: 'C' } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const stored = await db('Product').where({ id: p.id }).first();
  assert.equal(stored.approvalStatus, 'approved', 'not back to pending');
  assert.equal('vatCode' in stored, false, 'not on the public row');
  assert.equal((await db('ProductPrivate').where({ productId: p.id, variant: '' }).first()).vatCode, 'C');
  assert.equal((await call(vendorMyProducts, as(v.id))).body.find(x => x.id === p.id).vatCode, 'C');
  const shop = await call(getShopProduct, { sub: await user('member'), userType: 'member' }, { params: { id: p.id } });
  assert.equal(shop.status, 200);
  assert.equal(JSON.stringify(shop.body).includes('vatCode'), false, '/shop never shows it');
  assert.equal(JSON.stringify(await shopService.listProducts({ vendorId: v.id })).includes('vatCode'), false);
  const bad = await call(vendorUpdateProduct, as(v.id), { params: { id: p.id }, body: { vatCode: 'B' } });
  assert.deepEqual(bad.body, { error: 'invalid_vat_code', allowed: ['A', 'C', 'E'] });
  delete process.env.VENDOR_VAT;
  await call(vendorUpdateProduct, as(v.id), { params: { id: p.id }, body: { vatCode: 'E' } });
  assert.equal((await db('ProductPrivate').where({ productId: p.id, variant: '' }).first()).vatCode, 'C', 'flag off: ignored');
  assert.equal('vatCode' in (await call(vendorMyProducts, as(v.id))).body.find(x => x.id === p.id), false);
});

// ── marketplace untouched (O-10) ─────────────────────────────────────────────

test('marketplace: a VAT-verified vendor\'s order has the same price, commission, payout and settlement; VAT only on the vendor invoice', async () => {
  on();
  const plainV = await vendor();
  const vatV = await vendor();
  await registerAndVerify(vatV);
  const pPlain = await product(plainV.id, { name: 'Mat', priceTzs: 59_000 });
  const pVat = await product(vatV.id, { name: 'Mat', priceTzs: 59_000 });
  const buyer = await user('member', { displayName: 'Same Buyer' });
  const o1 = await paidOrder(buyer, [{ productId: pPlain.id, qty: 2 }]);
  const o2 = await paidOrder(buyer, [{ productId: pVat.id, qty: 2 }]);
  const money = o => ({ total: o.totalTzs, items: o.items.map(i => [i.qty, i.priceTzs, i.commissionPct, i.commissionTzs, i.vendorPayoutTzs]) });
  assert.deepEqual(money(o2), money(o1), 'checkout price, commission (on the VAT-inclusive gross) and payout are identical');
  const inv1 = await db('VendorOrderInvoice').where({ orderId: o1.id }).first();
  const inv2 = await db('VendorOrderInvoice').where({ orderId: o2.id }).first();
  assert.deepEqual([inv1.vatApplied, inv1.vatIncludedTzs], [false, 0]);
  assert.deepEqual([inv2.vatApplied, inv2.vatIncludedTzs, inv2.totalTzs], [true, includedVat(118_000, 18), 118_000]);
  assert.equal(inv2.vatIncludedTzs, 18_000, '118,000 × 18/118');
  assert.deepEqual(inv2.lines.map(l => [l.vatCode, l.vatRatePct, l.vatTzs]), [['A', 18, 18_000]]);
  assert.deepEqual([inv2.sellerSnapshot.tin, inv2.sellerSnapshot.vrn], ['123456789', '40012345X']);
  assert.equal(JSON.stringify(inv2).includes('commission'), false);
  // Settlement: deliver both, prepare, compare.
  for (const [o, v] of [[o1, plainV.id], [o2, vatV.id]]) {
    for (const status of ['accepted', 'dispatched', 'delivered']) assert.equal((await shopService.updateOrderStatus({ orderId: o.id, status, actorId: v })).order.status, status);
  }
  const clock = new Date(Date.now() + 7 * 86_400_000);
  const settlements = createVendorSettlementService({ users, payoutEligibility: createPayoutEligibility({ users, gyms, partnerGate, partnerSettlementAccounts, trainers }), now: () => clock });
  assert.equal((await settlements.prepare({ actorId: 'adm_vat' })).error, undefined);
  const statement = async vendorId => (await db('VendorSettlementLine').where({ vendorId, voided: false })).map(l => [l.salesTzs, l.commissionTzs, l.payoutTzs]);
  assert.deepEqual(await statement(vatV.id), await statement(plainV.id), 'settlement lines are the same');
  assert.ok((await statement(vatV.id)).length === 1);
  assert.deepEqual((await shopService.vendorPayments(vatV.id)).weeklySalesTzs, (await shopService.vendorPayments(plainV.id)).weeklySalesTzs);
});

// ── security review #229 L3 ──────────────────────────────────────────────────

test('#229 L3: verify refuses a certificate that is no longer the current one; a rejected verified certificate stops VAT at once (fail closed)', async () => {
  on();
  const v = await vendor();
  const p = await product(v.id);
  assert.equal((await call(vendorPutTaxProfile, as(v.id), { body: { vatRegistered: true, vrn: '40012345X' } })).status, 200);
  // The vendor uploads a newer certificate after submitting: the submitted one is no longer current.
  const newer = uid('pdoc');
  await db('PartnerDocument').insert({
    id: newer, caseId: v.caseId, requirementKey: 'vat_certificate', docType: 'vat_certificate', storageProvider: 'spec', storageKey: `spec/${newer}.pdf`,
    mimeType: 'application/pdf', sizeBytes: 100, sha256: randomUUID().replace(/-/g, ''), status: 'pending', supersedesId: v.certId,
    createdAt: new Date(Date.now() + 1000), updatedAt: new Date(),
  });
  assert.deepEqual((await call(adminVerifyVendorVat, adminClaims('adm_kyc'), { params: { id: v.id } })).body, { error: 'certificate_not_current' });
  assert.equal((await db('VendorTaxProfile').where({ vendorId: v.id }).first()).status, 'pending', 'nothing verified');
  // Re-submitted with the newer certificate → verified.
  assert.equal((await call(vendorPutTaxProfile, as(v.id), { body: { vatRegistered: true, vrn: '40012345X' } })).body.taxProfile.certificateDocumentId, newer);
  assert.equal((await call(adminVerifyVendorVat, adminClaims('adm_kyc'), { params: { id: v.id } })).status, 200);
  assert.equal((await sell(as(v.id), saleBody([{ productId: p.id, qty: 1 }], cash(10_000)))).vatIncludedTzs, 1525);
  // A KYC reviewer later rejects that certificate: VAT, TIN and VRN stop on new sales; the profile says so.
  await db('PartnerDocument').where({ id: newer }).update({ status: 'rejected', reviewNote: 'forged' });
  const profile = (await call(vendorGetTaxProfile, as(v.id))).body.taxProfile;
  assert.deepEqual([profile.inForce, profile.verified.certificateStands, profile.status], [false, false, 'verified']);
  const after1 = await sell(as(v.id), saleBody([{ productId: p.id, qty: 1 }], cash(10_000)));
  const row = await db('VendorSale').where({ id: after1.id }).first();
  assert.deepEqual([row.vatIncludedTzs, row.sellerSnapshot.vrn, row.sellerSnapshot.tin], [0, null, null]);
  // An accepted renewal (old one superseded) keeps VAT in force.
  await db('PartnerDocument').where({ id: newer }).update({ status: 'superseded' });
  assert.equal((await call(vendorGetTaxProfile, as(v.id))).body.taxProfile.inForce, true, 'superseded by an accepted renewal still stands');
});
