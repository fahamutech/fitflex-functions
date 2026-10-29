// Shop flash sales (Phase 2 · slice 4, flag SHOP_FLASH_SALES). Contract: docs/shop-flash-sales-api.md.
// PRICING PATH: these specs pin down what a buyer is charged.
// - effectivePrice: the lowest of price, a valid discount and a live approved sale, by the server clock,
//   to the millisecond at both ends of the window.
// - Checkout: the sale price on the line (commission on it), expectedPriceTzs + 409 price_changed, the
//   lock re-check when the window closes / a sale starts / staff end it between pricing and the lock,
//   the price fixed once the order is placed.
// - Workflow: rules (≥ 5 %, no maximum, below the effective price, 1 h – 7 days, 14-day rule, one sale
//   per product), the two-person rule and revisions, the price lock on the product, expiry.
// Service tests use the real Postgres stores (CI database) with one controllable clock.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db } from '../src/infra/knex-store.mjs';
import { products, shopOrders, users, auditLog, paymentRequests } from '../src/bootstrap/collections.mjs';
import { ensureInit } from '../functions/index.mjs';
import { createShopService } from '../src/services/shop-service.mjs';
import { createPgShopOrderStore } from '../src/infra/shop-order-store-pg.mjs';
import { createFlashSaleService } from '../src/services/flash-sale-service.mjs';
import { createPgFlashSaleStore } from '../src/infra/flash-sale-store-pg.mjs';
import { createPartnerNotifier } from '../src/services/partner-notifier.mjs';
import { effectivePrice, standingPrice, priceBreakdown, saleLiveFor, discountPct } from '../src/shared/shop-pricing.mjs';
import { maxSalePrice, priceRaiseError, parseSaleInput, SALE_RULES } from '../src/shared/flash-sale-rules.mjs';
import { priceOrderLine, vendorShareOfOrder } from '../src/shared/marketplace-pricing.mjs';
import { walkInPrice } from '../src/shared/vendor-sale.mjs';

await ensureInit();
const migration = createRequire(import.meta.url)('../db/migrations/20270129090000-shop-flash-sales.cjs');

