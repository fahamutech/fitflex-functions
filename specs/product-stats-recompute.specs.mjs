// POST /admin/shop/product-stats/recompute — rating / reviewCount / soldCount recomputed from the records,
// against the CI database and the production wiring. The expected values come from the live paths
// themselves (reviewProduct for rating, the order store's counter for soldCount), so the recompute is
// checked to agree with how the server keeps these columns, not with a second copy of the rules.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '../src/infra/knex-store.mjs';
import { shopService, productStatsRecomputeService } from '../src/bootstrap/services.mjs';
import { ensureInit } from '../functions/index.mjs';
import { adminRecomputeProductStats } from '../functions/shop.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { PRODUCT_STATS_LOCK, PRODUCT_STATS_AUDIT_ACTION, parseProductIds } from '../src/services/product-stats-recompute-service.mjs';

await ensureInit();

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [], orders: [], audits: [] };
const recompute = (args) => productStatsRecomputeService.recompute(args);

async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Stats ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
const vendor = () => user('vendor', { createdAt: new Date('2026-01-01T00:00:00Z'), vendorProfile: JSON.stringify({ businessName: 'Stats shop', status: 'published' }) });
async function listedProduct(vendorId, body = {}) {
  const out = await shopService.upsertProduct({ vendorId, body: { name: 'Stats whey', category: 'supplements_nutrition', priceTzs: 20_000, stock: 50, ...body } });
  assert.ok(!out.error, JSON.stringify(out));
  made.products.push(out.product.id);
  await shopService.adminUpdateProductListing({ productId: out.product.id, body: { approvalStatus: 'approved' }, actorId: 'adm_stats' });
  return out.product;
}
/** A product row written straight to the table, as an old vendor-typed create left it. */
async function rawProduct(vendorId, extra = {}) {
  const id = uid('prd');
  await db('Product').insert({ id, vendorId, name: 'Typed stats', category: 'equipment', priceTzs: 15_000, stock: 7, status: 'active', approvalStatus: 'approved', updatedAt: new Date('2026-10-01T00:00:00Z'), ...extra });
  made.products.push(id);
  return id;
}
async function place(buyerId, productId, qty) {
  const out = await shopService.createOrder({ buyerId, body: { items: [{ productId, qty }], deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni', paymentMethod: 'mpesa' } });
  assert.ok(out.order, JSON.stringify(out));
  made.orders.push(out.order.id);
  return out.order;
}
const row = (id) => db('Product').where({ id }).first();
const stats = async (id) => { const r = await row(id); return { rating: Number(r.rating), reviewCount: r.reviewCount, soldCount: r.soldCount }; };
const corrupt = (id, patch = { rating: 4.8, reviewCount: 12, soldCount: 37 }) => db('Product').where({ id }).update(patch);
const remember = (result) => { if (result.runId) made.audits.push(result.runId); return result; };

after(async () => {
  await db('ProductReview').whereIn('productId', made.products).del();
  await db('MarketplaceNotification').whereIn('userId', made.users).del();
  await db('ShopStockMovement').whereIn('orderId', made.orders).del();
  await db('PaymentRequest').whereIn('orderId', made.orders).del();
  await db('Refund').whereIn('orderId', made.orders).del();
  await db('AuditLog').whereIn('target', [...made.orders, ...made.products]).del();
  await db('AuditLog').whereIn('id', made.audits).del();
  await db('ShopOrder').whereIn('id', made.orders).del();
  await db('Product').whereIn('id', made.products).del();
  await db('User').whereIn('id', made.users).del().catch(() => {});
  await db.destroy();
});

// ── the rules ────────────────────────────────────────────────────────────────

test('dry run reports vendor-typed stats and writes nothing', async () => {
  const vendorId = await vendor();
  const id = await rawProduct(vendorId, { rating: 4.8, reviewCount: 12, soldCount: 37 });
  const before = await row(id);
  const audits = await db('AuditLog').where({ action: PRODUCT_STATS_AUDIT_ACTION }).count({ n: '*' }).first();

  const out = await recompute({ productIds: [id] });
  assert.equal(out.dryRun, true);
  assert.equal(out.checked, 1);
  assert.equal(out.unchanged, 0);
  assert.deepEqual(out.changed, [{ productId: id, name: 'Typed stats', vendorId, before: { rating: 4.8, reviewCount: 12, soldCount: 37 }, after: { rating: 0, reviewCount: 0, soldCount: 0 } }]);
  assert.equal(out.appliedAt, undefined);
  assert.equal(out.runId, undefined);
  assert.deepEqual(await row(id), before, 'dry run changed the product');
  assert.deepEqual(await db('AuditLog').where({ action: PRODUCT_STATS_AUDIT_ACTION }).count({ n: '*' }).first(), audits, 'dry run wrote an audit row');
});

test('apply fixes 4.8 / 12 reviews / 37 sold with no reviews or orders to 0 / 0 / 0 and touches nothing else', async () => {
  const vendorId = await vendor();
  const id = await rawProduct(vendorId, { rating: 4.8, reviewCount: 12, soldCount: 37, discountPriceTzs: 12_000 });
  const before = await row(id);
  const out = remember(await recompute({ apply: true, productIds: [id], actorId: 'adm_x' }));
  assert.equal(out.dryRun, false);
  assert.equal(out.changed.length, 1);
  assert.ok(out.runId.startsWith('psr_'));
  assert.ok(!Number.isNaN(Date.parse(out.appliedAt)));
  const now = await row(id);
  assert.deepEqual(await stats(id), { rating: 0, reviewCount: 0, soldCount: 0 });
  // Price, discount, stock, updatedAt, status... all exactly as they were.
  const { rating: _a, reviewCount: _b, soldCount: _c, ...restBefore } = before;
  const { rating: _d, reviewCount: _e, soldCount: _f, ...restNow } = now;
  assert.deepEqual(restNow, restBefore);
});

test('real reviews: rating and reviewCount equal what the review path stores (plain average, 2 decimals)', async () => {
  const vendorId = await vendor();
  const product = await listedProduct(vendorId);
  for (const score of [5, 4, 4]) {
    const buyer = await user('member');
    const order = await place(buyer, product.id, 1);
    await db('ShopOrder').where({ id: order.id }).update({ status: 'delivered' });
    const review = await shopService.reviewProduct({ buyerId: buyer, orderId: order.id, productId: product.id, rating: score });
    assert.equal(review.status, 201, JSON.stringify(review));
  }
  const live = await stats(product.id);
  assert.deepEqual(live, { rating: 4.33, reviewCount: 3, soldCount: 3 });

  const fresh = await recompute({ productIds: [product.id] });
  assert.equal(fresh.changed.length, 0, 'stats kept by the live paths must already agree');
  assert.equal(fresh.unchanged, 1);

  await corrupt(product.id, { rating: 1, reviewCount: 9 });
  const out = remember(await recompute({ apply: true, productIds: [product.id], actorId: 'adm_x' }));
  assert.deepEqual(out.changed[0].after, live);
  assert.deepEqual(await stats(product.id), live);
});

test('a half-way average rounds as Postgres stores the review path\'s value (4.125 → 4.13)', async () => {
  const vendorId = await vendor();
  const id = await rawProduct(vendorId);
  // 8 reviews averaging 4.125 (written straight, as many buyers would have).
  const scores = [5, 5, 4, 4, 4, 4, 4, 3];
  await db('ProductReview').insert(scores.map((rating, i) => ({ id: uid('rev'), buyerId: `b${i}`, orderId: `o${i}`, productId: id, rating, createdAt: new Date() })));
  const out = remember(await recompute({ apply: true, productIds: [id], actorId: 'adm_x' }));
  assert.deepEqual(out.changed[0].after, { rating: 4.13, reviewCount: 8, soldCount: 0 });
  // What the review path's own write (sum / count, unrounded) leaves stored:
  await db('Product').where({ id }).update({ rating: scores.reduce((s, r) => s + r, 0) / scores.length });
  assert.equal(Number((await row(id)).rating), 4.13);
  assert.equal((await recompute({ productIds: [id] })).changed.length, 0);
});

test('soldCount matches the live counter: reserved orders count paid or unpaid, delivered too; cancelled ones do not', async () => {
  const vendorId = await vendor();
  const product = await listedProduct(vendorId);
  const a = await place(await user('member'), product.id, 2); // stays unpaid, still holds stock
  const b = await place(await user('member'), product.id, 3);
  const cancelBuyer = await user('member');
  const c = await place(cancelBuyer, product.id, 4);
  await db('ShopOrder').where({ id: b.id }).update({ status: 'delivered', paymentStatus: 'paid' });
  const cancelled = await shopService.buyerCancelOrder({ buyerId: cancelBuyer, orderId: c.id });
  assert.equal(cancelled.order.status, 'cancelled', JSON.stringify(cancelled));
  assert.ok(a && b);

  const live = await stats(product.id);
  assert.equal(live.soldCount, 5, 'the live counter: +2 +3 +4 −4');
  assert.equal((await recompute({ productIds: [product.id] })).changed.length, 0, 'recompute agrees with the live counter');

  await corrupt(product.id, { soldCount: 999 });
  const out = remember(await recompute({ apply: true, productIds: [product.id], actorId: 'adm_x' }));
  assert.equal(out.changed[0].after.soldCount, 5);
  assert.equal((await stats(product.id)).soldCount, 5);
  assert.equal((await row(product.id)).stock, 50 - 5, 'stock untouched');
});

test('subset: only the named products are checked and written', async () => {
  const vendorId = await vendor();
  const one = await rawProduct(vendorId, { rating: 3.5, reviewCount: 2, soldCount: 4 });
  const two = await rawProduct(vendorId, { rating: 4.9, reviewCount: 40, soldCount: 100 });
  const out = remember(await recompute({ apply: true, productIds: [one, one, 'prd_does_not_exist'], actorId: 'adm_x' }));
  assert.equal(out.checked, 1);
  assert.deepEqual(out.changed.map(c => c.productId), [one]);
  assert.deepEqual(await stats(one), { rating: 0, reviewCount: 0, soldCount: 0 });
  assert.deepEqual(await stats(two), { rating: 4.9, reviewCount: 40, soldCount: 100 }, 'a product outside the subset was written');
});

test('without a subset every product is checked (dry run)', async () => {
  const vendorId = await vendor();
  const id = await rawProduct(vendorId, { rating: 2.5, reviewCount: 1, soldCount: 1 });
  const out = await recompute({});
  const [{ n }] = await db('Product').count({ n: '*' });
  assert.equal(out.checked, Number(n));
  assert.equal(out.checked, out.changed.length + out.unchanged);
  assert.ok(out.changed.some(c => c.productId === id));
});

test('idempotent: a second apply changes nothing', async () => {
  const vendorId = await vendor();
  const id = await rawProduct(vendorId, { rating: 4.8, reviewCount: 12, soldCount: 37 });
  const first = remember(await recompute({ apply: true, productIds: [id], actorId: 'adm_x' }));
  assert.equal(first.changed.length, 1);
  const updatedAt = (await row(id)).updatedAt;
  const second = remember(await recompute({ apply: true, productIds: [id], actorId: 'adm_x' }));
  assert.equal(second.changed.length, 0);
  assert.equal(second.unchanged, 1);
  assert.deepEqual((await row(id)).updatedAt, updatedAt);
});

test('apply writes one audit row: actor, counts and every before/after', async () => {
  const vendorId = await vendor();
  const id = await rawProduct(vendorId, { rating: 4.8, reviewCount: 12, soldCount: 37 });
  const ok = await rawProduct(vendorId);
  const out = remember(await recompute({ apply: true, productIds: [id, ok], actorId: 'adm_auditor' }));
  const audit = await db('AuditLog').where({ id: out.runId }).first();
  assert.equal(audit.actor, 'adm_auditor');
  assert.equal(audit.action, PRODUCT_STATS_AUDIT_ACTION);
  assert.equal(audit.target, 'products:2');
  assert.deepEqual(audit.before, [{ productId: id, rating: 4.8, reviewCount: 12, soldCount: 37 }]);
  assert.deepEqual(audit.after, { checked: 2, changed: 1, unchanged: 1, productIds: [id, ok], products: [{ productId: id, rating: 0, reviewCount: 0, soldCount: 0 }] });
  assert.equal(new Date(audit.at).toISOString(), out.appliedAt);
});

test('a second apply while one holds the lock is refused and writes nothing', async () => {
  const vendorId = await vendor();
  const id = await rawProduct(vendorId, { rating: 4.8, reviewCount: 12, soldCount: 37 });
  const trx = await db.transaction();
  try {
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [PRODUCT_STATS_LOCK]);
    const refused = await recompute({ apply: true, productIds: [id], actorId: 'adm_x' });
    assert.deepEqual(refused, { error: 'recompute_in_progress', status: 409 });
    assert.equal((await stats(id)).reviewCount, 12);
    // A dry run is read-only and still answers.
    assert.equal((await recompute({ productIds: [id] })).changed.length, 1);
  } finally {
    await trx.rollback();
  }
  remember(await recompute({ apply: true, productIds: [id], actorId: 'adm_x' }));
  assert.equal((await stats(id)).reviewCount, 0);
});

test('productIds validation', () => {
  assert.deepEqual(parseProductIds(undefined), { ids: null });
  assert.deepEqual(parseProductIds(['a', ' a ', 'b']), { ids: ['a', 'b'] });
  for (const bad of ['a', [], [1], [''], [null], {}]) assert.equal(parseProductIds(bad).error, 'invalid_product_ids', JSON.stringify(bad));
  assert.equal(parseProductIds(Array.from({ length: 1001 }, (_, i) => `p${i}`)).error, 'too_many_product_ids');
});

// ── the route ────────────────────────────────────────────────────────────────

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(claims, body = {}) {
  const req = { method: 'POST', headers: { authorization: `Bearer ${sign(claims)}` }, params: {}, query: {}, body, get: () => null };
  const out = res();
  for (const guard of [adminRecomputeProductStats.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await adminRecomputeProductStats.onRequest(req, out);
  return out;
}

test('route: admins with scope shop (and super-admins) may run it; vendors, members and other scopes get 403', async () => {
  const vendorId = await vendor();
  const id = await rawProduct(vendorId, { rating: 4.8, reviewCount: 12, soldCount: 37 });

  for (const claims of [{ sub: vendorId, userType: 'vendor' }, { sub: 'usr_m', userType: 'member' }, { sub: 'usr_s', userType: 'vendor_staff', vendorId }, { sub: 'usr_o', userType: 'gym_operator' }]) {
    const out = await call(claims, { apply: true, productIds: [id] });
    assert.equal(out.statusCode, 403, `${claims.userType}: ${JSON.stringify(out.body)}`);
  }
  const otherScope = await call({ sub: 'adm_pay', userType: 'admin', portalUser: true, aclPermissions: ['payments'] }, { apply: true, productIds: [id] });
  assert.equal(otherScope.statusCode, 403);
  assert.equal(otherScope.body.requiredScope, 'shop');
  assert.equal((await stats(id)).reviewCount, 12, 'a refused call wrote');

  const dry = await call({ sub: 'adm_shop', userType: 'admin', portalUser: true, aclPermissions: ['shop'] }, { productIds: [id] });
  assert.equal(dry.statusCode, 200);
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.changed[0].productId, id);

  const applied = await call({ sub: 'adm_super', userType: 'admin' }, { apply: true, productIds: [id] });
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.body));
  remember(applied.body);
  assert.equal(applied.body.dryRun, false);
  assert.equal((await db('AuditLog').where({ id: applied.body.runId }).first()).actor, 'adm_super', 'actor comes from the token');
  assert.deepEqual(await stats(id), { rating: 0, reviewCount: 0, soldCount: 0 });

  const noToken = res();
  await [adminRecomputeProductStats.onGuard].flat()[0]({ method: 'POST', headers: {}, body: {} }, noToken, () => assert.fail('no token passed'));
  assert.equal(noToken.statusCode, 401);
});

test('route: a non-boolean apply or bad productIds is a 400 and writes nothing', async () => {
  const vendorId = await vendor();
  const id = await rawProduct(vendorId, { rating: 4.8, reviewCount: 12, soldCount: 37 });
  const admin = { sub: 'adm_super', userType: 'admin' };
  assert.deepEqual([(await call(admin, { apply: 'yes', productIds: [id] })).statusCode, (await call(admin, { apply: 'yes' })).body], [400, { error: 'invalid_apply' }]);
  const bad = await call(admin, { apply: true, productIds: id });
  assert.deepEqual([bad.statusCode, bad.body], [400, { error: 'invalid_product_ids' }]);
  assert.equal((await stats(id)).reviewCount, 12);
});

// ── the CLI (npm run shop:recompute-stats) ───────────────────────────────────

const cli = (...args) => promisify(execFile)(process.execPath, ['scripts/shop-recompute-stats.mjs', ...args], { env: process.env });

test('CLI: dry run prints the table and writes nothing; --apply writes through the same service', async () => {
  const vendorId = await vendor();
  const id = await rawProduct(vendorId, { rating: 4.8, reviewCount: 12, soldCount: 37 });
  const dry = await cli('--product', id);
  assert.match(dry.stdout, /\(dry run\)/);
  assert.match(dry.stdout, new RegExp(id));
  assert.match(dry.stdout, /4\.8 \/ 12 \/ 37/);
  assert.match(dry.stdout, /checked 1, would change 1, unchanged 0/);
  assert.equal((await stats(id)).reviewCount, 12);

  const applied = await cli('--apply', `--product=${id}`);
  const runId = applied.stdout.match(/audit (psr_[0-9a-f-]+)/)?.[1];
  assert.ok(runId, applied.stdout);
  made.audits.push(runId);
  assert.equal((await db('AuditLog').where({ id: runId }).first()).actor.startsWith('cli'), true);
  assert.deepEqual(await stats(id), { rating: 0, reviewCount: 0, soldCount: 0 });

  await assert.rejects(cli('--bogus'), (err) => err.code === 2 && /Unknown argument/.test(err.stderr));
});
