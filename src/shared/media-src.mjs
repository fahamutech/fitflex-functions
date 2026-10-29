// Image sources a partner (or a member, for their own photo) may store for the apps to show.
//
// Security fix 2026-10-28 (owner approval in chat the same day): the apps turn any string that is
// not a data URI into a network image (FFRemoteImage → NetworkImage), so a stored
// "https://tracker.example/x.png" made every member who opened that storefront, gym or trainer
// fetch a host of the partner's choosing (IP leak, tracking). Only two forms are accepted now:
//   (a) data:image/(png|jpeg|webp);base64,<data> — decoded size ≤ MEDIA_SRC_MAX_BYTES (default
//       1.4 MB, so the base64 form still fits BFAST_BODY_LIMIT's default 2 MB request body), the
//       bytes must fully decode as a PNG, JPEG or WebP raster (no SVG, GIF, TIFF, ...), ≤ 2048 px a side;
//   (b) our own root-relative storage path /storage/<cid>/<file>, as /storage/upload returns it:
//       both segments only [A-Za-z0-9._~-], never "." / "..", never a "%".
// Anything else (another host, http(s) at all, javascript:, file:, protocol-relative //x, SVG) →
// 400 invalid_media_src { field, index?, reason }.
//
// `kept`: values already stored IN THE SAME FIELD of the same record are accepted unchanged (the
// apps send the whole gallery back on every save; old rows may hold an admin-uploaded absolute
// storage URL or a sign-in provider photo). Callers pass kept per field, so an old value cannot
// move to another field (e.g. thumbnails → images, logo → banner) except where noted at the call.
// scripts/check-media-src.mjs lists stored values that would fail today (read-only).
//
// Sign-in provider photos (Firebase `picture`) are not partner input but end up in User.photoUrl
// and from there in trainer profiles: signInPhotoOrNull keeps only https on SIGNIN_PHOTO_HOSTS
// (default Google's lh3–lh6.googleusercontent.com) or our own storage path, and drops anything else.
import sharp from 'sharp';
import { createVendorLimiter } from './vendor-rate-limit.mjs';

export const MEDIA_SRC_ERROR = 'invalid_media_src';
export const MEDIA_DATA_TYPES = Object.freeze(['png', 'jpeg', 'webp']);
// 1.4 MB decoded ≈ 1.87 MB of base64: one image still fits a 2 MB JSON body (BFAST_BODY_LIMIT default).
export const DEFAULT_MEDIA_MAX_BYTES = 1_400_000;
// The apps send ≤ 1280 px and the portal ≤ 1280 px; 2048 leaves headroom without big decodes.
export const MEDIA_MAX_SIDE = 2048;
const STORAGE_PATH_MAX = 512;

/** Decoded-size cap for a data URI (MEDIA_SRC_MAX_BYTES, bytes; default 1.4 MB). */
export function mediaSrcMaxBytes(env = process.env) {
  const n = Number(env.MEDIA_SRC_MAX_BYTES);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MEDIA_MAX_BYTES;
}

const DATA_URI = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/;
const STORAGE_PATH = /^\/storage\/([A-Za-z0-9._~-]+)\/([A-Za-z0-9._~-]+)$/;
const DOT_SEGMENT = /^\.+$/;

/** The storage path form only: true for "/storage/<cid>/<file>". */
export function isStoragePath(value) {
  if (typeof value !== 'string' || value.length > STORAGE_PATH_MAX) return false;
  const m = value.match(STORAGE_PATH);
  if (!m) return false;
  return !DOT_SEGMENT.test(m[1]) && !DOT_SEGMENT.test(m[2]);
}

/**
 * Synchronous shape check. → null when the shape is fine (a data URI still needs the decode in
 * mediaSrcProblem), else a reason: not_a_string | empty | scheme_not_allowed |
 * data_type_not_allowed | invalid_base64 | too_large | invalid_storage_path.
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
    // limitInputPixels makes sharp refuse a bigger picture before it decodes any pixel.
    const image = sharp(bytes, { failOn: 'error', limitInputPixels: MEDIA_MAX_SIDE * MEDIA_MAX_SIDE, animated: false });
    const meta = await image.metadata();
    // The declared type may differ from the bytes (the app labels a picked file by its extension);
    // what matters is that the bytes are one of the three raster formats, never SVG or anything else.
    if (!MEDIA_DATA_TYPES.includes(meta.format)) return 'not_an_image';
    if (!(meta.width > 0 && meta.height > 0)) return 'not_an_image';
    if (meta.width > MEDIA_MAX_SIDE || meta.height > MEDIA_MAX_SIDE) return 'image_too_large';
    await image.stats(); // decodes every pixel: a truncated or corrupt image fails here
  } catch (e) {
    if (/pixel limit/i.test(String(e?.message))) return 'image_too_large';
    return 'not_an_image';
  }
  return null;
}

// Saves that make the server decode new images, per person (or account), in memory per server:
// 30 in 10 minutes. Over it → 429 rate_limited { retryAfterSeconds } and nothing is decoded or saved.
export const MEDIA_DECODE_RATE = Object.freeze({ perWindow: 30, windowMs: 10 * 60_000 });
const decodeLimiter = createVendorLimiter({ perMinute: MEDIA_DECODE_RATE.perWindow, windowMs: MEDIA_DECODE_RATE.windowMs });
export const resetMediaDecodeLimits = () => decodeLimiter.reset();

const listOf = raw => (raw === undefined || raw === null || raw === '' ? [] : Array.isArray(raw) ? raw : [raw]);

/**
 * Check every image field of one save.
 *   fields:   { [field]: string | string[] | null | undefined } (undefined/null/'' = not being set)
 *   kept:     { [field]: string[] } — values already stored in that field (accepted as is)
 *   maxItems: { [field]: n } — list length cap, checked before anything is decoded
 *   actor:    person / account id for the decode rate limit (no limit without one)
 * → null | { error: 'too_many_images', status: 400, field, max }
 *        | { error: 'rate_limited', status: 429, retryAfterSeconds }
 *        | { error: 'invalid_media_src', status: 400, field, index?, reason }
 */
