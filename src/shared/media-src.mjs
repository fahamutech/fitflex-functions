// Image sources a partner (or a member, for their own photo) may store for the apps to show.
//
// Security fix 2026-10-29: the apps turn any string that is not a data URI into a network image
// (FFRemoteImage → NetworkImage), so a stored "https://tracker.example/x.png" made every member who
// opened that storefront, gym or trainer fetch a host of the partner's choosing (IP leak, tracking).
// Only two forms are accepted now:
//   (a) data:image/(png|jpeg|webp);base64,<data> — decoded size ≤ MEDIA_SRC_MAX_BYTES (default 2 MB),
//       the bytes must decode as a PNG, JPEG or WebP raster (no SVG, GIF, TIFF, ...), ≤ 4096 px a side;
//   (b) our own root-relative storage path /storage/<cid>/<file>, as /storage/upload returns it.
// Anything else (another host, http(s) at all, javascript:, file:, protocol-relative //x, SVG) →
// 400 invalid_media_src { field, index?, reason }.
//
// A value already stored on the same record is accepted unchanged (`kept`): the apps send the whole
// gallery back on every save, and old rows may hold an admin-uploaded absolute storage URL or a
// sign-in provider photo. That keeps every existing save working without letting a new host in;
// scripts/check-media-src.mjs lists stored values that would fail today (read-only).
import sharp from 'sharp';

export const MEDIA_SRC_ERROR = 'invalid_media_src';
export const MEDIA_DATA_TYPES = Object.freeze(['png', 'jpeg', 'webp']);
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const MEDIA_MAX_SIDE = 4096;
const STORAGE_PATH_MAX = 512;

/** Decoded-size cap for a data URI (MEDIA_SRC_MAX_BYTES, bytes; default 2 MB). */
export function mediaSrcMaxBytes(env = process.env) {
  const n = Number(env.MEDIA_SRC_MAX_BYTES);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

const DATA_URI = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/;
// Same shape as parseZebraResponse output; segments may not be "." / ".." or hold an encoded slash.
const STORAGE_PATH = /^\/storage\/([A-Za-z0-9._-]+)\/([^\s/?#\\<>"'`]+)$/;
const DOT_SEGMENT = /^\.+$/;
const ENCODED_SEPARATOR = /%(2f|5c)/i;

/** The storage path form only: true for "/storage/<cid>/<file>". */
export function isStoragePath(value) {
  if (typeof value !== 'string' || value.length > STORAGE_PATH_MAX) return false;
  const m = value.match(STORAGE_PATH);
  if (!m) return false;
  const [, cid, file] = m;
  return !DOT_SEGMENT.test(cid) && !DOT_SEGMENT.test(file) && !ENCODED_SEPARATOR.test(value);
}

/**
 * Synchronous shape check. → null when the shape is fine (a data URI still needs decodeProblem),
 * else a reason: not_a_string | empty | scheme_not_allowed | data_type_not_allowed | invalid_base64 |
 * too_large | invalid_storage_path.
 */
export function mediaSrcShapeProblem(value, { maxBytes = mediaSrcMaxBytes() } = {}) {
  if (typeof value !== 'string') return 'not_a_string';
  if (!value) return 'empty';
  if (value.startsWith('data:')) {
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(value)) return 'data_type_not_allowed';
    // Before decoding: base64 of maxBytes is at most 4·⌈maxBytes/3⌉ characters.
    const payloadLength = value.length - value.indexOf(',') - 1;
    if (payloadLength > 4 * Math.ceil(maxBytes / 3)) return 'too_large';
    const m = value.match(DATA_URI);
    if (!m || m[2].length % 4 !== 0 || !m[2].length) return 'invalid_base64';
    return null;
  }
  if (value.startsWith('/storage/')) return isStoragePath(value) ? null : 'invalid_storage_path';
  return 'scheme_not_allowed';
}

/** Full check of one value. → null when it may be stored, else a reason (see mediaSrcShapeProblem, plus not_an_image | image_too_large). */
export async function mediaSrcProblem(value, { maxBytes = mediaSrcMaxBytes() } = {}) {
  const shape = mediaSrcShapeProblem(value, { maxBytes });
  if (shape) return shape;
  if (!value.startsWith('data:')) return null;
  const bytes = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
  if (!bytes.length) return 'invalid_base64';
  if (bytes.length > maxBytes) return 'too_large';
  try {
    const image = sharp(bytes, { failOn: 'error', limitInputPixels: MEDIA_MAX_SIDE * MEDIA_MAX_SIDE, animated: false });
    const meta = await image.metadata();
    // The declared type may differ from the bytes (the app labels a picked file by its extension);
    // what matters is that the bytes are one of the three raster formats, never SVG or anything else.
    if (!MEDIA_DATA_TYPES.includes(meta.format)) return 'not_an_image';
    if (!(meta.width > 0 && meta.height > 0)) return 'not_an_image';
    if (meta.width > MEDIA_MAX_SIDE || meta.height > MEDIA_MAX_SIDE) return 'image_too_large';
    await image.stats(); // decodes every pixel: a truncated or corrupt image fails here
  } catch {
    return 'not_an_image';
  }
  return null;
}

/**
 * Check every image field of one save. `fields`: { [field]: string | string[] | null | undefined }
 * (undefined/null/'' = not being set). `kept`: values already stored on this record, accepted as is.
 * → null | { error: 'invalid_media_src', status: 400, field, index?, reason }
 */
export async function checkMediaFields(fields, { kept = [], maxBytes = mediaSrcMaxBytes() } = {}) {
  const keep = new Set((kept || []).filter(v => typeof v === 'string' && v));
  for (const [field, raw] of Object.entries(fields || {})) {
    if (raw === undefined || raw === null || raw === '') continue;
    const list = Array.isArray(raw) ? raw : [raw];
    for (let i = 0; i < list.length; i += 1) {
      const value = list[i];
      if (typeof value === 'string' && keep.has(value)) continue;
      const reason = await mediaSrcProblem(value, { maxBytes });
      if (reason) return { error: MEDIA_SRC_ERROR, status: 400, field, ...(Array.isArray(raw) ? { index: i } : {}), reason };
    }
  }
  return null;
}

/** Every string in these values (strings or lists), for building a `kept` set from a stored row. */
export function storedMedia(...values) {
  const out = [];
  for (const v of values) {
    if (typeof v === 'string' && v) out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x) out.push(x);
  }
  return out;
}
