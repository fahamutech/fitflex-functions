// Shop home banners — REST surface (Phase 2 · slice 1). Contract: docs/shop-banners-api.md.
//
// Dormant unless SHOP_BANNERS is set: every route here answers 404 feature_disabled before sign-in
// is checked, so the surface is invisible (GET /shop/home then has no `banners` key).
//
//   Vendors: the vendor account, or vendor staff holding `products` (read from the stored staff
//   record). They see and change only their own banners; other ids read as banner_not_found.
//   Admins: list and detail with `promotions` or `promotions_approve`; create, edit, photo, send
//   and withdraw FitFlex banners with `promotions`; approve, reject, end and reorder with
//   `promotions_approve` (never one's own: 403 cannot_approve_own_submission). Super-admins pass.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { shopBannerService as svc, shopService } from '../src/bootstrap/services.mjs';
import { parseMultipartRequest } from '../src/infra/storage-client.mjs';
import { BANNER_IMAGE_LIMITS } from '../src/shared/shop-banner-rules.mjs';
import { shopBannersOn } from '../src/shared/feature-flags.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';

const created = new Date().toISOString();

/** First guard on every route: with the flag off the routes do not exist. */
const bannersEnabled = (_req, res, next) => (shopBannersOn() ? next() : res.status(404).json({ error: 'feature_disabled' }));

/** vendor_staff must hold `products` on their stored staff record; the vendor account passes. */
async function requireProductsPermission(req, res, next) {
  if (req.user?.userType !== 'vendor_staff') return next();
  try {
    if (await shopService.authorizeStaff(req.user, 'products')) return next();
  } catch (error) {
    console.error('[shop-banners] staff authorization lookup failed', { staffId: req.user.sub, error: error.message });
    return res.status(503).json({ error: 'authorization_unavailable' });
  }
  return res.status(403).json({ error: 'vendor_permission_forbidden', requiredPermission: 'products' });
}

const vendorGuard = method => routeGuard(method, [bannersEnabled, requireAuth('vendor', 'vendor_staff'), requireProductsPermission]);
const adminView = method => routeGuard(method, [bannersEnabled, requireAuth('admin'), requireAcl('promotions', 'promotions_approve')]);
const adminManage = method => routeGuard(method, [bannersEnabled, requireAuth('admin'), requireAcl('promotions')]);
const adminApprove = method => routeGuard(method, [bannersEnabled, requireAuth('admin'), requireAcl('promotions_approve')]);

// Per vendor, per minute, in memory per server (vendor-rate-limit.mjs): 429 rate_limited { retryAfterSeconds }.
export const BANNER_RATE_LIMITS = Object.freeze({ create: 20, upload: 10, submit: 20 });
const limiters = Object.fromEntries(Object.entries(BANNER_RATE_LIMITS).map(([k, perMinute]) => [k, createVendorLimiter({ perMinute })]));
export const resetShopBannerLimits = () => Object.values(limiters).forEach(l => l.reset());
const limited = (kind, req, res) => limitOrNull(limiters[kind], vendorIdOf(req), res);

const vendorIdOf = req => (req.user.userType === 'vendor' ? req.user.sub : req.user.vendorId);
const vendorScope = req => ({ origin: 'vendor', vendorId: vendorIdOf(req) });
const STAFF = Object.freeze({ origin: 'staff' });
const hasScope = (req, scope) => !req.user?.portalUser || (req.user.aclPermissions || []).includes(scope);
const viewerOf = req => ({ actorId: req.user.sub, canManage: hasScope(req, 'promotions'), canApprove: hasScope(req, 'promotions_approve') });

function send(res, result, okStatus = 200) {
  const { error, status, ...payload } = result;
  if (error) return res.status(status || 400).json({ error, ...payload });
  return res.status(okStatus).json(payload);
}
/** { banner } out of an act() result ({ saved } → the right view). */
async function sendBanner(res, result, read) {
  if (result.error) return send(res, result);
  return send(res, await read(result.saved.id));
}

