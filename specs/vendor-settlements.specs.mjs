// Vendor payouts: FitFlex takes a commission fixed on each order line when
// the order is placed; a vendor is paid weekly for delivered orders, through
// a statement approved by a second person and paid only to a verified payout
// account. A vendor's share of an order is paid once.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { users, gyms, partnerGate, trainers } from '../src/bootstrap/services.mjs';
import { partnerSettlementAccounts } from '../src/bootstrap/collections.mjs';
import { ensureInit } from '../functions/index.mjs';
import { createPayoutEligibility } from '../src/services/payout-eligibility.mjs';
import { createVendorSettlementService, deliveredOn } from '../src/services/vendor-settlement-service.mjs';
import { createShopService } from '../src/services/shop-service.mjs';
import { vendorCommissionPct, priceOrderLine, vendorShareOfOrder, VENDOR_COMMISSION_PCT } from '../src/shared/marketplace-pricing.mjs';

await ensureInit();

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const NOW = new Date('2026-10-14T09:00:00Z'); // a Wednesday; last ended week = 5–11 Oct
const WEEK = { periodStartDate: '2026-10-05', periodEndDate: '2026-10-11' };
const made = { users: [], orders: [] };
const inbox = [];
let clock = NOW;

const eligibility = createPayoutEligibility({ users, gyms, partnerGate, partnerSettlementAccounts, trainers });
const svc = createVendorSettlementService({
  users, payoutEligibility: eligibility, now: () => clock,
  notify: async (userId, message) => { inbox.push({ userId, ...message }); },
});

async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Payout ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}

/** A vendor; `verified` gives them approved KYC and a payout account past its hold. */
async function vendor({ verified = true } = {}) {
  const id = await user('vendor', { vendorProfile: JSON.stringify({ businessName: `Shop ${randomUUID().slice(0, 4)}`, status: 'published' }) });
  if (verified) {
    const caseId = uid('kyc');
    await db('PartnerKycCase').insert({ id: caseId, partnerType: 'vendor', userId: id, status: 'approved', tier: 3, updatedAt: new Date() });
    await db('PartnerSettlementAccount').insert({
      id: uid('psa'), caseId, method: 'bank', provider: 'CRDB', accountName: 'Shop Ltd', accountNumber: '0150001234',
      status: 'verified', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z'), cooldownUntil: new Date('2026-09-03T00:00:00Z'), updatedAt: new Date(),
    });
  }
  return id;
}

/** An order with lines priced at 10% commission, delivered on `deliveredAt`. */
async function order({ buyerId, lines, status = 'delivered', paymentStatus = 'paid', deliveredAt = '2026-10-07T10:00:00Z' }) {
  const id = uid('ord');
  const items = lines.map(([vendorId, priceTzs, qty]) => ({ productId: uid('prd'), vendorId, name: 'Item', qty, priceTzs, ...priceOrderLine({ priceTzs, qty, commissionPct: 10 }) }));
  const timeline = [{ status: 'pending', at: '2026-10-05T08:00:00Z' }, ...(status === 'delivered' ? [{ status: 'delivered', at: deliveredAt }] : [])];
  await db('ShopOrder').insert({
    id, buyerId, buyerRole: 'member', items: JSON.stringify(items), totalTzs: items.reduce((s, i) => s + i.priceTzs * i.qty, 0),
    status, paymentStatus, paymentMethod: 'mpesa', deliveryMethod: 'home_delivery', deliveryAddress: 'Sinza',
    timeline: JSON.stringify(timeline), settlementStatus: 'pending', createdAt: new Date('2026-10-05T08:00:00Z'), updatedAt: new Date(deliveredAt),
  });
  made.orders.push(id);
  return id;
}

const mine = (statements, vendorId) => statements.filter(s => s.vendorId === vendorId);
const statementOf = async (vendorId, periodStartDate = WEEK.periodStartDate) =>
  db('VendorSettlement').where({ vendorId, periodStartDate }).whereNot({ status: 'voided' }).first();

