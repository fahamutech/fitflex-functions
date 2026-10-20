// Vendor tools · S2 — what a vendor may see of a marketplace order (plan §3, privacy rule A-02).
//
// An allowlist: only the keys built below ever leave the server for a vendor, whatever the stored
// order carries. Never: buyerId, buyerRole, email, paymentReference, other vendors' lines or totals,
// lines without a vendorId (older rows), fulfilments, idempotency, reservation or settlement internals.
//
// Pure functions: the caller looks up the buyer, the pickup gym and the vendor-scoped customer id.
import { fulfilmentsOf, canonicalStatus, nextStatuses } from './order-lifecycle.mjs';

const EAT_OFFSET_MS = 3 * 3_600_000; // Africa/Dar_es_Salaam, UTC+3, no daylight saving
const DAY_MS = 86_400_000;
export const CONTACT_DAYS_AFTER_DELIVERY = 7;

/** The EAT calendar day ("YYYY-MM-DD") an instant falls on. */
export function eatDate(instant) {
  if (instant === null || instant === undefined || instant === '') return null;
  const t = +new Date(instant);
  return Number.isFinite(t) ? new Date(t + EAT_OFFSET_MS).toISOString().slice(0, 10) : null;
}

/** "Today" in EAT and the UTC instants it starts and ends (end exclusive). */
export function eatDayBounds(day) {
  const start = Date.parse(`${day}T00:00:00.000Z`) - EAT_OFFSET_MS;
  return { start, end: start + DAY_MS };
}

/** Q-8: no human order number yet; both apps show the last 6 characters, uppercase. */
export const shortRef = id => String(id || '').slice(-6).toUpperCase();

/** This vendor's own lines: only lines that name this vendor (lines without a vendorId are never shown). */
export const ownLines = (order, vendorId) => (order?.items || []).filter(item => item && item.vendorId != null && item.vendorId === vendorId);

const latestDelivered = entries => [...entries].reverse().find(entry => canonicalStatus(entry?.status) === 'delivered' && entry.at)?.at || null;

/**
 * When this vendor's part was delivered: the latest delivered (or legacy fulfilled) entry of their
 * fulfilment's timeline, else of the order's timeline (entries with no vendorId or this vendor's).
 * Never a last-change time (updatedAt): settlement or any other write must not reopen the window.
 * null = unknown → the window is closed.
 */
function deliveredAt(own, order, vendorId) {
  const fromOwn = latestDelivered(Array.isArray(own?.timeline) ? own.timeline : []);
  if (fromOwn) return fromOwn;
  const orderEntries = (Array.isArray(order?.timeline) ? order.timeline : []).filter(entry => entry && (entry.vendorId == null || entry.vendorId === vendorId));
  return latestDelivered(orderEntries);
}

/**
 * O-3 contact window for this vendor's part of the order.
 *  - own part open (not delivered, not cancelled) and the order paid → open, no end date yet (until null);
 *  - own part delivered and the order paid → open through the end of the 7th EAT day after the
 *    EAT day of delivery: until = that day at 23:59:59 EAT (inclusive); delivery time unknown → closed;
 *  - otherwise (unpaid, refund pending/refunded, cancelled) → closed.
 * → { open: boolean, until: string|null }  (until = ISO with +03:00 offset)
 */
export function contactWindow(order, vendorId, now = new Date()) {
  if (!order || order.paymentStatus !== 'paid' || order.status === 'cancelled') return { open: false, until: null };
  const own = fulfilmentsOf(order).find(f => f.vendorId === vendorId);
  const status = canonicalStatus(own?.status || order.status);
  if (status === 'cancelled') return { open: false, until: null };
  if (status !== 'delivered') return { open: true, until: null };
  const day = eatDate(deliveredAt(own, order, vendorId));
  if (!day) return { open: false, until: null };
  const lastDay = new Date(Date.parse(`${day}T00:00:00.000Z`) + CONTACT_DAYS_AFTER_DELIVERY * DAY_MS).toISOString().slice(0, 10);
  const { end } = eatDayBounds(lastDay);
  return { open: +new Date(now) < end, until: `${lastDay}T23:59:59+03:00` };
}

/**
 * The vendor's view of one order.
 * @param order      the stored order
 * @param vendorId   whose view
 * @param ctx.customerId   vendor-scoped, stable pseudonym of the buyer
 * @param ctx.buyer        the buyer's user row (or null) — only displayName and phone are read
 * @param ctx.gym          the pickup gym row (or null) — only id and name are read
 * @param ctx.seesMoney    commissionTzs / vendorPayoutTzs on lines (Q-5)
 * @param ctx.contactOn    VENDOR_ORDER_BUYER_CONTACT
 * @param ctx.now
 */
