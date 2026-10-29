// Storage REST surface — proxies file uploads to the shared Zebra storage
// service (same infra used by smartstock-functions). Images are converted to
// WebP server-side before upload so the client never has to ship raw camera
// bytes, and gym/trainer records store a Zebra URL instead of base64.
import '../src/bootstrap/init.mjs';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { parseMultipartRequest, uploadToZebra, parseZebraResponse } from '../src/infra/storage-client.mjs';
import { auditLog, users } from '../src/bootstrap/collections.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { createVendorLimiter } from '../src/shared/vendor-rate-limit.mjs';
import path from 'path';
import sharp from 'sharp';

const created = new Date().toISOString();
// Read per request (not at import), so the storage address can be set after the module loads.
const zebraBaseUrl = () => process.env.ZEBRA_BASE_URL;

// Only images are accepted for now — no other file types (PDFs, docs, etc).
const FULL_MAX_DIMENSION = 1280;
const FULL_WEBP_QUALITY = 82;
const THUMB_MAX_DIMENSION = 320;
const THUMB_WEBP_QUALITY = 70;
// An upload is read into memory: bounded, so one request cannot exhaust the server.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Security fix 2026-10-28 (owner approval in chat the same day). Every file stored here gets a
// permanent public address that cannot be deleted, so only the accounts that have a reason to
// publish an image may upload:
//   - FitFlex staff (admin): gym, owner and trainer photos in the portal;
//   - partners and their staff: gym owners, trainers, vendors (the apps send photos inline today;
//     kept so a later app build can move to uploads without a server change);
//   - event organizers and their staff: event, route and sponsor images (portal event wizard);
//   - company HR (corporate_hr), and any account holding an active BILLING seat (role owner, admin,
//     finance or hr, or an explicit billing.pay grant) in an ACTIVE or PENDING B2B organisation
//     (owner decision 2026-10-29: a pending organisation pays before activation): proof of payment
//     on the portal's "Pay" tab. Suspended and inactive organisations are refused.
// Anyone else (a plain member, gym_staff, a viewer/analyst/manager seat) → 403 upload_forbidden.
export const UPLOAD_ROLES = Object.freeze([
  'admin', 'gym_operator', 'gym_owner', 'trainer', 'vendor', 'vendor_staff',
  'event_organizer', 'organizer_staff', 'corporate_hr',
]);
export const UPLOAD_SEAT_ROLES = Object.freeze(['owner', 'admin', 'finance', 'hr']);
// Organisation statuses whose billing seats may upload proof of payment (not suspended/inactive).
export const UPLOAD_ORG_STATUSES = Object.freeze(['active', 'pending']);
// Formats the bytes may be in (checked on the decoded file, not the declared type). No SVG, TIFF,
// PDF or other formats sharp could otherwise read. Everything is re-encoded to WebP anyway.
export const UPLOAD_FORMATS = Object.freeze(['jpeg', 'png', 'webp', 'gif', 'heif', 'avif']);
// A decompression bomb guard: far above any phone photo the portal sends (it downsizes to 1280 px).
const MAX_INPUT_PIXELS = 100_000_000;
// Per PERSON (all their accounts together), in memory per server: 20 a minute and 200 a day (the
// portal's gym form sends ≤ 8 at once). Checked before the role / seat lookup.
export const UPLOAD_RATE_LIMITS = Object.freeze({ perMinute: 20, perDay: 200 });
const minuteLimiter = createVendorLimiter({ perMinute: UPLOAD_RATE_LIMITS.perMinute });
const dayLimiter = createVendorLimiter({ perMinute: UPLOAD_RATE_LIMITS.perDay, windowMs: 86_400_000 });
// Refused uploads are audited, at most 10 rows a minute per person, so a flood cannot fill the log.
const refusalAuditLimiter = createVendorLimiter({ perMinute: 10 });
export const resetStorageUploadLimits = () => { minuteLimiter.reset(); dayLimiter.reset(); refusalAuditLimiter.reset(); };

/** The person behind an account (one key for all their personas); the account id when there is none. */
async function personKeyOf(userId) {
  const row = userId ? await users.findByIdAsync(userId) : null;
  return row?.personId ? `person:${row.personId}` : `user:${userId}`;
}

async function hasBillingSeat(userId) {
  if (!userId) return false;
  const seats = await db('B2BOrganizationUser as ou')
    .join('B2BOrganization as o', 'o.id', 'ou.organizationId')
    .where({ 'ou.userId': userId, 'ou.status': 'active' })
    .whereIn('o.status', UPLOAD_ORG_STATUSES)
    .select('ou.role', 'ou.permissions');
  return seats.some(seat => UPLOAD_SEAT_ROLES.includes(seat.role)
    || (Array.isArray(seat.permissions) && seat.permissions.includes('billing.pay')));
}

