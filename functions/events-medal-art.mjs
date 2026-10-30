// Marathon & running events · S6 — organizer medal artwork (spec §7.7, §8.1, §8.2). SECURITY AREA. Every route answers 404 feature_disabled
// unless EVENTS_MODULE, EVENTS_REGISTRATION, EVENTS_RESULTS, EVENTS_REWARDS and EVENTS_MEDAL_ART are on.
//  - The upload is the RAW image body (not a data URI, not multipart, not JSON). The rights confirmation and the alt text travel in the
//    QUERY (?confirmationVersion=…&altEn=…&altSw=…). The body is read ONLY after the caps and the role checks, and only up to the size limit.
//  - No remote URL, imageUrl or storage path is accepted anywhere; a query or header of that name is ignored.
//  - Files are served only to signed-in people who may see them, as image/webp with nosniff; the master is never served.
import { randomUUID } from 'node:crypto';
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { requireActiveOrganizer, requireOpenOrganizer, organizerOf } from '../src/auth/events-authz.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsMedalArt } from '../src/shared/feature-flags.mjs';
import { eventsMedalArtService as svc } from '../src/bootstrap/services.mjs';
import { eventsMedalArtMaxBytes } from '../src/shared/events-config.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';

const created = new Date().toISOString();
const ORGANIZER_TYPES = ['event_organizer', 'organizer_staff'];
const previewLimiter = createVendorLimiter({ perMinute: 120 });
const adminPreviewLimiter = createVendorLimiter({ perMinute: 300 });
const serveLimiter = createVendorLimiter({ perMinute: 300 });
export const resetEventsMedalArtLimits = () => { previewLimiter.reset(); adminPreviewLimiter.reset(); serveLimiter.reset(); };
const base = '/organizer/events/:id';
const writers = method => routeGuard(method, [requireEventsMedalArt, requireAuth(...ORGANIZER_TYPES), requireActiveOrganizer('owner', 'admin')]);
const readers = method => routeGuard(method, [requireEventsMedalArt, requireAuth(...ORGANIZER_TYPES), requireOpenOrganizer('owner', 'admin', 'timing')]);
const admin = method => routeGuard(method, [requireEventsMedalArt, requireAuth('admin'), requireAcl('events')]);
const staffActor = req => ({ kind: 'staff', userId: req.user.sub, role: organizerOf(req).role, requestId: req.requestId });
const adminActor = req => ({ kind: 'admin', userId: req.user.sub, requestId: req.requestId });
const orgCtx = req => ({ actor: staffActor(req), organizerId: organizerOf(req).organizer.id, eventId: req.params.id, templateId: req.params.templateId });
const idemKey = req => req.headers?.['idempotency-key'];

function send(req, res, result, okStatus = 200) {
  res.set?.('X-Request-Id', req.requestId);
  if (result?.error) { const { error, status, ...extra } = result; if (extra.retryAfterSeconds) res.set?.('Retry-After', String(extra.retryAfterSeconds)); return res.status(status || 400).json({ error, ...extra }); }
  const { status, replayed, ...body } = result ?? {};
  if (replayed) res.set?.('Idempotent-Replayed', 'true');
  return res.status(Number.isInteger(status) ? status : okStatus).json(body);
}
const stamped = fn => async (req, res) => {
  req.requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  try { return await fn(req, res); } catch (err) { console.error(`[events-medal-art] ${req.requestId} ${err?.message}`); return res.status(500).json({ error: 'internal_error', requestId: req.requestId }); }
};

/** The raw request body up to `max` bytes. → { buffer } | { error }. Content-Length over the limit is refused before a byte is read. */
async function readRaw(req, max) {
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > max) return { error: 'payload_too_large', status: 413, maxBytes: max };
  if (Buffer.isBuffer(req.body)) return req.body.length > max ? { error: 'payload_too_large', status: 413, maxBytes: max } : { buffer: req.body };
  if (typeof req.on !== 'function') return { error: 'raw_body_required', status: 400 };
  const chunks = []; let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > max) { req.destroy?.(); return { error: 'payload_too_large', status: 413, maxBytes: max }; }
      chunks.push(chunk);
    }
  } catch { return { error: 'raw_body_required', status: 400 }; }
  return size ? { buffer: Buffer.concat(chunks) } : { error: 'no_file_provided', status: 400 };
}

