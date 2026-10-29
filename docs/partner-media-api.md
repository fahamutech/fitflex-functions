# Partner hero photo and logo: API (slice 1, backend)

Plan: `docs/plans/partner-hero-media-plan.md` (parent repo). Design: `docs/design/photo-hero-screens.md` §39–§45 (parent repo). Owner decisions: 2026-10-29 (D-1…D-8, O-P1…O-P5).

**Flag:** `PARTNER_MEDIA` (server env, default off). When it is off, every route below answers `404 { error: "feature_disabled" }` before sign-in is checked. Apps treat that as "feature off".

**Storage:** the cleaned bytes are stored in Postgres (`PartnerMediaFile.data`, bytea). Replace, remove and takedown delete those rows, so the files really are gone. The `PartnerMedia` metadata row stays. Migration: `db/migrations/20270122090000-partner-media.cjs`.

**Serving (O-P1):** files are served only to signed-in readers of that partner. There is no public route in v1.

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
- `404`: `subject_not_found`
- `409`: `image_taken_down_before` (O-P2: the same uploaded bytes, by sha256, were taken down for this partner before)
- `413`: `file_too_large {maxBytes|maxSide}`
- `422`: `variant_over_budget`
- `429`: `rate_limited {retryAfterSeconds, limit:'minute'|'day', max}`. O-P5 allows 10 a minute per partner (in memory, per server) and 20 partner uploads a day (counted in the DB). `Retry-After` is set.
- `500`: `image_save_failed`

### `GET /partner/media/:id/file?variant=`
- Photos: `variant` is `x2` (default, 1080 wide, ≤ 150 KB) or `x1` (540, ≤ 60 KB). Logos: `logo256` (default) or `logo128` (each ≤ 40 KB, alpha kept).
- Headers: `Content-Type: image/webp`, `Cache-Control: private, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, `ETag`.
- Errors: `400 invalid_variant`. `404 media_not_found` when the item is not live or belongs to another partner.

### `GET /partner/media/:id/preview?w=240|480|960`
A WebP made from the cleaned master, with `Cache-Control: no-store, private`. Live items only.

### `DELETE /partner/media/:id`
The item becomes `removed`. Its bytes are deleted and its sha256 is cleared. Returns `200 { item }`. A non-live item → `409 not_editable {currentStatus}`.

## Admin endpoints (`requireAuth('admin')`; super-admins pass)

| Method and path | Scope | Body / query | Answer |
|---|---|---|---|
| `GET /admin/partner-media` | `moderation`, `moderation_decide` or `brand_media` | `tab=to_review` (default; live partner uploads, oldest first) `\|live` (newest first) `\|taken_down` (newest takedown first); `subjectType` (or `type`); `kind`; `q` (partner name); `subjectId`; `limit` ≤ 100; `cursor` | `{ items[], total, next }` |
| `GET /admin/partner-media/:id/preview?w=` | same | | WebP, `no-store`; non-live → `404 image_not_found` |
| `POST /admin/partner-media/:id/reviewed` | `moderation_decide` | `{ revision }` | `{ item }`. Errors: `400 revision_required`, `403 own_upload`, `404 media_gone`, `409 stale_revision {revision}`, `409 not_editable` |
| `POST /admin/partner-media/:id/take-down` | `moderation_decide` | `{ revision, reason, note? }` | `{ item }`. Bytes are deleted; reason, note, who, when and sha256 are kept; the partner is notified. Errors: `400 reason_required`, `invalid_reason {allowed\|allowedFor}`, `note_required`, `note_too_long`, `revision_required`; `404 media_gone`; `409 stale_revision`, `not_editable` |
| `GET /admin/partner-media/confirmation` | `brand_media` | | `{ adminConfirmation{version,status,rights{en,sw},partnerLogo{en,sw}}, limits }` |
| `POST /admin/partner-media` (multipart) | `brand_media` | `subjectType, subjectId, kind, file, rightsConfirmed, partnerLogoConfirmed (logo), adminConfirmationVersion, focalX?, focalY?, plate?` | `201 { item }` with `origin: fitflex` and `review: reviewed`. It never enters To review. No notification (O-P3). |
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

## Audit
Every write adds an `AuditLog` row. Actions: `partner_media.uploaded | set_by_fitflex | replaced | removed | reviewed | taken_down | updated`. The `before` and `after` snapshots hold ids, status, revision, review state, reason, sha256, focal and plate only. They never hold bytes or the note text.
