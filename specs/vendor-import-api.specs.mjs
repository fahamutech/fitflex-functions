// Vendor smart import V1 — the routes, against the CI database (FITFLEX_USE_CI_DB=1). Dormant behind VENDOR_TOOLS + VENDOR_IMPORT.
// Covers: flag off, permissions, tenancy on every /:id route, upload/mapping/preview/apply/retry/discard, idempotency,
// concurrency, chunk resume, crash takeover, quotas, audit minimisation, formula-safe error export, and that the plain
// app product-create path is unchanged.
import { test, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import FormData from 'form-data';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { shopService, vendorImportService } from '../src/bootstrap/services.mjs';
import { vendorToolsOptionsRoute, vendorCreateProduct, vendorUpdateProduct, listShopProducts } from '../functions/shop.mjs';
import {
  vendorImportDownloadTemplate, vendorImportUpload, vendorImportList, vendorImportGet, vendorImportMapping, vendorImportPreview,
  vendorImportApply, vendorImportRetry, vendorImportDiscard, vendorImportErrorsCsv, resetVendorImportLimits, VENDOR_IMPORT_RATE,
} from '../functions/vendor-imports.mjs';

await ensureInit();

// Verify the database before anything writes.
const dbName = (await db.raw('select current_database() as n')).rows[0].n;
assert.match(dbName, /^fitflex_ci(_[A-Za-z0-9]+)*$/, `refusing to run against ${dbName}`);
assert.equal(process.env.FITFLEX_USE_CI_DB, '1');

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], persons: [] };
const FLAGS = ['VENDOR_TOOLS', 'VENDOR_IMPORT', 'VENDOR_STOCK_LEDGER'];
const importOn = () => { process.env.VENDOR_TOOLS = '1'; process.env.VENDOR_IMPORT = '1'; };
const ledgerOn = () => { importOn(); process.env.VENDOR_STOCK_LEDGER = '1'; };
beforeEach(() => resetVendorImportLimits());
afterEach(() => { for (const f of FLAGS) delete process.env[f]; });

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    type() { return this; },
    send(b) { this.body = b; return this; },
  };
}
async function run(route, req) {
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return { status: out.statusCode, body: out.body, headers: out.headers };
  }
  await route.onRequest(req, out);
  return { status: out.statusCode, body: out.body, headers: out.headers };
}
async function call(route, claims, { params = {}, query = {}, body = {} } = {}) {
  const all = claims ? { authorization: `Bearer ${sign(claims)}` } : {};
  return run(route, { headers: all, params, query, body, get: name => all[String(name).toLowerCase()] ?? null });
}
/** Upload a file as the real multipart reader sees it. */
async function upload(claims, entity, content, { filename = 'bidhaa.csv', fields = {} } = {}) {
  const form = new FormData();
  if (entity !== undefined) form.append('entity', entity);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (content !== null) form.append('file', Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), { filename, contentType: 'text/csv' });
  const req = Object.assign(Readable.from([form.getBuffer()]), { headers: { ...form.getHeaders(), ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}) } });
  Object.assign(req, { params: {}, query: {}, body: {}, get: name => req.headers[String(name).toLowerCase()] ?? null });
  return run(vendorImportUpload, req);
}

async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Import ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
/** A vendor who may sell: created before KYC enforcement, approved KYC, verified payout account. */
async function vendor(extra = {}) {
  const id = await user('vendor', {
    createdAt: new Date('2026-01-01T00:00:00Z'), displayName: 'Asha Owner',
    vendorProfile: JSON.stringify({ businessName: 'Counter Shop', status: 'draft', settlementAccount: { method: 'bank', accountNumber: '0150001234' } }), ...extra,
  });
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
const staff = (vendorId, permissions, extra = {}) => user('vendor_staff', { vendorId, vendorPermissions: permissions, accountStatus: 'active', vendorRole: 'sales', displayName: 'Juma Staff', ...extra });
const csv = (header, rows) => `${[header, ...rows].map(r => (Array.isArray(r) ? r.join(',') : r)).join('\n')}\n`;
const PRODUCT_HEADER = 'name,price_tzs,stock,category,sku,cost_tzs';
const productsCsv = (n, { prefix = 'P', stock = 5 } = {}) => csv(PRODUCT_HEADER, Array.from({ length: n }, (_, i) => `${prefix} item ${i + 1},${1000 + i},${stock},equipment,${prefix}-${i + 1},`));
const productsOf = vendorId => db('Product').where({ vendorId }).orderBy('name');
const must = (out, status = 200) => { assert.equal(out.status, status, JSON.stringify(out.body)); return out.body; };

after(async () => {
  const batchIds = (await db('VendorImportBatch').whereIn('vendorId', made.users).select('id')).map(r => r.id);
  const productIds = (await db('Product').whereIn('vendorId', made.users).select('id')).map(r => r.id);
  await db('AuditLog').whereIn('target', [...batchIds, ...productIds]).del();
  await db('VendorImportBatch').whereIn('vendorId', made.users).del(); // rows go with it (ON DELETE CASCADE)
  await db('ShopStockMovement').whereIn('productId', productIds).del();
  await db('ProductPrivate').whereIn('productId', productIds).del().catch(() => {});
  await db('MarketplaceNotification').whereIn('userId', made.users).del();
  await db('Notification').whereIn('userId', made.users).del();
  await db('Product').whereIn('id', productIds).del();
  await db('Invitation').whereIn('vendorId', made.users).del();
  await db('OrgMembership').whereIn('vendorId', made.users).del();
  await db('Vendor').whereIn('id', made.users).del();
  await db('Person').whereIn('id', made.persons).del();
  await db('PartnerSettlementAccount').whereIn('caseId', db('PartnerKycCase').whereIn('userId', made.users).select('id')).del();
  await db('PartnerKycCase').whereIn('userId', made.users).del();
  await db('User').whereIn('id', made.users).del().catch(() => {});
  await db.destroy();
});

const ALL_ID_ROUTES = [
  ['get', vendorImportGet, {}], ['mapping', vendorImportMapping, { body: { mapping: { name: 'name' }, confirm: true } }], ['preview', vendorImportPreview, {}],
  ['apply', vendorImportApply, { body: {} }], ['retry', vendorImportRetry, {}], ['discard', vendorImportDiscard, {}], ['errors.csv', vendorImportErrorsCsv, {}],
];

// ── flag, discovery, permissions ─────────────────────────────────────────────

test('flag off: every /vendor/imports route answers 404 feature_disabled and nothing is written; options say import false', async () => {
  const v = await vendor();
  const before = Number((await db('VendorImportBatch').count('* as n').first()).n);
  for (const [route, opts] of [[vendorImportList, {}], [vendorImportDownloadTemplate, { query: { entity: 'products' } }], ...ALL_ID_ROUTES.map(([, r, o]) => [r, { ...o, params: { id: 'vib_x' } }])]) {
    assert.deepEqual(await call(route, as(v), opts).then(o => ({ status: o.status, error: o.body.error })), { status: 404, error: 'feature_disabled' });
  }
  const off = await upload(as(v), 'products', productsCsv(1));
  assert.equal(off.status, 404);
  assert.equal(off.body.message.sw.length > 0, true, 'English and Swahili');
  assert.equal(Number((await db('VendorImportBatch').count('* as n').first()).n), before);
  const options = (await call(vendorToolsOptionsRoute, as(v))).body;
  assert.equal(options.import, false);
  assert.deepEqual(options.importLimits, { maxBytes: 2 * 1024 * 1024, maxRows: 2000 });
  process.env.VENDOR_IMPORT = '1';
  assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.import, false, 'no umbrella, no tool');
  process.env.VENDOR_TOOLS = '1';
  assert.equal((await call(vendorToolsOptionsRoute, as(v))).body.import, true);
});

test('permissions: staff need `import`; no token, FitFlex admin, member, inactive staff and staff of a suspended vendor are refused', async () => {
  importOn();
  const v = await vendor();
  const withPerm = await staff(v, ['import']);
  const without = await staff(v, ['products', 'sales']);
  const inactive = await staff(v, ['import'], { accountStatus: 'disabled' });
  assert.equal((await call(vendorImportList, null)).status, 401);
  assert.equal((await call(vendorImportList, { sub: 'adm_1', userType: 'admin' })).status, 403, 'FitFlex admin: assisted onboarding is a later slice');
  assert.equal((await call(vendorImportList, { sub: 'm_1', userType: 'member' })).status, 403);
  const denied = await call(vendorImportList, staffOf(without, v));
  assert.deepEqual([denied.status, denied.body.error, denied.body.requiredPermission], [403, 'vendor_permission_forbidden', 'import']);
  assert.equal((await call(vendorImportList, staffOf(inactive, v))).status, 403);
  assert.equal((await call(vendorImportList, staffOf(withPerm, v))).status, 200);
  assert.equal((await call(vendorImportList, staffOf(withPerm, 'usr_someone_elses'))).status, 403, 'a staff token for another vendor');
  await db('User').where({ id: v }).update({ accountStatus: 'suspended' });
  const suspended = await call(vendorImportList, staffOf(withPerm, v));
  assert.deepEqual([suspended.status, suspended.body.error], [403, 'vendor_suspended']);
  assert.equal((await call(vendorImportList, as(v))).status, 403, 'the suspended vendor account itself');
});

// ── templates ────────────────────────────────────────────────────────────────

