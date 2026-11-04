// Hand-written RFC 4180 CSV reader for vendor smart import (no dependency, pure, never evaluates a cell).
//
// - Input is a string (UTF-8 already decoded by the caller). A leading BOM is stripped.
// - Records end at CRLF, LF or a lone CR; newlines inside quotes are part of the cell.
// - The delimiter is sniffed from the first record outside quotes: comma, semicolon or tab (comma on a tie).
// - Cells are strings. A cell that starts with = + - @ stays text exactly as written; callers decide what to do.
// - Blank records (every cell empty) are skipped. The first record is the header.
// - Limits are enforced while reading, so a hostile file cannot grow memory beyond the caller's byte cap.
//
// → { delimiter, header: string[], rows: [{ rowNo, cells: string[] }] }   rowNo = the record's position counting blank
//   records too (a quoted cell's inner newlines do not count), i.e. the row a spreadsheet shows; the header is usually 1
//   or { error, status, ...extra }

const DELIMITERS = [',', ';', '\t'];

export const CSV_LIMITS = Object.freeze({ maxRows: 2000, maxColumns: 40, maxCellChars: 5000 });

const fail = (error, extra = {}) => ({ error, status: 400, ...extra });

/** Fields in the first record when split by `delimiter`, with the parser's own quote rule (a quote opens a quoted cell only at the start of a cell). */
function firstRecordFields(text, delimiter) {
  let fields = 1;
  let inQuotes = false;
  let atFieldStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') i += 1; else inQuotes = false; }
    } else if (ch === '"' && atFieldStart) { inQuotes = true; atFieldStart = false; }
    else if (ch === delimiter) { fields += 1; atFieldStart = true; }
    else if (ch === '\n' || ch === '\r') break;
    else atFieldStart = false;
  }
  return fields;
}

/** The delimiter that splits the first record into the most cells (comma on a tie), using the parser's quote rule. */
export function sniffDelimiter(text) {
  let best = ',';
  let bestFields = firstRecordFields(text, ',');
  for (const d of DELIMITERS.slice(1)) {
    const n = firstRecordFields(text, d);
    if (n > bestFields) { best = d; bestFields = n; }
  }
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
  let recordNo = 0; // every record counts, blank ones too, so numbers match the spreadsheet's rows (header = 1)

  const endCell = () => {
    cells.push(cell);
    cell = '';
    atFieldStart = true;
    return cells.length <= maxColumns + 1; // one over the cap is enough to refuse later; never grow past it
  };
  const endRecord = () => {
    if (!endCell()) return fail('too_many_columns', { maxColumns });
    recordNo += 1;
    if (!cells.every(c => c.trim() === '')) records.push({ rowNo: recordNo, cells });
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
  return { delimiter, header: head.cells.map(c => c.trim()), rows };
}
