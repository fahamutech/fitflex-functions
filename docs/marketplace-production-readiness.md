# Marketplace production readiness

Status as of 2026-10-13, after **PR 1 (checkout and inventory integrity)**,
**PR 2 (order state machine and vendor-scoped fulfilment)** and
**PR 3 (payment confirmation, refund reliability, reconciliation)**,
**PR 4 (mobile checkout)** and **PR 5 (hardening and go-live regression)**.
Outcome: **CONDITIONALLY READY** for a controlled launch with **manual**
payment confirmation. There is **no payment-provider integration**; unattended
payments are NOT READY. See "Outcome" and `marketplace-go-live-checklist.md`.

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
| M-03 | P0 | **Duplicate orders on retry.** No idempotency; a timeout-and-retry made a second order and a second deduction. | `createOrder`, route | **Fixed PR 1** (server) + **PR 4** (app sends the key; fitflex-mobile#113). Effective for app traffic once both are deployed |
| M-04 | P1 | Same product on two lines: each line checked against full stock, then updates raced on a stale value (under-deduction). | `createOrder` | **Fixed PR 1** — lines merged per product |
| M-05 | P1 | Restock was not exactly-once: `restock` ran before the status write, guarded only by a stale read of `status`. Concurrent cancels double-restocked; a crash between restock and status write re-restocked on retry. | `restock`, `cancelOrder`, `applyPaymentToOrder` | **Fixed PR 1** — release is a conditional state change plus a ledger unique key |
| M-06 | P1 | **Late payment lost.** Approval of a payment for an order already cancelled returned silently ("FitFlex refunds it") — no refund was raised, nothing recorded. | `applyPaymentToOrder` | **Fixed PR 1** (decision D-2) — an order that lapsed on its own is **revived** if its stock can be taken again; otherwise, or if a person cancelled it, it stays cancelled, is marked `refund_pending`, and one refund is raised and audited |
| M-07 | P1 | No reservation expiry: an unpaid order held its stock forever. | — | **Implemented PR 1, off by default** (`SHOP_RESERVATION_EXPIRY=on`) |
| M-08 | P1 | A refund that could not be raised was only `console.warn`ed. | `cancelOrder` | **Fixed PR 1 + PR 3** — audited, order stays `refund_pending`, listed by reconciliation, retry endpoint |
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
| M-17 | P2 | `pickupGymId` / `deliveryAddress` are not validated beyond presence (gym existence, ownership). | `createOrder` | **Open (backend)** — the app now says what is missing; the server still accepts any gym id |
| M-32 | P1 | **Mobile: a checkout timeout stuck the order button with no message** (only `ApiException` was caught) and the client's automatic POST retry on dropped connections had nothing making it safe. | `shop_browse_page.dart` `_checkout`, `api_client.dart` | **Fixed PR 4** (read in code; pinned by widget tests; not reproduced on a device) |
| M-33 | P2 | Mobile showed "order placed" for unconfirmed payment; `refund_pending` looked like a finished refund; cancel text said the refund was "on its way". | `shop_browse_page.dart`, i18n | **Fixed PR 4** |
| M-34 | P2 | Mobile cannot buy two options of one product in one order, and *Reorder* drops options. | cart keyed by product | **Open** — documented limit (decide with `SHOP_REQUIRE_VARIANT`) |
| M-35 | P1 | **Customers were sent vendors' commission and payout figures** (`commissionPct/Tzs`, `vendorPayoutTzs`) and internal fields with every order, and product pages returned reviewers' buyer and order ids. | `myOrders`, `createOrder`/cancel responses, `getProduct`, `getVendorStore` | **Fixed PR 5** — `buyerOrderView`, `publicReview` |
| M-36 | P1 | **Stock hoarding.** One buyer could place unlimited unpaid orders, each reserving stock until expiry. | `createOrder` | **Fixed PR 5** — ≤ 5 unpaid orders per buyer (`SHOP_MAX_UNPAID_ORDERS`), `429 too_many_unpaid_orders` |
| M-37 | P1 | **Unbounded input.** Image upload read any size into memory for any signed-in user; order text fields, product text, price/stock (non-integers), image and option lists had no limits. | `functions/storage.mjs`, `createOrder`, `upsertProduct` | **Fixed PR 5** — 10 MB upload cap (413), bytes must decode as an image (400), field limits, integer money/stock, caps on lines, qty, total, images, options |
| M-38 | P2 | Storage redirect interpolated path params into the redirect URL unencoded. | `getStorageFile` | **Fixed PR 5** |
| M-39 | P2 | Reconciliation did not cover vendor statements' own arithmetic or settled orders. | reconciliation | **Fixed PR 5** — three checks added (`order_share_on_two_live_statements` is also enforced by a unique index, kept as a tripwire) |
| M-40 | P2 | A vendor setting a product's stock is an absolute write that can overwrite a purchase made at the same instant. | `upsertProduct` | **Open** — needs an adjust-by API; accepted limit (checklist H) |
| M-41 | P2 | No generic rate limiting on shop routes (the platform has it only for sign-in, PIN, invitations). | platform | **Open** |
| M-42 | P2 | Mobile shows a generic message for `too_many_unpaid_orders`. | mobile | **Open** (small) |
| M-18 | P2 | `paymentReference` is client-supplied and stored unverified. It is not used to mark anything paid. | `createOrder` | **Mitigated PR 3** — a reference confirms one order only; still unverified against a provider (none exists) |
| M-22 | P0 | **Double confirmation.** Approving a payment was read-then-write: two staff approving at once both succeeded and the order payment was applied twice. Reproduced: 2 successes, applied 2×. | `adminPaymentService.decide/update` | **Fixed PR 3** — conditional update; `409 already_decided` |
| M-23 | P1 | **A confirmed order payment could be edited back** to rejected / pending / cancelled while the order stayed paid (records disagree; refund flow bypassed). Reproduced. | `adminPaymentService.update` | **Fixed PR 3** — `409 payment_already_confirmed` |
| M-24 | P1 | Confirmation did not check the payment against the order (buyer, currency, amount) or what was received. | `decide/update` | **Fixed PR 3** — `checkOrderPayment`; optional `amountTzs` |
| M-25 | P1 | One transaction reference could confirm any number of orders. | `decide/update` | **Fixed PR 3** — service check + partial unique index (created only if existing data has no duplicates) |
| M-26 | P1 | Refund `decide` / `markPaid` were read-then-write: a refund could be "paid" twice (two records, two "refund sent" messages); a failure updating the order after payment was swallowed (`catch {}`). | `refundService` | **Fixed PR 3** — conditional updates; failure audited and reconciled |
| M-27 | P1 | A refund the refund service refused (`{ error }`) was treated as "no refund" with no record. | `bootstrap onRefundDue` | **Fixed PR 3** — thrown, audited, `refund_owed_none_raised` |
| M-28 | P1 | A refund could exceed what was confirmed (amount came from the order total only). | `raiseRefund` | **Fixed PR 3** — capped at confirmed; audited |
| M-29 | P1 | A crash between "payment recorded" and "order marked paid" left money confirmed and the order unpaid, undetectable. | `adminPaymentService` | **Fixed PR 3** — reconciliation + `repair-payment` |
| M-30 | P1 | **No payment-provider integration for shop orders.** Selcom webhook is subscriptions-only, token-protected, signature verification open (OI-004); nothing initiates a charge for an order; refunds are paid by hand. | `functions/webhooks.mjs`, `webhook-service.mjs` | **BLOCKED** — needs provider choice, documentation, sandbox, credentials. See `marketplace-payment-and-refund-flows.md` for the seams |
| M-31 | P2 | The Selcom webhook's replay guard checks `webhookSeen` then claims in two steps (the claim's primary key makes it safe, but the first read is redundant), and its token travels in the URL query. | `webhook-service.mjs`, `webhooks.mjs` | **Open** — outside the shop path; fix with the provider work |

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
| D-6 | **DECIDED 2026-10-15: keep the current rule.** Cancelling or returning **one vendor's part** of a multi-vendor order needs a partial refund (the refund model is one per order). Until decided, vendors cannot cancel a mixed order and FitFlex cancels it whole; once any vendor has delivered it cannot be cancelled at all. | **Decided: keep** (no partial refunds; revisit when mixed orders are common) |
| D-7 | **DECIDED 2026-10-15: keep the current rule.** Per-vendor settlement: today a mixed order is paid out only when **every** vendor has delivered (conservative). Pay each vendor as their own part is delivered? | **Decided: keep** (paid when every vendor has delivered) |
| D-8 | Remove the legacy `fulfilled` completion shortcut once no client uses it. | **Open** (low) |
| D-9 | **DECIDED 2026-10-15: Option A, manual confirmation for the controlled launch; no provider yet.** **Payment provider** for shop orders: which, with documentation, sandbox and credentials; webhook authentication scheme. Until then payments stay manual. | **Manual launch accepted; provider integration deferred. Still blocks unattended payments. Still to name: who confirms payments and sends refunds, within what time, from which account** |
| D-10 | Refund payout: stay manual, or automate through the provider's refund API once D-9 exists. | **Open** |
| D-11 | Reference uniqueness index: resolve any existing duplicate order references (the migration prints them) and create the index. | **Open — needs production data check** |
| D-12 | Alerting: wire an alert on the `[shop-reconciliation]` log lines / the report's `ok:false`; no alerting channel is configured in this repo for it. | **Open — operational** |

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