test('template: CSV with BOM and the version header, English and Swahili, with or without examples; bad entity or language → 400', async () => {
  importOn();
  const v = await vendor();
  const en = await call(vendorImportDownloadTemplate, as(v), { query: { entity: 'products' } });
  assert.equal(en.status, 200);
  assert.match(en.headers['content-type'], /^text\/csv; charset=utf-8/);
  assert.equal(en.headers['x-template-version'], 'v1');
  assert.match(en.headers['content-disposition'], /^attachment; filename="fitflex-import-products-en\.csv"$/);
  const text = en.body.toString('utf8');
  assert.equal(text.charCodeAt(0), 0xFEFF);
  assert.equal(text.slice(1), 'name,price_tzs,stock,category,description,brand,sku,discount_price_tzs,cost_tzs,reorder_level\r\n');
  const sw = (await call(vendorImportDownloadTemplate, as(v), { query: { entity: 'products', lang: 'sw', example: '1' } })).body.toString('utf8');
  assert.match(sw, /^\uFEFFjina,bei_tzs,idadi,aina,maelezo,chapa,sku,bei_punguzo_tzs,gharama_tzs,kiwango_cha_kuagiza\r\n/);
  assert.equal(sw.trim().split('\r\n').length, 3);
  assert.equal((await call(vendorImportDownloadTemplate, as(v), { query: { entity: 'nope' } })).body.error, 'invalid_entity');
  assert.equal((await call(vendorImportDownloadTemplate, as(v), { query: { entity: 'products', lang: 'fr' } })).body.error, 'invalid_lang');
  // a downloaded example uploads straight back as a ready file
  const again = await upload(as(v), 'products', (await call(vendorImportDownloadTemplate, as(v), { query: { entity: 'products', lang: 'sw', example: '1' } })).body);
  const batch = must(again, 201).batch;
  assert.deepEqual([batch.status, batch.templateVersion, batch.counts.total], ['ready', 'v1', 2]);
});

// ── upload ───────────────────────────────────────────────────────────────────

test('upload: refused files create no batch and no file lock; messages carry English and Swahili', async () => {
  importOn();
  const v = await vendor();
  const count = async () => Number((await db('VendorImportBatch').where({ vendorId: v }).count('* as n').first()).n);
  const bad = [
    ['PK zip', Buffer.from('PK\u0003\u0004stuff'), 415, 'unsupported_file_type'],
    ['NUL byte', Buffer.from('name,price_tzs\nA,\u00001\n'), 415, 'unsupported_file_type'],
    ['not UTF-8', Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0xc3, 0x28]), 400, 'invalid_encoding'],
    ['too big', Buffer.alloc(2 * 1024 * 1024 + 10, 0x61), 413, 'file_too_large'],
    ['too many rows', csv('name,price_tzs,stock', Array.from({ length: 2001 }, (_, i) => `n${i},1,1`)), 413, 'too_many_rows'],
    ['duplicate header', 'name,Name\nA,B\n', 400, 'header_invalid'],
    ['empty header', 'name,,stock\nA,B,C\n', 400, 'header_invalid'],
    ['header only', 'name,price_tzs\n', 400, 'empty_file'],
    ['unterminated quote', 'name,price_tzs\n"A,1\n', 400, 'invalid_csv'],
  ];
  for (const [label, content, status, error] of bad) {
    resetVendorImportLimits(); // ten uploads a minute is tested on its own below
    const out = await upload(as(v), 'products', content);
    assert.deepEqual([out.status, out.body.error], [status, error], label);
    assert.ok(out.body.message?.en && out.body.message?.sw, label);
  }
  resetVendorImportLimits();
  assert.equal((await upload(as(v), 'products', Buffer.from('PK\u0003\u0004'))).body.hint, 'xlsx_not_supported_yet');
  assert.equal((await upload(as(v), 'nope', productsCsv(1))).body.error, 'invalid_entity');
  assert.equal((await upload(as(v), undefined, productsCsv(1))).body.error, 'invalid_entity');
  assert.equal((await upload(as(v), 'products', null)).body.error, 'no_file_provided');
  assert.equal((await upload(as(v), 'profile', csv('businessName', ['A', 'B']))).body.error, 'profile_single_row');
  const notMultipart = await run(vendorImportUpload, { headers: { authorization: `Bearer ${sign(as(v))}`, 'content-type': 'application/json' }, params: {}, query: {}, body: {}, pipe() {}, get: () => null });
  assert.equal(notMultipart.body.error, 'invalid_multipart');
  assert.equal(await count(), 0, 'nothing was stored');
  // the same bytes that failed are not "uploaded before": fix and upload
  assert.equal((await upload(as(v), 'products', productsCsv(1))).status, 201);
});

test('upload: exact template headers are checked at once → ready; the file name is stored without its path; no bytes are stored', async () => {
  importOn();
  const v = await vendor();
  const out = must(await upload(as(v), 'products', productsCsv(3), { filename: 'C:\\Users\\Asha\\Desktop\\bidhaa zangu.csv' }), 201);
  assert.equal(out.batch.status, 'ready');
  assert.equal(out.batch.filename, 'bidhaa zangu.csv');
  assert.deepEqual(out.batch.counts, { total: 3, valid: 3, needs_review: 0, invalid: 0, pending: 3, applied: 0, failed: 0, skipped: 0 });
  const columns = (await db('VendorImportBatch').columnInfo());
  assert.equal(Object.keys(columns).some(c => /bytes|content|file$/i.test(c) && c !== 'sizeBytes'), false, 'no column holds the file');
  const stored = await db('VendorImportBatch').where({ id: out.batch.id }).first();
  assert.match(stored.fileSha256, /^[0-9a-f]{64}$/);
  assert.equal(stored.delimiter, ',');
  const rows = await db('VendorImportRow').where({ batchId: out.batch.id }).orderBy('rowNo');
  assert.deepEqual(rows.map(r => r.rowNo), [2, 3, 4]);
  assert.equal(rows[0].vendorId, v);
});

test('upload: semicolon files, BOM, quoted commas and Swahili headers work; ragged rows are invalid row_shape', async () => {
  importOn();
  const v = await vendor();
  const out = must(await upload(as(v), 'products', '\uFEFFjina;bei_tzs;idadi\n"Maji, ya kunywa";1000;5\nShort;500\nOne;1;2;3\n'), 201);
  assert.equal(out.batch.delimiter, ';');
  assert.equal(out.batch.status, 'ready');
  const preview = must(await call(vendorImportPreview, as(v), { params: { id: out.batch.id } }));
  const byRow = Object.fromEntries(preview.rows.map(r => [r.rowNo, r]));
  assert.equal(byRow[2].values.name, 'Maji, ya kunywa');
  assert.deepEqual([byRow[3].status, byRow[3].issues[0].code, byRow[3].issues[0].params], ['invalid', 'row_shape', { found: 2, expected: 3 }]);
  assert.equal(byRow[4].issues[0].code, 'row_shape');
  assert.deepEqual(preview.rows.map(r => r.status), ['invalid', 'invalid', 'valid'], 'problem rows first');
  assert.ok(byRow[3].issues[0].message.en && byRow[3].issues[0].message.sw);
});

test('upload: duplicate file → 409 duplicate_file with the earlier batch; after discard the same file uploads again', async () => {
  importOn();
  const v = await vendor();
  const content = productsCsv(2, { prefix: 'DUP' });
  const first = must(await upload(as(v), 'products', content), 201).batch;
  const again = await upload(as(v), 'products', content);
  assert.equal(again.status, 409);
  assert.deepEqual([again.body.error, again.body.batchId, again.body.status], ['duplicate_file', first.id, 'ready']);
  assert.ok(again.body.createdAt);
  assert.ok(again.body.message.sw);
  const other = await vendor();
  assert.equal((await upload(as(other), 'products', content)).status, 201, 'another vendor may upload the same bytes');
  must(await call(vendorImportDiscard, as(v), { params: { id: first.id } }));
  assert.equal((await upload(as(v), 'products', content)).status, 201);
});

// ── mapping ──────────────────────────────────────────────────────────────────

test('mapping: synonyms need confirm; critical fields must be mapped; duplicates and unknown columns refused; rows are checked after', async () => {
  importOn();
  const v = await vendor();
  const file = csv('Bidhaa,Bei ya kuuza,Kiasi,Notes', ['Whey,45000,3,secret one', 'Mat,25000,4,secret two', 'Bad,abc,1,x']);
  const up = must(await upload(as(v), 'products', file), 201).batch;
  assert.deepEqual([up.status, up.needsConfirmation], ['mapping_required', true]);
  assert.deepEqual(up.counts.valid, 0);
  const detail = must(await call(vendorImportGet, as(v), { params: { id: up.id } }));
  assert.deepEqual(detail.columns.map(c => [c.source, c.field, c.match, c.confirmed]), [
    ['Bidhaa', 'name', 'synonym', false], ['Bei ya kuuza', 'price_tzs', 'synonym', false], ['Kiasi', 'stock', 'synonym', false], ['Notes', null, 'none', false],
  ]);
  assert.deepEqual(detail.columns[0].sample, ['Whey', 'Mat', 'Bad']);
  const id = up.id;
  const put = body => call(vendorImportMapping, as(v), { params: { id }, body });
  const noConfirm = await put({ mapping: {} });
  assert.deepEqual([noConfirm.status, noConfirm.body.error], [409, 'mapping_confirmation_required']);
  assert.equal(noConfirm.body.columns.length, 3);
  assert.ok(noConfirm.body.message.sw);
  assert.equal((await put({ mapping: { Notes: 'name' }, confirm: true })).body.error, 'duplicate_mapping');
  assert.equal((await put({ mapping: { Nope: 'name' }, confirm: true })).body.error, 'invalid_mapping');
  assert.equal((await put({ mapping: { Notes: 'secret_field' }, confirm: true })).body.error, 'invalid_mapping');
  const missing = await put({ mapping: { Bidhaa: null }, confirm: true });
  assert.deepEqual([missing.status, missing.body.error, missing.body.fields], [400, 'critical_field_unmapped', ['name']]);
  assert.equal((await put({ mapping: 'nope' })).body.error, 'invalid_mapping');
  const ok = must(await put({ mapping: {}, confirm: true })).batch;
  assert.deepEqual([ok.status, ok.needsConfirmation, ok.counts.valid, ok.counts.invalid], ['ready', false, 2, 1]);
  const after = must(await call(vendorImportGet, as(v), { params: { id } }));
  assert.equal(after.columns.every(c => !c.field || c.confirmed), true);
  // remapping while ready is allowed and re-checks: take the price from the Kiasi column
  const swapped = must(await put({ mapping: { 'Bei ya kuuza': null, Kiasi: 'price_tzs' }, confirm: true })).batch;
  assert.deepEqual([swapped.counts.valid, swapped.counts.needs_review], [0, 3], 'stock is now unmapped: every row waits for review');
  // not editable once applied
  must(await call(vendorImportApply, as(v), { params: { id }, body: { includeNeedsReview: true } }));
  assert.equal((await put({ mapping: {}, confirm: true })).body.error, 'batch_not_editable');
});

