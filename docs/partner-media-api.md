# Partner hero photo and logo: API (slice 1, backend)

Plan: `docs/plans/partner-hero-media-plan.md` (parent repo). Design: `docs/design/photo-hero-screens.md` §39–§45 (parent repo). Owner decisions: 2026-10-29 (D-1…D-8, O-P1…O-P5).

**Flag:** `PARTNER_MEDIA` (server env, default off). When it is off, every route below answers `404 { error: "feature_disabled" }` before sign-in is checked. Apps treat that as "feature off".

**Storage:** the cleaned bytes are stored in Postgres (`PartnerMediaFile.data`, bytea). Replace, remove and takedown delete those rows, so the files really are gone. The `PartnerMedia` metadata row stays. Migration: `db/migrations/20270125090000-partner-media.cjs`.

**Serving (O-P1):** files are served only to signed-in readers of that partner. There is no public route in v1.

**Security review of functions#277 (fixed on the same PR):** M1 file revalidation; M2 purge when a partner goes, plus a nightly sweep; M3 per-person limits before the body is read, attempts counted in the database, an image-job gate, stored previews; L1 pixel hash, checked across an owner's gyms; L2 reinstatement rules; L3 brand_media list limits; L4 display names only on the partner side; L5 hashes only on taken-down audit rows; L6 OrgMembership audience; L7 magic bytes; L8 daily counts under a lock. Each is described below.

## MediaItem

```
{
  id, kind: 'hero'|'logo',
  subject: { type: 'gym'|'trainer'|'vendor', id, name },
  status: 'live'|'replaced'|'removed'|'taken_down',
  origin: 'partner'|'fitflex',
  review: { state: 'to_review'|'reviewed', at, (admin) by, byName },
  takedown: { reason, note, at, (admin) by, byName } | null,
  width, height,
  // hero only
  focal: { x, y },            // -1..1
  bright: boolean,
  // logo only
  plate: 'light'|'dark', plateChoice: 'auto'|'light'|'dark',
  files: { x2, x1 } | { logo256, logo128 },   // live only; partner view: "/partner/media/:id/file?variant=…"; admin view: null
  bytes: { same keys: byte length },
  uploadedBy, uploadedByName, uploadedByRole,
  confirmationVersion, rightsConfirmedBy, rightsConfirmedAt, rightsConfirmedByName,
  (logo) ownLogoConfirmedBy, ownLogoConfirmedAt, ownLogoConfirmedByName,
  revision, createdAt, updatedAt,
  // admin view only
  ownUpload, previewUrl ("/admin/partner-media/:id/preview" or null), statusChangedAt
}
```

The partner view never names FitFlex staff. On `origin: fitflex` items, `uploadedBy`, `uploadedByName`, `rightsConfirmedBy` and `rightsConfirmedByName` are null. `review.by` and `takedown.by` are admin-only. No `people` field exists anywhere.

## Partner endpoints

Roles: `gym_operator`, `gym_staff`, `trainer`, `vendor`, `vendor_staff`. Members get `403 forbidden`. Access is decided in the service from the stored accounts:

| Partner | Read | Write (`canEdit`) |
|---|---|---|
| gym (`gymId` required) | owner with the gym in their `gymIds`; any gym staff with the gym in their `gymIds` | owner; staff whose stored `aclPermissions` include `gyms` |
| gym under `V2_ORG_AUTHZ` enforce | ACTIVE owner/staff `OrgMembership` at that gym | owner membership; staff membership with `gyms` |
| trainer | the `TrainerProfile` whose `userId` = caller | same |
| vendor | the vendor; active vendor staff of that vendor | the vendor; staff with `vendorRole = admin` |

An item that belongs to another partner always answers `404 media_not_found`, never 403.

