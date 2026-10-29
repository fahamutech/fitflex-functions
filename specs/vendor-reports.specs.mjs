// Vendor business tools · S6 — vendor reports + CSV/PDF export. Against the CI database.
// Data is written straight into the tables with fixed dates, and the report service runs on a PINNED clock
// (no real "today" in any figure assertion; the 21:00–22:00 UTC day-boundary flake cannot happen).
// Covers: totals = line sums, EAT day boundaries (23:30 vs 00:30 EAT), voided and late-recorded sales, app
// refunds on the cancellation date, unknown cost never 0, profit ex-VAT minus commission, days of cover,
// stock value, payment methods (cash after change, PMT), customers, marketplace net == prepared / submitted /
// paid VendorSettlement, permissions and tenancy, CSV (BOM, CRLF, EN/SW headers, formula injection), limits
// and 413, PDF (+ 503 when pdfkit is missing), one audit row per export, ShopOrder.paidAt set on payment and
// its backfill (idempotent), /vendor/payments net fields, and the safe statement CSV.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { users, shopService, adminPaymentService, gyms, partnerGate, trainers } from '../src/bootstrap/services.mjs';
import { auditLog, partnerSettlementAccounts } from '../src/bootstrap/collections.mjs';
import { createVendorReportService } from '../src/services/vendor-report-service.mjs';
import { createPgVendorReportStore } from '../src/infra/vendor-report-store-pg.mjs';
import { createVendorSettlementService } from '../src/services/vendor-settlement-service.mjs';
import { createPayoutEligibility } from '../src/services/payout-eligibility.mjs';
import { priceOrderLine } from '../src/shared/marketplace-pricing.mjs';
import { csvCell, csvDocument, CSV_BOM } from '../src/shared/csv-export.mjs';
import { parseReportQuery, bucketsOf, cover, createReportCache, periodInWords, REPORT_LIMITS } from '../src/shared/vendor-reports.mjs';
import { setPdfkitLoaderForTests } from '../src/shared/vendor-document-pdf.mjs';
import { vendorToolsOptionsRoute } from '../functions/shop.mjs';
import {
  vendorReportSummary, vendorReportSales, vendorReportProducts, vendorReportStockValue, vendorReportProfit, vendorReportMarketplaceNet,
  vendorReportCustomers, vendorReportPaymentMethods, resetVendorReportCache,
} from '../functions/vendor-reports.mjs';

const migration = createRequire(import.meta.url)('../db/migrations/20270122090000-vendor-reports-paid-at.cjs');

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [], orders: [] };
const FLAGS = ['VENDOR_TOOLS', 'VENDOR_REPORTS', 'VENDOR_STOCK_LEDGER', 'VENDOR_CUSTOMERS'];
const flagsOn = (list = FLAGS) => { for (const f of list) process.env[f] = '1'; };
afterEach(() => { for (const f of FLAGS) delete process.env[f]; resetVendorReportCache(); setPdfkitLoaderForTests(null); });

