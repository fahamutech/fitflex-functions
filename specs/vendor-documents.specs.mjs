// Vendor business tools · S5 — documents: share links (hash only, revocable), the public page /d/:token and
// its PDF, logged-in document views, INV numbering for credit sales and order invoices, the buyer's invoice.
// Against the CI database. Privacy (A-02): no customer phone, email, address, note, void reason, cost,
// commission or payout on any document; app buyers by name only.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { shopService, adminPaymentService, vendorDocumentService, vendorCustomerService } from '../src/bootstrap/services.mjs';
import { vendorToolsOptionsRoute, vendorCreateProduct, marketplaceInvoice } from '../functions/shop.mjs';
import { vendorRecordSale, vendorVoidSale, resetVendorSalesLimits } from '../functions/vendor-sales.mjs';
import { vendorCustomersCreate, vendorCustomerRecordPayment, resetVendorCustomerLimits } from '../functions/vendor-customers.mjs';
import {
  vendorShareSale, vendorShareOrder, vendorSharePayment, vendorShareStatement, vendorDocumentLinks, vendorRevokeDocumentLinks,
  vendorRevokeDocumentLink, vendorDocumentView, resetVendorDocumentLimits, VENDOR_DOCUMENT_LIMITS, clientAddress, publicLimiterSizes,
} from '../functions/vendor-documents.mjs';
import { createVendorLimiter } from '../src/shared/vendor-rate-limit.mjs';
import {
  newToken, hashToken, validToken, publicBaseUrl, swahiliTime, formatDateTime, formatDay, shareTexts, pdfFileName, invoiceNumber, gsmSafe, gsmLength,
  saleDocument,
} from '../src/shared/vendor-documents.mjs';
import { renderDocumentPdf, setPdfkitLoaderForTests } from '../src/shared/vendor-document-pdf.mjs';
import PDFDocument from 'pdfkit';
import { renderUnavailable } from '../src/shared/vendor-document-html.mjs';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';

const migration = createRequire(import.meta.url)('../db/migrations/20270104090000-vendor-documents-vat.cjs');

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [], orders: [] };
const FLAGS = ['VENDOR_TOOLS', 'VENDOR_WALKIN_SALES', 'VENDOR_CUSTOMERS', 'VENDOR_DOCUMENTS'];
const PUBLIC = 'https://docs.fitflex.example';
const on = () => { for (const f of FLAGS) process.env[f] = '1'; process.env.PUBLIC_API_URL = PUBLIC; };
afterEach(() => {
  for (const f of FLAGS) delete process.env[f];
  delete process.env.PUBLIC_API_URL;
  resetVendorSalesLimits(); resetVendorCustomerLimits(); resetVendorDocumentLimits();
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
  await db('User').insert({ id, userType, displayName: `S5 ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
const PROFILE = { businessName: 'Dar Fitness Gear', address: { line1: 'Plot 12, Mikocheni', city: 'Dar es Salaam' }, contactNumber: '+255700111222', status: 'published', logo: '/storage/bafylogo/logo.webp' };
async function vendor(extra = {}) {
  const id = await user('vendor', { createdAt: new Date('2026-01-01T00:00:00Z'), displayName: 'Asha Owner', vendorProfile: JSON.stringify(PROFILE), ...extra });
  const caseId = uid('kyc');
  await db('PartnerKycCase').insert({ id: caseId, partnerType: 'vendor', userId: id, status: 'approved', tier: 3, updatedAt: new Date() });
  await db('PartnerSettlementAccount').insert({
    id: uid('psa'), caseId, method: 'bank', provider: 'CRDB', accountName: 'Dar Fitness Gear', accountNumber: '0150001234',
    status: 'verified', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z'), cooldownUntil: new Date('2026-09-03T00:00:00Z'), updatedAt: new Date(),
  });
  return id;
}
const as = id => ({ sub: id, userType: 'vendor' });
const staffOf = (id, vendorId) => ({ sub: id, userType: 'vendor_staff', vendorId });
const staff = (vendorId, permissions, extra = {}) => user('vendor_staff', { vendorId, vendorPermissions: permissions, accountStatus: 'active', vendorRole: 'sales', displayName: 'Neema Mwakyusa', ...extra });
async function product(vendorId, body = {}) {
  const out = await call(vendorCreateProduct, as(vendorId), { body: { name: 'Whey 1kg', category: 'supplements_nutrition', priceTzs: 45_000, stock: 50, ...body } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  made.products.push(out.body.id);
  await shopService.adminUpdateProductListing({ productId: out.body.id, body: { approvalStatus: 'approved' }, actorId: 'adm_s5' });
  return out.body;
}
const saleBody = (lines, payments, extra = {}) => ({ clientRef: randomUUID(), lines, payments, ...extra });
const cash = amountTzs => [{ method: 'cash', amountTzs }];
async function sell(claims, body) {
  const out = await call(vendorRecordSale, claims, { body });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.sale;
}
const addCustomer = async (claims, body) => {
  const out = await call(vendorCustomersCreate, claims, { body: { name: 'Juma Mussa', ...body } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.customer;
};
const pay = async (claims, customerId, body) => {
  const out = await call(vendorCustomerRecordPayment, claims, { params: { id: customerId }, body: { clientRef: randomUUID(), method: 'cash', ...body } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.payment;
};
const cart = items => ({ items, deliveryMethod: 'home_delivery', deliveryAddress: 'Kinondoni Block 7, Dar', paymentMethod: 'mpesa' });
async function placeOrder(buyerId, items) {
  const placed = await shopService.createOrder({ buyerId, body: cart(items) });
  assert.equal(placed.status, 202, JSON.stringify(placed));
  made.orders.push(placed.order.id);
  return placed;
}
async function paidOrder(buyerId, items) {
  const placed = await placeOrder(buyerId, items);
  const paid = await adminPaymentService.decide({ id: placed.paymentRequest.id, decision: 'approve', reference: `MP-${randomUUID().slice(0, 8)}`, amountTzs: placed.order.totalTzs, actorId: uid('adm') });
  assert.equal(paid.paymentRequest.status, 'approved');
  return placed.order;
}
const shareSale = (claims, id, body = {}) => call(vendorShareSale, claims, { params: { id }, body });
const tokenOf = url => url.split('/d/')[1].split('?')[0];

/**
 * The data of a stream that starts at `start`, cut by its dictionary's /Length. Never trim the newline before
 * `endstream` instead: a deflate stream ends in its Adler-32 checksum, so 1 in 256 end in 0x0D and a
 * `/\r?\n$/` trim eats that byte — the stream no longer inflates and the PDF reads as empty (CI run 40639757780).
 */
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
  const linkIds = (await db('VendorDocumentLink').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  const paymentIds = (await db('VendorCustomerPayment').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  await db('AuditLog').whereIn('target', [...saleIds, ...linkIds, ...paymentIds, ...made.orders, ...made.products]).del();
  await db('VendorDocumentLink').whereIn('vendorId', vendors).del();
  await db('VendorOrderInvoice').whereIn('vendorId', vendors).del();
  await db('VendorCustomerPayment').whereIn('vendorId', vendors).del();
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
let ipSeq = 0;
/** A fresh client address per call site, so one test's opens never count against another's. */
const freshIp = () => `10.5.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
async function open(urlPath, { ip = freshIp(), claims = null } = {}) {
  const r = await fetch(`${base}${urlPath}`, { headers: { 'x-forwarded-for': ip, ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}) } });
  const buffer = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, buffer, text: buffer.toString('utf8') };
}

// ── pure rules ───────────────────────────────────────────────────────────────

test('tokens: 128-bit, 22 base64url characters, only the SHA-256 is kept; unguessable in practice', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const { token, tokenHash } = newToken();
    assert.match(token, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 16, '128 bits');
    assert.equal(tokenHash, createHash('sha256').update(token).digest('hex'));
    assert.notEqual(tokenHash, token);
    seen.add(token);
  }
  assert.equal(seen.size, 2000, 'no repeats');
  assert.equal(validToken('short'), false);
  assert.equal(validToken('A'.repeat(22)), true);
  assert.equal(validToken('../../etc/passwd/xxxxxx'), false);
  assert.equal(hashToken('abc'), createHash('sha256').update('abc').digest('hex'));
});

test('PUBLIC_API_URL: no value (or a bad one) is null — never the bfast/smartstock fallback (Q-1)', () => {
  assert.equal(publicBaseUrl(undefined), null);
  assert.equal(publicBaseUrl(''), null);
  assert.equal(publicBaseUrl('ftp://x.example'), null);
  // #229 L4: https only; plain http only while NODE_ENV=test.
  assert.equal(publicBaseUrl('http://fitflex.co.tz', { nodeEnv: 'production' }), null);
  assert.equal(publicBaseUrl('http://fitflex.co.tz', { nodeEnv: undefined }), null);
  assert.equal(publicBaseUrl('http://localhost:3000', { nodeEnv: 'test' }), 'http://localhost:3000');
  assert.equal(publicBaseUrl('not a url'), null);
  assert.equal(publicBaseUrl('https://fitflex.co.tz/'), 'https://fitflex.co.tz');
  assert.equal(publicBaseUrl('https://fitflex.co.tz/api/'), 'https://fitflex.co.tz/api');
  const src = fs.readFileSync(path.join(root, 'src/shared/vendor-documents.mjs'), 'utf8') + fs.readFileSync(path.join(root, 'src/services/vendor-document-service.mjs'), 'utf8');
  assert.equal(/bfast|smartstock/i.test(src), false, 'no fallback host in the documents code');
});

