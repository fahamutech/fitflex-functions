// Shop home banners (Phase 2 · slice 1). Contract: docs/shop-banners-api.md. Dormant behind
// SHOP_BANNERS (the routes, the job and GET /shop/home check the flag; this service does not).
//
// - Vendors (the vendor account, or vendor staff with the `products` permission) propose banners
//   that link to one of their own products or to their own store. FitFlex staff (scope
//   `promotions`) create banners that may also link to a category or a results view.
// - Every banner is approved by someone with `promotions_approve` who neither created nor sent it
//   (403 cannot_approve_own_submission), after confirming the people rule for the photo.
// - Photos go through the app-photo cleaning pipeline (rotated upright, EXIF/GPS stripped) and stay
//   PRIVATE until approval; only approval makes public files (Zebra cannot delete, so files are made
//   for approved photos only).
// - Every change of state runs alone under one lock (store.transaction) and adds an AuditLog row
//   (`shop_banner.<action>`) with before and after. The vendor is told on approve, reject, expiry
//   and when FitFlex ends a banner (notifyVendor: inbox + push, English and Swahili).
// - "live" is never stored: an approved banner is live while now is inside its window. The shop
//   home reads banners on every request (no cache) and drops any whose vendor is suspended or not
//   operational, or whose target is no longer on sale.
import { createHash, randomUUID } from 'node:crypto';
import {
  BANNER_AUDIENCES, BANNER_EFFECTIVE_STATUSES, BANNER_PEOPLE, BANNER_IMAGE_LIMITS, REVIEW_CHECKS, REJECT_CODES, REASON_MAX,
  BANNER_CONFIRMATION, bannerConfigFromEnv, completenessError, effectiveStatus, headlineError, parseBannerInput, proposalExpiry, windowError,
  ctaFor, ctaKeyFor,
} from '../shared/shop-banner-rules.mjs';
import { storeNameOf } from '../shared/vendor-name.mjs';
import { prepareHeroUpload, buildHeroVariants, previewAt, sha256 } from '../infra/hero-image-file.mjs';

export const BANNER_PREVIEW_WIDTHS = Object.freeze([240, 480, 960]);
export const BANNER_PUBLIC_UPLOAD_TIMEOUT_MS = 30_000;
const SYSTEM_ACTOR = 'system';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const ms = v => new Date(v).getTime();
const newBannerId = () => `sbn_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const newImageId = () => `hero_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const shortHash = s => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const text = (v, max) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
const round3 = n => Math.round(n * 1000) / 1000;
const confirmed = v => v === true || v === 'true';
// Same rule as vendorName on product rows (src/shared/vendor-name.mjs).
const vendorName = storeNameOf;
const withEditor = (b, actorId) => [...new Set([...(b?.editors || []), actorId].filter(Boolean))];
/**
 * Two-person rule: anyone who created, edited, replaced the photo of, or sent a banner (and the
 * photo's uploader) has had a hand in it and may not approve, reject or reorder it.
 */
const isContributor = (b, actorId, img = null) => Boolean(actorId) && (
  actorId === b.createdBy || actorId === b.submittedBy || (b.editors || []).includes(actorId)
  || (img && (actorId === img.createdBy || actorId === img.rightsConfirmedBy || actorId === img.noFacesConfirmedBy)));
const headlineOf = (b, lang) => [b.headlineLead?.[lang], b.headlineAccent?.[lang]].filter(Boolean).join(' ');

function page(rows, query = {}) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);
  const offset = Math.max(parseInt(query.cursor, 10) || 0, 0);
  return { items: rows.slice(offset, offset + limit), total: rows.length, nextCursor: offset + limit < rows.length ? offset + limit : null };
}

const ADMIN_TABS = Object.freeze({
  requests: ['pending_approval'],
  scheduled: ['approved'],
  live: ['live'],
  closed: ['ended', 'rejected', 'expired', 'withdrawn'],
  drafts: ['draft'],
});

/** A product a buyer can find: the shop's listing rules (stock is checked separately). */
const productListed = p => p && !p.deletedAt && p.status === 'active' && !['pending', 'rejected'].includes(p.approvalStatus)
  && p.visibility !== 'hidden' && p.homepageVisible !== false;

