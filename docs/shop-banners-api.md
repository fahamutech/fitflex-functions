# Shop home banners API (Phase 2 · slice 1)

Status: on `feat/shop-banners` → `release-candidate`, **dormant** (`SHOP_BANNERS` off). Design spec: `docs/design/shop-home-phase2.md` §4–§5 in the parent repo (plus Phase 1 `docs/design/shop-home.md` §6.3, B-1).
Owner decisions this implements (2026-10-20): vendors propose, staff approve (never their own); both languages required; no prices, percentages or amounts in banner text; models allowed in product shots but never framed as FitFlex members or partners, and the uploader confirms rights and people; no paid placement (no "Sponsored" label); no maximum run length and no per-audience cap; proposals expire after 14 days or at their start.

Portal and mobile build against this file. Anything not written here is not part of the contract.

## Flags and settings

| Env | Default | Effect |
|---|---|---|
| `SHOP_BANNERS` | off | Off: every route below answers `404 {"error":"feature_disabled"}` **before sign-in is checked**; `GET /shop/home` has **no `banners` key** (the body is byte-identical to Phase 1); the lifecycle job does nothing; `GET /vendor/tools/options` says `merch.banners: false`. |
| `SHOP_PROPOSAL_EXPIRY_DAYS` | `14` | A pending proposal expires at the earlier of *sent + N days* and its `startsAt`. Positive integer; anything else → 14. |
| `SHOP_BANNER_MAX_LIVE` | `0` | Display limit only: how many live banners `GET /shop/home` returns (0 = all). Never blocks an approval. |

The app hides the banner tools when `merch.banners` is false and must keep working when `banners` is missing from `/shop/home` (older server, or flag off): show the band / fallback slide.

## States

Stored `status`: `draft` · `pending_approval` · `approved` · `ended` · `rejected` · `withdrawn` · `expired`.
Every view also has `effectiveStatus`, worked out from the clock on every read (never wait for the job):

| effectiveStatus | Meaning | Spec label (EN / SW) |
|---|---|---|
| `draft` | Being written; only its proposer sees a vendor draft | — |
| `pending_approval` | Sent, waiting for a decision; `expiresAt` says when it lapses | Waiting for approval / Inasubiri idhini |
| `approved` | Approved, `startsAt` still ahead | Scheduled / Imepangwa |
| `live` | Approved and now inside `[startsAt, endsAt)` | Live / Inaendelea |
| `ended` | Window passed, or ended early (`statusReasonCode`: `window_passed` · `ended_by_vendor` · `ended_by_fitflex`) | Ended / Imeisha |
| `rejected` | Staff said no; `statusReason` (+ `statusReasonCode`) is shown to the vendor | Rejected / Imekataliwa |
| `expired` | Not decided in time (`statusReasonCode`: `not_reviewed_in_time` · `start_passed`) | Expired / Imeisha muda |
| `withdrawn` | The proposer took it back before it went live | Withdrawn / Imeondolewa |

Transitions:

| From (effective) | Action | To |
|---|---|---|
| draft | submit | pending_approval (`submittedBy/At`, `expiresAt` set) |
| draft · pending_approval | edit / new photo | unchanged (pending keeps the time it was sent: `expiresAt` = the earlier of *sent + N days* and the current `startsAt`) |
| rejected | edit / new photo | **draft** (send it again) |
| approved · live | edit / new photo | **pending_approval** (off the shop until approved again; approval fields and position cleared; `startsAt` must then be ≥ 1 h ahead) |
| draft · pending_approval · approved | withdraw | withdrawn |
| live | withdraw | `409 invalid_transition { hint: "end" }` |
| live | vendor end | ended (`ended_by_vendor`) |
| pending_approval | approve (another admin) | approved |
| pending_approval | reject (another admin) | rejected |
| approved · live | admin end | ended (`ended_by_fitflex`) |
| pending past `expiresAt` | time | expired |
| approved past `endsAt` | time | ended (`window_passed`) |
| ended · expired · withdrawn | anything | `409 not_editable { currentStatus }` / `409 invalid_transition` |

