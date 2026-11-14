# Pay by mobile money — AzamPay

AzamPay **replaces Malipo by Tunzaa** for new mobile-money payments (owner decision 2026-11-15) while
`AZAMPAY_PAYMENTS` is on. Members pay a pending **FitFlex Pass**, a **pass upgrade** or a **gym plan**; with
`AZAMPAY_TRAINER_PRODUCTS` also trainer sessions and a trainer's gym pass. Shop orders stay manual; **event orders stay
on Tunzaa's dormant flow** (`EVENTS_PAYMENTS_TUNZAA`) until moved separately.
Docs: https://developerdocs.azampay.co.tz · Sandbox portal: https://developers.azampay.co.tz

Built dormant. Nothing changes until the flags below are set.

## Switching it on
| Variable | Meaning |
|---|---|
| `AZAMPAY_APP_NAME`, `AZAMPAY_CLIENT_ID`, `AZAMPAY_CLIENT_SECRET` | From the app registered on the AzamPay portal. Server only — never in the apps, the repo or chat. |
| `AZAMPAY_API_KEY` | Optional. Sent as `X-API-Key` on checkout calls if the portal issues one. |
| `AZAMPAY_ENV` | `sandbox` (default) or exactly `live`. Live also needs `AZAMPAY_AUTH_URL`, `AZAMPAY_CHECKOUT_URL`, `AZAMPAY_DISBURSE_URL` (AzamPay gives the production hosts after KYC approval); without all three it stays sandbox. Host overrides are ignored in sandbox when `NODE_ENV=production`. |
| `AZAMPAY_PAYMENTS` | `on` to offer "Pay now" through AzamPay. Replaces Tunzaa for new payments; Tunzaa prompts already out still settle through Tunzaa. |
| `AZAMPAY_SANDBOX_SETTLES` | `on` to allow paying against the **sandbox**. A sandbox payment still activates a real plan, so set it only on a test server. |
| `AZAMPAY_TRAINER_PRODUCTS` | `on` to make trainer sessions / trainer gym passes payable (needs `AZAMPAY_PAYMENTS`). |
| `AZAMPAY_CALLBACK_USER`, `AZAMPAY_CALLBACK_PASSWORD` | Optional. If AzamPay is configured to send them, the callback must carry them. |
| `AZAMPAY_DISBURSE_PUBLIC_KEY` | Payouts only: the RSA public key (PEM) AzamPay gives for the disbursement checksum. Payouts stay closed without it. |

Callback URL to register with AzamPay (sandbox app, later production): `<PUBLIC_API_URL>/webhooks/azampay`.

## Flow
1. The payment request is created as before (`POST /me/subscribe`, `/me/upgrade`, a gym plan).
2. `POST /me/payments/:id/mobile-money {phone, network?}` → AzamPay MNO checkout (USSD push) for **the request's own
   amount**, `externalId` = our reference `<request id>.<attempt>`. `network` is the wallet (`Mpesa`, `Tigo`, `Airtel`,
   `Halopesa`, `Azampesa`); without it the network is taken from the number prefix (400 `network_required` if unknown).
   Claiming, double-tap protection and rate limits are the same code as Tunzaa (`mobile-money-service`).
3. AzamPay calls `POST /webhooks/azampay`. The route verifies the **RSA-SHA256 signature** over
   `{utilityref}{externalreference}{transactionstatus}{operator}` with AzamPay's public key
   (`GET /azampay/v1/public-key`, cached 24 h, fetched again once on a mismatch) and that `clientId` is ours.
4. The request is found by `utilityref` (our reference). **AzamPay has no status query for collections**, so the
   verified callback is the confirmation. Before approving: amount must equal the request's, the transaction must be the
   one recorded when the prompt went out (any of `transid` / `reference` / `externalreference`), and it must not have
   confirmed another approved payment. Then `adminPaymentService.decide(approve)` — the same path as admins and Tunzaa;
   the audit actor is `azampay`.
5. `failure` → the request is released so the member can retry. `POST …/mobile-money/refresh` reports where it stands
   (it cannot ask AzamPay; it settles nothing on its own).

## Payouts (disbursement) — client only
`createAzamPayClient` has `disburse`, `nameLookup` and `payoutStatus`, and the checksum
`Base64(RSA_PKCS1(SHA512(text)))`. **Not wired into the settlement "pay" step yet**: AzamPay must first give the
checksum public key and say which fields form the checksum text. Until then statements are paid by hand as today.

## Known gaps (confirm in the sandbox before any flag goes on)
- The docs disagree on what the callback signature covers (4 fields in one section, 2 in the field list). We accept
  only the 4-field form (it signs the status). Confirm with one real sandbox callback.
- Which callback id equals the `transactionId` the checkout returns is not documented; all three are matched.
- Number-prefix → network table is an ASSUMPTION (numbers port between networks); the app should let members choose.
- No sweep: a prompt whose callback never arrives stays "in flight" until staff approve or reset it (there is no
  status query to ask).
- Disbursement checksum: SHA-512 as hex is an ASSUMPTION; fields unknown (ask AzamPay).
- Disbursement callback's `operator` enum lists only Airtel, Azampesa, Tigo — confirm M-Pesa / HaloPesa payouts.
- Event orders are not payable through AzamPay.
- Tunzaa code is kept (dormant) so in-flight Tunzaa prompts settle; remove it once AzamPay is live.

## Early renewals start when the current plan ends (`SCHEDULED_RENEWALS`, off)
Owner decision 2026-11-15. With the flag on, a FitFlex Pass (any tier) or a gym plan paid while the member's
current plan of the same product (same gym, for gym plans) is still running is stored `scheduled`, starting at that
plan's `expiresAt` with its full length. It applies to every way a plan is paid (AzamPay, Tunzaa, Selcom, admin approval).
- `GET /me` lists them in `scheduledRenewals` [{ id, type, tier, plan, homeGymId, startsAt, expiresAt }].
- One renewal may wait at a time: `POST /me/subscribe` answers 409 `renewal_already_scheduled`.
- It becomes `active` at its start: on the member's next `/me` or check-in, or by the `scheduledPlanStarter` job
  (every 15 min). Then the member gets the usual "pass active" notification and the activation events run.
- Renewal reminders (T-3/T-1/T-0) are not sent for a plan whose renewal is already scheduled.
- `scheduled` counts as holding its tier (tier-holders).
- Known gaps: admin member views that list only `active` plans do not show a scheduled renewal until it starts;
  refunding a scheduled plan follows the existing refund workflow (not specially handled).