async function readUpload(req) {
  // One byte over the limit marks the file truncated (→ 413).
  const parsed = await parseMultipartRequest(req, { fileSize: BANNER_IMAGE_LIMITS.maxBytes, files: 1, fields: 12, parts: 13, fieldSize: 1024 });
  const fields = {};
  for (const { name, value } of parsed.fields) if (!(name in fields)) fields[name] = value;
  return { fields, file: parsed.files.find(f => f.fieldname === 'file') || parsed.files[0] || null };
}
async function upload(req, res, scope, viewer = null) {
  let parts;
  try {
    parts = await readUpload(req);
  } catch {
    return res.status(400).json({ error: 'invalid_multipart' });
  }
  return send(res, await svc.uploadImage({ scope, id: req.params.id, file: parts.file, fields: parts.fields, actorId: req.user.sub, viewer }));
}
async function streamPreview(res, result) {
  if (result.error) return send(res, result);
  const { buffer, mimeType, fileName } = result.file;
  res.status(200);
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.end(buffer);
}

const BANNER_BODY = 'Body (all optional on create/PATCH; all needed to send): headlineLead {en,sw}, headlineAccent {en,sw} (lead + accent ≤ 32 EN / 42 SW), subline? {en,sw} (≤ 70 / 90; null clears), ctaKey? (view_product | visit_store | shop_now | view_all; vendors: only the key of their target, else 422 invalid_cta_key; left out → by target), ctaLabel? {en,sw} (FitFlex staff only, ≤ 24 / 30; from a vendor → 422 cta_label_not_allowed), imageAlt {en,sw}, target {type, value}, audienceRoles [member|trainer|owner] (default all three), startsAt, endsAt (ISO). Text in either language with a price, percentage or amount → 422 price_claim_in_text { field }; a link or phone number → 422 contact_in_text { field }; one language missing → 422 missing_translation { field, missing }.';

// ── Vendor ───────────────────────────────────────────────────────────────────

const vendorRead = req => id => svc.vendorGet({ vendorId: vendorIdOf(req), id });

export const vendorListShopBanners = {
  created, method: 'get', path: '/vendor/shop-banners',
  description: 'Vendor / staff with `products` (SHOP_BANNERS): my banners, newest first. ?status= (draft|pending_approval|approved|live|ended|rejected|withdrawn|expired, the effective status), ?limit (≤100, default 25), ?cursor. → { items: [banner], total, nextCursor, vendor: { canPropose, reason: null|vendor_suspended|vendor_not_approved }, proposalExpiryDays }.',
  onGuard: vendorGuard('get'),
  onRequest: async (req, res) => send(res, await svc.vendorList({ vendorId: vendorIdOf(req), query: req.query || {} })),
};

export const vendorCreateShopBanner = {
  created, method: 'post', path: '/vendor/shop-banners',
  description: `Vendor / staff with \`products\` (SHOP_BANNERS): start a banner (a draft only the vendor sees). ${BANNER_BODY} target.type: product (value = one of my products) | vendor_store (value = my vendor id, or left out). Another vendor's product or store → 403 target_not_owned; category/results → 403 target_type_not_allowed. Vendor suspended → 403 vendor_suspended; not approved / not operational → 403 vendor_not_approved. More than SHOP_BANNER_MAX_OPEN (10) drafts + pending → 409 too_many_open_proposals { max, open }. 20 a minute per vendor (429 rate_limited). → 201 { banner }.`,
  onGuard: vendorGuard('post'),
  onRequest: async (req, res) => limited('create', req, res) || send(res, await svc.create({ scope: vendorScope(req), actorId: req.user.sub, body: req.body || {} }), 201),
};

export const vendorGetShopBanner = {
  created, method: 'get', path: '/vendor/shop-banners/:id',
  description: 'Vendor / staff with `products` (SHOP_BANNERS): one of my banners. → { banner }. Not mine → 404 banner_not_found.',
  onGuard: vendorGuard('get'),
  onRequest: async (req, res) => send(res, await vendorRead(req)(req.params.id)),
};

