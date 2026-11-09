// Vendor business tools · S8 — barcodes (design spec docs/design/vendor-barcodes-s8.md §14, approved 2026-11-09 with
// Q-1..Q-5 as recommended). Against the CI database: gating (three flags; tools.barcodes needs the ledger), the
// rules and shared vectors, saves (replace / add, inside the ledger transaction, a barcode_in_use race rolls the
// whole save back), uniqueness per vendor and tenancy, variants (rename, drop, variants[].barcodes refused),
// approval never re-queued, delete frees codes, the lookup (variant, whole product, archived, deleted, SKU fallback,
// barcode wins, no cost or images, rate limits, guard matrix, route order over HTTP) and codes kept off public views,
// search, moderation and documents.
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
import { shopService, moderationService } from '../src/bootstrap/services.mjs';
import { vendorToolsOptions } from '../src/shared/feature-flags.mjs';
import {
  vendorToolsOptionsRoute, vendorCreateProduct, vendorUpdateProduct, vendorDeleteProduct, vendorMyProducts, vendorProductLookup,
  listShopProducts, getShopProduct, getVendorStore, resetVendorBarcodeLimits, VENDOR_BARCODE_LIMITS,
} from '../functions/shop.mjs';
import { vendorRecordSale, resetVendorSalesLimits } from '../functions/vendor-sales.mjs';
import { vendorDocumentView } from '../functions/vendor-documents.mjs';
import { shopHome, resetShopHomeLimits } from '../functions/shop-home.mjs';
import { codeKey, checkGtin, validateBarcode, parseBarcodeFields, parseLookupCode, BARCODE_MESSAGES, withoutLookupCode } from '../src/shared/vendor-barcode.mjs';
import { createShopService } from '../src/services/shop-service.mjs';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';

const require = createRequire(import.meta.url);
const migration = require('../db/migrations/20270203090200-vendor-barcodes.cjs');
const VECTORS = require('./fixtures/barcode-vectors.json');

await ensureInit();

