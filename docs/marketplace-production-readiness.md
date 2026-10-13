# Marketplace production readiness

Status as of 2026-10-13, after **PR 1 (checkout and inventory integrity)**.
Outcome so far: **NOT READY** — payments, vendor-scoped fulfilment and the order
state machine are not yet reviewed or fixed (PR 2–5). See "Outcome".

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
| M-06 | P1 | **Late payment lost.** Approval of a payment for an order already cancelled returned silently ("FitFlex refunds it") — no refund was raised, nothing recorded. | `applyPaymentToOrder` | **Fixed PR 1** — order stays cancelled, marked `refund_pending`, refund raised once, audited |
| M-07 | P1 | No reservation expiry: an unpaid order held its stock forever. | — | **Implemented PR 1, off by default** (`SHOP_RESERVATION_EXPIRY=on`) |
| M-08 | P1 | A refund that could not be raised was only `console.warn`ed. | `cancelOrder` | **Partly fixed PR 1** — recorded as audit `shop_refund_not_raised`; order stays `refund_pending`. Ops screen for these → PR 3 |
| M-09 | P2 | Fractional / non-integer quantities accepted (`1.5`). No cap on lines. | `createOrder` | **Fixed PR 1** (integers only, ≤ 50 lines) |
| M-10 | P2 | `soldCount` rose on reservation and never fell on release. | `restock` | **Fixed PR 1** |
| M-11 | P1 | **Vendor authorisation is per order, not per line.** `updateOrderStatus` allows any vendor owning *any* item to move the *whole* order (including other vendors' lines) to any status. `vendorOrders` falls back to product ownership. | `updateOrderStatus`, `vendorOrders` | **Open → PR 2** (read in code; not yet reproduced) |
| M-12 | P1 | **No state machine.** Any status in the set can follow any other (e.g. `pending → delivered`, `delivered → processing`); only "paid first" and "cancelled is final" are enforced. Transition write is an unconditional update. | `updateOrderStatus` | **Open → PR 2** |
| M-13 | P1 | Paid-order cancellation by a vendor/admin is not limited by fulfilment state beyond `delivered`; dispatched goods can be cancelled and "refunded". | `cancelOrder` | **Open → PR 2/3** (business rule needed) |
| M-14 | P2 | `free = totalTzs === 0 || !paymentRequests`: if `paymentRequests` were ever not injected, orders become `paid` with no payment. Production bootstrap injects it; the fallback is a trap. | `createOrder` | **Open** (small; will remove with PR 3 wiring test) |
| M-15 | P2 | Product `variants` carry their own `stock` but order lines have no variant, so variant stock is never checked or reserved; variants are not purchasable through the API. | `createOrder`, data model | **Open — decision needed** (D-3) |
| M-16 | P2 | `createOrder` does not check `visibility === 'hidden'`; the catalogue does. A hidden (unlisted) product can be bought by id. | `createOrder` vs `listProducts` | **Open — decision needed** (D-4) |
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
| `ShopStockMovement` | append-only ledger (`reserve`/`release`, delta, stock after); unique `(orderId, productId, reason)` is a second guard against double release |
| `Product` CHECK `stock >= 0` | `NOT VALID` (enforced on every new write; does not scan existing rows). Run `VALIDATE CONSTRAINT product_stock_non_negative` once existing data is checked |

**Code** — `src/infra/shop-order-store-pg.mjs` (new, transactions), `src/services/shop-order-store-memory.mjs` (new, same port over collections for unit specs), `src/services/shop-service.mjs`, `functions/shop.mjs`, `functions/jobs.mjs`, `src/bootstrap/services.mjs`, `src/infra/knex-store.mjs` (allowed fields).

**Stock lifecycle (as implemented)**

| Event | Stock | `stockState` |
|---|---|---|
| order placed (paid or awaiting payment) | reserved (deducted) in the order's transaction | `reserved` |
| payment approved | unchanged (committed) | `reserved` |
| payment rejected / cancelled, order cancelled, reservation expired | given back once | `released` |
| payment arrives after cancel / expiry | **not** re-deducted; order stays cancelled; money queued for refund | `released` |
| order delivered | unchanged; cancel is refused | `reserved` |

**API** — new optional request header `Idempotency-Key` (8–100 chars `A-Za-z0-9._:-`; body field `idempotencyKey` also accepted). New errors: `invalid_idempotency_key` 400, `idempotency_key_reused` 409, `price_changed` 409, `too_many_items` 400, `order_changed` 409 (cancel raced a state change). `insufficient_stock` now also comes from the atomic reserve.

## 6. Decisions and external configuration needed

| ID | Question | Why it matters | Default used |
|---|---|---|---|
| D-1 | Reservation TTL for unpaid orders, and whether to switch the expiry job on. Payments are approved by hand; an over-short TTL would cancel orders that are about to be approved (they would then be refunded as late payments). | live behaviour | `reservationExpiresAt` = placed + 24 h (`SHOP_RESERVATION_TTL_MINUTES`); **job does nothing unless `SHOP_RESERVATION_EXPIRY=on`** |
| D-2 | Late payment: refund (implemented) or revive the order if stock is still available. | money + customer experience | refund |
| D-3 | Are variants meant to be purchasable? If yes, order lines need a `variantId` and variant stock reservation (API + data change). | M-15 | not done |
| D-4 | Should `visibility: 'hidden'` block purchase by id? | M-16 | unchanged |
| D-5 | Run `VALIDATE CONSTRAINT` on `Product.stock` (needs a data check first). | schema | not run |

## 7. Tests

Baseline (before changes, isolated database `fitflex_ci_shop1013`, 92 migrations applied):

| Command | Result |
|---|---|
| `node --test` on `shop`, `marketplace-requirements`, `refunds-cancellations`, `vendor-settlements`, `partner-notifier` specs | **53 pass, 0 fail** |

After PR 1:

| Command | Result |
|---|---|
| `specs/shop-checkout-integrity.specs.mjs` (new, real Postgres), run twice | **21 pass, 0 fail** (20 on the two earlier runs, +1 route test) |
| the five baseline spec files | **53 pass, 0 fail** |
| `npm test` (full suite, 1868 tests) | **1868 pass, 0 fail, 0 skipped** |
| migration down → up round trip | ok (`stockState` column removed then restored) |
| negative control: old `createOrder`, 10 concurrent buyers, 1 unit | **10 orders created** (defect reproduced) |

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
expiry → refund once, not revived, audited; refund-raise failure recorded.

Known test limits: concurrency tests run in one Node process against a pooled
connection set (real row locking, but not multi-process). The service-level
unit specs still use the in-memory store, which is deliberately not atomic.

## 8. Remaining work

| PR | Content | State |
|---|---|---|
| 1 | transactional inventory, idempotency, expiry, late payment | **done, awaiting review** |
| 2 | state machine + vendor-scoped fulfilment (M-11, M-12, M-13) | not started |
| 3 | payment confirmation, refund reliability, reconciliation (M-08, M-14, M-18) | not started; provider integration cannot be assumed |
| 4 | mobile idempotency key, resume pending payment, status display (M-03 client half, M-17) | not started |
| 5 | settlement controls, security hardening, go-live regression | not started |

Also still to write: `marketplace-order-state-machine.md`,
`marketplace-payment-and-refund-flows.md`, `marketplace-go-live-checklist.md`.

## 9. Deployment prerequisites (PR 1)

1. Back up / snapshot the production database (additive migration, but it touches `ShopOrder` and `Product`).
2. Run the migration **before** deploying the new code (new code needs the columns). Old code keeps working on the new schema.
3. Deploy. Nothing changes for customers except the guarantees above. No env var is required.
4. Optional, later and deliberately: set `SHOP_RESERVATION_TTL_MINUTES`, then `SHOP_RESERVATION_EXPIRY=on` (D-1).
5. Rollback: redeploy old code; the down-migration is available but loses idempotency keys and the stock ledger.

## Outcome

**NOT READY.** The overselling, atomicity, retry and exactly-once-release
blockers in checkout are fixed and tested against a real database. The
marketplace still lacks an enforced order state machine, per-vendor fulfilment
authorisation, a verified payment provider integration with reconciliation,
and a reviewed mobile checkout. Do not enable unrestricted live transactions.