"Copy to new" is client-side (create a new draft from an old banner's fields).

## Banner body (create and PATCH)

All fields optional on create and PATCH (a draft may be partial); all needed to submit. Unknown fields → `400 unknown_field { fields }`.

| Field | Shape | Rules |
|---|---|---|
| `headlineLead` | `{ en, sw }` | Required to submit. Lead + accent ≤ **32** chars EN, ≤ **42** SW (`422 headline_too_long { field, max, length }`). |
| `headlineAccent` | `{ en, sw }` | Required to submit. Shown in the accent colour. |
| `subline` | `{ en, sw }` \| `null` | Optional. ≤ 70 EN / 90 SW (`422 text_too_long { field, max }`). Both or neither: `{ en:"", sw:"" }` or `null` clears it. |
| `ctaLabel` | `{ en, sw }` | Optional, ≤ 24 EN / 30 SW. **Left out → the default for the target** (`product` "View product / Tazama bidhaa", `vendor_store` "Visit store / Tembelea duka", `category` "Shop now / Nunua sasa", `results` "View all / Tazama zote"). Views always return the label in effect; `ctaLabelCustom` says whether one was set. |
| `imageAlt` | `{ en, sw }` | Required to submit. ≤ 160 EN / 200 SW. |
| `target` | `{ type, value }` | See Targets. Required to submit. |
| `audienceRoles` | `["member","trainer","owner"]` subset | At least one (`422 audience_required`); unknown → `400 invalid_audience`. Default: all three. |
| `startsAt`, `endsAt` | ISO 8601 | `endsAt` > `startsAt` (`422 end_before_start { field: "endsAt" }`). On submit (and on an edit that sends an approved banner back) `startsAt` ≥ now + 1 h (`422 start_too_soon { field, earliestStart }`). **No maximum length.** |

Text rules, every `{ en, sw }` field, both languages:
- One language missing → `422 missing_translation { field: "<name>.<en|sw>", missing: ["sw"] }`.
- A price, percentage or amount → `422 price_claim_in_text { field: "<name>.<en|sw>" }`. Blocked: any `%`; `/=`; `TSh` / `TZS` / `Sh` / `shilingi` next to a number; `bei` / `price` followed by a number; `percent` / `per cent` / `asilimia`; grouped amounts like `50,000` or `1.200.000`. Allowed: plain small numbers ("Buy 2, get 1", "5K run", "Since 2019").
- A link or phone number → `422 contact_in_text { field }` (http(s), www., common domains, Tanzanian mobile numbers, any run of 9+ digits).

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
| `rightsConfirmed` | `true` — "I have the right to use this image, and FitFlex may show it in its apps and portal." |
| `peopleConfirmed` | `true`, **required when `people=product_models`** — "The people are models showing the product. The banner does not present them as FitFlex members, trainers or partners, and has no names or quotes from them." |
| `focalX`, `focalY` | optional, −1..1 (default 0) |

The photo goes through the app-photo pipeline: rotated upright, converted to sRGB, re-encoded as WebP, **EXIF/GPS/XMP stripped**, and kept **private** until the banner is approved. Approval makes the public files (WebP 1080 / 540 / up to 1600 wide + AVIF). A new photo replaces the old one (the old row is retired) and counts as an edit. The uploader is recorded as the person who confirmed rights and people (for `none`, choosing "No people" is the people declaration).

Errors: `400 invalid_people { allowed }` · `400 rights_confirmation_required` · `400 people_confirmation_required` · `400 invalid_focal` · `400 no_file_provided` · `400 unsupported_file_type { reason }` · `400 image_too_small { minWidth: 1600, minHeight: 1000, width, height }` · `400 invalid_multipart` · `413 file_too_large { maxBytes }` · `409 not_editable` · `500 image_save_failed` · `503 storage_service_unavailable`.

Previews of the private photo: `GET …/:id/image?w=240|480|960` (omit `w` for the full cleaned master). WebP, `Cache-Control: no-store, private`. `400 invalid_width`, `404 image_not_found`, `502 stored_file_mismatch`, `503 storage_service_unavailable`.

## Views

### Vendor view (`banner`)

```json
{
  "id": "sbn_1a2b3c4d5e6f", "origin": "vendor", "vendorId": "usr_vendor_1",
  "status": "approved", "effectiveStatus": "live",
  "headlineLead": { "en": "Train harder with", "sw": "Fanya mazoezi zaidi na" },
  "headlineAccent": { "en": "new gear", "sw": "vifaa vipya" },
  "subline": { "en": "Fresh stock from a Dar seller.", "sw": "Bidhaa mpya kutoka kwa muuzaji wa Dar." },
  "ctaLabel": { "en": "View product", "sw": "Tazama bidhaa" }, "ctaLabelCustom": false,
  "imageAlt": { "en": "Dumbbells on a rack", "sw": "Dumbbell kwenye rafu" },
  "target": { "type": "product", "value": "prd_1" }, "targetName": "Adjustable dumbbells",
  "audienceRoles": ["member", "trainer", "owner"],
  "startsAt": "2026-10-21T07:00:00.000Z", "endsAt": "2026-10-28T07:00:00.000Z",
  "position": 1, "statusReason": null, "statusReasonCode": null,
  "expiresAt": null,
  "submittedAt": "…", "approvedAt": "…", "decidedAt": "…", "endedAt": null, "createdAt": "…", "updatedAt": "…",
  "endedByFitflex": false,
  "image": {
    "id": "hero_…", "width": 2560, "height": 1600, "people": "none", "focal": { "x": 0, "y": 0 },
    "rightsConfirmedAt": "…", "peopleConfirmedAt": "…",
    "previewUrl": "/vendor/shop-banners/sbn_1a2b3c4d5e6f/image",
    "public": { "url1x": "/storage/…-1x.webp", "url2x": "/storage/…-2x.webp", "urlWide": "/storage/…-wide.webp", "focal": { "x": 0, "y": 0 } }
  },
  "allowedActions": ["edit", "end"]
}
```

- `expiresAt` is set only while `status` is `pending_approval` (the card line "Expires {date} if not reviewed").
- `image` is `null` until a photo is uploaded; `image.public` is `null` until approval.
- `endedByFitflex: true` → show "Ended by FitFlex: {statusReason}".
- Vendors never get staff ids or names.
- `allowedActions` ⊆ `edit`, `image`, `submit`, `withdraw`, `end` for this banner now.

### Admin view

The vendor view (with `previewUrl` `/admin/shop-banners/:id/image`, no `endedByFitflex`) plus: `vendorName` (business name; `null` for staff banners), `sellerSuspended`, `createdBy`/`createdByName`, `submittedBy`/`submittedByName`, `approvedBy`/`approvedByName`, `decidedBy`/`decidedByName`, `endedBy`/`endedByName`, `ownItem` (this admin created or sent it: show "You created this, so another admin must approve it."), `image.rightsConfirmedBy`/`rightsConfirmedByName`/`peopleConfirmedBy`/`peopleConfirmedByName` (for "Confirmed by {name}, {date}"). `allowedActions` for **this admin**: `edit`, `image`, `submit`, `withdraw` (staff banners, scope `promotions`), `approve`, `reject` (pending, scope `promotions_approve`, not `ownItem`), `end`, `position` (approved/live, scope `promotions_approve`).

## Vendor endpoints

Who: the vendor account (`userType: vendor`) or vendor staff (`vendor_staff`) whose **stored** staff record holds `products`. Staff without it → `403 vendor_permission_forbidden { requiredPermission: "products" }`. A vendor only ever sees their own banners: anyone else's id → `404 banner_not_found`.
Proposing (create, PATCH, photo, submit) needs a vendor that is not suspended (`403 vendor_suspended`, also when suspended in moderation) and is approved and operational (KYC gate; `403 vendor_not_approved`). Withdraw and end are always allowed. A suspended vendor *account* is already stopped at sign-in (`403 account_suspended`); the `vendor_suspended` answer is what their still-active staff get.

| Method | Path | Body | → |
|---|---|---|---|
| GET | `/vendor/shop-banners` | `?status=<effectiveStatus>&limit=&cursor=` | `{ items: [banner], total, nextCursor, vendor: { canPropose, reason: null \| "vendor_suspended" \| "vendor_not_approved" }, proposalExpiryDays }` (newest first) |
| POST | `/vendor/shop-banners` | banner body; `target.type` `product` \| `vendor_store` | `201 { banner }` (draft) |
| GET | `/vendor/shop-banners/:id` | — | `{ banner }` |
| PATCH | `/vendor/shop-banners/:id` | banner body (at least one field, else `400 nothing_to_change`) | `{ banner }` (state per Transitions) |
| POST | `/vendor/shop-banners/:id/image` | multipart (see Photo) | `{ banner }` |
| GET | `/vendor/shop-banners/:id/image` | `?w=` | WebP bytes |
| POST | `/vendor/shop-banners/:id/submit` | — | `{ banner }` (pending_approval) |
| POST | `/vendor/shop-banners/:id/withdraw` | — | `{ banner }` (withdrawn) |
| POST | `/vendor/shop-banners/:id/end` | — | `{ banner }` (ended; live only) |

Submit errors, in check order: `409 invalid_transition` (not a draft) · `403 vendor_suspended` / `vendor_not_approved` · `422 missing_translation` / `price_claim_in_text` / `contact_in_text` / `headline_too_long` · `422 target_required` · `422 audience_required` · `422 start_required` / `end_required` / `end_before_start` / `start_too_soon` · `422 image_required` · `403 target_not_owned` · `422 target_not_eligible` · `422 image_people_unconfirmed`.

`GET /vendor/tools/options` (and `tools` in `GET /vendor/me`) now also carries `merch: { banners: boolean }` (= `SHOP_BANNERS` on). The key is always present.

## Admin endpoints

Scopes (super-admins pass all): view = `promotions` or `promotions_approve`; manage FitFlex banners = `promotions`; decide = `promotions_approve`. Missing scope → `403 acl_forbidden { requiredScope }`. No new scope was added.
A vendor's **drafts are never visible** to FitFlex (list, detail, decisions: `404 banner_not_found`). FitFlex never edits a vendor's banner (PATCH/photo/submit/withdraw on one → `404 banner_not_found`).

| Method | Path | Scope | Body | → |
|---|---|---|---|---|
| GET | `/admin/shop-merch` | view | `?kind=banner` (default; anything else `400 invalid_kind` until flash sales), `?tab=requests\|scheduled\|live\|closed\|drafts`, `?status=<effectiveStatus>`, `?origin=vendor\|staff`, `?vendorId=`, `?q=` (seller, product or headline), `?limit` (≤ 100, default 25), `?cursor` | `{ items: [admin banner], total, nextCursor, counts: { requests, scheduled, live, closed, drafts } }` |
| GET | `/admin/shop-banners/:id` | view | — | `{ banner, history: [{ id, at, actor, action: "shop_banner.<created\|updated\|image_uploaded\|submitted\|approved\|rejected\|withdrawn\|ended\|expired\|position_set>", target, before, after }] }` (oldest first) |
| GET | `/admin/shop-banners/:id/image` | view | `?w=` | WebP bytes |
| POST | `/admin/shop-banners` | promotions | banner body; any target type | `201 { banner }` (origin `staff`, draft) |
| PATCH | `/admin/shop-banners/:id` | promotions | banner body | `{ banner }` |
| POST | `/admin/shop-banners/:id/image` | promotions | multipart | `{ banner }` |
| POST | `/admin/shop-banners/:id/submit` | promotions | — | `{ banner }` |
| POST | `/admin/shop-banners/:id/withdraw` | promotions | — | `{ banner }` |
| POST | `/admin/shop-banners/:id/approve` | promotions_approve | `{ checks: ["people","text","languages"], position?: 0–9999 }` | `{ banner }` |
| POST | `/admin/shop-banners/:id/reject` | promotions_approve | `{ reason: 1–500 chars (the vendor sees it), code?: "image"\|"people"\|"text"\|"claim"\|"link"\|"other" }` | `{ banner }` |
| POST | `/admin/shop-banners/:id/end` | promotions_approve | `{ reason: 1–500 chars }` | `{ banner }` |
| POST | `/admin/shop-banners/:id/position` | promotions_approve | `{ position: 0–9999 \| null }` | `{ banner }` (stays approved) |

Lists: `requests` (and `status=pending_approval`) are sorted by `expiresAt`, soonest first; everything else newest first.

Approve, in check order: `409 proposal_expired { expiresAt }` · `409 invalid_transition` · `403 cannot_approve_own_submission` (the approver created **or** sent it) · `400 invalid_position` · `422 image_people_unconfirmed { required }` (no photo, the uploader's confirmations missing, a people value other than `none`/`product_models`, or `checks` without `"people"`) · `422 review_checks_required { missing, required }` · completeness errors as on submit (start may now be < 1 h away) · `409 vendor_suspended` / `409 vendor_not_approved` · `403 target_not_owned` · `422 target_not_eligible` · `503 storage_service_unavailable` (public files could not be made: nothing changed, try again).
Reject: `409 proposal_expired` · `409 invalid_transition` · `403 cannot_approve_own_submission` · `400 reason_required { maxLength }` · `400 invalid_reason_code { allowed }`.
End: allowed to anyone with `promotions_approve`, the creator too (stopping is always safe). `400 reason_required`.

Every change is made alone under one database lock, so two admins cannot both decide the same banner, and every change writes an `AuditLog` row with before and after.

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
- Target handling in the app: `product` → product sheet `?product=<id>`; `vendor_store` → Results `?vendorId=<id>`; `category` → Results `?category=<key>`; `results` → Results with `value` as the query.

## Vendor notifications

Through the existing `notifyVendor` (shop inbox row + push), on: approve, reject, expiry, and FitFlex ending a vendor banner. Not sent for staff banners, nor when the vendor ends their own.

| Inbox `type` (`MarketplaceNotification`) | Push `type` | EN | SW (draft for native review) |
|---|---|---|---|
| `shop_banner_approved` | `vendor_shop_banner_approved` | Banner approved · Your banner "{headline}" is approved. It goes live {dd/mm/yyyy HH:mm}. | Bango limeidhinishwa · Bango lako "{headline}" limeidhinishwa. Litaanza {date}. |
| `shop_banner_rejected` | `vendor_shop_banner_rejected` | Banner not approved · Your banner "{headline}" wasn't approved. See why. | Bango halikuidhinishwa · Bango lako "{headline}" halikuidhinishwa. Tazama sababu. |
| `shop_banner_expired` | `vendor_shop_banner_expired` | Banner expired · Your banner "{headline}" expired before review. | Bango limeisha muda · Bango lako "{headline}" limeisha muda kabla ya kukaguliwa. |
| `shop_banner_ended` | `vendor_shop_banner_ended` | Banner ended by FitFlex · FitFlex ended your banner "{headline}". | FitFlex imesimamisha bango · FitFlex imesimamisha bango lako "{headline}". |

Push is in the vendor's language (communication preference `en` → English, otherwise Swahili, as other vendor pushes); push `data`: `{ bannerId, open: "merch", item: <bannerId>, reason, titleSw, bodySw }` → open `/vendor/merch?item=<bannerId>`. Inbox `data`: `{ bannerId, headline, headlineSw, startsAt, reason }`. Dates are Tanzania time.

## Job

`shopBannerLifecycle` (every 10 minutes; nothing unless `SHOP_BANNERS`): writes pending proposals past `expiresAt` as `expired` (and tells the vendor) and approved banners past `endsAt` as `ended`. Reads never depend on it.

## Database (migration `20270103090000-shop-banners`)

- New table `ShopBanner` (columns as the views above, plus `statusChangedAt`, `createdBy`, `submittedBy`, `approvedBy`, `decidedBy/At`, `endedBy/At`). Checks: origin, status, vendorId iff origin vendor, `endsAt > startsAt`, approved rows complete.
- `HeroImage` gets nullable `purpose` (`hero` \| `shop_banner`; null = app photo) and `vendorId`; `people` may also be `product_models`, **only** on `purpose = 'shop_banner'` rows (DB check). The app-photo library (`/admin/hero-images`, slots, publish, rollback) never lists or accepts banner photos.
- Down: drops `ShopBanner`, deletes banner photo rows (their private files stay on Zebra, which cannot delete), removes the two columns and restores the people check.

## Deviations from the brief and the design spec (stated precisely)

1. **PATCH in `pending_approval` is allowed** (stays pending), as spec AC-08 requires; the brief said "draft/rejected only". Rejected → draft on edit; approved **and live** → pending on edit (brief: "editing approved → back to pending").
2. **Extra endpoints** beyond the brief: `GET /vendor/shop-banners/:id`, `POST /vendor/shop-banners/:id/end` (spec "End now"), `GET …/:id/image` previews (vendor and admin), `GET /admin/shop-banners/:id` (detail + history), `POST /admin/shop-banners/:id/image|submit|withdraw` (staff banners need a photo and a send step too), `POST /admin/shop-banners/:id/position`.
3. `image` in `/shop/home` banners carries an extra `focal { x, y }` (spec: focal point from upload). Additive.
4. `ctaLabel` is optional on input and defaults by target (spec DD-P2-1); the feed always returns one.
5. Extra error codes: `422 contact_in_text` (spec rule "no links or phone numbers"), `422 review_checks_required` (the spec's approve checklist, enforced on the server), `422 image_people_unconfirmed` is also returned on **submit** when the photo lacks confirmations. Reject of one's own submission is refused with the same `403 cannot_approve_own_submission`.
6. Error code names differ from spec §13 suggestions: `price_claim_in_text` (spec `banner_text_has_price`), `missing_translation` (spec `translation_required`), `contact_in_text` (spec `banner_text_has_contact`), `file_too_large` / `unsupported_file_type` (spec `image_too_large` / `image_type`, reusing the app-photo pipeline's codes), `text_too_long` (spec `too_long`). Not implemented by owner decision: the 30-day maximum and `banner_capacity_full` (5 per audience).
7. Audience roles are `member`, `trainer`, `owner` only; `vendor_personal` shopping mode receives no banners.
8. `start_too_soon` (≥ 1 h ahead when sending) is kept from spec §5.2.3; the owner did not overrule it.
9. `merch` in `/vendor/tools/options` is always present (`banners: false` when off) rather than only when on; it also appears in `/vendor/me` `tools` (same object).

## Known gaps

- Approved banner photos become **permanent public files on Zebra** (Zebra cannot delete); ending or rejecting later does not remove them. Pending and rejected photos stay private.
- Swahili notification and label texts are drafts for native review.
- No portal or app UI yet (portal-builder and mobile-builder build against this file).
- `SHOP_BANNERS` is off; turning it on in production needs the owner's go-ahead.