export const vendorUpdateShopBanner = {
  created, method: 'patch', path: '/vendor/shop-banners/:id',
  description: `Vendor / staff with \`products\` (SHOP_BANNERS): change a banner. ${BANNER_BODY} Draft stays draft; pending stays pending (expiry kept; re-dated if startsAt moves); rejected → draft (send it again); approved or live → pending_approval (off the shop until approved again; startsAt must then be ≥ 1 hour ahead). ended | expired | withdrawn → 409 not_editable. → { banner }.`,
  onGuard: vendorGuard('patch'),
  onRequest: async (req, res) => send(res, await svc.update({ scope: vendorScope(req), id: req.params.id, actorId: req.user.sub, body: req.body || {} })),
};

export const vendorUploadShopBannerImage = {
  created, method: 'post', path: '/vendor/shop-banners/:id/image',
  description: 'Vendor / staff with `products` (SHOP_BANNERS): the banner photo. multipart/form-data: file (JPEG, PNG or WebP; ≤ 5 MB; ≥ 1600 × 1000 upright), people = none | product_models, confirmationVersion (= confirmation.version from the list; else 400 confirmation_version_mismatch { current }), rightsConfirmed=true, peopleConfirmed=true + consentRef (model release reference; both needed for product_models), licenceRef?, focalX?, focalY? (-1..1). 10 a minute per vendor (429 rate_limited). Rotated upright and stripped of EXIF/GPS, kept private until approved. Replaces any earlier photo; counts as an edit (see PATCH). → { banner }. Errors: 400 invalid_people | rights_confirmation_required | people_confirmation_required | invalid_focal | no_file_provided | unsupported_file_type | image_too_small { minWidth, minHeight, width, height } | invalid_multipart; 413 file_too_large { maxBytes }; 409 not_editable; 503 storage_service_unavailable.',
  onGuard: vendorGuard('post'),
  onRequest: async (req, res) => limited('upload', req, res) || upload(req, res, vendorScope(req)),
};

export const vendorShopBannerImage = {
  created, method: 'get', path: '/vendor/shop-banners/:id/image',
  description: 'Vendor / staff with `products` (SHOP_BANNERS): the cleaned private photo of my banner (WebP; Cache-Control: no-store, private). ?w=240|480|960 for thumbnails. 404 banner_not_found | image_not_found.',
  onGuard: vendorGuard('get'),
  onRequest: async (req, res) => streamPreview(res, await svc.imagePreview({ scope: vendorScope(req), id: req.params.id, width: req.query?.w })),
};

export const vendorSubmitShopBanner = {
  created, method: 'post', path: '/vendor/shop-banners/:id/submit',
  description: 'Vendor / staff with `products` (SHOP_BANNERS): send a draft for approval. Needs every text in both languages, a target that is mine and on sale (422 target_not_eligible { reason }), audienceRoles, startsAt ≥ 1 hour from now (422 start_too_soon { earliestStart }), endsAt after it (422 end_before_start), and a photo with its confirmations (422 image_required | image_people_unconfirmed). → { banner } (pending_approval, expiresAt = the earlier of now + SHOP_PROPOSAL_EXPIRY_DAYS (14) and startsAt). Not a draft → 409 invalid_transition.',
  onGuard: vendorGuard('post'),
  onRequest: async (req, res) => limited('submit', req, res) || sendBanner(res, await svc.submit({ scope: vendorScope(req), id: req.params.id, actorId: req.user.sub }), vendorRead(req)),
};

export const vendorWithdrawShopBanner = {
  created, method: 'post', path: '/vendor/shop-banners/:id/withdraw',
  description: 'Vendor / staff with `products` (SHOP_BANNERS): take a banner back before it goes live (draft, pending or approved-not-started → withdrawn). Live → 409 invalid_transition { hint: "end" }. → { banner }.',
  onGuard: vendorGuard('post'),
  onRequest: async (req, res) => sendBanner(res, await svc.withdraw({ scope: vendorScope(req), id: req.params.id, actorId: req.user.sub }), vendorRead(req)),
};