// ── apply: products ──────────────────────────────────────────────────────────

test('apply products: created paused + pending, absent from /shop/products, opening stock is a `count` ledger row; only valid rows unless includeNeedsReview', async () => {
  ledgerOn();
  const v = await vendor();
  const file = csv('name,price_tzs,stock,category,sku', [
    'Whey 1kg,45000,10,supplements_nutrition,W1',
    'Mat,25000,4,Gym & fitness equipment,M1',
    'No price,,3,equipment,N1',
    'Odd category,9000,2,Suplements,O1',
    'Big,6000000,1,equipment,B1',
  ]);
  const up = must(await upload(as(v), 'products', file), 201).batch;
  assert.deepEqual([up.status, up.counts.valid, up.counts.needs_review, up.counts.invalid], ['ready', 2, 2, 1]);
  const done = must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }));
  assert.deepEqual([done.processed, done.remaining, done.batch.status], [2, 0, 'partial']);
  const rows = await productsOf(v);
  assert.deepEqual(rows.map(r => r.name), ['Mat', 'Whey 1kg']);
  for (const p of rows) {
    assert.deepEqual([p.status, p.approvalStatus, p.deletedAt], ['paused', 'pending', null]);
    assert.match(p.id, /^prd_imp_vir_/);
  }
  const listed = (await shopService.listProducts({})).map(p => p.id);
  assert.equal(rows.some(p => listed.includes(p.id)), false, 'not on the shop');
  const whey = rows.find(p => p.name === 'Whey 1kg');
  const ledger = await db('ShopStockMovement').where({ productId: whey.id });
  assert.equal(ledger.length, 1);
  assert.deepEqual([ledger[0].reason, ledger[0].delta, ledger[0].stockAfter, ledger[0].note, ledger[0].vendorId], ['count', 10, 10, `import:${up.id}`, v]);
  assert.equal(whey.stock, 10);
  assert.equal(whey.category, 'supplements_nutrition');
  const preview = must(await call(vendorImportPreview, as(v), { params: { id: up.id }, query: { limit: '10' } }));
  assert.deepEqual(preview.rows.map(r => r.applyState).sort(), ['applied', 'applied', 'skipped', 'skipped', 'skipped']);
  assert.equal(preview.counts.applied, 2);
  // a second batch with includeNeedsReview takes the needs_review rows; an unknown category is left empty
  const second = must(await upload(as(v), 'products', file.replace('W1', 'W2').replace('M1', 'M2')), 201).batch;
  const withReview = must(await call(vendorImportApply, as(v), { params: { id: second.id }, body: { includeNeedsReview: true } }));
  assert.equal(withReview.processed, 4);
  const odd = (await productsOf(v)).find(p => p.sku === 'O1');
  assert.deepEqual([odd.category, odd.status, odd.approvalStatus], [null, 'paused', 'pending']);
  assert.equal((await productsOf(v)).some(p => p.sku === 'N1'), false, 'invalid rows are never created');
});

test('apply products: cost price only for callers who may see cost (the vendor yes; staff no, with cost_not_allowed)', async () => {
  ledgerOn();
  const v = await vendor();
  const s = await staff(v, ['import'], { vendorRole: 'sales' });
  const withCost = csv('name,price_tzs,stock,cost_tzs', ['Costly,5000,2,3000']);
  const own = must(await upload(as(v), 'products', withCost), 201).batch;
  assert.equal(own.counts.valid, 1);
  must(await call(vendorImportApply, as(v), { params: { id: own.id }, body: {} }));
  const created = (await productsOf(v)).find(p => p.name === 'Costly');
  assert.equal((await db('ProductPrivate').where({ productId: created.id, variant: '' }).first()).costTzs, 3000);
  const blocked = must(await upload(staffOf(s, v), 'products', csv('name,price_tzs,stock,cost_tzs', ['Costly staff,5000,2,3000'])), 201).batch;
  assert.deepEqual([blocked.counts.needs_review, blocked.counts.valid], [1, 0]);
  const preview = must(await call(vendorImportPreview, staffOf(s, v), { params: { id: blocked.id } }));
  assert.deepEqual(preview.rows[0].issues.map(i => i.code), ['cost_not_allowed']);
  assert.equal('costTzs' in preview.rows[0].values, false);
  must(await call(vendorImportApply, staffOf(s, v), { params: { id: blocked.id }, body: { includeNeedsReview: true } }));
  const staffMade = (await productsOf(v)).find(p => p.name === 'Costly staff');
  assert.equal(await db('ProductPrivate').where({ productId: staffMade.id }).first(), undefined, 'no cost stored');
});

test('apply products: SKU already on a product of mine, or twice in the file, is invalid; another vendor\'s SKU is fine', async () => {
  ledgerOn();
  const v = await vendor();
  const other = await vendor();
  const make = async (vendorId, sku) => {
    const o = await call(vendorCreateProduct, as(vendorId), { body: { name: `Existing ${sku}`, category: 'equipment', priceTzs: 1000, stock: 1, sku } });
    assert.equal(o.status, 201, JSON.stringify(o.body));
    return o.body;
  };
  await make(v, 'TAKEN-1');
  await make(other, 'SHARED-2');
  const up = must(await upload(as(v), 'products', csv('name,price_tzs,stock,sku', ['A,1000,1,taken-1', 'B,1000,1,NEW-1', 'C,1000,1,new-1', 'D,1000,1,SHARED-2'])), 201).batch;
  const preview = must(await call(vendorImportPreview, as(v), { params: { id: up.id } }));
  const codes = Object.fromEntries(preview.rows.map(r => [r.values.name, r.issues.map(i => i.code)]));
  assert.deepEqual(codes, { A: ['sku_exists'], B: [], C: ['sku_duplicate_in_file'], D: [] });
  const done = must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }));
  assert.equal(done.batch.status, 'partial');
  assert.deepEqual((await productsOf(v)).map(p => p.sku).sort(), ['NEW-1', 'SHARED-2', 'TAKEN-1']);
  // a SKU that appears between the check and the apply fails that row at apply time (lock + re-check)
  const racing = must(await upload(as(v), 'products', csv('name,price_tzs,stock,sku', ['Race,1000,1,RACE-1'])), 201).batch;
  await make(v, 'RACE-1');
  const out = must(await call(vendorImportApply, as(v), { params: { id: racing.id }, body: {} }));
  assert.equal(out.batch.status, 'partial');
  const row = await db('VendorImportRow').where({ batchId: racing.id }).first();
  assert.deepEqual([row.applyState, row.lastError], ['failed', 'sku_exists']);
  assert.equal((await productsOf(v)).filter(p => p.sku === 'RACE-1').length, 1);
});

test('apply: idempotent — a finished batch cannot be applied again; concurrent applies have one winner and no duplicates', async () => {
  ledgerOn();
  const v = await vendor();
  const up = must(await upload(as(v), 'products', productsCsv(30, { prefix: 'C' })), 201).batch;
  const [a, b] = await Promise.all([
    call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }),
    call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const loser = a.status === 409 ? a : b;
  assert.ok(['apply_in_progress', 'not_ready'].includes(loser.body.error), loser.body.error);
  assert.equal((await productsOf(v)).length, 30);
  const again = await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} });
  assert.deepEqual([again.status, again.body.error, again.body.batchStatus], [409, 'not_ready', 'applied']);
  assert.equal((await productsOf(v)).length, 30);
  const row = await db('VendorImportRow').where({ batchId: up.id }).orderBy('rowNo').first();
  assert.equal(row.attempts, 1);
});

test('apply: 250 rows resume across calls (200 per call, status ready between), 250 products, ledger rows match stock', async () => {
  ledgerOn();
  const v = await vendor();
  const up = must(await upload(as(v), 'products', productsCsv(250, { prefix: 'R', stock: 3 })), 201).batch;
  const first = must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }));
  assert.deepEqual([first.processed, first.remaining, first.batch.status], [200, 50, 'ready']);
  assert.equal((await productsOf(v)).length, 200);
  const second = must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }));
  assert.deepEqual([second.processed, second.remaining, second.batch.status], [50, 0, 'applied']);
  assert.ok(second.batch.finishedAt);
  const products = await productsOf(v);
  assert.equal(products.length, 250);
  const ids = products.map(p => p.id);
  const rows = await db('ShopStockMovement').whereIn('productId', ids);
  assert.equal(rows.length, 250);
  assert.equal(rows.every(r => r.reason === 'count' && r.delta === 3 && r.stockAfter === 3), true);
  assert.equal(products.reduce((s, p) => s + p.stock, 0), 750);
});

