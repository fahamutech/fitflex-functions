// Storage REST surface — proxies file uploads to the shared Zebra storage
// service (same infra used by smartstock-functions). Images are converted to
// WebP server-side before upload so the client never has to ship raw camera
// bytes, and gym/trainer records store a Zebra URL instead of base64.
import '../src/bootstrap/init.mjs';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { parseMultipartRequest, uploadToZebra, parseZebraResponse } from '../src/infra/storage-client.mjs';
import { auditLog, b2bOrganizationUsers } from '../src/bootstrap/collections.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';
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

// Security fix 2026-10-29. Every file stored here gets a permanent public address that cannot be
// deleted, so only the accounts that have a reason to publish an image may upload:
//   - FitFlex staff (admin): gym, owner and trainer photos in the portal;
//   - partners and their staff: gym owners, trainers, vendors (the apps send photos inline today;
//     kept so a later app build can move to uploads without a server change);
//   - event organizers and their staff: event, route and sponsor images (portal event wizard);
//   - company HR (corporate_hr) and anyone holding an ACTIVE seat in a B2B organisation (any account
//     type, members included): proof of payment on the portal's "Pay" tab.
// A plain member, gym_staff without an organisation seat, or anyone else → 403 upload_forbidden.
export const UPLOAD_ROLES = Object.freeze([
  'admin', 'gym_operator', 'gym_owner', 'trainer', 'vendor', 'vendor_staff',
  'event_organizer', 'organizer_staff', 'corporate_hr',
]);
// Formats the bytes may be in (checked on the decoded file, not the declared type). No SVG, TIFF,
// PDF or other formats sharp could otherwise read. Everything is re-encoded to WebP anyway.
export const UPLOAD_FORMATS = Object.freeze(['jpeg', 'png', 'webp', 'gif', 'heif', 'avif']);
// A decompression bomb guard: far above any phone photo the portal sends (it downsizes to 1280 px).
const MAX_INPUT_PIXELS = 100_000_000;
// Per user, in memory per server: 20 a minute and 200 a day (the portal's gym form sends ≤ 8 at once).
export const UPLOAD_RATE_LIMITS = Object.freeze({ perMinute: 20, perDay: 200 });
const minuteLimiter = createVendorLimiter({ perMinute: UPLOAD_RATE_LIMITS.perMinute });
const dayLimiter = createVendorLimiter({ perMinute: UPLOAD_RATE_LIMITS.perDay, windowMs: 86_400_000 });
export const resetStorageUploadLimits = () => { minuteLimiter.reset(); dayLimiter.reset(); };

async function hasActiveOrganizationSeat(userId) {
  if (!userId) return false;
  const seats = await b2bOrganizationUsers.filterByColumnAsync('userId', userId);
  return seats.some(seat => seat.status === 'active');
}

/** Guard after requireAuth: an allowed account type, or an active B2B organisation seat. */
export async function mayUpload(claims) {
  if (UPLOAD_ROLES.includes(claims?.userType)) return true;
  return hasActiveOrganizationSeat(claims?.sub);
}

const requireUploader = async (req, res, next) => {
  try {
    if (await mayUpload(req.user)) return next();
  } catch (e) {
    console.error('[storage] uploader check failed:', e?.message || e);
    return res.status(503).json({ error: 'storage_service_unavailable' });
  }
  return res.status(403).json({ error: 'upload_forbidden' });
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
  description: 'Uploads a single image to the Zebra storage service. Content-Type: multipart/form-data, field name "file". Who (security fix 2026-10-29): admin, gym_operator, gym_owner, trainer, vendor, vendor_staff, event_organizer, organizer_staff, corporate_hr, or any account with an active B2B organisation seat; anyone else (e.g. a plain member) → 403 upload_forbidden. The file must be ≤ 10 MB (413 file_too_large { maxBytes }) and its bytes must decode as JPEG, PNG, WebP, GIF, HEIF or AVIF (≤ 100 MP) — SVG, TIFF, PDF and anything else → 400 unsupported_file_type. 20 a minute and 200 a day per user (429 rate_limited { retryAfterSeconds } + Retry-After). Every upload is written to the audit log (action storage_upload). The image is always normalized to WebP and a WebP thumbnail is generated server-side; both are uploaded to Zebra. The address returned is public and permanent.',
  request: {
    headers: { 'Content-Type': 'multipart/form-data' },
    body: '(multipart form data with an image "file" field)'
  },
  responseSample: {
    cid: 'QmXyz...', filename: 'photo.webp', url: '/storage/QmXyz.../photo.webp',
    thumbnailCid: 'QmAbc...', thumbnailFilename: 'photo-thumb.webp', thumbnailUrl: '/storage/QmAbc.../photo-thumb.webp'
  },
  onGuard: routeGuard('post', [requireAuth(), requireUploader]),
  onRequest: async (req, res) => {
    if (!zebraBaseUrl()) {
      return res.status(503).json({ error: 'storage_service_unavailable' });
    }
    if (limitOrNull(minuteLimiter, req.user.sub, res)) return undefined;
    if (limitOrNull(dayLimiter, req.user.sub, res)) return undefined;
    try {
      const { files } = await parseMultipartRequest(req, { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, parts: 12 });
      if (!files.length) return res.status(400).json({ error: 'no_file_provided' });

      const file = files[0];
      if (file.truncated) return res.status(413).json({ error: 'file_too_large', maxBytes: MAX_UPLOAD_BYTES });
      if (!isImageMime(file.mimetype)) {
        return res.status(400).json({ error: 'unsupported_file_type', reason: 'Only image uploads are supported' });
      }

      // The declared type is the client's word; the bytes must actually decode as an allowed image.
      let format;
      try {
        ({ format } = await sharp(file.buffer, { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS }).metadata());
      } catch {
        format = null;
      }
      if (!UPLOAD_FORMATS.includes(format)) {
        return res.status(400).json({ error: 'unsupported_file_type', reason: 'Only JPEG, PNG, WebP, GIF, HEIF or AVIF images are supported' });
      }
      let fullBuffer; let thumbBuffer;
      try {
        [fullBuffer, thumbBuffer] = await Promise.all([
          toWebp(file.buffer, FULL_MAX_DIMENSION, FULL_WEBP_QUALITY),
          toWebp(file.buffer, THUMB_MAX_DIMENSION, THUMB_WEBP_QUALITY)
        ]);
      } catch {
        return res.status(400).json({ error: 'unsupported_file_type', reason: 'The file is not a readable image' });
      }

      const [fullResponse, thumbResponse] = await Promise.all([
        uploadToZebra(fullBuffer, webpName(file.filename), 'image/webp'),
        uploadToZebra(thumbBuffer, webpName(file.filename, '-thumb'), 'image/webp')
      ]);

      if (fullResponse.status < 200 || fullResponse.status >= 300) {
        return res.status(fullResponse.status).send(fullResponse.data);
      }
      if (thumbResponse.status < 200 || thumbResponse.status >= 300) {
        return res.status(thumbResponse.status).send(thumbResponse.data);
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
      res.status(timedOut ? 504 : 502).json({
        error: timedOut ? 'storage_upload_timed_out' : 'storage_upload_failed',
        reason: `${e?.message ?? e ?? ''}`
      });
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