test('dates: EAT calendar; Swahili time is the apps\' rule — 12-hour clock + part of the day (formatters.dart)', () => {
  // Same boundaries as fitflexmobile lib/shared/formatters.dart: 5–11 asubuhi, 12–15 mchana, 16–18 jioni, else usiku.
  assert.equal(swahiliTime(14, 5), '2:05 mchana');
  assert.equal(swahiliTime(5, 30), '5:30 asubuhi');
  assert.equal(swahiliTime(4, 59), '4:59 usiku');
  assert.equal(swahiliTime(11, 59), '11:59 asubuhi');
  assert.equal(swahiliTime(12, 0), '12:00 mchana');
  assert.equal(swahiliTime(16, 0), '4:00 jioni');
  assert.equal(swahiliTime(18, 59), '6:59 jioni');
  assert.equal(swahiliTime(19, 0), '7:00 usiku');
  assert.equal(swahiliTime(0, 15), '12:15 usiku');
  assert.equal(formatDateTime('2026-10-19T11:05:00Z', 'en'), '19 Oct 2026, 14:05');
  assert.equal(formatDateTime('2026-10-19T11:05:00Z', 'sw'), '19 Okt 2026, 2:05 mchana');
  assert.equal(formatDay('2026-08-03', 'sw'), '3 Ago 2026');
  // 21:30 UTC is already the next EAT day.
  assert.equal(formatDay('2026-10-19T21:30:00Z', 'en'), '20 Oct 2026');
});

test('share texts: both languages, SMS ≤ 160 GSM-7 characters (business cut with "...", then the amount dropped)', () => {
  const doc = { docType: 'receipt', number: 'R-000123', totalTzs: 95_000, seller: { businessName: 'Dar Fitness Gear and Supplements Limited of Kinondoni' } };
  const url = `${PUBLIC}/d/${'A'.repeat(22)}`;
  const en = shareTexts(doc, url, 'en');
  const sw = shareTexts(doc, `${url}?lang=sw`, 'sw');
  assert.equal(en.whatsapp, `Dar Fitness Gear and Supplements Limited of Kinondoni: Receipt R-000123, TSh 95,000. View it here: ${url}`);
  assert.match(sw.whatsapp, /: Risiti R-000123, TSh 95,000\. Itazame hapa: /);
  assert.ok(en.sms.length <= 160, en.sms);
  assert.match(en.sms, /^Dar Fitness Gear and\.\.\. Receipt R-000123 TSh 95,000: https/);
  assert.equal(/…/.test(en.sms), false, 'the one-character ellipsis is not GSM-7');
  const long = shareTexts(doc, `https://${'x'.repeat(90)}.example/d/${'A'.repeat(22)}`, 'en');
  assert.ok(long.sms.length <= 160 || !/TSh/.test(long.sms), 'too long → the amount is left out');
  assert.equal(pdfFileName({ docType: 'receipt', number: 'R-000123', seller: { businessName: 'Dar Fitness & Gear!' } }), 'R-000123_dar-fitness-gear.pdf');
  assert.equal(pdfFileName({ docType: 'statement', customer: { name: 'Juma Ali Mussa' }, statement: { asOf: '2026-10-19T21:30:00Z' } }), 'statement_JAM_2026-10-20.pdf');
  assert.equal(invoiceNumber(45), 'INV-000045');
  // Swahili audit #229 item 12: a curly quote or emoji in the business name never turns the SMS into UCS-2.
  const fancy = shareTexts({ ...doc, seller: { businessName: 'Mama’s “Best” 💪 Shop' } }, url, 'sw');
  assert.equal(fancy.sms, `Mama's "Best" Shop Risiti R-000123 TSh 95,000: ${url}`);
  assert.notEqual(gsmLength(fancy.sms), null, 'all GSM-7');
  assert.ok(gsmLength(fancy.sms) <= 160);
  assert.match(fancy.whatsapp, /^Mama’s “Best” 💪 Shop:/, 'WhatsApp keeps the name as written');
  assert.equal(gsmSafe('Duka – la “Juma”…'), 'Duka - la "Juma"...');
  assert.equal(gsmLength('[a]'), 5, 'extension characters count twice');
});

// ── gating ───────────────────────────────────────────────────────────────────

test('flags: VENDOR_DOCUMENTS off → every vendor document route 404 feature_disabled; options report documents', async () => {
  const v = await vendor();
  for (const [route, params] of [[vendorShareSale, { id: 'x' }], [vendorShareOrder, { id: 'x' }], [vendorSharePayment, { id: 'x', paymentId: 'y' }],
    [vendorShareStatement, { id: 'x' }], [vendorDocumentLinks, {}], [vendorRevokeDocumentLinks, {}], [vendorRevokeDocumentLink, { linkId: 'x' }], [vendorDocumentView, { docType: 'sale', docId: 'x' }]]) {
    const out = await call(route, as(v), { params });
    assert.deepEqual([out.status, out.body], [404, { error: 'feature_disabled' }], route.path);
  }
  assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.documents, false);
  on();
  assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.documents, true);
});

test('PUBLIC_API_URL unset → share answers 503 public_url_not_configured and makes no link', async () => {
  on();
  delete process.env.PUBLIC_API_URL;
  const v = await vendor();
  const p = await product(v);
  const sale = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(45_000)));
  const out = await shareSale(as(v), sale.id);
  assert.deepEqual([out.status, out.body], [503, { error: 'public_url_not_configured' }]);
  assert.equal((await db('VendorDocumentLink').where({ vendorId: v })).length, 0);
});

// ── links, public page ───────────────────────────────────────────────────────