### `GET /partner/media?gymId=`
Returns `200`:
```
{ subject{type,id,name}, canEdit,
  hero: { live: MediaItem|null, lastTakedown: MediaItem|null },
  logo: { live, lastTakedown },
  confirmation: { version, status:'draft_pending_counsel', rights{en,sw}, ownLogo{en,sw} },
  limits: { hero{minWidth:1080,maxBytes:15728640,types[]}, logo{minSide:256,maxBytes:2097152,types[]} } }
```
- `lastTakedown` is set only when there is no live item and nothing was uploaded after the takedown.
- The response carries a weak `ETag` and `Cache-Control: private, no-cache`. `If-None-Match` → `304`.
- Errors: `400 gym_id_required`, `403 not_your_gym | acl_forbidden`, `404 subject_not_found`.

### Upload limits (O-P5, review M3/L8)
- **Before the request body is read** (route guard): per person, 10 attempts a minute (in memory, per server) and 40 a day across every gym they run (counted in `PartnerMediaUploadAttempt`, under a lock per person). The attempt is recorded at this point, so refused and failed uploads count toward these.
- **Then, per partner:**
  - 10 attempts a minute (in memory);
  - 60 attempts a day, whatever their outcome (`scope: 'partner_attempts'`);
  - **20 successful uploads a day** (O-P5, `scope: 'partner'`). Refused or failed attempts never use these 20, so a teammate's failures can't lock the owner out (re-review R5).
  - Counted under the partner's lock; the successful count is checked again inside the save transaction.
- **Over a limit:** `429 rate_limited { retryAfterSeconds, limit: 'minute'|'day', scope: 'person'|'partner'|'partner_attempts', max }`, with `Retry-After`.
- **Image jobs:** at most 2 partner images are decoded at once per server process, with up to 20 waiting. Beyond that: `503 image_service_busy { retryAfterSeconds }`. sharp's own settings are not changed, so hero photos, shop banners and KYC files are unaffected.
- **Magic bytes (L7):** a file whose first bytes are not JPEG, PNG, WebP or HEIF/AVIF (logos: JPEG, PNG, WebP only) is refused with `400 unsupported_file_type { reason: 'not_an_accepted_image' }` before any decoder sees it. SVG still gets `svg_not_allowed`.

### `POST /partner/media/hero` (multipart)
Fields:
- `file`: JPEG, PNG, WebP or HEIC/HEIF; ≤ 15 MB; ≥ 1080 px wide once upright
- `rightsConfirmed=true`
- `confirmationVersion`
- `focalX?`, `focalY?`: -1..1, default 0
- `gymId`: gym roles; may also be sent as `?gymId=`

Returns `201 { item }` with `status: live` and `review.state: to_review`. In the same transaction, the previous live photo becomes `replaced` and its bytes are deleted.

### `POST /partner/media/logo` (multipart)
Fields:
- `file`: PNG, JPEG or WebP, never SVG; ≤ 2 MB; ≤ 4000 × 4000; ≥ 256 px on the short side
- `rightsConfirmed=true`, `ownLogoConfirmed=true`, `confirmationVersion`
- `plate?`: `auto` (default) | `light` | `dark`
- `gymId`

With `auto`, the plate is dark when the alpha-weighted luminance of the logo is above 0.6. Same replace rule as the photo.

**Upload errors:**
- `400`: `gym_id_required`, `confirmation_version_mismatch {current}`, `rights_confirmation_required`, `own_logo_confirmation_required`, `invalid_focal`, `invalid_plate`, `no_file_provided`, `unsupported_file_type`, `svg_not_allowed`, `image_too_small {minWidth|minSide, width, height}`, `unknown_field` (any `people` / `peopleConfirmed` field), `invalid_multipart`
- `403`: `not_your_gym`, `acl_forbidden {requiredScope: gyms|own_profile|vendor_admin}`
- `404`: `subject_not_found` (also when the partner was deleted while the file was being cleaned)
- `409`: `image_taken_down_before`. The same file was taken down before (O-P2, review L1). "Same" means the same uploaded bytes (sha256) or the same decoded cleaned pixels (`pixelSha256`, which catches metadata-only edits). For gyms, takedowns at any gym of the same owner count.
- `413`: `file_too_large {maxBytes|maxSide}`
- `422`: `variant_over_budget`
- `429`: `rate_limited` (see Upload limits)
- `500`: `image_save_failed`
- `503`: `image_service_busy`, `rate_limit_unavailable`