// Fail closed: these specs write; they must never run against anything but an isolated CI database.
{
  const dbName = (await db.raw('SELECT current_database() AS d')).rows[0].d;
  assert.equal(process.env.FITFLEX_USE_CI_DB, '1', 'specs run only with FITFLEX_USE_CI_DB=1');
  assert.match(dbName, /ci|test/i, `refusing to run against database ${dbName}`);
}

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [] };
const S8 = ['VENDOR_TOOLS', 'VENDOR_STOCK_LEDGER', 'VENDOR_BARCODES'];
const EXTRA = ['VENDOR_PURCHASES', 'VENDOR_WALKIN_SALES', 'VENDOR_DOCUMENTS', 'SHOP_HOME_V2'];
const on = (list = S8) => { for (const f of list) process.env[f] = '1'; };
afterEach(() => {
  for (const f of [...S8, ...EXTRA]) delete process.env[f];
  resetVendorBarcodeLimits(); resetVendorSalesLimits(); resetShopHomeLimits();
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
  await db('User').insert({ id, userType, displayName: `S8 ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
async function vendor(extra = {}) {
  const id = await user('vendor', { createdAt: new Date('2026-01-01T00:00:00Z'), displayName: 'Asha Owner', vendorProfile: JSON.stringify({ businessName: 'Scan Shop', status: 'published' }), ...extra });
  const caseId = uid('kyc');
  await db('PartnerKycCase').insert({ id: caseId, partnerType: 'vendor', userId: id, status: 'approved', tier: 3, updatedAt: new Date() });
  await db('PartnerSettlementAccount').insert({
    id: uid('psa'), caseId, method: 'bank', provider: 'CRDB', accountName: 'Scan Shop', accountNumber: '0150001234',
    status: 'verified', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z'), cooldownUntil: new Date('2026-09-03T00:00:00Z'), updatedAt: new Date(),
  });
  return id;
}
const as = id => ({ sub: id, userType: 'vendor' });
const staffOf = (id, vendorId) => ({ sub: id, userType: 'vendor_staff', vendorId });
const staff = (vendorId, permissions, extra = {}) => user('vendor_staff', { vendorId, vendorPermissions: permissions, accountStatus: 'active', vendorRole: 'inventory_manager', displayName: 'Juma Storekeeper', ...extra });
const admin = { sub: 'adm_s8', userType: 'admin' };

async function product(vendorId, body = {}, { approve = true } = {}) {
  const full = Object.fromEntries(Object.entries({ name: `Whey ${randomUUID().slice(0, 4)}`, category: 'supplements_nutrition', priceTzs: 45_000, stock: 3, ...body }).filter(([, x]) => x !== undefined));
  const out = await call(vendorCreateProduct, as(vendorId), { body: full });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  made.products.push(out.body.id);
  if (approve) await shopService.adminUpdateProductListing({ productId: out.body.id, body: { approvalStatus: 'approved' }, actorId: 'adm_s8' });
  return out.body;
}
const put = (claims, id, body) => call(vendorUpdateProduct, claims, { params: { id }, body });
const lookup = (claims, code) => call(vendorProductLookup, claims, { query: code === undefined ? {} : { code } });
const listOf = async claims => (await call(vendorMyProducts, claims)).body;
const mine = async (vendorId, productId) => (await listOf(as(vendorId))).find(p => p.id === productId);
const stored = productId => db('ProductCode').where({ productId }).orderBy([{ column: 'variant' }, { column: 'createdAt' }, { column: 'id' }]);
const audits = productId => db('AuditLog').where({ target: productId, action: 'product_barcodes_changed' }).orderBy('at');
const afterOf = row => (typeof row.after === 'string' ? JSON.parse(row.after) : row.after);
const errorOf = out => { const { message, ...rest } = out.body || {}; return { status: out.status, body: rest }; };

after(async () => {
  for (const s of servers) s.close();
  const vendors = made.users;
  const saleIds = (await db('VendorSale').whereIn('vendorId', vendors).select('id')).map(r => r.id);
  await db('AuditLog').whereIn('target', [...made.products, ...vendors, ...saleIds]).del();
  await db('ProductCode').whereIn('vendorId', vendors).del();
  await db('VendorSale').whereIn('vendorId', vendors).del();
  await db('VendorDocumentSequence').whereIn('vendorId', vendors).del();
  await db('ShopStockMovement').whereIn('productId', made.products).del();
  await db('MarketplaceNotification').whereIn('userId', vendors).del();
  await db('Notification').whereIn('userId', vendors).del().catch(() => {});
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
// What the in-process request logger (morgan in bfast-function) would write: req.originalUrl when the response finishes.
const logged = [];
app.use((req, res, next) => { res.on('finish', () => logged.push(req.originalUrl)); next(); });
mountGuards(Object.keys(functions).filter(k => functions[k].onGuard), functions, app);
mountHttpRoutes(Object.keys(functions).filter(k => functions[k].onRequest), functions, app);
const servers = [app.listen(0)];
const base = `http://127.0.0.1:${servers[0].address().port}`;
async function hit(method, url, claims) {
  const r = await fetch(`${base}${url}`, { method, headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {} });
  const text = await r.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: parsed };
}

// ── rules ────────────────────────────────────────────────────────────────────

test('rules: the shared vectors (codeKey, check digit, B-1 reasons), GTIN check, body parsing errors in order, lookup query parsing, EN + SW messages', () => {
  for (const v of VECTORS.vectors) {
    const out = validateBarcode(v.input);
    if (v.error) {
      assert.equal(out.error, v.error, JSON.stringify(v));
      if (v.reason) assert.equal(out.reason, v.reason, JSON.stringify(v));
      assert.ok(out.message?.en && out.message?.sw, 'every error has EN + SW');
    } else {
      assert.equal(out.codeKey, v.codeKey, JSON.stringify(v));
      assert.equal(codeKey(v.input), v.codeKey);
    }
  }
  assert.equal(checkGtin('6201234567893'), true);
  assert.equal(checkGtin('6201234567891'), false);
  assert.equal(checkGtin('036000291452'), true);

  assert.equal(parseBarcodeFields({ name: 'x' }), null, 'no codes in the body');
  const err = body => { const { message, status, ...rest } = parseBarcodeFields(body); return rest; };
  assert.deepEqual(err({ barcodes: [], addBarcodes: [] }), { error: 'barcodes_conflict' });
  assert.deepEqual(err({ barcodes: 'x' }), { error: 'invalid_field', field: 'barcodes' });
  assert.deepEqual(err({ addBarcodes: [{ code: 1 }] }), { error: 'invalid_field', field: 'addBarcodes' });
  assert.deepEqual(err({ barcodes: [{ code: '12345', variant: 7 }] }), { error: 'invalid_field', field: 'barcodes' });
  assert.deepEqual(err({ barcodes: [{ code: '12345', variant: 'x'.repeat(61) }] }), { error: 'invalid_field', field: 'barcodes' });
  assert.deepEqual(err({ barcodes: Array.from({ length: 21 }, (_, i) => ({ code: `CODE-${i}` })) }), { error: 'too_many_barcodes', max: 20 });
  // The first failing code is reported.
  assert.deepEqual(err({ barcodes: [{ code: '6201234567893' }, { code: 'AB 12' }, { code: '123' }] }), { error: 'invalid_barcode', code: 'AB 12', reason: 'bad_characters' });
  assert.deepEqual(err({ barcodes: [{ code: '036000291452' }, { code: '0036000291452' }] }), { error: 'duplicate_barcode', code: '0036000291452' });
  assert.deepEqual(err({ barcodes: [{ code: 'abc-123' }, { code: 'ABC-123' }] }), { error: 'duplicate_barcode', code: 'ABC-123' });
  assert.deepEqual(parseBarcodeFields({ addBarcodes: [{ code: ' 12345670 ', variant: ' M ' }, { code: 'x-99', variant: null }] }),
    { mode: 'add', items: [{ code: '12345670', codeKey: '12345670', variant: 'M' }, { code: 'x-99', codeKey: 'X-99', variant: '' }] });

  const q = raw => { const { message, status, ...rest } = parseLookupCode(raw); return rest; };
  assert.deepEqual(q(undefined), { error: 'code_required' });
  assert.deepEqual(q('   '), { error: 'code_required' });
  assert.deepEqual(q(['a', 'b']), { error: 'code_required' });
  assert.deepEqual(q('x'.repeat(101)), { error: 'invalid_code', reason: 'too_long' });
  assert.deepEqual(q('AB 12'), { error: 'invalid_code', reason: 'bad_characters' });
  assert.deepEqual(q(' bnd '), { code: 'bnd', codeKey: 'BND', barcode: false }, 'short SKUs can be looked up');
  assert.deepEqual(q('6201234567891'), { code: '6201234567891', codeKey: '6201234567891', barcode: false }, 'a bad check digit can still match a SKU');
  for (const [key, m] of Object.entries(BARCODE_MESSAGES)) assert.ok(m.en && m.sw, key);
});

// ── migration ────────────────────────────────────────────────────────────────

test('migration: ProductCode exists with its unique (vendorId, codeKey) index; down refuses while a code exists and works once none do', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { barcodes: [{ code: 'MIG-0001' }] });
  const indexes = (await db.raw(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'ProductCode'`)).rows.map(r => r.indexname);
  assert.ok(indexes.includes('productcode_vendor_codekey_unique') && indexes.includes('productcode_vendor_product_idx'));
  await assert.rejects(migration.down(db), /product code\(s\) exist/);
  assert.ok((await db.raw(`SELECT to_regclass('"ProductCode"') AS t`)).rows[0].t, 'nothing dropped');
  const ROLLBACK = new Error('rollback');
  await assert.rejects(db.transaction(async (trx) => {
    await trx.raw('DELETE FROM "ProductCode"');
    await migration.down(trx);
    assert.equal((await trx.raw(`SELECT to_regclass('"ProductCode"') AS t`)).rows[0].t, null);
    await migration.up(trx);
    throw ROLLBACK;
  }), err => err === ROLLBACK);
  assert.equal((await stored(p.id)).length, 1, 'rolled back');
  // The database refuses a code outside 4–48 characters even if the service let one through.
  await assert.rejects(db('ProductCode').insert({ id: uid('pcd'), vendorId: v, productId: p.id, variant: '', code: 'abc', codeKey: 'ABC', createdBy: v }), /productcode_code_length/);
});

// ── gating ───────────────────────────────────────────────────────────────────

test('gating: tools.barcodes needs all three flags (changed meaning: the ledger too); lookup 404 with any off; list has no barcodes key; a save with codes while off is ignored and keeps the stored codes (AC-1, AC-2)', async () => {
  const v = await vendor();
  for (const missing of S8) {
    on(S8.filter(f => f !== missing));
    assert.equal(vendorToolsOptions().barcodes, false, `${missing} off`);
    assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.barcodes, false);
    assert.deepEqual((await lookup(as(v), '6201234567893')), { status: 404, body: { error: 'feature_disabled' } });
    for (const f of S8) delete process.env[f];
  }
  on();
  assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.barcodes, true);
  const p = await product(v, { barcodes: [{ code: '6201234567893' }] });
  assert.deepEqual(p.barcodes, [{ code: '6201234567893', variant: null }]);

  for (const f of ['VENDOR_BARCODES', 'VENDOR_STOCK_LEDGER']) {
    delete process.env[f];
    const listed = await mine(v, p.id);
    assert.equal('barcodes' in listed, false, `no barcodes key with ${f} off`);
    // The rest of the save works; the codes in it are ignored and the stored ones are untouched.
    const saved = await put(as(v), p.id, { name: `Renamed ${f}`, barcodes: [], addBarcodes: undefined });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.name, `Renamed ${f}`);
    assert.equal('barcodes' in saved.body, false);
    assert.equal((await put(as(v), p.id, { barcodes: 'not even a list' })).status, 200, 'not parsed while off');
    const created = await call(vendorCreateProduct, as(v), { body: { name: 'Off create', category: 'supplements_nutrition', priceTzs: 1000, barcodes: [{ code: 'OFF-0001' }] } });
    assert.equal(created.status, 201);
    made.products.push(created.body.id);
    assert.equal((await stored(created.body.id)).length, 0, 'nothing written while off');
    process.env[f] = '1';
  }
  // Flag back on: the codes are there, unchanged (AC-2).
  assert.deepEqual((await mine(v, p.id)).barcodes, [{ code: '6201234567893', variant: null }]);
});

// ── saves ────────────────────────────────────────────────────────────────────

test('saves: create with codes, replace-set, addBarcodes (no-op, never removes), [] clears; approved product stays approved and listed; audit rows form / add_from_scan; response and list carry barcodes (AC-6)', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { barcodes: [{ code: '6201234567893' }, { code: 'abc-123' }] });
  assert.equal((await db('Product').where({ id: p.id }).first()).approvalStatus, 'approved');
  assert.deepEqual((await stored(p.id)).map(r => [r.code, r.codeKey, r.variant, r.createdBy]), [['6201234567893', '6201234567893', '', v], ['abc-123', 'ABC-123', '', v]]);
  assert.match((await stored(p.id))[0].id, /^pcd_[0-9a-f]{16}$/);

  // Replace-set: one kept, one removed, one added. Approval and listing untouched (codes are not review fields).
  const replaced = await put(as(v), p.id, { barcodes: [{ code: 'ABC-123' }, { code: '12345670' }] });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.deepEqual(replaced.body.barcodes, [{ code: 'abc-123', variant: null }, { code: '12345670', variant: null }], 'kept code keeps its stored text');
  const row = await db('Product').where({ id: p.id }).first();
  assert.equal(row.approvalStatus, 'approved');
  assert.ok((await shopService.listProducts({ vendorId: v })).some(x => x.id === p.id), 'still listed');
  assert.equal('barcodes' in row, false, 'never a Product column');

  // addBarcodes: a no-op for a code already there; adds; never removes.
  const added = await put(as(v), p.id, { addBarcodes: [{ code: 'abc-123' }, { code: 'NEW-0001' }] });
  assert.deepEqual(added.body.barcodes.map(c => c.code), ['abc-123', '12345670', 'NEW-0001']);
  const noop = await put(as(v), p.id, { addBarcodes: [{ code: 'ABC-123' }] });
  assert.equal(noop.status, 200);
  assert.equal((await stored(p.id)).length, 3);

  const log = (await audits(p.id)).map(afterOf);
  assert.deepEqual(log.map(a => a.reason), ['form', 'form', 'add_from_scan'], 'one row per change; the no-op writes none');
  assert.deepEqual(log[1], { productId: p.id, vendorId: v, reason: 'form', added: [{ code: '12345670', variant: null }], removed: [{ code: '6201234567893', variant: null }] });

  // [] clears.
  assert.deepEqual((await put(as(v), p.id, { barcodes: [] })).body.barcodes, []);
  assert.equal((await stored(p.id)).length, 0);
  assert.equal((await db('Product').where({ id: p.id }).first()).approvalStatus, 'approved');
});

test('saves: every error code over the route, nothing written on any of them; staff rights; admins ignored (AC-3, AC-7)', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { variants: [{ name: 'S', stock: 1 }, { name: 'M', stock: 2 }], stock: undefined });
  const e = async body => errorOf(await put(as(v), p.id, body));
  assert.deepEqual(await e({ barcodes: [{ code: '123' }] }), { status: 400, body: { error: 'invalid_barcode', code: '123', reason: 'too_short' } });
  assert.deepEqual(await e({ barcodes: [{ code: `A${'1'.repeat(48)}` }] }), { status: 400, body: { error: 'invalid_barcode', code: `A${'1'.repeat(48)}`, reason: 'too_long' } });
  assert.deepEqual(await e({ barcodes: [{ code: 'AB 12' }] }), { status: 400, body: { error: 'invalid_barcode', code: 'AB 12', reason: 'bad_characters' } });
  assert.deepEqual(await e({ barcodes: [{ code: '6201234567891' }] }), { status: 400, body: { error: 'invalid_check_digit', code: '6201234567891' } });
  assert.deepEqual(await e({ barcodes: [{ code: 'X-1234' }, { code: 'x-1234' }] }), { status: 400, body: { error: 'duplicate_barcode', code: 'x-1234' } });
  assert.deepEqual(await e({ barcodes: Array.from({ length: 21 }, (_, i) => ({ code: `C-${1000 + i}` })) }), { status: 400, body: { error: 'too_many_barcodes', max: 20 } });
  assert.deepEqual(await e({ barcodes: [{ code: 'X-1234', variant: 'XL' }] }), { status: 400, body: { error: 'barcode_variant_not_found', code: 'X-1234', variant: 'XL' } });
  assert.deepEqual(await e({ barcodes: [], addBarcodes: [] }), { status: 400, body: { error: 'barcodes_conflict' } });
  assert.deepEqual(await e({ addBarcodes: { code: 'X-1234' } }), { status: 400, body: { error: 'invalid_field', field: 'addBarcodes' } });
  // variants[].barcodes is refused (it would be stored on the public row), whatever the flags.
  assert.deepEqual(await e({ variants: [{ name: 'S', barcodes: ['X-1234'] }, { name: 'M' }] }), { status: 400, body: { error: 'invalid_field', field: 'variants' } });
  delete process.env.VENDOR_BARCODES;
  assert.deepEqual(await e({ variants: [{ name: 'S', barcodes: ['X-1234'] }, { name: 'M' }] }), { status: 400, body: { error: 'invalid_field', field: 'variants' } });
  on();
  // 8 digits are accepted (not checked: UPC-E). The 20 cap counts the stored codes too (addBarcodes).
  assert.equal((await put(as(v), p.id, { addBarcodes: [{ code: '12345670' }] })).status, 200);
  const nineteen = Array.from({ length: 19 }, (_, i) => ({ code: `C-${2000 + i}` }));
  assert.equal((await put(as(v), p.id, { addBarcodes: nineteen })).status, 200);
  assert.deepEqual(await e({ addBarcodes: [{ code: 'ONE-MORE' }] }), { status: 400, body: { error: 'too_many_barcodes', max: 20 } });
  // The message comes in English and Swahili.
  assert.deepEqual((await put(as(v), p.id, { barcodes: [{ code: '6201234567891' }] })).body.message,
    { en: 'This number doesn\'t look right. Check the last digit.', sw: 'Namba hii haionekani sahihi. Hakiki tarakimu ya mwisho.' });
  assert.equal((await stored(p.id)).length, 20, 'the refused saves wrote nothing');
  // A code already on this product for another variant: adding never moves it.
  assert.deepEqual(await e({ addBarcodes: [{ code: '12345670', variant: 'S' }] }), { status: 409, body: { error: 'barcode_in_use', code: '12345670', productId: p.id, name: p.name, variant: null } });

  // Rights: `sales`-only staff cannot add codes (the products guard); `products` staff can.
  const sales = await staff(v, ['sales']);
  assert.equal((await put(staffOf(sales, v), p.id, { addBarcodes: [{ code: 'SALE-0001' }] })).status, 403);
  const keeper = await staff(v, ['products']);
  const q = await product(v);
  assert.deepEqual((await put(staffOf(keeper, v), q.id, { addBarcodes: [{ code: 'STAFF-0001' }] })).body.barcodes, [{ code: 'STAFF-0001', variant: null }]);
  assert.equal((await stored(q.id))[0].createdBy, keeper);
  // FitFlex admins: codes in an admin product create are ignored in v1.
  const created = await shopService.adminCreateProduct({ body: { vendorId: v, name: 'Admin made', category: 'supplements_nutrition', priceTzs: 1000, barcodes: [{ code: 'ADMIN-0001' }] }, actorId: 'adm_s8' });
  assert.equal(created.status, 201);
  made.products.push(created.product.id);
  assert.equal((await stored(created.product.id)).length, 0);
});

test('uniqueness and tenancy: a code on another live product → 409 naming it and NOTHING of the save applied (AC-9); the same code at two vendors is fine; UPC-A / EAN-13 / GTIN-14 and letter case are one code (AC-8)', async () => {
  on();
  const a = await vendor();
  const b = await vendor();
  const whey = await product(a, { name: 'Whey Protein 1kg', barcodes: [{ code: '6201234567893' }] });
  const gloves = await product(a, { name: 'Gym Gloves', variants: [{ name: 'S', stock: 3 }, { name: 'M', stock: 4 }], stock: undefined });
  const before = await db('Product').where({ id: gloves.id }).first();
  const movesBefore = (await db('ShopStockMovement').where({ productId: gloves.id })).length;
  const clash = await put(as(a), gloves.id, { name: 'Gloves renamed', variants: [{ name: 'S', stock: 9 }, { name: 'M', stock: 4 }], barcodes: [{ code: '6201234567893', variant: 'M' }] });
  assert.deepEqual(errorOf(clash), { status: 409, body: { error: 'barcode_in_use', code: '6201234567893', productId: whey.id, name: 'Whey Protein 1kg', variant: null } });
  assert.deepEqual(clash.body.message, { en: 'Already on Whey Protein 1kg.', sw: 'Tayari upo kwenye Whey Protein 1kg.' });
  const afterRow = await db('Product').where({ id: gloves.id }).first();
  assert.equal(afterRow.name, before.name, 'the name change is not stored');
  assert.deepEqual(afterRow.variants, before.variants, 'nor the stock change');
  assert.equal((await db('ShopStockMovement').where({ productId: gloves.id })).length, movesBefore, 'no ledger row');
  assert.equal((await stored(gloves.id)).length, 0);

  // Vendor B may hold the same code; vendor A's product is unaffected (AC-5).
  const bp = await product(b, { barcodes: [{ code: '6201234567893' }] });
  assert.equal((await stored(bp.id)).length, 1);
  assert.deepEqual((await mine(a, whey.id)).barcodes, [{ code: '6201234567893', variant: null }]);

  // UPC-A on Gloves M is found as its EAN-13 and GTIN-14, and the other way round.
  assert.equal((await put(as(a), gloves.id, { barcodes: [{ code: '036000291452', variant: 'M' }, { code: 'abc-123', variant: 'S' }] })).status, 200);
  for (const code of ['036000291452', '0036000291452', '00036000291452']) {
    const out = await lookup(as(a), code);
    assert.deepEqual(out.body.matches.map(m => [m.productId, m.variant, m.matchedBy]), [[gloves.id, 'M', 'barcode']], code);
    assert.equal(out.body.codeKey, '0036000291452');
  }
  assert.deepEqual((await lookup(as(a), 'ABC-123')).body.matches.map(m => m.variant), ['S']);
  assert.deepEqual(errorOf(await put(as(a), whey.id, { addBarcodes: [{ code: '0036000291452' }] })).body,
    { error: 'barcode_in_use', code: '0036000291452', productId: gloves.id, name: 'Gym Gloves', variant: 'M' });
});

test('concurrency: two saves adding the same code at once — one wins, the loser\'s fields, stock rows and codes all roll back (§2.5)', async () => {
  on();
  const v = await vendor();
  const one = await product(v, { name: 'Race One', stock: 5 });
  const two = await product(v, { name: 'Race Two', stock: 5 });
  const [r1, r2] = await Promise.all([
    put(as(v), one.id, { name: 'Race One won', stock: 7, addBarcodes: [{ code: 'RACE-0001' }] }),
    put(as(v), two.id, { name: 'Race Two won', stock: 8, addBarcodes: [{ code: 'RACE-0001' }] }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify([r1.body, r2.body]));
  const [winner, loser, loserOut] = r1.status === 200 ? [one, two, r2] : [two, one, r1];
  assert.equal(loserOut.body.error, 'barcode_in_use');
  assert.equal(loserOut.body.productId, winner.id);
  const loserRow = await db('Product').where({ id: loser.id }).first();
  assert.equal(loserRow.name, loser.name);
  assert.equal(Number(loserRow.stock), 5);
  assert.equal((await db('ShopStockMovement').where({ productId: loser.id, note: 'product_form' })).length, 0);
  assert.equal((await stored(loser.id)).length, 0);
  assert.deepEqual((await stored(winner.id)).map(r => r.code), ['RACE-0001']);
  assert.equal((await db('ProductCode').where({ vendorId: v, codeKey: 'RACE-0001' })).length, 1);
});

test('variants: codes follow a rename sent in the same body; a dropped variant\'s codes go with it (old build body without barcodes) with a variant_removed audit row (AC-10)', async () => {
  on();
  const v = await vendor();
  // The ledger refuses to drop a variant that still has stock (S1 Q-2), so the renamed one is empty here.
  const p = await product(v, { name: 'Gym Gloves', variants: [{ name: 'S', stock: 2 }, { name: 'M', stock: 0 }, { name: 'L', stock: 0 }], stock: undefined, barcodes: [{ code: 'GLOVE-S', variant: 'S' }, { code: 'GLOVE-M', variant: 'M' }, { code: 'GLOVE-L', variant: 'L' }, { code: 'GLOVE-ALL' }] });
  assert.deepEqual(p.barcodes, [{ code: 'GLOVE-ALL', variant: null }, { code: 'GLOVE-L', variant: 'L' }, { code: 'GLOVE-M', variant: 'M' }, { code: 'GLOVE-S', variant: 'S' }], 'whole product first, then by variant');
  // Rename M → Medium (merged by name = remove M + add Medium; M's stock moves with the body).
  const renamed = await put(as(v), p.id, {
    variants: [{ name: 'S', stock: 2 }, { name: 'Medium', stock: 0 }, { name: 'L', stock: 0 }],
    barcodes: [{ code: 'GLOVE-S', variant: 'S' }, { code: 'GLOVE-M', variant: 'Medium' }, { code: 'GLOVE-L', variant: 'L' }, { code: 'GLOVE-ALL' }],
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.deepEqual(renamed.body.barcodes.find(c => c.code === 'GLOVE-M'), { code: 'GLOVE-M', variant: 'Medium' });
  // An old app build drops L without sending barcodes: L's codes are deleted in the same save.
  const dropped = await put(as(v), p.id, { variants: [{ name: 'S', stock: 2 }, { name: 'Medium', stock: 0 }] });
  assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
  assert.deepEqual((await stored(p.id)).map(r => r.code).sort(), ['GLOVE-ALL', 'GLOVE-M', 'GLOVE-S']);
  const last = afterOf((await audits(p.id)).at(-1));
  assert.deepEqual(last, { productId: p.id, vendorId: v, reason: 'variant_removed', added: [], removed: [{ code: 'GLOVE-L', variant: 'L' }] });
  // A code that names a variant the product lost while the flag was off is never returned and never blocks.
  await db('ProductCode').insert({ id: uid('pcd'), vendorId: v, productId: p.id, variant: 'Ghost', code: 'GHOST-01', codeKey: 'GHOST-01', createdBy: v });
  assert.equal((await mine(v, p.id)).barcodes.some(c => c.code === 'GHOST-01'), false);
  assert.deepEqual((await lookup(as(v), 'GHOST-01')).body.matches, []);
  const other = await product(v, { barcodes: [{ code: 'GHOST-01' }] });
  assert.deepEqual(other.barcodes, [{ code: 'GHOST-01', variant: null }]);
});

test('delete: codes deleted with a product_deleted audit row, and the code is free at once; a code a deleted product still holds (failed cleanup) is free too and never looked up (AC-11, B-7)', async () => {
  on();
  const v = await vendor();
  const old = await product(v, { barcodes: [{ code: 'DEL-0001' }] });
  assert.deepEqual((await call(vendorDeleteProduct, as(v), { params: { id: old.id } })).body, { deleted: true });
  assert.equal((await stored(old.id)).length, 0);
  assert.equal(afterOf((await audits(old.id)).at(-1)).reason, 'product_deleted');
  assert.deepEqual((await lookup(as(v), 'DEL-0001')).body.matches, []);
  assert.deepEqual((await product(v, { barcodes: [{ code: 'DEL-0001' }] })).barcodes, [{ code: 'DEL-0001', variant: null }]);

  const ghost = await product(v);
  await db('Product').where({ id: ghost.id }).update({ deletedAt: new Date(), status: 'archived' });
  await db('ProductCode').insert({ id: uid('pcd'), vendorId: v, productId: ghost.id, variant: '', code: 'DEL-0002', codeKey: 'DEL-0002', createdBy: v });
  assert.deepEqual((await lookup(as(v), 'DEL-0002')).body.matches, [], 'a deleted product is never returned');
  const taker = await product(v);
  assert.equal((await put(as(v), taker.id, { addBarcodes: [{ code: 'DEL-0002' }] })).status, 200);
  assert.deepEqual((await stored(ghost.id)), []);
  assert.deepEqual((await stored(taker.id)).map(r => r.code), ['DEL-0002']);
});

// ── lookup ───────────────────────────────────────────────────────────────────

test('lookup: variant code (own stock), whole-product code with variants, archived included, SKU fallback (one, several, barcode wins), never cost / images / reorder level, query errors (AC-13, AC-14)', async () => {
  on();
  const v = await vendor();
  const whey = await product(v, { name: 'Whey Protein 1kg', sku: 'WP-1KG', priceTzs: 85_000, stock: 10, costTzs: 60_000, reorderLevel: 2, images: [], barcodes: [{ code: '6201234567893' }] });
  const gloves = await product(v, { name: 'Gym Gloves', priceTzs: 20_000, discountPriceTzs: 18_000, variants: [{ name: 'S', stock: 3 }, { name: 'M', stock: 4 }, { name: 'L', stock: 0 }], stock: undefined, barcodes: [{ code: 'GLV-ALL' }, { code: 'GLV-M', variant: 'M' }] });
  const shaker = await product(v, { name: 'Shaker', sku: ' 6201234567886 ' });
  const bandA = await product(v, { name: 'Band A', sku: 'BAND' });
  const bandB = await product(v, { name: 'Band B', sku: 'band' });
  const archived = await product(v, { name: 'Old Mat', barcodes: [{ code: 'MAT-0001' }] });
  assert.equal((await put(as(v), archived.id, { status: 'archived' })).status, 200);
  const pending = await product(v, { name: 'Pending thing', barcodes: [{ code: 'PEND-001' }] }, { approve: false });

  const m = await lookup(as(v), 'GLV-M');
  assert.equal(m.status, 200);
  assert.deepEqual(m.body, { code: 'GLV-M', codeKey: 'GLV-M', matches: [{ productId: gloves.id, name: 'Gym Gloves', variant: 'M', variants: null, priceTzs: 20_000, discountPriceTzs: 18_000, stock: 4, status: 'active', approvalStatus: 'approved', sku: null, matchedBy: 'barcode' }] });
  const all = (await lookup(as(v), 'glv-all')).body;
  assert.deepEqual([all.code, all.codeKey], ['glv-all', 'GLV-ALL']);
  assert.deepEqual(all.matches[0].variants, [{ name: 'S', stock: 3 }, { name: 'M', stock: 4 }, { name: 'L', stock: 0 }]);
  assert.equal(all.matches[0].variant, null);
  assert.equal(all.matches[0].stock, 7);
  const w = (await lookup(as(v), '6201234567893')).body.matches[0];
  assert.deepEqual([w.productId, w.stock, w.sku, w.variants], [whey.id, 10, 'WP-1KG', null]);
  for (const key of ['costTzs', 'effectiveCostTzs', 'reorderLevel', 'images', 'barcodes', 'vendorId', 'deletedAt', 'description']) assert.equal(key in w, false, key);
  assert.equal((await lookup(as(v), 'MAT-0001')).body.matches[0].status, 'archived');
  assert.equal((await lookup(as(v), 'PEND-001')).body.matches[0].approvalStatus, 'pending');

  // SKU fallback (Q-1): exact, trimmed, case-insensitive; several by name; a code failing the check digit can still match a SKU.
  assert.deepEqual((await lookup(as(v), '6201234567886')).body.matches.map(x => [x.productId, x.matchedBy, x.variant]), [[shaker.id, 'sku', null]]);
  assert.deepEqual((await lookup(as(v), 'band')).body.matches.map(x => x.productId), [bandA.id, bandB.id]);
  assert.deepEqual((await lookup(as(v), 'WP-1K')).body.matches, [], 'exact only');
  // Barcode wins: once Shaker's EAN is a barcode on Whey, only Whey is returned.
  assert.equal((await put(as(v), whey.id, { addBarcodes: [{ code: '6201234567886' }] })).status, 200);
  assert.deepEqual((await lookup(as(v), '6201234567886')).body.matches.map(x => [x.productId, x.matchedBy]), [[whey.id, 'barcode']]);

  assert.deepEqual(errorOf(await lookup(as(v))), { status: 400, body: { error: 'code_required' } });
  assert.deepEqual(errorOf(await lookup(as(v), 'x'.repeat(101))), { status: 400, body: { error: 'invalid_code', reason: 'too_long' } });
  assert.deepEqual(errorOf(await lookup(as(v), 'AB 12')), { status: 400, body: { error: 'invalid_code', reason: 'bad_characters' } });
  assert.deepEqual((await lookup(as(v), 'NOPE-404')).body, { code: 'NOPE-404', codeKey: 'NOPE-404', matches: [] });
  void pending;
});

test('lookup tenancy and guards: another vendor\'s code gives the same body as no code at all (AC-5); products / sales staff; purchases-only while S9 on; suspended vendor; inactive staff; admin 403 (AC-4)', async () => {
  on();
  const a = await vendor();
  const b = await vendor();
  await product(b, { barcodes: [{ code: '5012345678900' }], sku: 'B-ONLY' });
  const elsewhere = await lookup(as(a), '5012345678900');
  const nowhere = await lookup(as(a), '4006381333931');
  assert.deepEqual(elsewhere.body, { code: '5012345678900', codeKey: '5012345678900', matches: [] });
  assert.deepEqual(Object.keys(elsewhere.body), Object.keys(nowhere.body));
  assert.deepEqual((await lookup(as(a), 'B-ONLY')).body.matches, [], 'nor another vendor\'s SKU');
  // Vendor A may save B's code on its own product.
  assert.equal((await product(a, { barcodes: [{ code: '5012345678900' }] })).barcodes.length, 1);

  const sales = await staff(a, ['sales']);
  const keeper = await staff(a, ['products']);
  const buyer = await staff(a, ['purchases']);
  const orders = await staff(a, ['orders']);
  assert.equal((await lookup(staffOf(sales, a), '5012345678900')).body.matches.length, 1);
  assert.equal((await lookup(staffOf(keeper, a), '5012345678900')).status, 200);
  assert.equal((await lookup(staffOf(orders, a), '5012345678900')).status, 403);
  assert.equal((await lookup(staffOf(buyer, a), '5012345678900')).status, 403, 'purchases counts only while S9 is on');
  process.env.VENDOR_PURCHASES = '1';
  assert.equal((await lookup(staffOf(buyer, a), '5012345678900')).status, 200);
  const suspended = await vendor({ accountStatus: 'suspended' });
  const paused = await staff(suspended, ['purchases']);
  assert.deepEqual(await lookup(staffOf(paused, suspended), '5012345678900'), { status: 403, body: { error: 'vendor_suspended' } });
  const gone = await staff(a, ['products'], { accountStatus: 'disabled' });
  assert.equal((await lookup(staffOf(gone, a), '5012345678900')).status, 403);
  assert.equal((await lookup(admin, '5012345678900')).status, 403, 'FitFlex admins have no vendor context');
  // Staff of vendor A with a token naming vendor B are refused (stored staff record).
  assert.equal((await lookup(staffOf(keeper, b), '5012345678900')).status, 403);
});

test('lookup rate limits: 120 per person and 600 per vendor per minute → 429 rate_limited { retryAfterSeconds } + Retry-After (AC-15)', async () => {
  on();
  const v = await vendor();
  assert.deepEqual(VENDOR_BARCODE_LIMITS, { lookupsPerPersonPerMinute: 120, lookupsPerVendorPerMinute: 600 });
  for (let i = 0; i < 120; i += 1) assert.equal((await lookup(as(v), 'RL-0001')).status, 200);
  const limited = await lookup(as(v), 'RL-0001');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(limited.body.retryAfterSeconds >= 1 && limited.body.retryAfterSeconds <= 60);
  assert.equal(limited.headers['Retry-After'], String(limited.body.retryAfterSeconds));
  // Per vendor: four more people reach 600 in all, the sixth person is refused on their first call.
  const people = [];
  for (let i = 0; i < 5; i += 1) people.push(await staff(v, ['sales']));
  for (const s of people.slice(0, 4)) for (let i = 0; i < 120; i += 1) await lookup(staffOf(s, v), 'RL-0001');
  const sixth = await lookup(staffOf(people[4], v), 'RL-0001');
  assert.equal(sixth.status, 429, 'vendor limit');
  // Another vendor is not affected.
  const other = await vendor();
  assert.equal((await lookup(as(other), 'RL-0001')).status, 200);
});

test('route order over HTTP (mounted as bfast-function mounts it): GET /vendor/products/lookup reaches the lookup, GET /vendor/products and PUT /vendor/products/:id still work', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { barcodes: [{ code: 'HTTP-0001' }] });
  const out = await hit('GET', '/vendor/products/lookup?code=http-0001', as(v));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(out.body.matches.map(m => m.productId), [p.id]);
  const list = await hit('GET', '/vendor/products', as(v));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.find(x => x.id === p.id).barcodes, [{ code: 'HTTP-0001', variant: null }]);
  assert.equal((await hit('GET', '/vendor/products/lookup?code=x', admin)).status, 403);
  assert.equal((await hit('GET', '/vendor/products/lookup')).status, 401);
  delete process.env.VENDOR_BARCODES;
  assert.deepEqual(await hit('GET', '/vendor/products/lookup?code=HTTP-0001', as(v)), { status: 404, body: { error: 'feature_disabled' } });
});

// ── privacy ──────────────────────────────────────────────────────────────────

test('privacy: codes never on /shop/products, /shop/products/:id, /shop/vendors/:id, the shop home, public search, the moderation queue or a sale receipt (B-8)', async () => {
  on([...S8, 'VENDOR_WALKIN_SALES', 'VENDOR_DOCUMENTS', 'SHOP_HOME_V2']);
  const v = await vendor();
  const CODE = 'PRIV8-7731-ZQ';
  const p = await product(v, { name: 'Private Code Whey', sku: 'PRIV-SKU', stock: 9, barcodes: [{ code: CODE }, { code: '6291041500213' }] });
  assert.equal((await stored(p.id)).length, 2);
  const member = await user('member');
  const claims = { sub: member, userType: 'member' };
  const leaks = body => ['PRIV8-7731-ZQ', '6291041500213', 'barcodes', 'codeKey'].filter(s => JSON.stringify(body ?? null).includes(s));

  const listed = await call(listShopProducts, claims, { query: { vendorId: v } });
  assert.ok(listed.body.some(x => x.id === p.id), 'the product is public');
  assert.deepEqual(leaks(listed.body), []);
  assert.deepEqual((await call(listShopProducts, claims, { query: { search: CODE } })).body.filter(x => x.id === p.id), [], 'search never matches a code');
  assert.deepEqual((await call(listShopProducts, claims, { query: { search: '6291041500213' } })).body.filter(x => x.id === p.id), []);
  const one = await call(getShopProduct, claims, { params: { id: p.id } });
  assert.equal(one.status, 200);
  assert.deepEqual(leaks(one.body), []);
  assert.deepEqual(leaks((await call(getVendorStore, claims, { params: { id: v } })).body), []);
  const home = await call(shopHome, claims);
  assert.equal(home.status, 200, JSON.stringify(home.body));
  assert.deepEqual(leaks(home.body), []);
  assert.deepEqual(leaks(await moderationService.list({ entityType: 'product', q: 'Private Code Whey' })), []);
  assert.deepEqual(leaks((await shopService.adminListProducts()).find(x => x.id === p.id)), [], 'nor the admin product list');

  const sale = await call(vendorRecordSale, as(v), { body: { clientRef: randomUUID(), lines: [{ productId: p.id, qty: 1 }], payments: [{ method: 'cash', amountTzs: 45_000 }] } });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  assert.deepEqual(leaks(sale.body), []);
  for (const format of ['json', 'html']) {
    const doc = await call(vendorDocumentView, as(v), { params: { docType: 'sale', docId: sale.body.sale.id }, query: { format } });
    assert.equal(doc.status, 200, JSON.stringify(doc.body).slice(0, 300));
    assert.deepEqual(leaks(doc.body), [], format);
  }
});

test('structure: ProductCode is read and written only by the barcode store (and its migration); no public, search, moderation, settlement or document module touches it', () => {
  const allowed = new Set(['src/infra/product-code-store-pg.mjs', 'db/migrations/20270203090200-vendor-barcodes.cjs']);
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(mjs|cjs|js)$/.test(entry.name) && /["'`]ProductCode["'`]|"ProductCode"/.test(fs.readFileSync(path.join(root, rel), 'utf8'))) hits.push(rel);
    }
  };
  for (const dir of ['src', 'functions', 'db/migrations', 'scripts']) walk(dir);
  assert.deepEqual(hits.filter(f => !allowed.has(f)), []);
  // The store is wired into the shop service only.
  const importers = [];
  for (const dir of ['src', 'functions']) {
    const scan = (d) => {
      for (const entry of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
        const rel = path.join(d, entry.name);
        if (entry.isDirectory()) scan(rel);
        else if (entry.name.endsWith('.mjs') && /from ['"][^'"]*product-code-store-pg\.mjs['"]/.test(fs.readFileSync(path.join(root, rel), 'utf8'))) importers.push(rel);
      }
    };
    scan(dir);
  }
  assert.deepEqual(importers, ['src/bootstrap/services.mjs']);
});

// ── security review #334 ─────────────────────────────────────────────────────

test('M-1: the scanned code never reaches the request log URL (req.originalUrl), on 200 and on 401 / 403 / 404 / 429; req.query keeps it', async () => {
  assert.equal(withoutLookupCode('/vendor/products/lookup?code=6201234567893'), '/vendor/products/lookup');
  assert.equal(withoutLookupCode('/vendor/products/lookup?x=1&code=ABC&CODE=d&%63ode=e&code[]=f&y=2'), '/vendor/products/lookup?x=1&y=2');
  assert.equal(withoutLookupCode('/vendor/products/lookup?codes=1'), '/vendor/products/lookup?codes=1', 'only the code parameter');
  assert.equal(withoutLookupCode('/vendor/products/lookup'), '/vendor/products/lookup');
  // The route's own guards: the first one redacts, before auth runs; req.query is untouched.
  const req = { method: 'GET', originalUrl: '/vendor/products/lookup?code=SECRET-0001', query: { code: 'SECRET-0001' }, headers: {}, get: () => null };
  const out = res();
  for (const guard of [vendorProductLookup.onGuard].flat()) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) break;
  }
  assert.equal(out.statusCode, 401, 'stopped by auth');
  assert.equal(req.originalUrl, '/vendor/products/lookup');
  assert.equal(req.query.code, 'SECRET-0001');

  on();
  const v = await vendor();
  await product(v, { barcodes: [{ code: 'LOGGED-0001' }] });
  logged.length = 0;
  assert.equal((await hit('GET', '/vendor/products/lookup?code=LOGGED-0001', as(v))).body.matches.length, 1, 'the handler still read the code');
  await hit('GET', '/vendor/products/lookup?code=LOGGED-0001');
  await hit('GET', '/vendor/products/lookup?code=LOGGED-0001', admin);
  for (let i = 0; i < 121; i += 1) await hit('GET', `/vendor/products/lookup?code=LOGGED-0001&n=${i}`, as(v));
  delete process.env.VENDOR_BARCODES;
  await hit('GET', '/vendor/products/lookup?code=LOGGED-0001', as(v));
  const mine = logged.filter(u => u.startsWith('/vendor/products/lookup'));
  assert.equal(mine.length, 125);
  assert.deepEqual(mine.filter(u => /LOGGED|code=/i.test(u)), []);
});