const uid = p => `${p}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const made = { users: [], products: [], orders: [] };

async function user(userType, extra = {}) {
  const id = uid(userType === 'admin' ? 'adm' : 'usr');
  await db('User').insert({ id, userType, displayName: `Flash ${userType}`, accountStatus: 'active', updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
const vendorUser = (extra = {}) => user('vendor', { approvalStatus: 'approved', vendorProfile: JSON.stringify({ businessName: `Flash Shop ${randomUUID().slice(0, 4)}`, status: 'published' }), ...extra });
async function product(vendorId, extra = {}) {
  const id = uid('prd');
  await db('Product').insert({ id, vendorId, name: `Flash product ${id.slice(-4)}`, category: 'equipment', priceTzs: 100_000, stock: 10, soldCount: 0, status: 'active', approvalStatus: 'approved', updatedAt: new Date(), ...extra });
  made.products.push(id);
  return id;
}
const productRow = async id => db('Product').where({ id }).first();

/** Flash sale service + shop service over the real stores, one clock (the store's may be set apart). */
function harness({ unverified = [] } = {}) {
  const t = { clock: Date.now(), storeClock: null, flag: true };
  const notices = [];
  const gate = { unverified: new Set(unverified) };
  const svc = createFlashSaleService({
    store: createPgFlashSaleStore({ db }),
    partnerGate: { operationalUserIds: async ids => new Set(ids.filter(id => !gate.unverified.has(id))) },
    notifyVendor: async (vendorId, type, data) => { notices.push({ vendorId, type, data }); },
    now: () => new Date(t.clock),
    logger: { error() {}, warn() {} },
  });
  const pgOrders = createPgShopOrderStore({ db, now: () => new Date(t.storeClock ?? t.clock) });
  const orderStore = { ...pgOrders, placeOrder: async (args) => { if (t.beforeLock) await t.beforeLock(args); return pgOrders.placeOrder(args); } };
  const shop = createShopService({
    products, shopOrders, users, auditLog, paymentRequests, orderStore, reservationTtlMinutes: 72 * 60,
    flashSales: svc.pricing, flashSalesOn: () => t.flag, now: () => new Date(t.clock),
  });
  const at = (offset = 0) => new Date(t.clock + offset).toISOString();
  return { t, svc, shop, notices, gate, at, tick: ms => { t.clock += ms; } };
}

let ADMIN_X; let ADMIN_Y;
const vendorScope = vendorId => ({ origin: 'vendor', vendorId });
const STAFF = { origin: 'staff' };
const revisionOf = async id => (await db('FlashSale').where({ id }).first()).revision;

/** A vendor sale sent for approval: start in `startIn`, `length` long. → { id, vendor, productId }. */
async function pendingSale(h, { vendor, productId, salePriceTzs = 80_000, startIn = 2 * HOUR, length = DAY, productExtra = {} } = {}) {
  vendor ||= await vendorUser();
  productId ||= await product(vendor, productExtra);
  const created = await h.svc.create({ scope: vendorScope(vendor), actorId: vendor, body: { productId, salePriceTzs, startsAt: h.at(startIn), endsAt: h.at(startIn + length) } });
  assert.ok(created.sale, JSON.stringify(created));
  const sent = await h.svc.submit({ scope: vendorScope(vendor), id: created.sale.id, actorId: vendor });
  assert.ok(sent.saved, JSON.stringify(sent));
  return { id: created.sale.id, vendor, productId };
}
async function approvedSale(h, opts = {}) {
  const s = await pendingSale(h, opts);
  const ok = await h.svc.approve({ id: s.id, actorId: ADMIN_Y, revision: await revisionOf(s.id) });
  assert.ok(ok.saved, JSON.stringify(ok));
  return { ...s, sale: ok.saved };
}
const cart = (items, extra = {}) => ({ items, deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni', paymentMethod: 'mpesa', ...extra });
async function order(h, buyerId, items) {
  const out = await h.shop.createOrder({ buyerId, body: cart(items) });
  if (out.order) made.orders.push(out.order.id);
  return out;
}

before(async () => {
  ADMIN_X = await user('admin');
  ADMIN_Y = await user('admin');
});

after(async () => {
  await db('FlashSale').whereIn('productId', made.products).del();
  await db('AuditLog').where('action', 'like', 'flash_sale.%').whereIn('actor', made.users).del();
  if (made.orders.length) {
    await db('ShopStockMovement').whereIn('orderId', made.orders).del();
    await db('PaymentRequest').whereIn('orderId', made.orders).del();
    await db('ShopOrder').whereIn('id', made.orders).del();
  }
  await db('ProductPriceChange').whereIn('productId', made.products).del();
  await db('MarketplaceNotification').whereIn('userId', made.users).del();
  await db('Product').whereIn('id', made.products).del();
  await db('User').whereIn('id', made.users).del();
  await db.destroy();
});

beforeEach(() => { delete process.env.SHOP_FLASH_SALE_MAX_OPEN; delete process.env.SHOP_PROPOSAL_EXPIRY_DAYS; });

// ── Pure pricing ────────────────────────────────────────────────────────────

test('effectivePrice: the lowest of price, a valid discount and a live approved sale of this product and vendor', () => {
  const p = { id: 'p1', vendorId: 'v1', priceTzs: 85_000, discountPriceTzs: 79_000 };
  const sale = { id: 's1', productId: 'p1', vendorId: 'v1', status: 'approved', salePriceTzs: 69_000, startsAt: '2026-11-01T10:00:00.000Z', endsAt: '2026-11-01T12:00:00.000Z' };
  const at = iso => new Date(iso);
  assert.equal(standingPrice(p), 79_000);
  assert.equal(standingPrice({ priceTzs: 85_000, discountPriceTzs: 90_000 }), 85_000, 'a discount above the price is ignored');
  assert.equal(standingPrice({ priceTzs: 85_000, discountPriceTzs: 0 }), 85_000);
  // Boundaries to the millisecond: [startsAt, endsAt).
  assert.equal(effectivePrice(p, sale, at('2026-11-01T09:59:59.999Z')), 79_000);
  assert.equal(effectivePrice(p, sale, at('2026-11-01T10:00:00.000Z')), 69_000);
  assert.equal(effectivePrice(p, sale, at('2026-11-01T11:59:59.999Z')), 69_000);
  assert.equal(effectivePrice(p, sale, at('2026-11-01T12:00:00.000Z')), 79_000);
  assert.deepEqual(priceBreakdown(p, sale, at('2026-11-01T11:00:00Z')).source, 'flash_sale');
  assert.deepEqual(priceBreakdown(p, null, at('2026-11-01T11:00:00Z')).source, 'discount');
  // Anything not exactly a live approved sale of this product and vendor changes nothing.
  const live = at('2026-11-01T11:00:00Z');
  for (const bad of [{ status: 'pending_approval' }, { status: 'ended' }, { productId: 'p2' }, { vendorId: 'v2' }, { salePriceTzs: 80_000 }, { salePriceTzs: 0 }]) {
    assert.equal(saleLiveFor(p, { ...sale, ...bad }, live), false, JSON.stringify(bad));
    assert.equal(effectivePrice(p, { ...sale, ...bad }, live), 79_000, JSON.stringify(bad));
  }
  assert.equal(discountPct(85_000, 69_000), 18);
  // Walk-in (POS) prices never read a sale.
  assert.equal(walkInPrice(p), 79_000);
});

test('rules: at least 5 % off (floored), no maximum, sale price ≥ 1; 14-day raise rule; body shape', () => {
  assert.equal(maxSalePrice(100_000), 95_000);
  assert.equal(maxSalePrice(85_001), 80_750);
  assert.equal(discountPct(85_001, 80_750), 5);
  assert.equal(discountPct(85_001, 80_751), 4);
  assert.equal(parseSaleInput({ productId: 'p', salePriceTzs: 0, startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-02T00:00:00Z' }, { create: true }).error, 'invalid_field');
  assert.equal(parseSaleInput({ productId: 'p', salePriceTzs: 1.5, startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-02T00:00:00Z' }, { create: true }).error, 'invalid_field');
  assert.deepEqual(parseSaleInput({ productId: 'p', salePriceTzs: 1, startsAt: 'x', endsAt: '2026-11-02T00:00:00Z' }, { create: true }), { error: 'invalid_date', status: 400, field: 'startsAt' });
  assert.deepEqual(parseSaleInput({ productId: 'p', salePriceTzs: 1, startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-02T00:00:00Z', vendorId: 'v' }, { create: true }), { error: 'unknown_field', status: 400, fields: ['vendorId'] });
  assert.equal(parseSaleInput({ productId: 'p' }, { create: false }).error, 'product_not_editable');
  assert.deepEqual(parseSaleInput({ salePriceTzs: 5 }, { create: true }), { error: 'missing_field', status: 400, fields: ['productId', 'startsAt', 'endsAt'] });
  const start = '2026-11-20T10:00:00.000Z';
  const raise = at => ({ field: 'priceTzs', fromTzs: 80_000, toTzs: 85_000, at });
  assert.equal(priceRaiseError([], start), null);
  assert.equal(priceRaiseError([{ field: 'priceTzs', fromTzs: 90_000, toTzs: 85_000, at: '2026-11-19T00:00:00Z' }], start), null, 'a cut is not a raise');
  assert.equal(priceRaiseError([{ field: 'discountPriceTzs', fromTzs: 70_000, toTzs: 80_000, at: '2026-11-19T00:00:00Z' }], start), null, 'discount changes are not priceTzs raises');
  assert.equal(priceRaiseError([{ field: 'priceTzs', fromTzs: null, toTzs: 85_000, at: '2026-11-19T00:00:00Z' }], start), null, 'the first price is not a raise');
  assert.equal(priceRaiseError([raise('2026-11-06T10:00:00.000Z')], start), null, 'exactly 14 days before the start is allowed');
  const r = priceRaiseError([raise('2026-11-06T10:00:00.001Z')], start);
  assert.deepEqual([r.error, r.status, r.raisedAt, r.raisedOn, r.earliestStart], ['price_raised_recently', 422, '2026-11-06T10:00:00.001Z', '2026-11-06', '2026-11-20T10:00:00.001Z']);
});

// ── Create: every rule ───────────────────────────────────────────────────────

test('create: discount, effective price, length, lead time, ownership and eligibility rules', async () => {
  const h = harness();
  const v = await vendorUser();
  const p = await product(v, { priceTzs: 85_000, discountPriceTzs: 79_000 });
  const body = (extra = {}) => ({ productId: p, salePriceTzs: 69_000, startsAt: h.at(2 * HOUR), endsAt: h.at(2 * HOUR + DAY), ...extra });
  const mk = (extra, actor = v, scope = vendorScope(v)) => h.svc.create({ scope, actorId: actor, body: body(extra) });

  const fourPct = await mk({ salePriceTzs: 81_600 });
  assert.deepEqual([fourPct.error, fourPct.status, fourPct.reason, fourPct.maxSalePriceTzs, fourPct.minDiscountPct], ['discount_out_of_range', 422, 'below_minimum', 80_750, 5]);
  const notBelow = await mk({ salePriceTzs: 79_000 });
  assert.deepEqual([notBelow.error, notBelow.reason, notBelow.effectivePriceTzs, notBelow.discountPriceTzs], ['discount_out_of_range', 'not_below_effective', 79_000, 79_000]);
  assert.equal((await mk({ startsAt: h.at(2 * HOUR), endsAt: h.at(2 * HOUR + 30 * 60_000) })).error, 'sale_length_out_of_range');
  assert.equal((await mk({ startsAt: h.at(2 * HOUR), endsAt: h.at(2 * HOUR + 8 * DAY) })).error, 'sale_length_out_of_range');
  assert.equal((await mk({ startsAt: h.at(2 * HOUR), endsAt: h.at(2 * HOUR) })).error, 'end_before_start');
  const soon = await mk({ startsAt: h.at(30 * 60_000), endsAt: h.at(30 * 60_000 + DAY) });
  assert.deepEqual([soon.error, soon.earliestStart], ['start_too_soon', h.at(HOUR)]);
  // Another vendor's product; a product not on sale.
  const other = await vendorUser();
  assert.deepEqual(await h.svc.create({ scope: vendorScope(other), actorId: other, body: body() }), { error: 'not_your_product', status: 403, productId: p });
  const hidden = await product(v, { visibility: 'hidden' });
  assert.deepEqual((await mk({ productId: hidden })).reason, 'product_hidden');
  const pending = await product(v, { approvalStatus: 'pending' });
  assert.equal((await mk({ productId: pending })).reason, 'product_not_approved');
  // Out of stock is allowed (it just won't show until stock comes back).
  const empty = await product(v, { stock: 0 });
  assert.ok((await mk({ productId: empty, salePriceTzs: 50_000 })).sale);

  // No maximum: 90 % off and TSh 1 are accepted. Exactly 1 h and exactly 7 days are accepted.
  const p2 = await product(v, { priceTzs: 100_000 });
  const ninety = await mk({ productId: p2, salePriceTzs: 10_000, startsAt: h.at(2 * HOUR), endsAt: h.at(3 * HOUR) });
  assert.equal(ninety.sale.discountPct, 90);
  assert.equal(ninety.sale.effectiveStatus, 'draft');
  assert.deepEqual(ninety.sale.allowedActions.sort(), ['edit', 'submit', 'withdraw']);
  const p3 = await product(v, { priceTzs: 100_000 });
  assert.ok((await mk({ productId: p3, salePriceTzs: 1, startsAt: h.at(2 * HOUR), endsAt: h.at(2 * HOUR + 7 * DAY) })).sale);

  // A suspended or unapproved vendor can't propose; staff can't create for them either.
  const suspended = await vendorUser({ accountStatus: 'suspended' });
  const sp = await product(suspended);
  assert.deepEqual(await h.svc.create({ scope: vendorScope(suspended), actorId: suspended, body: body({ productId: sp, salePriceTzs: 50_000 }) }), { error: 'vendor_suspended', status: 403 });
  assert.equal((await h.svc.create({ scope: STAFF, actorId: ADMIN_X, body: body({ productId: sp, salePriceTzs: 50_000 }) })).error, 'vendor_suspended');
  const unverified = await vendorUser();
  const h2 = harness({ unverified: [unverified] });
  const up = await product(unverified);
  assert.equal((await h2.svc.create({ scope: vendorScope(unverified), actorId: unverified, body: { productId: up, salePriceTzs: 50_000, startsAt: h2.at(2 * HOUR), endsAt: h2.at(3 * HOUR) } })).error, 'vendor_not_approved');
});

test('too many open proposals: drafts + pending per vendor are capped (SHOP_FLASH_SALE_MAX_OPEN)', async () => {
  process.env.SHOP_FLASH_SALE_MAX_OPEN = '2';
  const h = harness();
  const v = await vendorUser();
  const make = async () => h.svc.create({ scope: vendorScope(v), actorId: v, body: { productId: await product(v), salePriceTzs: 80_000, startsAt: h.at(2 * HOUR), endsAt: h.at(3 * HOUR) } });
  assert.ok((await make()).sale);
  assert.ok((await make()).sale);
  assert.deepEqual(await make(), { error: 'too_many_open_proposals', status: 409, max: 2, open: 2 });
});

// ── 14-day rule (trigger-written history) ───────────────────────────────────

test('14-day rule: a priceTzs raise is logged by the database and blocks a sale starting within 14 days of it', async () => {
  const h = harness();
  const v = await vendorUser();
  const p = await product(v, { priceTzs: 80_000 });
  // Any write path: the trigger logs it.
  await db('Product').where({ id: p }).update({ priceTzs: 85_000 });
  await db('Product').where({ id: p }).update({ discountPriceTzs: 82_000 });
  const log = await db('ProductPriceChange').where({ productId: p }).orderBy('id');
  assert.deepEqual(log.map(r => [r.field, r.fromTzs, r.toTzs]), [['priceTzs', null, 80_000], ['priceTzs', 80_000, 85_000], ['discountPriceTzs', 0, 82_000]]);
  const raisedAt = new Date(log[1].at).getTime();

  const tomorrow = await h.svc.create({ scope: vendorScope(v), actorId: v, body: { productId: p, salePriceTzs: 70_000, startsAt: h.at(DAY), endsAt: h.at(2 * DAY) } });
  assert.deepEqual([tomorrow.error, tomorrow.status, tomorrow.raisedAt, tomorrow.earliestStart, tomorrow.fromTzs, tomorrow.toTzs],
    ['price_raised_recently', 422, new Date(raisedAt).toISOString(), new Date(raisedAt + 14 * DAY).toISOString(), 80_000, 85_000]);
  const check = await h.svc.priceCheck({ vendorId: v, productId: p, startsAt: h.at(DAY) });
  assert.deepEqual([check.ok, check.raisedAt, check.earliestStart, check.regularPriceTzs, check.discountPriceTzs, check.maxSalePriceTzs], [false, tomorrow.raisedAt, tomorrow.earliestStart, 85_000, 82_000, 80_750]);
  // "Start on {earliest}" gives a valid start.
  const ok = await h.svc.create({ scope: vendorScope(v), actorId: v, body: { productId: p, salePriceTzs: 70_000, startsAt: tomorrow.earliestStart, endsAt: new Date(raisedAt + 15 * DAY).toISOString() } });
  assert.ok(ok.sale, JSON.stringify(ok));
  assert.equal((await h.svc.priceCheck({ vendorId: v, productId: p, startsAt: tomorrow.earliestStart })).ok, true);
  assert.equal((await h.svc.priceCheck({ vendorId: await vendorUser(), productId: p })).error, 'not_your_product');
  // A raise backdated 13 days 23 h before a start tomorrow + 0 still blocks; 14 days + 1 ms does not.
  const q = await product(v, { priceTzs: 50_000 });
  const start = h.t.clock + 2 * HOUR;
  await db('ProductPriceChange').insert({ productId: q, field: 'priceTzs', fromTzs: 45_000, toTzs: 50_000, at: new Date(start - 14 * DAY + 1) });
  assert.equal((await h.svc.create({ scope: vendorScope(v), actorId: v, body: { productId: q, salePriceTzs: 40_000, startsAt: new Date(start).toISOString(), endsAt: new Date(start + DAY).toISOString() } })).error, 'price_raised_recently');
  const r = await product(v, { priceTzs: 50_000 });
  await db('ProductPriceChange').insert({ productId: r, field: 'priceTzs', fromTzs: 45_000, toTzs: 50_000, at: new Date(start - 14 * DAY) });
  assert.ok((await h.svc.create({ scope: vendorScope(v), actorId: v, body: { productId: r, salePriceTzs: 40_000, startsAt: new Date(start).toISOString(), endsAt: new Date(start + DAY).toISOString() } })).sale);
});

// ── One sale per product ────────────────────────────────────────────────────

test('overlap: a second sale on the same product is refused while another is scheduled or pending; back-to-back windows are fine; the database enforces it', async () => {
  const h = harness();
  const a = await approvedSale(h, { startIn: 2 * HOUR, length: DAY });
  const start = h.t.clock + 2 * HOUR;
  const body = (s, e) => ({ productId: a.productId, salePriceTzs: 70_000, startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString() });
  const clash = await h.svc.create({ scope: vendorScope(a.vendor), actorId: a.vendor, body: body(start + HOUR, start + 3 * HOUR) });
  assert.deepEqual([clash.error, clash.status, clash.saleId, clash.effectiveStatus], ['sale_overlap', 409, a.id, 'approved']);
  // [start, end) is half-open: starting exactly at the other's end is allowed.
  const next = await h.svc.create({ scope: vendorScope(a.vendor), actorId: a.vendor, body: body(start + DAY, start + 2 * DAY) });
  assert.ok(next.sale, JSON.stringify(next));
  // Pending sales count too: a third one overlapping `next` once it is sent is refused.
  await h.svc.submit({ scope: vendorScope(a.vendor), id: next.sale.id, actorId: a.vendor });
  assert.equal((await h.svc.create({ scope: STAFF, actorId: ADMIN_X, body: body(start + DAY + HOUR, start + DAY + 2 * HOUR) })).error, 'sale_overlap');
  // The database refuses two approved overlapping windows whatever the code does (SQLSTATE 23P01).
  const copy = await db('FlashSale').where({ id: a.id }).first();
  const rogue = { ...copy, editors: JSON.stringify(copy.editors), id: uid('fls'), startsAt: new Date(start + HOUR), endsAt: new Date(start + 2 * HOUR) };
  await assert.rejects(() => db('FlashSale').insert(rogue), err => err.code === '23P01');
  // Ended sales don't block.
  await h.svc.end({ id: a.id, actorId: ADMIN_X, reason: 'Stock issue' });
  await db('FlashSale').insert(rogue);
  await db('FlashSale').where({ id: rogue.id }).del();
});

test('overlap fallback trigger (where btree_gist is unavailable) raises the same 23P01', async () => {
  const h = harness();
  const a = await approvedSale(h);
  const SENTINEL = 'roll_back_the_fallback_test';
  await assert.rejects(() => db.transaction(async (trx) => {
    await trx.raw('ALTER TABLE "FlashSale" DROP CONSTRAINT flashsale_one_approved_per_product');
    await trx.raw(migration.OVERLAP_FALLBACK_SQL);
    await trx.raw('CREATE TRIGGER flash_sale_no_overlap BEFORE INSERT OR UPDATE ON "FlashSale" FOR EACH ROW EXECUTE FUNCTION fitflex_flash_sale_no_overlap()');
    const copy = await trx('FlashSale').where({ id: a.id }).first();
    const row = { ...copy, editors: JSON.stringify(copy.editors), id: uid('fls') };
    await trx.raw('SAVEPOINT s');
    await assert.rejects(() => trx('FlashSale').insert(row), err => err.code === '23P01');
    await trx.raw('ROLLBACK TO SAVEPOINT s');
    // Back-to-back is fine.
    await trx('FlashSale').insert({ ...row, startsAt: row.endsAt, endsAt: new Date(new Date(row.endsAt).getTime() + HOUR) });
    throw new Error(SENTINEL); // undo everything: the constraint is back, the trigger gone
  }), new RegExp(SENTINEL));
  const constraint = await db.raw(`SELECT 1 FROM pg_constraint WHERE conname = 'flashsale_one_approved_per_product'`);
  assert.equal(constraint.rows.length, 1, 'the exclusion constraint is back');
  const trigger = await db.raw(`SELECT 1 FROM pg_trigger WHERE tgname = 'flash_sale_no_overlap'`);
  assert.equal(trigger.rows.length, 0);
});

// ── Two-person rule, revisions, transitions ─────────────────────────────────

test('two-person rule: whoever created, edited or sent a sale cannot decide it; decisions name the revision', async () => {
  const h = harness();
  const v = await vendorUser();
  const p = await product(v);
  // Staff create (no vendor consent), X edits and sends: X can't approve; Y can.
  const created = await h.svc.create({ scope: STAFF, actorId: ADMIN_X, body: { productId: p, salePriceTzs: 80_000, startsAt: h.at(2 * HOUR), endsAt: h.at(DAY) } });
  assert.equal(created.sale.origin, 'staff');
  assert.equal(created.sale.vendorId, v);
  const editor = await user('admin');
  await h.svc.update({ scope: STAFF, id: created.sale.id, actorId: editor, body: { salePriceTzs: 75_000 } });
  await h.svc.submit({ scope: STAFF, id: created.sale.id, actorId: ADMIN_X });
  const rev = await revisionOf(created.sale.id);
  assert.equal(rev, 2);
  for (const who of [ADMIN_X, editor]) {
    assert.deepEqual(await h.svc.approve({ id: created.sale.id, actorId: who, revision: rev }), { error: 'cannot_approve_own_submission', status: 403 });
    assert.equal((await h.svc.reject({ id: created.sale.id, actorId: who, revision: rev, code: 'product' })).error, 'cannot_approve_own_submission');
  }
  assert.equal((await h.svc.approve({ id: created.sale.id, actorId: ADMIN_Y })).error, 'revision_required');
  assert.deepEqual((await h.svc.approve({ id: created.sale.id, actorId: ADMIN_Y, revision: 1 })).error, 'sale_changed');
  const detail = await h.svc.adminGet({ id: created.sale.id, viewer: { actorId: ADMIN_X, canApprove: true, canManage: true } });
  assert.equal(detail.sale.ownItem, true);
  assert.deepEqual([...detail.sale.allowedActions].sort(), ['edit', 'withdraw'], 'X may still manage it, never decide it');
  const ok = await h.svc.approve({ id: created.sale.id, actorId: ADMIN_Y, revision: rev });
  assert.equal(ok.saved.status, 'approved');
  assert.equal(ok.saved.wasPriceTzs, 100_000);
  assert.deepEqual(h.notices.map(n => [n.vendorId, n.type]), [[v, 'flash_sale_approved']], 'the vendor is told even about a FitFlex-made sale');
  // The vendor sees it read-only (no actions), with no staff ids.
  const mine = await h.svc.vendorList({ vendorId: v });
  assert.equal(mine.items.length, 1);
  assert.deepEqual(mine.items[0].allowedActions, []);
  assert.equal(mine.items[0].createdBy, undefined);
  assert.equal((await h.svc.vendorEnd({ scope: vendorScope(v), id: created.sale.id, actorId: v })).error, 'sale_not_found');
  // History has every step.
  const steps = (await h.svc.adminGet({ id: created.sale.id, viewer: { actorId: ADMIN_Y } })).history.map(r => r.action);
  assert.deepEqual(steps, ['flash_sale.created', 'flash_sale.updated', 'flash_sale.submitted', 'flash_sale.approved']);
});

test('vendor flow: drafts are private; edits move the state; withdraw, end early, reject → edit → resend', async () => {
  const h = harness();
  const s = await pendingSale(h);
  // A vendor's draft never reaches admins.
  const draft = await h.svc.create({ scope: vendorScope(s.vendor), actorId: s.vendor, body: { productId: await product(s.vendor), salePriceTzs: 80_000, startsAt: h.at(2 * HOUR), endsAt: h.at(DAY) } });
  assert.equal((await h.svc.adminGet({ id: draft.sale.id, viewer: {} })).error, 'sale_not_found');
  assert.ok(!(await h.svc.adminList({ query: {}, viewer: {} })).items.some(i => i.id === draft.sale.id));
  // Pending edit stays pending; the vendor is a contributor already.
  const edited = await h.svc.update({ scope: vendorScope(s.vendor), id: s.id, actorId: s.vendor, body: { salePriceTzs: 78_000 } });
  assert.equal(edited.sale.effectiveStatus, 'pending_approval');
  // Reject (code + note), edit → draft, resend, approve.
  assert.equal((await h.svc.reject({ id: s.id, actorId: ADMIN_Y, revision: await revisionOf(s.id), code: 'other' })).error, 'note_required');
  assert.equal((await h.svc.reject({ id: s.id, actorId: ADMIN_Y, revision: await revisionOf(s.id), code: 'nope' })).error, 'invalid_reason_code');
  const rej = await h.svc.reject({ id: s.id, actorId: ADMIN_Y, revision: await revisionOf(s.id), code: 'price_not_credible', note: 'Price looks inflated' });
  assert.deepEqual([rej.saved.status, rej.saved.statusReason, rej.saved.statusReasonNote], ['rejected', 'price_not_credible', 'Price looks inflated']);
  const back = await h.svc.update({ scope: vendorScope(s.vendor), id: s.id, actorId: s.vendor, body: { salePriceTzs: 70_000 } });
  assert.equal(back.sale.effectiveStatus, 'draft');
  await h.svc.submit({ scope: vendorScope(s.vendor), id: s.id, actorId: s.vendor });
  await h.svc.approve({ id: s.id, actorId: ADMIN_Y, revision: await revisionOf(s.id) });
  // Editing a scheduled sale sends it back for approval and clears the approval.
  const again = await h.svc.update({ scope: vendorScope(s.vendor), id: s.id, actorId: s.vendor, body: { salePriceTzs: 69_000 } });
  assert.deepEqual([again.sale.effectiveStatus, again.sale.wasPriceTzs, again.sale.approvedAt], ['pending_approval', null, null]);
  await h.svc.approve({ id: s.id, actorId: ADMIN_Y, revision: await revisionOf(s.id) });
  // Live: can't be edited or withdrawn; the vendor can end it early.
  h.tick(3 * HOUR);
  assert.deepEqual(await h.svc.update({ scope: vendorScope(s.vendor), id: s.id, actorId: s.vendor, body: { salePriceTzs: 60_000 } }), { error: 'not_editable', status: 409, currentStatus: 'live' });
  assert.deepEqual(await h.svc.withdraw({ scope: vendorScope(s.vendor), id: s.id, actorId: s.vendor }), { error: 'invalid_transition', status: 409, from: 'live', to: 'withdrawn', hint: 'end' });
  const ended = await h.svc.vendorEnd({ scope: vendorScope(s.vendor), id: s.id, actorId: s.vendor });
  assert.deepEqual([ended.saved.status, ended.saved.statusReason], ['ended', 'ended_by_vendor']);
  // Another vendor sees nothing of it.
  assert.equal((await h.svc.vendorGet({ vendorId: await vendorUser(), id: s.id })).error, 'sale_not_found');
});

test('expiry: undecided proposals expire after 14 days or at their start, whichever is first; the job writes it down and tells the vendor', async () => {
  const h = harness();
  const late = await pendingSale(h, { startIn: 20 * DAY, length: DAY });
  const early = await pendingSale(h, { startIn: 3 * HOUR, length: DAY });
  h.tick(3 * HOUR);
  assert.equal((await h.svc.vendorGet({ vendorId: early.vendor, id: early.id })).sale.effectiveStatus, 'expired');
  assert.equal((await h.svc.approve({ id: early.id, actorId: ADMIN_Y, revision: await revisionOf(early.id) })).error, 'proposal_expired');
  h.tick(14 * DAY);
  assert.equal((await h.svc.vendorGet({ vendorId: late.vendor, id: late.id })).sale.effectiveStatus, 'expired');
  const run = await h.svc.runLifecycle();
  assert.ok(run.expired >= 2);
  const [a, b] = await Promise.all([db('FlashSale').where({ id: early.id }).first(), db('FlashSale').where({ id: late.id }).first()]);
  assert.deepEqual([a.status, a.statusReason, b.status, b.statusReason], ['expired', 'start_passed', 'expired', 'not_reviewed_in_time']);
  assert.deepEqual(h.notices.filter(n => [early.vendor, late.vendor].includes(n.vendorId)).map(n => n.type), ['flash_sale_expired', 'flash_sale_expired']);
  assert.equal((await h.svc.runLifecycle()).expired, 0, 'idempotent');
});

// ── Price lock ──────────────────────────────────────────────────────────────

test('price lock: while a sale is scheduled or live the product price and discount cannot change (409 sale_conflict); other fields can', async () => {
  const h = harness();
  const a = await approvedSale(h);
  const edit = body => h.shop.upsertProduct({ vendorId: a.vendor, productId: a.productId, body });
  for (const body of [{ priceTzs: 120_000 }, { priceTzs: 79_000 }, { discountPriceTzs: 90_000 }]) {
    const out = await edit(body);
    assert.deepEqual([out.error, out.status, out.reason, out.saleId, out.effectiveStatus], ['sale_conflict', 409, 'price_locked_by_flash_sale', a.id, 'approved'], JSON.stringify(body));
  }
  // The whole form with the same prices (old app builds) saves; stock moves.
  const same = await edit({ priceTzs: 100_000, discountPriceTzs: 0, stock: 7 });
  assert.equal(same.error, undefined, JSON.stringify(same));
  assert.equal((await productRow(a.productId)).stock, 7);
  const listed = await h.shop.vendorListProducts(a.vendor);
  assert.deepEqual(listed.find(p => p.id === a.productId).priceLock, { saleId: a.id, startsAt: a.sale.startsAt, endsAt: a.sale.endsAt, effectiveStatus: 'approved' });
  h.tick(3 * HOUR);
  assert.equal((await edit({ priceTzs: 50_000 })).effectiveStatus, 'live');
  // Ended: unlocked. Flag off: no lock, no priceLock field.
  h.tick(DAY);
  assert.equal((await edit({ priceTzs: 99_000 })).error, undefined);
  const b = await approvedSale(h);
  h.t.flag = false;
  assert.equal((await h.shop.upsertProduct({ vendorId: b.vendor, productId: b.productId, body: { priceTzs: 101_000 } })).error, undefined);
  assert.equal((await h.shop.vendorListProducts(b.vendor)).find(p => p.id === b.productId).priceLock, undefined);
});

test('approval vs price edit race: never an approved sale over a changed price (product lock + submit snapshot)', async () => {
  const h = harness();
  for (let i = 0; i < 6; i += 1) {
    const s = await pendingSale(h);
    const rev = await revisionOf(s.id);
    const [approved, edited] = await Promise.all([
      h.svc.approve({ id: s.id, actorId: ADMIN_Y, revision: rev }),
      h.shop.upsertProduct({ vendorId: s.vendor, productId: s.productId, body: { priceTzs: 130_000 } }),
    ]);
    const price = (await productRow(s.productId)).priceTzs;
    if (approved.saved) {
      assert.equal(edited.error, 'sale_conflict', 'the edit came second and was refused');
      assert.equal(price, 100_000);
      assert.equal(approved.saved.wasPriceTzs, 100_000);
    } else {
      assert.equal(edited.error, undefined);
      assert.equal(price, 130_000);
      assert.deepEqual([approved.error, approved.reason], ['sale_changed', 'product_price_changed']);
    }
  }
});

// ── Buyer prices: lists, product, boundaries, gates ─────────────────────────

test('buyer prices at the window boundaries (ms): list, product page, filters, sorts and promotions', async () => {
  const h = harness();
  const a = await approvedSale(h, { salePriceTzs: 69_000, productExtra: { priceTzs: 85_000, discountPriceTzs: 79_000, category: 'flash_cat_' + randomUUID().slice(0, 6) } });
  const cat = (await productRow(a.productId)).category;
  const start = new Date(a.sale.startsAt).getTime();
  const end = new Date(a.sale.endsAt).getTime();
  const row = async () => (await h.shop.listProducts({ category: cat })).find(p => p.id === a.productId);
  h.t.clock = start - 1;
  assert.deepEqual([(await row()).effectivePriceTzs, (await row()).sale], [79_000, undefined], 'scheduled: invisible to buyers');
  h.t.clock = start;
  const live = await row();
  assert.equal(live.effectivePriceTzs, 69_000);
  assert.deepEqual(live.sale, { id: a.id, salePriceTzs: 69_000, wasPriceTzs: 85_000, regularPriceTzs: 85_000, discountPct: 18, startsAt: a.sale.startsAt, endsAt: a.sale.endsAt });
  assert.deepEqual([live.priceTzs, live.discountPriceTzs], [85_000, 79_000], 'stored prices are left as they are');
  assert.equal((await h.shop.getProduct(a.productId)).sale.salePriceTzs, 69_000);
  assert.equal((await h.shop.listProducts({ category: cat, maxPrice: 70_000 })).length, 1, 'maxPrice uses the sale price');
  assert.equal((await h.shop.listProducts({ category: cat, flashSale: 'true' })).length, 1);
  assert.equal((await h.shop.listProducts({ category: cat, promotions: 'true' })).length, 1);
  h.t.clock = end - 1;
  assert.equal((await row()).effectivePriceTzs, 69_000);
  h.t.clock = end;
  assert.deepEqual([(await row()).effectivePriceTzs, (await row()).sale], [79_000, undefined]);
  assert.equal((await h.shop.listProducts({ category: cat, maxPrice: 70_000 })).length, 0);
  assert.equal((await h.shop.listProducts({ category: cat, flashSale: 'true' })).length, 0);
  assert.equal((await h.shop.getProduct(a.productId)).sale, undefined);
});

test('hidden, paused or deleted products and suspended vendors never get a sale price (not listed, not sold)', async () => {
  const h = harness();
  const a = await approvedSale(h);
  h.tick(3 * HOUR);
  const buyer = await user('member');
  assert.ok((await h.shop.getProduct(a.productId)).sale);
  await db('Product').where({ id: a.productId }).update({ visibility: 'hidden' });
  assert.equal(await h.shop.getProduct(a.productId), null);
  assert.equal((await order(h, buyer, [{ productId: a.productId, qty: 1 }])).error, 'product_not_found');
  await db('Product').where({ id: a.productId }).update({ visibility: 'visible', status: 'paused' });
  assert.equal(await h.shop.getProduct(a.productId), null);
  await db('Product').where({ id: a.productId }).update({ status: 'active' });
  await db('User').where({ id: a.vendor }).update({ accountStatus: 'suspended' });
  assert.ok(!(await h.shop.listProducts({ vendorId: a.vendor })).length);
  assert.equal((await order(h, buyer, [{ productId: a.productId, qty: 1 }])).error, 'vendor_unavailable');
  await db('User').where({ id: a.vendor }).update({ accountStatus: 'active' });
  // Admin-only "unlisted" reads never carry a sale.
  assert.equal((await h.shop.getProduct(a.productId, { includeUnlisted: true })).sale, undefined);
});

// ── Checkout ────────────────────────────────────────────────────────────────

test('checkout during a sale: the line is the sale price, commission is on it, and the vendor\'s share follows; old clients unaffected', async () => {
  const h = harness();
  const a = await approvedSale(h, { salePriceTzs: 69_000, productExtra: { priceTzs: 85_000 } });
  await db('User').where({ id: a.vendor }).update({ vendorProfile: JSON.stringify({ businessName: 'Rate Shop', status: 'published', commissionPct: 12 }) });
  h.tick(3 * HOUR);
  const buyer = await user('member');
  const out = await order(h, buyer, [{ productId: a.productId, qty: 2 }]);
  assert.equal(out.status, 202, JSON.stringify(out));
  const [line] = out.order.items;
  assert.deepEqual([line.priceTzs, line.flashSaleId, line.commissionPct], [69_000, a.id, 12]);
  assert.deepEqual({ commissionTzs: line.commissionTzs, vendorPayoutTzs: line.vendorPayoutTzs }, (({ commissionTzs, vendorPayoutTzs }) => ({ commissionTzs, vendorPayoutTzs }))(priceOrderLine({ priceTzs: 69_000, qty: 2, commissionPct: 12 })));
  assert.equal(out.order.totalTzs, 138_000);
  assert.equal(out.paymentRequest.amountTzs, 138_000);
  assert.deepEqual(vendorShareOfOrder(out.order, a.vendor), { itemCount: 2, salesTzs: 138_000, commissionTzs: 16_560, payoutTzs: 121_440 });
});

test('expectedPriceTzs: a mismatch is 409 price_changed with every changed line, reasons and both totals; nothing is reserved', async () => {
  const h = harness();
  const a = await approvedSale(h, { salePriceTzs: 69_000, productExtra: { priceTzs: 85_000 } });
  const v2 = await vendorUser();
  const plain = await product(v2, { priceTzs: 10_000 });
  const buyer = await user('member');
  h.tick(3 * HOUR);
  // The app still showed the regular price: the sale started.
  const started = await order(h, buyer, [{ productId: a.productId, qty: 2, expectedPriceTzs: 85_000 }, { productId: plain, qty: 1, expectedPriceTzs: 10_000 }]);
  assert.deepEqual(started, {
    error: 'price_changed', status: 409, productId: a.productId, currentPriceTzs: 69_000,
    lines: [{ productId: a.productId, variant: null, expectedPriceTzs: 85_000, currentPriceTzs: 69_000, reason: 'sale_started' }],
    expectedTotalTzs: 180_000, totalTzs: 148_000,
  });
  assert.equal((await productRow(a.productId)).stock, 10, 'nothing reserved');
  // Matching expected prices place the order.
  assert.equal((await order(h, buyer, [{ productId: a.productId, qty: 1, expectedPriceTzs: 69_000 }])).status, 202);
  // After the sale: the app had the sale price → sale_ended.
  h.tick(DAY);
  const ended = await order(h, buyer, [{ productId: a.productId, qty: 1, expectedPriceTzs: 69_000 }]);
  assert.deepEqual([ended.error, ended.lines[0].reason, ended.currentPriceTzs], ['price_changed', 'sale_ended', 85_000]);
  // Any other difference → price_changed.
  assert.equal((await order(h, buyer, [{ productId: plain, qty: 1, expectedPriceTzs: 9_000 }])).lines[0].reason, 'price_changed');
  // Bad values → 400; two lines of the same product disagreeing → 409.
  for (const bad of [-1, 1.5, 'abc']) assert.deepEqual(await order(h, buyer, [{ productId: plain, qty: 1, expectedPriceTzs: bad }]), { error: 'invalid_expected_price', status: 400, productId: plain });
  const split = await order(h, buyer, [{ productId: plain, qty: 1, expectedPriceTzs: 10_000 }, { productId: plain, qty: 1, expectedPriceTzs: 9_000 }]);
  assert.deepEqual([split.error, split.lines[0].expectedPriceTzs], ['price_changed', null]);
  // Old clients send nothing and are charged the server price.
  assert.equal((await order(h, await user('member'), [{ productId: plain, qty: 1 }])).order.totalTzs, 10_000);
});

test('lock race: the window closes, a sale starts, or staff end it between pricing and the stock lock → 409 price_changed, nothing reserved', async () => {
  const h = harness();
  const buyer = await user('member');
  // (1) Priced inside the window; by the lock the window has closed (1 ms later).
  const a = await approvedSale(h, { salePriceTzs: 69_000, productExtra: { priceTzs: 85_000 } });
  const end = new Date(a.sale.endsAt).getTime();
  h.t.clock = end - 1;
  h.t.storeClock = end;
  const closed = await order(h, buyer, [{ productId: a.productId, qty: 1 }]);
  assert.deepEqual([closed.error, closed.status, closed.productId], ['price_changed', 409, a.productId]);
  assert.equal((await productRow(a.productId)).stock, 10);
  assert.equal(await db('ShopOrder').where({ buyerId: buyer }).first(), undefined);
  h.t.storeClock = null;

  // (2) Priced 1 ms before a sale starts; by the lock it has started.
  const b = await approvedSale(h, { salePriceTzs: 69_000, productExtra: { priceTzs: 85_000 } });
  const start = new Date(b.sale.startsAt).getTime();
  h.t.clock = start - 1;
  h.t.storeClock = start;
  assert.equal((await order(h, buyer, [{ productId: b.productId, qty: 1 }])).error, 'price_changed');
  h.t.storeClock = null;

  // (3) Staff end a live sale between pricing and the lock.
  h.t.clock = start + HOUR;
  h.t.beforeLock = async () => { await h.svc.end({ id: b.id, actorId: ADMIN_X, reason: 'Seller asked' }); };
  const stopped = await order(h, buyer, [{ productId: b.productId, qty: 1, expectedPriceTzs: 69_000 }]);
  h.t.beforeLock = null;
  assert.deepEqual([stopped.error, stopped.currentPriceTzs, stopped.lines[0].reason], ['price_changed', 85_000, 'sale_ended']);
  assert.equal((await productRow(b.productId)).stock, 10);
  // A retry at the new price goes through.
  const retry = await order(h, buyer, [{ productId: b.productId, qty: 1, expectedPriceTzs: 85_000 }]);
  assert.equal(retry.order.items[0].priceTzs, 85_000);
  assert.equal(retry.order.items[0].flashSaleId, undefined);
});

test('once placed, the price is fixed: paid after the sale ended, the order keeps the sale price', async () => {
  const h = harness();
  const a = await approvedSale(h, { salePriceTzs: 69_000, productExtra: { priceTzs: 85_000 } });
  h.tick(3 * HOUR);
  const out = await order(h, await user('member'), [{ productId: a.productId, qty: 1 }]);
  h.tick(DAY);
  assert.equal((await h.shop.getProduct(a.productId)).sale, undefined, 'the sale has ended');
  await h.shop.applyPaymentToOrder(out.order.id, 'approved');
  const stored = await db('ShopOrder').where({ id: out.order.id }).first();
  assert.equal(stored.paymentStatus, 'paid');
  assert.deepEqual([stored.totalTzs, stored.items[0].priceTzs, stored.items[0].flashSaleId], [69_000, 69_000, a.id]);
});

test('flag off: no sale price anywhere, expectedPriceTzs ignored, order lines exactly as before', async () => {
  const h = harness();
  const a = await approvedSale(h, { salePriceTzs: 69_000, productExtra: { priceTzs: 85_000, discountPriceTzs: 80_000 } });
  h.tick(3 * HOUR);
  h.t.flag = false;
  const r = (await h.shop.listProducts({ vendorId: a.vendor }))[0];
  assert.equal('effectivePriceTzs' in r, false);
  assert.equal('sale' in r, false);
  assert.equal('sale' in (await h.shop.getProduct(a.productId)), false);
  assert.equal((await h.shop.listProducts({ vendorId: a.vendor, flashSale: 'true' })).length, 1, 'the flashSale filter does not exist with the flag off');
  const out = await order(h, await user('member'), [{ productId: a.productId, qty: 1, expectedPriceTzs: 1 }]);
  assert.deepEqual(Object.keys(out.order.items[0]).sort(), ['commissionPct', 'commissionTzs', 'image', 'name', 'priceTzs', 'productId', 'qty', 'vendorId', 'vendorPayoutTzs']);
  assert.equal(out.order.items[0].priceTzs, 80_000);
});

// ── Notifications ───────────────────────────────────────────────────────────

test('vendor notices: approved, rejected, expired, ended by FitFlex — in the vendor\'s language, Swahili always in data', async () => {
  const sent = [];
  const notifier = createPartnerNotifier({
    users: { findByIdAsync: async () => null }, gyms: { filterAsync: async () => [] },
    preferences: { findByIdAsync: async id => (id === 'v_en' ? { locale: 'en' } : null) },
    notify: async (userId, m) => { sent.push({ userId, ...m }); },
  });
  const d = { saleId: 'fls_1', productName: 'Whey 1kg', startsAt: '2026-11-02T07:00:00Z', reason: 'Seller asked' };
  for (const kind of ['approved', 'rejected', 'expired', 'ended']) await notifier.vendorEvent('v_en', `flash_sale_${kind}`, d);
  await notifier.vendorEvent('v_sw', 'flash_sale_approved', d);
  assert.deepEqual(sent.map(s => s.type), ['vendor_flash_sale_approved', 'vendor_flash_sale_rejected', 'vendor_flash_sale_expired', 'vendor_flash_sale_ended', 'vendor_flash_sale_approved']);
  assert.equal(sent[0].body, 'Your flash sale on "Whey 1kg" is approved. It goes live 02/11/2026 10:00.');
  assert.equal(sent[4].title, 'Ofa ya muda mfupi imeidhinishwa');
  assert.equal(sent[4].body, 'Ofa yako ya muda mfupi kwa "Whey 1kg" imeidhinishwa. Itaanza 02/11/2026 10:00.');
  assert.deepEqual([sent[3].data.titleSw, sent[3].data.reason], ['Ofa ya muda mfupi imesitishwa na FitFlex', 'Seller asked']);
  for (const s of sent) {
    assert.ok(s.data.titleSw && s.data.bodySw);
    assert.deepEqual([s.data.open, s.data.tab, s.data.item], ['merch', 'sales', 'fls_1']);
  }
});

test('admin detail: price check with 30-day history, discount line, price changed since sending', async () => {
  const h = harness();
  const s = await pendingSale(h, { salePriceTzs: 80_000 });
  // The lock does not apply while pending: the vendor cuts the price; approval is refused.
  await h.shop.upsertProduct({ vendorId: s.vendor, productId: s.productId, body: { priceTzs: 95_000 } });
  const d = await h.svc.adminGet({ id: s.id, viewer: { actorId: ADMIN_Y, canApprove: true } });
  assert.equal(d.sale.priceChangedSinceSubmit, true);
  assert.deepEqual(d.priceCheck.priceHistory.map(c => [c.field, c.fromTzs, c.toTzs, c.raised]), [['priceTzs', 100_000, 95_000, false], ['priceTzs', null, 100_000, false]]);
  assert.deepEqual(d.priceCheck.discountLine, { pct: 15, savingTzs: 15_000, sellerPays: true });
  const refused = await h.svc.approve({ id: s.id, actorId: ADMIN_Y, revision: await revisionOf(s.id) });
  assert.deepEqual([refused.error, refused.reason, refused.regularPriceTzs, refused.regularPriceTzsAtSubmit], ['sale_changed', 'product_price_changed', 95_000, 100_000]);
  // Queue: requests tab, search by product name.
  const q = await h.svc.adminList({ query: { tab: 'requests', productId: s.productId }, viewer: { actorId: ADMIN_Y, canApprove: true } });
  assert.deepEqual(q.items.map(i => i.id), [s.id]);
  assert.ok(q.counts.requests >= 1);
  assert.equal((await h.svc.adminList({ query: { tab: 'nope' }, viewer: {} })).error, 'invalid_tab');
  assert.equal(SALE_RULES.priceRaiseLookbackDays, 14);
});
