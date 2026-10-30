// Marathon & running events · S6 — organizer medal artwork: the upload pipeline (spec §7.7, D54). Built on the partner-media helpers
// (looksLikeSvg, sniffImageType, pixelSha256, the quality steps) which are imported, not modified; the checks and their ORDER are:
//   size → SVG → type from the BYTES → animated → pixel / side limits → minimum side and square → decode & clean.
// The declared Content-Type and file name are never consulted. The cleaned master is rotated upright, converted to sRGB and re-encoded
// as WebP (alpha kept); EXIF, GPS, XMP and ICC are gone because this file never asks sharp to keep metadata.
import sharp from 'sharp';
import { looksLikeSvg, sniffImageType, pixelSha256, sha256, HERO_QUALITY_STEPS } from './hero-image-file.mjs';

export const MEDAL_ART_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxPixels: 16_000_000, maxSide: 4000, minSide: 512, squareTolerance: 0.02, masterMaxEdge: 1024, masterQuality: 90 });
export const MEDAL_ART_BUDGETS = Object.freeze({ m512: { size: 512, maxBytes: 90 * 1024 }, m256: { size: 256, maxBytes: 40 * 1024 }, m128: { size: 128, maxBytes: 15 * 1024 } });
export const MEDAL_ART_PREVIEWS = Object.freeze({ p240: 240, p480: 480 });
const ACCEPTED = new Set(['jpeg', 'png', 'webp']);
const fail = (error, status, extra = {}) => ({ error, status, ...extra });

/**
 * A 64-bit difference hash (dHash) of the picture: 9x8 greyscale (transparency flattened on white), one bit per horizontal neighbour. A re-saved,
 * re-sized or re-compressed copy of the same design lands within a few bits of the original, so a taken-down design stays blocked. → 16 hex chars.
 */
export async function dHash(image) {
  const { data } = await sharp(image).flatten({ background: '#ffffff' }).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) bits = (bits << 1n) | (data[y * 9 + x] < data[y * 9 + x + 1] ? 1n : 0n);
  return bits.toString(16).padStart(16, '0');
}
/** Number of differing bits between two dHashes. */
export function hamming(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`); let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}
/** Two designs this close (of 64 bits) count as the same design. */
export const DHASH_MAX_DISTANCE = 6;
/** A flat or near-flat picture hashes to (almost) all zeros and would "match" every plain design: only pictures with real structure are compared perceptually. */
export const dHashIsMeaningful = h => { const ones = [...BigInt(`0x${h}`).toString(2)].filter(c => c === '1').length; return ones >= 8 && ones <= 56; };

/** An APNG carries an acTL chunk before its first IDAT; an animated WebP carries an ANIM chunk. */
function looksAnimated(buf, type) {
  if (type === 'png') { const idat = buf.indexOf('IDAT'); const act = buf.indexOf('acTL'); return act !== -1 && (idat === -1 || act < idat); }
  if (type === 'webp') return buf.subarray(0, 4096).includes('ANIM');
  return false;
}

async function stepWebp(master, { size, maxBytes }) {
  let best = null;
  for (const quality of [90, ...HERO_QUALITY_STEPS]) {
    const { data, info } = await sharp(master).resize({ width: size, height: size, fit: 'cover' }).webp({ quality, alphaQuality: 90 }).toBuffer({ resolveWithObject: true });
    best = { buffer: data, width: info.width, height: info.height };
    if (data.length <= maxBytes) break; // over budget at the lowest step: keep it, never fail the upload for a budget miss
  }
  return best;
}

/**
 * → { files: [{ variant, buffer, width, height }], master: Buffer, width, height, sha256, pixelSha256 } or { error, status, … }.
 * `limits` may narrow maxBytes / maxPixels (EVENTS_MEDAL_ART_MAX_BYTES / _MAX_PIXELS).
 */
export async function prepareMedalArt(input, limits = {}) {
  const maxBytes = limits.maxBytes ?? MEDAL_ART_LIMITS.maxBytes;
  const maxPixels = limits.maxPixels ?? MEDAL_ART_LIMITS.maxPixels;
  if (!Buffer.isBuffer(input) || !input.length) return fail('no_file_provided', 400);
  if (input.length > maxBytes) return fail('payload_too_large', 413, { maxBytes });
  if (looksLikeSvg(input)) return fail('svg_not_allowed', 400);
  const type = sniffImageType(input);
  if (!type || !ACCEPTED.has(type)) return fail('unsupported_file_type', 400, { reason: type ? 'format_not_accepted' : 'not_an_image' });
  if (looksAnimated(input, type)) return fail('animated_not_allowed', 400);
  let meta;
  try { meta = await sharp(input, { limitInputPixels: false }).metadata(); } catch { return fail('corrupt_image', 400); }
  if ((meta.pages ?? 1) > 1) return fail('animated_not_allowed', 400);
  if (!meta.width || !meta.height) return fail('corrupt_image', 400);
  const turned = meta.orientation >= 5 && meta.orientation <= 8;
  const width = turned ? meta.height : meta.width;
  const height = turned ? meta.width : meta.height;
  if (width > MEDAL_ART_LIMITS.maxSide || height > MEDAL_ART_LIMITS.maxSide || width * height > maxPixels) return fail('image_too_large', 400, { maxSide: MEDAL_ART_LIMITS.maxSide, maxPixels });
  if (Math.min(width, height) < MEDAL_ART_LIMITS.minSide) return fail('image_too_small', 400, { minSide: MEDAL_ART_LIMITS.minSide, width, height });
  if (Math.abs(width - height) / Math.max(width, height) > MEDAL_ART_LIMITS.squareTolerance) return fail('not_square', 400, { width, height });
  let master; let info;
  try {
    ({ data: master, info } = await sharp(input, { limitInputPixels: maxPixels, failOn: 'warning', animated: false })
      .rotate()
      .resize({ width: MEDAL_ART_LIMITS.masterMaxEdge, height: MEDAL_ART_LIMITS.masterMaxEdge, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .webp({ quality: MEDAL_ART_LIMITS.masterQuality, alphaQuality: 100 })
      .toBuffer({ resolveWithObject: true }));
  } catch { return fail('corrupt_image', 400); }
  const files = [{ variant: 'master', buffer: master, width: info.width, height: info.height }];
  for (const [variant, spec] of Object.entries(MEDAL_ART_BUDGETS)) files.push({ variant, ...(await stepWebp(master, spec)) });
  for (const [variant, size] of Object.entries(MEDAL_ART_PREVIEWS)) {
    const { data, info: i } = await sharp(master).resize({ width: size, height: size, fit: 'cover' }).webp({ quality: 70 }).toBuffer({ resolveWithObject: true });
    files.push({ variant, buffer: data, width: i.width, height: i.height });
  }
  return { files, master, width: width, height: height, sha256: sha256(master), pixelSha256: await pixelSha256(master), dHash: await dHash(master) };
}