export const vendorEndShopBanner = {
  created, method: 'post', path: '/vendor/shop-banners/:id/end',
  description: 'Vendor / staff with `products` (SHOP_BANNERS): "End now" on a live banner (→ ended; it leaves the shop on the next shop home request). Not live → 409 invalid_transition. → { banner }.',
  onGuard: vendorGuard('post'),
  onRequest: async (req, res) => sendBanner(res, await svc.vendorEnd({ scope: vendorScope(req), id: req.params.id, actorId: req.user.sub }), vendorRead(req)),
};

// ── Admin ────────────────────────────────────────────────────────────────────

const adminRead = req => id => svc.adminGet({ id, viewer: viewerOf(req) });

export const adminShopMerch = {
  created, method: 'get', path: '/admin/shop-merch',
  description: 'Admin (promotions or promotions_approve; SHOP_BANNERS): the merch queue. ?kind=banner (the default; flash sales come in slice 4: anything else → 400 invalid_kind), ?tab=requests|scheduled|live|closed|drafts, ?status= (effective status), ?origin=vendor|staff, ?vendorId=, ?q= (seller, product or headline), ?limit, ?cursor. A vendor\'s drafts are never listed. requests are oldest-expiring first; the rest newest first. → { items: [banner (admin view)], total, nextCursor, counts: { requests, scheduled, live, closed, drafts } }.',
  onGuard: adminView('get'),
  onRequest: async (req, res) => send(res, await svc.adminList({ query: req.query || {}, viewer: viewerOf(req) })),
};

export const adminGetShopBanner = {
  created, method: 'get', path: '/admin/shop-banners/:id',
  description: 'Admin (promotions or promotions_approve; SHOP_BANNERS): one banner with its history. → { banner (admin view, incl. ownItem and allowedActions for this admin), history: [AuditLog rows shop_banner.*] }.',
  onGuard: adminView('get'),
  onRequest: async (req, res) => send(res, await adminRead(req)(req.params.id)),
};

export const adminShopBannerImage = {
  created, method: 'get', path: '/admin/shop-banners/:id/image',
  description: 'Admin (promotions or promotions_approve; SHOP_BANNERS): the cleaned private photo of a banner (WebP; no-store). ?w=240|480|960.',
  onGuard: adminView('get'),
  onRequest: async (req, res) => streamPreview(res, await svc.imagePreview({ scope: { any: true }, id: req.params.id, width: req.query?.w })),
};

export const adminCreateShopBanner = {
  created, method: 'post', path: '/admin/shop-banners',
  description: `Admin (promotions; SHOP_BANNERS): start a FitFlex banner (origin staff, a draft). ${BANNER_BODY} target.type: product | vendor_store | category (a product category key) | results (value = { category?, search?, brand?, vendorId?, promotions?, sort?, delivery? }). → 201 { banner }.`,
  onGuard: adminManage('post'),
  onRequest: async (req, res) => send(res, await svc.create({ scope: STAFF, actorId: req.user.sub, body: req.body || {}, viewer: viewerOf(req) }), 201),
};

export const adminUpdateShopBanner = {
  created, method: 'patch', path: '/admin/shop-banners/:id',
  description: 'Admin (promotions; SHOP_BANNERS): change a FitFlex banner (same rules as the vendor PATCH). A vendor\'s banner is never edited by FitFlex: 404 banner_not_found. → { banner }.',
  onGuard: adminManage('patch'),
  onRequest: async (req, res) => send(res, await svc.update({ scope: STAFF, id: req.params.id, actorId: req.user.sub, body: req.body || {}, viewer: viewerOf(req) })),
};

export const adminUploadShopBannerImage = {
  created, method: 'post', path: '/admin/shop-banners/:id/image',
  description: 'Admin (promotions; SHOP_BANNERS): the photo of a FitFlex banner (same multipart and errors as the vendor route). → { banner }.',
  onGuard: adminManage('post'),
  onRequest: async (req, res) => upload(req, res, STAFF, viewerOf(req)),
};

export const adminSubmitShopBanner = {
  created, method: 'post', path: '/admin/shop-banners/:id/submit',
  description: 'Admin (promotions; SHOP_BANNERS): send a FitFlex banner for approval by ANOTHER admin (same checks as the vendor submit). → { banner }.',
  onGuard: adminManage('post'),
  onRequest: async (req, res) => sendBanner(res, await svc.submit({ scope: STAFF, id: req.params.id, actorId: req.user.sub }), adminRead(req)),
};

