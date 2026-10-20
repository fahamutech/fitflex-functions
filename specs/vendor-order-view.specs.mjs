// Vendor tools · S2 — what a vendor sees of a marketplace order (plan §3, A-02), GET /vendor/me, today's
// sales in EAT (Q-3) and the sign-in answer for disabled vendor staff (Q-2).
// Pure view and window rules first; then the routes as bfast-function mounts them, against the CI database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import * as shopFunctions from '../functions/shop.mjs';
import { pinLogin } from '../functions/pin-auth.mjs';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';
import { products, shopOrders, users, auditLog, paymentRequests } from '../src/bootstrap/collections.mjs';
import { pinAuthService } from '../src/bootstrap/services.mjs';
import { createShopService } from '../src/services/shop-service.mjs';
import { createPgShopOrderStore } from '../src/infra/shop-order-store-pg.mjs';
import { createPgVendorBuyerRefStore } from '../src/infra/vendor-buyer-ref-store-pg.mjs';
import { contactWindow, vendorOrderView, eatDate, shortRef, orderTab, countOrders } from '../src/shared/vendor-order-view.mjs';

await ensureInit();

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const express = createRequire(path.join(root, 'package.json'))('express');
const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], products: [], orders: [], gyms: [] };

// The exact keys a vendor's order carries (optional ones checked separately).
const ORDER_KEYS = ['id', 'shortRef', 'createdAt', 'status', 'orderStatus', 'nextStatuses', 'timeline', 'items', 'totalTzs',
  'paymentStatus', 'paymentMethod', 'deliveryMethod', 'note', 'pickupGymId', 'pickupGym', 'buyer'];
const OPTIONAL_ORDER_KEYS = ['deliveryAddress'];
const ITEM_KEYS = ['productId', 'name', 'variant', 'qty', 'priceTzs', 'image'];
const MONEY_KEYS = ['commissionTzs', 'vendorPayoutTzs'];
const FORBIDDEN_KEYS = ['buyerId', 'buyerRole', 'email', 'paymentReference', 'fulfilments', 'idempotencyKey', 'idempotencyFingerprint',
  'stockState', 'reservationCycle', 'reservationExpiresAt', 'settlementStatus', 'vendorId', 'commissionPct', 'variantStockReserved', 'actorId', 'by'];