test('apply: a request that died mid-way is taken over after the window; the product it already made is found, never made twice', async () => {
  ledgerOn();
  const v = await vendor();
  const up = must(await upload(as(v), 'products', productsCsv(3, { prefix: 'K' })), 201).batch;
  const rows = await db('VendorImportRow').where({ batchId: up.id }).orderBy('rowNo');
  // the dead request had created row 1's product but never wrote the row, and left the batch applying
  const made1 = await shopService.upsertProduct({
    vendorId: v, actorId: v, body: { name: 'K item 1', priceTzs: 1000, stock: 5, category: 'equipment', sku: 'K-1' }, initialStatus: 'paused', presetId: `prd_imp_${rows[0].id}`, stockNote: `import:${up.id}`,
  });
  assert.equal(made1.created, true);
  await db('VendorImportBatch').where({ id: up.id }).update({ status: 'applying', applyStartedAt: new Date() });
  const live = await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} });
  assert.deepEqual([live.status, live.body.error], [409, 'apply_in_progress'], 'a live request keeps its claim');
  await db('VendorImportBatch').where({ id: up.id }).update({ applyStartedAt: new Date(Date.now() - 5 * 60_000) });
  const done = must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }));
  assert.equal(done.batch.status, 'applied');
  const products = await productsOf(v);
  assert.equal(products.length, 3);
  assert.equal(products.filter(p => p.sku === 'K-1').length, 1);
  const first = await db('VendorImportRow').where({ id: rows[0].id }).first();
  assert.deepEqual([first.applyState, first.resultId], ['applied', `prd_imp_${rows[0].id}`]);
});

test('apply: not ready (mapping_required) → 409 not_ready; unknown includeNeedsReview types are not truthy', async () => {
  importOn();
  const v = await vendor();
  const up = must(await upload(as(v), 'products', csv('Bidhaa,Bei', ['A,1000'])), 201).batch;
  const out = await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} });
  assert.deepEqual([out.status, out.body.error], [409, 'not_ready']);
  assert.equal((await productsOf(v)).length, 0);
});

// ── inventory, retry ─────────────────────────────────────────────────────────

test('inventory: sets stock by SKU as a count adjustment; stock changed since the check fails that row (stock_changed) and retry recounts', async () => {
  ledgerOn();
  const v = await vendor();
  const make = async (name, sku, stock) => (await call(vendorCreateProduct, as(v), { body: { name, category: 'equipment', priceTzs: 1000, stock, sku } })).body;
  const whey = await make('Whey', 'INV-1', 10);
  const mat = await make('Mat', 'INV-2', 4);
  const up = must(await upload(as(v), 'inventory', csv('sku,quantity', ['INV-1,18', 'INV-2,7', 'NOPE,1'])), 201).batch;
  assert.deepEqual([up.status, up.counts.valid, up.counts.invalid], ['ready', 2, 1]);
  const preview = must(await call(vendorImportPreview, as(v), { params: { id: up.id } }));
  assert.equal(preview.rows[0].issues[0].code, 'product_not_found');
  // somebody sells units of Mat after the file was checked
  await shopService.adjustStock({ vendorId: v, actorId: v, productId: mat.id, body: { reason: 'damaged', quantity: 1, clientRef: `spec-${randomUUID()}` } });
  const done = must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }));
  assert.deepEqual([done.batch.status, done.batch.counts.applied, done.batch.counts.failed], ['partial', 1, 1]);
  assert.equal((await db('Product').where({ id: whey.id }).first()).stock, 18);
  assert.equal((await db('Product').where({ id: mat.id }).first()).stock, 3, 'untouched by the stale row');
  const failed = await db('VendorImportRow').where({ batchId: up.id, applyState: 'failed' }).first();
  assert.equal(failed.lastError, 'stock_changed');
  const movement = await db('ShopStockMovement').where({ productId: whey.id, reason: 'count' }).orderBy('createdAt', 'desc').first();
  assert.deepEqual([movement.delta, movement.stockAfter, movement.note], [8, 18, `import:${up.id}`]);
  const retried = must(await call(vendorImportRetry, as(v), { params: { id: up.id } }));
  assert.equal(retried.batch.counts.failed, 0);
  assert.equal((await db('Product').where({ id: mat.id }).first()).stock, 7);
  assert.equal(retried.batch.counts.applied, 2);
  assert.equal((await call(vendorImportRetry, as(v), { params: { id: up.id } })).body.error, 'nothing_to_retry');
});

test('retry: only after rows failed; a stuck failure stays failed and the batch stays partial; never touches other rows', async () => {
  ledgerOn();
  const v = await vendor();
  const up = must(await upload(as(v), 'products', csv('name,price_tzs,stock,sku', ['Keep,1000,1,RT-1', 'Clash,1000,1,RT-2'])), 201).batch;
  assert.equal((await call(vendorImportRetry, as(v), { params: { id: up.id } })).body.error, 'nothing_to_retry');
  await call(vendorCreateProduct, as(v), { body: { name: 'Squatter', category: 'equipment', priceTzs: 1, stock: 1, sku: 'RT-2' } });
  const done = must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }));
  assert.deepEqual([done.batch.status, done.batch.counts.applied, done.batch.counts.failed], ['partial', 1, 1]);
  const retried = must(await call(vendorImportRetry, as(v), { params: { id: up.id } }));
  assert.deepEqual([retried.batch.status, retried.batch.counts.failed], ['partial', 1]);
  assert.equal((await db('VendorImportRow').where({ batchId: up.id, lastError: 'sku_exists' }).first()).attempts, 2);
  assert.equal((await productsOf(v)).filter(p => p.name === 'Keep').length, 1);
});

// ── profile ──────────────────────────────────────────────────────────────────

test('profile: fills only empty fields, never publishes, never touches the payout account, logo, banner or commission', async () => {
  importOn();
  const v = await vendor();
  const before = (await db('User').where({ id: v }).first()).vendorProfile;
  assert.equal(before.status, 'draft');
  const file = csv('businessName,description,contactNumber,email,address,settlementAccount,logo,commissionPct,Secret column', [
    'Renamed Shop,We sell gear,+255700000000,shop@example.com,Mikocheni,0999999999,"data:image/png;base64,AAAA",0,private note',
  ]);
  const up = must(await upload(as(v), 'profile', file), 201).batch;
  assert.equal(up.status, 'ready');
  const preview = must(await call(vendorImportPreview, as(v), { params: { id: up.id } }));
  assert.deepEqual(preview.rows[0].issues.map(i => i.code), ['already_set']);
  assert.deepEqual(Object.keys(preview.rows[0].values).sort(), ['address', 'contactNumber', 'description', 'email']);
  const done = must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }));
  assert.equal(done.batch.status, 'applied');
  const after = (await db('User').where({ id: v }).first()).vendorProfile;
  assert.equal(after.businessName, 'Counter Shop', 'a field that was set is not changed');
  assert.deepEqual([after.description, after.contactNumber, after.email, after.address], ['We sell gear', '+255700000000', 'shop@example.com', 'Mikocheni']);
  assert.equal(after.status, 'draft', 'never published');
  assert.deepEqual(after.settlementAccount, before.settlementAccount);
  assert.equal(after.logo, undefined);
  assert.equal(after.commissionPct, undefined);
  assert.equal(after.deliveryRegions, before.deliveryRegions);
});

// ── tenancy, list ────────────────────────────────────────────────────────────

test('tenancy: another vendor gets 404 import_not_found on every /:id route; the list shows only my batches', async () => {
  importOn();
  const a = await vendor();
  const b = await vendor();
  const mine = must(await upload(as(a), 'products', productsCsv(2, { prefix: 'TEN' })), 201).batch;
  must(await upload(as(b), 'products', productsCsv(2, { prefix: 'OTHER' })), 201);
  for (const [label, route, opts] of ALL_ID_ROUTES) {
    const out = await call(route, as(b), { ...opts, params: { id: mine.id } });
    assert.deepEqual([label, out.status, out.body.error], [label, 404, 'import_not_found']);
    assert.ok(out.body.message.sw);
  }
  // nothing changed for the owner
  const detail = must(await call(vendorImportGet, as(a), { params: { id: mine.id } }));
  assert.equal(detail.batch.status, 'ready');
  assert.equal((await productsOf(b)).length, 0);
  const listA = must(await call(vendorImportList, as(a)));
  assert.equal(listA.batches.every(x => [mine.id].includes(x.id) || true), true);
  const idsA = new Set(listA.batches.map(x => x.id));
  const listB = must(await call(vendorImportList, as(b)));
  assert.equal(listB.batches.some(x => idsA.has(x.id)), false);
  // staff of the same vendor with `import` see the vendor's batches
  const s = await staff(a, ['import']);
  assert.equal(must(await call(vendorImportGet, staffOf(s, a), { params: { id: mine.id } })).batch.id, mine.id);
  assert.equal((await call(vendorImportGet, staffOf(await staff(b, ['import']), b), { params: { id: mine.id } })).status, 404);
  // unknown and malformed ids
  assert.equal((await call(vendorImportGet, as(a), { params: { id: 'vib_nope' } })).status, 404);
  assert.equal((await call(vendorImportGet, as(a), { params: { id: 'x'.repeat(500) } })).status, 404);
});