/** An allowed account type, or an active billing seat in an active or pending organisation. */
export async function mayUpload(claims) {
  if (UPLOAD_ROLES.includes(claims?.userType)) return true;
  return hasBillingSeat(claims?.sub);
}

/** One audit row for a refused upload: who, why, how big. Never the file, its name or its contents. */
async function auditRefusal(req, status, error, extra = {}) {
  const key = req.uploadPersonKey || `user:${req.user?.sub}`;
  if (!refusalAuditLimiter.allow(key).ok) return;
  try {
    await auditLog.insertAsync({
      id: randomUUID(), at: new Date().toISOString(), actor: req.user?.sub ?? null, action: 'storage_upload_refused',
      target: '/storage/upload', before: null, after: { status, error, userType: req.user?.userType ?? null, ...extra },
    });
  } catch (e) {
    console.error('[storage] refusal audit failed:', e?.message || e);
  }
}
const refuse = async (req, res, status, body, extra) => {
  await auditRefusal(req, status, body.error, extra);
  return res.status(status).json(body);
};

// After requireAuth: rate limit (per person) first, then who may upload.
const uploadGate = async (req, res, next) => {
  try {
    req.uploadPersonKey = await personKeyOf(req.user.sub);
    for (const limiter of [minuteLimiter, dayLimiter]) {
      const allowed = limiter.allow(req.uploadPersonKey);
      if (!allowed.ok) {
        res.set?.('Retry-After', String(allowed.retryAfterSeconds));
        return refuse(req, res, 429, { error: 'rate_limited', retryAfterSeconds: allowed.retryAfterSeconds });
      }
    }
    if (await mayUpload(req.user)) return next();
  } catch (e) {
    console.error('[storage] uploader check failed:', e?.message || e);
    return res.status(503).json({ error: 'storage_service_unavailable' });
  }
  return refuse(req, res, 403, { error: 'upload_forbidden' });
};

const stripTrailingSlash = value => `${value ?? ''}`.replace(/\/+$/g, '');
const isImageMime = mime => `${mime ?? ''}`.toLowerCase().startsWith('image/');
const webpName = (filename, suffix = '') => {
  const clean = `${filename ?? 'image'}`.trim() || 'image';
  const ext = path.extname(clean);
  const base = ext ? clean.slice(0, -ext.length) : clean;
  return `${base}${suffix}.webp`;
};

/** Downscales + re-encodes as WebP. Skips re-encoding if already WebP and already within bounds. */
const toWebp = (buffer, maxDimension, quality) => sharp(buffer, { failOn: 'none', animated: true, limitInputPixels: MAX_INPUT_PIXELS })
  .rotate()
  .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
  .webp({ quality })
  .toBuffer();