test('share a receipt: one link, token returned once, only its hash stored; public page headers, no script, lastOpenedAt', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { name: 'Shaker', priceTzs: 10_000 });
  const sale = await sell(as(v), saleBody([{ productId: p.id, qty: 2 }], [{ method: 'cash', amountTzs: 25_000 }]));
  const out = await shareSale(as(v), sale.id, { lang: 'en' });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const b = out.body;
  assert.equal(b.docType, 'receipt');
  assert.equal(b.number, sale.number);
  assert.match(b.url, new RegExp(`^${PUBLIC}/d/[A-Za-z0-9_-]{22}$`));
  const token = tokenOf(b.url);
  assert.equal(b.texts.en.whatsapp, `Dar Fitness Gear: Receipt ${sale.number}, TSh 20,000. View it here: ${b.url}`);
  assert.equal(b.texts.sw.whatsapp, `Dar Fitness Gear: Risiti ${sale.number}, TSh 20,000. Itazame hapa: ${b.url}?lang=sw`);
  assert.equal(b.whatsappText, b.texts.en.whatsapp);
  const row = await db('VendorDocumentLink').where({ id: b.linkId }).first();
  assert.equal(row.tokenHash, hashToken(token));
  assert.equal(JSON.stringify(row).includes(token), false, 'the token itself is stored nowhere on the row');
  assert.equal(row.lastOpenedAt, null);

  const page = await open(`/d/${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('content-type'), /^text\/html; charset=utf-8/);
  // The logo is on our storage, shown from our own host (security fix 2026-10-28).
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'; img-src 'self' https:\/\/docs\.fitflex\.example( \S+)?; style-src 'unsafe-inline'/);
  assert.match(page.text, /<img class="logo" src="https:\/\/docs\.fitflex\.example\/storage\/bafylogo\/logo\.webp"/);
  assert.match(page.text, /<meta name="robots" content="noindex,nofollow">/);
  assert.equal(/<script/i.test(page.text), false, 'no JavaScript');
  assert.match(page.text, /<html lang="en">/);
  assert.match(page.text, new RegExp(`<h1>Receipt ${sale.number}</h1>`));
  assert.match(page.text, /This is not a TRA fiscal receipt\./);
  assert.match(page.text, /Change<\/span><span>TSh 5,000/);
  assert.match(page.text, /Served by Asha</, 'first name only');
  assert.ok((await db('VendorDocumentLink').where({ id: b.linkId }).first()).lastOpenedAt, 'opening sets lastOpenedAt');

  const sw = await open(`/d/${token}?lang=sw`);
  assert.match(sw.text, /<html lang="sw">/);
  assert.match(sw.text, new RegExp(`<h1>Risiti ${sale.number}</h1>`));
  assert.match(sw.text, /Hii si risiti ya kodi ya TRA\./);
  assert.match(sw.text, /Tarehe: \d+ \w+ \d{4}, \d{1,2}:\d{2} (asubuhi|mchana|jioni|usiku)</);
  assert.equal(/saa \d/.test(sw.text), false, 'not the six-hour Swahili clock');
  assert.match(sw.text, /Mhudumu: Asha/);
  assert.match(sw.text, /Taslimu/);
  assert.equal(/>Receipt</.test(sw.text), false, 'no English label left on the Swahili page');
  const odd = await open(`/d/${token}?lang=fr`);
  assert.match(odd.text, /<html lang="en">/, 'unknown lang → the link default');

  const list = await call(vendorDocumentLinks, as(v), { query: { docType: 'sale', docId: sale.id } });
  assert.equal(list.status, 200);
  assert.equal(list.body.activeCount, 1);
  const [l] = list.body.links;
  assert.deepEqual([l.n, l.docType, l.lang, l.active, l.createdBy.firstName, l.revokedAt], [1, 'receipt', 'en', true, 'Asha', null]);
  assert.ok(l.lastOpenedAt);
  assert.equal(JSON.stringify(list.body).includes(token), false, 'the URL is never listed');
});

test('identical 404s: unknown, malformed, revoked and flag-off links answer byte-identical pages; revoke and revoke-all', async () => {
  on();
  const v = await vendor();
  const p = await product(v);
  const sale = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(45_000)));
  const [a, b2, c] = [await shareSale(as(v), sale.id), await shareSale(as(v), sale.id, { lang: 'sw' }), await shareSale(as(v), sale.id)];
  const [ta, tb, tc] = [a, b2, c].map(x => tokenOf(x.body.url));
  assert.equal((await open(`/d/${ta}`)).status, 200);

  const unknown = await open(`/d/${newToken().token}`);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.text, renderUnavailable(null));
  assert.match(unknown.text, /This link isn&#39;t available/);
  assert.match(unknown.text, /Kiungo hiki hakipatikani/, 'both languages when the language is not known');
  assert.equal(unknown.headers.get('cache-control'), 'no-store');

  const one = await call(vendorRevokeDocumentLink, as(v), { params: { linkId: a.body.linkId } });
  assert.equal(one.status, 200);
  assert.equal(one.body.link.active, false);
  assert.ok(one.body.link.revokedAt);
  const again = await call(vendorRevokeDocumentLink, as(v), { params: { linkId: a.body.linkId } });
  assert.equal(again.body.link.revokedAt, one.body.link.revokedAt, 'revoking twice changes nothing');
  const revoked = await open(`/d/${ta}`);
  const malformed = await open('/d/not-a-token');
  assert.deepEqual([revoked.status, malformed.status], [404, 404]);
  assert.ok(revoked.buffer.equals(unknown.buffer), 'revoked = unknown, byte for byte');
  assert.ok(malformed.buffer.equals(unknown.buffer));
  assert.ok((await open(`/d/${ta}.pdf`)).buffer.equals(unknown.buffer), 'the PDF of a revoked link: the same page');
  assert.ok((await open(`/d/${newToken().token}?lang=sw`)).buffer.equals((await open(`/d/${ta}?lang=sw`)).buffer), 'with ?lang= too');

  const all = await call(vendorRevokeDocumentLinks, as(v), { body: { docType: 'sale', docId: sale.id } });
  assert.equal(all.status, 200);
  assert.equal(all.body.revokedCount, 2);
  assert.deepEqual(all.body.links.map(l => l.active), [false, false, false]);
  for (const t of [tb, tc]) assert.ok((await open(`/d/${t}`)).buffer.equals(unknown.buffer));

  // Flag off: a live link answers the same page too.
  const live = tokenOf((await shareSale(as(v), sale.id)).body.url);
  assert.equal((await open(`/d/${live}`)).status, 200);
  delete process.env.VENDOR_DOCUMENTS;
  const off = await open(`/d/${live}`);
  assert.equal(off.status, 404);
  assert.ok(off.buffer.equals(unknown.buffer), 'flag off = unknown, byte for byte');
});

test('rate limit: over 60 opens a minute from one address → 429 page with Retry-After', async () => {
  on();
  const ip = '10.99.99.99';
  for (let i = 0; i < VENDOR_DOCUMENT_LIMITS.publicPerIpPerMinute; i += 1) assert.equal((await open(`/d/${newToken().token}`, { ip })).status, 404);
  const limited = await open(`/d/${newToken().token}`, { ip });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.match(limited.text, /Too many requests/);
  assert.equal((await open(`/d/${newToken().token}`, { ip: '10.99.99.98' })).status, 404, 'another address is not affected');
});

// ── privacy (A-02) ───────────────────────────────────────────────────────────

test('privacy: no customer phone, email, address or note, no sale note, void reason, cost or staff surname — JSON, page and PDF; voided shows Cancelled', async () => {
  on();
  const v = await vendor();
  const seller = await staff(v, ['sales'], { displayName: 'Neema Mwakyusa' });
  const p = await product(v, { name: 'Gloves', priceTzs: 30_000, costTzs: 12_345 });
  await db('ProductPrivate').insert({ productId: p.id, variant: '', vendorId: v, costTzs: 12_345, updatedAt: new Date() }).onConflict(['productId', 'variant']).merge({ costTzs: 12_345 });
  const customer = await addCustomer(as(v), { name: 'Juma Mussa', phone: '0712345678', email: 'juma.private@example.com', address: 'Secret Street 9', note: 'VIP-NOTE-77' });
  const sale = await sell(staffOf(seller, v), saleBody([{ productId: p.id, qty: 1 }], cash(30_000), { customerId: customer.id, note: 'INTERNAL-NOTE-55' }));
  const link = await shareSale(as(v), sale.id, { lang: 'en' });
  const token = tokenOf(link.body.url);
  const json = await call(vendorDocumentView, as(v), { params: { docType: 'sale', docId: sale.id } });
  assert.equal(json.status, 200);
  const page = await open(`/d/${token}`);
  const pdf = await open(`/d/${token}.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const pdfWords = pdfText(pdf.buffer);
  assert.match(pdfWords, /This is not a TRA fiscal receipt\./, 'PDF text is readable by this helper');
  assert.match(pdfWords, /Juma Mussa/);
  const secrets = ['712345678', '+255712345678', 'juma.private@example.com', 'Secret Street 9', 'VIP-NOTE-77', 'INTERNAL-NOTE-55', '12,345', '12345', 'Mwakyusa', customer.id];
  for (const [what, text] of [['json', JSON.stringify(json.body)], ['html', page.text], ['pdf', pdfWords]]) {
    for (const secret of secrets) assert.equal(text.includes(secret), false, `${what} leaks ${secret}`);
  }
  assert.equal(json.body.doc.customer.name, 'Juma Mussa');
  assert.equal(json.body.doc.servedBy.firstName, 'Neema');
  for (const key of ['buyerUserId', 'unitCostTzs', 'costTzs', 'note', 'voidReason', 'commissionTzs', 'vendorPayoutTzs', 'phone', 'email']) {
    assert.equal(JSON.stringify(json.body).includes(`"${key}"`), false, `no ${key} key`);
  }

  // Voided (Q-2): the link still works and reads Cancelled — never the reason; no new links.
  assert.equal((await call(vendorVoidSale, as(v), { params: { id: sale.id }, body: { reason: 'SECRET-VOID-REASON' } })).status, 200);
  const cancelled = await open(`/d/${token}`);
  assert.equal(cancelled.status, 200);
  assert.match(cancelled.text, /Cancelled on \d+ \w+ \d{4}\. Dar Fitness Gear cancelled this document\./);
  assert.match(cancelled.text, /class="badge cancelled">Cancelled</);
  assert.equal(cancelled.text.includes('SECRET-VOID-REASON'), false);
  const cancelledPdf = pdfText((await open(`/d/${token}.pdf?lang=sw`)).buffer);
  assert.match(cancelledPdf, /CANCELLED ·[\s\S]*IMEBATILISHWA/, 'watermark (wraps to two lines on A4)');
  assert.equal(cancelledPdf.includes('SECRET-VOID-REASON'), false);
  assert.deepEqual((await shareSale(as(v), sale.id)).body, { error: 'document_cancelled' });
});

