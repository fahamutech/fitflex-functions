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
| Visits | `Checkin.passPurchaseId`, `.beneficiaryId` | set on a check-in made with a pass's child subscription; absent otherwise |

Months are calendar months (31 Jan + 1 month = 28/29 Feb); days and weeks are 24-hour days. The pass runs from the
moment the payment is **approved**, not from the request.

## Rules

* Headcount at checkout (buyer included): individual 1; couples exactly 2; group 3 .. the plan's limit. After checkout
  a group can still fill free slots up to its limit. The limit is enforced under a row lock: concurrent adds cannot exceed it.
* Beneficiaries are **notified, not asked** (owner decision D3). With an account: own subscription at once + in-app
  (`gym_pass_added`) + push + WhatsApp, falling back to SMS. Without: `pending_registration` + invite link
  (`<base>/gym-pass/#<token>`, token only in the hash, stored hashed, expires in `GYM_PASS_INVITE_EXPIRY_DAYS` (30) or at the
  pass's end, whichever is first). Email-only contacts have no send channel: use `…/invite` to get the link to share.
* A person is attached **only** through a contact they have **verified** (verified-contacts). The token alone attaches nothing;
  a profile-typed (unverified) number matches nothing.
* Removing a person never refunds and never cancels the pass; it frees the slot (a replacement). The buyer cannot be
  removed. A buyer may remove at most `beneficiaryLimit` people per purchase; the owner and the person themself without limit.
* Suspended / removed people are refused at check-in with the existing code `subscription_inactive`; an expired pass the same;
  another gym `wrong_gym`. No new refusal code.
* A payment that is rejected / cancelled / put back to pending stops access (purchase `cancelled` / `pending_payment`,
  child subscriptions `cancelled`); approving it again re-activates the same rows.

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

**The app must call `GET /me/gym-passes` (or `POST /me/gym-passes/claim`) after sign-in / contact verification** — that is
where a person invited without an account is attached.

## Settings and environment

* `GYM_CUSTOM_PASSES` — the flag.
* `GYM_PASS_INVITE_EXPIRY_DAYS` — invite link life, default 30.
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
