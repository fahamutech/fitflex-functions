# Marketplace payment and refund flows

State of the code after PR 3. **There is no payment-provider integration for shop
orders.** Everything below is the provider-independent safety layer that any
future integration plugs into. Nothing here calls a provider, and no provider
behaviour is assumed.

## What exists, what does not

| Capability | State |
|---|---|
| Payment initiation (create a charge at a provider) | **Does not exist.** An order creates a `PaymentRequest` with `provider: 'admin_approved'`; the buyer pays outside the app and may type a reference |
| Payment confirmation | **Manual**: FitFlex staff approve the request in the portal (`POST /admin/payment-requests/:id/decision`) |
| Provider webhook | `POST /webhooks/selcom` exists, protected by a shared token (`SELCOM_WEBHOOK_SECRET`; signature verification is open item OI-004). It settles **subscriptions only** (`subscription_id`); it has no order path, and nothing initiates a Selcom charge for an order |
| Refund payout | **Manual**: staff send the money and record it (`POST /admin/refunds/:id/paid` with a reference) |
| Reconciliation against a provider ledger | **Not possible** (no provider data). Internal reconciliation added (below) |

Blocked on external input (not guessed): a provider choice and its documentation,
sandbox credentials, the webhook/signature scheme, refund API. See "Provider
integration: what plugs in where".

## Two separate axes

`order.status` (fulfilment; see `marketplace-order-state-machine.md`) and
`order.paymentStatus`:

```
pending ──approved──▶ paid ──cancel──▶ refund_pending ──refund paid──▶ refunded
   │                    │
   ├─rejected/expired──▶ failed          (order cancelled, stock released)
   └─buyer cancels─────▶ cancelled
```

Fulfilment requires `paymentStatus = paid`. Settlement requires `paid` and `delivered`.

## Confirming a payment

`PaymentRequest` is the payment attempt: amount, currency, reference, status, who decided and when.

Before an order payment is confirmed (`decide` approve, or `update` to approved):

| Check | Failure |
|---|---|
| order exists | `409 order_not_found` |
| the request belongs to the order's buyer | `409 order_buyer_mismatch` |
| currency is TZS | `409 currency_mismatch` |
| request amount equals the order total | `409 order_amount_mismatch` |
| optional `amountTzs` (what staff actually received) equals the request | `409 amount_mismatch` |
| the reference is not already confirming another order | `409 reference_already_used` |

The decision is written with a **conditional update** (`WHERE status = <what was read>`):
two staff members, or a double click, cannot both succeed (`409 already_decided`).
The reference rule has a database backstop, a partial unique index on confirmed
order references (migration `20261224123000`; created only when existing data has
no duplicates — otherwise the migration prints the clashing references and skips it).

A **confirmed order payment is not edited back** (`409 payment_already_confirmed`):
the order is paid and may be fulfilled; getting money back is the refund flow.
A rejected or cancelled request may be re-opened or approved later; that is the
"late payment" path:

| Payment confirmed when the order is… | Result |
|---|---|
| pending | paid, vendors and buyer notified once |
| cancelled / expired by the system, stock still available | **revived**, paid, stock re-reserved |
| cancelled / expired, stock gone | stays cancelled, `refund_pending`, one refund raised |
| cancelled by a person (buyer, vendor, admin) | stays cancelled, `refund_pending`, one refund raised |
| already paid | no change |

### Recovery when the system stops half-way

The request is recorded as approved first, then the order is updated. If the
process stops between the two, the order stays `pending` while the money is
confirmed. This is **detected** (reconciliation check `confirmed_payment_order_not_paid`)
and **repaired** by `POST /admin/marketplace/orders/:id/repair-payment`, which is safe to repeat.

## Refunds

A refund is raised when a **paid** order is cancelled (buyer, vendor or admin;
see the cancellation table in the state-machine doc) or when a confirmed payment
arrives for an order that cannot be revived.

- One live refund per order (`refundService.raise` returns the existing one; unique index).
- Amount = the order total, **capped at what was confirmed** (`shop_refund_amount_capped` audit when they differ). There are no partial refunds in the shop model.
- Status: `requested | approved | paid | rejected`. Shop refunds are raised `approved`.
- `markPaid` and `decide` are conditional updates: a refund is recorded paid once (`409 already_paid`), a decision is made once (`409 already_decided`).
- When a refund is paid, the order moves `refund_pending → refunded` only from `refund_pending`; otherwise it is left and `shop_refund_paid_unexpected_state` is audited.

### Failures are states, not log lines

| Failure | What is recorded | How staff find it | Recovery |
|---|---|---|---|
| refund could not be raised at cancellation | audit `shop_refund_not_raised`; order stays `refund_pending` | reconciliation `refund_owed_none_raised` | `POST /admin/marketplace/orders/:id/raise-refund` (idempotent) |
| refund paid but the order was not updated | audit `refund_paid_source_not_updated` | `refund_paid_order_not_refunded` | re-run `markOrderRefunded` (staff: record again is refused; use repair — to be added with the portal screen) |
| approved refund not sent for days | — | `refund_approved_not_paid` (3 days) | staff pay it |
| payment confirmed, order not updated | — | `confirmed_payment_order_not_paid` | `repair-payment` |

## Reconciliation

`GET /admin/marketplace/reconciliation` (ACL `shop` or `payments`) and the hourly
job `shopReconciliation` (logs `[shop-reconciliation] P0|P1 <check> count=… sample=…`
for an alert to key on). Read-only.

| Check | Sev | Meaning |
|---|---|---|
| `paid_without_confirmed_payment` | P0 | order paid, no confirmed payment, total > 0 |
| `confirmed_payment_amount_differs` | P0 | confirmed amount ≠ order total |
| `refund_exceeds_payment` | P0 | refunds on an order exceed its total |
| `stock_state_inconsistent` | P0 | cancelled order holds stock / live order released it |
| `negative_stock` | P0 | product stock below zero |
| `refunded_order_in_vendor_statement` | P0 | cancelled/refunded order on a live vendor statement line |
| `confirmed_payment_order_not_paid` | P1 | half-finished confirmation |
| `refund_owed_none_raised` | P1 | customer owed, no refund exists |
| `refund_paid_order_not_refunded` | P1 | refund paid, order not updated |
| `refund_approved_not_paid` | P1 | approved refund waiting > 3 days |
| `unpaid_past_reservation` | P2 | unpaid order holding stock past its reservation (expiry job off or behind) |

`ok` is false while any P0/P1 is open.

## Provider integration: what plugs in where

When a provider is chosen and documented, the work is to implement, against the
existing seams (no new architecture):

1. **Initiation**: create the charge when the order is placed; store the provider's transaction id in `PaymentRequest.reference` (and a new `provider` value). The request amount/currency come from the order, never the client.
2. **Callback**: authenticate it with the provider's mechanism (signature), find the request by the provider transaction id, then call the same confirmation path: `checkOrderPayment` (buyer, currency, amount) → conditional decision → `applyPaymentToOrder`. Replays are already harmless: the decision is conditional and the reference unique.
3. **Timeouts**: a charge left pending with the provider is polled/queried by a job; its result goes through the same path. The half-finished-confirmation repair already exists.
4. **Refunds**: initiate through the provider from an `approved` refund, record the provider reference with `markPaid` semantics (conditional), handle the provider's callback the same way.
5. **Reconciliation**: add the provider's transaction list as one more source in `shop-reconciliation-service.mjs`.

None of this is implemented, and this document does not claim it is.