test('privacy, app buyers (A-02): order invoice by display name only; own lines only; no commission, payout, phone or address', async () => {
  on();
  const a = await vendor();
  const b = await vendor({ vendorProfile: JSON.stringify({ ...PROFILE, businessName: 'Other Shop' }) });
  const pa = await product(a, { name: 'Mat', priceTzs: 40_000 });
  const pb = await product(b, { name: 'Rope', priceTzs: 15_000 });
  const buyer = await user('member', { displayName: 'Rehema Buyer', phone: '+255754000111', email: 'rehema@example.com' });
  const order = await paidOrder(buyer, [{ productId: pa.id, qty: 1 }, { productId: pb.id, qty: 2 }]);
  const view = await call(vendorDocumentView, as(a), { params: { docType: 'order', docId: order.id } });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const doc = view.body.doc;
  assert.deepEqual([doc.docType, doc.status, doc.customer, doc.lines.map(l => l.name), doc.totalTzs], ['order_invoice', 'paid', { name: 'Rehema Buyer' }, ['Mat'], 40_000]);
  assert.equal(doc.soldVia, 'Seller: Dar Fitness Gear. Sold through the FitFlex app.');
  assert.equal(doc.paymentMethod, 'mpesa');
  assert.equal(doc.orderShortRef, order.id.slice(-6).toUpperCase());
  const text = JSON.stringify(view.body);
  for (const secret of ['+255754000111', 'rehema@example.com', 'Kinondoni Block 7', buyer, 'Rope', 'commission', 'Payout', 'payout', 'MP-']) assert.equal(text.includes(secret), false, `leaks ${secret}`);
  const share = await call(vendorShareOrder, as(a), { params: { id: order.id }, body: { lang: 'sw' } });
  assert.equal(share.status, 201);
  assert.match(share.body.url, /\?lang=sw$/);
  const page = await open(`/d/${tokenOf(share.body.url)}`);
  assert.match(page.text, /<html lang="sw">/, 'the link\'s language is the default');
  assert.match(page.text, /Muuzaji: Dar Fitness Gear\. Imeuzwa kupitia app ya FitFlex\./);
  for (const secret of ['+255754000111', 'rehema@example.com', 'Kinondoni', 'Rope']) assert.equal(page.text.includes(secret), false, `page leaks ${secret}`);
  // Another vendor's lines are never theirs to share; an unpaid order has no invoice yet.
  const unpaid = await placeOrder(buyer, [{ productId: pa.id, qty: 1 }]);
  assert.deepEqual((await call(vendorShareOrder, as(a), { params: { id: unpaid.order.id } })).body, { error: 'invoice_not_ready' });
  const pc = await product(b, { name: 'Band', priceTzs: 5_000 });
  const bOnly = await paidOrder(buyer, [{ productId: pc.id, qty: 1 }]);
  assert.deepEqual((await call(vendorShareOrder, as(a), { params: { id: bOnly.id } })).body, { error: 'order_not_found' });
});

// ── documents ────────────────────────────────────────────────────────────────

test('credit invoice: INV number with the R- sale ref, due date, live status; paid off → "Paid in full" on the same link', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { name: 'Dumbbell', priceTzs: 50_000 });
  const customer = await addCustomer(as(v), { name: 'Halima Said', phone: '0754123456' });
  const sale = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(10_000), { kind: 'credit', customerId: customer.id }));
  assert.match(sale.invoiceNumber, /^INV-\d{6}$/);
  const share = await shareSale(as(v), sale.id);
  assert.deepEqual([share.body.docType, share.body.number], ['invoice', sale.invoiceNumber]);
  const token = tokenOf(share.body.url);
  let page = await open(`/d/${token}`);
  assert.match(page.text, new RegExp(`<h1>Invoice ${sale.invoiceNumber}</h1>`));
  assert.match(page.text, new RegExp(`Sale ref ${sale.number}`));
  assert.match(page.text, /Due by \d+ \w+ \d{4}/);
  assert.match(page.text, /class="badge pay_later">Pay later</);
  assert.match(page.text, /Balance due: <strong>TSh 40,000<\/strong>/);
  const payment = await pay(as(v), customer.id, { amountTzs: 40_000 });
  page = await open(`/d/${token}`);
  assert.match(page.text, /class="badge paid_in_full">Paid in full</);
  assert.match(page.text, new RegExp(`Paid in full on \\d+ \\w+ \\d{4}<br>Paid with ${payment.number}`));

  // The payment receipt (customers): paid towards the INV number, still owed on it.
  const pr = await call(vendorSharePayment, as(v), { params: { id: customer.id, paymentId: payment.id } });
  assert.equal(pr.status, 201, JSON.stringify(pr.body));
  assert.equal(pr.body.number, payment.number);
  const receipt = await open(`/d/${tokenOf(pr.body.url)}`);
  assert.match(receipt.text, new RegExp(`<h1>Payment receipt ${payment.number}</h1>`));
  assert.match(receipt.text, new RegExp(`<span>${sale.invoiceNumber}</span><span>TSh 40,000</span>`));
  assert.match(receipt.text, /Still owed<\/span><span>TSh 0</);
  assert.equal(receipt.text.includes('754123456'), false);
  // Under another customer's path the payment is not found.
  const other = await addCustomer(as(v), { name: 'Other Person' });
  assert.deepEqual((await call(vendorSharePayment, as(v), { params: { id: other.id, paymentId: payment.id } })).body, { error: 'payment_not_found' });
});

test('statement link is a frozen snapshot (Q-9): a later payment never changes it; a new share shows the new figures', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { name: 'Bench', priceTzs: 100_000 });
  const customer = await addCustomer(as(v), { name: 'Baraka Juma', phone: '0765000111' });
  await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], [], { kind: 'credit', customerId: customer.id }));
  const first = await call(vendorShareStatement, as(v), { params: { id: customer.id } });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.docType, 'statement');
  assert.match(first.body.texts.en.whatsapp, /Statement .*, TSh 100,000\. View it here/);
  const snap = (await db('VendorDocumentLink').where({ id: first.body.linkId }).first()).snapshot;
  assert.equal(snap.totalOwedTzs, 100_000);
  await pay(as(v), customer.id, { amountTzs: 30_000 });
  const old = await open(`/d/${tokenOf(first.body.url)}`);
  assert.match(old.text, /Total owed<\/span><span>TSh 100,000/);
  assert.match(old.text, /As of \d+ \w+ \d{4}, \d{2}:\d{2}/);
  assert.equal(old.text.includes('765000111'), false);
  const second = await call(vendorShareStatement, as(v), { params: { id: customer.id } });
  const fresh = await open(`/d/${tokenOf(second.body.url)}`);
  assert.match(fresh.text, /Total owed<\/span><span>TSh 70,000/);
  assert.match(fresh.text, /PMT-\d{6}/);
  const pdf = await open(`/d/${tokenOf(first.body.url)}.pdf`);
  assert.match(pdf.headers.get('content-disposition'), /^inline; filename="statement_BJ_\d{4}-\d{2}-\d{2}\.pdf"$/);
});

test('numbering: INV is one continuous series per vendor across credit sales and order invoices, also under concurrency; another vendor starts at 1', async () => {
  on();
  const v = await vendor();
  const w = await vendor();
  const p = await product(v, { priceTzs: 10_000, stock: 200 });
  const q = await product(w, { priceTzs: 10_000, stock: 200 });
  const customer = await addCustomer(as(v), { name: 'Credit Buyer' });
  const wc = await addCustomer(as(w), { name: 'Other Buyer' });
  const buyer = await user('member', { displayName: 'App Buyer' });
  const results = await Promise.all([
    ...Array.from({ length: 6 }, () => call(vendorRecordSale, as(v), { body: saleBody([{ productId: p.id, qty: 1 }], [], { kind: 'credit', customerId: customer.id }) })),
    paidOrder(buyer, [{ productId: p.id, qty: 1 }]),
    paidOrder(buyer, [{ productId: p.id, qty: 2 }]),
  ]);
  for (const r of results.slice(0, 6)) assert.equal(r.status, 201, JSON.stringify(r.body));
  const credit = (await db('VendorSale').where({ vendorId: v, kind: 'credit' }).select('invoiceSeq')).map(r => r.invoiceSeq);
  const orders = (await db('VendorOrderInvoice').where({ vendorId: v }).select('seq')).map(r => r.seq);
  assert.deepEqual([...credit, ...orders].sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8], 'gap-free, shared');
  assert.ok((await db('VendorOrderInvoice').where({ vendorId: v })).every(r => r.number === invoiceNumber(r.seq)));
  const otherSale = await sell(as(w), saleBody([{ productId: q.id, qty: 1 }], [], { kind: 'credit', customerId: wc.id }));
  assert.equal(otherSale.invoiceNumber, 'INV-000001');
  const cashSale = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(10_000)));
  assert.equal(cashSale.invoiceNumber, null, 'a cash sale is a receipt only');
  // Issuing again for the same order and vendor never takes a second number.
  const [o] = results.slice(6);
  const again = await vendorDocumentService.orderPaid(await db('ShopOrder').where({ id: o.id }).first());
  assert.equal(again.issued, 0);
  assert.equal((await db('VendorOrderInvoice').where({ vendorId: v })).length, 2);
});