after(async () => {
  // Paid and voided statements are final by design, so they stay; what they point at goes.
  await db('VendorSettlement').whereIn('vendorId', made.users).where({ status: 'draft' }).del();
  if (made.orders.length) await db('ShopOrder').whereIn('id', made.orders).del();
  if (made.users.length) {
    await db('AuditLog').whereIn('actor', made.users).del();
    await db('User').whereIn('id', made.users).del();
  }
});

// ── Commission ──────────────────────────────────────────────────────────────

test('commission is 10% unless staff set a vendor\'s rate, and is kept within 0–30%', () => {
  assert.deepEqual(VENDOR_COMMISSION_PCT, { default: 10, min: 0, max: 30 });
  assert.equal(vendorCommissionPct({}), 10);
  assert.equal(vendorCommissionPct({ vendorProfile: { commissionPct: 12.5 } }), 12.5);
  assert.equal(vendorCommissionPct({ vendorProfile: { commissionPct: 0 } }), 0, 'a zero rate is a real rate');
  assert.equal(vendorCommissionPct({ vendorProfile: { commissionPct: 80 } }), 30);
  assert.deepEqual(priceOrderLine({ priceTzs: 40000, qty: 2, commissionPct: 10 }), { salesTzs: 80000, commissionPct: 10, commissionTzs: 8000, vendorPayoutTzs: 72000 });
  // An order line from before commission existed pays the vendor in full.
  const legacy = { items: [{ vendorId: 'v1', priceTzs: 5000, qty: 2 }, { vendorId: 'v2', priceTzs: 9000, qty: 1 }] };
  assert.deepEqual(vendorShareOfOrder(legacy, 'v1'), { itemCount: 2, salesTzs: 10000, commissionTzs: 0, payoutTzs: 10000 });
});

test('an order fixes each line\'s commission at its vendor\'s rate; staff change a rate for later orders only', async () => {
  const mem = (rows = []) => ({
    rows,
    async filterAsync(fn) { return rows.filter(fn); }, async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; }, async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) { const i = rows.findIndex(r => r.id === id); if (i >= 0) rows[i] = { ...rows[i], ...patch }; return rows[i] || null; },
    async upsertAsync(fn, row) { const i = rows.findIndex(fn); if (i >= 0) rows[i] = { ...rows[i], ...row }; else rows.push(row); return row; },
  });
  const people = mem([{ id: 'ven_a', userType: 'vendor', vendorProfile: { businessName: 'A', commissionPct: 15 } }, { id: 'ven_b', userType: 'vendor' }]);
  const products = mem([
    { id: 'p_a', vendorId: 'ven_a', name: 'Belt', priceTzs: 20000, stock: 9, status: 'active', approvalStatus: 'approved' },
    { id: 'p_b', vendorId: 'ven_b', name: 'Whey', priceTzs: 50000, discountPriceTzs: 40000, stock: 9, status: 'active', approvalStatus: 'approved' },
  ]);
  const shop = createShopService({ products, shopOrders: mem(), users: people, auditLog: { async insertAsync() {} }, marketplaceNotifications: mem() });
  const body = { items: [{ productId: 'p_a', qty: 1 }, { productId: 'p_b', qty: 2 }], deliveryMethod: 'home_delivery', deliveryAddress: 'Sinza', paymentMethod: 'mpesa' };

  const first = (await shop.createOrder({ buyerId: 'm1', body })).order;
  const [belt, whey] = first.items;
  assert.deepEqual([belt.commissionPct, belt.commissionTzs, belt.vendorPayoutTzs], [15, 3000, 17000]);
  // The vendor's own discount is theirs: commission is on the 40,000 sale price.
  assert.deepEqual([whey.priceTzs, whey.commissionPct, whey.commissionTzs, whey.vendorPayoutTzs], [40000, 10, 8000, 72000]);

  assert.deepEqual(await shop.adminUpdateVendor({ vendorId: 'ven_b', body: { commissionPct: 45 }, actorId: 'adm' }), { error: 'invalid_commission', status: 400, min: 0, max: 30 });
  const updated = await shop.adminUpdateVendor({ vendorId: 'ven_b', body: { commissionPct: 12 }, actorId: 'adm' });
  assert.equal(updated.vendor.vendorProfile.commissionPct, 12);
  // The vendor can't change their own rate by saving their profile.
  await shop.saveVendorProfile({ vendorId: 'ven_b', body: { businessName: 'B', commissionPct: 0 } });
  assert.equal((await people.findByIdAsync('ven_b')).vendorProfile.commissionPct, 12);

  const second = (await shop.createOrder({ buyerId: 'm1', body })).order;
  assert.equal(second.items[1].commissionPct, 12);
  assert.equal(first.items[1].commissionPct, 10, 'the earlier order keeps its rate');
});

