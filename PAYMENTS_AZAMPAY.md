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
| `AZAMPAY_BANK_CHECKOUT` | `on` to offer **bank checkout** (CRDB, NMB; needs `AZAMPAY_PAYMENTS`). Off: `POST /me/payments/:id/bank` is 404. |
| `AZAMPAY_CHECKOUT_PAGE` | `on` to offer AzamPay's **hosted payment page** (needs `AZAMPAY_PAYMENTS`, `AZAMPAY_VENDOR_ID` + `AZAMPAY_VENDOR_NAME`, and `PUBLIC_API_URL` and/or `PORTAL_PUBLIC_URL`). Off or not configured: `POST /me/payments/:id/checkout-page` is 404. |
| `AZAMPAY_VENDOR_ID`, `AZAMPAY_VENDOR_NAME` | The vendor AzamPay knows this app as, for the payment page (`vendorId` is a uuid). Not secret. List them with `node scripts/azampay-partners.mjs` (`GET /api/v1/Partner/GetPaymentPartners`: `paymentVendorId`, `vendorName`). |
| `PUBLIC_API_URL`, `PORTAL_PUBLIC_URL` | Already used elsewhere. For the payment page they are where a payer is sent back to: `app` → `<PUBLIC_API_URL>/payments/azampay/return`, `web` → `<PORTAL_PUBLIC_URL>/m/payment-return/`. https only. A target whose base is not set is not offered. |
| `AZAMPAY_SHOP_ORDERS` | `on` to make a member's own shop order payable (needs `AZAMPAY_PAYMENTS`). Off: a shop order is confirmed by staff as before. |
| `AZAMPAY_CALLBACK_USER`, `AZAMPAY_CALLBACK_PASSWORD` | A second shared secret on every callback (compared in constant time). **Required when `AZAMPAY_ENV=live`**: without both, AzamPay is CLOSED and the server logs `[azampay] MISCONFIGURED (live_callback_auth_missing)`. Optional in the sandbox; when set, the callback must carry them. |
| `AZAMPAY_PAGE_HOSTS` | Optional, comma-separated host names. A payment-page address is passed to a client only when it is https, has no user part and is on `azampay.co.tz` (or a sub-domain) or one of these hosts. |
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

