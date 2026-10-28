# Pay by mobile money — Malipo by Tunzaa

Members can pay a pending **FitFlex Pass**, a **pass upgrade** or a **gym plan** from their phone. With
`TUNZAA_TRAINER_PRODUCTS` on (slice B6a) members can also pay **trainer sessions** (`TRAINER_SERVICE`) and trainers
their own **trainer gym pass** (`TRAINER_GYM_PASS`). Shop orders always use the manual flow (`not_payable_this_way`,
marketplace D-9).
Docs: https://malipo.tunzaa.co.tz/docs/ · API host `https://pay.tunzaa.co.tz`.

## Switching it on (dormant by default)
| Variable | Meaning |
|---|---|
| `MALIPO_API_KEY`, `MALIPO_API_SECRET` | Credentials from the Malipo dashboard (`TUNZAA_API_KEY` / `TUNZAA_SECRET_KEY` also work). Server only, never in the apps, never in the repo or chat. |
| `MALIPO_ENV` | `sandbox` (default) or exactly `live` (`TUNZAA_ENV` also works). Anything else is sandbox, and a key starting `SB_` is always sandbox. |
| `TUNZAA_PAYMENTS` | `on` to offer "Pay now". Without it nothing is initiated; callbacks already in flight are still honoured. |
| `TUNZAA_SANDBOX_SETTLES` | `on` to allow paying against the **sandbox**. A sandbox payment still activates a real plan, so without this flag Pay now is not offered in sandbox (live needs nothing extra). Set it only on a test server. |
| `TUNZAA_TRAINER_PRODUCTS` | `on` to make trainer sessions (members) and trainer gym passes (trainers) payable this way. Effective only while `TUNZAA_PAYMENTS` is on. Off: trainers get 403 on the mobile-money routes, trainer products answer 409 `not_payable_this_way`, and `/payments/options` has no `mobileMoney` key. A sandbox run is required before either flag goes on anywhere (owner step). |
| `MALIPO_SANDBOX_SCENARIO` | Sandbox only: `success` or `failure` to rehearse an outcome without a real phone. |

In the Malipo merchant settings set the callback URL (sandbox and live) to `<PUBLIC_API_URL>/webhooks/tunzaa`.

**Sandbox is not money.** An approved sandbox payment still activates the pass or plan in FitFlex, which is why it needs
`TUNZAA_SANDBOX_SETTLES`. The app shows a "Test mode" notice while `/payments/options` reports `environment: "sandbox"`.
`MALIPO_BASE_URL` is ignored when `NODE_ENV=production`.

## Flow
1. The request is created as before (`POST /me/subscribe`, `/me/upgrade`, a gym plan).
2. `POST /me/payments/:id/mobile-money {phone}` → USSD push for **the request's own amount** (never the client's), with
   our reference `<request id>.<attempt>`. The request is claimed first (`provider = tunzaa`, `reference = pending:<ms>`) and
   then marked with the Tunzaa transactionID. A second tap sends no second prompt; at most 5 prompts per member and 3 per
   phone in 10 minutes (429 `too_many_attempts`). A call that may have reached the phone (timeout, 5xx) keeps its claim
   for 2 minutes instead of being released, so a lost answer cannot cause a second prompt.
3. Tunzaa calls `POST /webhooks/tunzaa` (X-Signature HMAC-SHA256 of the key-sorted JSON, secret key). The app also
   polls `POST /me/payments/:id/mobile-money/refresh` while waiting.
4. A callback finds its request by our `reference_id` (so a prompt whose answer was lost still settles). Either way the transaction is **read back from Tunzaa** (`check-status`) before anything is approved; a callback is only a trigger.
5. `COMPLETED` + matching amount → `adminPaymentService.decide(approve)`, the same path an admin uses, so passes, upgrades
   (in place, same end date) and gym plans all settle through one piece of code. The audit actor is `tunzaa`.
   `FAILED` → request released (still pending, `provider = admin_approved`) so the member can retry or an admin can approve by hand.