/** Every key anywhere in a JSON value. */
function keysDeep(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach(v => keysDeep(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysDeep(v, out); }
  return out;
}
function assertAllowlisted(order, { money = false } = {}) {
  const keys = Object.keys(order);
  for (const k of ORDER_KEYS) assert.ok(keys.includes(k), `missing ${k}`);
  assert.deepEqual(keys.filter(k => !ORDER_KEYS.includes(k) && !OPTIONAL_ORDER_KEYS.includes(k)), [], 'no other top-level keys');
  for (const item of order.items) {
    assert.deepEqual(Object.keys(item).sort(), [...ITEM_KEYS, ...(money ? MONEY_KEYS : [])].sort());
  }
  assert.deepEqual(Object.keys(order.buyer).filter(k => !['customerId', 'displayName', 'customerLinked', 'phone', 'contactVisibleUntil'].includes(k)), []);
  const deep = keysDeep(order);
  assert.deepEqual(FORBIDDEN_KEYS.filter(k => deep.has(k)), [], 'no forbidden key anywhere');
}

// ── pure: short ref, EAT day, contact window ─────────────────────────────────

test('shortRef: the last 6 characters of the id, uppercase (Q-8)', () => {
  assert.equal(shortRef('ord_3b0c8f6e'), '0C8F6E');
  assert.equal(shortRef('ord_abc'), 'RD_ABC');
  assert.equal(shortRef(null), '');
});

test('eatDate: the EAT calendar day (UTC+3)', () => {
  assert.equal(eatDate('2026-10-19T20:59:59.999Z'), '2026-10-19');
  assert.equal(eatDate('2026-10-19T21:00:00.000Z'), '2026-10-20');
  assert.equal(eatDate(null), null);
  assert.equal(eatDate('not a date'), null);
});

const deliveredOrder = (deliveredAtIso, extra = {}) => ({
  id: 'ord_window', status: 'delivered', paymentStatus: 'paid', deliveryMethod: 'home_delivery',
  items: [{ productId: 'p1', vendorId: 'v1', qty: 1, priceTzs: 1000 }],
  fulfilments: [{ vendorId: 'v1', status: 'delivered', timeline: [{ status: 'pending', at: '2026-10-01T08:00:00Z' }, { status: 'delivered', at: deliveredAtIso }], updatedAt: deliveredAtIso }],
  ...extra,
});

test('contact window: open while the vendor\'s part is open and paid (no end date yet); closed unpaid, refund pending, or cancelled', () => {
  const open = { id: 'o', status: 'accepted', paymentStatus: 'paid', items: [{ vendorId: 'v1' }], fulfilments: [{ vendorId: 'v1', status: 'dispatched', timeline: [] }] };
  assert.deepEqual(contactWindow(open, 'v1'), { open: true, until: null });
  assert.deepEqual(contactWindow({ ...open, paymentStatus: 'pending' }, 'v1'), { open: false, until: null });
  assert.deepEqual(contactWindow({ ...open, paymentStatus: 'refund_pending' }, 'v1'), { open: false, until: null });
  assert.deepEqual(contactWindow({ ...open, status: 'cancelled' }, 'v1'), { open: false, until: null });
  assert.deepEqual(contactWindow({ ...open, fulfilments: [{ vendorId: 'v1', status: 'cancelled', timeline: [] }] }, 'v1'), { open: false, until: null });
  // Legacy statuses read as their canonical ones: 'fulfilled' is delivered.
  assert.equal(contactWindow({ ...open, fulfilments: [{ vendorId: 'v1', status: 'confirmed', timeline: [] }] }, 'v1').open, true);
});

test('contact window: 7 EAT days after the EAT day of delivery, through 23:59:59 EAT — boundaries', () => {
  // Delivered 23:59 EAT on 12 Oct (20:59Z): EAT day 12 Oct → visible through 19 Oct 23:59:59 EAT.
  const late = deliveredOrder('2026-10-12T20:59:00.000Z');
  assert.equal(contactWindow(late, 'v1').until, '2026-10-19T23:59:59+03:00');
  assert.equal(contactWindow(late, 'v1', new Date('2026-10-19T20:59:59.999Z')).open, true, '19 Oct 23:59:59.999 EAT: still open');
  assert.equal(contactWindow(late, 'v1', new Date('2026-10-19T21:00:00.000Z')).open, false, '20 Oct 00:00 EAT: closed');
  // Delivered 00:00 EAT on 13 Oct (21:00Z on the 12th in UTC): EAT day 13 Oct → through 20 Oct.
  const early = deliveredOrder('2026-10-12T21:00:00.000Z');
  assert.equal(contactWindow(early, 'v1').until, '2026-10-20T23:59:59+03:00');
  assert.equal(contactWindow(early, 'v1', new Date('2026-10-20T20:59:59.000Z')).open, true);
  assert.equal(contactWindow(early, 'v1', new Date('2026-10-20T21:00:00.000Z')).open, false);
  // A delivered but not-paid (refunded) order: closed.
  assert.equal(contactWindow({ ...late, paymentStatus: 'refunded' }, 'v1', new Date('2026-10-13T00:00:00Z')).open, false);
  // The latest delivered entry counts (moved back and delivered again).
  const again = deliveredOrder('2026-10-12T20:59:00.000Z');
  again.fulfilments[0].timeline.push({ status: 'delivered', at: '2026-10-15T10:00:00.000Z' });
  assert.equal(contactWindow(again, 'v1').until, '2026-10-22T23:59:59+03:00');
});

test('contact window (security review of #200): the delivery time comes from delivered/fulfilled timeline entries only, never updatedAt; unknown → closed', () => {
  const now = new Date('2026-10-19T09:00:00.000Z');
  // An older order (no fulfilments) delivered long ago, touched yesterday by settlement: closed.
  const old = {
    id: 'ord_old', status: 'fulfilled', paymentStatus: 'paid', deliveryMethod: 'home_delivery', deliveryAddress: 'Old street',
    items: [{ productId: 'p1', vendorId: 'v1', qty: 1, priceTzs: 1000 }],
    timeline: [{ status: 'pending', at: '2026-08-01T08:00:00.000Z' }, { status: 'fulfilled', at: '2026-08-02T08:00:00.000Z' }],
    createdAt: '2026-08-01T08:00:00.000Z', updatedAt: '2026-10-18T12:00:00.000Z', settlementStatus: 'settled',
  };
  assert.deepEqual(contactWindow(old, 'v1', now), { open: false, until: '2026-08-09T23:59:59+03:00' });
  const view = vendorOrderView(old, 'v1', { buyer: { phone: '+255700000001' }, contactOn: true, now });
  assert.equal('deliveryAddress' in view, false);
  assert.equal('phone' in view.buyer, false);
  // No delivered entry anywhere (only a recent updatedAt): closed, no end date.
  const noEntry = { ...old, timeline: [{ status: 'pending', at: '2026-08-01T08:00:00.000Z' }] };
  assert.deepEqual(contactWindow(noEntry, 'v1', now), { open: false, until: null });
  const noEntryView = vendorOrderView(noEntry, 'v1', { buyer: { phone: '+255700000001' }, contactOn: true, now });
  assert.equal('deliveryAddress' in noEntryView, false);
  assert.equal('phone' in noEntryView.buyer, false);
  // A fulfilment that is delivered but has no delivered entry and a fresh updatedAt: closed.
  const bare = { ...old, timeline: [], fulfilments: [{ vendorId: 'v1', status: 'delivered', timeline: [{ status: 'pending', at: '2026-08-01T08:00:00.000Z' }], updatedAt: '2026-10-18T12:00:00.000Z' }] };
  assert.deepEqual(contactWindow(bare, 'v1', now), { open: false, until: null });
  // Another vendor's delivered entry on the order timeline does not count for v1.
  const otherVendors = { ...noEntry, timeline: [{ status: 'delivered', at: '2026-10-18T08:00:00.000Z', vendorId: 'v2' }] };
  assert.equal(contactWindow(otherVendors, 'v1', now).open, false);
  // This vendor's (or an untagged) recent delivered entry on the order timeline: open.
  const recent = { ...noEntry, timeline: [{ status: 'delivered', at: '2026-10-18T08:00:00.000Z', vendorId: 'v1' }] };
  assert.deepEqual(contactWindow(recent, 'v1', now), { open: true, until: '2026-10-25T23:59:59+03:00' });
});

test('vendorOrderView: allowlist only — own lines (never lines without a vendorId), no buyer id/role/email/payment reference/internals', () => {
  const order = {
    id: 'ord_view1', buyerId: 'usr_buyer', buyerRole: 'member', email: 'x@y.z', paymentReference: 'MPESA-SECRET', status: 'pending', paymentStatus: 'paid',
    paymentMethod: 'mpesa', deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni B', note: 'Ring twice', pickupGymId: null, totalTzs: 99999,
    idempotencyKey: 'k', idempotencyFingerprint: 'f', stockState: 'reserved', reservationCycle: 0, reservationExpiresAt: null, settlementStatus: 'pending',
    items: [
      { productId: 'p_mine', vendorId: 'v1', name: 'Mine', qty: 2, priceTzs: 1000, image: null, commissionPct: 10, commissionTzs: 200, vendorPayoutTzs: 1800, variantStockReserved: true, variant: 'Red' },
      { productId: 'p_theirs', vendorId: 'v2', name: 'Theirs', qty: 1, priceTzs: 5000, commissionTzs: 500, vendorPayoutTzs: 4500 },
      { productId: 'p_legacy', name: 'Legacy', qty: 1, priceTzs: 777 },
    ],
    fulfilments: [
      { vendorId: 'v1', status: 'accepted', timeline: [{ status: 'pending', at: 'a' }, { status: 'accepted', at: 'b', by: 'vendor', actorId: 'usr_staff', reason: 'ok' }] },
      { vendorId: 'v2', status: 'pending', timeline: [{ status: 'pending', at: 'a' }] },
    ],
    timeline: [{ status: 'pending', at: 'a' }, { status: 'accepted', at: 'b', vendorId: 'v1' }],
    createdAt: '2026-10-19T08:00:00.000Z', updatedAt: '2026-10-19T09:00:00.000Z',
  };
  const plain = vendorOrderView(order, 'v1', { customerId: 'cus_1', buyer: { displayName: 'Neema', phone: '+255700000009', email: 'n@x.y' } });
  assertAllowlisted(plain);
  assert.deepEqual(plain.items.map(i => i.productId), ['p_mine']);
  assert.equal(plain.items[0].variant, 'Red');
  assert.equal(plain.totalTzs, 2000, 'own subtotal, not the order total');
  assert.equal(plain.status, 'accepted');
  assert.equal(plain.orderStatus, 'pending');
  assert.deepEqual(plain.timeline, [{ status: 'pending', at: 'a' }, { status: 'accepted', at: 'b', reason: 'ok' }]);
  assert.deepEqual(plain.buyer, { customerId: 'cus_1', displayName: 'Neema', customerLinked: false }, 'no phone with the flag off');
  assert.equal(plain.deliveryAddress, 'Mikocheni B', 'address while the part is open and paid (needed to deliver)');
  assert.equal(plain.shortRef, '_VIEW1');
  for (const secret of ['usr_buyer', 'MPESA-SECRET', 'x@y.z', 'n@x.y', 'p_theirs', 'Theirs', 'p_legacy', 'Legacy', 'usr_staff', '99999']) {
    assert.equal(JSON.stringify(plain).includes(secret), false, secret);
  }
  const money = vendorOrderView(order, 'v1', { customerId: 'cus_1', seesMoney: true });
  assertAllowlisted(money, { money: true });
  assert.deepEqual([money.items[0].commissionTzs, money.items[0].vendorPayoutTzs], [200, 1800]);
  const contact = vendorOrderView(order, 'v1', { customerId: 'cus_1', buyer: { displayName: 'Neema', phone: '+255700000009' }, contactOn: true });
  assert.deepEqual(contact.buyer, { customerId: 'cus_1', displayName: 'Neema', customerLinked: false, phone: '+255700000009', contactVisibleUntil: null });
  assert.equal(vendorOrderView(order, 'v1', { customerId: 'cus_1', customerLinked: true }).buyer.customerLinked, true);
  assert.equal(vendorOrderView(order, 'v1', { customerId: null, customerLinked: true }).buyer.customerLinked, false, 'never linked without an id');
  // Unpaid: no address, no phone, no next steps.
  const unpaid = vendorOrderView({ ...order, paymentStatus: 'pending' }, 'v1', { buyer: { phone: '+255700000009' }, contactOn: true });
  assert.equal('deliveryAddress' in unpaid, false);
  assert.equal('phone' in unpaid.buyer, false);
  assert.deepEqual(unpaid.nextStatuses, []);
  // Older order without fulfilments: its own timeline entries only, not another vendor's.
  const legacy = vendorOrderView({ ...order, fulfilments: undefined, timeline: [{ status: 'pending', at: 'a' }, { status: 'accepted', at: 'b', vendorId: 'v2' }] }, 'v1');
  assert.deepEqual(legacy.timeline, [{ status: 'pending', at: 'a' }]);
  // Pickup: gym id and name.
  const pickup = vendorOrderView({ ...order, deliveryMethod: 'gym_pickup', deliveryAddress: null, pickupGymId: 'gym_1' }, 'v1', { gym: { id: 'gym_1', name: 'Kilele Gym', paymentNumber: 'x' } });
  assert.deepEqual(pickup.pickupGym, { id: 'gym_1', name: 'Kilele Gym' });
  assert.equal('deliveryAddress' in pickup, false);
});

// ── today's sales: EAT day, paid orders (Q-3) ────────────────────────────────

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(row => row.id === id) || null; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) { const i = rows.findIndex(r => r.id === id); if (i < 0) return null; rows[i] = { ...rows[i], ...patch }; return rows[i]; },
  };
}

