# Pay by mobile money — Malipo by Tunzaa

Members can pay a pending **FitFlex Pass**, a **pass upgrade** or a **gym plan** from their phone. Shop orders,
trainer sessions and trainer passes still use the manual flow (`not_payable_this_way`).
Docs: https://malipo.tunzaa.co.tz/docs/ · API host `https://pay.tunzaa.co.tz`.

## Switching it on (dormant by default)
| Variable | Meaning |
|---|---|
| `MALIPO_API_KEY`, `MALIPO_API_SECRET` | Credentials from the Malipo dashboard (`TUNZAA_API_KEY` / `TUNZAA_SECRET_KEY` also work). Server only, never in the apps, never in the repo or chat. |
| `MALIPO_ENV` | `sandbox` (default) or exactly `live` (`TUNZAA_ENV` also works). Anything else is sandbox, and a key starting `SB_` is always sandbox. |
| `TUNZAA_PAYMENTS` | `on` to offer "Pay now". Without it nothing is initiated; callbacks already in flight are still honoured. |
| `TUNZAA_SANDBOX_SETTLES` | `on` to allow paying against the **sandbox**. A sandbox payment still activates a real plan, so without this flag Pay now is not offered in sandbox (live needs nothing extra). Set it only on a test server. |
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

## Held for staff (money in, not applied)
Amount differs from the request or is not reported, the sandbox is not opted in, or an upgrade's plan ended meanwhile.
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