**PR 3** (stacked on PR 2):

| Command | Result |
|---|---|
| `specs/shop-payments.specs.mjs` (real Postgres, real payment-request and refund services) | **15 pass, 0 fail** |
| `npm test` (full suite) on a **brand-new database**, all 95 migrations from scratch | **1916 pass, 0 fail, 0 skipped** |
| negative control: old `adminPaymentService`, two staff approve at once, real DB | **2 successes, order payment applied 2×**; a confirmed payment edited back to `rejected` |

PR 3 covers: simultaneous approvals; amount / buyer / currency mismatch; reference
reuse (service and database); confirmed payment cannot be edited back; reject then
confirm later (revived once); half-finished confirmation found and repaired once;
refund recorded paid once under two staff; refund service down → recorded, listed,
retried once; refund paid but order not updated → recorded and listed; refund
capped at what was confirmed; unexpected refund state audited; reconciliation
checks (clean, paid-without-payment, stock mismatch, cancelled order on a vendor
statement).

Test-environment note: re-running the full suite many times against *one* database
fails two identity specs (`identity-i1-foundation`: a hard-coded public id `FM999`
that the id counter eventually reaches, because other identity specs leave users
behind). It is a pre-existing test-isolation problem unrelated to the shop; on a
fresh database, as in CI, the suite passes. Not fixed here.