// ── harness ─────────────────────────────────────────────────────────────────

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; }, setHeader(k, v) { this.headers[k] = v; return this; },
    type() { return this; }, send(b) { this.body = b; return this; }, end(b) { this.body = b; return this; },
  };
}
async function call(route, claims, { query = {} } = {}) {
  const all = { authorization: `Bearer ${sign(claims)}` };
  const path = route.path;
  const req = { method: 'GET', baseUrl: path, path: '/', headers: all, params: {}, query, body: {}, get: name => all[String(name).toLowerCase()] ?? null };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return { status: out.statusCode, body: out.body, headers: out.headers };
  }
  await route.onRequest(req, out);
  return { status: out.statusCode, body: out.body, headers: out.headers };
}
async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `S6 ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
async function vendor(name = 'Dar Fitness Gear', { payable = false } = {}) {
  const id = await user('vendor', { displayName: 'Asha Owner', vendorProfile: JSON.stringify({ businessName: name, status: 'published' }), accountStatus: 'active', approvalStatus: 'approved' });
  if (payable) {
    const caseId = uid('kyc');
    await db('PartnerKycCase').insert({ id: caseId, partnerType: 'vendor', userId: id, status: 'approved', tier: 3, updatedAt: new Date() });
    await db('PartnerSettlementAccount').insert({
      id: uid('psa'), caseId, method: 'bank', provider: 'CRDB', accountName: name, accountNumber: '0150001234', status: 'verified', isPrimary: true,
      verifiedAt: new Date('2025-01-01T00:00:00Z'), cooldownUntil: new Date('2025-01-03T00:00:00Z'), updatedAt: new Date(),
    });
  }
  return id;
}
const as = id => ({ sub: id, userType: 'vendor' });
const staffOf = (id, vendorId) => ({ sub: id, userType: 'vendor_staff', vendorId });
const staff = (vendorId, permissions, extra = {}) => user('vendor_staff', { vendorId, vendorPermissions: permissions, accountStatus: 'active', vendorRole: 'sales', displayName: 'Neema Mwakyusa', ...extra });

async function product(vendorId, { name, priceTzs, stock, costTzs = null, variants = [] }) {
  const id = uid('prd');
  await db('Product').insert({ id, vendorId, name, priceTzs, stock, status: 'active', approvalStatus: 'approved', variants: JSON.stringify(variants), category: 'supplements_nutrition' });
  if (costTzs != null) await db('ProductPrivate').insert({ productId: id, variant: '', vendorId, costTzs });
  made.products.push(id);
  return id;
}

let seq = 0;
/** A walk-in sale written straight to the tables (dates outside the POS's 7-day window are the point). */
async function walkIn(vendorId, { soldAt, createdAt = soldAt, lines, payments = [], discountTzs = 0, kind = 'cash', customerId = null, voided = false, vatIncludedTzs = 0, actorId = vendorId }) {
  const id = uid('sal');
  seq += 1;
  const priced = lines.map(l => ({ ...l, lineTotalTzs: l.qty * l.unitPriceTzs - (l.discountTzs || 0) }));
  const subtotal = priced.reduce((s, l) => s + l.qty * l.unitPriceTzs, 0);
  const lineDisc = priced.reduce((s, l) => s + (l.discountTzs || 0), 0);
  const total = subtotal - lineDisc - discountTzs;
  const paid = payments.reduce((s, p) => s + p.amountTzs, 0);
  const change = kind === 'cash' ? Math.max(0, paid - total) : 0;
  const balance = kind === 'credit' ? total - paid : 0;
  await db('VendorSale').insert({
    id, vendorId, seq, number: `R-${String(seq).padStart(6, '0')}`, kind, status: voided ? 'voided' : 'completed', customerId,
    soldAt: new Date(soldAt), subtotalTzs: subtotal, lineDiscountTzs: lineDisc, discountTzs, vatTzs: 0, totalTzs: total, paidTzs: kind === 'cash' ? total + change : paid,
    changeTzs: change, balanceTzs: balance, dueDate: kind === 'credit' ? '2026-12-30' : null, clientRef: `cref-${id}`, fingerprint: 'x', createdBy: actorId,
    vatIncludedTzs, ...(kind === 'credit' ? { invoiceSeq: seq, invoiceNumber: `INV-${String(seq).padStart(6, '0')}` } : {}),
    ...(voided ? { voidedAt: new Date(soldAt), voidedBy: actorId, voidReason: 'Wrong item' } : {}), createdAt: new Date(createdAt), updatedAt: new Date(createdAt),
  });
  await db('VendorSaleLine').insert(priced.map((l, i) => ({
    id: uid('sln'), saleId: id, vendorId, lineNo: i + 1, productId: l.productId, variant: l.variant || '', nameSnapshot: l.name, qty: l.qty,
    listPriceTzs: l.unitPriceTzs, unitPriceTzs: l.unitPriceTzs, discountTzs: l.discountTzs || 0, saleDiscountShareTzs: l.shareTzs || 0, lineTotalTzs: l.lineTotalTzs,
    unitCostTzs: l.unitCostTzs ?? null, vatCode: l.vatTzs ? 'A' : null, vatRatePct: l.vatTzs ? 18 : 0, vatTzs: l.vatTzs || 0,
  })));
  if (payments.length) await db('VendorSalePayment').insert(payments.map((p, i) => ({ id: uid('spm'), saleId: id, vendorId, position: i + 1, method: p.method, amountTzs: p.amountTzs, reference: p.method === 'cash' ? null : 'REF1', paidAt: new Date(soldAt), recordedBy: actorId })));
  return id;
}

/** An app order written straight to ShopOrder. lines: [vendorId, productId, priceTzs, qty, commissionPct?]. */
async function appOrder({ buyerId, lines, paidAt = null, status = 'accepted', paymentStatus = paidAt ? 'paid' : 'pending', timeline = [], paymentMethod = 'mpesa', settlementStatus = 'pending', createdAt = '2025-01-01T00:00:00Z', updatedAt = null }) {
  const id = uid('ord');
  const items = lines.map(([vendorId, productId, priceTzs, qty, pct = 10]) => ({ productId, vendorId, name: 'Item', qty, priceTzs, ...priceOrderLine({ priceTzs, qty, commissionPct: pct }) }));
  await db('ShopOrder').insert({
    id, buyerId, buyerRole: 'member', items: JSON.stringify(items), totalTzs: items.reduce((s, i) => s + i.priceTzs * i.qty, 0), status, paymentStatus, paymentMethod,
    deliveryMethod: 'home_delivery', deliveryAddress: 'Sinza', timeline: JSON.stringify(timeline), settlementStatus, paidAt: paidAt ? new Date(paidAt) : null,
    createdAt: new Date(createdAt), updatedAt: new Date(updatedAt || paidAt || createdAt),
  });
  made.orders.push(id);
  return id;
}

/** A report service on a pinned clock (every flag of the area on unless said). */
let clock = new Date('2026-10-15T21:30:00Z'); // 00:30 EAT on 16 Oct 2026 — inside the 21:00–22:00 UTC window on purpose
const svc = (extra = {}) => createVendorReportService({
  store: createPgVendorReportStore({ db }), users, auditLog, now: () => clock, cache: createReportCache({ ttlMs: 0 }),
  owedTotals: async () => ({ owedTzs: 35_000, overdueTzs: 0, current: 35_000, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 }),
  flags: { stockLedger: () => true, walkInSales: () => false, customers: () => true }, ...extra,
});
const OWNER = { cost: true, payout: true, customers: true };
const PLAIN = { cost: false, payout: false, customers: false };

/** Text drawn in a pdfkit PDF (inflates the content streams, decodes the hex strings). */
function pdfText(buffer) {
  const s = buffer.toString('latin1');
  let out = '';
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    let data;
    try { data = zlib.inflateSync(Buffer.from(s.slice(start, end).replace(/\r?\n$/, ''), 'latin1')).toString('latin1'); } catch { continue; }
    for (const t of data.matchAll(/\[(.*?)\]\s*TJ/g)) out += `${[...t[1].matchAll(/<([0-9a-fA-F]*)>/g)].map(h => Buffer.from(h[1], 'hex').toString('latin1')).join('')}\n`;
  }
  return out;
}

// ── the seed: vendor V, October 2026 ────────────────────────────────────────

const seed = {};
async function seedV() {
  if (seed.V) return seed;
  const V = await vendor('Dar Fitness Gear');
  const W = await vendor('Other Shop');
  const [buyer1, buyer2] = [await user('member'), await user('member')];
  const P1 = await product(V, { name: 'Whey 1kg', priceTzs: 45_000, stock: 30, costTzs: 30_000 });
  const P2 = await product(V, { name: 'Gloves', priceTzs: 20_000, stock: 5 });                       // no cost price
  const P3 = await product(V, { name: '=HYPERLINK("http://x")', priceTzs: 10_000, stock: 10, costTzs: 4_000 }); // never sold
  const P4 = await product(V, { name: 'Bands', priceTzs: 8_000, stock: 0 });
  const C = uid('cus');
  await db('VendorCustomer').insert({ id: C, vendorId: V, source: 'manual', name: 'Juma Mussa', createdBy: V });

  // 14 Oct 23:30 EAT: 2 × 45,000, line discount 5,000, sale discount 1,000; cash 100,000 (change 16,000).
  seed.S1 = await walkIn(V, { soldAt: '2026-10-14T20:30:00Z', discountTzs: 1_000, lines: [{ productId: P1, name: 'Whey 1kg', qty: 2, unitPriceTzs: 45_000, discountTzs: 5_000, shareTzs: 1_000, unitCostTzs: 30_000 }], payments: [{ method: 'cash', amountTzs: 100_000 }] });
  // 15 Oct 00:30 EAT, recorded late (synced at 15:00 EAT): 3 × 20,000, no cost known; M-Pesa.
  seed.S2 = await walkIn(V, { soldAt: '2026-10-14T21:30:00Z', createdAt: '2026-10-15T12:00:00Z', lines: [{ productId: P2, name: 'Gloves', qty: 3, unitPriceTzs: 20_000 }], payments: [{ method: 'mpesa', amountTzs: 60_000 }] });
  // 15 Oct: voided — in no total.
  seed.S3 = await walkIn(V, { soldAt: '2026-10-15T08:00:00Z', voided: true, lines: [{ productId: P1, name: 'Whey 1kg', qty: 1, unitPriceTzs: 45_000, unitCostTzs: 30_000 }], payments: [{ method: 'cash', amountTzs: 45_000 }] });
  // 15 Oct: pay later, 10,000 now, VAT 6,864 included.
  seed.S4 = await walkIn(V, { soldAt: '2026-10-15T09:00:00Z', kind: 'credit', customerId: C, vatIncludedTzs: 6_864, lines: [{ productId: P1, name: 'Whey 1kg', qty: 1, unitPriceTzs: 45_000, unitCostTzs: 30_000, vatTzs: 6_864 }], payments: [{ method: 'cash', amountTzs: 10_000 }] });
  // A customer payment received 15 Oct (PMT).
  await db('VendorCustomerPayment').insert({ id: uid('pmt'), vendorId: V, customerId: C, seq: 1, number: 'PMT-000001', amountTzs: 15_000, method: 'airtel_money', receivedOn: '2026-10-15', clientRef: `cref-${uid('p')}`, fingerprint: 'x', recordedBy: V });

  // App: O1 paid 15 Oct (13:00 EAT), delivered; V's line 45,000 (commission 4,500) + W's line; VAT 6,864 on V's invoice; cost snapshot 30,000.
  seed.O1 = await appOrder({ buyerId: buyer1, lines: [[V, P1, 45_000, 1], [W, uid('prd'), 10_000, 1]], paidAt: '2026-10-15T10:00:00Z', status: 'delivered', timeline: [{ status: 'delivered', at: '2026-10-15T14:00:00Z' }] });
  await db('ShopOrderLineCost').insert({ orderId: seed.O1, productId: P1, variant: '', vendorId: V, qty: 1, unitCostTzs: 30_000 });
  await db('VendorOrderInvoice').insert({ id: uid('oin'), vendorId: V, orderId: seed.O1, seq: 1, number: 'INV-900001', issuedAt: new Date('2026-10-15T10:00:00Z'), vatApplied: true, subtotalTzs: 45_000, totalTzs: 45_000, vatIncludedTzs: 6_864, lines: JSON.stringify([{ productId: P1, variant: null, qty: 1, amountTzs: 45_000, vatCode: 'A', vatRatePct: 18, vatTzs: 6_864 }]), sellerSnapshot: '{}' });
  // O2 paid 14 Oct (12:00 EAT), cancelled 15 Oct (14:00 EAT) → a sale on the 14th and a refund on the 15th.
  seed.O2 = await appOrder({ buyerId: buyer2, lines: [[V, P2, 20_000, 1]], paidAt: '2026-10-14T09:00:00Z', status: 'cancelled', paymentStatus: 'refunded', timeline: [{ status: 'cancelled', at: '2026-10-15T11:00:00Z', by: 'buyer' }] });
  // Never sales: unpaid, and a late payment (money came after cancellation: no paidAt).
  await appOrder({ buyerId: buyer1, lines: [[V, P1, 45_000, 5]] });
  await appOrder({ buyerId: buyer1, lines: [[V, P1, 45_000, 7]], status: 'cancelled', paymentStatus: 'refund_pending', timeline: [{ status: 'cancelled', at: '2026-10-15T05:00:00Z' }] });
  Object.assign(seed, { V, W, P1, P2, P3, P4, C, buyer1, buyer2 });
  return seed;
}

after(async () => {
  const vendors = made.users;
  await db('AuditLog').whereIn('target', vendors).del();
  await db('VendorSettlement').whereIn('vendorId', vendors).where({ status: 'draft' }).del();
  await db('VendorOrderInvoice').whereIn('vendorId', vendors).del();
  await db('VendorCustomerPayment').whereIn('vendorId', vendors).del();
  await db('VendorSale').whereIn('vendorId', vendors).del();
  await db('VendorCustomer').whereIn('vendorId', vendors).del();
  await db('ShopOrderLineCost').whereIn('orderId', made.orders).del();
  await db('PaymentRequest').whereIn('orderId', made.orders).del();
  await db('ShopStockMovement').whereIn('productId', made.products).del();
  await db('ShopOrder').whereIn('id', made.orders).del();
  await db('ProductPrivate').whereIn('productId', made.products).del();
  await db('Product').whereIn('id', made.products).del();
  await db('PartnerSettlementAccount').whereIn('caseId', db('PartnerKycCase').whereIn('userId', vendors).select('id')).del();
  await db('PartnerKycCase').whereIn('userId', vendors).del();
  await db('User').whereIn('id', vendors).del().catch(() => {});
  await db.destroy();
});

// ── pure rules ──────────────────────────────────────────────────────────────

test('period rules: EAT today, inclusive dates, ≤366 days, no future end, ≤120 buckets; auto grouping', () => {
  const now = new Date('2026-10-15T21:30:00Z'); // 00:30 EAT 16 Oct
  assert.equal(parseReportQuery({}, { now }).from, '2026-10-01', 'no dates = this month so far (EAT)');
  assert.equal(parseReportQuery({}, { now }).to, '2026-10-16');
  assert.equal(parseReportQuery({ from: '2026-10-16', to: '2026-10-16' }, { now }).closed, false);
  assert.equal(parseReportQuery({ from: '2026-10-15', to: '2026-10-15' }, { now }).closed, true);
  assert.deepEqual(parseReportQuery({ from: '2026-10-16', to: '2026-10-17' }, { now }), { error: 'invalid_range', status: 400, reason: 'future', today: '2026-10-16' });
  assert.equal(parseReportQuery({ from: '2026-10-16', to: '2026-10-15' }, { now }).reason, 'to_before_from');
  assert.equal(parseReportQuery({ from: '2025-10-15', to: '2026-10-15' }, { now }).days, 366);
  assert.deepEqual(parseReportQuery({ from: '2025-10-14', to: '2026-10-15' }, { now }), { error: 'invalid_range', status: 400, reason: 'too_long', maxDays: 366 });
  assert.equal(parseReportQuery({ from: '2026-02-30', to: '2026-03-01' }, { now }).reason, 'invalid_date');
  assert.equal(parseReportQuery({ from: '2026-10-01' }, { now }).reason, 'from_and_to_required');
  assert.equal(parseReportQuery({ from: '2026-01-01', to: '2026-10-15', groupBy: 'day' }, { now, grouped: true }).error, 'too_many_buckets');
  assert.equal(parseReportQuery({ from: '2026-06-01', to: '2026-09-28', groupBy: 'day' }, { now, grouped: true }).groupBy, 'day', '120 days = 120 buckets is allowed');
  assert.equal(parseReportQuery({ from: '2026-10-01', to: '2026-10-31' }, { now: new Date('2026-11-02T00:00:00Z'), grouped: true }).groupBy, 'day');
  assert.equal(parseReportQuery({ from: '2026-06-01', to: '2026-10-15' }, { now, grouped: true }).groupBy, 'week');
  assert.equal(parseReportQuery({ from: '2025-10-16', to: '2026-10-15' }, { now, grouped: true }).groupBy, 'month');
  assert.equal(parseReportQuery({ channel: 'shop' }, { now }).error, 'invalid_channel');
  assert.equal(parseReportQuery({ format: 'pdf' }, { now, formats: ['json', 'csv'] }).error, 'invalid_format');
  assert.equal(parseReportQuery({ lang: 'fr' }, { now }).error, 'invalid_lang');
  // Weeks run Monday–Sunday; the first and last are clipped to the period.
  assert.deepEqual(bucketsOf('2026-10-14', '2026-10-20', 'week'), [{ key: '2026-10-12', start: '2026-10-14', end: '2026-10-18' }, { key: '2026-10-19', start: '2026-10-19', end: '2026-10-20' }]);
  assert.deepEqual(bucketsOf('2026-01-30', '2026-03-02', 'month').map(b => [b.start, b.end]), [['2026-01-30', '2026-01-31'], ['2026-02-01', '2026-02-28'], ['2026-03-01', '2026-03-02']]);
  assert.equal(periodInWords('2026-10-01', '2026-10-31', 'sw'), '1–31 Okt 2026');
  assert.equal(periodInWords('2026-09-28', '2026-10-04', 'en'), '28 Sep – 4 Oct 2026');
});

test('days of cover: stock ÷ average daily units over 30 days; ≤7 days = reorder soon; out / no sales / untracked', () => {
  // NB design spec §15 AC-18 says stock 30 with 60 units sold → "30 days"; the formula it defines gives 15 (60/30 = 2 a day).
  assert.deepEqual(cover(30, 60), { avgDailyUnits30: 2, daysOfCover: 15, coverState: 'ok' });
  assert.deepEqual(cover(30, 30), { avgDailyUnits30: 1, daysOfCover: 30, coverState: 'ok' });
  assert.deepEqual(cover(5, 30), { avgDailyUnits30: 1, daysOfCover: 5, coverState: 'soon' });
  assert.deepEqual(cover(10, 0), { avgDailyUnits30: 0, daysOfCover: null, coverState: 'none' });
  assert.deepEqual(cover(0, 12), { avgDailyUnits30: 0.4, daysOfCover: 0, coverState: 'out' });
  assert.equal(cover(1, 90).daysOfCover, 0, 'less than one day');
  assert.equal(cover(null, 5).coverState, 'untracked');
});

test('CSV helper: BOM, CRLF, RFC 4180 quoting, formula injection neutralised, numbers stay numbers', () => {
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  for (const risky of ['+255700111222', '-5', '@SUM(A1)', '\tx', '\rx']) assert.ok(csvCell(risky).replace(/^"/, '').startsWith("'"), risky);
  assert.equal(csvCell(-5000), '-5000', 'a negative amount the server wrote is a number');
  assert.equal(csvCell('Mauzo, halisi'), '"Mauzo, halisi"');
  assert.equal(csvCell(null), '');
  const file = csvDocument(['a', 'b'], [[1, 'x'], [2, 'y']]);
  assert.ok(file.startsWith(CSV_BOM));
  assert.equal(file, `${CSV_BOM}a,b\r\n1,x\r\n2,y\r\n`);
});

// ── figures (pinned clock) ──────────────────────────────────────────────────

test('sales: totals equal the line sums; EAT days (23:30 vs 00:30 EAT); voids apart; late sale on its sale day; app refund on the cancellation date', async () => {
  const { V } = await seedV();
  const r = svc();
  const day = async (d, channel = 'all') => (await r.report('sales', { vendorId: V, access: OWNER, query: { from: d, to: d, channel } })).data.totals;
  const t14 = await day('2026-10-14');
  assert.deepEqual(t14, { grossTzs: 110_000, discountTzs: 6_000, refundTzs: 0, netTzs: 104_000, vatIncludedTzs: 0, saleCount: 1, orderCount: 1, itemsSold: 3, voided: { count: 0, totalTzs: 0 } },
    '14 Oct: the 23:30 EAT walk-in sale and O2 (paid on the 14th)');
  const t15 = await day('2026-10-15');
  assert.deepEqual(t15, { grossTzs: 150_000, discountTzs: 0, refundTzs: 20_000, netTzs: 130_000, vatIncludedTzs: 13_728, saleCount: 2, orderCount: 1, itemsSold: 5, voided: { count: 1, totalTzs: 45_000 } },
    '15 Oct: the 00:30 EAT (late-recorded) sale, the credit sale, O1, O2 refunded; the void counted apart');

  const both = (await r.report('sales', { vendorId: V, access: OWNER, query: { from: '2026-10-14', to: '2026-10-15' } })).data;
  assert.equal(both.groupBy, 'day');
  assert.equal(both.totals.netTzs, both.totals.grossTzs - both.totals.discountTzs - both.totals.refundTzs);
  assert.equal(both.totals.netTzs, t14.netTzs + t15.netTzs);
  assert.deepEqual(both.buckets.map(b => [b.start, b.netTzs]), [['2026-10-14', 104_000], ['2026-10-15', 130_000]]);
  for (const k of ['grossTzs', 'discountTzs', 'refundTzs', 'netTzs', 'vatIncludedTzs', 'itemsSold']) {
    assert.equal(both.buckets.reduce((s, b) => s + b.app[k] + b.walkIn[k], 0), both.totals[k] ?? both.totals.itemsSold, `Σ buckets = total for ${k}`);
    assert.equal(both.byChannel.app[k] + both.byChannel.walkIn[k], both.totals[k], `app + shop = all for ${k}`);
  }
  // Line sums straight from the tables (completed walk-in lines + V's app lines).
  const lines = await db.raw(`SELECT COALESCE(sum(l."lineTotalTzs" - l."saleDiscountShareTzs"), 0)::int AS net FROM "VendorSaleLine" l JOIN "VendorSale" s ON s.id = l."saleId" WHERE s."vendorId" = ? AND s.status = 'completed'`, [V]);
  assert.equal(both.byChannel.walkIn.netTzs, lines.rows[0].net);
  // Channel filters every figure; App + Shop = All.
  const appOnly = await day('2026-10-15', 'app');
  const shopOnly = await day('2026-10-15', 'walk_in');
  assert.equal(appOnly.netTzs + shopOnly.netTzs, t15.netTzs);
  assert.deepEqual([appOnly.saleCount, appOnly.orderCount, appOnly.voided.count, shopOnly.orderCount, shopOnly.voided.count], [0, 1, 0, 0, 1]);
  // Week grouping (Mon 12 – Sun 18 Oct) puts both days in one bucket.
  const week = (await r.report('sales', { vendorId: V, access: OWNER, query: { from: '2026-10-14', to: '2026-10-15', groupBy: 'week' } })).data;
  assert.deepEqual(week.buckets.map(b => [b.start, b.end, b.netTzs]), [['2026-10-14', '2026-10-15', 234_000]]);
});

test('EAT boundary holds at 23:59 EAT too, and "today" is the EAT day', async () => {
  const { V } = await seedV();
  clock = new Date('2026-10-15T20:59:00Z'); // 23:59 EAT 15 Oct
  try {
    const r = svc();
    assert.equal((await r.report('sales', { vendorId: V, access: OWNER, query: { from: '2026-10-16', to: '2026-10-16' } })).reason, 'future');
    const today = (await r.report('sales', { vendorId: V, access: OWNER, query: { from: '2026-10-15', to: '2026-10-15' } })).data;
    assert.equal(today.inProgress, true);
    assert.equal(today.totals.netTzs, 130_000);
  } finally { clock = new Date('2026-10-15T21:30:00Z'); }
});

test('profit: ex-VAT, minus commission, costed lines only; lines without a cost are apart and never cost 0', async () => {
  const { V } = await seedV();
  const r = svc();
  const p = (await r.report('profit', { vendorId: V, access: OWNER, query: { from: '2026-10-14', to: '2026-10-15' } })).data;
  // Costed: S1 84,000 − 60,000; S4 (45,000 − 6,864 VAT) − 30,000; O1 (45,000 − 6,864) − 4,500 commission − 30,000.
  assert.deepEqual(p.totals, { netExVatTzs: 160_272, commissionTzs: 4_500, costTzs: 120_000, profitTzs: 35_772, marginPct: 22.3 });
  // Uncosted: S2 (3 × 20,000) and O2 (sold 14 Oct, refunded 15 Oct).
  assert.deepEqual(p.uncosted, { lineCount: 2, qty: 4, revenueTzs: 60_000, netExVatTzs: 60_000 });
  assert.equal(p.hasVat, true);
  assert.equal(p.buckets.reduce((s, b) => s + b.profitTzs, 0), p.totals.profitTzs);
  assert.deepEqual(p.uncostedProducts.map(x => [x.name, x.units, x.revenueTzs]), [['Gloves', 4, 60_000]]);
  assert.equal(p.byProduct.find(x => x.productId === seed.P1).profitTzs, 35_772);
  assert.ok(!p.byProduct.some(x => x.productId === seed.P2), 'a product with no cost price is not given a profit');
  assert.equal(p.byChannel.app.commissionTzs, 4_500);
  assert.equal(p.byChannel.walkIn.commissionTzs, 0, 'walk-in sales carry no commission');
  // Not allowed without canSeeCost — explicitly asking for profit is refused.
  assert.deepEqual(await r.report('profit', { vendorId: V, access: PLAIN, query: {} }), { error: 'cost_not_allowed', status: 403 });
});

test('products: units and revenue per product = sales totals; last sold, stock, days of cover; slow sellers include unsold stock; cost keys only when allowed', async () => {
  const { V, P1, P2, P3, P4 } = await seedV();
  const r = svc();
  const q = { from: '2026-10-14', to: '2026-10-15' };
  const best = (await r.report('products', { vendorId: V, access: OWNER, query: q })).data;
  const sales = (await r.report('sales', { vendorId: V, access: OWNER, query: q })).data;
  assert.deepEqual(best.totals, { unitsSold: sales.totals.itemsSold, netRevenueTzs: sales.totals.netTzs });
  assert.deepEqual(best.rows.map(x => [x.productId, x.unitsSold, x.appUnits, x.walkInUnits, x.netRevenueTzs]), [[P1, 4, 1, 3, 174_000], [P2, 4, 1, 3, 60_000]]);
  const whey = best.rows[0];
  assert.equal(whey.lastSoldAt, '2026-10-15T10:00:00.000Z');
  assert.deepEqual([whey.stock, whey.coverState, whey.daysOfCover], [30, 'ok', 225], '30 in stock, 4 sold in 30 days (O2-style cancellations excluded)');
  assert.equal(whey.profitTzs, 35_772);
  const slow = (await r.report('products', { vendorId: V, access: PLAIN, query: { ...q, sort: 'slow' } })).data;
  assert.equal(slow.rows[0].productId, P3, 'the unsold product in stock comes first');
  assert.deepEqual([slow.rows[0].noSalesInPeriod, slow.rows[0].coverState, slow.rows[0].lastSoldAt], [true, 'none', null]);
  assert.ok(!slow.rows.some(x => x.productId === P4), 'out of stock is not a slow seller');
  assert.equal(slow.slowCount, 1);
  assert.ok(slow.rows.every(x => !('profitTzs' in x)), 'no profit key without canSeeCost');
  const page = (await r.report('products', { vendorId: V, access: OWNER, query: { ...q, limit: 1 } })).data;
  assert.equal(page.rows.length, 1);
  const next = (await r.report('products', { vendorId: V, access: OWNER, query: { ...q, limit: 1, cursor: page.nextCursor } })).data;
  assert.deepEqual([next.rows[0].productId, next.nextCursor], [P2, null]);
  assert.equal((await r.report('products', { vendorId: V, access: OWNER, query: { ...q, q: 'glo' } })).data.rows[0].productId, P2);
  assert.equal((await r.report('products', { vendorId: V, access: OWNER, query: { ...q, sort: 'price' } })).error, 'invalid_sort');
});

test('stock value: as of now; at cost over costed items only; cost unknown counted apart; cost keys absent without canSeeCost', async () => {
  const { V, P2 } = await seedV();
  const r = svc();
  const s = (await r.report('stock-value', { vendorId: V, access: OWNER, query: { from: '2026-10-01', to: '2026-10-02' } })).data;
  assert.deepEqual(s.totals, { atRetailTzs: 1_550_000, units: 45, products: 3, atCostTzs: 940_000 });
  assert.deepEqual(s.costUnknown, { count: 1, units: 5, retailTzs: 100_000 });
  assert.equal(s.rows.find(x => x.productId === P2).costTzs, null, 'unknown cost is null, never 0');
  const plain = (await r.report('stock-value', { vendorId: V, access: PLAIN, query: {} })).data;
  assert.ok(!('atCostTzs' in plain.totals) && !('costUnknown' in plain));
  assert.ok(plain.rows.every(x => !('costTzs' in x) && !('valueAtCostTzs' in x)));
  assert.equal((await svc({ flags: { stockLedger: () => false, walkInSales: () => false, customers: () => true } }).report('stock-value', { vendorId: V, access: OWNER, query: {} })).error, 'feature_disabled');
});

test('payment methods: collected by you (cash after change, PMT on its day) and paid through FitFlex, never added together', async () => {
  const { V } = await seedV();
  const m = (await svc().report('payment-methods', { vendorId: V, access: OWNER, query: { from: '2026-10-14', to: '2026-10-15' } })).data;
  assert.deepEqual(m.byYou, [
    { method: 'cash', amountTzs: 94_000, count: 2, sharePct: 55.6 },   // 100,000 + 10,000 paid now on the credit sale − 16,000 change
    { method: 'mpesa', amountTzs: 60_000, count: 1, sharePct: 35.5 },
    { method: 'airtel_money', amountTzs: 15_000, count: 1, sharePct: 8.9 },
  ]);
  assert.ok(Math.abs(m.byYou.reduce((s, x) => s + x.sharePct, 0) - 100) <= 0.1);
  assert.deepEqual(m.viaFitFlex, [{ paymentMethod: 'mpesa', amountTzs: 65_000, count: 2, sharePct: 100 }]);
  const appOnly = (await svc().report('payment-methods', { vendorId: V, access: OWNER, query: { from: '2026-10-14', to: '2026-10-15', channel: 'app' } })).data;
  assert.deepEqual(appOnly.byYou, []);
});

test('customers: owed from S4, pay-later sales and money collected in the period, buyers counted (never named)', async () => {
  const { V } = await seedV();
  const r = svc();
  const c = (await r.report('customers', { vendorId: V, access: OWNER, query: { from: '2026-10-14', to: '2026-10-15' } })).data;
  assert.deepEqual([c.owedTzs, c.overdueTzs, c.creditSales, c.collectedTzs, c.buyers], [35_000, 0, { count: 1, totalTzs: 45_000 }, 15_000, { shop: 1, app: 2 }]);
  assert.ok(!JSON.stringify(c).includes('Juma'), 'A-02: no names');
  assert.deepEqual(await r.report('customers', { vendorId: V, access: { ...OWNER, customers: false }, query: {} }), { error: 'vendor_permission_forbidden', status: 403, requiredPermission: 'customers' });
  assert.equal((await svc({ flags: { stockLedger: () => true, walkInSales: () => false, customers: () => false } }).report('customers', { vendorId: V, access: OWNER, query: {} })).error, 'feature_disabled');
});

test('summary: one call with the permitted sections only', async () => {
  const { V } = await seedV();
  const r = svc();
  const full = r.publicSummary((await r.report('summary', { vendorId: V, access: OWNER, query: { from: '2026-10-14', to: '2026-10-15' } })).data);
  assert.equal(full.sales.netTzs, 234_000);
  assert.deepEqual(full.sales.buckets.map(b => b.netTzs), [104_000, 130_000]);
  assert.equal(full.topProducts[0].name, 'Whey 1kg');
  assert.deepEqual([full.slowCount, full.profit.profitTzs, full.stock.atCostTzs, full.stock.costUnknownCount, full.customers.collectedTzs], [1, 35_772, 940_000, 1, 15_000]);
  assert.ok('payouts' in full && !('_pdf' in full));
  const plain = r.publicSummary((await r.report('summary', { vendorId: V, access: PLAIN, query: { from: '2026-10-14', to: '2026-10-15' } })).data);
  assert.ok(!('profit' in plain) && !('payouts' in plain) && !('customers' in plain));
  assert.ok(!('atCostTzs' in plain.stock) && !('costUnknownCount' in plain.stock));
  assert.equal((await r.report('summary', { vendorId: V, access: OWNER, query: { format: 'csv' } })).error, 'invalid_format', 'the overview has no CSV');
});

test('CSV exports: headers in English or Swahili with (TZS), raw integers, formula injection neutralised, cost columns only when allowed; 413 over 50,000 rows', async () => {
  const { V } = await seedV();
  const r = svc();
  const q = { from: '2026-10-14', to: '2026-10-15', sort: 'slow', format: 'csv' };
  const owner = await r.toCsv('products', await r.report('products', { vendorId: V, access: OWNER, query: q }), OWNER, V);
  assert.ok(owner.csv.startsWith(CSV_BOM));
  const [header, ...rows] = owner.csv.slice(1).trimEnd().split('\r\n');
  assert.equal(header, 'Product,Variant,Units sold,App units,Shop units,Net revenue (TZS),Last sold,In stock,Days of cover,Cover,Profit (TZS)');
  assert.ok(rows[0].startsWith(`"'=HYPERLINK(""http://x"")"`), rows[0]);
  assert.equal(owner.fileName, 'dar-fitness-gear_products_2026-10-14_2026-10-15.csv');
  const plain = await r.toCsv('products', await r.report('products', { vendorId: V, access: PLAIN, query: { ...q, lang: 'sw' } }), PLAIN, V);
  const swHeader = plain.csv.slice(1).split('\r\n')[0];
  assert.match(swHeader, /^Bidhaa,Aina,Idadi iliyouzwa,.*Mapato halisi \(TZS\)/);
  assert.ok(!/Faida|Profit/.test(swHeader), 'no profit column without canSeeCost');
  const sales = await r.toCsv('sales', await r.report('sales', { vendorId: V, access: OWNER, query: { from: '2026-10-14', to: '2026-10-15', format: 'csv' } }), OWNER, V);
  assert.deepEqual(sales.csv.slice(1).trimEnd().split('\r\n').slice(1), ['2026-10-14,2026-10-14,20000,84000,110000,6000,0,104000,0,2,3', '2026-10-15,2026-10-15,25000,105000,150000,0,20000,130000,13728,3,5']);
  const stock = await r.toCsv('stock-value', await r.report('stock-value', { vendorId: V, access: PLAIN, query: { format: 'csv' } }), PLAIN, V);
  assert.ok(!/cost/i.test(stock.csv.split('\r\n')[0]));
  const huge = { period: { from: '2026-10-01', to: '2026-10-02', lang: 'en' }, data: { buckets: Array.from({ length: REPORT_LIMITS.maxCsvRows + 1 }, () => ({ start: 'x', end: 'x', app: { netTzs: 0, grossTzs: 0, discountTzs: 0, refundTzs: 0, vatIncludedTzs: 0, count: 0, itemsSold: 0 }, walkIn: { netTzs: 0, grossTzs: 0, discountTzs: 0, refundTzs: 0, vatIncludedTzs: 0, count: 0, itemsSold: 0 } })) } };
  assert.deepEqual(await r.toCsv('sales', huge, OWNER, V), { error: 'export_too_large', status: 413, maxRows: 50_000, rows: 50_001 });
});

// ── App sales after commission == VendorSettlement ──────────────────────────

test('marketplace net reconciles with the vendor statement: draft (computed), submitted and paid (statement lines); by delivered date', async () => {
  const M = await vendor('Recon Shop', { payable: true });
  const buyerId = await user('member');
  const [maker, checker] = [await user('admin'), await user('admin')];
  const pid = uid('prd');
  const delivered = (at) => [{ status: 'pending', at: '2025-06-02T08:00:00Z' }, { status: 'delivered', at }];
  const A = await appOrder({ buyerId, lines: [[M, pid, 40_000, 2]], paidAt: '2025-06-02T09:00:00Z', status: 'delivered', timeline: delivered('2025-06-03T10:00:00Z') });
  const B = await appOrder({ buyerId, lines: [[M, pid, 10_000, 1], [uid('usr'), pid, 30_000, 1]], paidAt: '2025-06-02T09:00:00Z', status: 'delivered', timeline: delivered('2025-06-08T20:30:00Z') }); // Sun 23:30 EAT
  await appOrder({ buyerId, lines: [[M, pid, 99_000, 1]], paidAt: '2025-06-02T09:00:00Z', status: 'delivered', timeline: delivered('2025-06-08T21:30:00Z') });                  // Mon 00:30 EAT: next week
  await appOrder({ buyerId, lines: [[M, pid, 5_000, 1]], paidAt: '2025-06-05T09:00:00Z', status: 'dispatched' });                                                          // paid, not delivered
  await appOrder({ buyerId, lines: [[M, pid, 7_000, 1]], paidAt: '2025-06-05T09:00:00Z', status: 'cancelled', paymentStatus: 'refunded', timeline: [{ status: 'cancelled', at: '2025-06-06T09:00:00Z' }] });

  clock = new Date('2025-06-11T09:00:00Z');
  try {
    const eligibility = createPayoutEligibility({ users, gyms, partnerGate, partnerSettlementAccounts, trainers });
    const settle = createVendorSettlementService({ users, payoutEligibility: eligibility, now: () => clock, notify: async () => {} });
    const prepared = await settle.prepare({ periodStart: '2025-06-02', actorId: maker });
    const stmt = prepared.statements.find(s => s.vendorId === M);
    const row = () => db('VendorSettlement').where({ id: stmt.id }).first();
    const r = svc();
    const week = async () => (await r.report('marketplace-net', { vendorId: M, access: OWNER, query: { from: '2025-06-02', to: '2025-06-08' } })).data;

    let d = await week();
    const draft = await row();
    assert.equal(draft.status, 'draft');
    assert.deepEqual(d.weeks, [{ periodStartDate: '2025-06-02', periodEndDate: '2025-06-08', orderCount: 2, grossTzs: draft.salesTzs, commissionTzs: draft.commissionTzs, payoutTzs: draft.finalNetTzs, paidOut: false, statement: null }],
      'a draft is not shown to the vendor, but the computed week equals it');
    assert.deepEqual([draft.salesTzs, draft.commissionTzs, draft.finalNetTzs], [90_000, 9_000, 81_000]);
    assert.deepEqual(d.status.notDelivered, { orders: 1, grossTzs: 5_000, commissionTzs: 500, payoutTzs: 4_500 });
    assert.deepEqual(d.totals, { orderCount: 2, grossTzs: 90_000, commissionTzs: 9_000, payoutTzs: 81_000 });
    assert.equal(d.channel, 'app');

    await settle.submit({ id: stmt.id, actorId: maker });
    d = await week();
    assert.deepEqual(d.weeks.map(w => [w.periodStartDate, w.grossTzs, w.commissionTzs, w.payoutTzs, w.statement]), [['2025-06-02', 90_000, 9_000, 81_000, { id: stmt.id, status: 'submitted', finalNetTzs: 81_000 }]]);
    assert.equal(d.status.waiting.payoutTzs, 81_000);

    await settle.approve({ id: stmt.id, actorId: checker });
    assert.equal((await settle.markPayable({ id: stmt.id, actorId: checker })).statement?.status, 'payable');
    assert.equal((await settle.pay({ id: stmt.id, paymentReference: 'CRDB-S6', actorId: checker })).statement?.status, 'paid');
    d = await week();
    const paid = await row();
    assert.deepEqual([d.weeks[0].grossTzs, d.weeks[0].commissionTzs, d.weeks[0].payoutTzs, d.weeks[0].paidOut, d.weeks[0].statement.status], [paid.salesTzs, paid.commissionTzs, paid.finalNetTzs, true, 'paid']);
    assert.deepEqual([d.status.paidOut.orders, d.status.paidOut.payoutTzs, d.status.waiting.orders], [2, 81_000, 0]);

    // The Monday 00:30 EAT delivery is next week's, not on a statement yet.
    const two = (await r.report('marketplace-net', { vendorId: M, access: OWNER, query: { from: '2025-06-02', to: '2025-06-09' } })).data;
    assert.deepEqual(two.weeks.map(w => [w.periodStartDate, w.payoutTzs, w.statement?.status ?? null]), [['2025-06-02', 81_000, 'paid'], ['2025-06-09', 89_100, null]]);
    assert.deepEqual(await r.report('marketplace-net', { vendorId: M, access: PLAIN, query: {} }), { error: 'payout_not_allowed', status: 403 });

    // GET /vendor/payments: additive net fields (read only), on the same orders.
    const pay = await shopService.vendorPayments(M);
    assert.deepEqual([pay.settledPaymentsTzs, pay.settledNetTzs, pay.pendingSettlementTzs, pay.pendingSettlementNetTzs], [90_000, 81_000, 99_000, 89_100]);
    assert.equal(pay.settlements.find(s => s.orderId === A).netTzs, 72_000);
    assert.equal(pay.settlements.find(s => s.orderId === B).netTzs, 9_000, "only this vendor's share");
  } finally { clock = new Date('2026-10-15T21:30:00Z'); }
});

// ── routes: flags, permissions, tenancy, exports, audit, PDF ────────────────

test('routes: dormant behind VENDOR_TOOLS + VENDOR_REPORTS; permission reports; cost and payout rules; tenancy', async () => {
  const { V, W } = await seedV();
  const reportsOnly = await staff(V, ['reports']);
  const noReports = await staff(V, ['orders']);
  const admin = await staff(V, ['products', 'orders', 'reports'], { vendorRole: 'admin' });
  const withPayments = await staff(V, ['reports', 'payments']);
  const withCustomers = await staff(V, ['reports', 'customers']);
  assert.deepEqual((await call(vendorReportSales, as(V))).body, { error: 'feature_disabled' });
  flagsOn(['VENDOR_TOOLS']);
  assert.equal((await call(vendorReportSales, as(V))).status, 404, 'the umbrella alone is not enough');
  flagsOn();
  assert.equal((await call(vendorReportSales, as(V))).status, 200);
  assert.deepEqual((await call(vendorReportSales, staffOf(noReports, V))).body, { error: 'vendor_permission_forbidden', requiredPermission: 'reports' });
  assert.equal((await call(vendorReportSales, staffOf(reportsOnly, W))).status, 403, 'staff of V claiming W are refused');
  assert.equal((await call(vendorReportSales, { sub: await user('member'), userType: 'member' })).status, 403);

  const plain = staffOf(reportsOnly, V);
  assert.deepEqual((await call(vendorReportProfit, plain)).body, { error: 'cost_not_allowed' });
  assert.deepEqual((await call(vendorReportMarketplaceNet, plain)).body, { error: 'payout_not_allowed' });
  assert.equal((await call(vendorReportCustomers, plain)).status, 403);
  const summary = (await call(vendorReportSummary, plain)).body;
  assert.ok(!('profit' in summary) && !('payouts' in summary) && !('customers' in summary) && !('_pdf' in summary));
  const stock = (await call(vendorReportStockValue, plain)).body;
  assert.ok(!JSON.stringify(stock).includes('Cost') && !('atCostTzs' in stock.totals));
  assert.ok((await call(vendorReportProducts, plain, { query: { sort: 'slow' } })).body.rows.every(x => !('profitTzs' in x)));
  assert.equal((await call(vendorReportProfit, staffOf(admin, V))).status, 200, 'vendorRole admin sees cost');
  assert.equal((await call(vendorReportMarketplaceNet, staffOf(admin, V))).status, 200);
  assert.equal((await call(vendorReportMarketplaceNet, staffOf(withPayments, V))).status, 200, 'reports + payments see payouts');
  assert.equal((await call(vendorReportProfit, staffOf(withPayments, V))).status, 403, '…but not profit');
  assert.equal((await call(vendorReportCustomers, staffOf(withCustomers, V))).status, 200);
  assert.equal((await call(vendorReportPaymentMethods, plain)).status, 200);

  // Tenancy: W sees none of V's figures, only its own line of the shared order O1.
  const wSummary = (await call(vendorReportSummary, as(W), { query: { from: '2026-10-14', to: '2026-10-15' } }));
  assert.equal(wSummary.status, 200);
  assert.deepEqual([wSummary.body.sales.netTzs, wSummary.body.sales.saleCount, wSummary.body.sales.orderCount], [10_000, 0, 1], "W gets only its own line of the shared order");

  // tools options: canSeeOrderMoney.
  assert.equal((await call(vendorToolsOptionsRoute, as(V))).body.canSeeOrderMoney, true);
  assert.equal((await call(vendorToolsOptionsRoute, plain)).body.canSeeOrderMoney, false);
  assert.equal((await call(vendorToolsOptionsRoute, staffOf(withPayments, V))).body.canSeeOrderMoney, true);
  assert.equal((await call(vendorToolsOptionsRoute, plain)).body.reports, true);
});

test('routes: CSV and PDF exports — headers, file names, one audit row each with includedCost; 503 when pdfkit is missing', async () => {
  const { V } = await seedV();
  flagsOn();
  const reportsOnly = await staff(V, ['reports'], { displayName: 'Neema Mwakyusa' });
  const before = Number((await db('AuditLog').where({ target: V, action: 'vendor_report_exported' }).count('* as n'))[0].n);
  const csv = await call(vendorReportProducts, as(V), { query: { from: '2026-10-14', to: '2026-10-15', format: 'csv', lang: 'sw' } });
  assert.equal(csv.status, 200);
  assert.equal(csv.headers['Content-Type'], 'text/csv; charset=utf-8');
  assert.equal(csv.headers['Content-Disposition'], 'attachment; filename="dar-fitness-gear_products_2026-10-14_2026-10-15.csv"');
  assert.ok(csv.body.startsWith(CSV_BOM) && csv.body.includes('Faida (TZS)'));
  const pdf = await call(vendorReportSummary, as(V), { query: { from: '2026-10-14', to: '2026-10-15', format: 'pdf' } });
  assert.equal(pdf.headers['Content-Type'], 'application/pdf');
  assert.ok(Buffer.isBuffer(pdf.body) && pdf.body.subarray(0, 5).toString() === '%PDF-');
  const text = pdfText(pdf.body);
  assert.match(text, /not a tax document/);
  assert.match(text, /Page 1 of/);
  assert.match(text, /Profit/);
  const plainPdf = await call(vendorReportSummary, staffOf(reportsOnly, V), { query: { from: '2026-10-14', to: '2026-10-15', format: 'pdf', lang: 'sw' } });
  const plainText = pdfText(plainPdf.body);
  assert.match(plainText, /si hati ya kodi/);
  assert.ok(!/Faida|Kamisheni|Unapokea/.test(plainText), 'no cost, profit, commission or payout in a reports-only PDF');
  assert.match(plainText, /Neema/);
  assert.ok(!plainText.includes('Mwakyusa'), 'first name only');
  const rows = await db('AuditLog').where({ target: V, action: 'vendor_report_exported' }).orderBy('at');
  assert.equal(rows.length - before, 3);
  const last = rows.slice(-3).map(r => (typeof r.after === 'string' ? JSON.parse(r.after) : r.after));
  assert.deepEqual(last.map(a => [a.section, a.format, a.includedCost]), [['products', 'csv', true], ['summary', 'pdf', true], ['summary', 'pdf', false]]);
  assert.equal((await call(vendorReportSales, as(V), { query: { format: 'pdf' } })).body.error, 'invalid_format');
  setPdfkitLoaderForTests(async () => { throw new Error('Cannot find package pdfkit'); });
  assert.deepEqual((await call(vendorReportSummary, as(V), { query: { format: 'pdf' } })).body, { error: 'pdf_unavailable' });
  assert.equal((await call(vendorReportSales, as(V), { query: { from: '2026-01-01', to: '2026-12-31' } })).body.error, 'invalid_range', 'a future end date is refused');
});

// ── paidAt ──────────────────────────────────────────────────────────────────

test('ShopOrder.paidAt: set when the payment is confirmed (real checkout path); backfill is idempotent and skips late payments', async () => {
  const V = await vendor('PaidAt Shop');
  const buyer = await user('member');
  const pid = uid('prd');
  await db('Product').insert({ id: pid, vendorId: V, name: 'Mat', priceTzs: 12_000, stock: 9, status: 'active', approvalStatus: 'approved', variants: '[]', category: 'accessories' });
  made.products.push(pid);
  const placed = await shopService.createOrder({ buyerId: buyer, body: { items: [{ productId: pid, qty: 1 }], deliveryMethod: 'home_delivery', deliveryAddress: 'Sinza, Dar', paymentMethod: 'mpesa' } });
  assert.equal(placed.status, 202, JSON.stringify(placed));
  made.orders.push(placed.order.id);
  assert.equal((await db('ShopOrder').where({ id: placed.order.id }).first()).paidAt, null);
  await adminPaymentService.decide({ id: placed.paymentRequest.id, decision: 'approve', reference: `MP-${randomUUID().slice(0, 8)}`, amountTzs: placed.order.totalTzs, actorId: uid('adm') });
  const paidRow = await db('ShopOrder').where({ id: placed.order.id }).first();
  assert.ok(paidRow.paidAt instanceof Date, 'markPaid stamps paidAt');

  // Backfill.
  const at = d => new Date(d);
  const paid = await appOrder({ buyerId: buyer, lines: [[V, pid, 1_000, 1]], status: 'accepted', paymentStatus: 'paid' });
  const costed = await appOrder({ buyerId: buyer, lines: [[V, pid, 1_000, 1]], status: 'accepted', paymentStatus: 'paid', createdAt: '2026-03-01T00:00:00Z' });
  const refunded = await appOrder({ buyerId: buyer, lines: [[V, pid, 1_000, 1]], status: 'cancelled', paymentStatus: 'refunded', timeline: [{ status: 'cancelled', at: '2026-03-05T00:00:00Z' }] });
  const late = await appOrder({ buyerId: buyer, lines: [[V, pid, 1_000, 1]], status: 'cancelled', paymentStatus: 'refund_pending', timeline: [{ status: 'cancelled', at: '2026-03-05T00:00:00Z' }] });
  const request = (orderId, decidedAt) => db('PaymentRequest').insert({ id: uid('pr'), memberId: buyer, orderId, amountTzs: 1_000, status: 'approved', provider: 'manual', requestedAt: at('2026-03-01T00:00:00Z'), decidedAt: at(decidedAt) });
  await request(paid, '2026-03-02T10:00:00Z');
  await request(refunded, '2026-03-04T10:00:00Z');       // paid, then cancelled on the 5th
  await request(late, '2026-03-06T10:00:00Z');           // money after the cancellation: never a sale
  await db('ShopOrderLineCost').insert({ orderId: costed, productId: pid, variant: '', vendorId: V, qty: 1, unitCostTzs: null, createdAt: at('2026-03-03T08:00:00Z') });
  const first = await migration.backfillPaidAt(db);
  assert.ok(first.paid >= 2 && first.cancelledAfterPayment >= 1);
  const value = async id => (await db('ShopOrder').where({ id }).first()).paidAt?.toISOString() ?? null;
  assert.deepEqual([await value(paid), await value(costed), await value(refunded), await value(late)], ['2026-03-02T10:00:00.000Z', '2026-03-03T08:00:00.000Z', '2026-03-04T10:00:00.000Z', null]);
  assert.equal(await value(placed.order.id), paidRow.paidAt.toISOString(), 'an order that has a paidAt keeps it');
  assert.deepEqual(await migration.backfillPaidAt(db), { paid: 0, cancelledAfterPayment: 0 }, 'a second run changes nothing');
});

test('GET /vendor/payments/statement CSV: same columns, now BOM + CRLF via the safe helper', async () => {
  const { V } = await seedV();
  const file = await shopService.vendorStatement(V);
  assert.ok(file.startsWith(CSV_BOM));
  const lines = file.slice(1).split('\r\n');
  assert.equal(lines[0], 'order_id,amount_tzs,order_status,payment_status,settlement_status,date');
  assert.ok(lines.length >= 3 && !file.slice(1).replace(/\r\n/g, '').includes('\n'));
});