test('L-1: two saves swapping codes between two products at once never deadlock or 500; each code stays on exactly one product', async () => {
  on();
  const v = await vendor();
  const waitingOnLocks = async () => Number((await db.raw(`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%ProductCode%'`)).rows[0].n);
  for (let round = 0; round < 3; round += 1) {
    const x = `SWAP-X-${round}`;
    const y = `SWAP-Y-${round}`;
    const one = await product(v, { barcodes: [{ code: x }] });
    const two = await product(v, { barcodes: [{ code: y }] });
    // Line both saves up on the two code rows (a third transaction holds them), then let both go at once: without
    // ordered locking each deletes its own code and waits for the other's (40P01 → 500 before the fix).
    const blocker = await db.transaction();
    await blocker.raw('SELECT id FROM "ProductCode" WHERE "vendorId" = ? AND "codeKey" IN (?, ?) FOR UPDATE', [v, x, y]);
    const racing = Promise.all([
      put(as(v), one.id, { name: `One ${round}`, barcodes: [{ code: y }] }),
      put(as(v), two.id, { name: `Two ${round}`, barcodes: [{ code: x }] }),
    ]);
    for (let i = 0; i < 100 && (await waitingOnLocks()) < 2; i += 1) await new Promise(r => setTimeout(r, 20));
    assert.equal(await waitingOnLocks(), 2, 'both saves are waiting on the code rows');
    await blocker.commit();
    const outs = await racing;
    for (const out of outs) {
      assert.ok([200, 409].includes(out.status), JSON.stringify(out.body));
      if (out.status === 409) assert.equal(out.body.error, 'barcode_in_use');
    }
    for (const code of [x, y]) assert.equal((await db('ProductCode').where({ vendorId: v, codeKey: code })).length, 1, code);
    // A refused save changed nothing (its name included).
    for (const [p, out, name] of [[one, outs[0], `One ${round}`], [two, outs[1], `Two ${round}`]]) {
      assert.equal((await db('Product').where({ id: p.id }).first()).name, out.status === 200 ? name : p.name);
    }
  }
});

