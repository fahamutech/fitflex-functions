// Owner decision 2026-10-29: a vendor changing a product's price (priceTzs) or discount price
// (discountPriceTzs) does not send an already-approved product back to pending review or hide it.
// Other reviewed fields (name, description, category, brand, images, variant names) still do.
// Still guarded: validation, the flash-sale price lock (409 while a sale is scheduled or live),
// the ProductPriceChange history (trigger) and a `product_price_changed` audit row.
// Against the CI database, through PUT /vendor/products/:id, with the stock ledger off and on.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { shopService, flashSaleService } from '../src/bootstrap/services.mjs';
import { vendorCreateProduct, vendorUpdateProduct, listShopProducts, getShopProduct } from '../functions/shop.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const made = { users: [], products: [] };
const FLAGS = ['VENDOR_TOOLS', 'VENDOR_STOCK_LEDGER', 'SHOP_FLASH_SALES'];
const ledger = mode => { if (mode === 'on') { process.env.VENDOR_TOOLS = '1'; process.env.VENDOR_STOCK_LEDGER = '1'; } };
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
  const headers = { authorization: `Bearer ${sign(claims)}` };
  const req = { headers, params, query, body, get: name => headers[String(name).toLowerCase()] ?? null };
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
  const id = uid(userType === 'admin' ? 'adm' : 'usr');
  await db('User').insert({ id, userType, displayName: `Price ${userType}`, accountStatus: 'active', updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
/** A vendor who may sell: created before KYC enforcement, with approved KYC and a verified payout account. */
async function vendor() {
  const id = await user('vendor', { createdAt: new Date('2026-01-01T00:00:00Z'), approvalStatus: 'approved', vendorProfile: JSON.stringify({ businessName: 'Price Shop', status: 'published' }) });
  const caseId = uid('kyc');
  await db('PartnerKycCase').insert({ id: caseId, partnerType: 'vendor', userId: id, status: 'approved', tier: 3, updatedAt: new Date() });
  await db('PartnerSettlementAccount').insert({
    id: uid('psa'), caseId, method: 'bank', provider: 'CRDB', accountName: 'Price Shop', accountNumber: '0150001234',
    status: 'verified', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z'), cooldownUntil: new Date('2026-09-03T00:00:00Z'), updatedAt: new Date(),
  });
  return id;
}
const as = id => ({ sub: id, userType: 'vendor' });
const member = () => ({ sub: uid('usr'), userType: 'member' });

let ADMIN;
/** A product created through the vendor endpoint, then approved by an admin. */
async function listed(vendorId, body = {}) {
  const out = await call(vendorCreateProduct, as(vendorId), { body: { name: 'Kettlebell', category: 'supplements_nutrition', priceTzs: 100_000, stock: 10, images: ['/storage/bafytest/k.webp'], ...body } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  made.products.push(out.body.id);
  await shopService.adminUpdateProductListing({ productId: out.body.id, body: { approvalStatus: 'approved' }, actorId: ADMIN });
  return out.body;
}
const row = id => db('Product').where({ id }).first();
const edit = (v, id, body) => call(vendorUpdateProduct, as(v), { params: { id }, body });
const inShop = async (v, id) => (await call(listShopProducts, member(), { query: { vendorId: v } })).body.some(x => x.id === id);
const history = productId => db('ProductPriceChange').where({ productId }).orderBy('at').orderBy('id');
const audits = productId => db('AuditLog').where({ target: productId, action: 'product_price_changed' }).orderBy('at');
const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);

before(async () => { ADMIN = await user('admin'); });

after(async () => {
  await db('FlashSale').whereIn('productId', made.products).del();
  await db('ShopStockMovement').whereIn('productId', made.products).del();
  await db('AuditLog').whereIn('target', made.products).del();
  await db('AuditLog').where('action', 'like', 'flash_sale.%').whereIn('actor', made.users).del();
  await db('MarketplaceNotification').whereIn('userId', made.users).del();
  await db('Notification').whereIn('userId', made.users).del();
  await db('ProductPriceChange').whereIn('productId', made.products).del();
  await db('Product').whereIn('id', made.products).del();
  await db('PartnerSettlementAccount').whereIn('caseId', db('PartnerKycCase').whereIn('userId', made.users).select('id')).del();
  await db('PartnerKycCase').whereIn('userId', made.users).del();
  await db('User').whereIn('id', made.users).del().catch(() => {});
  await db.destroy();
});

for (const mode of ['off', 'on']) {
  test(`price edits (ledger ${mode}): a raise, a cut and a discount change keep an approved product approved and in the shop`, async () => {
    ledger(mode);
    const v = await vendor();
    const p = await listed(v);
    assert.equal((await row(p.id)).approvalStatus, 'approved');
    assert.equal(await inShop(v, p.id), true);
    const form = { name: 'Kettlebell', category: 'supplements_nutrition', priceTzs: 100_000, discountPriceTzs: null, images: ['/storage/bafytest/k.webp'] };

    for (const [label, body, price, discount] of [
      ['raise', { ...form, priceTzs: 120_000 }, 120_000, null],
      ['cut', { ...form, priceTzs: 90_000 }, 90_000, null],
      ['discount set', { ...form, priceTzs: 90_000, discountPriceTzs: 80_000 }, 90_000, 80_000],
      ['discount changed', { ...form, priceTzs: 90_000, discountPriceTzs: 75_000 }, 90_000, 75_000],
      ['discount cleared', { ...form, priceTzs: 90_000, discountPriceTzs: null }, 90_000, null],
      ['price alone', { priceTzs: 95_000 }, 95_000, null],
    ]) {
      const out = await edit(v, p.id, body);
      assert.equal(out.status, 200, `${label}: ${JSON.stringify(out.body)}`);
      const stored = await row(p.id);
      assert.deepEqual([stored.approvalStatus, Number(stored.priceTzs), stored.discountPriceTzs == null ? null : Number(stored.discountPriceTzs)], ['approved', price, discount], label);
      assert.equal(out.body.approvalStatus, 'approved', `${label}: the response says approved`);
      assert.equal(await inShop(v, p.id), true, `${label}: still listed for buyers`);
    }
    const detail = await call(getShopProduct, member(), { params: { id: p.id } });
    assert.deepEqual([detail.status, detail.body.priceTzs], [200, 95_000], 'the product page shows the new price');

    // Price history (trigger) has every change; the audit log has who made each.
    const changes = (await history(p.id)).filter(c => c.source !== 'migration_baseline').map(c => [c.field, c.fromTzs == null ? null : Number(c.fromTzs), c.toTzs == null ? null : Number(c.toTzs)]);
    for (const want of [['priceTzs', 100_000, 120_000], ['priceTzs', 120_000, 90_000], ['discountPriceTzs', null, 80_000], ['discountPriceTzs', 80_000, 75_000], ['priceTzs', 90_000, 95_000]]) {
      assert.ok(changes.some(c => c[0] === want[0] && c[2] === want[2] && (want[1] == null || c[1] === want[1])), `price history has ${JSON.stringify(want)}: ${JSON.stringify(changes)}`);
    }
    const logged = (await audits(p.id)).map(a => ({ actor: a.actor, before: parse(a.before), after: parse(a.after) }));
    assert.equal(logged.length, 6, JSON.stringify(logged));
    assert.deepEqual(logged.map(a => a.actor), Array(6).fill(v));
    assert.deepEqual(logged[0].before, { priceTzs: 100_000, discountPriceTzs: null });
    assert.deepEqual([logged[0].after.priceTzs, logged[0].after.discountPriceTzs, logged[0].after.vendorId, logged[0].after.approvalStatus], [120_000, null, v, 'approved']);
    assert.deepEqual([logged[3].before, logged[3].after.discountPriceTzs], [{ priceTzs: 90_000, discountPriceTzs: 80_000 }, 75_000]);

    // Saving the whole form unchanged (the app sends every field) writes no audit row.
    assert.equal((await edit(v, p.id, { ...form, priceTzs: 95_000, stock: 4 })).status, 200);
    assert.equal((await audits(p.id)).length, 6, 'no price change, no audit row');
  });

  test(`price edits (ledger ${mode}): a name or photo change still sends an approved product back to review and out of the shop`, async () => {
    ledger(mode);
    const v = await vendor();
    const a = await listed(v);
    assert.equal((await edit(v, a.id, { name: 'Kettlebell 16kg', priceTzs: 110_000 })).status, 200);
    assert.equal((await row(a.id)).approvalStatus, 'pending', 'a new name is reviewed (with a price change in the same save)');
    assert.equal(await inShop(v, a.id), false, 'pending products are not shown');
    assert.equal((await audits(a.id)).length, 1, 'the price change in that save is still audited');

    const b = await listed(v);
    assert.equal((await edit(v, b.id, { images: ['/storage/bafytest/k2.webp'] })).status, 200);
    assert.equal((await row(b.id)).approvalStatus, 'pending', 'a new photo is reviewed');

    const c = await listed(v);
    assert.equal((await edit(v, c.id, { description: 'Cast iron' })).status, 200);
    assert.equal((await row(c.id)).approvalStatus, 'pending', 'a new description is reviewed');
  });
}

test('price edits: validation still applies (positive whole numbers; discount may be 0)', async () => {
  const v = await vendor();
  const p = await listed(v);
  for (const body of [{ priceTzs: 0 }, { priceTzs: -5 }, { priceTzs: 1000.5 }, { priceTzs: 'abc' }]) {
    const out = await edit(v, p.id, body);
    assert.deepEqual([out.status, out.body.error], [400, 'priceTzs_required'], JSON.stringify(body));
  }
  for (const body of [{ discountPriceTzs: -1 }, { discountPriceTzs: 10.5 }]) {
    const out = await edit(v, p.id, body);
    assert.deepEqual([out.status, out.body.error, out.body.field], [400, 'invalid_field', 'discountPriceTzs'], JSON.stringify(body));
  }
  const stored = await row(p.id);
  assert.deepEqual([Number(stored.priceTzs), stored.approvalStatus], [100_000, 'approved'], 'refused edits change nothing');
  assert.equal((await audits(p.id)).length, 0);
});

test('price edits: moderation can still hide an approved product by hand after a price edit', async () => {
  const v = await vendor();
  const p = await listed(v);
  assert.equal((await edit(v, p.id, { priceTzs: 80_000 })).status, 200);
  assert.equal(await inShop(v, p.id), true);
  await shopService.adminUpdateProductListing({ productId: p.id, body: { approvalStatus: 'pending' }, actorId: ADMIN });
  assert.equal(await inShop(v, p.id), false);
  await shopService.adminUpdateProductListing({ productId: p.id, body: { approvalStatus: 'approved', homepageVisible: false }, actorId: ADMIN });
  assert.equal((await row(p.id)).homepageVisible, false);
});

for (const mode of ['off', 'on']) {
  test(`price edits (ledger ${mode}): the flash-sale price lock still refuses a price change while a sale is scheduled (409), and nothing is audited`, async () => {
    ledger(mode);
    process.env.SHOP_FLASH_SALES = '1';
    const v = await vendor();
    const p = await listed(v);
    // Owner ruling: 14 days of price history before a sale.
    await db('ProductPriceChange').where({ productId: p.id }).update({ at: new Date(Date.now() - 20 * DAY) });
    const startsAt = new Date(Date.now() + 2 * HOUR).toISOString();
    const endsAt = new Date(Date.now() + 2 * HOUR + DAY).toISOString();
    const scope = { origin: 'vendor', vendorId: v };
    const created = await flashSaleService.create({ scope, actorId: v, body: { productId: p.id, salePriceTzs: 80_000, startsAt, endsAt } });
    assert.ok(created.sale, JSON.stringify(created));
    assert.ok((await flashSaleService.submit({ scope, id: created.sale.id, actorId: v })).saved);
    const revision = (await db('FlashSale').where({ id: created.sale.id }).first()).revision;
    const approved = await flashSaleService.approve({ id: created.sale.id, actorId: ADMIN, revision });
    assert.ok(approved.saved, JSON.stringify(approved));

    for (const body of [{ priceTzs: 120_000 }, { priceTzs: 90_000 }, { discountPriceTzs: 95_000 }]) {
      const out = await edit(v, p.id, body);
      assert.deepEqual([out.status, out.body.error, out.body.reason, out.body.saleId], [409, 'sale_conflict', 'price_locked_by_flash_sale', created.sale.id], JSON.stringify(out.body));
    }
    const stored = await row(p.id);
    assert.deepEqual([Number(stored.priceTzs), stored.approvalStatus], [100_000, 'approved']);
    assert.equal((await audits(p.id)).length, 0, 'a refused edit is not audited');
    // Same prices with other fields (old app builds send the whole form) still save.
    assert.equal((await edit(v, p.id, { priceTzs: 100_000, discountPriceTzs: 0, stock: 6 })).status, 200);
  });
}
