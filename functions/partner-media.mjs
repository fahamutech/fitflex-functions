// Partner hero photo and logo — REST surface (plan docs/plans/partner-hero-media-plan.md slice 1;
// design spec photo-hero-screens.md §44.4; owner decisions 2026-10-29).
//
// Dormant unless PARTNER_MEDIA is set: every route here answers 404 feature_disabled before
// sign-in is checked. Files are served to signed-in readers of that partner only (O-P1); there is
// no public file route in v1.
//
//   Partners (read): gym owners and ANY staff of that gym, trainers (own profile), vendors and ANY
//   active staff of that vendor. Write: owners (own gyms), gym staff holding `gyms` at that gym,
//   trainers (own profile), the vendor, vendor staff with vendorRole admin. Decided in the
//   service from the stored accounts (src/services/partner-media-service.mjs).
//   Admins: `moderation` (or moderation_decide / brand_media) views; `moderation_decide` marks
//   reviewed and takes down; `brand_media` sets a photo or logo for a partner. Super-admins pass.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { partnerMediaService as svc } from '../src/bootstrap/services.mjs';
import { parseMultipartRequest } from '../src/infra/storage-client.mjs';
import { partnerMediaOn } from '../src/shared/feature-flags.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { PARTNER_MEDIA_LIMITS, PARTNER_ROLES, PREVIEW_RATE } from '../src/shared/partner-media-rules.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';
import { createHash } from 'node:crypto';

const created = new Date().toISOString();

/** First guard on every route: with the flag off the routes do not exist. */
const mediaEnabled = (_req, res, next) => (partnerMediaOn() ? next() : res.status(404).json({ error: 'feature_disabled' }));

/**
 * Security review M3: the per-person upload limits are checked here, before the multipart body is
 * read; the attempt is recorded whatever happens next (refused and failed uploads count too).
 */
async function admitUpload(req, res, next) {
  let admitted;
  try {
    admitted = await svc.admitUpload(req.user);
  } catch (err) {
    console.error('[partner-media] upload admission failed:', err?.message);
    return res.status(503).json({ error: 'rate_limit_unavailable' });
  }
  if (admitted.error) return send(res, admitted);
  req.partnerMediaAttemptId = admitted.attemptId;
  return next();
}

// Previews are made at upload; reading them is still limited per person (review M3).
const previewLimiters = {
  partner: createVendorLimiter({ perMinute: PREVIEW_RATE.partnerPerMinute }),
  admin: createVendorLimiter({ perMinute: PREVIEW_RATE.adminPerMinute }),
};
export const resetPartnerMediaPreviewLimits = () => Object.values(previewLimiters).forEach(l => l.reset());

const partnerGuard = method => routeGuard(method, [mediaEnabled, requireAuth(...PARTNER_ROLES)]);
const partnerUploadGuard = () => routeGuard('post', [mediaEnabled, requireAuth(...PARTNER_ROLES), admitUpload]);
const adminView = method => routeGuard(method, [mediaEnabled, requireAuth('admin'), requireAcl('moderation', 'moderation_decide', 'brand_media')]);
const adminDecide = method => routeGuard(method, [mediaEnabled, requireAuth('admin'), requireAcl('moderation_decide')]);
const adminBrand = method => routeGuard(method, [mediaEnabled, requireAuth('admin'), requireAcl('brand_media')]);

function send(res, result, okStatus = 200) {
  const { error, status, ...payload } = result;
  if (error) {
    // 429 rate_limited and 503 image_service_busy carry retryAfterSeconds in the body and as Retry-After.
    if ((status === 429 || status === 503) && payload.retryAfterSeconds) res.setHeader?.('Retry-After', String(payload.retryAfterSeconds));
    return res.status(status || 400).json({ error, ...payload });
  }
  return res.status(okStatus).json(payload);
}
const safely = (label, fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (err) {
    console.error(`[partner-media] ${label} failed:`, err?.message);
    if (!res.headersSent) res.status(500).json({ error: label.includes('upload') || label.includes('set') ? 'image_save_failed' : 'partner_media_failed' });
  }
};