test('GET /vendor/payments todaySalesTzs: own lines of paid orders placed on today\'s EAT day, delivered or not; not unpaid, refunded, cancelled or yesterday (EAT)', async () => {
  const at = new Date('2026-10-19T21:30:00.000Z'); // 00:30 EAT on 20 Oct
  const line = (vendorId, priceTzs) => ({ productId: `p_${vendorId}`, vendorId, qty: 1, priceTzs });
  const shop = memStore([
    { id: 'eat_today_processing', items: [line('v1', 1000), line('v2', 50_000), { productId: 'legacy', qty: 1, priceTzs: 70_000 }], paymentStatus: 'paid', status: 'processing', createdAt: '2026-10-19T21:10:00.000Z' },
    { id: 'eat_today_delivered', items: [line('v1', 2000)], paymentStatus: 'paid', status: 'delivered', createdAt: '2026-10-19T21:00:00.000Z' },
    { id: 'eat_yesterday', items: [line('v1', 4000)], paymentStatus: 'paid', status: 'pending', createdAt: '2026-10-19T20:59:59.999Z' },
    { id: 'eat_today_unpaid', items: [line('v1', 8000)], paymentStatus: 'pending', status: 'pending', createdAt: '2026-10-19T22:00:00.000Z' },
    { id: 'eat_today_refund', items: [line('v1', 16_000)], paymentStatus: 'refund_pending', status: 'cancelled', createdAt: '2026-10-19T22:00:00.000Z' },
  ]);
  const service = createShopService({ products: memStore(), shopOrders: shop, users: memStore(), auditLog: { insertAsync: async () => {} }, now: () => at });
  const dash = await service.vendorPayments('v1');
  assert.equal(dash.todaySalesTzs, 3000);
  assert.equal(dash.pendingSettlementTzs, 2000, 'still delivered, paid orders; own lines only');
  assert.doesNotMatch(await service.vendorStatement('v1'), /70000|50000/, 'the statement holds own lines only');
});

// ── routes, as bfast-function mounts them, on the CI database ────────────────