test('L-1: a deadlock (40P01) or serialization failure (40001) in a barcode save is retried once, then answered 409 barcode_in_use (never a 500)', async () => {
  const prior = { id: 'prd_retry', vendorId: 'usr_retry', name: 'Retry', priceTzs: 1000, stock: 1, variants: [], images: [], approvalStatus: 'approved' };
  const make = (failures) => {
    let calls = 0;
    const service = createShopService({
      products: { findByIdAsync: async () => prior }, shopOrders: {}, users: { findByIdAsync: async () => null }, auditLog: { insertAsync: async r => r },
      stockLedger: {
        applyProductForm: async () => { calls += 1; if (calls <= failures) throw Object.assign(new Error('deadlock detected'), { code: calls % 2 ? '40P01' : '40001' }); return { product: prior }; },
        checkLow: async () => [], privatesOf: async () => new Map(),
      },
      stockLedgerOn: () => true, barcodesOn: () => true, productCodes: { codesOf: async () => new Map([[prior.id, []]]) },
    });
    return { service, calls: () => calls };
  };
  const body = { addBarcodes: [{ code: 'RETRY-0001' }] };
  const once = make(1);
  const ok = await once.service.upsertProduct({ vendorId: prior.vendorId, productId: prior.id, body, barcodesAllowed: true });
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.equal(once.calls(), 2, 'retried once');
  const twice = make(2);
  const refused = await twice.service.upsertProduct({ vendorId: prior.vendorId, productId: prior.id, body, barcodesAllowed: true });
  assert.equal(twice.calls(), 2, 'no third try');
  assert.deepEqual([refused.error, refused.status, refused.code], ['barcode_in_use', 409, 'RETRY-0001']);
  // Anything else is not swallowed.
  const other = createShopService({
    products: { findByIdAsync: async () => prior }, shopOrders: {}, users: { findByIdAsync: async () => null }, auditLog: { insertAsync: async r => r },
    stockLedger: { applyProductForm: async () => { throw Object.assign(new Error('boom'), { code: '23502' }); } },
    stockLedgerOn: () => true, barcodesOn: () => true, productCodes: {},
  });
  await assert.rejects(other.upsertProduct({ vendorId: prior.vendorId, productId: prior.id, body, barcodesAllowed: true }), /boom/);
});