// NOTE: this path must NOT be a prefix of getStorageFile's path below —
// bfast-function registers onGuard via `expressApp.use(path, guard)`, which
// matches every sub-path under that prefix (all HTTP methods), so guarding
// '/storage' here would also lock down the public '/storage/:cid/:filename'
// redirect route.
export const uploadStorageFile = {
  created, method: 'post', path: '/storage/upload',
  description: 'Uploads a single image to the Zebra storage service. Content-Type: multipart/form-data, field name "file". Who (security fix 2026-10-28): admin, gym_operator, gym_owner, trainer, vendor, vendor_staff, event_organizer, organizer_staff, corporate_hr, or any account with an active billing seat (role owner, admin, finance or hr, or a billing.pay grant) in an active or pending B2B organisation (suspended/inactive organisations refused); anyone else (e.g. a plain member) → 403 upload_forbidden. The file must be ≤ 10 MB (413 file_too_large { maxBytes }) and its bytes must decode as JPEG, PNG, WebP, GIF, HEIF or AVIF (≤ 100 MP) — SVG, TIFF, PDF and anything else → 400 unsupported_file_type. 20 a minute and 200 a day per person, across all their accounts, checked first (429 rate_limited { retryAfterSeconds } + Retry-After). Every upload is written to the audit log (action storage_upload); refused ones (403/400/413/429) as storage_upload_refused, without the file. Storage failures answer 502 storage_upload_failed / 504 storage_upload_timed_out with no upstream detail. The image is always normalized to WebP and a WebP thumbnail is generated server-side; both are uploaded to Zebra. The address returned is public and permanent.',
  request: {
    headers: { 'Content-Type': 'multipart/form-data' },
    body: '(multipart form data with an image "file" field)'
  },
  responseSample: {
    cid: 'QmXyz...', filename: 'photo.webp', url: '/storage/QmXyz.../photo.webp',
    thumbnailCid: 'QmAbc...', thumbnailFilename: 'photo-thumb.webp', thumbnailUrl: '/storage/QmAbc.../photo-thumb.webp'
  },
  onGuard: routeGuard('post', [requireAuth(), uploadGate]),
  onRequest: async (req, res) => {
    if (!zebraBaseUrl()) {
      return res.status(503).json({ error: 'storage_service_unavailable' });
    }
    try {
      const { files } = await parseMultipartRequest(req, { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, parts: 12 });
      if (!files.length) return refuse(req, res, 400, { error: 'no_file_provided' });

      const file = files[0];
      const sizeOf = { bytes: file.buffer.length, declaredType: String(file.mimetype || '').slice(0, 100) };
      if (file.truncated) return refuse(req, res, 413, { error: 'file_too_large', maxBytes: MAX_UPLOAD_BYTES }, sizeOf);
      if (!isImageMime(file.mimetype)) {
        return refuse(req, res, 400, { error: 'unsupported_file_type', reason: 'Only image uploads are supported' }, sizeOf);
      }

      // The declared type is the client's word; the bytes must actually decode as an allowed image.
      let format;
      try {
        ({ format } = await sharp(file.buffer, { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS }).metadata());
      } catch {
        format = null;
      }
      if (!UPLOAD_FORMATS.includes(format)) {
        return refuse(req, res, 400, { error: 'unsupported_file_type', reason: 'Only JPEG, PNG, WebP, GIF, HEIF or AVIF images are supported' }, { ...sizeOf, format: format ?? null });
      }
      let fullBuffer; let thumbBuffer;
      try {
        [fullBuffer, thumbBuffer] = await Promise.all([
          toWebp(file.buffer, FULL_MAX_DIMENSION, FULL_WEBP_QUALITY),
          toWebp(file.buffer, THUMB_MAX_DIMENSION, THUMB_WEBP_QUALITY)
        ]);
      } catch {
        return refuse(req, res, 400, { error: 'unsupported_file_type', reason: 'The file is not a readable image' }, { ...sizeOf, format });
      }

      const [fullResponse, thumbResponse] = await Promise.all([
        uploadToZebra(fullBuffer, webpName(file.filename), 'image/webp'),
        uploadToZebra(thumbBuffer, webpName(file.filename, '-thumb'), 'image/webp')
      ]);

      // The storage service's own answer is logged, never passed on to the caller.
      for (const r of [fullResponse, thumbResponse]) {
        if (r.status < 200 || r.status >= 300) {
          console.error('[storage] storage service answered', r.status);
          return res.status(502).json({ error: 'storage_upload_failed' });
        }
      }

      const full = parseZebraResponse(fullResponse.data);
      const thumb = parseZebraResponse(thumbResponse.data);
      if (!full || !thumb) {
        return res.status(502).json({ error: 'storage_upload_failed', reason: 'no_url_in_storage_response' });
      }

      // Public and permanent: who published what is kept. A failed audit write never loses the upload.
      try {
        await auditLog.insertAsync({
          id: randomUUID(), at: new Date().toISOString(), actor: req.user.sub, action: 'storage_upload',
          target: full.url, before: null,
          after: { url: full.url, thumbnailUrl: thumb.url, userType: req.user.userType ?? null, format, bytes: file.buffer.length, storedBytes: fullBuffer.length },
        });
      } catch (e) {
        console.error('[storage] audit write failed:', e?.message || e);
      }

      res.json({
        cid: full.cid, filename: full.filename, url: full.url,
        thumbnailCid: thumb.cid, thumbnailFilename: thumb.filename, thumbnailUrl: thumb.url
      });
    } catch (e) {
      const code = `${e?.code ?? ''}`;
      const timedOut = ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET'].includes(code);
      console.error('[storage] upload failed:', e?.message || e);
      // No raw error text to the caller (it can name internal hosts); it is in the server log.
      res.status(timedOut ? 504 : 502).json({ error: timedOut ? 'storage_upload_timed_out' : 'storage_upload_failed' });
    }
  }
};

export const getStorageFile = {
  created, method: 'get', path: '/storage/:cid/:filename',
  description: 'Redirects to the underlying Zebra storage URL for a stored file by content ID (CID) and filename. Public — no authentication required (images are served directly to end users).',
  request: { params: { cid: 'QmXyz...', filename: 'photo.webp' } },
  responseSample: '307 redirect to the Zebra storage URL',
  onRequest: (req, res) => {
    if (!zebraBaseUrl()) return res.status(503).json({ error: 'storage_service_unavailable' });
    const { cid, filename } = req.params || {};
    res.redirect(307, `${stripTrailingSlash(zebraBaseUrl())}/storage/${encodeURIComponent(cid)}/${encodeURIComponent(filename)}`);
  }
};