const fns = Object.fromEntries(Object.entries(shopFunctions).filter(([, d]) => d && typeof d === 'object' && (d.onRequest || d.onGuard)));
const app = express();
app.use(express.json());
mountGuards(Object.keys(fns).filter(k => fns[k].onGuard), fns, app);
mountHttpRoutes(Object.keys(fns).filter(k => fns[k].onRequest), fns, app);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function hit(method, url, claims, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}
async function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) { if (v === null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const CONTACT_ON = { VENDOR_TOOLS: 'true', VENDOR_ORDER_BUYER_CONTACT: 'true' };
const CONTACT_OFF = { VENDOR_TOOLS: null, VENDOR_ORDER_BUYER_CONTACT: null };

async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `S2 ${userType}`, accountStatus: 'active', updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
async function product(vendorId, name = 'S2 item') {
  const id = uid('prd');
  await db('Product').insert({ id, vendorId, name, priceTzs: 10_000, stock: 50, status: 'active', approvalStatus: 'approved', updatedAt: new Date() });
  made.products.push(id);
  return id;
}
const staffOf = (vendorId, permissions, extra = {}) => user('vendor_staff', { vendorId, vendorPermissions: permissions, vendorRole: 'staff', ...extra });
const vendorClaims = id => ({ sub: id, userType: 'vendor' });
const staffClaims = (id, vendorId) => ({ sub: id, userType: 'vendor_staff', vendorId });

// Orders are placed and paid through a service of their own (refunds recorded, not raised); the routes use the app's.
const refunds = [];
const local = createShopService({
  products, shopOrders, users, auditLog, paymentRequests, orderStore: createPgShopOrderStore({ db }),
  buyerRefs: createPgVendorBuyerRefStore({ db }),
  onRefundDue: async ({ order, reasonCode }) => { const r = { id: uid('ref'), orderId: order.id, reasonCode }; refunds.push(r); return r; },
});
async function paidOrder(buyerId, lines, body = {}) {
  const placed = await local.createOrder({ buyerId, body: { items: lines, deliveryMethod: 'home_delivery', deliveryAddress: 'Mikocheni B, house 12', paymentMethod: 'mpesa', paymentReference: 'MPESA-REF-SECRET', note: 'Call at the gate', ...body } });
  assert.ok(placed.order, JSON.stringify(placed));
  made.orders.push(placed.order.id);
  await local.applyPaymentToOrder(placed.order.id, 'approved');
  return placed.order.id;
}
/** Mark one vendor's part delivered `daysAgo` days ago (stored directly). */
async function deliveredAgo(orderId, vendorId, daysAgo) {
  const row = await db('ShopOrder').where({ id: orderId }).first();
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const fulfilments = row.fulfilments.map(f => (f.vendorId === vendorId ? { ...f, status: 'delivered', timeline: [...f.timeline, { status: 'delivered', at }], updatedAt: at } : f));
  await db('ShopOrder').where({ id: orderId }).update({ fulfilments: JSON.stringify(fulfilments), status: 'delivered' });
}

/** Two vendors, a buyer with phone and email, a pickup gym, and an order with a line from each plus an older line with no vendor. */
async function world() {
  const [a, b] = [await user('vendor', { vendorProfile: JSON.stringify({ businessName: 'Vendor A' }) }), await user('vendor', { vendorProfile: JSON.stringify({ businessName: 'Vendor B' }) })];
  const phone = `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const buyer = await user('member', { displayName: 'Neema Buyer', phone, email: `${uid('buyer')}@example.com` });
  const [pa, pb] = [await product(a, 'A whey'), await product(b, 'B shaker')];
  const shared = await paidOrder(buyer, [{ productId: pa, qty: 1 }, { productId: pb, qty: 2 }]);
  const legacyPid = uid('prd_legacy');
  const row = await db('ShopOrder').where({ id: shared }).first();
  await db('ShopOrder').where({ id: shared }).update({ items: JSON.stringify([...row.items, { productId: legacyPid, name: 'Legacy secret line', qty: 1, priceTzs: 777 }]) });
  const onlyB = await paidOrder(buyer, [{ productId: pb, qty: 1 }]);
  const gym = uid('gym');
  await db('Gym').insert({ id: gym, name: 'Kilele Gym S2', tier: 'standard', location: 'Moshi', updatedAt: new Date() });
  made.gyms.push(gym);
  const pickup = await paidOrder(buyer, [{ productId: pa, qty: 1 }], { deliveryMethod: 'gym_pickup', pickupGymId: gym, deliveryAddress: undefined });
  const buyerRow = await db('User').where({ id: buyer }).first();
  return { a, b, buyer, phone, buyerEmail: buyerRow.email, pa, pb, legacyPid, shared, onlyB, pickup, gym };
}

after(async () => {
  server.close();
  const vendors = made.users;
  await db('VendorBuyerRef').whereIn('vendorId', vendors).del();
  await db('ShopStockMovement').whereIn('orderId', made.orders).del();
  await db('PaymentRequest').whereIn('orderId', made.orders).del();
  await db('AuditLog').whereIn('target', made.orders).del();
  await db('MarketplaceNotification').whereIn('userId', made.users).del();
  await db('ShopOrder').whereIn('id', made.orders).del();
  await db('Product').whereIn('id', made.products).del();
  await db('Gym').whereIn('id', made.gyms).del();
  await db('User').whereIn('id', made.users).del();
  await db.destroy();
});

test('GET /vendor/orders: own lines and subtotal only; no buyer id/role/email, payment reference, other vendors\' or legacy lines; pickup gym name', async () => {
  await withEnv(CONTACT_OFF, async () => {
    const w = await world();
    const list = await hit('GET', '/vendor/orders', vendorClaims(w.a));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.map(o => o.id).sort(), [w.shared, w.pickup].sort(), 'vendor B\'s own order is not listed');
    for (const order of list.body) assertAllowlisted(order, { money: true });
    const text = JSON.stringify(list.body);
    for (const secret of [w.buyer, w.buyerEmail, 'MPESA-REF-SECRET', w.pb, 'B shaker', w.b, w.legacyPid, 'Legacy secret line', w.phone]) {
      assert.equal(text.includes(secret), false, `leaks ${secret}`);
    }
    const shared = list.body.find(o => o.id === w.shared);
    assert.deepEqual(shared.items.map(i => i.productId), [w.pa]);
    assert.equal(shared.totalTzs, 10_000);
    assert.equal(shared.shortRef, w.shared.slice(-6).toUpperCase());
    assert.equal(shared.buyer.displayName, 'Neema Buyer');
    assert.match(shared.buyer.customerId, /^cus_[0-9a-f]{16}$/);
    assert.equal(shared.deliveryAddress, 'Mikocheni B, house 12', 'address while open and paid (app builds deliver with it)');
    assert.equal(shared.note, 'Call at the gate');
    assert.equal(shared.pickupGym, null);
    const pickup = list.body.find(o => o.id === w.pickup);
    assert.deepEqual(pickup.pickupGym, { id: w.gym, name: 'Kilele Gym S2' });
    assert.equal(pickup.pickupGymId, w.gym, 'kept for app builds that read it');
    assert.equal('deliveryAddress' in pickup, false);
    // customerId: stable per vendor, different between vendors for the same buyer.
    const again = await hit('GET', '/vendor/orders', vendorClaims(w.a));
    assert.equal(again.body.find(o => o.id === w.shared).buyer.customerId, shared.buyer.customerId);
    assert.equal(pickup.buyer.customerId, shared.buyer.customerId, 'same buyer, same vendor → same id');
    const forB = await hit('GET', '/vendor/orders', vendorClaims(w.b));
    const sharedB = forB.body.find(o => o.id === w.shared);
    assert.deepEqual(sharedB.items.map(i => i.productId), [w.pb]);
    assert.equal(sharedB.totalTzs, 20_000);
    assert.notEqual(sharedB.buyer.customerId, shared.buyer.customerId, 'another vendor gets another id');
    assert.equal(JSON.stringify(forB.body).includes(w.pa), false);
  });
});

test('GET /vendor/orders/:id: my order in the same shape; another vendor\'s order or an unknown id → 404 order_not_found', async () => {
  const w = await world();
  const mine = await hit('GET', `/vendor/orders/${w.shared}`, vendorClaims(w.a));
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assertAllowlisted(mine.body, { money: true });
  const fromList = (await hit('GET', '/vendor/orders', vendorClaims(w.a))).body.find(o => o.id === w.shared);
  assert.deepEqual(mine.body, fromList);
  assert.deepEqual(await hit('GET', `/vendor/orders/${w.onlyB}`, vendorClaims(w.a)), { status: 404, body: { error: 'order_not_found' } });
  assert.deepEqual(await hit('GET', `/vendor/orders/${uid('ord')}`, vendorClaims(w.a)), { status: 404, body: { error: 'order_not_found' } });
  // Staff of vendor A cannot reach B's order either.
  const staffA = await staffOf(w.a, ['orders']);
  assert.equal((await hit('GET', `/vendor/orders/${w.onlyB}`, staffClaims(staffA, w.a))).status, 404);
  // A token naming vendor B for A's staff is refused (rights come from the staff record).
  assert.equal((await hit('GET', `/vendor/orders/${w.onlyB}`, staffClaims(staffA, w.b))).status, 403);
  assert.equal((await hit('GET', `/vendor/orders/${w.shared}`, { sub: uid('m'), userType: 'member' })).status, 403);
  assert.equal((await hit('GET', `/vendor/orders/${w.shared}`, null)).status, 401);
});

test('staff: no `orders` → 403 on list and detail; `orders` without `payments` → no commission/payout; `payments`, vendor admin role and the vendor → with them', async () => {
  const w = await world();
  const none = await staffOf(w.a, ['products', 'payments']);
  for (const url of ['/vendor/orders', `/vendor/orders/${w.shared}`]) {
    assert.deepEqual(await hit('GET', url, staffClaims(none, w.a)), { status: 403, body: { error: 'vendor_permission_forbidden', requiredPermission: 'orders' } }, url);
  }
  const clerk = await staffOf(w.a, ['orders']);
  const withPay = await staffOf(w.a, ['orders', 'payments']);
  const vendorAdmin = await staffOf(w.a, ['orders'], { vendorRole: 'admin' });
  const clerkView = await hit('GET', `/vendor/orders/${w.shared}`, staffClaims(clerk, w.a));
  assert.equal(clerkView.status, 200, JSON.stringify(clerkView.body));
  assertAllowlisted(clerkView.body, { money: false });
  // Claims the token might carry change nothing.
  const forged = await hit('GET', '/vendor/orders', { ...staffClaims(clerk, w.a), vendorRole: 'admin', vendorPermissions: ['payments'] });
  assert.ok(forged.body.every(o => o.items.every(i => !('commissionTzs' in i))));
  for (const claims of [staffClaims(withPay, w.a), staffClaims(vendorAdmin, w.a), vendorClaims(w.a)]) {
    const view = await hit('GET', `/vendor/orders/${w.shared}`, claims);
    assert.equal(view.status, 200);
    assertAllowlisted(view.body, { money: true });
    assert.equal(view.body.items[0].commissionTzs + view.body.items[0].vendorPayoutTzs, 10_000, JSON.stringify(claims));
  }
  const suspended = await staffOf(w.a, ['orders'], { accountStatus: 'suspended' });
  assert.equal((await hit('GET', '/vendor/orders', staffClaims(suspended, w.a))).status, 403);
});

test('buyer phone: only with VENDOR_ORDER_BUYER_CONTACT, while open and paid, and up to 7 EAT days after delivery; address follows the same window', async () => {
  const w = await world();
  await withEnv(CONTACT_OFF, async () => {
    const off = (await hit('GET', `/vendor/orders/${w.shared}`, vendorClaims(w.a))).body;
    assert.deepEqual(Object.keys(off.buyer).sort(), ['customerId', 'customerLinked', 'displayName']);
  });
  await withEnv(CONTACT_ON, async () => {
    const open = (await hit('GET', `/vendor/orders/${w.shared}`, vendorClaims(w.a))).body;
    assert.deepEqual([open.buyer.phone, open.buyer.contactVisibleUntil], [w.phone, null]);
    assert.equal(open.deliveryAddress, 'Mikocheni B, house 12');
    // Delivered 6 days ago: still visible, with the end date.
    await deliveredAgo(w.shared, w.a, 6);
    const recent = (await hit('GET', `/vendor/orders/${w.shared}`, vendorClaims(w.a))).body;
    assert.equal(recent.buyer.phone, w.phone);
    assert.match(recent.buyer.contactVisibleUntil, /^\d{4}-\d{2}-\d{2}T23:59:59\+03:00$/);
    const deliveredDay = eatDate(Date.now() - 6 * 86_400_000);
    const expected = new Date(Date.parse(`${deliveredDay}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    assert.equal(recent.buyer.contactVisibleUntil, `${expected}T23:59:59+03:00`);
    // Delivered 8 days ago: gone, phone and address.
    await deliveredAgo(w.shared, w.a, 8);
    const old = (await hit('GET', `/vendor/orders/${w.shared}`, vendorClaims(w.a))).body;
    assert.deepEqual(Object.keys(old.buyer).sort(), ['customerId', 'customerLinked', 'displayName']);
    assert.equal('deliveryAddress' in old, false);
    // Vendor B's part of the same order is still open: B still sees the phone.
    const forB = (await hit('GET', `/vendor/orders/${w.shared}`, vendorClaims(w.b))).body;
    assert.equal(forB.buyer.phone, w.phone);
    // Unpaid order: nothing.
    const unpaid = await local.createOrder({ buyerId: w.buyer, body: { items: [{ productId: w.pa, qty: 1 }], deliveryMethod: 'home_delivery', deliveryAddress: 'Unpaid street', paymentMethod: 'mpesa' } });
    made.orders.push(unpaid.order.id);
    const u = (await hit('GET', `/vendor/orders/${unpaid.order.id}`, vendorClaims(w.a))).body;
    assert.equal(u.paymentStatus, 'pending');
    assert.deepEqual(Object.keys(u.buyer).sort(), ['customerId', 'customerLinked', 'displayName']);
    assert.equal('deliveryAddress' in u, false);
    assert.deepEqual(u.nextStatuses, []);
  });
});