const altOf = q => {
  const alt = {};
  if (typeof q?.altEn === 'string' && q.altEn) alt.en = q.altEn;
  if (typeof q?.altSw === 'string' && q.altSw) alt.sw = q.altSw;
  return alt;
};

async function upload(req, res, actor, ids) {
  const admission = await svc.admit({ actor, ...ids, key: idemKey(req) });
  if (admission.error) return send(req, res, admission);
  const raw = await readRaw(req, eventsMedalArtMaxBytes());
  if (raw.error) return send(req, res, raw);
  return send(req, res, await svc.store({ actor, admission, buffer: raw.buffer, confirmationVersion: req.query?.confirmationVersion, altText: altOf(req.query), key: idemKey(req) }), 201);
}

export const uploadMedalArt = {
  created, method: 'post', path: `${base}/medal-templates/:templateId/art`,
  description: 'Organizer owner / admin (EVENTS_MEDAL_ART; organizer active): upload this medal\'s own design. Header Idempotency-Key REQUIRED. The body is the RAW image (PNG, JPEG or WebP, ≤2 MB, 512–4000 px, square within 2 %, ≤16 MP; the type is read from the bytes, never from the Content-Type or file name; SVG, GIF, TIFF, HEIC, AVIF, PDF and animated images are refused). Query: confirmationVersion (REQUIRED, the current rights text), altEn?, altSw? (≤120). Caps are counted before the body is read: 5 a minute and 30 a day per person; 10 a minute, 60 attempts and 20 successful uploads a day per organizer. → 201 { art { id, templateId, eventId, status: live, revision, width, height, altText, source: custom, confirmedAt, createdAt } }. The design is live at once (show-now); EXIF, GPS, XMP and ICC are stripped; a client imageUrl is ignored. 400 svg_not_allowed | unsupported_file_type | animated_not_allowed | image_too_large | image_too_small | not_square { width, height } | corrupt_image | no_file_provided | raw_body_required | idempotency_key_required; 409 confirmation_outdated { current } | file_not_allowed (a taken-down file) | event_cancelled; 413 payload_too_large; 429 rate_limited { retryAfterSeconds }; 503 busy.',
  onGuard: writers('post'),
  onRequest: stamped(async (req, res) => upload(req, res, staffActor(req), { organizerId: organizerOf(req).organizer.id, eventId: req.params.id, templateId: req.params.templateId })),
};
export const patchMedalArt = {
  created, method: 'patch', path: `${base}/medal-templates/:templateId/art`,
  description: 'Organizer owner / admin (EVENTS_MEDAL_ART): change the alt text of the live design. Idempotency-Key REQUIRED. Body { altText: { en?, sw? } (≤120 each) } → { art }.',
  onGuard: writers('patch'),
  onRequest: stamped(async (req, res) => send(req, res, await svc.patchAlt({ ...orgCtx(req), key: idemKey(req), body: req.body || {} }))),
};
export const removeMedalArt = {
  created, method: 'delete', path: `${base}/medal-templates/:templateId/art`,
  description: 'Organizer owner / admin (EVENTS_MEDAL_ART): remove the custom design; the medal shows its built-in design again. The bytes are deleted. Idempotency-Key REQUIRED → { removed { artId } }.',
  onGuard: writers('delete'),
  onRequest: stamped(async (req, res) => send(req, res, await svc.remove({ ...orgCtx(req), key: idemKey(req) }))),
};
export const previewMedalArt = {
  created, method: 'get', path: `${base}/medal-templates/:templateId/art/preview`,
  description: 'Organizer owner / admin / timing (EVENTS_MEDAL_ART): the stored preview of the live design. ?w=240|480 (default 240) → image/webp, private, no resizing per request. 120 a minute per person.',
  onGuard: readers('get'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(previewLimiter, `p:${req.user.sub}`, res)) return undefined;
    const out = await svc.staffPreview({ ...orgCtx(req), width: req.query?.w });
    return out.error ? send(req, res, out) : sendImage(res, out.file, 'private, no-store');
  }),
};

function sendImage(res, file, cache) {
  res.set?.('Content-Type', 'image/webp');
  res.set?.('X-Content-Type-Options', 'nosniff');
  res.set?.('Content-Disposition', 'inline');
  res.set?.('Content-Security-Policy', "default-src 'none'");
  res.set?.('Cache-Control', cache);
  res.status(200);
  return typeof res.end === 'function' ? res.end(file.buffer) : res.send(file.buffer);
}

