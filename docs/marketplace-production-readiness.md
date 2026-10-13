# Marketplace production readiness

Status as of 2026-10-13, after **PR 1 (checkout and inventory integrity)** and
**PR 2 (order state machine and vendor-scoped fulfilment)**.
Outcome so far: **NOT READY** — payments, refunds, reconciliation, the mobile
client and settlement controls are not yet reviewed or fixed (PR 3–5). See "Outcome".

Evidence rules for this document: a defect is **confirmed** only if it was
reproduced by a test or read directly in the code at the cited location. Anything
not yet inspected is listed under "Not yet inspected", not assumed fine.

## 1. Scope and repositories

| Repo | Role | Status |
|---|---|---|
| `fitflex-functions` | API, rules, migrations, tests | inspected; PR 1 implemented here |
| `fitflexmobile` | cart, checkout, order tracking (`lib/shared/widgets/shop_browse_page.dart`) | **not yet inspected** (PR 4) |
| `fitflex-portal` | vendor and admin operations | **not yet inspected** (PR 2/5) |

## 2. Architecture and request flow (as built)

```
mobile ─ POST /me/shop-orders ─▶ functions/shop.mjs ─▶ shopService.createOrder
                                                         │  (src/services/shop-service.mjs)
                                                         ▼
                                              orderStore.placeOrder  ── one DB transaction ──▶ Product (stock)
                                              (src/infra/shop-order-store-pg.mjs)             ShopStockMovement (ledger)
                                                                                              ShopOrder
                                                                                              PaymentRequest (provider 'admin_approved')
admin approves/rejects PaymentRequest ─▶ adminPaymentService ─▶ shopService.applyPaymentToOrder
buyer / vendor / admin cancel ─▶ shopService.cancelOrder ─▶ orderStore.cancelAndRelease ─▶ refundService.raise
vendor ─ POST /vendor/orders/:id/status ─▶ shopService.updateOrderStatus
weekly job ─▶ vendorSettlementService (delivered + paid orders)
```

Data layer: `src/infra/knex-store.mjs` exposes each table as a "collection"
(read whole table, filter in memory, write row by row). It has **no transaction
API**; that is why PR 1 added a dedicated store for the stock-and-order writes
instead of building on collections.

Payment model for shop orders: `PaymentRequest` rows with
`provider: 'admin_approved'`. A FitFlex admin approves the request in the portal,
which calls `applyPaymentToOrder`. **No payment-provider integration exists for
shop orders in this code path** (see PR 3).

## 3. Confirmed defects