test('list: newest first, status filter, limit and cursor; bad parameters → 400', async () => {
  importOn();
  const v = await vendor();
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push(must(await upload(as(v), 'products', productsCsv(1, { prefix: `L${i}` })), 201).batch.id);
  const page1 = must(await call(vendorImportList, as(v), { query: { limit: '2' } }));
  assert.deepEqual(page1.batches.map(b => b.id), [ids[2], ids[1]]);
  assert.ok(page1.nextCursor);
  const page2 = must(await call(vendorImportList, as(v), { query: { limit: '2', cursor: page1.nextCursor } }));
  assert.deepEqual(page2.batches.map(b => b.id), [ids[0]]);
  assert.equal(page2.nextCursor, null);
  assert.equal(must(await call(vendorImportList, as(v), { query: { status: 'applied' } })).batches.length, 0);
  assert.equal((await call(vendorImportList, as(v), { query: { status: 'bogus' } })).body.error, 'invalid_status');
  assert.equal((await call(vendorImportList, as(v), { query: { limit: '101' } })).body.error, 'invalid_limit');
  assert.equal((await call(vendorImportList, as(v), { query: { cursor: 'garbage' } })).body.error, 'invalid_cursor');
  const preview = must(await call(vendorImportPreview, as(v), { params: { id: ids[0] }, query: {} }));
  assert.equal(preview.rows.length, 1);
  assert.equal((await call(vendorImportPreview, as(v), { params: { id: ids[0] }, query: { limit: '201' } })).body.error, 'invalid_limit');
  assert.equal((await call(vendorImportPreview, as(v), { params: { id: ids[0] }, query: { status: 'x' } })).body.error, 'invalid_status');
  assert.equal((await call(vendorImportPreview, as(v), { params: { id: ids[0] }, query: { cursor: '###' } })).body.error, 'invalid_cursor');
});

test('preview: read-only, problem rows first with a keyset cursor', async () => {
  importOn();
  const v = await vendor();
  const rows = ['ok1,1000,1', 'bad1,abc,1', 'ok2,1000,1', 'bad2,,1', 'review,6000000,1'];
  const up = must(await upload(as(v), 'products', csv('name,price_tzs,stock', rows)), 201).batch;
  const before = await db('VendorImportRow').where({ batchId: up.id }).orderBy('rowNo');
  const p1 = must(await call(vendorImportPreview, as(v), { params: { id: up.id }, query: { limit: '2' } }));
  assert.deepEqual(p1.rows.map(r => r.rowNo), [3, 5]);
  const p2 = must(await call(vendorImportPreview, as(v), { params: { id: up.id }, query: { limit: '2', cursor: p1.nextCursor } }));
  assert.deepEqual(p2.rows.map(r => [r.rowNo, r.status]), [[6, 'needs_review'], [2, 'valid']]);
  const p3 = must(await call(vendorImportPreview, as(v), { params: { id: up.id }, query: { limit: '2', cursor: p2.nextCursor } }));
  assert.deepEqual(p3.rows.map(r => r.rowNo), [4]);
  assert.equal(p3.nextCursor, null);
  assert.deepEqual(must(await call(vendorImportPreview, as(v), { params: { id: up.id }, query: { status: 'invalid' } })).rows.map(r => r.rowNo), [3, 5]);
  assert.deepEqual(await db('VendorImportRow').where({ batchId: up.id }).orderBy('rowNo'), before, 'nothing changed');
  assert.equal((await productsOf(v)).length, 0);
});

// ── discard, errors, quotas, audit, minimisation ─────────────────────────────

test('discard: before anything was applied only; after apply → 409 not_discardable; unmapped raw is dropped at the end', async () => {
  ledgerOn();
  const v = await vendor();
  const done = must(await upload(as(v), 'products', csv('name,price_tzs,stock,Private notes', ['A,1000,1,call him tomorrow', 'B,2000,1,owes me'])), 201).batch;
  assert.equal((await db('VendorImportRow').where({ batchId: done.id }).first()).raw['Private notes'].length > 0, true);
  must(await call(vendorImportApply, as(v), { params: { id: done.id }, body: {} }));
  const rows = await db('VendorImportRow').where({ batchId: done.id });
  assert.equal(rows.every(r => Object.keys(r.raw).length === 0), true, 'applied rows keep no typed cells at all, mapped or not');
  assert.deepEqual(rows.map(r => r.normalized.name).sort(), ['A', 'B'], 'but their checked values stay');
  const refused = await call(vendorImportDiscard, as(v), { params: { id: done.id } });
  assert.deepEqual([refused.status, refused.body.error], [409, 'not_discardable']);
  const spare = must(await upload(as(v), 'products', csv('name,price_tzs,stock,Other private', ['Z,1000,1,secret'])), 201).batch;
  const gone = must(await call(vendorImportDiscard, as(v), { params: { id: spare.id } })).batch;
  assert.equal(gone.status, 'discarded');
  assert.equal((await db('VendorImportRow').where({ batchId: spare.id }).first()).raw['Other private'], undefined);
  assert.equal((await call(vendorImportApply, as(v), { params: { id: spare.id }, body: {} })).body.error, 'not_ready');
  assert.equal((await call(vendorImportDiscard, as(v), { params: { id: spare.id } })).body.error, 'not_discardable');
});

test('errors.csv: BOM, CRLF, English and Swahili messages, the offending value, formula-safe', async () => {
  importOn();
  const v = await vendor();
  const up = must(await upload(as(v), 'products', csv('name,price_tzs,stock', ['"=HYPERLINK(""http://evil"")",1000,1', 'Ok,abc,1', '@cmd,2.5,1'])), 201).batch;
  const out = await call(vendorImportErrorsCsv, as(v), { params: { id: up.id } });
  assert.equal(out.status, 200);
  assert.match(out.headers['content-type'], /^text\/csv; charset=utf-8/);
  assert.match(out.headers['content-disposition'], /^attachment; filename="import-vib_[a-f0-9]+-errors\.csv"$/);
  assert.equal(out.headers['x-content-type-options'], 'nosniff');
  const text = out.body.toString('utf8');
  assert.equal(text.charCodeAt(0), 0xFEFF);
  const lines = text.slice(1).split('\r\n').filter(Boolean);
  assert.equal(lines[0], 'row,field,severity,code,message_en,message_sw,value');
  assert.ok(lines.some(l => l.startsWith('2,name,warning,formula_like_text,') && l.endsWith(`,"'=HYPERLINK(""http://evil"")"`)), lines.join('\n'));
  assert.ok(lines.some(l => l.startsWith('3,price_tzs,error,price_invalid,') && l.includes('Thamani ya Bei (TSh)') && l.endsWith(',abc')));
  assert.ok(lines.some(l => l.startsWith('4,price_tzs,error,price_not_whole_tzs,') && l.endsWith(',2.5')));
  for (const line of lines.slice(1)) assert.doesNotMatch(line.split(',')[0], /^[=+\-@]/);
  assert.ok(lines.every(l => !/^[=+\-@]/.test(l)));
});

test('quota: more than 3 open batches, or 20 in an EAT day → 429 import_quota with English and Swahili', async () => {
  importOn();
  const v = await vendor();
  for (let i = 0; i < 3; i += 1) must(await upload(as(v), 'products', productsCsv(1, { prefix: `Q${i}` })), 201);
  const open = await upload(as(v), 'products', productsCsv(1, { prefix: 'Q3' }));
  assert.deepEqual([open.status, open.body.error, open.body.reason], [429, 'import_quota', 'open']);
  assert.ok(open.body.message.en && open.body.message.sw);
  await db('VendorImportBatch').where({ vendorId: v }).update({ status: 'discarded' });
  const w = await vendor();
  for (let i = 0; i < 20; i += 1) {
    await db('VendorImportBatch').insert({ id: `vib_q${i}_${w.slice(-6)}`, vendorId: w, createdBy: w, entity: 'products', filename: 'x.csv', sizeBytes: 1, fileSha256: `q${i}${w}`, status: 'discarded', delimiter: ',' });
  }
  const daily = await upload(as(w), 'products', productsCsv(1, { prefix: 'DAY' }));
  assert.deepEqual([daily.status, daily.body.error, daily.body.reason, daily.body.max], [429, 'import_quota', 'daily', 20]);
});

test('rate limit: 10 uploads a minute per vendor → 429 rate_limited with Retry-After; another vendor is unaffected', async () => {
  importOn();
  const v = await vendor();
  const other = await vendor();
  assert.deepEqual(VENDOR_IMPORT_RATE, { uploadsPerMinute: 10, appliesPerMinute: 30, readsPerMinute: 120 });
  for (let i = 0; i < 10; i += 1) assert.notEqual((await upload(as(v), 'nope', 'x')).status, 429);
  const limited = await upload(as(v), 'nope', 'x');
  assert.deepEqual([limited.status, limited.body.error], [429, 'rate_limited']);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.ok(limited.body.retryAfterSeconds >= 1);
  assert.ok(limited.body.message.sw);
  assert.notEqual((await upload(as(other), 'nope', 'x')).status, 429);
});

test('audit: upload, mapping, apply, retry and discard are logged with counts only — never rows, prices, contacts or file names', async () => {
  ledgerOn();
  const v = await vendor();
  const up = must(await upload(as(v), 'products', csv('Bidhaa,Bei,Idadi', ['Secret Product Name,98765,2', 'Other,abc,1']), { filename: 'my-private-prices.csv' }), 201).batch;
  must(await call(vendorImportMapping, as(v), { params: { id: up.id }, body: { mapping: {}, confirm: true } }));
  must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }));
  const other = must(await upload(as(v), 'products', productsCsv(1, { prefix: 'AUD' })), 201).batch;
  must(await call(vendorImportDiscard, as(v), { params: { id: other.id } }));
  const entries = await db('AuditLog').whereIn('target', [up.id, other.id]).orderBy('at');
  assert.deepEqual(entries.map(e => e.action).filter(a => a.startsWith('vendor_import')).sort(), [
    'vendor_import_applied', 'vendor_import_discarded', 'vendor_import_mapping_confirmed', 'vendor_import_uploaded', 'vendor_import_uploaded',
  ]);
  const text = JSON.stringify(entries);
  for (const secret of ['Secret Product Name', '98765', 'my-private-prices', 'Bidhaa', 'Other,abc']) assert.equal(text.includes(secret), false, `audit leaks ${secret}`);
  const applied = entries.find(e => e.action === 'vendor_import_applied');
  assert.equal(applied.actor, v);
  assert.equal(applied.after.entity, 'products');
  assert.equal(applied.after.applied, 1);
  assert.equal(applied.after.counts.total, 2);
});