async function readUpload(req, kind) {
  // One byte over the limit marks the file truncated (→ 413). The larger limit when the kind is in a field.
  const maxBytes = kind ? PARTNER_MEDIA_LIMITS[kind].maxBytes : PARTNER_MEDIA_LIMITS.hero.maxBytes;
  const parsed = await parseMultipartRequest(req, { fileSize: maxBytes, files: 1, fields: 16, parts: 17, fieldSize: 1024 });
  const fields = {};
  for (const { name, value } of parsed.fields) if (!(name in fields)) fields[name] = value;
  return { fields, file: parsed.files.find(f => f.fieldname === 'file') || parsed.files[0] || null };
}

function streamImage(res, result, cache) {
  if (result.error) return send(res, result);
  if (result.notModified) {
    res.setHeader('ETag', result.etag);
    res.setHeader('Cache-Control', cache);
    return res.status(304).end();
  }
  const { buffer, mimeType, id } = result.file;
  res.status(200);
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', cache);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (id) res.setHeader('ETag', `"${id}"`);
  return res.end(buffer);
}

const ITEM = 'MediaItem { id, kind: hero|logo, subject { type: gym|trainer|vendor, id, name }, status: live|replaced|removed|taken_down, origin: partner|fitflex, review { state: to_review|reviewed, at } (admin also by, byName), takedown { reason, note, at } | null (admin also by, byName), width, height, hero: focal { x, y } (-1..1), bright; logo: plate light|dark, plateChoice auto|light|dark; files { x2, x1 | logo256, logo128 } (live only; root-relative GET /partner/media/:id/file?variant= paths; admin view: null + previewUrl), bytes { same keys }, uploadedBy, uploadedByName, uploadedByRole, confirmationVersion, rightsConfirmedBy, rightsConfirmedAt, rightsConfirmedByName, (logo) ownLogoConfirmedBy, ownLogoConfirmedAt, ownLogoConfirmedByName, revision, createdAt, updatedAt }. On the partner side, people are never named for items FitFlex set, nor for review or takedown.';
const UPLOAD_ERRORS = 'Errors: 400 gym_id_required | confirmation_version_mismatch { current } | rights_confirmation_required | invalid_focal | no_file_provided | unsupported_file_type | svg_not_allowed | image_too_small { minWidth | minSide, width, height } | unknown_field (people fields are not accepted) | invalid_multipart; 403 not_your_gym | acl_forbidden { requiredScope: gyms | own_profile | vendor_admin }; 404 subject_not_found; 409 image_taken_down_before (the same file was taken down for this partner before); 413 file_too_large { maxBytes } | { maxPixels } (photo, width × height) | { maxSide } (logo); 422 variant_over_budget; 429 rate_limited { retryAfterSeconds, limit: minute|day, scope: person|partner|partner_attempts, max } (before the body is read: 10 attempts a minute and 40 a day per person; then per partner 10 attempts a minute, 60 attempts a day, and 20 SUCCESSFUL uploads a day — refused attempts never use the 20); 404 subject_not_found also when the partner was deleted while the file was cleaned; 500 image_save_failed; 503 image_service_busy { retryAfterSeconds } (+ Retry-After) | rate_limit_unavailable. A file whose first bytes are not JPEG, PNG, WebP or HEIF/AVIF (logos: JPEG, PNG, WebP) → 400 unsupported_file_type before it is decoded.';

// ── Partner ──────────────────────────────────────────────────────────────────

