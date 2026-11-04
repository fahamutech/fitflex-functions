// Hand-written RFC 4180 CSV reader for vendor smart import (no dependency, pure, never evaluates a cell).
//
// - Input is a string (UTF-8 already decoded by the caller). A leading BOM is stripped.
// - Records end at CRLF, LF or a lone CR; newlines inside quotes are part of the cell.
// - The delimiter is sniffed from the first record outside quotes: comma, semicolon or tab (comma on a tie).
// - Cells are strings. A cell that starts with = + - @ stays text exactly as written; callers decide what to do.
// - Blank records (every cell empty) are skipped. The first record is the header.
// - Limits are enforced while reading, so a hostile file cannot grow memory beyond the caller's byte cap.
//
// → { delimiter, header: string[], rows: [{ rowNo, cells: string[] }] }   rowNo: 1 = the header, 2 = first data record
//   or { error, status, ...extra }

const DELIMITERS = [',', ';', '\t'];

export const CSV_LIMITS = Object.freeze({ maxRows: 2000, maxColumns: 40, maxCellChars: 5000 });

const fail = (error, extra = {}) => ({ error, status: 400, ...extra });

/** The delimiter used by the first record (quotes respected). */
export function sniffDelimiter(text) {
  const counts = new Map(DELIMITERS.map(d => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    else if (!inQuotes && counts.has(ch)) counts.set(ch, counts.get(ch) + 1);
  }
  let best = ',';
  for (const d of DELIMITERS) if (counts.get(d) > counts.get(best)) best = d;
  return best;
}

export function parseCsv(input, limits = CSV_LIMITS) {
  const { maxRows, maxColumns, maxCellChars } = { ...CSV_LIMITS, ...limits };
  let text = String(input ?? '');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const delimiter = sniffDelimiter(text);

  const records = [];
  let cells = [];
  let cell = '';
  let inQuotes = false;
  let atFieldStart = true;

  const endCell = () => {
    cells.push(cell);
    cell = '';
    atFieldStart = true;
    return cells.length <= maxColumns + 1; // one over the cap is enough to refuse later; never grow past it
  };
  const endRecord = () => {
    if (!endCell()) return fail('too_many_columns', { maxColumns });
    if (!cells.every(c => c.trim() === '')) records.push({ cells });
    cells = [];
    return null;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else { inQuotes = false; }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
    } else if (ch === delimiter) {
      if (!endCell()) return fail('too_many_columns', { maxColumns });
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      const stop = endRecord();
      if (stop) return stop;
    } else {
      cell += ch;
      atFieldStart = false;
    }
    if (cell.length > maxCellChars) return fail('cell_too_long', { maxCellChars });
    if (records.length > maxRows + 1) return { error: 'too_many_rows', status: 413, maxRows };
  }
  if (inQuotes) return fail('invalid_csv', { reason: 'unterminated_quote' });
  if (cell !== '' || cells.length) {
    const stop = endRecord();
    if (stop) return stop;
  }
  if (!records.length) return fail('empty_file');

  const [head, ...rows] = records;
  if (head.cells.length > maxColumns) return fail('too_many_columns', { maxColumns });
  if (rows.length > maxRows) return { error: 'too_many_rows', status: 413, maxRows };
  if (!rows.length) return fail('empty_file', { reason: 'header_only' });
  // Row numbers are the data records' positions (header = 1) so they match what a spreadsheet shows.
  const numbered = rows.map((r, index) => ({ rowNo: index + 2, cells: r.cells }));
  return { delimiter, header: head.cells.map(c => c.trim()), rows: numbered };
}
