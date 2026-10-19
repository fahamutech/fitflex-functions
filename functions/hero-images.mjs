// Admin-managed app photos REST surface (plan docs/plans/photo-hero-sections-footer-admin-plan.md, slice 4).
//
// Dormant unless HERO_IMAGES_CMS is set:
//   - every /admin/hero-images and /admin/hero-slots route answers 404 feature_disabled, before
//     sign-in is even checked, so the surface is invisible;
//   - the public GET /app/hero-images answers { version: 0, slots: {} } (the apps then drop any
//     saved photos and use the bundled ones).
// Admin routes need an admin session with the brand_media scope (super-admins pass). Any such admin
// uploads, edits and publishes alone (owner decision D-4); every write is in the audit log.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { heroImageService as svc } from '../src/bootstrap/services.mjs';
import { parseMultipartRequest } from '../src/infra/storage-client.mjs';
import { HERO_LIMITS } from '../src/infra/hero-image-file.mjs';
import { EMPTY_HERO_MANIFEST } from '../src/services/hero-image-service.mjs';
import { heroImagesCmsOn } from '../src/shared/feature-flags.mjs';

const created = new Date().toISOString();

/** First guard on every admin route: with the flag off the routes do not exist. */
const heroImagesCmsEnabled = (_req, res, next) => (heroImagesCmsOn() ? next() : res.status(404).json({ error: 'feature_disabled' }));
const heroAdminGuard = [heroImagesCmsEnabled, requireAuth('admin'), requireAcl('brand_media')];

// No stale-while-revalidate: a photo taken down (unpublish) must stop being served within
// max-age (5 min) plus this server's 60 s memory, not linger in caches for up to a day.
export const HERO_MANIFEST_CACHE_CONTROL = 'public, max-age=300';

function send(res, result, okStatus = 200) {
  if (result.error) {
    const { error, status, ...extra } = result;
    return res.status(status || 400).json({ error, ...extra });
  }
  res.status(okStatus).json(result);
}