### `GET /partner/media/:id/file?variant=`
- Photos: `variant` is `x2` (default, 1080 wide, ≤ 150 KB) or `x1` (540, ≤ 60 KB). Logos: `logo256` (default) or `logo128` (each ≤ 40 KB, alpha kept).
- Headers: `Content-Type: image/webp`, `Cache-Control: private, no-cache`, `ETag: "<file id>"`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`.
- **Revalidate on every use (review M1):** send `If-None-Match`. A matching tag gets `304` without the bytes; a removed, replaced or taken-down item gets `404`, so the app drops its saved copy at the next use. (This replaces the earlier `max-age=31536000, immutable`.)
- Errors: `400 invalid_variant`. `404 media_not_found` when the item is not live or belongs to another partner.

### `GET /partner/media/:id/preview?w=240|480|960`
A WebP preview, with `Cache-Control: no-store, private`. Live items only.
- The previews are made once at upload and stored (`p240`, `p480`, `p960`). The route only reads them.
- `w` defaults to 960. The master is never served (this changed from "no `w` → the master").
- Limited to 120 requests a minute per person (`429 rate_limited`).

### `DELETE /partner/media/:id`
The item becomes `removed`. Its bytes are deleted and its sha256 is cleared. Returns `200 { item }`. A non-live item → `409 not_editable {currentStatus}`.

## Admin endpoints (`requireAuth('admin')`; super-admins pass)

| Method and path | Scope | Body / query | Answer |
|---|---|---|---|
| `GET /admin/partner-media` | `moderation` or `moderation_decide`. `brand_media` alone: only `tab=live` with `subjectId`, else `403 acl_forbidden { requiredScope: 'moderation' }` (review L3) | `tab=to_review` (default; live partner uploads, oldest first) `\|live` (newest first) `\|taken_down` (newest takedown first); `subjectType` (or `type`); `kind`; `q` (partner name); `subjectId`; `limit` ≤ 100; `cursor` | `{ items[], total, next }`. Items of a partner that no longer exists are never listed. |
| `GET /admin/partner-media/:id/preview?w=` | `moderation`, `moderation_decide` or `brand_media` | | Stored WebP, `no-store`, 300 a minute per admin. Non-live → `404 image_not_found`; partner gone → `404 media_not_found` |
| `POST /admin/partner-media/:id/reviewed` | `moderation_decide` | `{ revision }` | `{ item }`. Errors: `400 revision_required`, `403 own_upload`, `404 media_gone`, `409 stale_revision {revision}`, `409 not_editable` |
| `POST /admin/partner-media/:id/take-down` | `moderation_decide` | `{ revision, reason, note? }` | `{ item }`. Bytes are deleted; reason, note, who, when and sha256 are kept; the partner is notified. Errors: `400 reason_required`, `invalid_reason {allowed\|allowedFor}`, `note_required`, `note_too_long`, `revision_required`; `404 media_gone`; `409 stale_revision`, `not_editable` |
| `GET /admin/partner-media/confirmation` | `brand_media` | | `{ adminConfirmation{version,status,rights{en,sw},partnerLogo{en,sw}}, limits }` |
| `POST /admin/partner-media` (multipart) | `brand_media` | `subjectType, subjectId, kind, file, rightsConfirmed, partnerLogoConfirmed (logo), adminConfirmationVersion, focalX?, focalY?, plate?` | `201 { item }` with `origin: fitflex` and `review: reviewed`. It never enters To review. No notification (O-P3). **Reinstating (review L2):** a file matching a taken-down item of this partner (or a gym of the same owner) needs `moderation_decide` or super-admin, else `403 reinstate_requires_moderation_decide { reinstates }`. When that takedown was `person_request`, it also needs `overrideReason` (≤ 500), else `409 override_reason_required { reinstates }`. Audited as `reinstates: <id>`, `reinstatesReason`, `overrideReason`. |
| `PATCH /admin/partner-media/:id` | `brand_media` | `{ focal?:{x,y} (photo), plate? (logo), revision? }` | `{ item }`. Errors: `nothing_to_change`, `field_not_applicable`, `invalid_focal`, `invalid_plate`, `unknown_field`, `stale_revision` |

Reason codes:
- `inappropriate`, `rights`, `quality`, `other`: photo and logo. `other` needs a note of at most 500 characters.
- `other_brand`, `person_request`: photo only.
- `not_own_logo`: logo only.

## Notification `partner_media.taken_down`
- **Who gets it:**
  - gym: owners and gym staff with `gyms` at that gym;
  - trainer: the trainer;
  - vendor: the vendor and active admin staff.
- **Language:** English for people whose communication preference `locale` is `en`, Swahili otherwise (the existing partner-notice convention).
- **Title and body:** the §44.3 text. The note is never included.
- **`data`:** `{ mediaId, kind, subjectType, subjectId, gymId (gyms), reason, route, open:'brand_media', titleEn, bodyEn, titleSw, bodySw }`.
- **`route`:** `/owner/brand-media?gymId=…`, `/trainer/brand-media` or `/vendor/brand-media`.

## Purge when a partner goes (review M2)
- **When it runs:**
  - a gym is deleted (`gymService.remove`, `ownerGymService.deleteGym`);
  - a trainer profile is deleted (`trainerService.adminRemove`);
  - an account is deleted (`accountService.deleteMyAccount`: vendor, trainer, gym owner);
  - an owner is removed by an admin (`adminOwnerService.remove`);
  - registration withdraws a just-made profile (`registrationService`).
- **For a gym owner:** only the gyms that no open owner account still runs are purged.
- **What it does** (`partnerMediaService.purgeSubject`), in one transaction under both slot locks:
  - deletes every file row;
  - marks live items `removed`;
  - clears `sha256`, `pixelSha256` and the takedown note on every row;
  - sets `purgedAt`.
- **After a purge:** purged rows are never read again, so a re-created id shows no old photo, logo or takedown. Audit row: `partner_media.purged { cause }`.
- **Nightly sweep:** job `partnerMediaSweep` (`40 0 * * *` UTC) purges the media of:
  - partners that vanished another way (gym or trainer profile row gone, vendor gone or closed);
  - trainer profiles whose account is closed (a profile with no account at all is kept);
  - gyms that no open owner runs: no open `gym_operator` listing the gym, and no ACTIVE V2 owner `OrgMembership` whose persona is open (re-review R2). This includes FitFlex-set media on a gym an admin created but no owner has claimed yet.

  It also deletes upload attempts older than two days. It runs whatever the flag says, because it only ever deletes partner-media data.
- **V2-only owners:** `purgeAccount` also finds gyms owned through owner memberships, including memberships whose persona row was just deleted (matched by Person).
- **Race with an upload (re-review R1):** the save transaction holds the same locks as a purge and re-checks that the partner still exists, so an upload that finishes after its partner was deleted gets `404 subject_not_found` and nothing is saved.
- **Meanwhile:** the admin list hides these items and the admin preview answers 404.

## Audit
Every write adds an `AuditLog` row. Actions: `partner_media.uploaded | set_by_fitflex | replaced | removed | reviewed | taken_down | updated`. The `before` and `after` snapshots hold ids, status, revision, review state, reason, focal and plate only. They never hold bytes or the note text. The upload hashes (`sha256`, `pixelSha256`) appear only in snapshots of `taken_down` items (review L5), and never in `partner_media.purged` rows (re-review R3).

## Names on the partner side (review L4)
`uploadedByName`, `rightsConfirmedByName` and `ownLogoConfirmedByName` are the person's display name only, never an email. They are `null` when there is no display name; show `uploadedByRole` instead. The admin view still falls back to the email.

## Takedown notice audience under V2 (review L6)
With `V2_ORG_AUTHZ` enforcing, a gym's takedown notice goes to the people who have access by the same rule as the API: owners and staff with `gyms` through ACTIVE `OrgMembership` rows at that gym.
