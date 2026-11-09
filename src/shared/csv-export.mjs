// CSV files people open in Excel / Google Sheets (vendor reports S6, vendor payment statement).
//
// - UTF-8 with a byte-order mark, so Excel shows Swahili (and every other non-ASCII letter) correctly.
// - Comma separator, CRLF line ends, RFC 4180 quoting (a cell with a comma, quote, CR or LF is quoted;
//   quotes are doubled).
// - Formula-injection safe (design spec S6 §10.1): a TEXT cell that starts with = + - @, a tab or a CR
//   is prefixed with ' so a spreadsheet shows it as text and never runs it. Numbers are written from
//   finite numbers only (integers stay integers), so a negative amount stays a number.
// - Row 1 is the header; every other row is data (no title or footer rows).

export const CSV_BOM = '﻿';
const RISKY_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** One cell. null/undefined → empty; numbers → their digits; everything else → injection-safe text. */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let text = String(value);
  if (RISKY_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const csvRow = cells => cells.map(csvCell).join(',');

/** A whole file: BOM + header + rows, CRLF after every row. */
export function csvDocument(header, rows) {
  return `${CSV_BOM}${[header, ...rows].map(csvRow).join('\r\n')}\r\n`;
}