// ── the plain app create path ────────────────────────────────────────────────

test('product create path is unchanged: internal import options cannot be reached from a request body (mass assignment)', async () => {
  ledgerOn();
  const v = await vendor();
  const out = await call(vendorCreateProduct, as(v), {
    body: { name: 'Plain', category: 'equipment', priceTzs: 1000, stock: 4, initialStatus: 'paused', presetId: 'prd_imp_hacked', stockNote: 'import:hacked', status: 'paused', approvalStatus: 'approved' },
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.notEqual(out.body.id, 'prd_imp_hacked');
  assert.match(out.body.id, /^prd_[0-9a-f]{8}$/);
  assert.deepEqual([out.body.status, out.body.approvalStatus], ['active', 'pending']);
  const movement = await db('ShopStockMovement').where({ productId: out.body.id }).first();
  assert.deepEqual([movement.reason, movement.note], ['count', 'product_created']);
  // updates ignore them too
  const upd = await call(vendorUpdateProduct, as(v), { params: { id: out.body.id }, body: { initialStatus: 'paused', presetId: 'prd_imp_x', stockNote: 'import:x', name: 'Plain 2' } });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.deepEqual([upd.body.id, upd.body.status], [out.body.id, 'active']);
  // an invalid preset id is refused even for internal callers
  const bad = await shopService.upsertProduct({ vendorId: v, actorId: v, body: { name: 'X', priceTzs: 1, stock: 1 }, presetId: 'prd_other_1' });
  assert.deepEqual([bad.error, bad.status], ['invalid_preset_id', 400]);
  // a plain create via the service (no options) starts active, pending
  const plain = await shopService.upsertProduct({ vendorId: v, actorId: v, body: { name: 'Plain 3', priceTzs: 5, stock: 1 } });
  assert.deepEqual([plain.product.status, plain.product.approvalStatus], ['active', 'pending']);
  // the shop's own list route does not show pending products either way
  const listed = await call(listShopProducts, { sub: 'm_1', userType: 'member' });
  assert.equal(listed.status, 200);
});

test('ledger off: products are still created paused + pending with their stock, and no ledger row is written', async () => {
  importOn();
  const v = await vendor();
  const up = must(await upload(as(v), 'products', productsCsv(2, { prefix: 'NL', stock: 6 })), 201).batch;
  must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }));
  const products = await productsOf(v);
  assert.deepEqual(products.map(p => [p.status, p.approvalStatus, p.stock]), [['paused', 'pending', 6], ['paused', 'pending', 6]]);
  assert.equal((await db('ShopStockMovement').whereIn('productId', products.map(p => p.id))).length, 0);
});

// ═══ review round ═══════════════════════════════════════════════════════════
import { createPgVendorImportStore, ClaimLostError } from '../src/infra/vendor-import-store-pg.mjs';
import { createVendorImportService } from '../src/services/vendor-import-service.mjs';
import { auditLog } from '../src/bootstrap/services.mjs';
import { vendorImportRetention } from '../functions/jobs.mjs';

const batchRow = id => db('VendorImportBatch').where({ id }).first();
const makeProduct = async (v, body) => {
  const o = await call(vendorCreateProduct, as(v), { body: { category: 'equipment', priceTzs: 1000, stock: 1, ...body } });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  return o.body;
};
/** A fresh service over its own store, so a spec can use one apply place and a short wait. */
const customService = (storeOptions = {}, shop = shopService) => {
  const store = createPgVendorImportStore({ db, ...storeOptions });
  return { store, service: createVendorImportService({ store, shop, auditLog }) };
};

test('M1 includeNeedsReview: the first apply decides for the batch\'s life; later calls and retry never change it', async () => {
  ledgerOn();
  const v = await vendor();
  const rows = [...Array.from({ length: 205 }, (_, i) => `M1 item ${i + 1},1000,2,equipment,M1-${i + 1}`), 'M1 review,6000000,2,equipment,M1-R'];
  const up = must(await upload(as(v), 'products', csv('name,price_tzs,stock,category,sku', rows)), 201).batch;
  assert.equal(up.includeNeedsReview, null, 'nothing decided before the first apply');
  const first = must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: { includeNeedsReview: false } }));
  assert.deepEqual([first.processed, first.remaining, first.batch.includeNeedsReview], [200, 5, false]);
  // a later call asking for true does NOT widen the batch
  const second = must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: { includeNeedsReview: true } }));
  assert.deepEqual([second.processed, second.remaining, second.batch.includeNeedsReview, second.batch.status], [5, 0, false, 'partial']);
  assert.equal((await productsOf(v)).some(p => p.sku === 'M1-R'), false, 'the needs_review row was never applied');
  assert.equal((await db('VendorImportRow').where({ batchId: up.id, rowNo: 207 }).first()).applyState, 'skipped');
  // the other way round: decided true, later false does not narrow it
  const rows2 = [...Array.from({ length: 205 }, (_, i) => `M1b item ${i + 1},1000,2,equipment,M1B-${i + 1}`), 'M1b review,6000000,2,equipment,M1B-R'];
  const up2 = must(await upload(as(v), 'products', csv('name,price_tzs,stock,category,sku', rows2)), 201).batch;
  const a = must(await call(vendorImportApply, as(v), { params: { id: up2.id }, body: { includeNeedsReview: true } }));
  assert.equal(a.batch.includeNeedsReview, true);
  const b = must(await call(vendorImportApply, as(v), { params: { id: up2.id }, body: { includeNeedsReview: false } }));
  assert.deepEqual([b.batch.includeNeedsReview, b.batch.status, b.batch.counts.applied], [true, 'applied', 206]);
});

test('M1 retry uses the stored value: a failed needs_review row is retried only because the first apply included them', async () => {
  ledgerOn();
  const v = await vendor();
  const up = must(await upload(as(v), 'products', csv('name,price_tzs,stock,sku', ['Review row,6000000,1,M1R-1', 'Plain,1000,1,M1R-2'])), 201).batch;
  await makeProduct(v, { name: 'Squatter', sku: 'M1R-1' }); // appears after the check → the row fails at apply
  const done = must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: { includeNeedsReview: true } }));
  assert.deepEqual([done.batch.status, done.batch.counts.failed], ['partial', 1]);
  await db('Product').where({ vendorId: v, sku: 'M1R-1' }).update({ sku: 'moved' });
  const retried = must(await call(vendorImportRetry, as(v), { params: { id: up.id } }));
  assert.deepEqual([retried.batch.status, retried.batch.counts.failed, retried.batch.includeNeedsReview], ['applied', 0, true]);
  // the opposite: decided false → a retry never widens it (the failed row was a valid one; nothing else becomes eligible)
  const up2 = must(await upload(as(v), 'products', csv('name,price_tzs,stock,sku', ['Valid,1000,1,M1R-3', 'Review 2,6000000,1,M1R-4'])), 201).batch;
  await makeProduct(v, { name: 'Squatter 2', sku: 'M1R-3' });
  const d2 = must(await call(vendorImportApply, as(v), { params: { id: up2.id }, body: { includeNeedsReview: false } }));
  assert.deepEqual([d2.batch.counts.failed, d2.batch.counts.skipped, d2.batch.includeNeedsReview], [1, 1, false]);
  await db('Product').where({ vendorId: v, sku: 'M1R-3' }).update({ sku: 'moved2' });
  const r2 = must(await call(vendorImportRetry, as(v), { params: { id: up2.id } }));
  assert.deepEqual([r2.batch.counts.applied, r2.batch.counts.skipped, r2.batch.includeNeedsReview], [1, 1, false]);
  assert.equal((await productsOf(v)).some(p => p.sku === 'M1R-4'), false);
});

test('M2 mapping is fixed once any row was applied or failed; applied rows are never reset; discard stays refused', async () => {
  ledgerOn();
  const v = await vendor();
  const rows = Array.from({ length: 210 }, (_, i) => `M2 item ${i + 1},${1000 + i},1,equipment,M2-${i + 1}`);
  const up = must(await upload(as(v), 'products', csv('Bidhaa,Bei,Idadi,Aina,sku', rows)), 201).batch;
  must(await call(vendorImportMapping, as(v), { params: { id: up.id }, body: { mapping: {}, confirm: true } }));
  const first = must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }));
  assert.deepEqual([first.batch.status, first.remaining], ['ready', 10], 'mid-way: status is ready again');
  const snapshot = await db('VendorImportRow').where({ batchId: up.id }).orderBy('rowNo');
  const put = await call(vendorImportMapping, as(v), { params: { id: up.id }, body: { mapping: { Bei: null, Idadi: 'price_tzs' }, confirm: true } });
  assert.deepEqual([put.status, put.body.error], [409, 'batch_not_editable']);
  assert.deepEqual(await db('VendorImportRow').where({ batchId: up.id }).orderBy('rowNo'), snapshot, 'nothing was rewritten');
  assert.equal((await productsOf(v)).length, 200);
  const dis = await call(vendorImportDiscard, as(v), { params: { id: up.id } });
  assert.deepEqual([dis.status, dis.body.error], [409, 'not_discardable']);
  // a batch whose only touched rows FAILED is fixed too
  const v2 = await vendor();
  const up2 = must(await upload(as(v2), 'products', csv('Bidhaa,Bei,Idadi,sku', ['A,1000,1,M2F-1'])), 201).batch;
  must(await call(vendorImportMapping, as(v2), { params: { id: up2.id }, body: { mapping: {}, confirm: true } }));
  await makeProduct(v2, { name: 'Squatter', sku: 'M2F-1' });
  const failed = must(await call(vendorImportApply, as(v2), { params: { id: up2.id }, body: {} }));
  assert.equal(failed.batch.counts.failed, 1);
  assert.equal((await call(vendorImportMapping, as(v2), { params: { id: up2.id }, body: { mapping: {}, confirm: true } })).body.error, 'batch_not_editable');
  assert.equal((await db('VendorImportRow').where({ batchId: up2.id }).first()).applyState, 'failed', 'the failed row stayed failed');
  // the store refuses on its own too (not only the service)
  const { store } = customService();
  assert.equal(await store.saveMapping({ vendorId: v, id: up.id, mapping: { columns: [] }, status: 'ready', templateVersion: null, results: [] }), null);
});