## Three ways to pay (contract for the apps)
All three act on the **same payment request** and are settled the **same way**: only by AzamPay's signed callback,
through `adminPaymentService.decide`. One attempt is open at a time on a request, whatever the method. Ownership
(someone else's request is 404 `not_found`), roles and product gates are identical for all three.

### `GET /payments/options` (any signed-in user)
```json
{ "enabled": true, "provider": "azampay", "environment": "sandbox",
  "methods": ["mobile_money", "bank", "page"],
  "bank": { "providers": ["CRDB", "NMB"], "maxAmountTzs": 5000000 },
  "page": { "returnTo": ["app", "web"], "languages": ["en", "sw"] },
  "mobileMoney": { "products": ["FITFLEX_PASS", "GYM_SUBSCRIPTION"] } }
```
`enabled`, `provider`, `environment` and `mobileMoney` are as before. **New, additive**: `methods` (always present;
`[]` while paying is off; `mobile_money` first), `bank` (only while bank checkout is on) and `page` (only while the
page is on; `returnTo` lists the targets that are configured on the server). `mobileMoney.products` applies to every method.

### 1. Mobile money — `POST /me/payments/:id/mobile-money` (unchanged)
Body `{ "phone": "0712345678", "network": "Mpesa" }` → 202 `{ state: "in_progress", paymentRequest, method: "mobile_money" }`.

### 2. Bank checkout — `POST /me/payments/:id/bank` (`AZAMPAY_BANK_CHECKOUT`)
The payer first gets a one-time password **from their own bank** (the app shows these steps; they are AzamPay's):
- CRDB: dial `*150*03#`, enter the SIM Banking PIN, `7` other services, `5` AzamPay, "Link AzamPay Account".
- NMB: dial `*150*66#`, `8` More, `5` Register Sarafu, `1` Select Account No.

Request body:
```json
{ "bank": "CRDB", "accountNumber": "0150123456789", "phone": "0712345678", "otp": "123456" }
```
| Field | Rule |
|---|---|
| `bank` | `CRDB` or `NMB` (any case) |
| `accountNumber` | the payer's bank account: 5–30 letters, digits, `-`, `/` or spaces |
| `phone` | the mobile number registered with the bank (`0…`, `255…` or `+255…`) |
| `otp` | 4–12 letters or digits. **Passed to AzamPay and kept nowhere**: not stored, not logged, not in the audit |

Response 202:
```json
{ "state": "in_progress", "method": "bank",
  "paymentRequest": { "id": "pay_1a2b3c4d", "status": "pending", "amountTzs": 60000, "provider": "azampay", "reference": "<AzamPay transaction id>" } }
```
Then poll `POST /me/payments/:id/refresh`. Errors: 400 `invalid_bank { allowed }` | `invalid_account_number` |
`invalid_phone` | `invalid_otp`; 404 `feature_disabled` | `not_found`; 403 `not_payable_by_role`; 409
`payment_not_pending` | `manual_payment_submitted` | `not_payable_this_way` | `tier_not_available` | `invalid_amount` |
`unsupported_currency` | `amount_over_bank_limit { maxTzs }` | the event / shop / trainer pre-checks of the mobile-money
route; 409 `bank_attempts_exhausted { max: 5 }` (the bank refused this request 5 times: the bank method is closed
for it — offer another method; it reopens only when the request is recreated or staff reset `bankRejections`);
422 `provider_rejected` (AzamPay refused it — e.g. a wrong OTP; the request is free again at once); 429
`too_many_attempts` (5 per member, 3 per phone in 10 minutes — the same limits as prompts); 503 `provider_unavailable`
(AzamPay may have received it: the request stays claimed for 2 minutes, no second charge).
What AzamPay receives: `{ amount (number, the request's own), currencyCode: "TZS", merchantAccountNumber, merchantMobileNumber,
merchantName: null, otp, provider, referenceId: "<request id>.<attempt>" }`.

### 3. Hosted payment page — `POST /me/payments/:id/checkout-page` (`AZAMPAY_CHECKOUT_PAGE`)
Request body (both optional):
```json
{ "returnTo": "app", "language": "en" }
```
`returnTo` is a **name**, never an address: `app` or `web`, whichever the server has configured (`page.returnTo`;
default: the first). `language`: `en` (default) or `sw`. Anything else in the body is ignored.

Response 202:
```json
{ "state": "in_progress", "method": "page", "checkoutUrl": "https://…azampay…/…",
  "paymentRequest": { "id": "pay_1a2b3c4d", "status": "pending", "amountTzs": 60000, "provider": "azampay", "reference": "<our 30-character page reference>" } }
```
Open `checkoutUrl` in the **external browser** (mobile) or a new window / the same tab (web). While the page is open
(30 minutes) the same call answers 200 `{ state: "in_progress", alreadyRequested: true, method: "page", checkoutUrl }`
with the **same** page, and so does a refresh — a member who closed it opens it again; no second attempt is made.
Errors: 400 `invalid_return_to { allowed }` | `invalid_language { allowed }`; 404 `feature_disabled` | `not_found`;
403 `not_payable_by_role`; 409 `payment_not_pending` | `manual_payment_submitted` | `not_payable_this_way` (also: a
request whose id cannot be put in a page reference) | `return_not_configured` | `tier_not_available` |
`invalid_amount` | `unsupported_currency` | the event / shop / trainer pre-checks; 422 `provider_rejected`; 429
`too_many_attempts`; 503 `provider_unavailable`.

**Coming back.** AzamPay redirects the payer to an address the **server** built:
- `app` → `GET <PUBLIC_API_URL>/payments/azampay/return?result=success|failed` — a small public page of this server
  ("go back to the FitFlex app"). The app refreshes the payment when it returns to the foreground.
- `web` → `<PORTAL_PUBLIC_URL>/m/payment-return/?paymentRequestId=<id>&result=success|failed` — a member-portal page
  (to be built in the portal) that calls refresh for that request.

**The redirect is never proof of payment.** `result` is only a hint for what to show while refreshing; a request
becomes `approved` only when AzamPay's signed callback arrives. Nothing a client sends becomes part of a redirect
address (no open redirect): `src/shared/azampay-return.mjs`.

**The 30-character `externalId`.** AzamPay asks for a "30 characters long unique string", so `<request id>.<attempt>`
does not fit. The page reference is 30 lower-case letters/digits:
`f` + `L` (one base-36 digit: the length of the request id without `pay_`, 1–19) + that id + the attempt (the time in
base 36, left-padded with `0`). It parses back to exactly one request and one attempt (`parsePageReference`), two
attempts never share one, and it is compared case-insensitively. Until the page is paid there is no AzamPay
transaction, so the request waits on this reference; when the callback arrives the request is approved and
**AzamPay's own transaction id** (`transid`) is what is recorded and kept single-use.

### Refresh — `POST /me/payments/:id/refresh` (new, every method)
The same answer as `POST /me/payments/:id/mobile-money/refresh` (kept for current apps):
```json
{ "state": "in_progress | completed | failed | held | none", "reason": "…", "paymentRequest": { … }, "remark": "…", "checkoutUrl": "…" }
```
`checkoutUrl` is present only while a payment page is open. It reports where the request stands; it settles nothing.
Every `paymentRequest` in these answers carries `productType` (`FITFLEX_PASS`, `GYM_SUBSCRIPTION`, `TRAINER_SERVICE`,
`TRAINER_GYM_PASS`, `EVENT_ORDER`, `SHOP_ORDER`): what is being paid for, so a return page can link back to it.

### Shop orders
`POST /me/shop-orders` and each row of `GET /me/shop-orders` now carry `paymentRequestId`: the pending payment
request to pay with any method above, or `null` once it is paid, cancelled or free.

### Callback
The same `POST /webhooks/azampay` for all three methods (same schema, same RSA signature, same checks). A verified
**success** whose reference matches no payment request is no longer just acknowledged: it is audited
(`payment_mobile_money_unmatched`) and raised as an ops exception keyed on the fields AzamPay **signs**
(`azampay_unmatched:<utilityref>:<externalreference>`). A replay of the same signed callback with other (unsigned)
transaction ids or amounts is counted on that one exception and writes no further audit row.

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

### Bank checkout and the payment page
The same rules apply unchanged: exact amount, single use, holds, ops exceptions, given-up attempts
(`supersededReferences`), the re-read after the claim. Differences:
- **a failed try on the page does not end the attempt.** While the page is within its 30 minutes, a signed `failure`
  for the page reference is only put on record (audit `payment_mobile_money_page_try_failed`): the request keeps
  waiting on the page, an event order's payment stays pending, and a retry on the same page that succeeds settles
  normally. (Releasing it would have let that retry succeed with no attempt open: charged, then held.) After the
  window a failure releases the request as usual. A failed prompt or bank checkout is still released at once;
- **OTP guessing**: each refusal by the bank is counted on the request (`PaymentRequest.bankRejections`, same
  migration); after 5 the bank method answers 409 `bank_attempts_exhausted` for that request;
- **an event order's places are held for the page's whole window** (30 minutes + 1, never past the hold cap or the
  event's start), not by the 10-minute prompt rule;
- the audit row of a bank attempt keeps the bank and the **last four** characters of the account (`account: "…7766"`)
  for disputes — never the number, the phone or the OTP;
- `checkoutUrl` is cleared when the request is decided (by the callback or by staff) or released, and is only ever
  handed out for a pending request whose page is still open;
- a bank checkout is given up after the same 10 minutes as a prompt; a **payment page after 30 minutes**
  (`PAGE_TTL_MS`; `PaymentRequest.checkoutUrl`, migration `20270218090000-payment-request-checkout-url`, marks the
  attempt as a page and lets the same page be reopened). ASSUMPTION: AzamPay does not document how long its page lives;
- a page AzamPay refused to create frees the request at once (nothing can have been paid on a page nobody got);
- a late payment on an old page is found by its own 30-character reference and held (`transaction_mismatch`).

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

## ASSUMPTIONS for bank checkout and the payment page (confirm each in the sandbox before either flag goes on)
1. **The callback's `utilityref` is our `referenceId` (bank) / `externalId` (page).** The docs call `utilityref` the
   "Partner's reference" but do not say so for these two methods. If it is not, the callback matches no request: the
   payment is NOT lost (audit + ops exception `azampay_unmatched:<utilityref>:<externalreference>`) but nothing is
   activated automatically.
2. **Bank checkout's `merchantAccountNumber` / `merchantMobileNumber` are the PAYER's bank account and mobile number.**
   The docs give only the field names and lengths (their sample: `'1292-123'`, `'255123123123'`); the OTP steps
   ("Link AzamPay Account") point to the payer. `merchantName` is sent as `null` (optional).
3. **Bank checkout is confirmed by the callback**, like a phone prompt, and its 200 answer `{ transactionId, success }`
   is not itself proof of payment. If AzamPay sends no callback for bank payments, they will sit `in_progress` until
   given up — nothing is activated wrongly.
4. **`amount` for bank checkout is a number** (the schema says number; the docs' own sample sends a string).
5. **OTP shape**: 4–12 letters or digits (the docs' sample is `1234`); the phone number is sent as `255…`.
6. **The page's `vendorId` / `vendorName` are one vendor for the whole app**, taken from GetPaymentPartners
   (`paymentVendorId`, `vendorName`). If partners carry different vendors, AzamPay must say which the page uses.
7. **PostCheckout answers a bare URL string** (JSON-quoted or plain text; `{ data | url }` is also read). Only an
   absolute http(s) address is passed on (https only in live).
8. **`externalId` may be lower-case letters and digits**, and comes back unchanged (or only changed in case).
9. **`language`** takes `en` / `sw`; **`requestOrigin`** is the origin of the return address; **`cart.items[].name`**
   is shown on the page (we send `FitFlex`).
10. **The page lives no longer than 30 minutes**, and AzamPay redirects to `redirectSuccessURL` / `redirectFailURL`
    without needing them registered in advance.
11. The page's callback `amount` is the amount charged, in whole shillings, and `transid` is unique per payment.
12. **Whether the page lets a payer retry after a failed try, and whether AzamPay sends a callback per try**, is not
    documented. We assume it may: a `failure` inside the page's window does not end the attempt (see above). If the
    page closes on the first failure, the only cost is that the member waits out the window (or the app offers
    another method once `refresh` says `none`).
13. The page's address is on `azampay.co.tz` (or a sub-domain). If AzamPay serves it elsewhere, name the host in
    `AZAMPAY_PAGE_HOSTS`; until then PostCheckout's answer is refused (422 `provider_rejected`).

## Known gaps (confirm in the sandbox before any flag goes on)
- The docs' sample code signs the 4-field text with PKCS#1 v1.5 (checked again 2026-11-17); the field list elsewhere
  in the docs names 2 fields. We accept only the 4-field form (it signs the status). Confirm with one real sandbox callback.
- Which callback id equals the `transactionId` the checkout returns is not documented; all three are matched.
- Number-prefix → network table is an ASSUMPTION (numbers port between networks); the app should let members choose.
- The 10-minute prompt window is an ASSUMPTION about handset timeouts (see above).
- A request left pending with another provider's prompt (`provider` `tunzaa`, before 2026-11-17) is not prompted
  again and no callback will come for it: staff approve or reject it, or the member cancels and starts again.
- Bank checkout and the payment page have **never been called against AzamPay** (sandbox or live): everything above
  the callback is built from the documentation only.
- The wallet / bank actually used is not stored on the payment request (there is no column for it and none was
  added): the method, the bank and the wallet the member chose are in the audit row `payment_mobile_money_requested`;
  for an event order the callback's `operator` is in `EventPayment.rawRedacted`. A shop order's `paymentMethod` is
  still what checkout sent.
- A request cancelled by another path than the callback or the staff tools (a member cancelling the plan, the event
  sweep) may keep a stale `checkoutUrl` in its row; it is never handed out (only a pending request with an open page
  returns it).
- A signed `failure` replayed for an open page writes one audit row per delivery (no ops exception).
- Staff have no route to reset `bankRejections`; it is reset by recreating the request (or in the database).
- The member-portal page `/m/payment-return/` is built in fitflex-portal#236.
- Shop orders: only a **member's** own order is payable (`AZAMPAY_SHOP_ORDERS`); a trainer / owner / vendor buying in the
  shop still has the order confirmed by staff (the pay route admits members, and trainers for their own trainer pass).
  Checkout still accepts `paymentMethod` / `paymentReference`.
- An organisation's event order and B2B invoices are not payable through AzamPay (bank / payment notice).
- Held AzamPay money appears to staff as ops exceptions (and audit rows); there is no screen dedicated to it.
- Not done yet (from the security review, to decide with a real sandbox callback): matching a transaction only on a
  signed field (the amount and `transid` are not signed by AzamPay); a unique index for single use.
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