export const partnerMediaOverview = {
  created, method: 'get', path: '/partner/media',
  description: `Partner (PARTNER_MEDIA): my home photo and logo. Gym roles pass ?gymId= (required). Readable by the owner and every staff member of that gym, the trainer, the vendor and every active vendor staff member. → { subject { type, id, name }, canEdit, hero { live: MediaItem | null, lastTakedown: MediaItem | null }, logo { same }, confirmation { version, status: draft_pending_counsel, rights { en, sw }, ownLogo { en, sw } }, limits { hero { minWidth, maxBytes, maxPixels, types[] }, logo { minSide, maxSide, maxBytes, types[] } } }. lastTakedown is set only when there is no live item and nothing was uploaded after the takedown. ETag; If-None-Match → 304. ${ITEM} Errors: 400 gym_id_required; 403 not_your_gym | acl_forbidden; 404 subject_not_found.`,
  onGuard: partnerGuard('get'),
  onRequest: safely('overview', async (req, res) => {
    const result = await svc.overview({ claims: req.user, gymId: req.query?.gymId ?? null });
    if (result.error) return send(res, result);
    const body = JSON.stringify(result);
    const etag = `W/"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    if (req.headers?.['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).end(body);
  }),
};

function uploadRoute(kind) {
  const fieldsText = kind === 'hero'
    ? 'file (JPEG, PNG, WebP or HEIC/HEIF; ≤ 15 MB, ≤ 50 MP, ≥ 1080 px wide once upright), rightsConfirmed=true, confirmationVersion (= confirmation.version from GET /partner/media), focalX?, focalY? (-1..1, default 0), gymId (gym roles; or ?gymId=)'
    : 'file (PNG, JPEG or WebP; never SVG; ≤ 2 MB, ≤ 4000 × 4000, ≥ 256 px on the short side once upright; transparency kept), rightsConfirmed=true, ownLogoConfirmed=true, confirmationVersion, plate? = auto (default) | light | dark, gymId (gym roles; or ?gymId=)';
  return {
    created, method: 'post', path: `/partner/media/${kind}`,
    description: `Partner with edit rights (PARTNER_MEDIA): upload my home ${kind === 'hero' ? 'photo' : 'logo'}. multipart/form-data: ${fieldsText}. Cleaned on the server (rotated upright, EXIF/GPS/XMP removed, sRGB, WebP) and live at once (review.state to_review). In the same transaction the previous live ${kind} becomes replaced and its bytes are deleted. → 201 { item: MediaItem }. ${UPLOAD_ERRORS}`,
    onGuard: partnerUploadGuard(),
    onRequest: safely(`upload ${kind}`, async (req, res) => {
      let parts;
      try {
        parts = await readUpload(req, kind);
      } catch {
        return res.status(400).json({ error: 'invalid_multipart' });
      }
      return send(res, await svc.upload({
        claims: req.user, kind, file: parts.file, fields: parts.fields, gymId: parts.fields.gymId ?? req.query?.gymId ?? null, attemptId: req.partnerMediaAttemptId ?? null,
      }), 201);
    }),
  };
}
export const partnerMediaUploadHero = uploadRoute('hero');
export const partnerMediaUploadLogo = uploadRoute('logo');

export const partnerMediaFile = {
  created, method: 'get', path: '/partner/media/:id/file',
  description: 'Partner reader (PARTNER_MEDIA): the bytes of a live photo or logo of MY partner (O-P1: signed-in readers of that partner only). ?variant = x2 | x1 (photo; default x2) or logo256 | logo128 (logo; default logo256). WebP; Cache-Control: private, no-cache (revalidate every use, so a removed file stops showing); ETag = "<file id>" and If-None-Match → 304 without the bytes; X-Content-Type-Options: nosniff; Content-Disposition: inline. 400 invalid_variant; 404 media_not_found (another partner\'s item, or replaced, removed or taken down: the bytes are gone).',
  onGuard: partnerGuard('get'),
  onRequest: safely('file', async (req, res) => streamImage(res, await svc.file({
    claims: req.user, id: req.params.id, variant: req.query?.variant, ifNoneMatch: req.headers?.['if-none-match'] ?? null,
  }), 'private, no-cache')),
};

export const partnerMediaPreview = {
  created, method: 'get', path: '/partner/media/:id/preview',
  description: `Partner reader (PARTNER_MEDIA): a thumbnail of a live item of MY partner, made once at upload. ?w = 240 | 480 | 960 (default 960). WebP; Cache-Control: no-store, private. ${PREVIEW_RATE.partnerPerMinute} a minute per person (429 rate_limited). 400 invalid_width; 404 media_not_found | image_not_found.`,
  onGuard: partnerGuard('get'),
  onRequest: safely('preview', async (req, res) => limitOrNull(previewLimiters.partner, req.user.sub, res)
    || streamImage(res, await svc.preview({ claims: req.user, id: req.params.id, width: req.query?.w }), 'no-store, private')),
};

export const partnerMediaRemove = {
  created, method: 'delete', path: '/partner/media/:id',
  description: 'Partner with edit rights (PARTNER_MEDIA): remove my live photo or logo. Status removed; the bytes are deleted at once (the file route answers 404); the metadata row stays for audit. → { item: MediaItem }. 403 acl_forbidden; 404 media_not_found; 409 not_editable { currentStatus } (not live).',
  onGuard: partnerGuard('delete'),
  onRequest: safely('remove', async (req, res) => send(res, await svc.remove({ claims: req.user, id: req.params.id }))),
};

// ── Admin ────────────────────────────────────────────────────────────────────

const actorOf = req => req.user.sub;
const holds = (req, scope) => !req.user?.portalUser || (Array.isArray(req.user.aclPermissions) && req.user.aclPermissions.includes(scope));
const canModerate = req => holds(req, 'moderation') || holds(req, 'moderation_decide');
const canDecide = req => holds(req, 'moderation_decide');

export const adminPartnerMediaList = {
  created, method: 'get', path: '/admin/partner-media',
  description: `Admin (moderation or moderation_decide; PARTNER_MEDIA; brand_media alone: only ?tab=live with ?subjectId, else 403 acl_forbidden — the Set-photo dialog): the Partner photos queue. Items of a partner that no longer exists are never listed. ?tab = to_review (default: live partner uploads not yet reviewed, oldest first; FitFlex-set items never) | live (newest first) | taken_down (newest takedown first); ?subjectType (or ?type) = gym | trainer | vendor; ?kind = hero | logo; ?q (partner name); ?subjectId; ?limit (≤ 100, default 25); ?cursor. → { items: [MediaItem (admin view: + ownUpload, previewUrl, statusChangedAt)], total, next (cursor | null) }. 400 invalid_tab | invalid_subject_type | invalid_kind.`,
  onGuard: adminView('get'),
  onRequest: safely('admin list', async (req, res) => send(res, await svc.adminList({ query: req.query || {}, actorId: actorOf(req), viewer: { canModerate: canModerate(req) } }))),
};

export const adminPartnerMediaConfirmation = {
  created, method: 'get', path: '/admin/partner-media/confirmation',
  description: 'Admin (brand_media; PARTNER_MEDIA): the texts an admin confirms when setting a partner\'s photo or logo. → { adminConfirmation { version, status: draft_pending_counsel, rights { en, sw }, partnerLogo { en, sw } }, limits { hero, logo } }.',
  onGuard: adminBrand('get'),
  onRequest: safely('admin confirmation', async (_req, res) => send(res, svc.adminConfirmation())),
};

export const adminPartnerMediaPreview = {
  created, method: 'get', path: '/admin/partner-media/:id/preview',
  description: `Admin (moderation, moderation_decide or brand_media; PARTNER_MEDIA): a preview of a live item, made at upload (WebP; no-store). ?w = 240 | 480 | 960 (default 960). ${PREVIEW_RATE.adminPerMinute} a minute per admin (429 rate_limited). 400 invalid_width; 404 media_not_found (also when the partner no longer exists) | image_not_found (taken down, removed or replaced: the file is deleted).`,
  onGuard: adminView('get'),
  onRequest: safely('admin preview', async (req, res) => limitOrNull(previewLimiters.admin, req.user.sub, res)
    || streamImage(res, await svc.adminPreview({ id: req.params.id, width: req.query?.w }), 'no-store, private')),
};

export const adminPartnerMediaReviewed = {
  created, method: 'post', path: '/admin/partner-media/:id/reviewed',
  description: 'Admin (moderation_decide; PARTNER_MEDIA): "Looks fine" { revision }. The item leaves To review and stays live. → { item }. 400 revision_required | invalid_revision; 403 own_upload; 404 media_not_found | media_gone (replaced or removed by the partner); 409 stale_revision { revision } | not_editable { currentStatus }.',
  onGuard: adminDecide('post'),
  onRequest: safely('admin reviewed', async (req, res) => send(res, await svc.markReviewed({ actorId: actorOf(req), id: req.params.id, revision: req.body?.revision }))),
};

export const adminPartnerMediaTakeDown = {
  created, method: 'post', path: '/admin/partner-media/:id/take-down',
  description: 'Admin (moderation_decide; PARTNER_MEDIA): take down a live item { revision, reason: inappropriate | rights | other_brand (photo) | not_own_logo (logo) | person_request (photo) | quality | other, note? (≤ 500; required for other; the partner sees it on the page, never in the push) }. Works on FitFlex-set items too. The bytes are deleted at once; reason, note, who, when and the upload hash are kept (the same file is then refused for this partner). The partner\'s people are told (partner_media.taken_down). → { item }. 400 reason_required | invalid_reason { allowed | allowedFor } | note_required | note_too_long | revision_required; 404 media_not_found | media_gone; 409 stale_revision { revision } | not_editable.',
  onGuard: adminDecide('post'),
  onRequest: safely('admin take-down', async (req, res) => send(res, await svc.takeDown({
    actorId: actorOf(req), id: req.params.id, revision: req.body?.revision, reason: req.body?.reason, note: req.body?.note,
  }))),
};

export const adminPartnerMediaSet = {
  created, method: 'post', path: '/admin/partner-media',
  description: `Admin (brand_media; PARTNER_MEDIA): set a partner's photo or logo. multipart/form-data: subjectType (gym | trainer | vendor), subjectId, kind (hero | logo), file (same rules as the partner upload), rightsConfirmed=true, partnerLogoConfirmed=true (logo), adminConfirmationVersion (= adminConfirmation.version), focalX?, focalY? (hero), plate? (logo). Live at once with origin fitflex and review.state reviewed (never in To review); replaces the live one (bytes deleted). The partner is not notified (O-P3). A file matching a taken-down item of this partner (or a gym of the same owner) puts it back: that needs moderation_decide or super-admin (403 reinstate_requires_moderation_decide { reinstates }), and when it was taken down at a person's request, overrideReason (≤ 500; 409 override_reason_required { reinstates }); audited as reinstates: <id>. → 201 { item }. 400 invalid_subject_type | invalid_kind | confirmation_version_mismatch | rights_confirmation_required | partner_logo_confirmation_required | override_reason_too_long | file errors as the partner upload; 404 subject_not_found; 503 image_service_busy.`,
  onGuard: adminBrand('post'),
  onRequest: safely('admin set', async (req, res) => {
    let parts;
    try {
      parts = await readUpload(req, null);
    } catch {
      return res.status(400).json({ error: 'invalid_multipart' });
    }
    const { file } = parts;
    // The logo limit is smaller than the multipart limit used here.
    if (parts.fields.kind === 'logo' && file?.buffer?.length > PARTNER_MEDIA_LIMITS.logo.maxBytes) file.truncated = true;
    return send(res, await svc.adminSet({ actorId: actorOf(req), file, fields: parts.fields, viewer: { canDecide: canDecide(req) } }), 201);
  }),
};

export const adminPartnerMediaUpdate = {
  created, method: 'patch', path: '/admin/partner-media/:id',
  description: 'Admin (brand_media; PARTNER_MEDIA): change a live item { focal?: { x, y } (photo; each -1..1), plate?: auto | light | dark (logo), revision? }. → { item }. 400 unknown_field | nothing_to_change | invalid_focal | invalid_plate | field_not_applicable; 404 media_not_found | media_gone; 409 stale_revision | not_editable.',
  onGuard: adminBrand('patch'),
  onRequest: safely('admin update', async (req, res) => send(res, await svc.adminUpdate({ actorId: actorOf(req), id: req.params.id, body: req.body || {} }))),
};

// ── Nightly sweep (security review M2) ───────────────────────────────────────

export const partnerMediaSweep = {
  created, rule: '40 0 * * *', // every day 00:40 UTC = 03:40 EAT
  description: 'Partner photos and logos: purge the media of partners that no longer exist (gym or trainer profile deleted, vendor deleted or closed): bytes deleted, live items removed, hashes and notes cleared, rows marked purged. Also deletes upload attempts older than two days. Runs whatever PARTNER_MEDIA says (it only ever deletes partner-media data; with no data it does nothing). Idempotent.',
  onJob: async () => {
    const r = await svc.sweep();
    if (r.subjects || r.attemptsDeleted) console.log(`[partner-media] sweep: subjects=${r.subjects} items=${r.items} files=${r.files} attempts=${r.attemptsDeleted}`);
  },
};