test('L-2: a code left on a variant dropped while the flag was off does not come back when a variant of the same name is added later (deleted, audit variant_removed)', async () => {
  on();
  const v = await vendor();
  const p = await product(v, { name: 'Old Band', variants: [{ name: 'S', stock: 1 }, { name: 'M', stock: 0 }], stock: undefined, barcodes: [{ code: 'BAND-M-01', variant: 'M' }, { code: 'BAND-S-01', variant: 'S' }] });
  delete process.env.VENDOR_BARCODES;
  assert.equal((await put(as(v), p.id, { variants: [{ name: 'S', stock: 1 }] })).status, 200, 'M dropped while the flag is off');
  assert.equal((await stored(p.id)).length, 2, 'nothing touched the codes while off');
  on();
  // The first flag-on save adds a NEW variant called M: the old M code is dead and is deleted, not revived.
  const readded = await put(as(v), p.id, { variants: [{ name: 'S', stock: 1 }, { name: 'M', stock: 0 }] });
  assert.equal(readded.status, 200, JSON.stringify(readded.body));
  assert.deepEqual(readded.body.barcodes, [{ code: 'BAND-S-01', variant: 'S' }]);
  assert.deepEqual((await stored(p.id)).map(r => r.code), ['BAND-S-01']);
  assert.deepEqual((await lookup(as(v), 'BAND-M-01')).body.matches, []);
  const last = afterOf((await audits(p.id)).at(-1));
  assert.deepEqual([last.reason, last.removed], ['variant_removed', [{ code: 'BAND-M-01', variant: 'M' }]]);
  // And a variant that was kept keeps its codes through a flag-on save.
  assert.deepEqual((await put(as(v), p.id, { name: 'Old Band 2' })).body.barcodes, [{ code: 'BAND-S-01', variant: 'S' }]);
});