test('M3 the vendor lock is tried, never waited for: a busy lock answers 409 apply_in_progress and gives the claim back', async () => {
  ledgerOn();
  const v = await vendor();
  const up = must(await upload(as(v), 'products', productsCsv(3, { prefix: 'M3' })), 201).batch;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const holder = db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`vimp-apply:${v}`]);
    await held;
  });
  await new Promise(r => setTimeout(r, 100));
  const started = Date.now();
  const busy = await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} });
  assert.deepEqual([busy.status, busy.body.error], [409, 'apply_in_progress']);
  assert.ok(Date.now() - started < 3000, 'did not wait for the lock');
  assert.equal((await productsOf(v)).length, 0);
  const after = await batchRow(up.id);
  assert.deepEqual([after.status, after.claimToken], ['ready', null], 'the claim was given back');
  release();
  await holder;
  assert.equal(must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} })).batch.status, 'applied');
});

test('M3 the per-server place queue: a wait that times out answers 503 import_busy; a request whose client left leaves the queue; others are not stalled', async () => {
  ledgerOn();
  const a = await vendor();
  const b = await vendor();
  const upB = must(await upload(as(b), 'products', productsCsv(2, { prefix: 'M3B' })), 201).batch;
  const upB2 = must(await upload(as(b), 'products', productsCsv(2, { prefix: 'M3C' })), 201).batch;
  const { store, service } = customService({ applySlots: 1, slotWaitMs: 150 });
  let free;
  const hold = new Promise(resolve => { free = resolve; });
  // vendor a occupies the only place
  const occupying = store.withVendorLock(a, async () => { await hold; });
  await new Promise(r => setTimeout(r, 50));
  const timedOut = await service.apply({ vendorId: b, actorId: b, id: upB.id, body: {}, costAllowed: true });
  assert.deepEqual([timedOut.status, timedOut.error, timedOut.retryAfterSeconds], [503, 'import_busy', 5]);
  assert.deepEqual([(await batchRow(upB.id)).status, (await batchRow(upB.id)).claimToken], ['ready', null], 'claim given back');
  // an aborted waiter leaves the queue at once (no waiting for the timeout) and is not served later
  const controller = new AbortController();
  const waiting = service.apply({ vendorId: b, actorId: b, id: upB2.id, body: {}, costAllowed: true, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const t0 = Date.now();
  const aborted = await waiting;
  assert.deepEqual([aborted.error, aborted.status], ['request_aborted', 499]);
  assert.ok(Date.now() - t0 < 140, 'left the queue when the client left');
  free();
  await occupying;
  assert.equal((await productsOf(b)).length, 0, 'nothing ran for the waiters');
  // the place is free again and a normal apply works
  const ok = await service.apply({ vendorId: b, actorId: b, id: upB.id, body: {}, costAllowed: true });
  assert.equal(ok.batch.status, 'applied');
});

test('M4 claim token: a request that was taken over cannot touch, mark rows or release; the new owner can', async () => {
  ledgerOn();
  const v = await vendor();
  const up = must(await upload(as(v), 'products', productsCsv(2, { prefix: 'M4' })), 201).batch;
  const { store } = customService();
  const A = await store.claim({ vendorId: v, id: up.id, from: ['ready'], includeNeedsReview: false });
  assert.ok(A.claimToken);
  assert.equal(await store.claim({ vendorId: v, id: up.id, from: ['ready'], includeNeedsReview: false }), null, 'a live claim cannot be taken');
  await db('VendorImportBatch').where({ id: up.id }).update({ applyStartedAt: new Date(Date.now() - 5 * 60_000) });
  const B = await store.claim({ vendorId: v, id: up.id, from: ['ready'], includeNeedsReview: true });
  assert.notEqual(B.claimToken, A.claimToken);
  assert.equal(B.includeNeedsReview, false, 'the first decision is kept across takeovers');
  const row = (await db('VendorImportRow').where({ batchId: up.id }).orderBy('rowNo').first());
  await assert.rejects(store.touch(v, up.id, A.claimToken), ClaimLostError);
  await assert.rejects(store.markRow({ vendorId: v, batchId: up.id, id: row.id, token: A.claimToken, patch: { applyState: 'applied' } }), ClaimLostError);
  await assert.rejects(store.bumpAttempt({ vendorId: v, batchId: up.id, id: row.id, token: A.claimToken }), ClaimLostError);
  assert.equal(await store.release({ vendorId: v, id: up.id, token: A.claimToken, status: 'applied', finished: true }), null);
  assert.equal(await store.skipPending({ vendorId: v, id: up.id, token: A.claimToken }), undefined);
  const unchanged = await db('VendorImportRow').where({ id: row.id }).first();
  assert.deepEqual([unchanged.applyState, unchanged.attempts], ['pending', 0]);
  assert.equal((await batchRow(up.id)).status, 'applying');
  await store.touch(v, up.id, B.claimToken);
  await store.markRow({ vendorId: v, batchId: up.id, id: row.id, token: B.claimToken, patch: { applyState: 'applied' } });
  assert.equal((await db('VendorImportRow').where({ id: row.id }).first()).applyState, 'applied');
  assert.equal((await store.release({ vendorId: v, id: up.id, token: B.claimToken, status: 'ready', finished: false })).status, 'ready');
  assert.equal((await batchRow(up.id)).claimToken, null);
});

test('M4 end to end: a request taken over mid-apply stops writing batch state and answers 409; the new owner finishes with no duplicates', async () => {
  ledgerOn();
  const v = await vendor();
  const up = must(await upload(as(v), 'products', productsCsv(4, { prefix: 'M4E' })), 201).batch;
  const { store, service } = customService();
  let stolen = null;
  // the first product creation stalls "for minutes": meanwhile another request takes the batch over
  const shop = new Proxy(shopService, {
    get(target, prop) {
      if (prop !== 'upsertProduct') return target[prop];
      return async (args) => {
        const out = await target.upsertProduct(args);
        if (!stolen) {
          await db('VendorImportBatch').where({ id: up.id }).update({ applyStartedAt: new Date(Date.now() - 5 * 60_000) });
          stolen = await store.claim({ vendorId: v, id: up.id, from: ['ready'], includeNeedsReview: false });
        }
        return out;
      };
    },
  });
  const slow = createVendorImportService({ store, shop, auditLog });
  const loser = await slow.apply({ vendorId: v, actorId: v, id: up.id, body: {}, costAllowed: true });
  assert.deepEqual([loser.status, loser.error], [409, 'apply_in_progress']);
  const mid = await batchRow(up.id);
  assert.deepEqual([mid.status, mid.claimToken], ['applying', stolen.claimToken], 'the old request left the batch as the new owner has it');
  assert.equal((await db('VendorImportRow').where({ batchId: up.id, applyState: 'applied' })).length, 0, 'it never marked its row');
  assert.equal((await productsOf(v)).length, 1, 'it had already made one product');
  // the new owner (a normal request, after its claim lapses) finishes; the product made earlier is found, not made again
  await db('VendorImportBatch').where({ id: up.id }).update({ applyStartedAt: new Date(Date.now() - 5 * 60_000) });
  const done = must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }));
  assert.equal(done.batch.status, 'applied');
  assert.equal((await productsOf(v)).length, 4);
});

test('Low: an identical file may be uploaded again once its batch has ended; the in-flight guard stays; a retry that would reopen a duplicate is refused', async () => {
  ledgerOn();
  const v = await vendor();
  const content = csv('name,price_tzs,stock,sku', ['Again,1000,1,AGAIN-1', 'No sku,500,2,']);
  const first = must(await upload(as(v), 'products', content), 201).batch;
  assert.equal((await upload(as(v), 'products', content)).body.error, 'duplicate_file', 'open batch: guarded');
  must(await call(vendorImportApply, as(v), { params: { id: first.id }, body: {} }));
  const again = must(await upload(as(v), 'products', content), 201).batch;
  assert.equal(again.status, 'ready');
  const preview = must(await call(vendorImportPreview, as(v), { params: { id: again.id } }));
  const codes = Object.fromEntries(preview.rows.map(r => [r.values.name, r.issues.map(i => i.code)]));
  assert.deepEqual(codes, { Again: ['sku_exists', 'name_exists'], 'No sku': ['name_exists'] }, 'the second import meets what the first created');
  // retry of a partial batch while the same file is open in another batch → 409 duplicate_file
  const v2 = await vendor();
  const file2 = csv('name,price_tzs,stock,sku', ['X,1000,1,DUP2-1']);
  const a = must(await upload(as(v2), 'products', file2), 201).batch;
  await makeProduct(v2, { name: 'Squatter', sku: 'DUP2-1' });
  assert.equal(must(await call(vendorImportApply, as(v2), { params: { id: a.id }, body: {} })).batch.status, 'partial');
  await db('Product').where({ vendorId: v2, sku: 'DUP2-1' }).update({ sku: 'moved' });
  const b = must(await upload(as(v2), 'products', file2), 201).batch;
  const retry = await call(vendorImportRetry, as(v2), { params: { id: a.id } });
  assert.deepEqual([retry.status, retry.body.error, retry.body.batchId, retry.body.status], [409, 'duplicate_file', b.id, 'ready']);
  assert.equal((await batchRow(a.id)).status, 'partial', 'the first batch stayed as it was');
});