| ID | Sev | Defect | Where | Status |
|---|---|---|---|---|
| M-01 | P0 | **Overselling.** Stock was read, checked, then written in separate statements with no lock. Reproduced: 10 simultaneous buyers of a 1-unit product → **10 orders created** (old code, same DB). | `createOrder` (before PR 1) | **Fixed PR 1** — conditional `UPDATE … WHERE stock >= qty`; test `ten buyers race for the last unit` |
| M-02 | P0 | **Not atomic.** Stock deducted line by line, then the order inserted, then the payment request. A failure part-way left stock deducted with no order (or an order with no payment request). | `createOrder` | **Fixed PR 1** — single transaction |
| M-03 | P0 | **Duplicate orders on retry.** No idempotency; a timeout-and-retry made a second order and a second deduction. | `createOrder`, route | **Fixed server-side PR 1** (`Idempotency-Key`). Mobile does not send a key yet → **PR 4** |
| M-04 | P1 | Same product on two lines: each line checked against full stock, then updates raced on a stale value (under-deduction). | `createOrder` | **Fixed PR 1** — lines merged per product |
| M-05 | P1 | Restock was not exactly-once: `restock` ran before the status write, guarded only by a stale read of `status`. Concurrent cancels double-restocked; a crash between restock and status write re-restocked on retry. | `restock`, `cancelOrder`, `applyPaymentToOrder` | **Fixed PR 1** — release is a conditional state change plus a ledger unique key |
| M-06 | P1 | **Late payment lost.** Approval of a payment for an order already cancelled returned silently ("FitFlex refunds it") — no refund was raised, nothing recorded. | `applyPaymentToOrder` | **Fixed PR 1** (decision D-2) — an order that lapsed on its own is **revived** if its stock can be taken again; otherwise, or if a person cancelled it, it stays cancelled, is marked `refund_pending`, and one refund is raised and audited |
| M-07 | P1 | No reservation expiry: an unpaid order held its stock forever. | — | **Implemented PR 1, off by default** (`SHOP_RESERVATION_EXPIRY=on`) |
| M-08 | P1 | A refund that could not be raised was only `console.warn`ed. | `cancelOrder` | **Partly fixed PR 1** — recorded as audit `shop_refund_not_raised`; order stays `refund_pending`. Ops screen for these → PR 3 |
| M-09 | P2 | Fractional / non-integer quantities accepted (`1.5`). No cap on lines. | `createOrder` | **Fixed PR 1** (integers only, ≤ 50 lines) |
| M-10 | P2 | `soldCount` rose on reservation and never fell on release. | `restock` | **Fixed PR 1** |
| M-11 | P1 | **Vendor authorisation was per order, not per line.** `updateOrderStatus` let any vendor owning *any* item move the *whole* order (including other vendors' lines) to any status; `vendorOrders` returned every vendor's lines, commissions and payouts. Reproduced: vendor A marked a 2-vendor order `delivered` from `pending`; vendor B never touched it. | `updateOrderStatus`, `vendorOrders` | **Fixed PR 2** — per-vendor fulfilments; vendors see and move only their own |
| M-12 | P1 | **No state machine.** Any status could follow any other (`pending → delivered`, `delivered → processing`); only "paid first" and "cancelled is final" were enforced, by an unconditional update. | `updateOrderStatus` | **Fixed PR 2** — `docs/marketplace-order-state-machine.md`; decided under a row lock |
| M-13 | P1 | A vendor/admin can cancel (and refund) a dispatched order. | `cancelOrder` | **Preserved on purpose** — an existing, specified rule ("the vendor can still cancel a dispatched order, which refunds the buyer"). Now refused once any vendor has delivered (`order_partly_delivered`), and vendors cannot cancel a multi-vendor order alone |
| M-19 | P1 | **Administrators needed no ACL scope to change order status.** The route only required an `admin` token; an admin without the `shop` scope could move any vendor's orders. | `functions/shop.mjs` `vendorUpdateOrderStatus` | **Fixed PR 2** — `shop` scope required (super-admin unrestricted) |
| M-20 | P2 | A suspended vendor (or one whose staff still held tokens) could keep fulfilling orders. | `updateOrderStatus` | **Fixed PR 2** — `403 vendor_suspended` |
| M-21 | P1 | The cancel path (expiry, rejected payment) left vendors' fulfilments uncancelled. | PR 2 development | **Fixed PR 2** (found by test) |
| M-14 | P2 | `free = totalTzs === 0 || !paymentRequests`: if `paymentRequests` were ever not injected, orders become `paid` with no payment. Production bootstrap injects it; the fallback is a trap. | `createOrder` | **Open** (small; will remove with PR 3 wiring test) |
| M-15 | P2 | Product `variants` carry their own `stock` but order lines had no variant, so variant stock was never checked or reserved. | `createOrder`, data model | **Fixed PR 1** (decision D-3) — see §5 "Variants" |
| M-16 | P2 | `createOrder` did not check `visibility === 'hidden'`; the catalogue does. A hidden product could be bought by id. | `createOrder` vs `listProducts` | **Fixed PR 1** (decision D-4) — checked in the service and again in the atomic reserve |
| M-17 | P2 | `pickupGymId` / `deliveryAddress` are not validated beyond presence (gym existence, ownership). | `createOrder` | **Open → PR 4** |
| M-18 | P2 | `paymentReference` is client-supplied and stored unverified. It is not used to mark anything paid. | `createOrder` | **Open → PR 3** (note only) |

### Not yet inspected (no claim made)

- Payment webhooks / callbacks and any Selcom (or other) integration for shop orders; reconciliation (PR 3).
- Refund provider callbacks, partial refunds, refund-vs-statement interaction (PR 3).
- Vendor settlement formula against refunds/cancellations; duplicate-batch protection beyond what `vendor-settlements.specs` covers (PR 5).
- Rate limiting, request size limits, product-image upload validation (PR 5).
- Mobile checkout, cart clearing, retry, status display (PR 4).
- Portal vendor/admin order screens and their status vocabulary (PR 2).

## 4. Behaviour that must be preserved

- `POST /me/shop-orders` still answers **201 with the order object** (not wrapped), including for orders awaiting payment (the app depends on this). A replay adds header `Idempotent-Replay: true`.
- Order and item field names; `status` values including legacy `confirmed` / `fulfilled`; `paymentStatus` values `pending | paid | failed | cancelled | refund_pending | refunded`.
- Commission is fixed per line at order time (`priceOrderLine`); a later rate change never alters an order.
- Unapproved, paused, archived, deleted, moderated-hidden products and non-operational vendors cannot be bought (`product_not_found`).
- Refund raising is already de-duplicated by `refundService.raise` (one live refund per order, unique index); kept.
- Admin-approval payment flow and its notifications.

## 5. What PR 1 changed

**Schema** — `db/migrations/20261224103000-shop-order-integrity.cjs` (additive; down-migration provided and round-trip tested):

| Object | Purpose |
|---|---|
| `ShopOrder.idempotencyKey`, `idempotencyFingerprint` | retry returns original order; same key with a different cart → `409 idempotency_key_reused`. Unique per `(buyerId, key)` where key present |
| `ShopOrder.stockState` (`reserved` \| `released`) | release is a conditional update on this → exactly once. Backfilled: cancelled orders → `released` |
| `ShopOrder.reservationExpiresAt` | when an unpaid order's reservation lapses |
| `ShopOrder.reservationCycle` | numbers each reservation of an order (1, then 2 after a revival); part of the ledger's unique key so a revived order can be released again exactly once |
| `ShopStockMovement` | append-only ledger (`reserve`/`release`, delta, stock after); unique `(orderId, productId, variant, reason, cycle)` is a second guard against double release |
| `Product` CHECK `stock >= 0` | `NOT VALID` (enforced on every new write; does not scan existing rows). Run `VALIDATE CONSTRAINT product_stock_non_negative` once existing data is checked |

**Code** — `src/infra/shop-order-store-pg.mjs` (new, transactions), `src/services/shop-order-store-memory.mjs` (new, same port over collections for unit specs), `src/services/shop-service.mjs`, `functions/shop.mjs`, `functions/jobs.mjs`, `src/bootstrap/services.mjs`, `src/infra/knex-store.mjs` (allowed fields).

**Stock lifecycle (as implemented)**

| Event | Stock | `stockState` |
|---|---|---|
| order placed (paid or awaiting payment) | reserved (deducted) in the order's transaction | `reserved` |
| payment approved | unchanged (committed) | `reserved` |
| payment rejected / cancelled, order cancelled, reservation expired | given back once | `released` |
| payment arrives after the reservation lapsed (or payment was rejected, then approved) | re-reserved atomically, all lines or none; order is live and paid again (`reservationCycle` + 1) | `reserved` |
| payment arrives and stock is gone, or a person (buyer / vendor / admin) had cancelled the order | **not** re-deducted; order stays cancelled; money queued for refund, once | `released` |
| order delivered | unchanged; cancel is refused | `reserved` |

**Variants** — product `stock` always limits an order. A variant that keeps its own numeric `stock` is a second limit and is reserved/released in the same statement (jsonb update, conditional on enough variant stock). Order lines accept `variant` (the variant's `name`); lines for the same product and variant are merged.
- An unknown variant name is `variant_not_found` (404). A product with a stock-tracked variant can require the line to name one (`variant_required`, 400, lists the names), but that is **off** (`SHOP_REQUIRE_VARIANT=on` to enforce): the current app sends no variant, and existing products (and the existing marketplace specs) buy without one. An order that names none reserves product stock only.
- Name-only variants (what the mobile vendor app creates today: `{name}` with no stock) are labels: optional, validated when given, limited by product stock.
- The order item records `variant` (and `variantStockReserved` when the variant's own count was taken).
- The app does not send `variant` yet, so stock-tracked variants are not reserved per variant for app orders until the picker ships (PR 4); then enable `SHOP_REQUIRE_VARIANT=on`.

**Hidden products** — `visibility: 'hidden'` (the vendor's toggle) now blocks purchase by id.

**API** — new optional request header `Idempotency-Key` (8–100 chars `A-Za-z0-9._:-`; body field `idempotencyKey` also accepted). New errors: `invalid_idempotency_key` 400, `idempotency_key_reused` 409, `price_changed` 409, `too_many_items` 400, `order_changed` 409 (cancel raced a state change), `variant_required` 400, `variant_not_found` 404, `invalid_variant` 400. `insufficient_stock` now also comes from the atomic reserve.

## 6. Decisions

| ID | Question | Decision (2026-10-13) |
|---|---|---|
| D-1 | Reservation TTL for unpaid orders | **48 hours** (`SHOP_RESERVATION_TTL_MINUTES` overrides). The expiry job still does nothing until `SHOP_RESERVATION_EXPIRY=on`; set it deliberately after deploy. |
| D-2 | Late payment: refund or revive | **Revive.** Implemented as: revive when the order lapsed on its own and its stock can be re-reserved in full; otherwise refund. An order that a person cancelled is refunded, never revived (assumption — confirm). |
| D-3 | Variants purchasable | **Yes** — see §5. A variant can be named and its own stock is then reserved; choosing is not mandatory until the app can send it (`SHOP_REQUIRE_VARIANT=on`). |
| D-4 | Block hidden products by id | **Yes.** |
| D-5 | `VALIDATE CONSTRAINT` on `Product.stock` | **Still open** — needs a data check on production first. |
| D-6 | Cancelling or returning **one vendor's part** of a multi-vendor order needs a partial refund (the refund model is one per order). Until decided, vendors cannot cancel a mixed order and FitFlex cancels it whole; once any vendor has delivered it cannot be cancelled at all. | **Open — financial-model decision** |
| D-7 | Per-vendor settlement: today a mixed order is paid out only when **every** vendor has delivered (conservative). Pay each vendor as their own part is delivered? | **Open** (PR 5) |
| D-8 | Remove the legacy `fulfilled` completion shortcut once no client uses it. | **Open** (low) |

## 7. Tests

Baseline (before changes, isolated database `fitflex_ci_shop1013`, 92 migrations applied):

| Command | Result |
|---|---|
| `node --test` on `shop`, `marketplace-requirements`, `refunds-cancellations`, `vendor-settlements`, `partner-notifier` specs | **53 pass, 0 fail** |

After PR 1:

| Command | Result |
|---|---|
| `specs/shop-checkout-integrity.specs.mjs` (new, real Postgres) | **28 pass, 0 fail** |
| the five baseline spec files | **53 pass, 0 fail** |
| `npm test` (full suite, 1875 tests) | **1875 pass, 0 fail, 0 skipped** |
| migration down → up round trip | ok (`stockState` column removed then restored) |
| negative control: old `createOrder`, 10 concurrent buyers, 1 unit | **10 orders created** (defect reproduced) |

**PR 2** (stacked on PR 1; isolated database, 93 migrations):

| Command | Result |
|---|---|
| `specs/shop-order-lifecycle.specs.mjs` (hand-written expected matrix, 64 status pairs × 2 delivery methods) | **9 pass, 0 fail** |
| `specs/shop-fulfilment.specs.mjs` (real Postgres) | **17 pass, 0 fail** |
| `npm test` (full suite) | **1901 pass, 0 fail, 0 skipped** |
| migration `20261224113000-shop-order-fulfilments` down → up | ok |
| negative control: old `updateOrderStatus`, vendor A on a 2-vendor order | **`pending → delivered` accepted** (defect reproduced) |

Existing specs changed by PR 2 (each encoded the removed behaviour): the
"seven-stage timeline" spec read a timeline array that the old code mutated in
place — it now reads the stored order; the gym-pickup spec marked
`ready_for_pickup` straight from `pending`; the refund spec dispatched / delivered
straight from `pending`. All now accept the order first.

No linter or static-analysis script exists in `package.json`; none was run.
No mobile or portal build was run (not touched in PR 1).

What the new spec covers: concurrent last-unit purchase; stock 5 vs 12 buyers;
duplicate lines; fractional qty; DB refuses negative stock; multi-item rollback
(store level); order + payment request + ledger written together; server-side
price and price-moved refusal; retry returns original order; 5 simultaneous
identical requests → one order; retry after stock gone; key reuse with a
different cart; per-buyer keys; malformed key; double/triple concurrent cancel;
paid order double cancel → one refund, one restock; the route reads `Idempotency-Key` and flags a replay; double rejection; delivered
order not restockable; expiry once under two concurrent sweeps; payment after
expiry → order revived once with a new ledger cycle (and releasable again); stock gone →
refunded once; buyer-cancelled → refunded; stock-tracked variants (race, release, required,
unknown; mandatory choice behind the switch); label variants; hidden product; 48 h default; refund-raise failure recorded.

Known test limits: concurrency tests run in one Node process against a pooled
connection set (real row locking, but not multi-process). The service-level
unit specs still use the in-memory store, which is deliberately not atomic.

## 8. Remaining work

| PR | Content | State |
|---|---|---|
| 1 | transactional inventory, idempotency, expiry, late payment | **done, awaiting review** |
| 2 | state machine + vendor-scoped fulfilment (M-11, M-12, M-13, M-19–M-21) | **done, awaiting review** (stacked on PR 1) |
| 3 | payment confirmation, refund reliability, reconciliation (M-08, M-14, M-18) | not started; provider integration cannot be assumed |
| 4 | mobile idempotency key, resume pending payment, status display (M-03 client half, M-17, variant picker) | not started |
| 5 | settlement controls, security hardening, go-live regression | not started |

Also still to write: `marketplace-order-state-machine.md`,
`marketplace-payment-and-refund-flows.md`, `marketplace-go-live-checklist.md`.

## 9. Deployment prerequisites (PR 1 and PR 2)

1. Back up / snapshot the production database (additive migration, but it touches `ShopOrder` and `Product`).
2. Run the migration **before** deploying the new code (new code needs the columns). Old code keeps working on the new schema.
3. Deploy. Nothing changes for customers except the guarantees above. No env var is required.
4. Optional, later and deliberately: `SHOP_RESERVATION_EXPIRY=on` (D-1; TTL default 48 h).
5. Rollback: redeploy old code; the down-migration is available but loses idempotency keys and the stock ledger.
6. PR 2 adds `ShopOrder.fulfilments` (nullable jsonb; no backfill, derived lazily). Run its migration before deploying PR 2's code. Rollback drops the column; `status` and `timeline` stay complete.
7. PR 2 changes what `GET /vendor/orders` returns for a vendor: their own lines and subtotal, `status` = their own fulfilment's status, plus `orderStatus` and `nextStatuses`. Identical for single-vendor orders. The vendor app needs no change.

## Outcome

**NOT READY.** The overselling, atomicity, retry and exactly-once-release
blockers in checkout are fixed and tested against a real database. The
marketplace still lacks an enforced order state machine, per-vendor fulfilment
authorisation, a verified payment provider integration with reconciliation,
and a reviewed mobile checkout. Do not enable unrestricted live transactions.
