// Marathon & running events · S5 — pure rules for venue operations (spec §4, §6): bib numbers, CSV in and out,
// cursors, request fingerprints, masked names. No database, no clock, no network.
import { createHash } from 'node:crypto';

export const BIB_RE = /^[A-Z0-9][A-Z0-9-]{0,11}$/;
export const MANUAL_REASONS = Object.freeze(['phone_lost', 'no_signal', 'screen_damaged', 'other']);
export const REVOKE_REASONS = Object.freeze(['cancelled', 'refunded', 'event_cancelled', 'admin', 'replaced']);
export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_MAX_BYTES = 512 * 1024;
export const BULK_MAX = 5000;

export const sha256hex = v => createHash('sha256').update(String(v)).digest('hex');

/** A bib number as stored: trimmed, upper case, 1–12 characters of letters, digits and dashes, not starting with a dash; else null. */
export function normaliseBib(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const v = String(raw).trim().toUpperCase();
  return BIB_RE.test(v) ? v : null;
}

/** "Amina M." — first name and the last initial; never the full name. */
export function cardName(firstName, lastName) {
  const first = String(firstName ?? '').trim();
  const initial = String(lastName ?? '').trim().slice(0, 1).toUpperCase();
  return initial ? `${first} ${initial}.` : first;
}

// ── Cursors ─────────────────────────────────────────────────────────────────

export const encodeCursor = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
/** The object inside a cursor, or null when it is not one of ours. */
export function decodeCursor(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 400) return null;
  try { const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}
/** ?limit: an integer between 1 and `max` (default `dflt`), or null when it is not valid. */
export function parseLimit(raw, { dflt = 50, max = 200 } = {}) {
  if (raw === undefined || raw === null || raw === '') return dflt;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

// ── Request fingerprints (idempotency) ──────────────────────────────────────

const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
};
/** Same logical body → same fingerprint (key order does not matter). */
export const fingerprintOf = body => sha256hex(canonical(body ?? {}));
export const idempotencyKeyValid = k => typeof k === 'string' && k.length >= 8 && k.length <= 100 && /^[\x21-\x7e]+$/.test(k);

// ── CSV ─────────────────────────────────────────────────────────────────────

/** A cell that a spreadsheet would run as a formula. */
export const isFormulaCell = v => /^[=+\-@\t\r]/.test(String(v ?? ''));
/** Neutralise a value we echo or export: a leading apostrophe makes the spreadsheet treat it as text. */
export const neutralise = v => (isFormulaCell(v) ? `'${v}` : String(v ?? ''));
/** One CSV cell for OUTPUT: neutralised, line breaks collapsed, quotes doubled, always quoted. */
export const csvCell = v => `"${neutralise(String(v ?? '').replace(/[\r\n]+/g, ' ')).replace(/"/g, '""')}"`;
export const csvLine = cells => cells.map(csvCell).join(',');

/**
 * Parse CSV text (UTF-8, header row required, `,` or `;`, quotes and doubled quotes, CRLF or LF).
 * → { header: string[], rows: [{ line, cells }] } or { error: 'empty' | 'too_large' | 'too_many_rows' | 'bad_quote' }.
 */
export function parseCsv(text, { maxRows = IMPORT_MAX_ROWS, maxBytes = IMPORT_MAX_BYTES } = {}) {
  if (typeof text !== 'string') return { error: 'empty' };
  if (Buffer.byteLength(text) > maxBytes) return { error: 'too_large' };
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const records = [];
  let row = []; let cell = ''; let quoted = false; let line = 1; let startLine = 1; let sawAny = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; } else { if (ch === '\n') line += 1; cell += ch; }
      continue;
    }
    if (ch === '"' && cell === '') { quoted = true; sawAny = true; continue; }
    if (ch === delimiter) { row.push(cell); cell = ''; sawAny = true; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(cell);
      if (row.some(c => c.trim() !== '') || sawAny) records.push({ line: startLine, cells: row });
      row = []; cell = ''; sawAny = false; line += 1; startLine = line;
      continue;
    }
    cell += ch; sawAny = true;
  }
  if (quoted) return { error: 'bad_quote' };
  if (cell !== '' || row.length) { row.push(cell); records.push({ line: startLine, cells: row }); }
  const nonBlank = records.filter(r => r.cells.some(c => c.trim() !== ''));
  if (!nonBlank.length) return { error: 'empty' };
  const [head, ...rest] = nonBlank;
  if (rest.length > maxRows) return { error: 'too_many_rows' };
  return { header: head.cells.map(c => c.trim()), rows: rest.map(r => ({ line: r.line, cells: r.cells })) };
}

// ── Bulk bib numbers ────────────────────────────────────────────────────────

/**
 * The numbers a rule yields for `count` people: prefix + zero-padded integer from `start`, stopping at `end` when given.
 * → { numbers: string[], shortfall: number } (shortfall = people left without a number because the range is too small).
 */
export function bulkNumbers({ start, end = null, prefix = '', padTo = 0, count }) {
  const numbers = [];
  const last = end === null || end === undefined ? Number.MAX_SAFE_INTEGER : end;
  for (let n = start; numbers.length < count && n <= last; n += 1) numbers.push(`${prefix}${String(n).padStart(padTo, '0')}`);
  return { numbers, shortfall: Math.max(count - numbers.length, 0) };
}
