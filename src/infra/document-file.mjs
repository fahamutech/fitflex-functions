// Checks and clean-up for uploaded KYC documents.
//
// The file type is decided from the file's own first bytes, never from the
// name or the Content-Type the client sent. PDFs are stored as uploaded,
// except that encrypted PDFs and PDFs carrying scripts are refused. Photos
// are re-encoded in their own format, which applies the camera rotation and
// drops metadata such as the GPS position a phone embeds.
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { DOCUMENT_MAX_BYTES } from '../shared/partner-kyc.mjs';

const TYPES = [
  { mimeType: 'application/pdf', ext: 'pdf', test: b => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mimeType: 'image/jpeg', ext: 'jpg', test: b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { mimeType: 'image/png', ext: 'png', test: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) },
  { mimeType: 'image/webp', ext: 'webp', test: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/** The document type from its first bytes: { mimeType, ext } or null. */
export function sniffDocumentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const match = TYPES.find(t => t.test(buffer));
  return match ? { mimeType: match.mimeType, ext: match.ext } : null;
}

/** Why a PDF is refused, or null. */
export function pdfProblem(buffer) {
  const text = buffer.toString('latin1');
  if (/\/Encrypt\b/.test(text)) return 'encrypted_pdf';
  if (/\/(JavaScript|JS|Launch|EmbeddedFile)\b/.test(text)) return 'pdf_with_active_content';
  return null;
}

export const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

/** A safe display name: the original base name, letters, digits, dots, dashes and spaces only. */
export function displayFileName(name, ext) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '')
    .replace(/[^\p{L}\p{N} ._-]+/gu, '').trim().slice(0, 80);
  return `${base || 'document'}.${ext}`;
}

/**
 * Validate and clean an uploaded document.
 * @returns {Promise<{ buffer, mimeType, ext, sizeBytes, sha256 } | { error }>}
 */
export async function prepareDocumentFile(buffer, { truncated = false } = {}) {
  if (truncated || buffer.length > DOCUMENT_MAX_BYTES) return { error: 'file_too_large' };
  if (!buffer.length) return { error: 'empty_file' };
  const type = sniffDocumentType(buffer);
  if (!type) return { error: 'unsupported_file_type' };

  let out = buffer;
  if (type.mimeType === 'application/pdf') {
    const problem = pdfProblem(buffer);
    if (problem) return { error: problem };
  } else {
    try {
      const image = sharp(buffer, { failOn: 'error' }).rotate();
      out = type.mimeType === 'image/jpeg' ? await image.jpeg({ quality: 90 }).toBuffer()
        : type.mimeType === 'image/png' ? await image.png().toBuffer()
          : await image.webp({ quality: 90 }).toBuffer();
    } catch {
      return { error: 'unreadable_image' };
    }
    if (out.length > DOCUMENT_MAX_BYTES) return { error: 'file_too_large' };
  }
  return { buffer: out, mimeType: type.mimeType, ext: type.ext, sizeBytes: out.length, sha256: sha256(out) };
}
