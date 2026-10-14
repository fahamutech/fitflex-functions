# Marketplace order state machine

Implemented in `src/shared/order-lifecycle.mjs` (pure rules) and applied by
`shopService.updateOrderStatus` under the order's row lock. Tested by
`specs/shop-order-lifecycle.specs.mjs` (hand-written expected matrix, every
status pair, both delivery methods) and `specs/shop-fulfilment.specs.mjs`
(real Postgres: races, vendor isolation, authorisation).

## Model

An order has **one fulfilment per vendor** (`ShopOrder.fulfilments`, jsonb).
A vendor moves only their own fulfilment. `ShopOrder.status` is the combined,
customer-facing status: the **least advanced live fulfilment**; `delivered` only
when every fulfilment is delivered; `cancelled` only when all are.

Payment is a separate axis (`paymentStatus`): `pending | paid | failed | cancelled | refund_pending | refunded`.
Fulfilment moves require `paymentStatus = paid` (cancelling does not).

## Transitions (per fulfilment)

```
home_delivery   pending → accepted → [processing] → [packed] → dispatched → delivered
gym_pickup      pending → accepted → [processing] → [packed] → [dispatched →] ready_for_pickup → delivered
                any non-terminal status → cancelled
```

| from \ to | accepted | processing | packed | dispatched | ready_for_pickup | delivered |
|---|---|---|---|---|---|---|
| pending | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| accepted | – | ✔ | ✔ | ✔ | pickup only | ✘ |
| processing | ✘ | – | ✔ | ✔ | pickup only | ✘ |
| packed | ✘ | ✘ | – | ✔ | pickup only | ✘ |
| dispatched | ✘ | ✘ | ✘ | – | pickup only | home only |
| ready_for_pickup | ✘ | ✘ | ✘ | ✘ | – | ✔ |
| delivered | ✘ | ✘ | ✘ | ✘ | ✘ | – (final) |
| cancelled | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ (final) |

Rules:

- `processing` and `packed` are optional bookkeeping stages; `accepted`, the hand-over (`dispatched` / `ready_for_pickup`) and `delivered` cannot be skipped.
- A home-delivery order cannot be `ready_for_pickup`. A pickup order that was `dispatched` (goods sent to the gym) must pass `ready_for_pickup` before `delivered`.
- **Repeating** the current status is a no-op: `200`, nothing written, no second timeline or audit entry.
- **Final**: `delivered` and `cancelled` are never left through this route. Returns and refunds of delivered orders are a separate workflow (PR 3).
- Anything else → `409 invalid_transition` with `from`, `to` and `allowed`; `409 order_status_final` for a final fulfilment.

## Cancellation

| Who | When | Effect |
|---|---|---|
| buyer | until any vendor has dispatched / is ready for pickup | whole order; paid → `refund_pending` + one refund |
| vendor | until delivered, **single-vendor orders only** | whole order; paid → refund (`vendor_cancelled`) |
| vendor, several vendors | — | `409 multi_vendor_cancel_requires_admin` |
| admin (scope `shop`) | until any vendor has delivered | whole order; refund (`cancelled_by_fitflex`); optional `reason` kept |
| anyone | once any vendor has delivered | `409 order_partly_delivered` |

Cancelling cancels every vendor's fulfilment, restocks once, withdraws an
unpaid payment request. The rule is judged under the same lock as the change,
so a delivery and a cancel sent together cannot both succeed.

**Why vendors cannot cancel one vendor's part of a mixed order:** that needs a
partial refund, and the refund model is one refund per order. That is a
financial-model decision (D-6 in the readiness document), not a code detail.

## Authorisation

| Actor | Rule |
|---|---|
| vendor / vendor staff | must have a line in the order, and may move only their own fulfilment; staff need the `orders` permission (checked server-side against the staff record) and act for their own vendor only (`vendorId` comes from the verified token, never the request) |
| suspended vendor | `403 vendor_suspended` |
| other vendor | `403 order_not_owned_by_vendor` — also for orders they have no line in |
| admin | needs ACL scope `shop` (super-admin unrestricted). `vendorId` is required when the order has several vendors (`400 vendor_required`); `404 vendor_not_in_order` otherwise. Admins follow the same matrix: there is no force-override in this PR |
| buyer | cancel only (own orders) |

What a vendor receives for an order is a **view**: only their own lines and subtotal,
`status` = their fulfilment's status, `orderStatus` = combined, `nextStatuses`, and
their own timeline. Other vendors' lines, commissions, payouts and statuses are not shown.

## Audit trail

Every change writes an `AuditLog` row (`shop_order_<status>`): actor, previous status,
new status, vendor, actor role, optional reason. Each fulfilment keeps its own timeline
entries (`status, at, by, actorId, reason?`); the order's timeline gets one entry per move
with the vendor it concerns.

## Legacy states

| Legacy | Treatment |
|---|---|
| stored `confirmed` | equals `accepted` for every rule; shown as stored |
| input `confirmed` | means `accepted`, stored as `confirmed` (as before) |
| input `fulfilled` | means `delivered`, stored `delivered`. **Kept as a completion shortcut** from any accepted-or-later stage (not from `pending`), because the route's documented contract was `pending → confirmed → fulfilled` |
| rows without `fulfilments` | derived on first change: one per vendor, at the order's own status (lines without a vendor resolve through their product) |
| `fulfilled` rows in settlement | still counted as delivered by `vendor-settlement-service` |

The `fulfilled` shortcut is the one place the "no skipping" rule is relaxed. Remove
it when no client uses it (the current mobile app and portal do not).

## Consumers

| Consumer | Uses | Status |
|---|---|---|
| mobile vendor app | `status` step-by-step; `_nextOrderStatus` | compatible (strict sequence); now sees its own fulfilment status |
| mobile buyer app / `canCancel` | `status` (combined) + `canCancel` | compatible; `canCancel` still from the combined status, the server also refuses when any vendor dispatched |
| vendor settlement | `status IN (delivered, fulfilled)` and paid, on the whole order | unchanged: a mixed order is paid out once **every** vendor has delivered (conservative; per-vendor payout is PR 5) |
| reviews / invoice / reorder | combined status | unchanged |
| notifications | `order_<status>` to the buyer on every move (now includes `vendorId`) | compatible |
| promotions | paid / cancelled hooks | unchanged |