test('migration backfill: credit sales without an INV number get one per vendor in createdAt order; repeat-safe', async () => {
  on();
  const v = await vendor();
  const customer = await addCustomer(as(v), { name: 'Backfill Buyer' });
  const ids = [];
  for (const [i, when] of ['2026-06-03T09:00:00Z', '2026-06-01T09:00:00Z', '2026-06-02T09:00:00Z'].entries()) {
    const id = uid('sal');
    await db('VendorSale').insert({
      id, vendorId: v, seq: 800 + i, number: `R-BF${i}`, kind: 'credit', status: 'completed', customerId: customer.id, soldAt: when, createdAt: when,
      subtotalTzs: 1000, totalTzs: 1000, paidTzs: 0, changeTzs: 0, balanceTzs: 1000, dueDate: '2026-07-01', clientRef: uid('ref'), fingerprint: 'spec', createdBy: v,
    });
    ids.push(id);
  }
  const first = await migration.backfillCreditInvoiceNumbers(db);
  assert.ok(first.numbered >= 3);
  const rows = await db('VendorSale').where({ vendorId: v }).orderBy('createdAt').select('number', 'invoiceNumber');
  assert.deepEqual(rows.map(r => [r.number, r.invoiceNumber]), [['R-BF1', 'INV-000001'], ['R-BF2', 'INV-000002'], ['R-BF0', 'INV-000003']]);
  assert.equal((await migration.backfillCreditInvoiceNumbers(db)).numbered, 0, 'repeat-safe');
});

// ── permissions, tenancy ─────────────────────────────────────────────────────

test('permissions (§0.3): sales → receipts; customers → credit invoices, payment receipts, statements; orders → order invoices', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { priceTzs: 10_000, stock: 50 });
  const salesOnly = await staff(v, ['sales']);
  const customersOnly = await staff(v, ['customers']);
  const ordersOnly = await staff(v, ['orders']);
  const productsOnly = await staff(v, ['products']);
  const customer = await addCustomer(as(v), { name: 'Perm Buyer' });
  const cashSale = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(10_000)));
  const creditSale = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], [], { kind: 'credit', customerId: customer.id }));
  const payment = await pay(as(v), customer.id, { amountTzs: 5_000 });
  const order = await paidOrder(await user('member'), [{ productId: p.id, qty: 1 }]);
  const tries = async claims => [
    (await shareSale(claims, cashSale.id)).status,
    (await shareSale(claims, creditSale.id)).status,
    (await call(vendorSharePayment, claims, { params: { id: customer.id, paymentId: payment.id } })).status,
    (await call(vendorShareStatement, claims, { params: { id: customer.id } })).status,
    (await call(vendorShareOrder, claims, { params: { id: order.id } })).status,
    (await call(vendorDocumentView, claims, { params: { docType: 'order', docId: order.id } })).status,
  ];
  assert.deepEqual(await tries(as(v)), [201, 201, 201, 201, 201, 200]);
  assert.deepEqual(await tries(staffOf(salesOnly, v)), [201, 201, 403, 403, 403, 403]);
  assert.deepEqual(await tries(staffOf(customersOnly, v)), [403, 201, 201, 201, 403, 403]);
  assert.deepEqual(await tries(staffOf(ordersOnly, v)), [403, 403, 403, 403, 201, 200]);
  const none = await shareSale(staffOf(productsOnly, v), cashSale.id);
  assert.deepEqual([none.status, none.body.error], [403, 'vendor_permission_forbidden']);
  const forbidden = await call(vendorSharePayment, staffOf(salesOnly, v), { params: { id: customer.id, paymentId: payment.id } });
  assert.deepEqual(forbidden.body, { error: 'vendor_permission_forbidden', requiredPermission: 'customers', acceptedPermissions: ['customers'] });
  // Links of a document follow the same rule: sales-only staff see sale links, not statement links.
  assert.equal((await call(vendorDocumentLinks, staffOf(salesOnly, v), { query: { docType: 'sale', docId: cashSale.id } })).status, 200);
  assert.equal((await call(vendorDocumentLinks, staffOf(salesOnly, v), { query: { docType: 'statement', docId: customer.id } })).status, 403);
  const statementLink = (await db('VendorDocumentLink').where({ vendorId: v, docType: 'statement' }).first()).id;
  assert.equal((await call(vendorRevokeDocumentLink, staffOf(salesOnly, v), { params: { linkId: statementLink } })).status, 403);
  // Staff of a suspended vendor (as S3/S4).
  await db('User').where({ id: v }).update({ accountStatus: 'suspended' });
  assert.deepEqual((await shareSale(staffOf(salesOnly, v), cashSale.id)).body, { error: 'vendor_suspended' });
  await db('User').where({ id: v }).update({ accountStatus: 'active' });
});

test('tenancy: another vendor cannot view, share, list or revoke my documents', async () => {
  on();
  const a = await vendor();
  const b = await vendor();
  const p = await product(a);
  const sale = await sell(as(a), saleBody([{ productId: p.id, qty: 1 }], cash(45_000)));
  const link = await shareSale(as(a), sale.id);
  assert.deepEqual((await shareSale(as(b), sale.id)).body, { error: 'sale_not_found' });
  assert.deepEqual((await call(vendorDocumentView, as(b), { params: { docType: 'sale', docId: sale.id } })).body, { error: 'sale_not_found' });
  assert.deepEqual((await call(vendorDocumentLinks, as(b), { query: { docType: 'sale', docId: sale.id } })).body, { links: [], activeCount: 0 });
  assert.deepEqual((await call(vendorRevokeDocumentLink, as(b), { params: { linkId: link.body.linkId } })).body, { error: 'link_not_found' });
  const all = await call(vendorRevokeDocumentLinks, as(b), { body: { docType: 'sale', docId: sale.id } });
  assert.equal(all.body.revokedCount, 0);
  assert.equal((await open(`/d/${tokenOf(link.body.url)}`)).status, 200, 'still live');
  // A deleted vendor's links are unavailable (identical 404).
  const gone = await vendor();
  const gp = await product(gone);
  const gs = await sell(as(gone), saleBody([{ productId: gp.id, qty: 1 }], cash(45_000)));
  const gl = tokenOf((await shareSale(as(gone), gs.id)).body.url);
  await db('User').where({ id: gone }).update({ userType: 'member' });
  assert.equal((await open(`/d/${gl}`)).status, 404);
  await db('User').where({ id: gone }).update({ userType: 'vendor' });
});

// ── PDF and logged-in views ──────────────────────────────────────────────────

test('PDF: A4 and 80mm through the logged-in view (no link made) and the public link; tagged, titled, page footer', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { name: 'Kettlebell', priceTzs: 20_000, stock: 500 });
  const lines = Array.from({ length: 40 }, () => ({ productId: p.id, qty: 1 }));
  const sale = await sell(as(v), saleBody(lines, cash(800_000)));
  const view = await open(`/vendor/documents/sale/${sale.id}?format=pdf&lang=sw`, { claims: as(v) });
  assert.equal(view.status, 200, view.text.slice(0, 200));
  assert.equal(view.headers.get('content-type'), 'application/pdf');
  assert.match(view.headers.get('content-disposition'), new RegExp(`^attachment; filename="${sale.number}_dar-fitness-gear\\.pdf"$`));
  assert.equal(view.buffer.subarray(0, 5).toString(), '%PDF-');
  const raw = view.buffer.toString('latin1');
  assert.match(raw, /\/Lang \(sw\)/);
  assert.match(raw, /\/MarkInfo/);
  assert.match(raw, /\/StructTreeRoot/);
  const titleRef = raw.match(/\/Title (\d+) 0 R/)[1];
  assert.match(raw, new RegExp(`\\n${titleRef} 0 obj\\n\\(Risiti R-\\d{6}\\)`), 'Title metadata');
  assert.match(raw, /\/DisplayDocTitle true/);
  const text = pdfText(view.buffer);
  assert.match(text, /Ukurasa 1 kati ya 2/);
  assert.match(text, /Ukurasa 2 kati ya 2/);
  assert.equal((text.match(/Hii si risiti ya kodi ya TRA\./g) || []).length >= 2, true, 'the not-fiscal line on every page');
  assert.equal((text.match(/Bidhaa/g) || []).length >= 2, true, 'the table header repeats on page 2');
  assert.ok(view.buffer.length < 150_000, `A4 PDF is small (${view.buffer.length} bytes)`);
  assert.equal(await db('VendorDocumentLink').where({ vendorId: v }).count('* as n').first().then(r => Number(r.n)), 0, 'Send PDF makes no link');

  const thermal = await open(`/vendor/documents/sale/${sale.id}?format=pdf&paper=80mm`, { claims: as(v) });
  assert.equal(thermal.status, 200);
  const box = thermal.buffer.toString('latin1').match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
  assert.equal(Math.round(Number(box[1]) / (72 / 25.4)), 80, '80 mm wide');
  assert.ok(Number(box[2]) > Number(box[1]), 'continuous height');

  const html = await open(`/vendor/documents/sale/${sale.id}?format=html`, { claims: as(v) });
  assert.match(html.headers.get('content-type'), /^text\/html/);
  assert.equal(/<script/i.test(html.text), false);
  assert.equal(html.text.includes('class="bar"'), false, 'the embedded view has no language bar (the portal has its toolbar)');
  const bad = await call(vendorDocumentView, as(v), { params: { docType: 'sale', docId: sale.id }, query: { format: 'docx' } });
  assert.equal(bad.body.error, 'invalid_format');
  const link = tokenOf((await shareSale(as(v), sale.id)).body.url);
  const pub = await open(`/d/${link}.pdf?paper=80mm`);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(pub.headers.get('content-disposition'), /^inline; /);
});