export function createShopBannerService({
  store,
  documentStore = null,   // private Zebra store (put/get) — the cleaned master
  publicStore = null,     // public Zebra store (put → { url }) — files made on approval
  partnerGate = null,     // operationalUserIds(ids) → Set (KYC gate)
  moderationGate = null,  // blocked('vendor') → Set
  notifyVendor = async () => {},
  config = () => bannerConfigFromEnv(),
  now = () => new Date(),
  logger = console,
  uploadTimeoutMs = BANNER_PUBLIC_UPLOAD_TIMEOUT_MS,
}) {
  const stamp = () => now().toISOString();
  // History is read in `at` order: steps written in the same millisecond (create, photo and send
  // from one form) still get distinct, increasing times on this server.
  let lastAuditMs = 0;
  const auditAt = () => {
    lastAuditMs = Math.max(now().getTime(), lastAuditMs + 1);
    return new Date(lastAuditMs).toISOString();
  };
  const audit = (q, action, actor, banner, before, after) => q.audit({
    id: randomUUID(), at: auditAt(), actor, action: `shop_banner.${action}`, target: banner.id, before, after,
  });
  const snapshot = b => (b ? {
    status: b.status, revision: b.revision, imageId: b.imageId, ctaKey: b.ctaKey ?? null, headlineLead: b.headlineLead, headlineAccent: b.headlineAccent, subline: b.subline,
    ctaLabel: b.ctaLabel, imageAlt: b.imageAlt, target: b.target, audienceRoles: b.audienceRoles, startsAt: b.startsAt,
    endsAt: b.endsAt, position: b.position, statusReasonNote: b.statusReasonNote, statusReason: b.statusReason, expiresAt: b.expiresAt,
  } : null);

  // ── Who may do what ─────────────────────────────────────────────────────────

  /**
   * Fresh status of vendor accounts: suspended (account or moderation), approved and operational.
   * → Map(vendorId → { ok, reason: null | vendor_suspended | vendor_not_approved | vendor_not_found, row }).
   */
  async function vendorStates(q, ids) {
    const wanted = [...new Set(ids.filter(Boolean))];
    const out = new Map();
    if (!wanted.length) return out;
    const [rows, operational, blocked] = await Promise.all([
      q.vendors(wanted),
      partnerGate ? partnerGate.operationalUserIds(wanted) : new Set(wanted),
      moderationGate ? moderationGate.blocked('vendor') : new Set(),
    ]);
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const id of wanted) {
      const row = byId.get(id);
      let reason = null;
      if (!row) reason = 'vendor_not_found';
      else if (row.accountStatus === 'suspended' || blocked.has(id)) reason = 'vendor_suspended';
      // Fail closed (QA round 2): only an explicitly approved vendor counts. New vendors are
      // 'pending_approval'; 'pending', 'rejected', any other value and a missing one are not approved,
      // whatever the KYC gate says.
      else if (row.approvalStatus !== 'approved' || !operational.has(id)) reason = 'vendor_not_approved';
      out.set(id, { ok: !reason, reason, row: row || null });
    }
    return out;
  }

  async function vendorMayPropose(q, vendorId) {
    const s = (await vendorStates(q, [vendorId])).get(vendorId);
    if (s.ok) return null;
    return fail(s.reason, s.reason === 'vendor_not_found' ? 404 : 403);
  }

  /** A vendor banner may only link to the vendor's own product or store. */
  async function targetOwnership(q, target, banner) {
    if (!target || banner.origin !== 'vendor') return null;
    if (target.type === 'vendor_store') return target.value === banner.vendorId ? null : fail('target_not_owned', 403, { field: 'target.value' });
    if (target.type === 'product') {
      const [p] = await q.products([target.value]);
      if (!p || p.deletedAt || p.vendorId !== banner.vendorId) return fail('target_not_owned', 403, { field: 'target.value' });
    }
    return null;
  }

  /** The target is on sale now (checked on submit and approve; the shop home checks it again on every request). */
  async function targetEligibility(q, target) {
    if (!target) return fail('target_required', 422, { field: 'target' });
    if (target.type === 'product') {
      const [p] = await q.products([target.value]);
      if (!productListed(p)) return fail('target_not_eligible', 422, { field: 'target.value', reason: 'product_not_listed' });
      const s = (await vendorStates(q, [p.vendorId])).get(p.vendorId);
      if (!s.ok) return fail('target_not_eligible', 422, { field: 'target.value', reason: s.reason });
    }
    if (target.type === 'vendor_store') {
      const s = (await vendorStates(q, [target.value])).get(target.value);
      if (!s.ok) return fail('target_not_eligible', 422, { field: 'target.value', reason: s.reason });
    }
    return null;
  }

  /** The uploader confirmed rights and the people rule on the photo (spec O-3). */
  function imageConfirmed(img) {
    return Boolean(img && img.rightsConfirmedBy && img.rightsConfirmedAt && img.noFacesConfirmedBy && img.noFacesConfirmedAt
      && BANNER_PEOPLE.includes(img.people) && img.status !== 'retired' && Boolean(img.confirmationVersion)
      // Models need the consent (model release) reference the uploader gave.
      && (img.people !== 'product_models' || Boolean(img.consentRef)));
  }

  // ── Views ───────────────────────────────────────────────────────────────────

  const publicImage = img => (img?.variants ? {
    url1x: img.variants.url1x, url2x: img.variants.url2x, urlWide: img.variants.urlWide,
    focal: { x: img.focalX, y: img.focalY },
  } : null);

  function actionsFor(b, { side, canManage = false, canApprove = false, actorId = null }) {
    const eff = effectiveStatus(b, now());
    const out = [];
    const owns = side === 'vendor' || (b.origin === 'staff' && canManage);
    if (owns) {
      if (['draft', 'pending_approval', 'rejected', 'approved', 'live'].includes(eff)) out.push('edit');
      // Same states as edit: a new photo is an edit (rejected → draft, approved/live → pending).
      if (['draft', 'pending_approval', 'rejected', 'approved', 'live'].includes(eff)) out.push('image');
      if (eff === 'draft') out.push('submit');
      if (['draft', 'pending_approval', 'approved'].includes(eff)) out.push('withdraw');
      if (side === 'vendor' && eff === 'live') out.push('end');
    }
    if (side === 'admin' && canApprove) {
      const own = isContributor(b, actorId);
      if (eff === 'pending_approval' && !own) out.push('approve', 'reject');
      if (['approved', 'live'].includes(eff)) out.push('end');
      if (['approved', 'live'].includes(eff) && !own) out.push('position');
    }
    return [...new Set(out)];
  }

  function imageView(img, base, names = {}) {
    if (!img) return null;
    return {
      id: img.id, width: img.width, height: img.height, people: img.people,
      focal: { x: img.focalX, y: img.focalY },
      rightsConfirmedAt: img.rightsConfirmedAt, peopleConfirmedAt: img.noFacesConfirmedAt,
      confirmationVersion: img.confirmationVersion ?? null, consentRef: img.consentRef ?? null, licenceRef: img.licenceRef ?? null,
      ...(names ? {
        uploadedBy: img.createdBy, uploadedByName: names[img.createdBy] ?? null,
        rightsConfirmedBy: img.rightsConfirmedBy, rightsConfirmedByName: names[img.rightsConfirmedBy] ?? null,
        peopleConfirmedBy: img.noFacesConfirmedBy, peopleConfirmedByName: names[img.noFacesConfirmedBy] ?? null,
      } : {}),
      previewUrl: `${base}/image`,
      public: publicImage(img),
    };
  }

  function commonView(b) {
    return {
      id: b.id, origin: b.origin, vendorId: b.vendorId ?? null,
      status: b.status, effectiveStatus: effectiveStatus(b, now()),
      headlineLead: b.headlineLead ?? null, headlineAccent: b.headlineAccent ?? null, subline: b.subline ?? null,
      revision: b.revision,
      ctaKey: b.target ? ctaKeyFor(b) : (b.ctaKey ?? null),
      ctaLabel: b.target ? ctaFor(b) : (b.ctaLabel ?? null), ctaLabelCustom: Boolean(b.ctaLabel), imageAlt: b.imageAlt ?? null,
      target: b.target ?? null, audienceRoles: b.audienceRoles || [], startsAt: b.startsAt, endsAt: b.endsAt,
      position: b.position, statusReasonNote: b.statusReasonNote ?? null, statusReason: b.statusReason ?? null,
      expiresAt: b.status === 'pending_approval' ? b.expiresAt : null,
      submittedAt: b.submittedAt, approvedAt: b.approvedAt, decidedAt: b.decidedAt, endedAt: b.endedAt,
      createdAt: b.createdAt, updatedAt: b.updatedAt,
    };
  }

  /** What the vendor sees: no FitFlex staff ids or names. endedByFitflex says FitFlex stopped it. */
  function vendorView(b, { image, productName }) {
    return {
      ...commonView(b),
      targetName: productName ?? null,
      endedByFitflex: b.status === 'ended' && b.statusReason === 'ended_by_fitflex',
      image: imageView(image, `/vendor/shop-banners/${encodeURIComponent(b.id)}`, null),
      allowedActions: actionsFor(b, { side: 'vendor' }),
    };
  }

  function adminView(b, { image, names, vendor, productName, viewer }) {
    const own = isContributor(b, viewer?.actorId, image);
    return {
      ...commonView(b),
      vendorName: vendor ? vendorName(vendor) : null,
      sellerSuspended: vendor ? (vendor.accountStatus === 'suspended') : false,
      targetName: productName ?? null,
      createdBy: b.createdBy, createdByName: names[b.createdBy] ?? null,
      submittedBy: b.submittedBy ?? null, submittedByName: names[b.submittedBy] ?? null,
      approvedBy: b.approvedBy ?? null, approvedByName: names[b.approvedBy] ?? null,
      decidedBy: b.decidedBy ?? null, decidedByName: names[b.decidedBy] ?? null,
      endedBy: b.endedBy ?? null, endedByName: names[b.endedBy] ?? null,
      ownItem: Boolean(own),
      // Everyone who created, edited, replaced the photo of or sent it (two-person rule): none may decide it.
      editedBy: b.editors || [],
      image: imageView(image, `/admin/shop-banners/${encodeURIComponent(b.id)}`, names),
      allowedActions: actionsFor(b, { side: 'admin', ...viewer }),
    };
  }

  async function decorate(q, rows, side, viewer = null) {
    const images = new Map((await q.getImages(rows.map(r => r.imageId))).map(i => [i.id, i]));
    const productIds = rows.filter(r => r.target?.type === 'product').map(r => r.target.value);
    const products = new Map((await q.products(productIds)).map(p => [p.id, p]));
    const productName = r => (r.target?.type === 'product' ? products.get(r.target.value)?.name ?? null : null);
    if (side === 'vendor') return rows.map(r => vendorView(r, { image: images.get(r.imageId), productName: productName(r) }));
    const vendors = new Map((await q.vendors(rows.map(r => r.vendorId))).map(v => [v.id, v]));
    const ids = rows.flatMap(r => [r.createdBy, r.submittedBy, r.approvedBy, r.decidedBy, r.endedBy]);
    for (const img of images.values()) ids.push(img.rightsConfirmedBy, img.noFacesConfirmedBy, img.createdBy);
    const names = await q.displayNames(ids);
    return rows.map(r => adminView(r, { image: images.get(r.imageId), names, vendor: vendors.get(r.vendorId), productName: productName(r), viewer }));
  }

  // ── Loading in scope ────────────────────────────────────────────────────────

  /**
   * scope = { origin: 'vendor', vendorId } (a vendor's own banners) | { origin: 'staff' } (FitFlex
   * banners) | { any: true } (admin decisions: any banner a vendor has sent, and staff banners).
   * Anything else reads as banner_not_found (a vendor never learns another vendor's ids).
   */
  async function load(q, id, scope) {
    const b = await q.getBanner(id);
    if (!b) return null;
    if (scope.any) return b.origin === 'vendor' && b.status === 'draft' ? null : b; // vendor drafts are private
    if (scope.origin === 'vendor') return b.origin === 'vendor' && b.vendorId === scope.vendorId ? b : null;
    return b.origin === 'staff' ? b : null;
  }
  const notFound = () => fail('banner_not_found', 404);

  // ── Create and edit ─────────────────────────────────────────────────────────

  async function create({ scope, actorId, body, viewer = null }) {
    if (!actorId) return fail('actor_required', 403);
    const parsed = parseBannerInput(body, { origin: scope.origin, vendorId: scope.vendorId });
    if (parsed.error) return parsed;
    const v = parsed.value;
    const at = stamp();
    const row = {
      id: newBannerId(), origin: scope.origin, vendorId: scope.origin === 'vendor' ? scope.vendorId : null, imageId: null,
      headlineLead: v.headlineLead ?? null, headlineAccent: v.headlineAccent ?? null, subline: v.subline ?? null,
      ctaKey: v.ctaKey ?? null, ctaLabel: v.ctaLabel ?? null, imageAlt: v.imageAlt ?? null, target: v.target ?? null,
      audienceRoles: v.audienceRoles ?? [...BANNER_AUDIENCES], startsAt: v.startsAt ?? null, endsAt: v.endsAt ?? null,
      position: null, revision: 1, editors: [actorId],
      status: 'draft', statusChangedAt: at, createdBy: actorId, createdAt: at, updatedAt: at,
    };
    const shapeErr = headlineError(v) || windowError(v) || ctaKeyError(row);
    if (shapeErr) return shapeErr;
    const saved = await store.transaction(async (q) => {
      if (scope.origin === 'vendor') {
        const blocked = await vendorMayPropose(q, scope.vendorId);
        if (blocked) return blocked;
        const full = await openProposalsFull(q, scope.vendorId);
        if (full) return full;
      }
      const owned = await targetOwnership(q, row.target, row);
      if (owned) return owned;
      const out = await q.insertBanner(row);
      await audit(q, 'created', actorId, out, null, snapshot(out));
      return out;
    });
    if (saved.error) return saved;
    return { banner: (await decorate(store, [saved], scope.origin === 'vendor' ? 'vendor' : 'admin', viewer || { actorId, canManage: true }))[0] };
  }

  /** A vendor's button must be the one for its target ("View product" / "Visit store"). */
  function ctaKeyError(b) {
    if (b.origin !== 'vendor' || !b.ctaKey || !b.target) return null;
    const want = { product: 'view_product', vendor_store: 'visit_store' }[b.target.type];
    return b.ctaKey === want ? null : fail('invalid_cta_key', 422, { field: 'ctaKey', allowed: [want] });
  }

  /** SHOP_BANNER_MAX_OPEN: a vendor's drafts + pending proposals at once (abuse limit). */
  async function openProposalsFull(q, vendorId) {
    const max = config().maxOpenProposals;
    const open = await q.openProposals(vendorId, stamp());
    return open >= max ? fail('too_many_open_proposals', 409, { max, open }) : null;
  }

  /**
   * Apply an edit (fields, or a new photo) to a loaded banner under the lock, moving its state:
   *   draft → draft · pending_approval → pending_approval (expiry clock kept, re-dated if the start moves)
   *   rejected → draft (send it again) · approved / live → pending_approval (needs approval again)
   *   ended, expired, withdrawn → 409 not_editable.
   */
  async function applyEdit(q, b, patch, actorId, action, extraAfter = {}) {
    const eff = effectiveStatus(b, now());
    if (['ended', 'expired', 'withdrawn'].includes(eff)) return fail('not_editable', 409, { currentStatus: eff });
    const merged = { ...b, ...patch };
    const shapeErr = headlineError(merged) || windowError(merged) || ctaKeyError(merged);
    if (shapeErr) return shapeErr;
    const owned = await targetOwnership(q, patch.target, b);
    if (owned) return owned;
    const at = stamp();
    // Every change of content or photo is a new revision, and its author joins the editors.
    const next = { ...patch, revision: b.revision + 1, editors: withEditor(b, actorId), updatedAt: at };
    if (eff === 'rejected') {
      if (b.origin === 'vendor') {
        const full = await openProposalsFull(q, b.vendorId);
        if (full) return full;
      }
      Object.assign(next, { status: 'draft', statusChangedAt: at, submittedBy: null, submittedAt: null, expiresAt: null, decidedBy: null, decidedAt: null });
    } else if (eff === 'pending_approval') {
      const err = completenessError(merged, { now: now(), checkStart: 'startsAt' in patch });
      if (err) return err;
      next.expiresAt = proposalExpiry(b.submittedAt, merged.startsAt, config().proposalExpiryDays).toISOString();
    } else if (['approved', 'live'].includes(eff)) {
      const err = completenessError(merged, { now: now(), checkStart: true });
      if (err) return err;
      if (b.origin === 'vendor') {
        const blocked = await vendorMayPropose(q, b.vendorId);
        if (blocked) return blocked;
      }
      Object.assign(next, {
        status: 'pending_approval', statusChangedAt: at, statusReasonNote: null, statusReason: null,
        submittedBy: actorId, submittedAt: at, expiresAt: proposalExpiry(at, merged.startsAt, config().proposalExpiryDays).toISOString(),
        approvedBy: null, approvedAt: null, decidedBy: null, decidedAt: null, position: null,
      });
    }
    const saved = await q.updateBanner(b.id, next);
    await audit(q, action, actorId, saved, snapshot(b), { ...snapshot(saved), ...extraAfter });
    return saved;
  }

  async function update({ scope, id, actorId, body, viewer = null }) {
    if (!actorId) return fail('actor_required', 403);
    const b0 = await load(store, id, scope);
    if (!b0) return notFound();
    const parsed = parseBannerInput(body, { origin: b0.origin, vendorId: b0.vendorId });
    if (parsed.error) return parsed;
    if (!Object.keys(parsed.value).length) return fail('nothing_to_change', 400);
    const saved = await store.transaction(async (q) => {
      const b = await load(q, id, scope);
      if (!b) return notFound();
      if (b.origin === 'vendor') {
        const blocked = await vendorMayPropose(q, b.vendorId);
        if (blocked) return blocked;
      }
      return applyEdit(q, b, parsed.value, actorId, 'updated');
    });
    if (saved.error) return saved;
    return { banner: (await decorate(store, [saved], scope.origin === 'vendor' ? 'vendor' : 'admin', viewer || { actorId, canManage: true }))[0] };
  }

  // ── Photo ───────────────────────────────────────────────────────────────────

  const REF_MAX = 200;
  const refField = v => (v == null || v === '' ? { value: null } : typeof v === 'string' && v.trim() && v.trim().length <= REF_MAX ? { value: v.trim() } : { invalid: true });

  function parseFocalField(v) {
    if (v == null || v === '') return { value: 0 };
    const n = Number(v);
    return Number.isFinite(n) && n >= -1 && n <= 1 ? { value: round3(n) } : { invalid: true };
  }

  /**
   * multipart: file + people (none | product_models) + rightsConfirmed=true (+ peopleConfirmed=true
   * for product_models) + focalX?, focalY? (-1..1). The photo replaces any earlier one (that row is
   * retired) and counts as an edit (see applyEdit).
   */
  async function uploadImage({ scope, id, file, fields = {}, actorId, viewer = null }) {
    if (!actorId) return fail('actor_required', 403);
    if (!BANNER_PEOPLE.includes(fields.people)) return fail('invalid_people', 400, { field: 'people', allowed: BANNER_PEOPLE });
    if (fields.confirmationVersion !== BANNER_CONFIRMATION.version) {
      return fail('confirmation_version_mismatch', 400, { field: 'confirmationVersion', current: BANNER_CONFIRMATION.version });
    }
    if (!confirmed(fields.rightsConfirmed)) return fail('rights_confirmation_required', 400, { field: 'rightsConfirmed' });
    const models = fields.people === 'product_models';
    if (models && !confirmed(fields.peopleConfirmed)) return fail('people_confirmation_required', 400, { field: 'peopleConfirmed' });
    const consentRef = refField(fields.consentRef);
    const licenceRef = refField(fields.licenceRef);
    if (consentRef.invalid || licenceRef.invalid) return fail('invalid_reference', 400, { field: consentRef.invalid ? 'consentRef' : 'licenceRef', maxLength: REF_MAX });
    if (models && !consentRef.value) return fail('consent_reference_required', 400, { field: 'consentRef' });
    const fx = parseFocalField(fields.focalX); const fy = parseFocalField(fields.focalY);
    if (fx.invalid || fy.invalid) return fail('invalid_focal', 400);
    if (!file?.buffer?.length) return fail('no_file_provided', 400);
    if (file.truncated) return fail('file_too_large', 413, { maxBytes: BANNER_IMAGE_LIMITS.maxBytes });

    const b0 = await load(store, id, scope);
    if (!b0) return notFound();
    const eff0 = effectiveStatus(b0, now());
    if (['ended', 'expired', 'withdrawn'].includes(eff0)) return fail('not_editable', 409, { currentStatus: eff0 });
    if (b0.origin === 'vendor') {
      const blocked = await vendorMayPropose(store, b0.vendorId);
      if (blocked) return blocked;
    }
    if (!documentStore) return fail('storage_service_unavailable', 503);
    const prepared = await prepareHeroUpload(file.buffer, BANNER_IMAGE_LIMITS);
    if (prepared.error) return prepared;

    const imageId = newImageId();
    let stored;
    try {
      stored = await documentStore.put(prepared.buffer, `${imageId}.webp`, prepared.mimeType);
    } catch (err) {
      logger.error?.('[shop-banners] private upload failed:', err?.message);
      return fail('storage_service_unavailable', 503);
    }
    // From here the private file exists (Zebra cannot delete it): any outcome without a saved row is audited.
    const at = stamp();
    const refuse = out => { throw Object.assign(new Error(out.error), { refusal: out }); };
    let saved;
    try {
      saved = await store.transaction(async (q) => {
        const b = await load(q, id, scope);
        if (!b) refuse(notFound());
        const img = await q.insertImage({
          id: imageId, privateProvider: stored.provider, privateKey: stored.key, sha256: prepared.sha256, status: 'draft',
          width: prepared.width, height: prepared.height, focalX: fx.value, focalY: fy.value, variants: null,
          textZoneLuminance: prepared.luminance,
          source: b.origin === 'vendor' ? 'vendor_upload' : 'staff_upload', photographer: 'uploader', licence: 'uploader_confirmed_rights',
          licenceRef: licenceRef.value, people: fields.people, consentRef: consentRef.value,
          confirmationVersion: BANNER_CONFIRMATION.version,
          // The people confirmation: the "models showing the product" tick, or the "No people" choice itself.
          rightsConfirmedBy: actorId, rightsConfirmedAt: at, noFacesConfirmedBy: actorId, noFacesConfirmedAt: at,
          createdBy: actorId, createdAt: at, updatedAt: at, vendorId: b.vendorId ?? null,
        });
        const out = await applyEdit(q, b, { imageId: img.id }, actorId, 'image_uploaded', {
          image: { id: img.id, people: img.people, width: img.width, height: img.height, confirmationVersion: img.confirmationVersion, consentRef: img.consentRef },
        });
        // A refused edit (e.g. not_editable) rolls the row back with the transaction.
        if (out.error) refuse(out);
        if (b.imageId && b.imageId !== img.id) await q.updateImage(b.imageId, { status: 'retired', updatedAt: at });
        return out;
      });
    } catch (err) {
      logger.error?.(`[shop-banners] ORPHANED private file: image ${imageId} not saved (${err?.message}); provider=${stored.provider} key=${stored.key}`);
      try {
        await store.audit({
          id: randomUUID(), at: auditAt(), actor: actorId, action: 'shop_banner.image_orphaned', target: id, before: null,
          after: { imageId, privateKeyHash: shortHash(stored.key), sha256: prepared.sha256, reason: err?.refusal?.error || String(err?.message || 'insert_failed').slice(0, 200) },
        });
      } catch { /* logged above */ }
      return err?.refusal || fail('image_save_failed', 500);
    }
    return { banner: (await decorate(store, [saved], scope.origin === 'vendor' ? 'vendor' : 'admin', viewer || { actorId, canManage: true }))[0] };
  }

  /** The cleaned private photo of a banner in scope (never the raw upload). ?w = 240 | 480 | 960. */
  async function imagePreview({ scope, id, width = null }) {
    let w = null;
    if (width != null && width !== '') {
      w = Number(width);
      if (!BANNER_PREVIEW_WIDTHS.includes(w)) return fail('invalid_width', 400, { allowed: BANNER_PREVIEW_WIDTHS });
    }
    const b = await load(store, id, scope);
    if (!b) return notFound();
    const img = await store.getImage(b.imageId);
    if (!img) return fail('image_not_found', 404);
    const r = await readPrivate(img);
    if (r.error) return r;
    const buffer = w ? await previewAt(r.buffer, w) : r.buffer;
    return { file: { buffer, mimeType: 'image/webp', fileName: `${b.id}${w ? `-${w}` : ''}.webp` } };
  }

  async function readPrivate(img) {
    if (!documentStore || documentStore.provider !== img.privateProvider) return fail('storage_service_unavailable', 503);
    let buffer;
    try {
      buffer = await documentStore.get(img.privateKey);
    } catch (err) {
      logger.error?.('[shop-banners] private read failed:', err?.message);
      return fail('storage_service_unavailable', 503);
    }
    if (sha256(buffer) !== img.sha256) return fail('stored_file_mismatch', 502);
    return { buffer };
  }

  function putWithTimeout(file, filename, imageId) {
    let timer;
    let timedOut = false;
    const put = Promise.resolve().then(() => publicStore.put(file.buffer, filename, file.mimeType));
    put.then(r => { if (timedOut) logger.error?.(`[shop-banners] ORPHANED public file for ${imageId} (landed after timeout): ${r?.url}`); }, () => {});
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; reject(new Error(`public upload timed out after ${uploadTimeoutMs} ms`)); }, uploadTimeoutMs);
    });
    return Promise.race([put, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Build and upload the public files of a photo, OUTSIDE the banner lock (seconds of image work and
   * Zebra calls must not hold every banner write). Writes nothing to the database except, on a
   * part-way failure, an audit row naming the public files already made (Zebra cannot delete them).
   * → { variants, urls } or { error }.
   */
  async function buildPublicFiles(img, bannerId, actorId) {
    if (!publicStore) return fail('storage_service_unavailable', 503);
    const master = await readPrivate(img);
    if (master.error) return master;
    const built = await buildHeroVariants(master.buffer);
    if (built.error) return built;
    const urls = {};
    try {
      for (const [name, suffix] of [['x2', '2x'], ['x1', '1x'], ['wide', 'wide'], ['avif', 'wide']]) {
        urls[name] = (await putWithTimeout(built[name], `${img.id}-${suffix}.${built[name].ext}`, img.id)).url;
      }
    } catch (err) {
      await recordOrphanedPublicFiles(bannerId, img.id, Object.values(urls), actorId, `upload_failed: ${err?.message}`);
      return fail('storage_service_unavailable', 503);
    }
    return {
      urls: Object.values(urls),
      variants: {
        url2x: urls.x2, url1x: urls.x1, urlWide: urls.wide, urlAvif: urls.avif,
        bytes2x: built.x2.bytes, bytes1x: built.x1.bytes, bytesWide: built.wide.bytes, bytesAvif: built.avif.bytes,
        width2x: built.x2.width, height2x: built.x2.height, width1x: built.x1.width, height1x: built.x1.height,
        widthWide: built.wide.width, heightWide: built.wide.height,
      },
    };
  }

  /** Public files that no banner uses (a failed or overtaken approval): logged and audited, never silent. */
  async function recordOrphanedPublicFiles(bannerId, imageId, urls, actorId, reason) {
    if (!urls.length) return;
    logger.error?.(`[shop-banners] ORPHANED public files for ${imageId} (${reason}): ${urls.join(' ')}`);
    try {
      await store.audit({
        id: randomUUID(), at: auditAt(), actor: actorId, action: 'shop_banner.public_files_orphaned', target: bannerId, before: null,
        after: { imageId, urls, reason: String(reason).slice(0, 200) },
      });
    } catch (err) {
      logger.error?.(`[shop-banners] could not audit orphaned public files for ${imageId}:`, err?.message);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Run fn(q, banner) alone under the lock; then send the notice it returns (best effort). */
  async function act(id, scope, actorId, fn) {
    if (!actorId) return fail('actor_required', 403);
    const result = await store.transaction(async (q) => {
      const b = await load(q, id, scope);
      if (!b) return notFound();
      return fn(q, b);
    });
    if (result.error) return result;
    if (result.notice) await notice(result.saved, result.notice);
    return result;
  }

  async function move(q, b, to, actorId, action, extra = {}) {
    const at = stamp();
    const saved = await q.updateBanner(b.id, { status: to, statusChangedAt: at, updatedAt: at, ...extra });
    await audit(q, action, actorId, saved, { status: b.status, effectiveStatus: effectiveStatus(b, now()) }, {
      status: to, ...(extra.statusReasonNote !== undefined ? { reason: extra.statusReasonNote } : {}),
      ...(extra.statusReason ? { code: extra.statusReason } : {}), ...(extra.position != null ? { position: extra.position } : {}),
    });
    return saved;
  }

  const invalid = (b, to) => fail('invalid_transition', 409, { from: effectiveStatus(b, now()), to });

  const submit = ({ scope, id, actorId }) => act(id, scope, actorId, async (q, b) => {
    if (b.status !== 'draft') return invalid(b, 'pending_approval');
    if (b.origin === 'vendor') {
      const blocked = await vendorMayPropose(q, b.vendorId);
      if (blocked) return blocked;
    }
    const err = completenessError(b, { now: now(), checkStart: true });
    if (err) return err;
    const owned = await targetOwnership(q, b.target, b);
    if (owned) return owned;
    const elig = await targetEligibility(q, b.target);
    if (elig) return elig;
    if (!imageConfirmed(await q.getImage(b.imageId))) return fail('image_people_unconfirmed', 422, { field: 'image' });
    const at = stamp();
    const saved = await move(q, b, 'pending_approval', actorId, 'submitted', {
      submittedBy: actorId, submittedAt: at, editors: withEditor(b, actorId), statusReasonNote: null, statusReason: null,
      expiresAt: proposalExpiry(at, b.startsAt, config().proposalExpiryDays).toISOString(),
    });
    return { saved };
  });

  /** Take it back before it goes live: draft, pending or approved-not-yet-started → withdrawn. */
  const withdraw = ({ scope, id, actorId }) => act(id, scope, actorId, async (q, b) => {
    const eff = effectiveStatus(b, now());
    if (eff === 'live') return fail('invalid_transition', 409, { from: eff, to: 'withdrawn', hint: 'end' });
    if (!['draft', 'pending_approval', 'approved'].includes(eff)) return invalid(b, 'withdrawn');
    return { saved: await move(q, b, 'withdrawn', actorId, 'withdrawn', { expiresAt: null }) };
  });

  /** The proposer stops a live banner ("End now"). */
  const vendorEnd = ({ scope, id, actorId }) => act(id, scope, actorId, async (q, b) => {
    if (effectiveStatus(b, now()) !== 'live') return invalid(b, 'ended');
    return { saved: await move(q, b, 'ended', actorId, 'ended', { endedBy: actorId, endedAt: stamp(), statusReasonNote: null, statusReason: 'ended_by_vendor' }) };
  });

  /**
   * The decision must be about what the reviewer saw: { revision, imageId } of the banner they
   * reviewed. Missing → 400 revision_required; anything changed since → 409 banner_changed with the
   * current values (reload and review again).
   */
  function sameRevision(b, { revision, updatedAt, imageId }) {
    // `revision` is the contract; `updatedAt` (as shown in the view) is accepted when a client has no revision.
    const hasRevision = !(revision == null || revision === '');
    const hasUpdatedAt = typeof updatedAt === 'string' && updatedAt !== '';
    const missing = [!hasRevision && !hasUpdatedAt ? 'revision' : null, imageId == null || imageId === '' ? 'imageId' : null].filter(Boolean);
    if (missing.length) return fail('revision_required', 400, { fields: missing });
    const sameContent = hasRevision ? Number(revision) === b.revision : ms(updatedAt) === ms(b.updatedAt);
    if (!sameContent || imageId !== b.imageId) return fail('banner_changed', 409, { revision: b.revision, updatedAt: b.updatedAt, imageId: b.imageId });
    return null;
  }

  /**
   * Everything approval needs, read from `q`. Run twice: before the public files are made (outside
   * the lock) and again under the lock right before the state changes.
   * → { img, pos } or { error }.
   */
  async function approvalCheck(q, b, { actorId, checks, position, revision, updatedAt, imageId }) {
    const eff = effectiveStatus(b, now());
    if (eff === 'expired') return fail('proposal_expired', 409, { expiresAt: b.expiresAt });
    if (eff !== 'pending_approval') return invalid(b, 'approved');
    const changed = sameRevision(b, { revision, updatedAt, imageId });
    if (changed) return changed;
    const img = await q.getImage(b.imageId);
    if (isContributor(b, actorId, img)) return fail('cannot_approve_own_submission', 403);
    const pos = position == null || position === '' ? null : Number(position);
    if (pos !== null && !(Number.isInteger(pos) && pos >= 0 && pos <= 9999)) return fail('invalid_position', 400, { field: 'position' });
    const ticked = Array.isArray(checks) ? checks : [];
    if (!imageConfirmed(img) || !ticked.includes('people')) return fail('image_people_unconfirmed', 422, { field: 'checks', required: REVIEW_CHECKS });
    const missing = REVIEW_CHECKS.filter(c => !ticked.includes(c));
    if (missing.length) return fail('review_checks_required', 422, { field: 'checks', missing, required: REVIEW_CHECKS });
    const err = completenessError(b, { now: now(), checkStart: false });
    if (err) return err;
    if (b.origin === 'vendor') {
      const st = (await vendorStates(q, [b.vendorId])).get(b.vendorId);
      if (!st.ok) return fail(st.reason, 409);
    }
    const owned = await targetOwnership(q, b.target, b);
    if (owned) return owned;
    const elig = await targetEligibility(q, b.target);
    if (elig) return elig;
    return { img, pos };
  }

  /**
   * Approve a pending banner: promotions_approve (the route), someone who had no hand in it (two-person
   * rule), the revision and photo the reviewer saw, the review checks, the uploader's confirmations, a
   * vendor still allowed to sell, a target still on sale. The public files are made outside the lock;
   * the state changes under it after every check is run again. Optional position (0–9999).
   */
  async function approve({ id, actorId, checks, position, revision, updatedAt, imageId }) {
    if (!actorId) return fail('actor_required', 403);
    const args = { actorId, checks, position, revision, updatedAt, imageId };
    const b0 = await load(store, id, { any: true });
    if (!b0) return notFound();
    const pre = await approvalCheck(store, b0, args);
    if (pre.error) return pre;
    let built = null;
    if (!pre.img.variants) {
      built = await buildPublicFiles(pre.img, b0.id, actorId);
      if (built.error) return built;
    }
    const result = await store.transaction(async (q) => {
      const b = await load(q, id, { any: true });
      if (!b) return notFound();
      const chk = await approvalCheck(q, b, args);
      if (chk.error) return chk;
      if (!chk.img.variants) {
        if (!built || chk.img.id !== pre.img.id) return fail('banner_changed', 409, { revision: b.revision, imageId: b.imageId });
        await q.updateImage(chk.img.id, { variants: built.variants, status: 'published', updatedAt: stamp() });
        await q.audit({ id: randomUUID(), at: auditAt(), actor: actorId, action: 'shop_banner.image_published', target: b.id, before: null, after: { imageId: chk.img.id, urls: built.urls } });
        built.used = true;
      }
      const at = stamp();
      const saved = await move(q, b, 'approved', actorId, 'approved', {
        approvedBy: actorId, approvedAt: at, decidedBy: actorId, decidedAt: at, position: chk.pos, expiresAt: null,
        statusReasonNote: null, statusReason: null,
      });
      return { saved, notice: 'approved' };
    });
    if (built && !built.used) await recordOrphanedPublicFiles(b0.id, pre.img.id, built.urls, actorId, result.error || 'not_used');
    if (result.error) return result;
    await notice(result.saved, 'approved');
    return result;
  }

  /**
   * Reject a pending banner { code (one of REJECT_CODES), note (the vendor sees it; required for
   * "other", else optional; ≤ 500), revision | updatedAt, imageId }.
   */
  const reject = ({ id, actorId, code, note, revision, updatedAt, imageId }) => act(id, { any: true }, actorId, async (q, b) => {
    const eff = effectiveStatus(b, now());
    if (eff === 'expired') return fail('proposal_expired', 409, { expiresAt: b.expiresAt });
    if (eff !== 'pending_approval') return invalid(b, 'rejected');
    const changed = sameRevision(b, { revision, updatedAt, imageId });
    if (changed) return changed;
    if (isContributor(b, actorId, await q.getImage(b.imageId))) return fail('cannot_approve_own_submission', 403);
    if (code == null || code === '') return fail('reason_code_required', 400, { field: 'code', allowed: REJECT_CODES });
    if (!REJECT_CODES.includes(code)) return fail('invalid_reason_code', 400, { field: 'code', allowed: REJECT_CODES });
    if (note != null && (typeof note !== 'string' || note.trim().length > REASON_MAX)) return fail('invalid_note', 400, { field: 'note', maxLength: REASON_MAX });
    const why = text(note, REASON_MAX);
    if (code === 'other' && !why) return fail('note_required', 400, { field: 'note', maxLength: REASON_MAX });
    const at = stamp();
    const saved = await move(q, b, 'rejected', actorId, 'rejected', {
      statusReasonNote: why, statusReason: code, decidedBy: actorId, decidedAt: at, expiresAt: null,
    });
    return { saved, notice: 'rejected' };
  });

  /** FitFlex ends an approved banner (scheduled or live) with a reason the vendor sees. */
  const end = ({ id, actorId, reason }) => act(id, { any: true }, actorId, async (q, b) => {
    const eff = effectiveStatus(b, now());
    if (!['approved', 'live'].includes(eff)) return invalid(b, 'ended');
    const why = text(reason, REASON_MAX);
    if (!why) return fail('reason_required', 400, { field: 'reason', maxLength: REASON_MAX });
    const saved = await move(q, b, 'ended', actorId, 'ended', { endedBy: actorId, endedAt: stamp(), statusReasonNote: why, statusReason: 'ended_by_fitflex' });
    return { saved, notice: b.origin === 'vendor' ? 'ended' : null };
  });

  /** Reorder an approved banner without sending it back for approval (promotions_approve). */
  const setPosition = ({ id, actorId, position }) => act(id, { any: true }, actorId, async (q, b) => {
    const eff = effectiveStatus(b, now());
    if (!['approved', 'live'].includes(eff)) return invalid(b, eff);
    if (isContributor(b, actorId, await q.getImage(b.imageId))) return fail('cannot_approve_own_submission', 403);
    const pos = position == null ? null : Number(position);
    if (pos !== null && !(Number.isInteger(pos) && pos >= 0 && pos <= 9999)) return fail('invalid_position', 400, { field: 'position' });
    const saved = await q.updateBanner(b.id, { position: pos, updatedAt: stamp() });
    await audit(q, 'position_set', actorId, saved, { position: b.position }, { position: pos });
    return { saved };
  });

  /**
   * Write down what time has already decided: pending proposals past their expiry → expired (the
   * vendor is told), approved banners past their end → ended. Reads never wait for this (they work
   * the state out from the time), so a late run changes nothing anyone sees. Idempotent.
   */
  async function runLifecycle() {
    const at = now();
    const done = await store.transaction(async (q) => {
      const { expired, ended } = await q.lapsed(at.toISOString());
      const out = { expired: [], ended: [] };
      for (const b of expired) {
        // expiresAt is the earlier of sent + N days and the start: which one it was is the reason.
        const code = ms(b.startsAt) <= ms(b.expiresAt) ? 'start_passed' : 'not_reviewed_in_time';
        out.expired.push(await move(q, b, 'expired', SYSTEM_ACTOR, 'expired', { statusReasonNote: null, statusReason: code }));
      }
      for (const b of ended) out.ended.push(await move(q, b, 'ended', SYSTEM_ACTOR, 'ended', { endedAt: b.endsAt, statusReasonNote: null, statusReason: 'window_passed' }));
      return out;
    });
    for (const b of done.expired) await notice(b, 'expired');
    return { expired: done.expired.length, ended: done.ended.length };
  }

  async function notice(b, kind) {
    if (!b || b.origin !== 'vendor' || !kind) return;
    try {
      await notifyVendor(b.vendorId, `shop_banner_${kind}`, {
        bannerId: b.id, headline: headlineOf(b, 'en'), headlineSw: headlineOf(b, 'sw'),
        startsAt: b.startsAt, reason: kind === 'rejected' || kind === 'ended' ? (b.statusReasonNote || '') : '',
      });
    } catch (err) {
      logger.error?.(`[shop-banners] could not tell vendor ${b.vendorId} about ${b.id} (${kind}):`, err?.message);
    }
  }

  // ── Lists ───────────────────────────────────────────────────────────────────

  async function vendorList({ vendorId, query = {} }) {
    let rows = await store.listBanners({ origin: 'vendor', vendorId });
    if (query.status) {
      if (!BANNER_EFFECTIVE_STATUSES.includes(query.status)) return fail('invalid_status', 400, { allowed: BANNER_EFFECTIVE_STATUSES });
      rows = rows.filter(r => effectiveStatus(r, now()) === query.status);
    }
    const p = page(rows, query);
    const s = (await vendorStates(store, [vendorId])).get(vendorId);
    return {
      items: await decorate(store, p.items, 'vendor'), total: p.total, nextCursor: p.nextCursor,
      // The app shows the suspended alert / "available once approved" state from this.
      vendor: { canPropose: s.ok, reason: s.reason },
      proposalExpiryDays: config().proposalExpiryDays,
      openProposals: { open: await store.openProposals(vendorId, stamp()), max: config().maxOpenProposals },
      // The exact texts the photo form shows and sends back as confirmationVersion.
      confirmation: BANNER_CONFIRMATION,
    };
  }

  async function vendorGet({ vendorId, id }) {
    const b = await load(store, id, { origin: 'vendor', vendorId });
    if (!b) return notFound();
    return { banner: (await decorate(store, [b], 'vendor'))[0] };
  }

  async function adminList({ query = {}, viewer }) {
    const kind = query.kind ?? 'banner';
    if (kind !== 'banner') return fail('invalid_kind', 400, { allowed: ['banner'] });
    // A vendor's drafts are theirs until sent.
    const all = (await store.listBanners()).filter(r => !(r.origin === 'vendor' && r.status === 'draft'));
    const eff = r => effectiveStatus(r, now());
    const counts = Object.fromEntries(Object.entries(ADMIN_TABS).map(([tab, states]) => [tab, all.filter(r => states.includes(eff(r))).length]));
    let rows = all;
    if (query.tab) {
      if (!ADMIN_TABS[query.tab]) return fail('invalid_tab', 400, { allowed: Object.keys(ADMIN_TABS) });
      rows = rows.filter(r => ADMIN_TABS[query.tab].includes(eff(r)));
    }
    if (query.status) {
      if (!BANNER_EFFECTIVE_STATUSES.includes(query.status)) return fail('invalid_status', 400, { allowed: BANNER_EFFECTIVE_STATUSES });
      rows = rows.filter(r => eff(r) === query.status);
    }
    if (query.origin) rows = rows.filter(r => r.origin === query.origin);
    if (query.vendorId) rows = rows.filter(r => r.vendorId === query.vendorId);
    const needle = typeof query.q === 'string' ? query.q.trim().toLowerCase().slice(0, 100) : '';
    let decorated = await decorate(store, rows, 'admin', viewer);
    if (needle) {
      decorated = decorated.filter(v => [v.vendorName, v.targetName, v.headlineLead?.en, v.headlineAccent?.en, v.headlineLead?.sw, v.headlineAccent?.sw]
        .some(s => String(s || '').toLowerCase().includes(needle)));
    }
    // Requests: oldest sent first (the one closest to expiring on top). Everything else: newest first.
    if (query.tab === 'requests' || query.status === 'pending_approval') decorated.sort((a, b) => ms(a.expiresAt) - ms(b.expiresAt) || a.id.localeCompare(b.id));
    const p = page(decorated, query);
    return { items: p.items, total: p.total, nextCursor: p.nextCursor, counts, confirmation: BANNER_CONFIRMATION };
  }

  async function adminGet({ id, viewer }) {
    const b = await load(store, id, { any: true });
    if (!b) return notFound();
    const history = await store.history(id);
    const names = await store.displayNames(history.map(r => r.actor));
    return {
      banner: (await decorate(store, [b], 'admin', viewer))[0],
      // actorName: display name (else email); null for the system (lifecycle job).
      history: history.map(r => ({ ...r, actorName: r.actor === SYSTEM_ACTOR ? null : names[r.actor] ?? null })),
    };
  }

  // ── The shop home ───────────────────────────────────────────────────────────

  /**
   * The live banners for this shopper, worked out now (nothing cached): approved, inside the window,
   * for this mode, vendor not suspended / operational, target still on sale (`products` = the
   * buyer-visible catalogue the home already loaded), photo published. Staff banners have no
   * vendorName. Ordered by position (lower first, unset last), then staff before vendor, then
   * start time. SHOP_BANNER_MAX_LIVE (0 = all) cuts the list.
   */
  async function feed({ mode, products = [], ownVendorIds = [], at = now() }) {
    if (!BANNER_AUDIENCES.includes(mode)) return [];
    const t = at.getTime();
    const rows = (await store.approvedNotEnded(at.toISOString()))
      .filter(b => ms(b.startsAt) <= t && ms(b.endsAt) > t && (b.audienceRoles || []).includes(mode));
    if (!rows.length) return [];
    const byProduct = new Map(products.map(p => [p.id, p]));
    const own = new Set(ownVendorIds.filter(Boolean));
    const vendorIds = rows.flatMap(b => [
      b.vendorId,
      b.target?.type === 'vendor_store' ? b.target.value : null,
      b.target?.type === 'product' ? byProduct.get(b.target.value)?.vendorId : null,
    ]);
    const states = await vendorStates(store, vendorIds);
    const vendorOk = id => states.get(id)?.ok === true;
    const inStock = p => p && Number(p.stock) > 0;
    const targetOk = (tg) => {
      switch (tg?.type) {
        case 'product': { const p = byProduct.get(tg.value); return inStock(p) && vendorOk(p.vendorId) && !own.has(p.vendorId); }
        case 'vendor_store': return vendorOk(tg.value) && !own.has(tg.value) && products.some(p => p.vendorId === tg.value && inStock(p));
        case 'category': return products.some(p => p.category === tg.value && inStock(p));
        case 'results': return true;
        default: return false;
      }
    };
    const kept = rows.filter(b => (b.origin === 'staff' || (vendorOk(b.vendorId) && !own.has(b.vendorId))) && targetOk(b.target));
    const images = new Map((await store.getImages(kept.map(b => b.imageId))).map(i => [i.id, i]));
    const pos = b => (b.position == null ? Number.MAX_SAFE_INTEGER : b.position);
    const out = kept
      .filter(b => images.get(b.imageId)?.variants && images.get(b.imageId).status !== 'retired')
      .sort((a, b) => pos(a) - pos(b) || (a.origin === b.origin ? 0 : a.origin === 'staff' ? -1 : 1)
        || ms(a.startsAt) - ms(b.startsAt) || a.id.localeCompare(b.id))
      .map(b => ({
        id: b.id,
        image: publicImage(images.get(b.imageId)),
        imageAlt: b.imageAlt,
        headlineLead: b.headlineLead,
        headlineAccent: b.headlineAccent,
        subline: b.subline ?? null,
        ctaLabel: ctaFor(b),
        target: b.target,
        origin: b.origin,
        ...(b.origin === 'vendor' ? { vendorName: vendorName(states.get(b.vendorId)?.row) } : {}),
        endsAt: b.endsAt,
      }));
    const { maxLive } = config();
    return maxLive > 0 ? out.slice(0, maxLive) : out;
  }

  return {
    // vendor (scope { origin: 'vendor', vendorId }) and staff (scope { origin: 'staff' })
    create, update, uploadImage, imagePreview, submit, withdraw, vendorEnd,
    vendorList, vendorGet,
    // admin decisions
    approve, reject, end, setPosition, adminList, adminGet,
    // time and the shop home
    runLifecycle, feed,
  };
}
