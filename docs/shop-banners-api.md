# Shop home banners API (Phase 2 · slice 1)

Status: on `feat/shop-banners` → `release-candidate`, **dormant** (`SHOP_BANNERS` off). Design spec: `docs/design/shop-home-phase2.md` §4–§5 in the parent repo (plus Phase 1 `docs/design/shop-home.md` §6.3, B-1).
Owner decisions this implements (2026-10-20): vendors propose, staff approve (never their own); both languages required; no prices, percentages or amounts in banner text; models allowed in product shots but never framed as FitFlex members or partners, and the uploader confirms rights and people; no paid placement (no "Sponsored" label); **no maximum run length and no per-audience cap**; proposals expire after 14 days or at their start.

Portal and mobile build against this file. Anything not written here is not part of the contract. Revision 2 (review round 1, 2026-10-20) is aligned with portal#127 (915d50b); changes from revision 1 are listed at the end.

## Flags and settings

| Env | Default | Effect |
|---|---|---|
| `SHOP_BANNERS` | off | Off: every route below answers `404 {"error":"feature_disabled"}` **before sign-in is checked**; `GET /shop/home` has **no `banners` key** (the body is byte-identical to Phase 1); the lifecycle job does nothing; `GET /vendor/tools/options` says `merch.banners: false`. |
| `SHOP_PROPOSAL_EXPIRY_DAYS` | `14` | A pending proposal expires at the earlier of *sent + N days* and its `startsAt`. Positive integer; anything else → 14. |
| `SHOP_BANNER_MAX_LIVE` | `0` | Display limit only: how many live banners `GET /shop/home` returns (0 = all). Never blocks an approval. |
| `SHOP_BANNER_MAX_OPEN` | `10` | Abuse limit: a vendor's drafts + pending (not expired) proposals at once. Beyond it → `409 too_many_open_proposals { max, open }`. Positive integer. |

Rate limits per vendor, per minute, in memory per server (with several servers the real allowance is servers × this): create 20, photo upload 10, send for approval 20. Over → `429 rate_limited { retryAfterSeconds }` with a `Retry-After` header.

The app hides the banner tools when `merch.banners` is false and must keep working when `banners` is missing from `/shop/home` (older server, or flag off): show the band / fallback slide.

## States

Stored `status`: `draft` · `pending_approval` · `approved` · `ended` · `rejected` · `withdrawn` · `expired`.
Every view also has `effectiveStatus`, worked out from the clock on every read (never wait for the job):

| effectiveStatus | Meaning | Label EN / SW (draft) | `statusReason` (code) |
|---|---|---|---|
| `draft` | Being written; a vendor draft is visible only to that vendor | — | null |
| `pending_approval` | Sent, waiting for a decision; `expiresAt` says when it lapses | Waiting for approval / Inasubiri idhini | null |
| `approved` | Approved, `startsAt` still ahead | Scheduled / Imepangwa | null |
| `live` | Approved and now inside `[startsAt, endsAt)` | Live / Inaendelea | null |
| `ended` | Window passed, or ended early | Ended / Limesitishwa (when ended early) | `window_passed` · `ended_by_vendor` · `ended_by_fitflex` (+ `statusReasonNote`) |
| `rejected` | Staff said no | Rejected / Imekataliwa | `image` · `people` · `text` · `claim` · `link` · `other` (+ `statusReasonNote`) |
| `expired` | Not decided in time | Expired / Imeisha muda | `not_reviewed_in_time` · `start_passed` |
| `withdrawn` | The proposer took it back before it went live | Withdrawn / Imeondolewa | null |

(While a stored `pending_approval` or `approved` row reads as `expired` / `ended` before the job runs, `statusReason` stays null; show the label from `effectiveStatus`.)

Transitions:

| From (effective) | Action | To |
|---|---|---|
| draft | submit | pending_approval (`submittedBy/At`, `expiresAt` set) |
| draft · pending_approval | edit / new photo | unchanged (pending keeps the time it was sent: `expiresAt` = the earlier of *sent + N days* and the current `startsAt`) |
| rejected | edit / new photo | **draft** (send it again; counts toward `SHOP_BANNER_MAX_OPEN`) |
| approved · live | edit / new photo | **pending_approval** (off the shop until approved again; approval fields and position cleared; `startsAt` must then be ≥ 1 h ahead) |
| draft · pending_approval · approved | withdraw | withdrawn |
| live | withdraw | `409 invalid_transition { hint: "end" }` |
| live | vendor end | ended (`ended_by_vendor`) |
| pending_approval | approve (an admin with no hand in it) | approved |
| pending_approval | reject (an admin with no hand in it) | rejected |
| approved · live | admin end | ended (`ended_by_fitflex`) |
| pending past `expiresAt` | time | expired |
| approved past `endsAt` | time | ended (`window_passed`) |
| ended · expired · withdrawn | edit / photo | `409 not_editable { currentStatus }` |