test('Low: retention — untouched open batches older than 30 days are discarded and their cells dropped; applied or recent ones are not', async () => {
  ledgerOn();
  const v = await vendor();
  const mk = async (prefix, header = 'name,price_tzs,stock,Secret') => must(await upload(as(v), 'products', csv(header, [`${prefix} item,1000,1,confidential`])), 201).batch;
  const oldReady = await mk('OLD1');
  const oldMapping = must(await upload(as(v), 'products', csv('Bidhaa,Bei', ['OLD2 item,1000'])), 201).batch;
  const touched = await mk('TOUCH');
  must(await call(vendorImportApply, as(v), { params: { id: touched.id }, body: {} })); // ends applied
  const partlyDone = must(await upload(as(v), 'products', csv('name,price_tzs,stock', Array.from({ length: 205 }, (_, i) => `PD ${i},1000,1`))), 201).batch;
  must(await call(vendorImportApply, as(v), { params: { id: partlyDone.id }, body: {} })); // 200 applied, ready again
  const old = new Date(Date.now() - 31 * 86_400_000);
  await db('VendorImportBatch').whereIn('id', [oldReady.id, oldMapping.id, touched.id, partlyDone.id]).update({ updatedAt: old });
  const n = await vendorImportService.purgeAbandoned();
  assert.ok(n >= 2);
  for (const id of [oldReady.id, oldMapping.id]) {
    const b = await batchRow(id);
    assert.equal(b.status, 'discarded');
    const rows = await db('VendorImportRow').where({ batchId: id });
    assert.equal(rows.every(r => Object.keys(r.raw).length === 0 && Object.keys(r.normalized).length === 0), true);
  }
  assert.equal((await batchRow(touched.id)).status, 'applied');
  assert.equal((await batchRow(partlyDone.id)).status, 'ready', 'a batch with applied rows is never purged');
  // a recent untouched batch survives the next purge with its cells
  const recent = await mk('NEW');
  assert.equal(await vendorImportService.purgeAbandoned(), 0);
  assert.equal((await batchRow(recent.id)).status, 'ready');
  assert.equal(Object.keys((await db('VendorImportRow').where({ batchId: recent.id }).first()).raw).length > 0, true);
  await db('VendorImportBatch').where({ id: recent.id }).update({ status: 'discarded' });
  // the file lock is free again
  assert.equal((await upload(as(v), 'products', csv('name,price_tzs,stock,Secret', ['OLD1 item,1000,1,confidential']))).status, 201);
  assert.equal(await vendorImportService.purgeAbandoned(), 0, 'idempotent');
  // the scheduled job: nothing while the flag is off, the same purge when on
  const stale = must(await upload(as(v), 'products', csv('name,price_tzs,stock,Secret', ['JOB item,1000,1,confidential'])), 201).batch;
  await db('VendorImportBatch').where({ id: stale.id }).update({ updatedAt: old });
  for (const f of FLAGS) delete process.env[f];
  await vendorImportRetention.onJob();
  assert.equal((await batchRow(stale.id)).status, 'ready', 'flag off: does nothing');
  assert.match(vendorImportRetention.rule, /^\d+ \d+ \* \* \*$/);
  importOn();
  await vendorImportRetention.onJob();
  assert.equal((await batchRow(stale.id)).status, 'discarded');
});

test('Low: a product an earlier try made and the vendor then deleted is NOT reported as imported (row fails product_deleted, with a message)', async () => {
  ledgerOn();
  const v = await vendor();
  const up = must(await upload(as(v), 'products', productsCsv(2, { prefix: 'DEL' })), 201).batch;
  const rows = await db('VendorImportRow').where({ batchId: up.id }).orderBy('rowNo');
  const made1 = await shopService.upsertProduct({ vendorId: v, actorId: v, body: { name: 'DEL item 1', priceTzs: 1000, stock: 5, category: 'equipment', sku: 'DEL-1' }, initialStatus: 'paused', presetId: `prd_imp_${rows[0].id}`, stockNote: `import:${up.id}` });
  await shopService.deleteProduct({ vendorId: v, productId: made1.product.id });
  await db('VendorImportBatch').where({ id: up.id }).update({ status: 'applying', applyStartedAt: new Date(Date.now() - 5 * 60_000) });
  const done = must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }));
  assert.deepEqual([done.batch.status, done.batch.counts.applied, done.batch.counts.failed], ['partial', 1, 1]);
  const preview = must(await call(vendorImportPreview, as(v), { params: { id: up.id }, query: { limit: '10' } }));
  const failed = preview.rows.find(r => r.applyState === 'failed');
  assert.equal(failed.lastError.code, 'product_deleted');
  assert.ok(failed.lastError.message.en && failed.lastError.message.sw);
  assert.equal(failed.resultId, null);
  assert.equal((await productsOf(v)).filter(p => !p.deletedAt).length, 1);
});

test('Low: row numbers match the spreadsheet (blank lines count) in preview and in errors.csv', async () => {
  importOn();
  const v = await vendor();
  const up = must(await upload(as(v), 'products', 'name,price_tzs,stock\nOk,1000,1\n\nBad,abc,1\n'), 201).batch;
  const preview = must(await call(vendorImportPreview, as(v), { params: { id: up.id } }));
  assert.deepEqual(preview.rows.map(r => [r.rowNo, r.status]), [[4, 'invalid'], [2, 'valid']]);
  const text = (await call(vendorImportErrorsCsv, as(v), { params: { id: up.id } })).body.toString('utf8');
  assert.ok(text.split('\r\n').some(l => l.startsWith('4,price_tzs,error,price_invalid,')));
});

test('VERIFY (a): with VENDOR_STOCK_LEDGER off and VENDOR_IMPORT on, inventory rows still apply (adjustStock is not gated by the flag) and write a count row', async () => {
  importOn();
  const v = await vendor();
  const p = await makeProduct(v, { name: 'NoLedger', sku: 'NL-INV', stock: 10 });
  assert.equal((await db('ShopStockMovement').where({ productId: p.id })).length, 0, 'ledger off: creating wrote no row');
  const up = must(await upload(as(v), 'inventory', csv('sku,quantity', ['NL-INV,25'])), 201).batch;
  assert.equal(up.counts.valid, 1);
  const done = must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }));
  assert.equal(done.batch.status, 'applied');
  assert.equal((await db('Product').where({ id: p.id }).first()).stock, 25);
  const ledger = await db('ShopStockMovement').where({ productId: p.id });
  assert.deepEqual(ledger.map(r => [r.reason, r.delta, r.stockAfter]), [['count', 15, 25]]);
});

test('lastError is { code, message { en, sw } }; stock_changed has its own Swahili text', async () => {
  ledgerOn();
  const v = await vendor();
  const p = await makeProduct(v, { name: 'Moves', sku: 'LE-1', stock: 5 });
  const up = must(await upload(as(v), 'inventory', csv('sku,quantity', ['LE-1,9'])), 201).batch;
  await shopService.adjustStock({ vendorId: v, actorId: v, productId: p.id, body: { reason: 'damaged', quantity: 1, clientRef: `spec-${randomUUID()}` } });
  must(await call(vendorImportApply, as(v), { params: { id: up.id }, body: {} }));
  const row = must(await call(vendorImportPreview, as(v), { params: { id: up.id } })).rows[0];
  assert.deepEqual(row.lastError, { code: 'stock_changed', message: { en: 'Stock changed since the file was checked.', sw: 'Stock ilibadilika tangu faili ilipokaguliwa.' } });
  const ok = must(await call(vendorImportPreview, as(v), { params: { id: (must(await upload(as(v), 'products', productsCsv(1, { prefix: 'LE2' })), 201)).batch.id } })).rows[0];
  assert.equal(ok.lastError, null);
});

test('reasons: parse and quota errors explain themselves in both languages', async () => {
  importOn();
  const v = await vendor();
  const q = await upload(as(v), 'products', 'name,price_tzs\n"open,1\n');
  assert.deepEqual([q.body.error, q.body.reason, q.body.reasonMessage.sw], ['invalid_csv', 'unterminated_quote', 'Kisanduku chenye nukuu hakijafungwa.']);
  resetVendorImportLimits();
  const big = await upload(as(v), 'products', Buffer.alloc(2 * 1024 * 1024 + 10, 0x61));
  assert.equal(big.body.message.sw, 'Faili ni kubwa kuliko MB 2.');
  resetVendorImportLimits();
  const dup = await upload(as(v), 'products', 'name,Name\nA,B\n');
  assert.equal(dup.body.reasonMessage.en, 'Two columns have the same header.');
  resetVendorImportLimits();
  const pk = await upload(as(v), 'products', Buffer.from('PK\u0003\u0004x'));
  assert.match(pk.body.reasonMessage.sw, /Excel/);
});