Known test limits: concurrency tests run in one Node process against a pooled
connection set (real row locking, but not multi-process). The service-level
unit specs still use the in-memory store, which is deliberately not atomic.

**PR 4** (fitflex-mobile#113, base `release-candidate`):

| Command | Result |
|---|---|
| `flutter test` on RC (baseline) | **1018 pass** |
| `flutter test` with PR 4 | **1038 pass, 0 fail** |
| `flutter analyze` | **no issues** |
| device / Flutter web UAT | **not run** |

**PR 5** (stacked on PR 3):

| Command | Result |
|---|---|
| `specs/shop-hardening.specs.mjs` (real Postgres, production wiring) | **7 pass, 0 fail** |
| `npm test` on a fresh database, second run | **1923 pass, 0 fail, 0 skipped** |
| `npm test` on a fresh database, first run | 1922 pass, **1 fail**: `b2b-analytics-validation` "no analytics response carries a field an organisation must never receive" (asserts a response string does not contain `175`; it also failed once during PR 1 and passes on re-run). Pre-existing flake, unrelated to the shop, not changed |
| golden path: listing → moderation → purchase → payment → fulfilment → statement (prepared twice) → two-person approval → payout (paid twice at once) → settled → reconciliation clean for the order | pass |

## 8. Remaining work

| PR | Content | State |
|---|---|---|
| 1 | transactional inventory, idempotency, expiry, late payment | **done, awaiting review** |
| 2 | state machine + vendor-scoped fulfilment (M-11, M-12, M-13, M-19–M-21) | **done, awaiting review** (stacked on PR 1) |
| 3 | payment confirmation, refund reliability, reconciliation (M-08, M-18, M-22–M-29) | **done, awaiting review** (stacked on PR 2). Provider integration (M-30) **blocked**, not done |
| 4 | mobile idempotency key, resume pending payment, status display, option picker (M-03 client half, M-32, M-33) | **done, awaiting review** — fitflex-mobile#113 → `release-candidate`. Not run on a device |
| 5 | settlement integrity checks, security hardening, go-live regression, checklist | **done, awaiting review** (stacked on PR 3). **Settlement rules were not changed** (D-7 needs your decision) |

Written: `marketplace-order-state-machine.md` (PR 2), `marketplace-payment-and-refund-flows.md` (PR 3), `marketplace-go-live-checklist.md` (PR 5).

## 9. Deployment prerequisites (PR 1, 2, 3 and 4)

1. Back up / snapshot the production database (additive migration, but it touches `ShopOrder` and `Product`).
2. Run the migration **before** deploying the new code (new code needs the columns). Old code keeps working on the new schema.
3. Deploy. Nothing changes for customers except the guarantees above. No env var is required.
4. Optional, later and deliberately: `SHOP_RESERVATION_EXPIRY=on` (D-1; TTL default 48 h).
5. Rollback: redeploy old code; the down-migration is available but loses idempotency keys and the stock ledger.
6. PR 2 adds `ShopOrder.fulfilments` (nullable jsonb; no backfill, derived lazily). Run its migration before deploying PR 2's code. Rollback drops the column; `status` and `timeline` stay complete.
10. PR 4 is a mobile build. Ship it **before** setting `SHOP_REQUIRE_VARIANT=on` and before relying on app-side retry protection; the backend works with old and new builds.
8. PR 3 migration `20261224123000` creates a unique index on confirmed order payment references **only if no duplicates exist**; otherwise it prints them and skips it (resolve, then create the index by hand: statement in the migration output). No downtime either way.
9. PR 3 adds `GET /admin/marketplace/reconciliation` and two repair endpoints, and an hourly job `shopReconciliation` (read-only). Nothing alerts on it yet (D-12).
7. PR 2 changes what `GET /vendor/orders` returns for a vendor: their own lines and subtotal, `status` = their own fulfilment's status, plus `orderStatus` and `nextStatuses`. Identical for single-vendor orders. The vendor app needs no change.
   Vendor tools S2 (2026-10-19) replaces that view with an allowlist (plan `docs/plans/vendor-business-tools-plan.md` §3, shared in `src/shared/vendor-order-view.mjs`): no buyerId, buyerRole, paymentReference or internals, only lines that name the vendor (older lines without a vendorId are no longer shown), `buyer { customerId, displayName }`, `pickupGym { id, name }`, `shortRef`; the same shape from `GET /vendor/orders/:id` and the vendor's `POST /vendor/orders/:id/status` response. `todaySalesTzs` counts paid orders placed on the EAT day.

## Outcome

**CONDITIONALLY READY — for a controlled launch where staff confirm every payment and send every refund by hand.**
**NOT READY for unattended (provider-confirmed) payments.**

Why not READY FOR CONTROLLED LAUNCH: the code gates in `marketplace-go-live-checklist.md`
pass, but these are unverified or undone, and each needs a person or access I do not have:

1. Nothing is deployed or migrated; rollback has not been rehearsed (B1–B7).
2. The mobile build has not run on a device or in UAT (F2).
3. The manual-payment process (who confirms, who refunds, how fast) is not defined (C2–C3).
4. No alerting on reconciliation (E2) and no screen for it (F4).
5. No independent security review was run (G5).
6. Mixed-order cancellation/returns and per-vendor payout are undecided (D-6, D-7).

What would make it NOT READY again: any open P0 — none is known; the reconciliation
report returning P0 findings in production; or a decision to launch unattended payments
before D-9.

Evidence base: 5 backend PRs and 1 mobile PR; every P0/P1 above was reproduced on the old
code where marked, fixed, and pinned by tests run against a real Postgres. What the tests
do not cover: multi-process concurrency, real payment providers (none exist), real payouts
(none were made), real devices.