export const serveMedalArt = {
  created, method: 'get', path: '/events/medal-art/:artId/file',
  description: 'Signed in (EVENTS_MEDAL_ART): a medal design as image/webp. ?variant=m512|m256|m128 (default m512; the master is never served). Allowed: a member who holds or held a medal from that template, staff of the event\'s organizer, a FitFlex admin with the events scope. Everyone else, a signed-out caller, an unknown id and a removed or taken-down design get 404 (never 403): clients then show the built-in design from MedalAward.art.artKey. Headers: nosniff, inline, Content-Security-Policy default-src \'none\', Cache-Control private, max-age=86400.',
  onGuard: routeGuard('get', [requireEventsMedalArt, requireAuth()]),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(serveLimiter, `s:${req.user.sub}`, res)) return undefined;
    const { portalUser, aclPermissions } = req.user;
    const adminEvents = req.user.userType === 'admin' && (!portalUser || (Array.isArray(aclPermissions) && aclPermissions.includes('events')));
    const out = await svc.serve({ viewer: { userId: req.user.sub, userType: req.user.userType, adminEvents }, artId: req.params.artId, variant: req.query?.variant ?? 'm512' });
    return out.error ? res.status(404).json({ error: 'not_found' }) : sendImage(res, out.file, 'private, max-age=86400');
  }),
};

export const adminListMedalArt = {
  created, method: 'get', path: '/admin/medal-art',
  description: 'Admin (scope events; EVENTS_MEDAL_ART): the moderation queue. ?reviewState=to_review|reviewed&status (default live)&cursor&limit → { toReview, items [art + { eventTitle, organizerName, tier, categoryName, reviewState, confirmationVersion, organizerTakedowns30d, highlightOrganizer (3 or more in 30 days) }], nextCursor }.',
  onGuard: admin('get'),
  onRequest: stamped(async (req, res) => send(req, res, await svc.adminList({ query: req.query || {} }))),
};
export const adminPreviewMedalArt = {
  created, method: 'get', path: '/admin/medal-art/:id/preview',
  description: 'Admin (scope events; EVENTS_MEDAL_ART): the stored 240 / 480 preview (?w) as image/webp, private, no-store.',
  onGuard: admin('get'),
  onRequest: stamped(async (req, res) => {
    if (limitOrNull(adminPreviewLimiter, `a:${req.user.sub}`, res)) return undefined;
    const out = await svc.adminPreview({ id: req.params.id, width: req.query?.w });
    return out.error ? send(req, res, out) : sendImage(res, out.file, 'private, no-store');
  }),
};
export const adminReviewedMedalArt = {
  created, method: 'post', path: '/admin/medal-art/:id/reviewed',
  description: 'Admin (scope events; EVENTS_MEDAL_ART): "Looks fine" → { art }.',
  onGuard: admin('post'),
  onRequest: stamped(async (req, res) => send(req, res, await svc.markReviewed({ admin: req.user.sub, id: req.params.id }))),
};
export const adminTakeDownMedalArt = {
  created, method: 'post', path: '/admin/medal-art/:id/take-down',
  description: 'Admin (scope events; EVENTS_MEDAL_ART): take a design down. Body { reason: inappropriate | rights | other_brand | person_request | quality | other, note? (≤200; required for other) } → { art }. Final for that file: the bytes are deleted, its hashes are kept so the same file (or a re-saved copy) is refused (409 file_not_allowed), the medal reverts to its built-in design, awards are untouched, the organizer owners and admins get an essential bilingual notice.',
  onGuard: admin('post'),
  onRequest: stamped(async (req, res) => send(req, res, await svc.takeDown({ admin: req.user.sub, id: req.params.id, body: req.body || {} }))),
};
export const adminUploadMedalArt = {
  created, method: 'post', path: '/admin/events/:id/medal-templates/:templateId/art',
  description: 'Admin (scope events; EVENTS_MEDAL_ART): set a design for an organizer who asks (same raw body, query and checks as the organizer upload; stored as reviewed, with FitFlex\'s own confirmation version 2026-10-29.s6admin1). Idempotency-Key REQUIRED.',
  onGuard: admin('post'),
  onRequest: stamped(async (req, res) => upload(req, res, adminActor(req), { eventId: req.params.id, templateId: req.params.templateId })),
};