// ── buyer invoice ────────────────────────────────────────────────────────────

test('buyer invoice: text default unchanged; json/html/pdf behind VENDOR_DOCUMENTS; one invoice per seller; unpaid → 404', async () => {
  const a = await vendor();
  const b = await vendor({ vendorProfile: JSON.stringify({ ...PROFILE, businessName: 'Second Seller' }) });
  const pa = await product(a, { name: 'Mat', priceTzs: 40_000 });
  const pb = await product(b, { name: 'Rope', priceTzs: 15_000 });
  const buyer = await user('member', { displayName: 'Two Seller Buyer' });
  const order = await paidOrder(buyer, [{ productId: pa.id, qty: 1 }, { productId: pb.id, qty: 2 }]);
  const me = { sub: buyer, userType: 'member' };
  const text = await call(marketplaceInvoice, me, { params: { id: order.id } });
  assert.match(text.body, /^FitFlex Marketplace Invoice\nOrder: /);
  assert.deepEqual((await call(marketplaceInvoice, me, { params: { id: order.id }, query: { format: 'json' } })).body, { error: 'feature_disabled' });
  on();
  assert.match((await call(marketplaceInvoice, me, { params: { id: order.id } })).body, /^FitFlex Marketplace Invoice/, 'text stays the default');
  const json = await call(marketplaceInvoice, me, { params: { id: order.id }, query: { format: 'json' } });
  assert.equal(json.status, 200, JSON.stringify(json.body));
  const byVendor = Object.fromEntries(json.body.invoices.map(i => [i.vendorId, i]));
  assert.deepEqual(byVendor[a].lines.map(l => l.name), ['Mat']);
  assert.deepEqual(byVendor[b].lines.map(l => l.name), ['Rope']);
  assert.match(byVendor[a].number, /^INV-\d{6}$/);
  assert.equal(byVendor[b].seller.businessName, 'Second Seller');
  assert.equal(byVendor[a].customer.name, 'Two Seller Buyer');
  assert.equal(JSON.stringify(json.body).includes('commission'), false);
  const needsVendor = (await call(marketplaceInvoice, me, { params: { id: order.id }, query: { format: 'pdf' } })).body;
  assert.equal(needsVendor.error, 'vendor_required');
  assert.deepEqual([...needsVendor.vendors].sort(), [a, b].sort());
  const pdf = await call(marketplaceInvoice, me, { params: { id: order.id }, query: { format: 'pdf', vendorId: b } });
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(pdf.body).subarray(0, 5).toString(), '%PDF-');
  const html = await call(marketplaceInvoice, me, { params: { id: order.id }, query: { format: 'html', lang: 'sw' } });
  assert.equal((html.body.match(/<html/g) || []).length, 1, 'one page');
  assert.equal((html.body.match(/<main>/g) || []).length, 2, 'two invoices');
  assert.match(html.body, /Ankara INV-/);
  // Someone else's order, an unpaid one.
  const stranger = { sub: await user('member'), userType: 'member' };
  assert.deepEqual((await call(marketplaceInvoice, stranger, { params: { id: order.id }, query: { format: 'json' } })).body, { error: 'order_not_found' });
  const unpaid = await placeOrder(buyer, [{ productId: pa.id, qty: 1 }]);
  assert.deepEqual((await call(marketplaceInvoice, me, { params: { id: unpaid.order.id }, query: { format: 'json' } })).body, { error: 'invoice_not_ready' });
  // An order paid before S5 (no invoice row) gets one on first request (issued late, no VAT).
  await db('VendorOrderInvoice').where({ orderId: order.id, vendorId: a }).del();
  const late = await call(marketplaceInvoice, me, { params: { id: order.id }, query: { format: 'json' } });
  assert.equal(late.body.invoices.length, 2);
  assert.equal((await db('VendorOrderInvoice').where({ orderId: order.id, vendorId: a }).first()).lateIssued, true);
});

// ── security review #229 ─────────────────────────────────────────────────────

