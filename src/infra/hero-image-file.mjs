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
 * `limits` (optional) narrows the checks for another use of the same pipeline (shop banners:
 * ≤ 5 MB, JPEG/PNG/WebP, at least 1600 × 1000): { maxBytes, minWidth, minHeight, formats }.
 * The cleaning (rotate, sRGB, re-encode, no metadata) is always the same.
 * → { buffer, mimeType: 'image/webp', width, height, sha256, luminance } or { error, status }.
 */
export async function prepareHeroUpload(input, limits = {}) {
  const maxBytes = limits.maxBytes ?? HERO_LIMITS.maxBytes;
  const minWidth = limits.minWidth ?? HERO_LIMITS.minWidth;
  const minHeight = limits.minHeight ?? 0;
  const formats = limits.formats ? new Set(limits.formats) : ACCEPTED_FORMATS;
  if (!Buffer.isBuffer(input) || !input.length) return fail('no_file_provided', 400);
  if (input.length > maxBytes) return fail('file_too_large', 413, { maxBytes });
  let meta;
  try {
    // Reads the header only; the pixel limit is checked again when decoding.
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    return fail('unsupported_file_type', 400, { reason: 'not_an_image' });
  }
  if (!formats.has(meta.format)) return fail('unsupported_file_type', 400, { reason: 'format_not_accepted' });
  if (!meta.width || !meta.height) return fail('unsupported_file_type', 400, { reason: 'not_an_image' });
  if (meta.width * meta.height > HERO_LIMITS.maxPixels) return fail('file_too_large', 413, { maxPixels: HERO_LIMITS.maxPixels });
  const upright = uprightSize(meta);
  if (upright.width < minWidth || upright.height < minHeight) {
    return fail('image_too_small', 400, { minWidth, ...(minHeight ? { minHeight, height: upright.height } : {}), width: upright.width });
  }

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

/** A smaller copy of the master for admin previews (WebP q75, no metadata, never enlarged). */
export const previewAt = (master, width) => sharp(master).resize({ width, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();

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

// ── Partner hero photo and logo (PARTNER_MEDIA; plan partner-hero-media-plan.md) ─────────────
//
// The same cleaning as above (rotate upright, sRGB, re-encode, no metadata). Partner photos get
// only the x2 / x1 band files; logos keep their transparency and get 256 / 128 px files.

/** True when the bytes look like SVG (or any XML), which is never accepted: it can carry scripts and links. */
export function looksLikeSvg(input) {
  if (!Buffer.isBuffer(input) || !input.length) return false;
  const head = input.subarray(0, 2048).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  return head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!doctype svg') || /<svg[\s>]/.test(head);
}

/** The band files of a cleaned partner photo: { x2, x1 } or { error: variant_over_budget, status: 422, variant, maxBytes }. */
export async function buildPartnerHeroVariants(master) {
  const out = {};
  for (const name of ['x2', 'x1']) {
    const v = await stepWebp(master, HERO_VARIANT_BUDGETS[name]);
    if (!v) return fail('variant_over_budget', 422, { variant: name, maxBytes: HERO_VARIANT_BUDGETS[name].maxBytes });
    out[name] = v;
  }
  return out;
}

export const LOGO_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxSide: 4000,
  minSide: 256,
  masterMaxEdge: 1024,
  masterQuality: 90,
});
export const LOGO_VARIANT_BUDGETS = Object.freeze({
  logo256: { size: 256, maxBytes: 40 * 1024 },
  logo128: { size: 128, maxBytes: 40 * 1024 },
});
const LOGO_FORMATS = new Set(['png', 'jpeg', 'webp']);
// Spec §40.2: "auto" picks the dark plate when the logo's opaque pixels average above this.
export const LOGO_DARK_PLATE_ABOVE = 0.6;

/**
 * Check and clean an uploaded logo: PNG, JPEG or WebP (never SVG), ≤ 2 MB, ≤ 4000 × 4000, ≥ 256 px
 * on the short side once upright. Transparency is kept.
 * → { buffer, mimeType, width, height, sha256, luminance, plateAuto } or { error, status }.
 */
export async function prepareLogoUpload(input, limits = {}) {
  const maxBytes = limits.maxBytes ?? LOGO_LIMITS.maxBytes;
  const minSide = limits.minSide ?? LOGO_LIMITS.minSide;
  const maxSide = limits.maxSide ?? LOGO_LIMITS.maxSide;
  if (!Buffer.isBuffer(input) || !input.length) return fail('no_file_provided', 400);
  if (input.length > maxBytes) return fail('file_too_large', 413, { maxBytes });
  if (looksLikeSvg(input)) return fail('svg_not_allowed', 400);
  let meta;
  try {
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    return fail('unsupported_file_type', 400, { reason: 'not_an_image' });
  }
  if (meta.format === 'svg') return fail('svg_not_allowed', 400);
  if (!LOGO_FORMATS.has(meta.format)) return fail('unsupported_file_type', 400, { reason: 'format_not_accepted' });
  if (!meta.width || !meta.height) return fail('unsupported_file_type', 400, { reason: 'not_an_image' });
  if (meta.width > maxSide || meta.height > maxSide) return fail('file_too_large', 413, { maxSide });
  const upright = uprightSize(meta);
  if (Math.min(upright.width, upright.height) < minSide) {
    return fail('image_too_small', 400, { minSide, width: upright.width, height: upright.height });
  }
  let buffer; let info;
  try {
    ({ data: buffer, info } = await sharp(input, { limitInputPixels: maxSide * maxSide, failOn: 'warning', animated: false })
      .rotate()
      .resize({ width: LOGO_LIMITS.masterMaxEdge, height: LOGO_LIMITS.masterMaxEdge, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .webp({ quality: LOGO_LIMITS.masterQuality, alphaQuality: 100 })
      .toBuffer({ resolveWithObject: true }));
  } catch {
    return fail('unsupported_file_type', 400, { reason: 'not_a_readable_image' });
  }
  const luminance = await logoLuminance(buffer);
  return {
    buffer, mimeType: 'image/webp', width: info.width, height: info.height, sha256: sha256(buffer),
    luminance, plateAuto: plateFor(luminance),
  };
}

/** The plate tone "auto" resolves to for a logo of this luminance (spec §40.2). */
export const plateFor = luminance => (Number(luminance) > LOGO_DARK_PLATE_ABOVE ? 'dark' : 'light');

/**
 * Alpha-weighted mean relative luminance of a logo's pixels (0 = black, 1 = white). Transparent
 * pixels do not count; a fully transparent image measures 0 (light plate).
 */
export async function logoLuminance(buffer) {
  const { data, info } = await sharp(buffer).resize({ width: 128, height: 128, fit: 'inside' }).ensureAlpha().toColourspace('srgb')
    .raw().toBuffer({ resolveWithObject: true });
  const { channels } = info;
  let sum = 0; let weight = 0;
  for (let p = 0; p < data.length; p += channels) {
    const a = data[p + 3] / 255;
    if (!a) continue;
    sum += a * (0.2126 * LINEAR[data[p]] + 0.7152 * LINEAR[data[p + 1]] + 0.0722 * LINEAR[data[p + 2]]);
    weight += a;
  }
  return round3(weight ? sum / weight : 0);
}

/** The logo files: { logo256, logo128 } (fit inside, alpha kept, each ≤ 40 KB) or { error: variant_over_budget }. */
export async function buildLogoVariants(master) {
  const out = {};
  for (const [name, { size, maxBytes }] of Object.entries(LOGO_VARIANT_BUDGETS)) {
    let made = null;
    for (const quality of [90, ...HERO_QUALITY_STEPS]) {
      const { data, info } = await sharp(master).resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .webp({ quality, alphaQuality: 90 }).toBuffer({ resolveWithObject: true });
      if (data.length <= maxBytes) { made = { buffer: data, width: info.width, height: info.height, bytes: data.length, quality, mimeType: 'image/webp', ext: 'webp' }; break; }
    }
    if (!made) return fail('variant_over_budget', 422, { variant: name, maxBytes });
    out[name] = made;
  }
  return out;
}

// ISO-BMFF brands of HEIF and AVIF stills and sequences (the 4 bytes after "ftyp").
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

/**
 * The image type the first bytes declare, before any decoder sees the file (security review L7):
 * 'jpeg' | 'png' | 'webp' | 'heif' | 'avif', or null for anything else (GIF, TIFF, BMP, SVG, text…).
 */
export function sniffImageType(input) {
  if (!Buffer.isBuffer(input) || input.length < 12) return null;
  if (input[0] === 0xFF && input[1] === 0xD8 && input[2] === 0xFF) return 'jpeg';
  if (input.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png';
  if (input.toString('latin1', 0, 4) === 'RIFF' && input.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (input.toString('latin1', 4, 8) === 'ftyp') {
    const brand = input.toString('latin1', 8, 12);
    if (AVIF_BRANDS.has(brand)) return 'avif';
    if (HEIF_BRANDS.has(brand)) return 'heif';
  }
  return null;
}

/** sha256 of the decoded pixels (with their size) of a cleaned image: the same picture re-saved with other metadata hashes the same. */
export async function pixelSha256(cleaned) {
  const { data, info } = await sharp(cleaned).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return createHash('sha256').update(`${info.width}x${info.height}x${info.channels}:`).update(data).digest('hex');
}
