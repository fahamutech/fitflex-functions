# Payments — AzamPay only

**AzamPay is the only payment method in FitFlex** (owner decision 2026-11-17). Removed with that decision:
Malipo by Tunzaa (client, `POST /webhooks/tunzaa`, `TUNZAA_*` / `MALIPO_*`), the Selcom payment webhook
(`POST /webhooks/selcom`, `SELCOM_*`), and paying by hand (the Lipa Namba instructions and the transaction ID a
member typed: `MANUAL_PAY_INSTRUCTIONS`, the `manual` block of `GET /payments/options`, `reference` / `payerPhone`
on subscribe, upgrade, custom gym pass and a member's event order).

Members pay a pending **FitFlex Pass**, a **pass upgrade**, a **gym plan** or a **custom gym pass**; with their own
switch also trainer sessions / a trainer's gym pass, a member's **event order** and a member's **shop order**.
Docs: https://developerdocs.azampay.co.tz · Sandbox portal: https://developers.azampay.co.tz

Built dormant. Nothing is offered until the flags below are set on the server.

## Switching it on
| Variable | Meaning |
|---|---|
| `AZAMPAY_APP_NAME`, `AZAMPAY_CLIENT_ID`, `AZAMPAY_CLIENT_SECRET` | From the app registered on the AzamPay portal. Server only — never in the apps, the repo or chat. |
| `AZAMPAY_API_KEY` | Optional. Sent as `X-API-Key` on checkout calls if the portal issues one. |
| `AZAMPAY_ENV` | `sandbox` (default) or exactly `live`. Live needs `AZAMPAY_AUTH_URL` and `AZAMPAY_CHECKOUT_URL` (AzamPay gives the production hosts after KYC approval), each `https://`. **If `live` is set and they are missing or not https, AzamPay is CLOSED** — no client, nothing offered, callbacks 403 — and the server logs `[azampay] MISCONFIGURED (live_hosts_missing \| live_hosts_not_https)` at boot. It never falls back to the sandbox. `AZAMPAY_DISBURSE_URL` is for payouts only (optional; `https://` when given; payouts stay closed without it). Host overrides are ignored in sandbox when `NODE_ENV=production`. |
| `AZAMPAY_PAYMENTS` | `on` to offer "Pay now". Off: `POST /me/payments/:id/mobile-money` is 404 `feature_disabled` and payment requests are settled by staff only. |
| `AZAMPAY_SANDBOX_SETTLES` | `on` to allow paying against the **sandbox**. A sandbox payment still activates a real plan, so set it only on a test server. |
| `AZAMPAY_SANDBOX_UNSIGNED_CALLBACKS` | Sandbox only, never live (owner decision 2026-11-17). AzamPay's sandbox `GET /azampay/v1/public-key` answered 404, so no sandbox callback signature can be checked and every callback was refused (403). `on`: such a callback is acted on only when it names the attempt open right now — our reference (`utilityref`) and the transaction id AzamPay returned when the prompt went out (one of `transid` / `reference` / `externalreference`) — and the amount is exact; anything else answers 403 and changes nothing (audit `payment_mobile_money_unsigned_refused`). A `clientId` that is not ours is still refused. |
| `AZAMPAY_TRAINER_PRODUCTS` | `on` to make trainer sessions / trainer gym passes payable (needs `AZAMPAY_PAYMENTS`). |
| `EVENTS_PAYMENTS_AZAMPAY` | `on` to make a member's event order payable (needs `AZAMPAY_PAYMENTS`, `EVENTS_MODULE`, `EVENTS_REGISTRATION`, a ticket secret and the approver gate). Replaces `EVENTS_PAYMENTS_TUNZAA`. |
| `AZAMPAY_SHOP_ORDERS` | `on` to make a member's own shop order payable (needs `AZAMPAY_PAYMENTS`). Off: a shop order is confirmed by staff as before. |
| `AZAMPAY_CALLBACK_USER`, `AZAMPAY_CALLBACK_PASSWORD` | Optional. If AzamPay is configured to send them, the callback must carry them. |
| `AZAMPAY_DISBURSE_PUBLIC_KEY` | Payouts only: the RSA public key (PEM) AzamPay gives for the disbursement checksum. Payouts stay closed without it. |

No longer read (remove from the server when convenient; leaving them set does nothing): `TUNZAA_PAYMENTS`,
`TUNZAA_SANDBOX_SETTLES`, `TUNZAA_TRAINER_PRODUCTS`, `EVENTS_PAYMENTS_TUNZAA`, `MALIPO_API_KEY`, `MALIPO_API_SECRET`,
`MALIPO_SECRET_KEY`, `MALIPO_ENV`, `MALIPO_BASE_URL`, `MALIPO_SANDBOX_SCENARIO`, `TUNZAA_API_KEY`, `TUNZAA_SECRET_KEY`,
`TUNZAA_ENV`, `TUNZAA_BASE_URL`, `TUNZAA_SANDBOX_SCENARIO`, `SELCOM_BASE_URL`, `SELCOM_VENDOR`, `SELCOM_API_KEY`,
`SELCOM_API_SECRET`, `SELCOM_WEBHOOK_SECRET`, `SELCOM_STRICT_AMOUNT`, `SELCOM_WEBHOOK_SERVER_CONFIRM`,
`SELCOM_WEBHOOK_QUERY_TOKEN_OFF`, `MANUAL_PAY_INSTRUCTIONS`.

`EVENTS_PAYMENTS_MANUAL` is still read, with a narrower meaning: it opens an **organisation's** payment notice for
its event order (bank transfer or mobile money, checked by FitFlex finance). It no longer lets a member pay by hand.

Callback URL to register with AzamPay (sandbox app, later production): `<PUBLIC_API_URL>/webhooks/azampay`.

## Flow
1. The payment request is created as before (`POST /me/subscribe`, `/me/upgrade`, a gym plan, a custom gym pass,
   `POST /me/event-orders/:id/payment`, shop checkout).
2. `POST /me/payments/:id/mobile-money {phone, network?}` → AzamPay MNO checkout (USSD push) for **the request's own
   amount**, `externalId` = our reference `<request id>.<attempt>`. `network` is the wallet (`Mpesa`, `Tigo`, `Airtel`,
   `Halopesa`, `Azampesa`); without it the network is taken from the number prefix (400 `network_required` if unknown).
   The request is claimed first, so a double tap sends one prompt; prompts are rate-limited per member and per phone.
3. AzamPay calls `POST /webhooks/azampay`. The route verifies the **RSA-SHA256 signature** (PKCS#1 v1.5) over
   `{utilityref}{externalreference}{transactionstatus}{operator}` with AzamPay's public key
   (`GET /azampay/v1/public-key`, cached 24 h) and that `clientId` is **present and ours** (a callback without it
   is refused), and the callback user / password when configured (compared in constant time).
   A bad signature, a missing or foreign `clientId` is 403 and changes nothing. When a signature does not verify the
   key is fetched again in case it rotated — only for a body that carries a signature and the signed fields, and at
   most once every 5 minutes, so junk posted to the route cannot make the server call AzamPay at will. (If the key
   really rotates inside such a window, genuine callbacks are refused until it ends; AzamPay's retry then passes.)
4. The request is found by `utilityref` (our reference). **AzamPay has no status query for collections**, so the
   verified callback is the confirmation. Before approving, all of these must hold; otherwise nothing is approved and
   the money is written to the audit log for staff (see the table):
   the request is pending and has an attempt of ours open; the transaction is not one of the request's given-up
   prompts; the amount is a whole number equal to the request's (an amount with cents is not rounded: it is held);
   the transaction is the one recorded when the prompt went out (any of `transid` / `reference` /
   `externalreference`); it has not confirmed another approved payment. Then `adminPaymentService.decide(approve)` — the same path admins use; the audit actor
   is `azampay`.
5. `failure` → the request is released so the member can retry (an event order's attempt ends and a new one is started).
   `POST …/mobile-money/refresh` reports where the request stands (it cannot ask AzamPay; it settles nothing on its own).

## Billing edge cases
No credit, no part-plan and no automatic refund is invented: anything that does not match exactly is **held for
staff**, who use the usual approve / reject / refund tools. Audit actions are in `AuditLog` with actor `azampay` and
the payment request as target, and **every hold raises an ops exception** (the existing mechanism, no new table):
- passes, gym plans, trainer products, shop orders: type `payment_conflict`, key `azampay_held:<request>:<transaction>`,
  entity `payment_request` (a repeat of the same callback is counted on the same exception);
- event orders: type `events_payment_reconciliation`, key `evpay:<payment>`; the payment also becomes
  `reconciliation_required` where it is still open — **except** money for a prompt that was given up while a newer one
  is open (see below), which gets its own key `evpay:<payment>:<transaction>` and leaves the payment payable.

| Case | Result | Audit |
|---|---|---|
| Exact amount | Approved once; plan / upgrade / order activated once | `payment_mobile_money_requested`, then the approval |
| Less than asked (partial), more than asked (over) | Held (`amount_mismatch`); nothing activated; the request stays pending on its prompt | `payment_mobile_money_amount_mismatch` { received, transactionId } |
| Amount missing / not a number / ≤ 0 / with cents (`59999.5`) | Held the same way (`received: null`); never rounded | same |
| Duplicate callback (same transaction) | No second activation | none (an event callback is also remembered in `WebhookSeen`) |
| A different transaction confirmed for an already **approved** request (paid twice) | Nothing changes | `payment_mobile_money_orphaned` { error: `already_settled` } |
| Success for a **rejected / cancelled / expired** request | Nothing activated | `payment_mobile_money_orphaned` { error: `request_closed` } |
| Success for a request with **no attempt open** (released after a failure or an expired prompt) — includes "success after failure for the same attempt" | Held (`no_open_attempt`); nothing activated; staff approve it by hand with that transaction if the money is there | `payment_mobile_money_orphaned` { error: `no_open_attempt` } |
| Success for an **older attempt** after a retry — also while the retry is still being sent | Held (`transaction_mismatch`); the new attempt still settles normally (an event payment stays payable; staff can also approve by hand) | `payment_mobile_money_held` { error: `transaction_mismatch`, superseded: true, transactionId, amountTzs } |
| The same AzamPay transaction for two requests | The second is held (`reference_already_used`) | `payment_mobile_money_held` |
| Bad signature / missing or wrong `clientId` / wrong callback user or password | 403, no state change | none |
| Unknown `utilityref` | 200 (understood, ignored), no state change | none |
| `failure` | Released for a retry; a late failure for an older attempt changes nothing | `payment_mobile_money_failed` |
| Two "Pay now" taps at once | One prompt (`alreadyRequested: true` on the other) | one `payment_mobile_money_requested` |
| Callback arrives before AzamPay's own checkout call returns | Settled by our reference; the settled request is not written over | — |
| Renewal paid while the current plan runs (`SCHEDULED_RENEWALS`) | Stored `scheduled`, starts when the current plan ends | as an approval |
| Upgrade (price difference) | Plan upgraded in place once; the full price instead of the difference is held | as above |
| Sandbox without `AZAMPAY_SANDBOX_SETTLES` | Held (`sandbox_not_settled`) | `payment_mobile_money_held` |

### A prompt whose callback never arrives
AzamPay cannot be asked about a collection, so before this change a lost callback left the request "in flight"
for ever. Now the time a prompt went out is recorded (`PaymentRequest.promptedAt`, migration
`20270217090000-payment-request-prompted-at`) and a prompt is **given up after 10 minutes** (`PROMPT_TTL_MS` in
`src/shared/mobile-money-claim.mjs`):
- until then a second "Pay now" answers `in_progress` / `alreadyRequested` (no second prompt), and the plan cannot be
  cancelled under the prompt;
- after it, "Pay now" sends a **new prompt on the same request** (audit `payment_mobile_money_prompt_expired` names the
  old transaction), and a refresh gives the request back (`state: none`, audit `payment_mobile_money_failed`
  { why: `prompt_expired` });
- the transaction id of every prompt that is given up (failed, or unanswered and retried) stays on the request
  (`PaymentRequest.supersededReferences`, migration `20270217090100-payment-request-superseded-prompts`);
- a success that still arrives for the old prompt is **never approved on its own**: it is held
  (`transaction_mismatch` if a new prompt is out **or is just being sent**, `no_open_attempt` if not,
  `already_settled` if the new prompt was paid too) — recorded for staff, never lost, never a second activation;
- holding it does **not** block the new attempt: the request stays pending on its new prompt, which settles
  normally. For an event order the `EventPayment` is left as it is (not `reconciliation_required`), so the new
  prompt's success confirms the order and staff can still approve the request by hand; the old money is an ops
  exception of its own for staff to refund or apply;
- before AzamPay is called the request is read again after the claim, so a request that was settled or closed in
  between is not sent to a phone.

Why 10 minutes: a USSD push is answered or times out on the handset within a couple of minutes (ASSUMPTION — confirm
in the sandbox), so the member cannot still be approving the old prompt, while a slow callback still has room.
Why hold rather than accept the late success: after a retry two payments may exist for one request, and with no
status query there is nothing to check the first against; a person looks. A request prompted before the column
existed (`promptedAt` empty) keeps waiting as before.
Event orders also keep their hourly sweep: a prompt not completed in 30 minutes is expired (request cancelled); a
success after that is `request_closed` + an ops exception.

## Staff tools stay
`adminPaymentService.decide` and the admin approve / reject / verify / change / refund routes are unchanged: they
are the settlement path AzamPay itself uses and how staff resolve held payments. B2B sponsor invoicing and
collections, payouts, the settlement engine, refunds and pricing are untouched. An **organisation's** event order is
still paid by a payment notice (`POST /b2b/organizations/:id/event-orders/:orderId/payment`), not by a phone prompt.

## Payouts (disbursement) — client only
`createAzamPayClient` has `disburse`, `nameLookup` and `payoutStatus`, and the checksum
`Base64(RSA_PKCS1(SHA512(text)))`. **Not wired into the settlement "pay" step yet**: AzamPay must first give the
checksum public key and say which fields form the checksum text. Until then statements are paid by hand as today.
(Selcom was never used for payouts: only its payment webhook existed, and that is what was removed.)

## Known gaps (confirm in the sandbox before any flag goes on)
- The docs' sample code signs the 4-field text with PKCS#1 v1.5 (checked again 2026-11-17); the field list elsewhere
  in the docs names 2 fields. We accept only the 4-field form (it signs the status). Confirm with one real sandbox callback.
- Which callback id equals the `transactionId` the checkout returns is not documented; all three are matched.
- Number-prefix → network table is an ASSUMPTION (numbers port between networks); the app should let members choose.
- The 10-minute prompt window is an ASSUMPTION about handset timeouts (see above).
- A request left pending with another provider's prompt (`provider` `tunzaa`, before 2026-11-17) is not prompted
  again and no callback will come for it: staff approve or reject it, or the member cancels and starts again.
- Shop orders: only a **member's** own order is payable (`AZAMPAY_SHOP_ORDERS`); a trainer / owner / vendor buying in the
  shop still has the order confirmed by staff (the pay route admits members, and trainers for their own trainer pass).
  Checkout still accepts `paymentMethod` / `paymentReference`.
- An organisation's event order and B2B invoices are not payable through AzamPay (bank / payment notice).
- Held AzamPay money appears to staff as ops exceptions (and audit rows); there is no screen dedicated to it.
- Not done yet (from the security review, to decide with a real sandbox callback): making the callback user /
  password mandatory in live; matching a transaction only on a signed field; a unique index for single use.
- Disbursement checksum: SHA-512 as hex is an ASSUMPTION; fields unknown (ask AzamPay).
- Disbursement callback's `operator` enum lists only Airtel, Azampesa, Tigo — confirm M-Pesa / HaloPesa payouts.

## Early renewals start when the current plan ends (`SCHEDULED_RENEWALS`, off)
Owner decision 2026-11-15. With the flag on, a FitFlex Pass (any tier) or a gym plan paid while the member's
current plan of the same product (same gym, for gym plans) is still running is stored `scheduled`, starting at that
plan's `expiresAt` with its full length. It applies to every way a plan is paid (AzamPay, admin approval).
- `GET /me` lists them in `scheduledRenewals` [{ id, type, tier, plan, homeGymId, startsAt, expiresAt }].
- One renewal may wait at a time: `POST /me/subscribe` answers 409 `renewal_already_scheduled`.
- It becomes `active` at its start: on the member's next `/me` or check-in, or by the `scheduledPlanStarter` job
  (every 15 min). Then the member gets the usual "pass active" notification and the activation events run.
- Renewal reminders (T-3/T-1/T-0) are not sent for a plan whose renewal is already scheduled.
- `scheduled` counts as holding its tier (tier-holders).
- Known gaps: admin member views that list only `active` plans do not show a scheduled renewal until it starts;
  refunding a scheduled plan follows the existing refund workflow (not specially handled).

## Logs (2026-11-17)
Every step prints one line with a fixed prefix, never a secret, token, signature, password or full phone number:
- `[azampay] config` at start-up: which AzamPay settings are present (yes/no), the environment, the switches.
- `[azampay] callback_refused` with `reason`: `client_not_configured`, `not_an_object`, `client_id_mismatch`, `callback_auth_mismatch`, `client_id_missing`, `unsigned`, `public_key_unavailable`, `signature_invalid`. Also the field names that arrived, `utilityref`, status, operator, amount, the transaction ids and the last 3 digits of the phone.
- `[azampay] callback` for an accepted one: `signed`, the outcome (`completed`, `held` + reason, `failed`, `unsigned_unmatched`, …).
- `[azampay] call_failed` for a failed call to AzamPay (`token`, `public_key`, `mno_checkout`): HTTP status, code, AzamPay's message.
- `[azampay] mno_checkout`: our reference, wallet, amount, AzamPay's `success`, `transactionId` and message.
- `[azampay] pay` / `[azampay] refresh`: payment request, user, role, wallet, HTTP status and outcome.