export function vendorOrderView(order, vendorId, { customerId = null, buyer = null, gym = null, seesMoney = false, contactOn = false, customerLinked = false, now = new Date() } = {}) {
  const mine = ownLines(order, vendorId);
  const own = fulfilmentsOf(order).find(f => f.vendorId === vendorId);
  const status = own?.status || order.status;
  const timelineSource = own?.timeline?.length
    ? own.timeline
    // No fulfilment record (older order): the order's own entries that are not about another vendor.
    : (Array.isArray(order.timeline) ? order.timeline : []).filter(entry => entry && (entry.vendorId == null || entry.vendorId === vendorId));
  const window = contactWindow(order, vendorId, now);
  const items = mine.map(item => ({
    productId: item.productId ?? null,
    name: item.name ?? null,
    variant: item.variant ?? null,
    qty: Number(item.qty || 0),
    priceTzs: Number(item.priceTzs || 0),
    image: item.image ?? null,
    ...(seesMoney ? { commissionTzs: item.commissionTzs ?? null, vendorPayoutTzs: item.vendorPayoutTzs ?? null } : {}),
  }));
  const view = {
    id: order.id,
    shortRef: shortRef(order.id),
    createdAt: order.createdAt ?? null,
    status,
    orderStatus: order.status,
    nextStatuses: order.status === 'cancelled' || order.paymentStatus !== 'paid' ? [] : nextStatuses(status, order.deliveryMethod),
    timeline: timelineSource.map(entry => ({ status: entry.status, at: entry.at ?? null, ...(entry.reason ? { reason: String(entry.reason) } : {}) })),
    items,
    totalTzs: items.reduce((sum, item) => sum + item.priceTzs * item.qty, 0),
    paymentStatus: order.paymentStatus ?? null,
    paymentMethod: order.paymentMethod ?? null,
    deliveryMethod: order.deliveryMethod ?? null,
    note: order.note ?? null,
    // Kept for app builds that read it (they show the id); new clients use pickupGym.
    pickupGymId: order.pickupGymId ?? null,
    pickupGym: order.pickupGymId ? { id: order.pickupGymId, name: gym?.name ?? null } : null,
    // customerLinked (S4): a vendor customer record exists for this buyer and VENDOR_CUSTOMERS is on.
    buyer: { customerId, displayName: buyer?.displayName ?? null, customerLinked: !!(customerId && customerLinked) },
  };
  if (window.open) {
    // The delivery address is what the vendor needs to deliver: shown while their part is open and
    // paid and for 7 days after delivery, flag or not (app builds on main read it to deliver).
    if (order.deliveryMethod === 'home_delivery' && order.deliveryAddress) view.deliveryAddress = order.deliveryAddress;
    if (contactOn) {
      view.buyer.phone = buyer?.phone ?? null;
      view.buyer.contactVisibleUntil = window.until;
    }
  }
  return view;
}

// ── paging (GET /vendor/orders?limit=&cursor=) ───────────────────────────────
export const ORDERS_PAGE_DEFAULT = 50;
export const ORDERS_PAGE_MAX = 200;

/** Opaque cursor for keyset paging over (createdAt desc, id desc). */
export const encodeOrderCursor = order => Buffer.from(JSON.stringify({ c: order.createdAt, i: order.id })).toString('base64url');
/** → { createdAt, id } or null when it is not a cursor this server made. */
export function decodeOrderCursor(cursor) {
  try {
    const { c, i } = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof i !== 'string' || !i || typeof c !== 'string' || !Number.isFinite(Date.parse(c))) return null;
    return { createdAt: new Date(c).toISOString(), id: i };
  } catch { return null; }
}

// ── tabs and counts (GET /vendor/orders?limit=… → counts) ────────────────────
/**
 * Which Orders tab one order falls in for this vendor (their own part), first rule that matches:
 *   'cancelled' — own status cancelled, or the order cancelled, or paymentStatus refund_pending | refunded
 *   'delivered' — own status delivered (legacy: fulfilled)
 *   'open'      — paid (paymentStatus 'paid') and own status anything else
 *   'unpaid'    — the rest (payment not confirmed yet): shown under All only
 * The Postgres store counts with the same rules in SQL (shop-order-store-pg countsForVendor).
 */
export function orderTab(order, vendorId) {
  const own = fulfilmentsOf(order).find(f => f.vendorId === vendorId);
  const status = own?.status || order.status;
  if (status === 'cancelled' || order.status === 'cancelled' || ['refund_pending', 'refunded'].includes(order.paymentStatus)) return 'cancelled';
  if (canonicalStatus(status) === 'delivered') return 'delivered';
  if (order.paymentStatus === 'paid') return 'open';
  return 'unpaid';
}
/** waitingAccept: an 'open' order whose own status is still pending (paid, not accepted yet). */
export const isWaitingAccept = (order, vendorId) => orderTab(order, vendorId) === 'open'
  && (fulfilmentsOf(order).find(f => f.vendorId === vendorId)?.status || order.status) === 'pending';
/** Counts over a list of orders (memory store; the Postgres store does this in SQL). */
export function countOrders(orders, vendorId) {
  const counts = { open: 0, delivered: 0, cancelled: 0, all: 0, waitingAccept: 0 };
  for (const order of orders) {
    counts.all++;
    const tab = orderTab(order, vendorId);
    if (tab !== 'unpaid') counts[tab]++;
    if (isWaitingAccept(order, vendorId)) counts.waitingAccept++;
  }
  return counts;
}