Every change of content or photo adds 1 to `revision`. "Copy to new" is client-side (create a new draft from an old banner's fields).

## Banner body (create and PATCH)

All fields optional on create and PATCH (a draft may be partial); all needed to submit. Unknown fields → `400 unknown_field { fields }`; not an object → `400 invalid_body`.

| Field | Shape | Rules |
|---|---|---|
| `headlineLead` | `{ en, sw }` | Required to submit. Lead + accent ≤ **32** chars EN, ≤ **42** SW (`422 headline_too_long { field, max, length }`). |
| `headlineAccent` | `{ en, sw }` | Required to submit. Shown in the accent colour. |
| `subline` | `{ en, sw }` \| `null` | Optional. ≤ 70 EN / 90 SW (`422 text_too_long { field, max }`). Both or neither: `{ en:"", sw:"" }` or `null` clears it. |
| `ctaKey` | `view_product` \| `visit_store` \| `shop_now` \| `view_all` \| `null` | Optional; left out → the key for the target (`product` → `view_product`, `vendor_store` → `visit_store`, `category` → `shop_now`, `results` → `view_all`). **Vendors** may only send `view_product` / `visit_store`, and only the one matching their target (`422 invalid_cta_key { field, allowed }`). |
| `ctaLabel` | `{ en, sw }` | **FitFlex staff only**, ≤ 24 EN / 30 SW; overrides `ctaKey`. From a vendor → `422 cta_label_not_allowed { field, allowed }`. |
| `imageAlt` | `{ en, sw }` | Required to submit. ≤ 160 EN / 200 SW. |
| `target` | `{ type, value }` | See Targets. Required to submit. |
| `audienceRoles` | `["member","trainer","owner"]` subset | At least one (`422 audience_required`); unknown → `400 invalid_audience`. Default: all three. |
| `startsAt`, `endsAt` | ISO 8601 | Not a date → `400 invalid_date { field }`. `endsAt` > `startsAt` (`422 end_before_start { field: "endsAt" }`). On submit (and on an edit that sends an approved banner back) `startsAt` ≥ now + 1 h (`422 start_too_soon { field, earliestStart }`). **No maximum length.** |

Button labels (`ctaKey` → `{ en, sw }`): `view_product` View product / Tazama bidhaa · `visit_store` Visit store / Tembelea duka · `shop_now` Shop now / Nunua sasa · `view_all` View all / Tazama zote. Views always return `ctaKey` (null when staff wrote a `ctaLabel`) and the `ctaLabel` in effect; `ctaLabelCustom` says whether staff wrote it.

### Text rules (every `{ en, sw }` field, both languages)

Texts are stored and checked **normalised**: Unicode NFKC (fullwidth `％`/digits → ASCII, ligatures split), format characters removed (`\p{Cf}`: zero-width spaces/joiners, bidi controls, soft hyphens), whitespace collapsed. Digits are any `\p{Nd}` (Arabic-Indic too).

- One language missing → `422 missing_translation { field: "<name>.<en|sw>", missing: ["sw"] }`; bad shape → `400 invalid_field { field }`.
- A link, handle or phone number → `422 contact_in_text { field }` (checked first): `http(s)://`, `www.`, a dot + a TLD (com net org info biz shop store app io me co tz ke ug rw bi africa online site website xyz link ly tv club fit fitness, so `shop.co.tz`, `x.co.ke`), "dot com" / "nukta com", `@handle`, `+255…` / `+254…`, `07…` / `06…` / `01…` mobile numbers, any run of 9+ digits.
- A price, percentage or amount → `422 price_claim_in_text { field }`: any percent sign (`%`, `٪`, `﹪`); `/=`; a number followed by `/-`; `TSh` / `TZS` / `KSh` / `Sh` / `shilingi` / `bob` next to a number; `bei` / `price` followed by a number; the words `shilingi`, `asilimia`, `percent`, `per cent`, `pct`, `elfu`, `laki`, `milioni`, `million`, `punguzo`, `bure`, `nusu bei`, `half price`, `discount`; grouped amounts (`50,000`, `1.200.000`); **any 4+ digit number** (this also refuses years such as "Since 2019").
- Allowed: small plain numbers ("Buy 2, get 1", "5K run"), "Sugar-free", "Co-op".

## Targets

| `type` | `value` | Who | Eligible (submit, approve, and again on every `/shop/home` request) |
|---|---|---|---|
| `product` | product id | vendor (own products only), staff | Listed (active, approved, not hidden, not deleted), its vendor allowed to sell; on `/shop/home` also **in stock** and not the viewer's own |
| `vendor_store` | vendor id (vendors may leave it out = their own store) | vendor (own store only), staff | Vendor not suspended, approved and operational; on `/shop/home` also at least one in-stock product |
| `category` | product category key (`equipment`, `supplements_nutrition`, …) | staff only | On `/shop/home`: at least one in-stock product in it |
| `results` | `{ category?, search?, brand?, vendorId?, promotions?, sort?, delivery? }` (the `GET /shop/products` query) | staff only | Always |

A vendor naming another vendor's product or store (or a product that does not exist) → `403 target_not_owned { field: "target.value" }`. A vendor using `category`/`results` → `403 target_type_not_allowed { allowed }`. Bad shape → `400 invalid_target { field }`. Not on sale at submit/approve → `422 target_not_eligible { field, reason }` (`product_not_listed` · `vendor_suspended` · `vendor_not_approved` · `vendor_not_found`).

## Photo

`POST …/:id/image`, `multipart/form-data`:

| Part | Value |
|---|---|
| `file` | JPEG, PNG or WebP; ≤ **5 MB**; ≥ **1600 × 1000** px after rotation |
| `people` | `none` \| `product_models` |
| `confirmationVersion` | the `confirmation.version` from the list response (now `2026-10-20.draft1`). Anything else → `400 confirmation_version_mismatch { field, current }`: reload and show the current texts. |
| `rightsConfirmed` | `true`: the uploader accepts `confirmation.rights` |
| `peopleConfirmed` | `true`, **required when `people=product_models`**: the uploader accepts `confirmation.models` |
| `consentRef` | the model release reference, **required when `people=product_models`** (≤ 200; `400 consent_reference_required`) |
| `licenceRef` | optional, ≤ 200 (e.g. "own shoot", a stock licence number) |
| `focalX`, `focalY` | optional, −1..1 (default 0) |

**Confirmation texts** (`confirmation` in `GET /vendor/shop-banners` and `GET /admin/shop-merch`; status `draft_pending_counsel`: **draft wording pending Tanzanian counsel and Swahili native review**; show them exactly as sent):

```json
"confirmation": {
  "version": "2026-10-20.draft1",
  "status": "draft_pending_counsel",
  "rights": { "en": "I have the right to use this image, and FitFlex may show it in its apps and portal.", "sw": "Nina haki ya kutumia picha hii, na FitFlex inaweza kuionyesha kwenye app na portal zake." },
  "models": { "en": "The people are models showing the product. The banner does not present them as FitFlex members, trainers or partners, and has no names or quotes from them. I hold their consent (model release) and give its reference.", "sw": "Watu hawa ni wanamitindo wanaoonyesha bidhaa. Bango haliwaonyeshi kama wanachama, ma-trainer au washirika wa FitFlex, na halina majina wala maneno yao. Nina ridhaa yao (model release) na ninatoa kumbukumbu yake." }
}
```

The photo goes through the app-photo pipeline: rotated upright, converted to sRGB, re-encoded as WebP, **EXIF/GPS/XMP stripped**, and kept **private** until the banner is approved. Approval makes the public files (WebP 1080 / 540 / up to 1600 wide + AVIF). A new photo replaces the old one (the old row is retired), counts as an edit and is a new revision. The uploader is recorded as the confirmer of rights and people (for `none`, choosing "No people" is the people declaration), with the version accepted, `consentRef` and `licenceRef`.

Errors: `400 invalid_people { allowed }` · `400 confirmation_version_mismatch { current }` · `400 rights_confirmation_required` · `400 people_confirmation_required` · `400 consent_reference_required` · `400 invalid_reference { field, maxLength }` · `400 invalid_focal` · `400 no_file_provided` · `400 unsupported_file_type { reason }` · `400 image_too_small { minWidth: 1600, minHeight: 1000, width, height }` · `400 invalid_multipart` · `413 file_too_large { maxBytes }` · `409 not_editable` · `409 too_many_open_proposals` (a rejected banner would become a draft) · `429 rate_limited` · `500 image_save_failed` · `503 storage_service_unavailable`. A refusal after the private file was stored leaves no row but always an audit row `shop_banner.image_orphaned` (hash of the storage key, never the key).

Previews of the private photo: `GET …/:id/image?w=240|480|960` (omit `w` for the full cleaned master). WebP, `Cache-Control: no-store, private`. `400 invalid_width`, `404 image_not_found`, `502 stored_file_mismatch`, `503 storage_service_unavailable`.

## Views

### Vendor view (`banner`)

```json
{
  "id": "sbn_1a2b3c4d5e6f", "origin": "vendor", "vendorId": "usr_vendor_1",
  "status": "approved", "effectiveStatus": "live", "revision": 3,
  "headlineLead": { "en": "Train harder with", "sw": "Fanya mazoezi zaidi na" },
  "headlineAccent": { "en": "new gear", "sw": "vifaa vipya" },
  "subline": { "en": "Fresh stock from a Dar seller.", "sw": "Bidhaa mpya kutoka kwa muuzaji wa Dar." },
  "ctaKey": "view_product", "ctaLabel": { "en": "View product", "sw": "Tazama bidhaa" }, "ctaLabelCustom": false,
  "imageAlt": { "en": "Dumbbells on a rack", "sw": "Dumbbell kwenye rafu" },
  "target": { "type": "product", "value": "prd_1" }, "targetName": "Adjustable dumbbells",
  "audienceRoles": ["member", "trainer", "owner"],
  "startsAt": "2026-10-21T07:00:00.000Z", "endsAt": "2026-10-28T07:00:00.000Z",
  "position": 1, "statusReason": null, "statusReasonNote": null,
  "expiresAt": null,
  "submittedAt": "…", "approvedAt": "…", "decidedAt": "…", "endedAt": null, "createdAt": "…", "updatedAt": "…",
  "endedByFitflex": false,
  "image": {
    "id": "hero_…", "width": 2560, "height": 1600, "people": "none", "focal": { "x": 0, "y": 0 },
    "rightsConfirmedAt": "…", "peopleConfirmedAt": "…",
    "confirmationVersion": "2026-10-20.draft1", "consentRef": null, "licenceRef": null,
    "previewUrl": "/vendor/shop-banners/sbn_1a2b3c4d5e6f/image",
    "public": { "url1x": "/storage/…-1x.webp", "url2x": "/storage/…-2x.webp", "urlWide": "/storage/…-wide.webp", "focal": { "x": 0, "y": 0 } }
  },
  "allowedActions": ["edit", "end", "image"]
}
```

- `statusReason` is a **code** (see States); `statusReasonNote` is the text FitFlex wrote (reject note, end note), shown as "Reason: {note}" / "Ended by FitFlex: {note}".
- `expiresAt` is set only while `status` is `pending_approval` (the card line "Expires {date} if not reviewed").
- `image` is `null` until a photo is uploaded; `image.public` is `null` until approval.
- `endedByFitflex: true` ⇔ `statusReason = ended_by_fitflex`.
- Vendors never get staff ids or names.
- `allowedActions` ⊆ `edit`, `image`, `submit`, `withdraw`, `end` for this banner now. `edit` and `image` have the same states (draft, pending, rejected, approved, live).

### Admin view

The vendor view (with `previewUrl` `/admin/shop-banners/:id/image`, no `endedByFitflex`) plus:
- `vendorName` (business name; `null` for staff banners), `sellerSuspended`, `targetName`;
- `createdBy`/`createdByName`, `submittedBy`/`submittedByName`, `approvedBy`/`approvedByName`, `decidedBy`/`decidedByName`, `endedBy`/`endedByName`;
- **`editedBy`**: every actor id that created, edited, replaced the photo of or sent the banner, over its whole life (a superset of "edited while pending");
- **`image.uploadedBy`** / `uploadedByName`, `image.rightsConfirmedBy`/`rightsConfirmedByName`, `image.peopleConfirmedBy`/`peopleConfirmedByName` (for "Confirmed by {name}, {date}");
- `ownItem`: this admin is in `editedBy`, is the creator or sender, or uploaded/confirmed the photo. Then show "You created this, so another admin must approve it." (the server refuses anyway);
- `allowedActions` for **this admin**: `edit`, `image`, `submit`, `withdraw` (staff banners, scope `promotions`); `approve`, `reject` (pending, scope `promotions_approve`, not `ownItem`); `end` (approved/live, `promotions_approve`); `position` (approved/live, `promotions_approve`, not `ownItem`).

## Vendor endpoints

Who: the vendor account (`userType: vendor`) or vendor staff (`vendor_staff`) whose **stored** staff record holds `products`. Staff without it → `403 vendor_permission_forbidden { requiredPermission: "products" }`; the staff lookup failing → `503 authorization_unavailable`; other roles → `403 forbidden`; signed out → `401 unauthenticated`. A vendor only ever sees their own banners: anyone else's id → `404 banner_not_found`.
Proposing (create, PATCH, photo, submit) needs a vendor that is not suspended (`403 vendor_suspended`, also when suspended in moderation), has `approvalStatus` exactly `approved` **and** is operational (KYC gate) (`403 vendor_not_approved`), and exists (`404 vendor_not_found`). Fail closed (QA round 2): `pending_approval` (what new vendors get), `pending`, `rejected` and any other value are not approved, whatever the KYC gate says. The same rule decides whether a live banner stays in the shop, whether a pending one can be approved (`409 vendor_not_approved`) and whether a `product` / `vendor_store` target is eligible. Withdraw and end are always allowed. A suspended vendor *account* is already stopped at sign-in (`403 account_suspended`); `vendor_suspended` is what their still-active staff get.

| Method | Path | Body | → |
|---|---|---|---|
| GET | `/vendor/shop-banners` | `?status=<effectiveStatus>` (else `400 invalid_status`), `&limit=&cursor=` | `{ items: [banner], total, nextCursor, vendor: { canPropose, reason: null \| "vendor_suspended" \| "vendor_not_approved" \| "vendor_not_found" }, proposalExpiryDays, openProposals: { open, max }, confirmation }` (newest first) |
| POST | `/vendor/shop-banners` | banner body; `target.type` `product` \| `vendor_store` | `201 { banner }` (draft) · `409 too_many_open_proposals` · `429 rate_limited` |
| GET | `/vendor/shop-banners/:id` | — | `{ banner }` |
| PATCH | `/vendor/shop-banners/:id` | banner body (at least one field, else `400 nothing_to_change`) | `{ banner }` (state per Transitions) |
| POST | `/vendor/shop-banners/:id/image` | multipart (see Photo) | `{ banner }` · `429 rate_limited` |
| GET | `/vendor/shop-banners/:id/image` | `?w=` | WebP bytes |
| POST | `/vendor/shop-banners/:id/submit` | — | `{ banner }` (pending_approval) · `429 rate_limited` |
| POST | `/vendor/shop-banners/:id/withdraw` | — | `{ banner }` (withdrawn) |
| POST | `/vendor/shop-banners/:id/end` | — | `{ banner }` (ended; live only) |

Submit errors, in check order: `409 invalid_transition` (not a draft) · `403 vendor_suspended` / `vendor_not_approved` · `422 invalid_cta_key` · `422 missing_translation` / `contact_in_text` / `price_claim_in_text` / `headline_too_long` · `422 target_required` · `422 audience_required` · `422 start_required` / `end_required` / `end_before_start` / `start_too_soon` · `422 image_required` · `403 target_not_owned` · `422 target_not_eligible` · `422 image_people_unconfirmed` (photo without its confirmations, version, or the model release reference).

`GET /vendor/tools/options` (and `tools` in `GET /vendor/me`) also carries `merch: { banners: boolean }` (= `SHOP_BANNERS` on). The key is always present.

## Admin endpoints

Scopes (super-admins pass all): view = `promotions` or `promotions_approve`; manage FitFlex banners = `promotions`; decide = `promotions_approve`. Missing scope → `403 acl_forbidden { requiredScope }`. No new scope was added.
A vendor's **drafts are never visible** to FitFlex (list, detail, decisions: `404 banner_not_found`). FitFlex never edits a vendor's banner (PATCH/photo/submit/withdraw on one → `404 banner_not_found`).

| Method | Path | Scope | Body | → |
|---|---|---|---|---|
| GET | `/admin/shop-merch` | view | `?kind=banner` (default; else `400 invalid_kind` until flash sales), `?tab=requests\|scheduled\|live\|closed\|drafts` (else `400 invalid_tab`), `?status=<effectiveStatus>` (else `400 invalid_status`), `?origin=vendor\|staff`, `?vendorId=`, `?q=` (seller, product or headline), `?limit` (≤ 100, default 25), `?cursor` | `{ items: [admin banner], total, nextCursor, counts: { requests, scheduled, live, closed, drafts }, confirmation }` |
| GET | `/admin/shop-banners/:id` | view | — | `{ banner, history: [{ id, at, actor, actorName, action, target, before, after }] }` (oldest first; `actorName` null for the system job) |
| GET | `/admin/shop-banners/:id/image` | view | `?w=` | WebP bytes |
| POST | `/admin/shop-banners` | promotions | banner body; any target type; `ctaLabel` allowed | `201 { banner }` (origin `staff`, draft) |
| PATCH | `/admin/shop-banners/:id` | promotions | banner body | `{ banner }` |
| POST | `/admin/shop-banners/:id/image` | promotions | multipart | `{ banner }` |
| POST | `/admin/shop-banners/:id/submit` | promotions | — | `{ banner }` |
| POST | `/admin/shop-banners/:id/withdraw` | promotions | — | `{ banner }` |
| POST | `/admin/shop-banners/:id/approve` | promotions_approve | `{ revision, imageId, checks: ["people","text","languages"], position?: 0–9999 }` | `{ banner }` |
| POST | `/admin/shop-banners/:id/reject` | promotions_approve | `{ code: "image"\|"people"\|"text"\|"claim"\|"link"\|"other", note?: ≤ 500 (required for "other"; the vendor sees it), revision, imageId }` | `{ banner }` |
| POST | `/admin/shop-banners/:id/end` | promotions_approve | `{ note: 1–500 chars (the vendor sees it; `reason` is accepted as an alias) }` | `{ banner }` |
| POST | `/admin/shop-banners/:id/position` | promotions_approve | `{ position: 0–9999 \| null }` | `{ banner }` (stays approved) |

History `action` values: `shop_banner.created` · `updated` · `image_uploaded` · `submitted` · `image_published` · `approved` · `rejected` · `withdrawn` · `ended` · `expired` · `position_set` · `image_orphaned` · `public_files_orphaned`.

Lists: `requests` (and `status=pending_approval`) are sorted by `expiresAt`, soonest first; everything else newest first.

**Two-person rule.** Approve, reject and position are refused with `403 cannot_approve_own_submission` for anyone who created, edited, replaced the photo of or sent the banner (`editedBy`), or uploaded/confirmed its photo.

**The decision is about what the reviewer saw.** Approve and reject must send the `revision` (or, as a fallback, the `updatedAt` from the view) and the `imageId` (`image.id`) they reviewed. Missing → `400 revision_required { fields }`. Anything changed since → `409 banner_changed { revision, updatedAt, imageId }` (the current values): reload and review again.

Approve, in check order: `409 proposal_expired { expiresAt }` · `409 invalid_transition` · `400 revision_required` / `409 banner_changed` · `403 cannot_approve_own_submission` · `400 invalid_position` · `422 image_people_unconfirmed { required }` (no photo, the uploader's confirmations, version or model release reference missing, a people value other than `none`/`product_models`, or `checks` without `"people"`) · `422 review_checks_required { missing, required }` · completeness errors as on submit (start may now be < 1 h away) · `409 vendor_suspended` / `409 vendor_not_approved` · `403 target_not_owned` · `422 target_not_eligible` · `503 storage_service_unavailable`.
The public files are made **outside** the banner lock; then, under the lock, every check runs again before the state changes. If anything changed meanwhile the answer is `409 banner_changed` (or the new error), the banner is untouched, and the files already made are recorded (`shop_banner.public_files_orphaned` with their URLs). A part-way upload failure answers `503`, leaves the banner pending and records the files already made the same way.
Reject, in check order: `409 proposal_expired` · `409 invalid_transition` · `400 revision_required` / `409 banner_changed` · `403 cannot_approve_own_submission` · `400 reason_code_required` / `400 invalid_reason_code { allowed }` · `400 invalid_note { maxLength }` · `400 note_required` (code `other`).
End: allowed to anyone with `promotions_approve`, the creator too (stopping is always safe). `400 reason_required`.

Every state change is made alone under one database lock, so two admins cannot both decide the same banner, and every change writes an `AuditLog` row with before and after.

## `GET /shop/home` — `banners`

With `SHOP_BANNERS` on (and `SHOP_HOME_V2` on, as before) the body gains **one key**, `banners` (always present then, possibly `[]`). Nothing else in the body changes.

```json
"banners": [{
  "id": "sbn_1a2b3c4d5e6f",
  "image": { "url1x": "/storage/…-1x.webp", "url2x": "/storage/…-2x.webp", "urlWide": "/storage/…-wide.webp", "focal": { "x": 0, "y": 0 } },
  "imageAlt": { "en": "Dumbbells on a rack", "sw": "Dumbbell kwenye rafu" },
  "headlineLead": { "en": "Train harder with", "sw": "Fanya mazoezi zaidi na" },
  "headlineAccent": { "en": "new gear", "sw": "vifaa vipya" },
  "subline": { "en": "…", "sw": "…" },
  "ctaLabel": { "en": "View product", "sw": "Tazama bidhaa" },
  "target": { "type": "product", "value": "prd_1" },
  "origin": "vendor",
  "vendorName": "Dar Fitness Gear",
  "endsAt": "2026-10-28T07:00:00.000Z"
}]
```

- Image URLs are root-relative `/storage/:cid/:file` addresses, as gym photos and `/app/hero-images`.
- `subline` may be `null`. `vendorName` is present **only** on `origin: "vendor"` banners ("From {vendorName}" / "Kutoka {vendorName}"); staff banners have no chip. There is **no promotion / Sponsored field** on any banner.
- Worked out on every request (not cached): approved, `startsAt ≤ now < endsAt`, the request's `mode` in `audienceRoles` (`vendor_personal` mode gets none), the vendor not suspended (account or moderation) and operational, the target eligible (see Targets; product targets use the same catalogue the rest of the page uses), never the viewer's own vendor, photo published.
- Order: `position` ascending (unset last), then staff before vendor, then `startsAt`, then id. Then cut to `SHOP_BANNER_MAX_LIVE` if it is above 0. The client renders in the order received.
- If reading banners fails, `banners` is `[]` and the rest of the page is unaffected.
- `vendorName` uses the same rule as the `vendorName` on product rows (business name, else display name), so a Visit-store heading read from either matches.
- Target handling in the app: `product` → product sheet `?product=<id>`; `vendor_store` → Results `?vendorId=<id>` (the heading can be kept after a reload from `vendorName` on any returned product row); `category` → Results `?category=<key>`; `results` → Results with `value` as the query.

## Vendor notifications

Through the existing `notifyVendor` (shop inbox row + push), on: approve, reject, expiry, and FitFlex ending a vendor banner. Not sent for staff banners, nor when the vendor ends their own. Swahili follows the glossary rows of 2026-10-20 (provisional, needs native review): banner = bango (li- agreement), End = sitisha / limesitishwa ("simamisha" is reserved for Suspended), rejected = limekataliwa.

| Inbox `type` (`MarketplaceNotification`) | Push `type` | EN | SW (draft for native review) |
|---|---|---|---|
| `shop_banner_approved` | `vendor_shop_banner_approved` | Banner approved · Your banner "{headline}" is approved. It goes live {dd/mm/yyyy HH:mm}. | Bango limeidhinishwa · Bango lako "{headline}" limeidhinishwa. Litaanza {date}. |
| `shop_banner_rejected` | `vendor_shop_banner_rejected` | Banner rejected · Your banner "{headline}" wasn't approved. See why. | Bango limekataliwa · Bango lako "{headline}" limekataliwa. Tazama sababu. |
| `shop_banner_expired` | `vendor_shop_banner_expired` | Banner expired · Your banner "{headline}" expired before review. | Bango limeisha muda · Bango lako "{headline}" limeisha muda kabla ya kukaguliwa. |
| `shop_banner_ended` | `vendor_shop_banner_ended` | Banner ended by FitFlex · FitFlex ended your banner "{headline}". | Bango limesitishwa na FitFlex · FitFlex imesitisha bango lako "{headline}". |

Push is in the vendor's language (communication preference `en` → English, otherwise Swahili, as other vendor pushes); push `data`: `{ bannerId, open: "merch", item: <bannerId>, reason, titleSw, bodySw }` → open `/vendor/merch?item=<bannerId>`. Inbox `data`: `{ bannerId, headline, headlineSw, startsAt, reason }` (`reason` = the note). Dates are Tanzania time.

## Job

`shopBannerLifecycle` (every 10 minutes; nothing unless `SHOP_BANNERS`): writes pending proposals past `expiresAt` as `expired` (and tells the vendor) and approved banners past `endsAt` as `ended`. Reads never depend on it.

## Database (migration `20270103090000-shop-banners`)

- New table `ShopBanner` (columns as the views above, plus `ctaKey`, `revision`, `editors` (jsonb array → `editedBy`), `statusReason` (code), `statusReasonNote`, `statusChangedAt`, `createdBy`, `submittedBy`, `approvedBy`, `decidedBy/At`, `endedBy/At`). Checks: origin, status, vendorId iff origin vendor, `endsAt > startsAt`, approved rows complete.
- `HeroImage` gets nullable `purpose` (`hero` \| `shop_banner`; null = app photo), `vendorId` and `confirmationVersion`; `people` may also be `product_models`, **only** on `purpose = 'shop_banner'` rows (DB check; null purpose counts as `hero`). Banner photos use the existing `consentRef` / `licenceRef` columns. The app-photo library (`/admin/hero-images`, slots, publish, rollback) never lists or accepts banner photos.
- Down: drops `ShopBanner`, deletes banner photo rows (and any `product_models` rows), removes the three columns and restores the people check. **After go-live, down loses the banner → photo → public-file mapping**: export `ShopBanner`, the `HeroImage` rows with `purpose = 'shop_banner'` and the `shop_banner.*` AuditLog rows first.

## Errors not tied to one route

`401 unauthenticated` · `403 forbidden` (wrong role) · `403 actor_required` (no signed-in actor reached the service; should not happen through the routes) · `403 account_suspended` · `503 authorization_unavailable` (vendor staff lookup failed) · `404 feature_disabled` (flag off) · `404 banner_not_found`.

## What stays public, and for how long

Zebra cannot delete, so public files are permanent:
- Photos are private until an approval makes their public files. Pending, rejected and withdrawn photos that were **never approved** stay private.
- A photo that **was approved** keeps its public files after the banner is ended, edited back to pending and then rejected, or replaced by a new photo. The banner stops showing it in the shop at once.
- An approval that fails part-way, or is overtaken by an edit while uploading, leaves the public files already made; they are recorded in `shop_banner.public_files_orphaned` (URLs) and used by nothing.

## Deviations from the brief and the design spec

1. **PATCH in `pending_approval` is allowed** (stays pending), as spec AC-08 requires; the brief said "draft/rejected only". Rejected → draft on edit; approved **and live** → pending on edit.
2. **Extra endpoints** beyond the brief: `GET /vendor/shop-banners/:id`, `POST /vendor/shop-banners/:id/end` (spec "End now"), `GET …/:id/image` previews (vendor and admin), `GET /admin/shop-banners/:id` (detail + history), `POST /admin/shop-banners/:id/image|submit|withdraw` (staff banners need a photo and a send step too), `POST /admin/shop-banners/:id/position`.
3. `image` in `/shop/home` banners carries an extra `focal { x, y }` (spec: focal point from upload). Additive.
4. Extra error codes: `contact_in_text` (spec rule "no links or phone numbers"), `review_checks_required` (the spec's approve checklist, enforced on the server); `image_people_unconfirmed` is also returned on **submit**. Rejecting one's own submission is refused with the same `403 cannot_approve_own_submission`.
5. Error code names differ from spec §13: `price_claim_in_text` (spec `banner_text_has_price`), `missing_translation` (`translation_required`), `contact_in_text` (`banner_text_has_contact`), `file_too_large` / `unsupported_file_type` (`image_too_large` / `image_type`, the app-photo pipeline's codes), `text_too_long` (`too_long`). Not implemented by owner decision: the 30-day maximum and `banner_capacity_full` (5 per audience).
6. Audience roles are `member`, `trainer`, `owner` only; `vendor_personal` shopping mode receives no banners.
7. `start_too_soon` (≥ 1 h ahead when sending) is kept from spec §5.2.3.
8. `merch` in `/vendor/tools/options` is always present (`banners: false` when off); it also appears in `/vendor/me` `tools`.
9. `editedBy` lists everyone with a hand in the banner over its whole life, not only edits made while pending (stricter; same field name as portal#127).

## Changes in QA round 2 (2026-10-20)

- **Additive, outside the banner routes:** every buyer-facing product row now has `vendorName` (string \| null): `GET /shop/products`, `GET /shop/products/:id` (and its `similarProducts`), `GET /shop/vendors/:id` `products`, `GET /discover/products` (`items` and `featured`), and `GET /shop/home` `products`. The vendor's own list (`GET /vendor/products`) and admin lists are unchanged.
- Vendor eligibility for banners now requires `approvalStatus = approved` (fail closed; see Vendor endpoints).

## Changes from revision 1 (review round 1, for portal and mobile)

- **New on every view:** `revision`, `ctaKey`, `statusReasonNote`; `image.confirmationVersion`, `image.consentRef`, `image.licenceRef`. **Admin view:** `editedBy`, `image.uploadedBy` / `uploadedByName`. **History rows:** `actorName`.
- **Changed meaning:** `statusReason` is now the **code**; the text moved to `statusReasonNote`. The field `statusReasonCode` is gone.
- **Approve body:** now requires `revision` (or `updatedAt`) + `imageId` → `400 revision_required` / `409 banner_changed`.
- **Reject body:** `{ code (required), note?, revision, imageId }`; the old `reason` field is gone (`note_required` for `other`, `reason_code_required`).
- **End body:** `{ note }` (`reason` still accepted).
- **CTA:** vendors send `ctaKey` only; a vendor `ctaLabel` → `422 cta_label_not_allowed`; a key not matching the target → `422 invalid_cta_key`. Staff may still send `ctaLabel`.
- **Photo upload:** now needs `confirmationVersion`; `product_models` also needs `consentRef`; optional `licenceRef`. List responses carry `confirmation` (texts + version; draft pending counsel).
- **`allowedActions`:** `image` now also in `rejected` and `live` (same states as `edit`); `position` is not offered to someone with a hand in the banner.
- **Two-person rule widened** to everyone in `editedBy` and the photo's uploader (approve, reject, position).
- **Limits:** `429 rate_limited` (create 20, photo 10, submit 20 per vendor per minute), `409 too_many_open_proposals` (`SHOP_BANNER_MAX_OPEN`, default 10); vendor list has `openProposals { open, max }`.
- **Text rules tightened:** normalisation and the wider lists above. Any 4+ digit number is now refused (years too).
- **Swahili:** ended notice "Bango limesitishwa na FitFlex" / "FitFlex imesitisha…", rejected "Bango limekataliwa" / "…limekataliwa".