## Trainer products (B6a, `TUNZAA_TRAINER_PRODUCTS`)
- Who pays what: a **member** session pays FITFLEX_PASS, GYM_SUBSCRIPTION and TRAINER_SERVICE; a **trainer** session
  pays only TRAINER_GYM_PASS (not a gym member plan bought as a trainer). Both only for requests they own (`404 not_found`
  otherwise); the right owner with the wrong role gets `403 not_payable_by_role {product}`. Same rules on `/refresh`.
- `GET /payments/options` adds `mobileMoney: { products: [...] }`, the kinds the caller may pay now (empty while paying is
  not offered). Absent while the flag is off: the app keeps assuming FITFLEX_PASS + GYM_SUBSCRIPTION for members.
- A trainer-session payment whose group holds a rejected session whose slot someone else has booked since is refused
  before any prompt: `409 group_slot_rebooked {bookingIds}` (`trainerBookingService.checkGroupPayment`). If that happens
  while a prompt is out, the money is held for staff (`reason: group_slot_rebooked`); the bookings do not move.
- Settling goes through `decide({automated:true})`: the booking group follows (`applyPaymentToGroup` → `confirmed`), a
  trainer pass becomes `active`. `MONEY_SECOND_APPROVER` does not apply (the provider is the verification), but a
  transaction already used on another approved payment is held (`reference_already_used`).
- Request currency must be TZS (`409 unsupported_currency`).
- While a prompt is out for a group's payment (provider `tunzaa` with a transaction id, or a claim under 2 minutes old),
  its sessions cannot be cancelled by the member, the trainer or an admin: `409 payment_in_progress`. Once the prompt
  completes, fails or its claim expires, cancelling works as before (an unpaid slot shrinks or withdraws the payment;
  that write is conditional, so a prompt claimed at the same moment leaves the payment untouched).
- If `TUNZAA_TRAINER_PRODUCTS` is turned off while a trainer's own pass prompt is out, the trainer can still
  `/refresh` it (not start a new one). Otherwise a trainer's refresh answers `403 forbidden` as before.

## Held for staff (money in, not applied)
Amount differs from the request or is not reported; the request is waiting on a different transaction than the one
confirmed (`transaction_mismatch`); the transaction already confirmed another approved payment (`reference_already_used`,
checked on every settlement whatever `MONEY_SECOND_APPROVER` / `MANUAL_PAY_INSTRUCTIONS` say); a trainer session's slot
was rebooked (`group_slot_rebooked`); the sandbox is not opted in; or an upgrade's plan ended meanwhile.
Money arriving for a request that was cancelled or rejected meanwhile writes `payment_mobile_money_orphaned`: look for it.
A plan with a live prompt cannot be cancelled by the member (`payment_in_progress`); the Selcom webhook ignores it. The request stays pending; an audit row
(`payment_mobile_money_amount_mismatch` / `payment_mobile_money_held`) says why. The member sees "we received your payment".

## Known gaps
- No background sweep: a lost callback is settled when the member's app refreshes or when staff approve. A prompt the
  member ignores stays "in flight" until Tunzaa reports it failed; staff can approve or reset it by hand.
- No refunds or payouts through Tunzaa: refunds stay manual (existing refund workflow).
- The signature canonicalisation is not fully specified in the docs; both compact and `", "`/`": "` renderings are
  accepted. Confirm with one real sandbox callback.
- The Selcom webhook remains, unchanged.
- Tunzaa's merchant reference is not matched on status: `check-status` is read for the transaction id and its status and
  amount are checked, but the reference Tunzaa holds for that transaction is not compared with ours
  (`<request id>.<attempt>`). Mitigations: a request already waiting on a transaction id is held if a different one is
  confirmed (`transaction_mismatch`), and a transaction already used on an approved payment is held
  (`reference_already_used`). Remaining exposure: a signed callback naming another unused transaction of the same amount
  while the request has no transaction id yet (only a claim, e.g. after a timeout) would settle it.