test('POST /vendor/orders/:id/status: the vendor gets the allowlisted order back (moved and repeated); an admin still gets the stored order', async () => {
  const w = await world();
  const moved = await hit('POST', `/vendor/orders/${w.pickup}/status`, vendorClaims(w.a), { status: 'accepted', reason: 'On it' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assertAllowlisted(moved.body, { money: true });
  assert.equal(moved.body.status, 'accepted');
  assert.deepEqual(moved.body.timeline.at(-1), { status: 'accepted', at: moved.body.timeline.at(-1).at, reason: 'On it' });
  const same = await hit('POST', `/vendor/orders/${w.pickup}/status`, vendorClaims(w.a), { status: 'accepted' });
  assert.equal(same.status, 200);
  assertAllowlisted(same.body, { money: true });
  // Staff with `orders` only: allowlisted, without money.
  const clerk = await staffOf(w.a, ['orders']);
  const byClerk = await hit('POST', `/vendor/orders/${w.pickup}/status`, staffClaims(clerk, w.a), { status: 'ready_for_pickup' });
  assert.equal(byClerk.status, 200, JSON.stringify(byClerk.body));
  assertAllowlisted(byClerk.body, { money: false });
  // Multi-vendor: A moves A's part; B's lines stay out.
  const shared = await hit('POST', `/vendor/orders/${w.shared}/status`, vendorClaims(w.a), { status: 'accepted' });
  assert.deepEqual(shared.body.items.map(i => i.productId), [w.pa]);
  assert.equal(JSON.stringify(shared.body).includes('MPESA-REF-SECRET'), false);
  // Another vendor's order looks absent (404), to the vendor and to their staff; nothing moves.
  assert.deepEqual(await hit('POST', `/vendor/orders/${w.onlyB}/status`, vendorClaims(w.a), { status: 'accepted' }), { status: 404, body: { error: 'order_not_found' } });
  assert.deepEqual(await hit('POST', `/vendor/orders/${w.onlyB}/status`, staffClaims(clerk, w.a), { status: 'accepted' }), { status: 404, body: { error: 'order_not_found' } });
  assert.deepEqual(await hit('POST', `/vendor/orders/${uid('ord')}/status`, vendorClaims(w.a), { status: 'accepted' }), { status: 404, body: { error: 'order_not_found' } });
  assert.equal((await db('ShopOrder').where({ id: w.onlyB }).first()).fulfilments[0].status, 'pending');
  // The shared order's legacy line (no vendorId) does not let A reach B's part, and a vendor cannot act on an order whose only line has no vendorId.
  const legacyOnly = uid('ord');
  made.orders.push(legacyOnly);
  await db('ShopOrder').insert({ id: legacyOnly, buyerId: w.buyer, items: JSON.stringify([{ productId: w.pa, name: 'Old', qty: 1, priceTzs: 10_000 }]), totalTzs: 10_000, status: 'pending', paymentStatus: 'paid', deliveryMethod: 'home_delivery', timeline: JSON.stringify([{ status: 'pending' }]), stockState: 'reserved' });
  assert.deepEqual(await hit('POST', `/vendor/orders/${legacyOnly}/status`, vendorClaims(w.a), { status: 'accepted' }), { status: 404, body: { error: 'order_not_found' } });
  assert.deepEqual(await hit('GET', `/vendor/orders/${legacyOnly}`, vendorClaims(w.a)), { status: 404, body: { error: 'order_not_found' } });
  // FitFlex admin (scope shop): the stored order, as before.
  const admin = await hit('POST', `/vendor/orders/${w.onlyB}/status`, { sub: uid('adm'), userType: 'admin' }, { status: 'accepted' });
  assert.equal(admin.status, 200, JSON.stringify(admin.body));
  assert.equal(admin.body.buyerId, w.buyer);
});

test('a vendor cancelling their (single-vendor) order gets the allowlisted order back, not the refund or the buyer\'s details', async () => {
  const w = await world();
  const out = await local.updateOrderStatus({ orderId: w.pickup, status: 'cancelled', actorId: w.a, actorRole: 'vendor', reason: 'Out of stock' });
  assert.ok(out.order, JSON.stringify(out));
  assertAllowlisted(out.order);
  assert.equal(out.order.orderStatus, 'cancelled');
  assert.ok(refunds.some(r => r.orderId === w.pickup), 'the refund is still raised');
  assert.equal(out.refund?.orderId, w.pickup, 'the server\'s own callers still get the refund; the route sends only `order`');
  assert.equal(JSON.stringify(out.order).includes(w.buyer), false);
});

test('older delivered order touched recently (settlement): no address or phone over HTTP (security review of #200)', async () => {
  const w = await world();
  await withEnv(CONTACT_ON, async () => {
    await deliveredAgo(w.shared, w.a, 30);
    await db('ShopOrder').where({ id: w.shared }).update({ updatedAt: new Date(), settlementStatus: 'settled' });
    const view = (await hit('GET', `/vendor/orders/${w.shared}`, vendorClaims(w.a))).body;
    assert.deepEqual(Object.keys(view.buyer).sort(), ['customerId', 'customerLinked', 'displayName']);
    assert.equal('deliveryAddress' in view, false);
  });
});

test('GET /vendor/orders paging: no params → the whole array (older apps); limit/cursor → { orders, nextCursor }, newest first, no gaps or repeats; bad params → 400', async () => {
  const vendor = await user('vendor');
  const buyer = await user('member', { phone: `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` });
  const pid = await product(vendor);
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await paidOrder(buyer, [{ productId: pid, qty: 1 }]));
  // Two orders at the same instant: the id breaks the tie.
  await db('ShopOrder').whereIn('id', [ids[3], ids[4]]).update({ createdAt: new Date('2026-10-19T10:00:00.000Z') });
  const expected = (await db('ShopOrder').whereIn('id', ids).orderBy([{ column: 'createdAt', order: 'desc' }, { column: 'id', order: 'desc' }]).select('id')).map(r => r.id);

  const all = await hit('GET', '/vendor/orders', vendorClaims(vendor));
  assert.ok(Array.isArray(all.body));
  assert.deepEqual(all.body.map(o => o.id), expected);

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const url = `/vendor/orders?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await hit('GET', url, vendorClaims(vendor));
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.deepEqual(Object.keys(page.body).sort(), ['counts', 'nextCursor', 'orders']);
    assert.equal(page.body.counts.all, 5, 'counts are over all orders, not the page');
    assert.ok(page.body.orders.length <= 2);
    for (const o of page.body.orders) assertAllowlisted(o, { money: true });
    seen.push(...page.body.orders.map(o => o.id));
    cursor = page.body.nextCursor;
    pages++;
  } while (cursor && pages < 10);
  assert.equal(pages, 3);
  assert.deepEqual(seen, expected);

  const first = await hit('GET', '/vendor/orders?cursor=', vendorClaims(vendor));
  assert.deepEqual([first.body.orders.length, first.body.nextCursor], [5, null], 'cursor alone → default limit 50');
  const capped = await hit('GET', '/vendor/orders?limit=5000', vendorClaims(vendor));
  assert.equal(capped.status, 200);
  assert.equal(capped.body.orders.length, 5);
  for (const bad of ['0', '-1', '2.5', 'abc']) {
    assert.deepEqual(await hit('GET', `/vendor/orders?limit=${bad}`, vendorClaims(vendor)), { status: 400, body: { error: 'invalid_limit' } }, bad);
  }
  assert.deepEqual(await hit('GET', '/vendor/orders?cursor=not-a-cursor', vendorClaims(vendor)), { status: 400, body: { error: 'invalid_cursor' } });
  // Another vendor's pages never hold this vendor's orders.
  const other = await user('vendor');
  assert.deepEqual((await hit('GET', '/vendor/orders?limit=10', vendorClaims(other))).body, { orders: [], nextCursor: null, counts: { open: 0, delivered: 0, cancelled: 0, all: 0, waitingAccept: 0 } });
  // Staff without money rights: paged orders without commission.
  const clerk = await staffOf(vendor, ['orders']);
  const clerkPage = await hit('GET', '/vendor/orders?limit=1', staffClaims(clerk, vendor));
  assertAllowlisted(clerkPage.body.orders[0], { money: false });
});

// ── UAT D2: tab counts on the paged list ─────────────────────────────────────

test('orderTab / countOrders: cancelled (own part, order, refund_pending, refunded) → delivered → open (paid) → unpaid (all only); waitingAccept = open and own part pending', () => {
  const o = (id, extra) => ({ id, items: [{ vendorId: 'v1' }, { vendorId: 'v2' }], status: 'pending', paymentStatus: 'paid',
    fulfilments: [{ vendorId: 'v1', status: 'pending', timeline: [] }, { vendorId: 'v2', status: 'accepted', timeline: [] }], ...extra });
  const orders = [
    o('pending_paid'),
    o('accepted', { fulfilments: [{ vendorId: 'v1', status: 'accepted', timeline: [] }] }),
    o('delivered', { fulfilments: [{ vendorId: 'v1', status: 'delivered', timeline: [] }] }),
    o('delivered_refunded', { paymentStatus: 'refunded', fulfilments: [{ vendorId: 'v1', status: 'delivered', timeline: [] }] }),
    o('refund_pending', { status: 'cancelled', paymentStatus: 'refund_pending' }),
    o('own_cancelled', { fulfilments: [{ vendorId: 'v1', status: 'cancelled', timeline: [] }] }),
    o('unpaid', { paymentStatus: 'pending' }),
    o('expired', { status: 'cancelled', paymentStatus: 'failed' }),
    { id: 'legacy_fulfilled', items: [{ vendorId: 'v1' }], status: 'fulfilled', paymentStatus: 'paid' },
    { id: 'legacy_confirmed', items: [{ vendorId: 'v1' }], status: 'confirmed', paymentStatus: 'paid' },
  ];
  assert.deepEqual(orders.map(x => [x.id, orderTab(x, 'v1')]), [
    ['pending_paid', 'open'], ['accepted', 'open'], ['delivered', 'delivered'], ['delivered_refunded', 'cancelled'],
    ['refund_pending', 'cancelled'], ['own_cancelled', 'cancelled'], ['unpaid', 'unpaid'], ['expired', 'cancelled'],
    ['legacy_fulfilled', 'delivered'], ['legacy_confirmed', 'open'],
  ]);
  assert.deepEqual(countOrders(orders, 'v1'), { open: 3, delivered: 2, cancelled: 4, all: 10, waitingAccept: 1 });
  // Vendor B's own part of the first order is accepted: open, not waiting.
  assert.equal(orderTab(orders[0], 'v2'), 'open');
});

test('GET /vendor/orders?limit=…: counts are over all my orders (SQL), not the page; the same rules as orderTab; the plain array has none', async () => {
  const w = await world(); // A: shared (pending, paid), pickup (pending, paid); B: shared, onlyB
  const ids = { shared: w.shared, pickup: w.pickup };
  ids.accepted = await paidOrder(w.buyer, [{ productId: w.pa, qty: 1 }]);
  await local.updateOrderStatus({ orderId: ids.accepted, status: 'accepted', actorId: w.a });
  ids.delivered = await paidOrder(w.buyer, [{ productId: w.pa, qty: 1 }]);
  await deliveredAgo(ids.delivered, w.a, 1);
  ids.refunded = await paidOrder(w.buyer, [{ productId: w.pa, qty: 1 }]);
  await deliveredAgo(ids.refunded, w.a, 2);
  await db('ShopOrder').where({ id: ids.refunded }).update({ paymentStatus: 'refunded' });
  ids.cancelled = await paidOrder(w.buyer, [{ productId: w.pa, qty: 1 }]);
  assert.ok((await local.updateOrderStatus({ orderId: ids.cancelled, status: 'cancelled', actorId: w.a, reason: 'x' })).order);
  const unpaid = await local.createOrder({ buyerId: w.buyer, body: { items: [{ productId: w.pa, qty: 1 }], deliveryMethod: 'home_delivery', deliveryAddress: 'x', paymentMethod: 'mpesa' } });
  made.orders.push(unpaid.order.id);
  // An older order (no fulfilments) whose line names A, delivered under the legacy name.
  const legacy = uid('ord');
  made.orders.push(legacy);
  await db('ShopOrder').insert({ id: legacy, buyerId: w.buyer, items: JSON.stringify([{ productId: w.pa, vendorId: w.a, name: 'Old', qty: 1, priceTzs: 1000 }]), totalTzs: 1000, status: 'fulfilled', paymentStatus: 'paid', deliveryMethod: 'home_delivery', timeline: JSON.stringify([]), stockState: 'reserved' });
  // B accepts the shared order: A's own part is still pending (waiting).
  await local.updateOrderStatus({ orderId: w.shared, status: 'accepted', actorId: w.b });

  const expected = { open: 3, delivered: 2, cancelled: 2, all: 8, waitingAccept: 2 };
  const page = await hit('GET', '/vendor/orders?limit=1', vendorClaims(w.a));
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.body.orders.length, 1);
  assert.deepEqual(page.body.counts, expected);
  // Same counts on every page, and the same rules as the JS orderTab over the stored rows.
  const next = await hit('GET', `/vendor/orders?limit=1&cursor=${encodeURIComponent(page.body.nextCursor)}`, vendorClaims(w.a));
  assert.deepEqual(next.body.counts, expected);
  const rows = (await db('ShopOrder').whereIn('id', made.orders)).map(r => JSON.parse(JSON.stringify(r)));
  const mineRows = rows.filter(r => (r.items || []).some(i => i.vendorId === w.a));
  assert.deepEqual(countOrders(mineRows, w.a), expected);
  // The whole list in one page agrees with the counts.
  const full = await hit('GET', '/vendor/orders?limit=200', vendorClaims(w.a));
  assert.equal(full.body.orders.length, expected.all);
  // Vendor B: shared accepted (open, not waiting), onlyB pending (open, waiting).
  assert.deepEqual((await hit('GET', '/vendor/orders?limit=5', vendorClaims(w.b))).body.counts, { open: 2, delivered: 0, cancelled: 0, all: 2, waitingAccept: 1 });
  // Staff with `orders` see the same counts; the plain array (no params) is unchanged.
  const clerk = await staffOf(w.a, ['orders']);
  assert.deepEqual((await hit('GET', '/vendor/orders?cursor=', staffClaims(clerk, w.a))).body.counts, expected);
  const plain = await hit('GET', '/vendor/orders', vendorClaims(w.a));
  assert.ok(Array.isArray(plain.body));
  assert.equal(plain.body.length, expected.all);
  // A vendor with no orders.
  const none = await user('vendor');
  assert.deepEqual((await hit('GET', '/vendor/orders?limit=10', vendorClaims(none))).body, { orders: [], nextCursor: null, counts: { open: 0, delivered: 0, cancelled: 0, all: 0, waitingAccept: 0 } });
});

// ── GET /vendor/me ───────────────────────────────────────────────────────────

test('GET /vendor/me: 404 feature_disabled unless VENDOR_TOOLS + VENDOR_PORTAL; then who I am, my permissions and the tools', async () => {
  const vendor = await user('vendor', { vendorProfile: JSON.stringify({ businessName: 'Me Shop' }), approvalStatus: 'pending_approval' });
  const clerk = await staffOf(vendor, ['orders', 'payments']);
  const vendorAdmin = await staffOf(vendor, ['products'], { vendorRole: 'admin' });
  for (const env of [{ VENDOR_TOOLS: null, VENDOR_PORTAL: null }, { VENDOR_TOOLS: 'true', VENDOR_PORTAL: null }, { VENDOR_TOOLS: null, VENDOR_PORTAL: 'true' }]) {
    await withEnv(env, async () => {
      assert.deepEqual(await hit('GET', '/vendor/me', vendorClaims(vendor)), { status: 404, body: { error: 'feature_disabled' } }, JSON.stringify(env));
    });
  }
  await withEnv({ VENDOR_TOOLS: 'true', VENDOR_PORTAL: 'true', VENDOR_ORDER_BUYER_CONTACT: null, VENDOR_STOCK_LEDGER: null }, async () => {
    const me = await hit('GET', '/vendor/me', vendorClaims(vendor));
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.deepEqual(Object.keys(me.body).sort(), ['accountStatus', 'approvalStatus', 'businessName', 'permissions', 'tools', 'userType', 'vendorId', 'vendorRole']);
    assert.deepEqual([me.body.vendorId, me.body.businessName, me.body.userType, me.body.vendorRole, me.body.approvalStatus, me.body.accountStatus], [vendor, 'Me Shop', 'vendor', null, 'pending_approval', 'active']);
    assert.deepEqual(me.body.permissions, ['products', 'orders', 'sales', 'customers', 'reports', 'payments', 'staff']);
    assert.deepEqual([me.body.tools.portal, me.body.tools.buyerContact, me.body.tools.stockLedger, me.body.tools.canSeeCost], [true, false, false, true]);
    const options = await hit('GET', '/vendor/tools/options', vendorClaims(vendor));
    assert.deepEqual(me.body.tools, options.body, 'tools = /vendor/tools/options');

    const staffMe = await hit('GET', '/vendor/me', { ...staffClaims(clerk, vendor), vendorPermissions: ['staff'], vendorRole: 'admin' });
    assert.equal(staffMe.status, 200, JSON.stringify(staffMe.body));
    assert.deepEqual([staffMe.body.vendorId, staffMe.body.userType, staffMe.body.vendorRole, staffMe.body.businessName], [vendor, 'vendor_staff', 'staff', 'Me Shop']);
    assert.deepEqual(staffMe.body.permissions, ['orders', 'payments'], 'from the staff record, not the token');
    assert.equal(staffMe.body.tools.canSeeCost, false);
    const adminMe = await hit('GET', '/vendor/me', staffClaims(vendorAdmin, vendor));
    assert.deepEqual([adminMe.body.vendorRole, adminMe.body.permissions, adminMe.body.tools.canSeeCost], ['admin', ['products'], true]);
  });
});

test('GET /vendor/me: staff no longer active, of another vendor, or unknown → 403 vendor_staff_inactive (flag on or off); members and FitFlex admins → 403', async () => {
  const vendor = await user('vendor');
  const other = await user('vendor');
  const moved = await staffOf(other, ['orders']);
  const disabled = await staffOf(vendor, ['orders']);
  await db('User').where({ id: disabled }).update({ accountStatus: 'disabled' });
  const suspended = await staffOf(vendor, ['orders'], { accountStatus: 'suspended' });
  for (const env of [{ VENDOR_TOOLS: 'true', VENDOR_PORTAL: 'true' }, { VENDOR_TOOLS: null, VENDOR_PORTAL: null }]) {
    await withEnv(env, async () => {
      for (const claims of [staffClaims(moved, vendor), staffClaims(disabled, vendor), staffClaims(uid('ghost'), vendor)]) {
        assert.deepEqual(await hit('GET', '/vendor/me', claims), { status: 403, body: { error: 'vendor_staff_inactive' } }, JSON.stringify(claims));
      }
      const s = await hit('GET', '/vendor/me', staffClaims(suspended, vendor));
      assert.equal(s.status, 403);
      assert.ok(['account_suspended', 'vendor_staff_inactive'].includes(s.body.error), JSON.stringify(s.body));
    });
  }
  assert.equal((await hit('GET', '/vendor/me', { sub: uid('m'), userType: 'member' })).status, 403);
  assert.equal((await hit('GET', '/vendor/me', { sub: uid('a'), userType: 'admin' })).status, 403);
  assert.equal((await hit('GET', '/vendor/me', null)).status, 401);
});

// ── sign-in: disabled vendor staff (Q-2) ─────────────────────────────────────

const localPhone = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const e164 = l => `+255${l.slice(1)}`;
let ipCounter = 0;
async function pinPost(body) {
  const out = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await pinLogin.onRequest({ body, headers: { 'x-forwarded-for': `10.92.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` } }, out);
  return out;
}
const PIN_ON = { IDENTITY_V2: 'true', V2_PIN_LOGIN: 'true', V2_PERSONAS: 'true', V2_IDENTIFIERS: 'true', V2_LINKING: null, VERIFICATION_EMAIL_PROVIDER: 'fake' };
async function personWithPin(userType, extra = {}) {
  const local = localPhone();
  const id = uid('usr_s2pin');
  await users.upsertAsync(u => u.id === id, { id, userType, phone: local, displayName: 'S2 PIN', accountStatus: 'active', approvalStatus: 'approved', createdAt: new Date().toISOString(), ...extra });
  // Like the other PIN specs, these users stay (their Person and identifiers point at them).
  const row = await db('User').where({ id }).first();
  assert.ok(row.personId, 'a person is made for the user');
  await db('LoginIdentifier').insert({ id: uid('lid'), personId: row.personId, type: 'phone', value: e164(local), normalizedValue: e164(local), verifiedAt: new Date(), status: 'active' });
  await pinAuthService.setPin(row.personId, '4821');
  return { id, personId: row.personId, phone: e164(local) };
}

test('PIN sign-in: vendor staff whose only profile was turned off get 403 vendor_staff_inactive, not onboarding; with another working profile they still sign in', async () => {
  await withEnv(PIN_ON, async () => {
    const vendor = await user('vendor');
    const off = await personWithPin('vendor_staff', { vendorId: vendor, vendorPermissions: ['orders'], vendorRole: 'staff', accountStatus: 'suspended' });
    const refused = await pinPost({ phone: off.phone, pin: '4821' });
    assert.deepEqual([refused.statusCode, refused.body], [403, { error: 'vendor_staff_inactive' }]);

    // Control: a person whose only profile is a suspended member still goes to onboarding, as before.
    const member = await personWithPin('member', { accountStatus: 'suspended' });
    const onboarding = await pinPost({ phone: member.phone, pin: '4821' });
    assert.equal(onboarding.statusCode, 200, JSON.stringify(onboarding.body));
    assert.equal(onboarding.body.onboarding, true);

    // The same disabled staff member who is also a working member signs in (as the member).
    const both = await personWithPin('vendor_staff', { vendorId: vendor, vendorPermissions: ['orders'], vendorRole: 'staff', accountStatus: 'suspended' });
    const memberId = uid('usr_s2pin');
    await db('User').insert({ id: memberId, userType: 'member', personId: both.personId, accountStatus: 'active', approvalStatus: 'approved', updatedAt: new Date() });
    const session = await pinPost({ phone: both.phone, pin: '4821' });
    assert.equal(session.statusCode, 200, JSON.stringify(session.body));
    assert.ok(session.body.token);
    assert.equal(session.body.user.id, memberId);
    const staffPersona = session.body.personas.find(p => p.userType === 'vendor_staff');
    assert.equal(staffPersona.accountStatus, 'suspended', 'the portal can tell the staff persona is off');
  });
});

test('PIN sign-in (UAT D3): a suspended vendor owner with the right PIN gets 403 account_suspended, not onboarding; a wrong PIN still says invalid_credentials', async () => {
  await withEnv(PIN_ON, async () => {
    const owner = await personWithPin('vendor', { accountStatus: 'suspended' });
    const wrong = await pinPost({ phone: owner.phone, pin: '1111' });
    assert.deepEqual([wrong.statusCode, wrong.body.error], [401, 'invalid_credentials'], 'nothing about the account before the PIN is right');
    const refused = await pinPost({ phone: owner.phone, pin: '4821' });
    assert.deepEqual([refused.statusCode, refused.body], [403, { error: 'account_suspended' }]);
    // Suspended owner who is also a working member: signs in as the member; the vendor persona shows suspended.
    const both = await personWithPin('vendor', { accountStatus: 'suspended' });
    const memberId = uid('usr_s2pin');
    await db('User').insert({ id: memberId, userType: 'member', personId: both.personId, accountStatus: 'active', approvalStatus: 'approved', updatedAt: new Date() });
    const session = await pinPost({ phone: both.phone, pin: '4821' });
    assert.equal(session.statusCode, 200, JSON.stringify(session.body));
    assert.equal(session.body.user.id, memberId);
    assert.equal(session.body.personas.find(p => p.userType === 'vendor').accountStatus, 'suspended');
    // An active vendor owner signs in as before.
    const active = await personWithPin('vendor');
    const ok = await pinPost({ phone: active.phone, pin: '4821' });
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.user.userType, 'vendor');
  });
});

// ── UAT re-check: a move on an order cancelled meanwhile → 409 order_cancelled, not order_not_paid ──

test('status move on an order cancelled meanwhile (refund_pending / refunded / own part cancelled) → 409 order_cancelled before the payment check; unpaid still → order_not_paid; cancelling again is a no-op', async () => {
  const w = await world();
  // Vendor cancels the paid pickup order: cancelled + refund_pending.
  assert.ok((await local.updateOrderStatus({ orderId: w.pickup, status: 'cancelled', actorId: w.a, reason: 'Out of stock' })).order);
  const stored = await db('ShopOrder').where({ id: w.pickup }).first();
  assert.deepEqual([stored.status, stored.paymentStatus], ['cancelled', 'refund_pending']);
  for (const status of ['accepted', 'dispatched', 'delivered']) {
    assert.deepEqual(await hit('POST', `/vendor/orders/${w.pickup}/status`, vendorClaims(w.a), { status }), { status: 409, body: { error: 'order_cancelled' } }, status);
  }
  const clerk = await staffOf(w.a, ['orders']);
  assert.deepEqual(await hit('POST', `/vendor/orders/${w.pickup}/status`, staffClaims(clerk, w.a), { status: 'accepted' }), { status: 409, body: { error: 'order_cancelled' } });
  // Refunded afterwards: still order_cancelled.
  await db('ShopOrder').where({ id: w.pickup }).update({ paymentStatus: 'refunded' });
  assert.deepEqual(await hit('POST', `/vendor/orders/${w.pickup}/status`, vendorClaims(w.a), { status: 'accepted' }), { status: 409, body: { error: 'order_cancelled' } });
  // Admins get the same answer.
  assert.deepEqual(await hit('POST', `/vendor/orders/${w.pickup}/status`, { sub: uid('adm'), userType: 'admin' }, { status: 'accepted' }), { status: 409, body: { error: 'order_cancelled' } });
  // Cancelling again changes nothing and is not an error.
  const again = await hit('POST', `/vendor/orders/${w.pickup}/status`, vendorClaims(w.a), { status: 'cancelled' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.orderStatus, 'cancelled');

  // refund_pending on an order not marked cancelled (money owed back): order_cancelled.
  const owed = await paidOrder(w.buyer, [{ productId: w.pa, qty: 1 }]);
  await db('ShopOrder').where({ id: owed }).update({ paymentStatus: 'refund_pending' });
  assert.deepEqual(await local.updateOrderStatus({ orderId: owed, status: 'accepted', actorId: w.a }), { error: 'order_cancelled', status: 409 });
  // Only this vendor's part cancelled: order_cancelled.
  const part = await paidOrder(w.buyer, [{ productId: w.pa, qty: 1 }]);
  const row = await db('ShopOrder').where({ id: part }).first();
  await db('ShopOrder').where({ id: part }).update({ fulfilments: JSON.stringify(row.fulfilments.map(f => ({ ...f, status: 'cancelled' }))) });
  assert.deepEqual(await local.updateOrderStatus({ orderId: part, status: 'accepted', actorId: w.a }), { error: 'order_cancelled', status: 409 });

  // Unpaid and not cancelled: still order_not_paid.
  const unpaid = await local.createOrder({ buyerId: w.buyer, body: { items: [{ productId: w.pa, qty: 1 }], deliveryMethod: 'home_delivery', deliveryAddress: 'x', paymentMethod: 'mpesa' } });
  made.orders.push(unpaid.order.id);
  assert.deepEqual(await hit('POST', `/vendor/orders/${unpaid.order.id}/status`, vendorClaims(w.a), { status: 'accepted' }), { status: 409, body: { error: 'order_not_paid' } });
});

test('status move: an order cancelled between the read and the row lock → 409 order_cancelled (decided under the lock)', async () => {
  const w = await world();
  const store = createPgShopOrderStore({ db });
  const racing = createShopService({
    products, shopOrders, users, auditLog, paymentRequests, buyerRefs: createPgVendorBuyerRefStore({ db }),
    orderStore: { ...store, async updateWithLock(orderId, decide) {
      // Someone cancels the order (FitFlex, buyer) after the move read it and before it takes the lock.
      await db('ShopOrder').where({ id: orderId }).update({ status: 'cancelled', paymentStatus: 'refund_pending' });
      return store.updateWithLock(orderId, decide);
    } },
    onRefundDue: async () => null,
  });
  assert.deepEqual(await racing.updateOrderStatus({ orderId: w.pickup, status: 'accepted', actorId: w.a }), { error: 'order_cancelled', status: 409 });
  const stored = await db('ShopOrder').where({ id: w.pickup }).first();
  assert.equal(stored.fulfilments.find(f => f.vendorId === w.a).status, 'pending', 'nothing moved');
});