// ── The whole path ──────────────────────────────────────────────────────────

test('delivered orders are prepared, approved by a second person, paid, and marked settled', async () => {
  clock = NOW;
  const buyerId = await user('member');
  const [a, other] = [await vendor(), await vendor()];
  const [maker, checker] = [await user('admin'), await user('admin')];
  const solo = await order({ buyerId, lines: [[a, 40000, 2]] });                                   // 80,000 → 72,000
  const shared = await order({ buyerId, lines: [[a, 10000, 1], [other, 30000, 1]], deliveredAt: '2026-10-11T20:30:00Z' }); // Sunday 23:30 EAT
  await order({ buyerId, lines: [[a, 99000, 1]], deliveredAt: '2026-10-11T21:30:00Z' });           // Monday 00:30 EAT: next week
  await order({ buyerId, lines: [[a, 5000, 1]], status: 'dispatched' });                           // not delivered yet
  await order({ buyerId, lines: [[a, 7000, 1]], status: 'cancelled', paymentStatus: 'refunded' }); // refunded

  assert.equal(deliveredOn({ timeline: [{ status: 'delivered', at: '2026-10-11T21:30:00Z' }] }), '2026-10-12');
  assert.equal((await svc.prepare({ periodStart: '2026-10-07', actorId: maker })).error, 'period_must_start_on_monday');
  assert.equal((await svc.prepare({ periodStart: '2026-10-12', actorId: maker })).error, 'week_not_ended');

  const prepared = await svc.prepare({ actorId: maker });
  const [draft] = mine(prepared.statements, a);
  assert.deepEqual([draft.orderCount, draft.finalNetTzs], [2, 81000]);
  assert.deepEqual(mine(prepared.statements, other).map(s => [s.orderCount, s.finalNetTzs]), [[1, 27000]]);

  const detail = await svc.get(draft.id);
  assert.deepEqual([detail.statement.salesTzs, detail.statement.commissionTzs, detail.statement.finalNetTzs], [90000, 9000, 81000]);
  assert.match(detail.statement.vendor.businessName, /^Shop /);
  assert.deepEqual(detail.lines.map(l => [l.orderId, l.salesTzs, l.payoutTzs, l.deliveredOn]).sort(), [[solo, 80000, 72000, '2026-10-07'], [shared, 10000, 9000, '2026-10-11']].sort());
  assert.equal(detail.payout.ok, true);
  assert.equal((await svc.listMine({ vendorId: a })).statements.length, 0, 'a draft is not shown to the vendor');

  await svc.submit({ id: draft.id, actorId: maker });
  assert.deepEqual(await svc.approve({ id: draft.id, actorId: maker }), { error: 'cannot_approve_own_submission', status: 403 });
  await svc.approve({ id: draft.id, actorId: checker });
  await svc.hold({ id: draft.id, reason: 'Buyer reports a missing item', actorId: maker });
  assert.equal((await svc.markPayable({ id: draft.id, actorId: checker })).error, 'on_hold');
  await svc.release({ id: draft.id, actorId: checker });
  assert.equal((await svc.markPayable({ id: draft.id, actorId: checker })).statement.status, 'payable');
  assert.equal((await svc.pay({ id: draft.id, actorId: checker })).error, 'payment_reference_required');
  const paid = await svc.pay({ id: draft.id, paymentReference: 'CRDB-V1', actorId: checker });
  assert.deepEqual([paid.statement.status, paid.statement.paymentReference], ['paid', 'CRDB-V1']);

  // The vendor is told; the orders are settled.
  const note = inbox.find(n => n.userId === a);
  assert.equal(note.type, 'vendor_payout_paid');
  assert.match(note.body, /TZS 81,000 for 2 order\(s\).*CRDB-V1/);
  assert.equal((await db('ShopOrder').where({ id: solo }).first()).settlementStatus, 'settled');

  // The vendor sees it, without staff ids or the buyer's id.
  const view = await svc.listMine({ vendorId: a });
  assert.deepEqual([view.payoutReady, view.statements[0].status, view.statements[0].paidTo.accountLast4], [true, 'paid', '1234']);
  assert.ok(!('paidBy' in view.statements[0]));
  const own = await svc.getMine({ vendorId: a, id: draft.id });
  assert.equal(own.lines.length, 2);
  assert.ok(own.lines.every(l => !('buyerId' in l)));
  assert.equal((await svc.getMine({ vendorId: other, id: draft.id })).error, 'statement_not_found');
  await assert.rejects(db('VendorSettlement').where({ id: draft.id }).update({ finalNetTzs: 1 }), /final/);

  // Next week: nothing is paid twice; the Monday delivery is picked up.
  clock = new Date(+NOW + 7 * 86_400_000);
  const next = await svc.prepare({ actorId: maker });
  assert.deepEqual(mine(next.statements, a).map(s => [s.orderCount, s.finalNetTzs]), [[1, 89100]]);
});

