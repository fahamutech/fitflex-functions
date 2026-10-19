// Image processing for admin-managed app photos (plan slice 4).
//
// Upload: the bytes must decode as a JPEG, PNG, WebP or HEIF/AVIF image of at most 50 MP and at
// least 1080 px wide (after rotation). The server keeps a cleaned master: rotated upright from its
// EXIF orientation, converted to sRGB and re-encoded, so EXIF, GPS, XMP and ICC metadata are gone.
// sharp drops metadata on output unless asked to keep it; this file never calls withMetadata /
// keepMetadata / keepExif.
//
// Publish: public variants are made from the master, each re-encoded the same way:
//   x2    1080 wide WebP, quality 72 stepping down to 50 until ≤ 150 KB (else variant_over_budget)
//   x1     540 wide WebP, same steps until ≤ 60 KB (else variant_over_budget)
//   wide  up to 1600 wide WebP, same steps aiming for ≤ 300 KB (best effort: desktop and portal)
//   avif  the wide size as AVIF (portal)
import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const HERO_LIMITS = Object.freeze({
  maxBytes: 15 * 1024 * 1024,
  maxPixels: 50_000_000,
  minWidth: 1080,
  // The master is never larger than this on its long edge: every variant is smaller still.
  masterMaxEdge: 2560,
  masterQuality: 90,
});

export const HERO_VARIANT_BUDGETS = Object.freeze({
  x2: { width: 1080, maxBytes: 150 * 1024, strict: true },
  x1: { width: 540, maxBytes: 60 * 1024, strict: true },
  wide: { width: 1600, maxBytes: 300 * 1024, strict: false },
});
export const HERO_QUALITY_STEPS = Object.freeze([72, 68, 64, 60, 56, 52, 50]);
const AVIF_QUALITY = 50;

// Spec §8.3: the text zone should average ≤ 0.20 relative luminance with no patch above 0.45.
export const TEXT_ZONE_LIMITS = Object.freeze({ mean: 0.20, patch: 0.45 });

const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif']);
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
export const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

// EXIF orientations 5–8 turn the picture a quarter: width and height swap once it is upright.
const uprightSize = ({ width, height, orientation }) => (orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height });
const open = buffer => sharp(buffer, { limitInputPixels: HERO_LIMITS.maxPixels, failOn: 'warning', animated: false });

/**
 * Check and clean an uploaded photo.
 * → { buffer, mimeType: 'image/webp', width, height, sha256, luminance } or { error, status }.
 */
