# Custom gym passes & flexible membership — API contract (phase 2, backend)

Flag: **`GYM_CUSTOM_PASSES`** (off by default). Off: every route below answers `404 { "error": "feature_disabled" }`
before any sign-in check, the legacy daily / weekly / monthly plans and every existing route behave exactly as before.
A payment already made for a pass is still applied when the flag is turned off (the money was taken).

Source of truth for every route's errors: the `description` of each export in `functions/gym-passes.mjs`.

## Model

| Thing | Where | Notes |
|---|---|---|
| Plan | `GymPassPlan` | owner-designed: `category` individual (1 person) / couples (2) / group (3..50), duration in days / weeks / months (max 730 d / 104 w / 24 m), `priceTzs` whole TZS (1..100,000,000), `startPolicy` `immediate` only, optional `terms` + `termsVersion` |
| Purchase (one sale) | `GymPassPurchase` | `pending_payment → active → expired`, or `cancelled`. `snapshot` = what the buyer saw and paid; editing the plan never changes it |
| Person covered | `GymPassBeneficiary` | the buyer holds slot 1. `pending_registration` (no account yet) / `active` / `suspended` / `removed` |
| Payment | `PaymentRequest.passPurchaseId` | ONE request for the full price, `provider: admin_approved`, `note: gym_pass`. Product type is still `GYM_SUBSCRIPTION` |
| Access | `Subscription.passPurchaseId`, `.passBeneficiaryId` | every covered person gets their OWN `direct_sub` (`tier: null`, `plan: null`, `homeGymId` = the gym, same `expiresAt` as the sale). No payment rows of their own |
| Visits | `Checkin.passPurchaseId`, `.beneficiaryId` | set on a check-in made with a pass's child subscription; **`null`** (the keys are present, not absent) on every other check-in |
| Abuse state | `GymPassBeneficiary.suspendedByRole / contactHash / contactMask / addedBy / addedByRole / sendCount`, `GymPassContactBlock` | migration `20270214090000-gym-pass-abuse-limits` (security review of PR #355); see *Privacy and abuse limits* |

Months are calendar months (31 Jan + 1 month = 28/29 Feb); days and weeks are 24-hour days. The pass runs from the
moment the payment is **approved**, not from the request.

## Rules

* Headcount at checkout (buyer included): individual 1; couples exactly 2; group 3 .. the plan's limit. After checkout
  a group can still fill free slots up to its limit. The limit is enforced under a row lock: concurrent adds cannot exceed it.
* Beneficiaries are **notified, not asked** (owner decision D3). With an active member account: own subscription at once + in-app
  (`gym_pass_added`) + push + WhatsApp, falling back to SMS. Without (or with a suspended / deleted / non-member account, or
  across a member block): `pending_registration` + invite link
  (`<base>/gym-pass/#<token>`, token only in the hash, stored hashed, expires in `GYM_PASS_INVITE_EXPIRY_DAYS` (30) or at the
  pass's end, whichever is first). The `/gym-pass` page is in the **portal**, so `<base>` is `GYM_PASS_INVITE_BASE_URL`, else
  `PORTAL_PUBLIC_URL` (trimmed, trailing slashes stripped); `FRIEND_INVITE_BASE_URL` / `APP_DOWNLOAD_LINK` are no longer used here.
  **If neither is set no link is built or sent** (`share.link` is `null`): the person is still invited, still attached by their
  verified contact, and the SMS reads "...Sign up on FitFlex with this number to start using it." (WhatsApp's invite template needs
  the link, so it is skipped and SMS is used). Email-only contacts have no send channel: use `…/invite` to get the link to share.
  The buyer's name in every outgoing text is sanitised (no links, no digit runs, 30 characters; falls back, per reader language, to the shared "a member" word: "A member" / "Mwanachama").
* **Invite expiry, one rule everywhere.** The *link* expires (`invitation.status: expired` in the preview, `410 invitation_expired` on
  a claim made with its token). The *person* does not: signing up and verifying the invited contact still attaches them
  (`POST /me/gym-passes/claim` without a token, or `GET /me/gym-passes`) until the pass itself ends. A claim made with a token
  never attaches the token's own row once its link has expired.
* A person is attached **only** through a contact they have **verified** (verified-contacts). The token alone attaches nothing;
  a profile-typed (unverified) number matches nothing.
* Removing a person never refunds and never cancels the pass; it frees the slot (a replacement). The buyer cannot be
  removed. A buyer may remove at most `beneficiaryLimit` people per purchase; the owner and the person themself without limit.
* **Who suspended** is recorded (`suspendedByRole`: `owner` | `buyer` | `admin`). A buyer may resume only what a buyer suspended
  (`403 suspended_by_other` otherwise); the owner may resume anything.
* **Owner-removed contacts**: a contact (or the account behind it) the gym owner removed from a purchase cannot be re-added by the
  buyer (`403 removed_by_owner`); the owner may re-add it.
* **Leaving is final for that buyer**: a person who leaves is blocked, by every verified contact and by account, from being
  attached again to that purchase or to any other purchase of the same buyer, by the buyer *or* the owner (`409 cannot_add_person`
  on an add, the generic `invalid_beneficiaries` at checkout; a pending row is skipped at claim). There is no unblock route in this
  version: only a future, explicit action by the person could lift it.
* Suspended / removed people are refused at check-in with the existing code `subscription_inactive`; an expired pass the same;
  another gym `wrong_gym`. No new refusal code.
* A payment that is rejected / cancelled / put back to pending stops access (purchase `cancelled` / `pending_payment`,
  child subscriptions `cancelled`); approving it again re-activates the same rows.

## Privacy and abuse limits

* **Nobody learns whether a typed contact has an account.** A person the buyer attached reads `status: "invited"` (and no name) in
  every buyer view until they have made a first visit on the pass; then `active` and a masked name. Before payment every row
  reads `awaiting_payment`. The buyer's add answers `invited` for everyone. A buyer's transition error `invalid_transition`
  carries no `from`. (Residual: a buyer who tries to suspend a person who has not got a subscription yet gets `invalid_transition`;
  attempts are throttled below.)
* **`POST …/beneficiaries/:id/invite` does not reveal an account.** It answers the same for a person waiting for an account and one
  already attached (both read "invited" to the buyer): same checks, same 429 `too_soon` pacing, same `{ share { link, text }, delivery }`
  shape. For an attached person `link` is a well-formed token that matches nothing (it opens to "invitation not valid"), and the
  person is sent the normal "added" text, not an invite. 404 `not_found` only for a removed person, the buyer's own row, another
  purchase's row or an unknown id. (Residual: the waiting path writes a token, the other does not: a few ms of timing.)
* **Owner add answer is masked**: `{ id, slot, isPurchaser: false, status: "invited", contactType, contact (masked) }`, no `userId`,
  no name, no `notifiedVia`, whatever the account state. Owner *lists* (`pass-memberships`, `pass-purchases/:id`) still show the
  name and `userId` of people who hold a subscription at the gym, as for any member.
* **Owner Members list** (`GET /owner/members`, `GET /owner/members/:id`): for a member whose current direct subscription belongs to a
  pass (`Subscription.passPurchaseId`), `phone` (and `email` in the detail) are masked and `photoUrl` is `null` until the person has
  one valid check-in at the owner's gym(s). Rows without a pass are unchanged; the `search` filter runs on the masked value.
* **Plain contacts are short-lived.** `contactValue` exists only while a person is `pending_registration`; it is nulled on claim,
  activation, removal and account erasure. After that only `contactMask` (shown) and `contactHash`
  (`sha256("<type>:<normalised value>")`, used by limits and blocks) remain; both are nulled on erasure.
* **Limits**, all `429 rate_limited { retryAfterSeconds }` with a `Retry-After` header unless noted:

  | What | Default | Env var |
  |---|---|---|
  | add attempts per actor (buyer, or owner per gym) per hour, failures included | 40 (the friend lookup's) | `GYM_PASS_ADD_ATTEMPTS_PER_HOUR` |
  | adds per buyer per hour (after checkout) | 20 | `GYM_PASS_BUYER_ADDS_PER_HOUR` |
  | adds per owner per gym per hour | 30 | `GYM_PASS_OWNER_ADDS_PER_GYM_PER_HOUR` |
  | rows created for one contact per day, any actor, any purchase, incl. checkout | 3 | `GYM_PASS_TARGET_PER_DAY` |
  | `POST /me/gym-pass-purchases` per member per hour | 20 | `GYM_PASS_PURCHASE_PER_HOUR` |
  | SMS/WhatsApp attempts per purchase (past it nothing is sent; links are still returned) | max(8, 4 × slots) | `GYM_PASS_SENDS_PER_PURCHASE` |

  The attempt throttle and the route limiters are per server instance (as the friend lookup); the add / target caps are counted from
  the table. `POST …/invite` also keeps `429 too_soon` (once an hour per person).
* **Member blocks** (the friends feature) are honoured: a person who blocked the buyer, or whom the buyer blocked, is never attached
  by that buyer's pass, gets no notification and no invite text.
* **SMS log** keeps the invite text with the link replaced by `[invite link removed]`.
* **Account erasure** (`account-erasure-store-pg`): for an erased user their rows lose contact, hash, mask and token, become `removed`
  (`removedByRole: "erasure"`, slot freed) and their pass subscription is cancelled; for an erased buyer the same applies to the
  pending people on their purchases (attached people keep the pass but lose the stored contact), the sale and its payment stay,
  and `GymPassContactBlock` rows about or by them are deleted. Other buyers' pending invitations to the erased person's own numbers
  are removed too.

## Routes

Public: `GET /gyms/:id/pass-plans`, `POST /gym-pass-invitations/preview { token }`.

Member (`member` token): `POST /me/gym-pass-purchases`, `POST /me/gym-pass-purchases/:purchaseId/cancel`,
`GET /me/gym-passes`, `POST /me/gym-passes/claim { token? }`, `POST /me/gym-passes/:purchaseId/leave`, and as buyer
`POST /me/gym-pass-purchases/:purchaseId/beneficiaries` and `…/beneficiaries/:beneficiaryId/(suspend|resume|remove|invite)`.

Owner (`gym_operator`, or `gym_staff` with the scope): plans need scope `gyms`
(`GET|POST /owner/gyms/:gymId/pass-plans`, `PUT …/:planId`, `POST …/:planId/(activate|deactivate)`); sales and revenue need
`payments` (`GET …/pass-sales`, `GET …/pass-summary`); people need `members` (`GET …/pass-memberships`,
`GET …/pass-purchases/:purchaseId`, `…/beneficiaries/:beneficiaryId/attendance`, `POST …/beneficiaries`,
`POST …/beneficiaries/:beneficiaryId/(suspend|resume|remove)`).

### Response and error details (contract drift fixed)

* `purchaseCore` (every purchase body): `{ id, status, gymId, planId, plan (snapshot), priceTzs, currency, paymentRequestId, startsAt, expiresAt, createdAt }`
  plus the route's extras (`beneficiaries`, `slots`, `gym`, `payment`, …). `startsAt` / `expiresAt` are `null` until the payment is approved.
* `POST /me/gym-pass-purchases` → `202 { purchase, paymentRequest }`; `paymentRequest` is the **raw inserted `PaymentRequest` row**
  (all columns, e.g. `id, memberId, gymId, amountTzs, status, provider, passPurchaseId, requestedAt, …`), not a reduced view.
* `POST /me/gym-pass-purchases` accepts an optional **`expectedPriceTzs`** (the price the member was shown). If present and not equal to
  the plan's current price: `409 { error: "price_changed", priceTzs, currency }` and nothing is created. Absent or `null` = no check.
* `beneficiary_limit_exceeded`: **`400` at checkout** with `{ limit }` = the absolute group maximum (50); **`409` on an add** with
  `{ limit }` = that pass's slot count.
* Owner memberships `beneficiaries[]`: `{ id, slot, isPurchaser, status, userId|null, displayName|null, contactType|null, contact (masked)|null,
  subscriptionId, notifiedAt, notifiedVia: ("in_app"|"whatsapp"|"sms")[], claimedAt, removedAt, removedByRole (owner|purchaser|self|erasure), attendance { visits, lastVisitAt } }`.
  `notifiedVia` is an array (empty when nothing went out).
* New / changed error codes: `invalid_beneficiaries` (400, checkout), `removed_by_owner` (403), `suspended_by_other` (403),
  `cannot_add_person` (409), `rate_limited` (429, `{ retryAfterSeconds }`). `cannot_add_yourself` on an add is now `409 cannot_add_person`
  when the contact resolves to the buyer's account by another contact (a typed own contact is still `400 cannot_add_yourself`).
  `duplicate_beneficiary` at checkout now means only "the same contact typed twice"; one account typed by phone and by email is
  `invalid_beneficiaries`.

**The app must call `GET /me/gym-passes` (or `POST /me/gym-passes/claim`) after sign-in / contact verification** — that is
where a person invited without an account is attached.

## Settings and environment

* `GYM_CUSTOM_PASSES` — the flag.
* `GYM_PASS_INVITE_EXPIRY_DAYS` — invite link life, default 30.
* `GYM_PASS_INVITE_BASE_URL` (else `PORTAL_PUBLIC_URL`; neither → no link is sent) — the base of the invite link (the portal host that serves `/gym-pass`)
  (`<base>/gym-pass/#<token>`; shared with friend invitations).
* Limits: `GYM_PASS_ADD_ATTEMPTS_PER_HOUR`, `GYM_PASS_BUYER_ADDS_PER_HOUR`, `GYM_PASS_OWNER_ADDS_PER_GYM_PER_HOUR`,
  `GYM_PASS_TARGET_PER_DAY`, `GYM_PASS_PURCHASE_PER_HOUR`, `GYM_PASS_SENDS_PER_PURCHASE` (table above).
* `GYM_PASS_WHATSAPP_TEMPLATE_ADDED` (default `gym_pass_added`), `GYM_PASS_WHATSAPP_TEMPLATE_INVITE` (default `gym_pass_invite`) —
  WhatsApp templates (params: buyer, pass name, gym, until-date / link). Used only when the WhatsApp channel is enabled and
  the template is approved in `WhatsAppTemplate`; otherwise SMS (category `invitation`) carries the message.

## Swahili

All new texts exist in English and Swahili. The Swahili is a **placeholder** (the English wording behind `[SW pending review]`)
in `src/shared/gym-pass-texts.mjs` (in-app notices `gym_pass_added` / `gym_pass_active`, and the SMS / WhatsApp texts). They are
kept out of `NOTIFICATION_TEXTS` because `specs/notification-languages.specs.mjs` requires real Swahili there. In-app notices
carry both languages in `data` (`titleEn/bodyEn/titleSw/bodySw`, as the trainer no-show notice does) and are sent in the reader's
chosen language. Replace the `sw` builders once native review is done. The API's error codes are English identifiers for the
apps to translate.