/** Does If-None-Match name this ETag? (Comma lists, weak tags and * are honoured.) */
export function etagMatches(header, etag) {
  if (!header) return false;
  return String(header).split(',').map(t => t.trim().replace(/^W\//, '')).some(t => t === '*' || t === etag);
}

// ── Public ───────────────────────────────────────────────────────────────────

export const appHeroImages = {
  created, method: 'get', path: '/app/hero-images',
  description: 'Public, no sign-in: the published app photos per slot. → { version, publishedAt, slots: { [slotId]: [{ id, sourceId, url, url1x, urlWide, urlAvif, width, height, bytes, focal: { x, y } }] } }. url/url1x/urlWide/urlAvif are root-relative /storage/:cid/:filename addresses (as gym photos). version is the publication id and the ETag is "hp_<version>"; send If-None-Match to get 304. An empty answer { version: 0, slots: {} } means "use the bundled photos and delete saved ones" (nothing published, or HERO_IMAGES_CMS off). Cache-Control: public, max-age=300 (no stale-while-revalidate, so a takedown reaches the apps within about 6 minutes); the server keeps the answer for 60 s.',
  responseSample: {
    version: 12, publishedAt: '2026-10-19T08:00:00.000Z',
    slots: { gyms: [{ id: 'hero_ab12cd34ef56ab78-1a2b3c4d5e6f', sourceId: 'hero_ab12cd34ef56ab78', url: '/storage/bafy.../hero_ab12cd34ef56ab78-2x.webp', url1x: '/storage/bafy.../hero_ab12cd34ef56ab78-1x.webp', urlWide: '/storage/bafy.../hero_ab12cd34ef56ab78-wide.webp', urlAvif: '/storage/bafy.../hero_ab12cd34ef56ab78-wide.avif', width: 1080, height: 720, bytes: 98304, focal: { x: -0.3, y: 0 } }] },
  },
  onRequest: async (req, res) => {
    let m = EMPTY_HERO_MANIFEST;
    if (heroImagesCmsOn()) {
      try {
        m = await svc.manifest();
      } catch (err) {
        console.error('[hero-images] manifest failed:', err?.message);
        res.setHeader('Cache-Control', 'no-store');
        return res.status(503).json({ error: 'hero_images_unavailable' });
      }
    }
    res.setHeader('ETag', m.etag);
    res.setHeader('Cache-Control', HERO_MANIFEST_CACHE_CONTROL);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (etagMatches(req.headers?.['if-none-match'], m.etag)) return res.status(304).end();
    res.status(200).json(m.body);
  },
};

// ── Admin (brand_media) ──────────────────────────────────────────────────────

export const adminHeroImages = {
  created, method: 'get', path: '/admin/hero-images',
  description: 'Admin (brand_media; HERO_IMAGES_CMS): the photo library and every slot. → { areas[preSignIn, members, partners, footers, portal], images[{ id, sourceId, status, width, height, focal{x,y}, focalX, focalY, variants, textZoneLuminance{vertical,horizontal}{mean,maxPatch}, brightWarning{vertical,horizontal}, source, photographer, licence, licenceRef, people, consentRef, rightsConfirmedBy(+Name, At), noFacesConfirmedBy(+Name, At), createdBy, createdByName, createdAt, updatedAt, previewUrl }] (never the storage key), slots[{ id, area, surface, variant, aspectHint, maxImages, draft[imageId], published[imageId], brightWarning }] in display order, publications[last 20 { id, publishedBy, publishedByName, publishedAt, note, rolledBackFrom, slots{ slotId: [imageId] } }] }.',
  onGuard: heroAdminGuard,
  onRequest: async (req, res) => send(res, await svc.adminState()),
};

export const adminUploadHeroImage = {
  created, method: 'post', path: '/admin/hero-images',
  description: 'Admin (brand_media; HERO_IMAGES_CMS): upload a photo. multipart/form-data: file (JPEG, PNG, WebP or HEIF/AVIF; ≤ 15 MB, ≤ 50 MP, ≥ 1080 px wide upright) + source, photographer, licence, licenceRef?, people (only none for now; hands_backs | unclear_faces are refused with people_not_allowed until Zebra can delete files), consentRef?, rightsConfirmed=true, noFacesConfirmed=true. The photo is rotated upright and stripped of EXIF/GPS, then kept private until published. → 201 { image }. Errors: 400 rights_confirmation_required | no_faces_confirmation_required | licence_details_required | invalid_people | people_not_allowed | invalid_reference | no_file_provided | image_too_small | unsupported_file_type; 413 file_too_large; 500 image_save_failed (the private file was stored but not recorded; logged and audited); 503 storage_service_unavailable.',
  onGuard: heroAdminGuard,
  onRequest: async (req, res) => {
    let parsed;
    try {
      parsed = await parseMultipartRequest(req, { fileSize: HERO_LIMITS.maxBytes, files: 1, fields: 12, parts: 13, fieldSize: 4096 });
    } catch {
      return res.status(400).json({ error: 'invalid_multipart' });
    }
    const fields = {};
    for (const { name, value } of parsed.fields) if (!(name in fields)) fields[name] = value;
    const file = parsed.files.find(f => f.fieldname === 'file') || parsed.files[0] || null;
    send(res, await svc.upload({ file, fields, actorId: req.user.sub }), 201);
  },
};

export const adminHeroImagePreview = {
  created, method: 'get', path: '/admin/hero-images/:id/preview',
  description: 'Admin (brand_media; HERO_IMAGES_CMS): the cleaned private photo (rotated, no metadata, long edge ≤ 2560; never the raw upload), streamed (Cache-Control: no-store, private). Optional ?w=240|480|960 for thumbnails. Each successful view is audited (hero_image_previewed: actor, image, size). 400 invalid_width; 404 image_not_found; 502 stored_file_mismatch; 503 storage_service_unavailable.',
  onGuard: heroAdminGuard,
  onRequest: async (req, res) => {
    const result = await svc.preview(req.params.id, { width: req.query?.w, actorId: req.user.sub });
    if (result.error) return send(res, result);
    const { buffer, mimeType, fileName } = result.file;
    res.status(200);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(buffer);
  },
};

export const adminUpdateHeroImage = {
  created, method: 'patch', path: '/admin/hero-images/:id',
  description: 'Admin (brand_media; HERO_IMAGES_CMS): change a photo { focal?: { x, y } (each -1..1), source?, photographer?, licence?, licenceRef?, people?, consentRef?, status?: "retired", rightsConfirmed?, noFacesConfirmed? }. Changing source, photographer, licence, licenceRef, people or consentRef needs rightsConfirmed: true (people also noFacesConfirmed: true) and records the session admin as the confirmer; unchanged values sent back need neither. people must be none for now. A photo in any slot draft cannot be retired (409 image_in_draft { slotIds }); a retired photo still shows until unpublished or the next publish (the answer says inLiveSnapshot). → { image }. Errors: 400 unknown_field | invalid_focal | licence_details_required | invalid_reference | invalid_people | people_not_allowed | rights_confirmation_required | no_faces_confirmation_required | invalid_status | nothing_to_change; 404 image_not_found; 409 image_retired | image_in_draft.',
  onGuard: heroAdminGuard,
  onRequest: async (req, res) => send(res, await svc.update(req.params.id, req.body || {}, req.user.sub)),
};

export const adminUnpublishHeroImage = {
  created, method: 'post', path: '/admin/hero-images/:id/unpublish',
  description: 'Admin (brand_media; HERO_IMAGES_CMS): fast takedown. Publishes the current live snapshot again without this photo { note? } (drafts are not touched: take it out of the drafts too, or the next publish brings it back). This server answers the new manifest at once; other servers within 60 s; apps within Cache-Control max-age 300. Rollback to any older snapshot holding the photo is refused from now on (409 image_unpublished); rollbackBlockedBefore is the new snapshot id. → 201 { publication, removedFromSlots[slotId], rollbackBlockedBefore }. Errors: 400 invalid_note; 404 image_not_found; 409 image_not_live.',
  onGuard: heroAdminGuard,
  onRequest: async (req, res) => send(res, await svc.unpublish(req.params.id, req.body || {}, req.user.sub), 201),
};

export const adminSetHeroSlot = {
  created, method: 'put', path: '/admin/hero-slots/:slotId',
  description: 'Admin (brand_media; HERO_IMAGES_CMS): set a slot\'s draft photos in order { imageIds: [...] } ([] = use the bundled photo). Nothing changes in the apps until publish. → { slot: { id, draft } }. Errors: 400 unknown_slot | invalid_image_ids | duplicate_image | too_many_images | image_not_found { imageIds } | image_retired { imageIds } | people_not_allowed { imageIds, allowed } (older photos whose people value is no longer accepted).',
  onGuard: heroAdminGuard,
  onRequest: async (req, res) => send(res, await svc.setSlot(req.params.slotId, req.body || {}, req.user.sub)),
};

export const adminPublishHeroSlots = {
  created, method: 'post', path: '/admin/hero-slots/publish',
  description: 'Admin (brand_media; HERO_IMAGES_CMS): publish every slot\'s draft as a new snapshot { note? }. Photos used for the first time get their public files now (WebP 1080 ≤ 150 KB, 540 ≤ 60 KB, wide ≤ 1600, AVIF): all are built first and uploaded only if every one succeeds (Zebra cannot delete). → 201 { publication }. Each upload has 30 s; a timeout aborts like a failed upload. Errors: 400 invalid_note | people_not_allowed { imageIds, allowed }; 409 drafts_changed { imageIds }; 422 variant_over_budget { imageId }; 502 stored_file_mismatch { imageId }; 503 storage_service_unavailable { imageId?, reason?: "upload_timeout" }.',
  onGuard: heroAdminGuard,
  onRequest: async (req, res) => send(res, await svc.publish(req.body || {}, req.user.sub), 201),
};

export const adminRollbackHeroSlots = {
  created, method: 'post', path: '/admin/hero-slots/rollback',
  description: 'Admin (brand_media; HERO_IMAGES_CMS): put an earlier snapshot back { publicationId, note? }: it is published again as a new snapshot and the drafts are set to it. → 201 { publication }. Errors: 400 invalid_publication_id | invalid_note | people_not_allowed { imageIds, allowed }; 404 publication_not_found; 409 already_current | image_retired { imageIds } | image_unpublished { imageIds } (a photo in that snapshot was unpublished after it).',
  onGuard: heroAdminGuard,
  onRequest: async (req, res) => send(res, await svc.rollback(req.body || {}, req.user.sub), 201),
};