test('#229 M1: a member who deletes their account is not named on statement links shared earlier (snapshot scrubbed, page checks too)', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { name: 'Bar', priceTzs: 20_000, stock: 50 });
  const buyer = await user('member', { displayName: 'Forget Me Please' });
  await paidOrder(buyer, [{ productId: p.id, qty: 1 }]);
  const customer = await db('VendorCustomer').where({ vendorId: v, buyerUserId: buyer }).first();
  assert.equal(customer.name, 'Forget Me Please');
  await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], [], { kind: 'credit', customerId: customer.id }));
  const link = await call(vendorShareStatement, as(v), { params: { id: customer.id } });
  assert.equal(link.status, 201, JSON.stringify(link.body));
  const token = tokenOf(link.body.url);
  assert.match((await open(`/d/${token}`)).text, /Forget Me Please/);
  const out = await vendorCustomerService.forgetBuyer(buyer);
  assert.equal(out.snapshotsScrubbed, 1);
  const snap = (await db('VendorDocumentLink').where({ id: link.body.linkId }).first()).snapshot;
  assert.deepEqual(snap.customer, { name: null });
  assert.equal(snap.totalOwedTzs, 20_000, 'the figures stay; only the name goes');
  const page = await open(`/d/${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.text.includes('Forget Me'), false);
  assert.equal(pdfText((await open(`/d/${token}.pdf`)).buffer).includes('Forget Me'), false);
  // Even a snapshot that still carried the name (e.g. written in a race) is rendered nameless.
  await db('VendorDocumentLink').where({ id: link.body.linkId }).update({ snapshot: JSON.stringify({ ...snap, customer: { name: 'Forget Me Please' } }) });
  assert.equal((await open(`/d/${token}`)).text.includes('Forget Me'), false);
});

test('#229 M2: malformed tokens skip every limiter; per-link counting only for real links; true cap; IP from the trusted proxy hop', async () => {
  on();
  // Limiter cap is a hard cap (oldest evicted).
  const capped = createVendorLimiter({ perMinute: 1, maxTracked: 3 });
  for (const k of ['a', 'b', 'c', 'd', 'e']) assert.equal(capped.allow(k, 1000).ok, true);
  assert.equal(capped.size(), 3);
  assert.equal(capped.allow('e', 1001).ok, false, 'the newest key is still tracked');
  assert.equal(capped.allow('a', 1001).ok, true, 'the oldest was evicted');
  // Trusted hop: the entry our nearest proxy appended (rightmost by default).
  const req = xff => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '127.0.0.9' } });
  assert.equal(clientAddress(req('6.6.6.6, 10.0.0.9'), 1), '10.0.0.9');
  assert.equal(clientAddress(req('6.6.6.6, 10.0.0.9'), 2), '6.6.6.6');
  assert.equal(clientAddress(req('6.6.6.6, 10.0.0.9'), 0), '127.0.0.9', '0 hops: X-Forwarded-For ignored');
  assert.equal(clientAddress(req(''), 1), '127.0.0.9');
  assert.equal(clientAddress(req('10.0.0.9')), '10.0.0.9');
  process.env.PUBLIC_DOCS_TRUSTED_PROXY_HOPS = '';
  try { assert.equal(clientAddress(req('6.6.6.6, 10.0.0.9')), '10.0.0.9', 'empty setting = default 1, never 0'); } finally { delete process.env.PUBLIC_DOCS_TRUSTED_PROXY_HOPS; }

  resetVendorDocumentLimits();
  const ip = '10.77.0.1';
  for (let i = 0; i < 80; i += 1) assert.equal((await open('/d/bad-token', { ip })).status, 404);
  assert.deepEqual(publicLimiterSizes(), { ip: 0, token: 0 }, 'malformed tokens touch no limiter');
  for (let i = 0; i < 10; i += 1) assert.equal((await open(`/d/${newToken().token}`, { ip })).status, 404);
  assert.deepEqual(publicLimiterSizes(), { ip: 1, token: 0 }, 'unknown well-formed tokens count per address, never per token');
  // A client cannot escape the address limit by forging the left part of X-Forwarded-For.
  resetVendorDocumentLimits();
  for (let i = 0; i < VENDOR_DOCUMENT_LIMITS.publicPerIpPerMinute; i += 1) {
    assert.equal((await open(`/d/${newToken().token}`, { ip: `9.9.9.${i % 250}, 10.77.0.2` })).status, 404);
  }
  assert.equal((await open(`/d/${newToken().token}`, { ip: '1.1.1.1, 10.77.0.2' })).status, 429);
  // A real link is counted per token.
  resetVendorDocumentLimits();
  const v = await vendor();
  const p = await product(v);
  const sale = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(45_000)));
  const token = tokenOf((await shareSale(as(v), sale.id)).body.url);
  assert.equal((await open(`/d/${token}`)).status, 200);
  assert.equal(publicLimiterSizes().token, 1);
});

test('#229 L2: staff without the permission get 403 before anything is loaded — no id probing, no invoice numbered', async () => {
  on();
  const v = await vendor();
  const p = await product(v);
  const ordersOnly = await staff(v, ['orders']);
  const salesOnly = await staff(v, ['sales']);
  const unknown = await call(vendorDocumentView, staffOf(ordersOnly, v), { params: { docType: 'sale', docId: 'sal_does_not_exist' } });
  assert.deepEqual([unknown.status, unknown.body.error, unknown.body.acceptedPermissions], [403, 'vendor_permission_forbidden', ['sales', 'customers']]);
  assert.equal((await shareSale(staffOf(ordersOnly, v), 'sal_does_not_exist')).status, 403);
  assert.equal((await call(vendorShareStatement, staffOf(salesOnly, v), { params: { id: 'cus_nope' } })).status, 403);
  const order = await paidOrder(await user('member'), [{ productId: p.id, qty: 1 }]);
  await db('VendorOrderInvoice').where({ orderId: order.id }).del(); // as for an order paid before S5
  assert.equal((await call(vendorShareOrder, staffOf(salesOnly, v), { params: { id: order.id } })).status, 403);
  assert.equal((await call(vendorDocumentView, staffOf(salesOnly, v), { params: { docType: 'order', docId: order.id } })).status, 403);
  assert.equal((await db('VendorOrderInvoice').where({ orderId: order.id })).length, 0, 'no invoice was numbered by a forbidden call');
});

test('#229 L5: the buyer HTML invoice carries nosniff, frame-ancestors none and no-referrer', async () => {
  on();
  const v = await vendor();
  const p = await product(v);
  const buyer = await user('member', { displayName: 'Header Buyer' });
  const order = await paidOrder(buyer, [{ productId: p.id, qty: 1 }]);
  const html = await call(marketplaceInvoice, { sub: buyer, userType: 'member' }, { params: { id: order.id }, query: { format: 'html' } });
  assert.equal(html.status, 200);
  assert.equal(html.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(html.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.equal(html.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(html.headers['Cache-Control'], 'no-store, private');
});

// ── Swahili audit #229 ───────────────────────────────────────────────────────

test('#229 Swahili: statement labels (Kufikia, Mwisho wa kulipa, Jumla inayodaiwa, Bado muda haujafika); a cancelled ORDER reads Imeghairiwa, a voided sale Imebatilishwa', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { name: 'Ball', priceTzs: 30_000, stock: 50 });
  const customer = await addCustomer(as(v), { name: 'Saidi Ally' });
  await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], [], { kind: 'credit', customerId: customer.id }));
  const st = await call(vendorShareStatement, as(v), { params: { id: customer.id }, body: { lang: 'sw' } });
  const page = (await open(`/d/${tokenOf(st.body.url)}`)).text;
  for (const text of ['Kufikia ', 'Mwisho wa kulipa', 'Jumla inayodaiwa', 'Bado muda haujafika']) assert.ok(page.includes(text), text);
  for (const old of ['Hadi ', 'Jumla ya deni', 'Bado haijafika']) assert.equal(page.includes(old), false, old);

  const buyer = await user('member', { displayName: 'Cancel Buyer' });
  const order = await paidOrder(buyer, [{ productId: p.id, qty: 1 }]);
  const link = await call(vendorShareOrder, as(v), { params: { id: order.id }, body: { lang: 'sw' } });
  assert.equal(link.status, 201);
  const cancelled = await shopService.updateOrderStatus({ orderId: order.id, status: 'cancelled', actorId: v, reason: 'out of stock' });
  assert.equal(cancelled.error, undefined, JSON.stringify(cancelled));
  const orderPage = (await open(`/d/${tokenOf(link.body.url)}`)).text;
  assert.match(orderPage, /class="badge cancelled">Imeghairiwa</);
  assert.match(orderPage, /Imeghairiwa tarehe \d+ \w+ \d{4}\. Oda hii imeghairiwa\./);
  assert.equal(orderPage.includes('Imebatilishwa'), false);
  assert.equal(orderPage.includes('out of stock'), false, 'never the reason');
  assert.match(pdfText((await open(`/d/${tokenOf(link.body.url)}.pdf?lang=sw`)).buffer), /CANCELLED ·[\s\S]*IMEGHAIRIWA/);
  assert.match((await open(`/d/${tokenOf(link.body.url)}?lang=en`)).text, /Cancelled on \d+ \w+ \d{4}\. This order was cancelled\./);
});

/** Every text run of a pdfkit PDF with its box: { page, x, y, w, text } (fonts read from the page resources). */
function pdfRuns(buffer) {
  const s = buffer.toString('latin1');
  const objects = new Map([...s.matchAll(/\n(\d+) 0 obj\n([\s\S]*?)\nendobj/g)].map(m => [m[1], m[2]]));
  const measure = new PDFDocument({ autoFirstPage: false });
  const runs = [];
  let page = 0;
  for (const [, body] of objects) {
    if (!/\/Type \/Page\b/.test(body)) continue;
    page += 1;
    const fonts = new Map();
    const res = objects.get(body.match(/\/Resources (\d+) 0 R/)?.[1]) || body;
    const fontDict = res.match(/\/Font <<([\s\S]*?)>>/)?.[1] || objects.get(res.match(/\/Font (\d+) 0 R/)?.[1]) || '';
    for (const f of fontDict.matchAll(/\/(F\d+) (\d+) 0 R/g)) fonts.set(f[1], objects.get(f[2]).match(/\/BaseFont \/([\w-]+)/)[1]);
    for (const ref of (body.match(/\/Contents \[?([\d\s0R]+)\]?/)?.[1] || '').matchAll(/(\d+) 0 R/g)) {
      const obj = objects.get(ref[1]);
      const raw = streamData(obj, 0, obj.indexOf('\nstream\n') + '\nstream\n'.length);
      const data = zlib.inflateSync(Buffer.from(raw, 'latin1')).toString('latin1');
      let font = 'Helvetica', size = 10, x = 0, y = 0;
      for (const op of data.matchAll(/\/(F\d+) ([\d.]+) Tf|1 0 0 1 ([-\d.]+) ([-\d.]+) Tm|\[(.*?)\] TJ/g)) {
        if (op[1]) { font = fonts.get(op[1]); size = Number(op[2]); continue; }
        if (op[3]) { x = Number(op[3]); y = Number(op[4]); continue; }
        const text = [...op[5].matchAll(/<([0-9a-fA-F]*)>/g)].map(h => Buffer.from(h[1], 'hex').toString('latin1')).join('');
        const kern = [...op[5].matchAll(/>\s*(-?[\d.]+)\s*</g)].reduce((t, k) => t + Number(k[1]), 0);
        measure.font(font).fontSize(size);
        runs.push({ page, x, y, w: measure.widthOfString(text) - (kern / 1000) * size, text });
      }
    }
  }
  return runs;
}

test('#229 PDF layout: a Swahili A4 PDF with 7-digit amounts and a long payment reference has no overlapping text on any line', async () => {
  const lines = [
    { lineNo: 1, nameSnapshot: 'Mashine ya kukimbia ya kisasa yenye skrini kubwa', variant: 'Nyeusi', qty: 1, unitPriceTzs: 7_654_321, discountTzs: 1_234_567, lineTotalTzs: 6_419_754, saleDiscountShareTzs: 0, vatCode: 'A', vatRatePct: 18, vatTzs: includedVatOf(6_419_754) },
    { lineNo: 2, nameSnapshot: 'Kamba', variant: '', qty: 3, unitPriceTzs: 1_000_000, discountTzs: 0, lineTotalTzs: 3_000_000, saleDiscountShareTzs: 0, vatCode: 'E', vatRatePct: 0, vatTzs: 0 },
  ];
  const sale = { kind: 'credit', status: 'completed', number: 'R-000999', invoiceNumber: 'INV-000999', balanceTzs: 1_419_754, dueDate: '2026-11-30', soldAt: '2026-10-20T11:05:00Z', subtotalTzs: 10_654_321, lineDiscountTzs: 1_234_567, discountTzs: 0, totalTzs: 9_419_754, paidTzs: 8_000_000, allocatedTzs: 0, changeTzs: 0 };
  const doc = saleDocument({
    sale, lines, today: '2026-10-20', allocations: [], customer: { name: 'Mteja Mwenye Jina Refu Sana' }, servedByName: 'Neema',
    payments: [{ position: 1, method: 'airtel_money', reference: 'AIRTEL-REF-00012345678901234567890', amountTzs: 7_000_000 }, { position: 2, method: 'bank', reference: 'CRDB TT 2026/10/20 KARIAKOO BRANCH 0001', amountTzs: 1_000_000 }],
    seller: { businessName: 'Duka Kubwa la Vifaa vya Mazoezi Kariakoo', contactNumber: '+255700000000', tin: '123456789', vrn: '40012345X' },
  }, 'sw');
  const pdf = await renderDocumentPdf(doc, { lang: 'sw' });
  const runs = pdfRuns(pdf);
  const all = runs.map(r => r.text).join('|');
  assert.match(all, /Inajumuisha VAT TSh 979,285/);
  assert.match(all, /Airtel Money \(AIRTEL-\|?REF-0001/, 'the long reference wraps inside its column');
  assert.match(all, /TSh 9,419,754/);
  const byLine = new Map();
  for (const r of runs) {
    const key = `${r.page}:${Math.round(r.y)}`;
    byLine.set(key, [...(byLine.get(key) || []), r]);
  }
  for (const [key, row] of byLine) {
    row.sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i += 1) {
      const prev = row[i - 1];
      assert.ok(prev.x + prev.w <= row[i].x + 0.5, `overlap on ${key}: "${prev.text}" (${prev.x.toFixed(1)}+${prev.w.toFixed(1)}) runs into "${row[i].text}" at ${row[i].x.toFixed(1)}`);
    }
  }
});
const includedVatOf = net => Math.floor((2 * net * 1800 + 11800) / (2 * 11800));

test('#229 contract: pdfkit is loaded lazily — without it the backend runs, HTML works, and every PDF route answers 503 pdf_unavailable', async () => {
  for (const dir of ['src', 'functions']) {
    const files = fs.readdirSync(path.join(root, dir), { recursive: true }).filter(f => String(f).endsWith('.mjs'));
    for (const f of files) assert.equal(/^import [^;]*from 'pdfkit'/m.test(fs.readFileSync(path.join(root, dir, String(f)), 'utf8')), false, `${dir}/${f} imports pdfkit at start-up`);
  }
  on();
  const v = await vendor();
  const p = await product(v);
  const sale = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(45_000)));
  const token = tokenOf((await shareSale(as(v), sale.id)).body.url);
  const buyer = await user('member');
  const order = await paidOrder(buyer, [{ productId: p.id, qty: 1 }]);
  setPdfkitLoaderForTests(async () => { throw new Error("Cannot find package 'pdfkit'"); });
  try {
    assert.deepEqual((await call(vendorDocumentView, as(v), { params: { docType: 'sale', docId: sale.id }, query: { format: 'pdf' } })).body, { error: 'pdf_unavailable' });
    assert.equal((await call(vendorDocumentView, as(v), { params: { docType: 'sale', docId: sale.id }, query: { format: 'pdf' } })).status, 503);
    const pub = await open(`/d/${token}.pdf`);
    assert.equal(pub.status, 503);
    assert.match(pub.text, /The PDF couldn&#39;t be made/);
    assert.equal((await open(`/d/${token}`)).status, 200, 'the page itself still works');
    const bp = await call(marketplaceInvoice, { sub: buyer, userType: 'member' }, { params: { id: order.id }, query: { format: 'pdf' } });
    assert.deepEqual([bp.status, bp.body], [503, { error: 'pdf_unavailable' }]);
    assert.equal((await call(vendorDocumentView, as(v), { params: { docType: 'sale', docId: sale.id }, query: { format: 'html' } })).status, 200);
  } finally { setPdfkitLoaderForTests(null); }
  assert.equal((await open(`/d/${token}.pdf`)).status, 200, 'loads again once available');
});

// ── UAT (S5) ─────────────────────────────────────────────────────────────────

test('UAT D4: discounts read "-TSh 1,500" on the page (list, table, totals), the A4 PDF and the 80mm PDF', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { name: 'Socks', priceTzs: 10_000, stock: 50 });
  const sale = await sell(as(v), saleBody([{ productId: p.id, qty: 1, discountTzs: 1_500 }], cash(7_500), { discountTzs: 1_000 }));
  const token = tokenOf((await shareSale(as(v), sale.id)).body.url);
  const page = (await open(`/d/${token}`)).text;
  assert.match(page, /Discount -TSh 1,500/, 'line, phone layout');
  assert.match(page, /<td class="n">-TSh 1,500<\/td>/, 'line, table');
  assert.match(page, /Discounts<\/span><span>-TSh 2,500</, 'totals');
  assert.equal(/[\s>]-\d{1,3}(,\d{3})*\b/.test(page), false, 'no bare "-1,500"');
  const a4 = pdfText((await open(`/d/${token}.pdf`)).buffer);
  assert.match(a4, /-TSh 1,500/);
  assert.match(a4, /-TSh 2,500/);
  assert.equal(/(^|\s)-\d{1,3}(,\d{3})*\b/m.test(a4), false, 'no bare discount in the A4 PDF');
  const thermal = pdfText((await open(`/d/${token}.pdf?paper=80mm`)).buffer);
  assert.match(thermal, /-TSh 1,500/);
  assert.match(thermal, /-TSh 2,500/);
});

test('UAT D6: listing and turning off links follow the document\'s own permission (customers-only staff on a cash receipt → 403)', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { priceTzs: 10_000, stock: 50 });
  const customersOnly = await staff(v, ['customers']);
  const salesOnly = await staff(v, ['sales']);
  const ordersOnly = await staff(v, ['orders']);
  const customer = await addCustomer(as(v), { name: 'Links Buyer' });
  const cashSale = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], cash(10_000)));
  const creditSale = await sell(as(v), saleBody([{ productId: p.id, qty: 1 }], [], { kind: 'credit', customerId: customer.id }));
  await shareSale(as(v), cashSale.id);
  await shareSale(as(v), creditSale.id);
  const list = (claims, docType, docId) => call(vendorDocumentLinks, claims, { query: { docType, docId } });
  const revokeAll = (claims, docType, docId) => call(vendorRevokeDocumentLinks, claims, { body: { docType, docId } });
  for (const docType of ['sale', 'receipt']) {
    const out = await list(staffOf(customersOnly, v), docType, cashSale.id);
    assert.deepEqual([out.status, out.body.error, out.body.requiredPermission], [403, 'vendor_permission_forbidden', 'sales'], docType);
    assert.equal((await revokeAll(staffOf(customersOnly, v), docType, cashSale.id)).status, 403, docType);
  }
  assert.equal((await db('VendorDocumentLink').where({ docId: cashSale.id }).whereNull('revokedAt')).length, 1, 'nothing was turned off');
  const credit = await list(staffOf(customersOnly, v), 'sale', creditSale.id);
  assert.deepEqual([credit.status, credit.body.activeCount, credit.body.links[0].docType], [200, 1, 'invoice']);
  assert.equal((await list(staffOf(salesOnly, v), 'sale', cashSale.id)).body.activeCount, 1);
  assert.equal((await list(staffOf(salesOnly, v), 'invoice', creditSale.id)).body.activeCount, 1);
  assert.equal((await list(staffOf(ordersOnly, v), 'sale', cashSale.id)).status, 403);
  assert.equal((await list(staffOf(salesOnly, v), 'statement', customer.id)).status, 403);
  assert.deepEqual((await list(as(v), 'invoice', cashSale.id)).body, { links: [], activeCount: 0 }, 'a cash sale has no invoice links');
  const off = await revokeAll(staffOf(customersOnly, v), 'sale', creditSale.id);
  assert.deepEqual([off.status, off.body.revokedCount], [200, 1]);
});

test('UAT D7: the 429, server-error and PDF-failed pages say their message once (short heading + one sentence)', async () => {
  const { renderRateLimited, renderServerError, renderPdfFailed } = await import('../src/shared/vendor-document-html.mjs');
  const bodyOf = html => html.slice(html.indexOf('<main>'));
  const once = (html, text) => assert.equal(bodyOf(html).split(text).length - 1, 1, `${text} once`);
  const en = renderRateLimited('en');
  assert.match(en, /<title>Too many requests<\/title>/);
  assert.match(bodyOf(en), /<h1>Too many requests<\/h1><p>Try again in a minute\.<\/p>/);
  once(en, 'Too many requests'); once(en, 'Try again in a minute.');
  const sw = renderRateLimited('sw');
  assert.match(bodyOf(sw), /<h1>Maombi ni mengi mno<\/h1><p>Jaribu tena baada ya dakika moja\.<\/p>/);
  once(sw, 'Jaribu tena baada ya dakika moja.');
  const both = renderRateLimited(null);
  once(both, 'Try again in a minute.'); once(both, 'Jaribu tena baada ya dakika moja.');
  const pdf = renderPdfFailed('en', 'TOKEN');
  assert.match(bodyOf(pdf), /<h1>PDF not available<\/h1><p>The PDF couldn&#39;t be made\. You can still view the page\.<\/p><p><a href="TOKEN\?lang=en">Back to the document<\/a><\/p>/);
  once(pdf, 'couldn&#39;t be made');
  const pdfSw = renderPdfFailed('sw', 'TOKEN');
  assert.match(bodyOf(pdfSw), /<h1>PDF haipatikani<\/h1><p>Imeshindikana kutengeneza PDF\. Bado unaweza kuona ukurasa\.<\/p>/);
  const err = renderServerError('en');
  assert.match(bodyOf(err), /<h1>Something went wrong<\/h1><p>Try again later\.<\/p>/);
});