export const adminWithdrawShopBanner = {
  created, method: 'post', path: '/admin/shop-banners/:id/withdraw',
  description: 'Admin (promotions; SHOP_BANNERS): take a FitFlex banner back before it goes live. → { banner }.',
  onGuard: adminManage('post'),
  onRequest: async (req, res) => sendBanner(res, await svc.withdraw({ scope: STAFF, id: req.params.id, actorId: req.user.sub }), adminRead(req)),
};

export const adminApproveShopBanner = {
  created, method: 'post', path: '/admin/shop-banners/:id/approve',
  description: 'Admin (promotions_approve; SHOP_BANNERS): approve a pending banner { revision (or updatedAt), imageId (both as reviewed; changed since → 409 banner_changed { revision, imageId }, missing → 400 revision_required), checks: ["people","text","languages"], position?: 0–9999 (lower shows first) }. The approver must have had no hand in it — created, edited, replaced the photo of or sent it (403 cannot_approve_own_submission). Without the photo confirmations or the "people" check → 422 image_people_unconfirmed; other checks missing → 422 review_checks_required { missing }. Vendor suspended / not operational now → 409 vendor_suspended | vendor_not_approved; target no longer on sale → 422 target_not_eligible; past its expiry → 409 proposal_expired. Makes the photo\'s public files (503 storage_service_unavailable if that fails: nothing changes). The vendor is notified. → { banner }.',
  onGuard: adminApprove('post'),
  onRequest: async (req, res) => sendBanner(res, await svc.approve({ id: req.params.id, actorId: req.user.sub, checks: req.body?.checks, position: req.body?.position, revision: req.body?.revision, updatedAt: req.body?.updatedAt, imageId: req.body?.imageId }), adminRead(req)),
};

export const adminRejectShopBanner = {
  created, method: 'post', path: '/admin/shop-banners/:id/reject',
  description: 'Admin (promotions_approve; SHOP_BANNERS): reject a pending banner { code: image|people|text|claim|link|other (required; 400 reason_code_required | invalid_reason_code), note (the vendor sees it; required for other → 400 note_required; ≤ 500), revision (or updatedAt), imageId (as reviewed; 409 banner_changed / 400 revision_required) }. Stored as statusReason = code, statusReasonNote = note. Not one\'s own (403 cannot_approve_own_submission). The vendor is notified. → { banner }.',
  onGuard: adminApprove('post'),
  onRequest: async (req, res) => sendBanner(res, await svc.reject({ id: req.params.id, actorId: req.user.sub, code: req.body?.code, note: req.body?.note, revision: req.body?.revision, updatedAt: req.body?.updatedAt, imageId: req.body?.imageId }), adminRead(req)),
};

export const adminEndShopBanner = {
  created, method: 'post', path: '/admin/shop-banners/:id/end',
  description: 'Admin (promotions_approve; SHOP_BANNERS): end an approved banner, scheduled or live { note (1–500, the vendor sees it; `reason` accepted too) } → statusReason ended_by_fitflex, statusReasonNote = note. Allowed on one\'s own too (stopping is always safe). Vendor banners: the vendor is notified. → { banner }.',
  onGuard: adminApprove('post'),
  onRequest: async (req, res) => sendBanner(res, await svc.end({ id: req.params.id, actorId: req.user.sub, reason: req.body?.note ?? req.body?.reason }), adminRead(req)),
};

export const adminPositionShopBanner = {
  created, method: 'post', path: '/admin/shop-banners/:id/position',
  description: 'Admin (promotions_approve; SHOP_BANNERS): reorder an approved banner { position: 0–9999 | null } without sending it back for approval. → { banner }.',
  onGuard: adminApprove('post'),
  onRequest: async (req, res) => sendBanner(res, await svc.setPosition({ id: req.params.id, actorId: req.user.sub, position: req.body?.position }), adminRead(req)),
};