export async function prepareHeroUpload(input) {
  if (!Buffer.isBuffer(input) || !input.length) return fail('no_file_provided', 400);
  if (input.length > HERO_LIMITS.maxBytes) return fail('file_too_large', 413, { maxBytes: HERO_LIMITS.maxBytes });
  let meta;
  try {
    // Reads the header only; the pixel limit is checked again when decoding.
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    return fail('unsupported_file_type', 400, { reason: 'not_an_image' });
  }
  if (!ACCEPTED_FORMATS.has(meta.format)) return fail('unsupported_file_type', 400, { reason: 'format_not_accepted' });
  if (!meta.width || !meta.height) return fail('unsupported_file_type', 400, { reason: 'not_an_image' });
  if (meta.width * meta.height > HERO_LIMITS.maxPixels) return fail('file_too_large', 413, { maxPixels: HERO_LIMITS.maxPixels });
  const upright = uprightSize(meta);
  if (upright.width < HERO_LIMITS.minWidth) return fail('image_too_small', 400, { minWidth: HERO_LIMITS.minWidth, width: upright.width });

  let buffer; let info;
  try {
    // Decoding every pixel is the real check that the file is an image (a damaged file fails here).
    ({ data: buffer, info } = await open(input)
      .rotate()
      .resize({ width: HERO_LIMITS.masterMaxEdge, height: HERO_LIMITS.masterMaxEdge, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .webp({ quality: HERO_LIMITS.masterQuality })
      .toBuffer({ resolveWithObject: true }));
  } catch {
    return fail('unsupported_file_type', 400, { reason: 'not_a_readable_image' });
  }
  return {
    buffer, mimeType: 'image/webp', width: info.width, height: info.height,
    sha256: sha256(buffer), luminance: await measureTextZones(buffer),
  };
}

// sRGB 8-bit → linear light, once.
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const round3 = n => Math.round(n * 1000) / 1000;
const SAMPLE_WIDTH = 160;
const PATCH = 16;

/**
 * Average relative luminance of the two text zones of the hero (spec §5 / crops table):
 * `vertical` = bottom 55% (full, compact, band), `horizontal` = left 50% (panel); with the
 * brightest 16×16 patch of a 160 px wide sample. Measured on the whole frame, before any crop.
 */
export async function measureTextZones(buffer) {
  const { data, info } = await sharp(buffer).resize({ width: SAMPLE_WIDTH }).removeAlpha().toColourspace('srgb')
    .raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const lum = new Float64Array(w * h);
  for (let i = 0, p = 0; i < lum.length; i += 1, p += channels) {
    lum[i] = 0.2126 * LINEAR[data[p]] + 0.7152 * LINEAR[data[p + 1]] + 0.0722 * LINEAR[data[p + 2]];
  }
  const zone = (x0, y0, x1, y1) => {
    let sum = 0; let maxPatch = 0;
    for (let py = y0; py < y1; py += PATCH) {
      for (let px = x0; px < x1; px += PATCH) {
        let s = 0; let n = 0;
        for (let y = py; y < Math.min(py + PATCH, y1); y += 1) for (let x = px; x < Math.min(px + PATCH, x1); x += 1) { s += lum[y * w + x]; n += 1; }
        sum += s;
        if (n) maxPatch = Math.max(maxPatch, s / n);
      }
    }
    const count = (x1 - x0) * (y1 - y0);
    return { mean: round3(count ? sum / count : 0), maxPatch: round3(maxPatch) };
  };
  return {
    vertical: zone(0, Math.floor(h * 0.45), w, h),
    horizontal: zone(0, 0, Math.ceil(w * 0.5), h),
  };
}

/** True when a zone is brighter than spec §8.3 asks (the app still reads it: the scrim guarantee holds). */
export const isBright = zone => Boolean(zone) && (zone.mean > TEXT_ZONE_LIMITS.mean || zone.maxPatch > TEXT_ZONE_LIMITS.patch);

async function stepWebp(master, { width, maxBytes, strict }) {
  let last = null;
  for (const quality of HERO_QUALITY_STEPS) {
    const { data, info } = await sharp(master).resize({ width, withoutEnlargement: true }).webp({ quality })
      .toBuffer({ resolveWithObject: true });
    last = { buffer: data, width: info.width, height: info.height, bytes: data.length, quality, mimeType: 'image/webp', ext: 'webp' };
    if (data.length <= maxBytes) return last;
  }
  return strict ? null : last;
}

/**
 * The public files of a published photo, from its cleaned master.
 * → { x2, x1, wide, avif } (each { buffer, width, height, bytes, quality, mimeType, ext }) or { error, status, variant }.
 */
export async function buildHeroVariants(master) {
  const out = {};
  for (const name of ['x2', 'x1', 'wide']) {
    const v = await stepWebp(master, HERO_VARIANT_BUDGETS[name]);
    if (!v) return fail('variant_over_budget', 422, { variant: name, maxBytes: HERO_VARIANT_BUDGETS[name].maxBytes });
    out[name] = v;
  }
  const { data, info } = await sharp(master).resize({ width: HERO_VARIANT_BUDGETS.wide.width, withoutEnlargement: true })
    .avif({ quality: AVIF_QUALITY, effort: 4 }).toBuffer({ resolveWithObject: true });
  out.avif = { buffer: data, width: info.width, height: info.height, bytes: data.length, quality: AVIF_QUALITY, mimeType: 'image/avif', ext: 'avif' };
  return out;
}