test('a vendor without approved KYC and a verified payout account cannot be cleared for payment', async () => {
  clock = NOW;
  const buyerId = await user('member');
  const b = await vendor({ verified: false });
  const [maker, checker] = [await user('admin'), await user('admin')];
  await order({ buyerId, lines: [[b, 20000, 1]] });
  await svc.prepare({ actorId: maker });
  const draft = await statementOf(b);
  await svc.submit({ id: draft.id, actorId: maker });
  await svc.approve({ id: draft.id, actorId: checker });
  assert.deepEqual(await svc.markPayable({ id: draft.id, actorId: checker }), { error: 'not_payable', status: 409, reason: 'kyc_not_started' });
  assert.deepEqual([(await svc.listMine({ vendorId: b })).payoutReady, (await svc.listMine({ vendorId: b })).payoutBlockedBy], [false, 'kyc_not_started']);
  assert.equal((await eligibility.forVendor('usr_nobody')).reason, 'no_vendor_account');
});

test('voiding releases the orders for the next statement; the database keeps a share on one live statement', async () => {
  clock = NOW;
  const buyerId = await user('member');
  const c = await vendor();
  const [maker, checker] = [await user('admin'), await user('admin')];
  const first = await order({ buyerId, lines: [[c, 30000, 1]] });
  await svc.prepare({ actorId: maker });
  const draft = await statementOf(c);
  await svc.submit({ id: draft.id, actorId: maker });
  // A delivery recorded after submission waits for the next statement.
  const late = await order({ buyerId, lines: [[c, 10000, 1]], deliveredAt: '2026-10-09T10:00:00Z' });
  assert.equal(mine((await svc.prepare({ actorId: maker })).statements, c).length, 0);

  assert.equal((await svc.voidStatement({ id: draft.id, actorId: checker })).error, 'reason_required');
  assert.equal((await svc.voidStatement({ id: draft.id, reason: 'Wrong orders', actorId: checker })).statement.status, 'voided');
  const [fresh] = mine((await svc.prepare({ actorId: maker })).statements, c);
  assert.deepEqual([fresh.orderCount, fresh.finalNetTzs], [2, 36000]);

  await assert.rejects(db('VendorSettlementLine').insert({ id: randomUUID(), vendorSettlementId: fresh.id, vendorId: c, orderId: first, deliveredOn: '2026-10-07', payoutTzs: 1 }), /vendor_settlement_line_order_ux/);
  await assert.rejects(db('VendorSettlement').where({ id: fresh.id }).update({ status: 'paid', paidAt: new Date(), paymentReference: 'X', destinationSnapshot: '{}' }), /not an allowed transition/);
  assert.equal((await svc.list({ status: 'nope' })).error, 'invalid_status');
  assert.ok((await svc.list({ vendorId: c })).statements.some(s => s.status === 'voided'));
  assert.ok(late);
});
