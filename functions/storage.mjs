// Storage REST surface — proxies file uploads to the shared Zebra storage
// service (same infra used by smartstock-functions). Images are converted to
// WebP server-side before upload so the client never has to ship raw camera
// bytes, and gym/trainer records store a Zebra URL instead of base64.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { parseMultipartRequest, uploadToZebra, parseZebraResponse } from '../src/infra/storage-client.mjs';
import path from 'path';
import sharp from 'sharp';

const created = new Date().toISOString();
const ZEBRA_BASE_URL = process.env.ZEBRA_BASE_URL;

// Only images are accepted for now — no other file types (PDFs, docs, etc).
const FULL_MAX_DIMENSION = 1280;
const FULL_WEBP_QUALITY = 82;
const THUMB_MAX_DIMENSION = 320;
const THUMB_WEBP_QUALITY = 70;

const stripTrailingSlash = value => `${value ?? ''}`.replace(/\/+$/g, '');
const isImageMime = mime => `${mime ?? ''}`.toLowerCase().startsWith('image/');
const webpName = (filename, suffix = '') => {
  const clean = `${filename ?? 'image'}`.trim() || 'image';
  const ext = path.extname(clean);
  const base = ext ? clean.slice(0, -ext.length) : clean;
  return `${base}${suffix}.webp`;
};

/** Downscales + re-encodes as WebP. Skips re-encoding if already WebP and already within bounds. */
const toWebp = (buffer, maxDimension, quality) => sharp(buffer, { failOn: 'none', animated: true })
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
  description: 'Uploads a single image to the Zebra storage service. Requires authentication (Bearer token). Content-Type: multipart/form-data, field name "file". Only image files are accepted — any other file type is rejected with 400. The image is always normalized to WebP (converted if not already WebP) and a WebP thumbnail is generated server-side; both are uploaded to Zebra.',
  request: {
    headers: { 'Content-Type': 'multipart/form-data' },
    body: '(multipart form data with an image "file" field)'
  },
  responseSample: {
    cid: 'QmXyz...', filename: 'photo.webp', url: '/storage/QmXyz.../photo.webp',
    thumbnailCid: 'QmAbc...', thumbnailFilename: 'photo-thumb.webp', thumbnailUrl: '/storage/QmAbc.../photo-thumb.webp'
  },
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    if (!ZEBRA_BASE_URL) {
      return res.status(503).json({ error: 'storage_service_unavailable' });
    }
    try {
      const { files } = await parseMultipartRequest(req);
      if (!files.length) return res.status(400).json({ error: 'no_file_provided' });

      const file = files[0];
      if (!isImageMime(file.mimetype)) {
        return res.status(400).json({ error: 'unsupported_file_type', reason: 'Only image uploads are supported' });
      }

      const [fullBuffer, thumbBuffer] = await Promise.all([
        toWebp(file.buffer, FULL_MAX_DIMENSION, FULL_WEBP_QUALITY),
        toWebp(file.buffer, THUMB_MAX_DIMENSION, THUMB_WEBP_QUALITY)
      ]);

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
    if (!ZEBRA_BASE_URL) return res.status(503).json({ error: 'storage_service_unavailable' });
    const { cid, filename } = req.params || {};
    res.redirect(307, `${stripTrailingSlash(ZEBRA_BASE_URL)}/storage/${cid}/${filename}`);
  }
};
