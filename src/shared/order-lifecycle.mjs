// Marketplace order lifecycle — the one place that says which status may follow
// which. Pure functions, no I/O; the service applies them under a row lock.
//
// Canonical flow (per vendor fulfilment):
//
//   pending → accepted → [processing] → [packed] → dispatched → delivered          (home_delivery)
//   pending → accepted → [processing] → [packed] → [dispatched →] ready_for_pickup → delivered   (gym_pickup)
//
// - `processing` and `packed` are bookkeeping stages a vendor may skip; `accepted`,
//   the hand-over stage (`dispatched` / `ready_for_pickup`) and `delivered` may not be skipped.
// - Cancelling is separate (see canCancelFrom): allowed until `delivered`.
// - `delivered` and `cancelled` are terminal. Returns and refunds are their own workflow.
// - Repeating the status an order is already in is a no-op, not an error.
//
// Legacy compatibility (older clients and old rows):
// - input `confirmed` means `accepted` and is stored as `confirmed`; a stored `confirmed` is `accepted`.
// - input `fulfilled` means `delivered` and is stored as `delivered`. It remains a completion
//   shortcut from any accepted-or-later stage, because that is the documented two-step contract
//   (pending → confirmed → fulfilled). It is not part of the canonical flow.

export const STATUSES = ['pending', 'accepted', 'processing', 'packed', 'dispatched', 'ready_for_pickup', 'delivered', 'cancelled'];
export const LEGACY_INPUTS = ['confirmed', 'fulfilled'];
export const TERMINAL = new Set(['delivered', 'cancelled']);

/** Where an order sits on its way to the customer; used to combine vendors' progress. */
const RANK = { pending: 0, confirmed: 1, accepted: 1, processing: 2, packed: 3, dispatched: 4, ready_for_pickup: 5, delivered: 6, fulfilled: 6 };

/** A stored status as its canonical name (legacy rows). */
export function canonicalStatus(status) {
  if (status === 'confirmed') return 'accepted';
  if (status === 'fulfilled') return 'delivered';
  return status;
}

const FORWARD = {
  pending: ['accepted'],
  accepted: ['processing', 'packed', 'dispatched', 'ready_for_pickup'],
  processing: ['packed', 'dispatched', 'ready_for_pickup'],
  packed: ['dispatched', 'ready_for_pickup'],
  dispatched: ['ready_for_pickup', 'delivered'],
  ready_for_pickup: ['delivered'],
  delivered: [],
  cancelled: [],
};

/** The statuses that may follow `from` for an order delivered this way (cancelling excluded). */
export function nextStatuses(from, deliveryMethod = 'home_delivery') {
  const list = FORWARD[canonicalStatus(from)] || [];
  if (deliveryMethod === 'gym_pickup') {
    // Goods may reach the gym (dispatched) but are handed over only once ready for pickup.
    return list.filter(s => !(canonicalStatus(from) === 'dispatched' && s === 'delivered'));
  }
  return list.filter(s => s !== 'ready_for_pickup');
}

/** Cancelling is possible from every status that is not terminal. */
export const canCancelFrom = (from) => !TERMINAL.has(canonicalStatus(from));

/**
 * Decide a requested move for one fulfilment.
 *   → { ok: true, noop?: true, store }   `store` is the status to write
 *   → { ok: false, error, allowed }      allowed: the statuses that could follow
 * `to` may be a canonical status or a legacy input.
 */
export function decideTransition({ from, to, deliveryMethod = 'home_delivery' }) {
  const current = canonicalStatus(from);
  if (!STATUSES.includes(current)) return { ok: false, error: 'unknown_current_status', allowed: [] };
  if (!STATUSES.includes(to) && !LEGACY_INPUTS.includes(to)) return { ok: false, error: 'invalid_status', allowed: nextStatuses(current, deliveryMethod) };
  const target = canonicalStatus(to);
  // Saying what is already true changes nothing (so a repeated cancel is not an error).
  if (target === current) return { ok: true, noop: true, store: from };
  if (to === 'cancelled') return canCancelFrom(current) ? { ok: true, store: 'cancelled' } : { ok: false, error: 'status_is_final', allowed: [] };
  if (TERMINAL.has(current)) return { ok: false, error: 'status_is_final', allowed: [] };
  const allowed = nextStatuses(current, deliveryMethod);
  if (allowed.includes(target)) return { ok: true, store: to === 'confirmed' ? 'confirmed' : target };
  // The legacy completion shortcut (see the header).
  if (to === 'fulfilled' && current !== 'pending') return { ok: true, store: 'delivered' };
  return { ok: false, error: 'invalid_transition', allowed };
}

/**
 * The customer-facing status of an order made of several vendors' fulfilments: the
 * least advanced of the live ones (what is still outstanding), `delivered` only when
 * every fulfilment is delivered, `cancelled` only when every one is cancelled.
 */
export function combinedStatus(fulfilments) {
  const list = Array.isArray(fulfilments) ? fulfilments : [];
  if (!list.length) return null;
  const live = list.filter(f => canonicalStatus(f.status) !== 'cancelled');
  if (!live.length) return 'cancelled';
  return live.reduce((low, f) => (RANK[f.status] ?? 0) < (RANK[low.status] ?? 0) ? f : low).status;
}

/** True when at least one fulfilment has reached `status` or beyond (e.g. already on its way). */
export const anyAtLeast = (fulfilments, status) =>
  (fulfilments || []).some(f => canonicalStatus(f.status) !== 'cancelled' && (RANK[f.status] ?? 0) >= RANK[status]);

/**
 * An order's per-vendor fulfilments. Orders made before fulfilments existed have none stored:
 * they are derived, one per vendor, at the order's own status.
 */
export function fulfilmentsOf(order, vendorIds = []) {
  if (Array.isArray(order?.fulfilments) && order.fulfilments.length) return order.fulfilments;
  const fromItems = [...new Set((order?.items || []).map(item => item.vendorId).filter(Boolean))];
  const ids = fromItems.length ? fromItems : vendorIds;
  return ids.map(vendorId => ({ vendorId, status: order?.status || 'pending', timeline: [], updatedAt: order?.updatedAt || null }));
}