export async function checkMediaFields(fields, { kept = {}, maxItems = {}, actor = null, maxBytes = mediaSrcMaxBytes() } = {}) {
  const entries = Object.entries(fields || {});
  for (const [field, raw] of entries) {
    const max = maxItems[field];
    if (max != null && listOf(raw).length > max) return { error: 'too_many_images', status: 400, field, max };
  }
  const keep = Object.fromEntries(Object.entries(kept || {}).map(([f, v]) => [f, new Set(storedMedia(v))]));
  const isKept = (field, value) => typeof value === 'string' && Boolean(keep[field]?.has(value));
  // Shape first (cheap, no decoding), then the rate limit, then the decodes.
  let decodes = false;
  for (const [field, raw] of entries) {
    const list = listOf(raw);
    for (let i = 0; i < list.length; i += 1) {
      if (isKept(field, list[i])) continue;
      const reason = mediaSrcShapeProblem(list[i], { maxBytes });
      if (reason) return { error: MEDIA_SRC_ERROR, status: 400, field, ...(Array.isArray(raw) ? { index: i } : {}), reason };
      if (list[i].startsWith('data:')) decodes = true;
    }
  }
  if (decodes && actor) {
    const allowed = decodeLimiter.allow(String(actor));
    if (!allowed.ok) return { error: 'rate_limited', status: 429, retryAfterSeconds: allowed.retryAfterSeconds };
  }
  for (const [field, raw] of entries) {
    const list = listOf(raw);
    for (let i = 0; i < list.length; i += 1) {
      if (isKept(field, list[i])) continue;
      const reason = await mediaSrcProblem(list[i], { maxBytes });
      if (reason) return { error: MEDIA_SRC_ERROR, status: 400, field, ...(Array.isArray(raw) ? { index: i } : {}), reason };
    }
  }
  return null;
}

/** Every non-empty string in these values (strings or lists), for one field's `kept` list. */
export function storedMedia(...values) {
  const out = [];
  for (const v of values) {
    if (typeof v === 'string') {
      if (v) out.push(v);
    } else if (Array.isArray(v) || v instanceof Set) {
      for (const x of v) {
        if (typeof x === 'string' && x) out.push(x);
      }
    }
  }
  return out;
}

// ── Sign-in provider photos ─────────────────────────────────────────────────

const DEFAULT_SIGNIN_PHOTO_HOSTS = ['lh3.googleusercontent.com', 'lh4.googleusercontent.com', 'lh5.googleusercontent.com', 'lh6.googleusercontent.com'];
/** SIGNIN_PHOTO_HOSTS (comma-separated, exact host names) or Google's photo hosts. */
export function signInPhotoHosts(env = process.env) {
  const configured = String(env.SIGNIN_PHOTO_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  return configured.length ? configured : DEFAULT_SIGNIN_PHOTO_HOSTS;
}

/**
 * A sign-in provider photo we may store and show, else null (dropped). Only
 * https://<allowed host>/<path> (no credentials, no port, ≤ 2048 characters) or our own storage path.
 */
export function signInPhotoOrNull(value, { hosts = signInPhotoHosts() } = {}) {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  if (isStoragePath(value)) return value;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return hosts.includes(url.hostname.toLowerCase()) ? value : null;
}

/**
 * Whether a photo copied between a person's own accounts (a new persona) may go along: an
 * allowed sign-in photo or a value of our media shape. Synchronous: data URIs are shape-checked
 * only, as they were fully checked when first saved.
 */
export function copyablePhotoOrNull(value) {
  if (signInPhotoOrNull(value)) return value;
  return typeof value === 'string' && mediaSrcShapeProblem(value) === null ? value : null;
}
