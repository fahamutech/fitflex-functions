// Vendor smart import V1 — the CSV reader and the byte-level checks. Pure: no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, sniffDelimiter } from '../src/shared/csv-parse.mjs';
import { readCsvBytes, safeFilename } from '../src/services/vendor-import-service.mjs';
import { csvDocument } from '../src/shared/csv-export.mjs';

const ok = text => { const out = parseCsv(text); assert.equal(out.error, undefined, JSON.stringify(out)); return out; };

test('csv: plain rows, header first, row numbers match a spreadsheet (header = 1)', () => {
  const out = ok('name,price\nWhey,45000\nMat,25000\n');
  assert.deepEqual(out.header, ['name', 'price']);
  assert.deepEqual(out.rows, [{ rowNo: 2, cells: ['Whey', '45000'] }, { rowNo: 3, cells: ['Mat', '25000'] }]);
  assert.equal(out.delimiter, ',');
});

test('csv: quotes, doubled quotes, commas and newlines inside quotes, CRLF and lone CR line ends', () => {
  const out = ok('name,note\r\n"Whey, 1kg","say ""hi"""\r\n"two\nlines",x\rlast,y');
  assert.deepEqual(out.rows.map(r => r.cells), [['Whey, 1kg', 'say "hi"'], ['two\nlines', 'x'], ['last', 'y']]);
});

test('csv: BOM is stripped; blank lines and all-empty rows are skipped', () => {
  const out = ok('\uFEFFname,price\n\n,\nWhey,1\n\n');
  assert.deepEqual(out.header, ['name', 'price']);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].rowNo, 4, 'the blank line and the all-empty row count as rows 2 and 3, as in a spreadsheet');
});

test('csv: row numbers count blank lines but not newlines inside a quoted cell', () => {
  const out = ok('a,b\n1,2\n\n3,"x\ny\nz"\n4,5\n');
  assert.deepEqual(out.rows.map(r => r.rowNo), [2, 4, 5]);
  assert.deepEqual(ok('a\r\n\r\n1\r\n').rows.map(r => r.rowNo), [3]);
  assert.deepEqual(ok('a\n1\n2').rows.map(r => r.rowNo), [2, 3], 'no trailing newline');
});

test('csv: the delimiter is sniffed (semicolon, tab; comma on a tie); delimiters inside quotes do not count', () => {
  assert.equal(ok('a;b;c\n1;2;3').delimiter, ';');
  assert.deepEqual(ok('a;b;c\n1;2;3').rows[0].cells, ['1', '2', '3']);
  assert.equal(ok('a\tb\n1\t2').delimiter, '\t');
  assert.equal(sniffDelimiter('a,b;c\n'), ',');
  assert.equal(sniffDelimiter('"a;b;c",d\n1,2'), ',', 'semicolons inside quotes are not delimiters');
  assert.equal(sniffDelimiter('single\n1'), ',');
  // the sniffer reads quotes the way the parser does: a quote inside a cell is a plain character
  assert.equal(sniffDelimiter('na"me;price;stock\n1;2;3'), ';');
  assert.deepEqual(ok('na"me;price;stock\n1;2;3').header, ['na"me', 'price', 'stock']);
  assert.equal(sniffDelimiter('"a,b,c";d;e\n'), ';', 'commas inside a quoted cell are not delimiters');
  assert.equal(sniffDelimiter('"a""b;c";d,e\n'), ',', 'doubled quotes stay inside the cell');
});

test('csv: ragged rows are returned as they are (the service marks row_shape); a trailing line without newline is kept', () => {
  const out = ok('a,b,c\n1,2\n1,2,3,4\n5,6,7');
  assert.deepEqual(out.rows.map(r => r.cells.length), [2, 4, 3]);
});

test('csv: cells are never evaluated: formula-looking text stays exactly as written', () => {
  const out = ok('name,note\n=HYPERLINK("http://x"),+1\n@SUM(A1),-5');
  assert.deepEqual(out.rows.map(r => r.cells), [['=HYPERLINK("http://x")', '+1'], ['@SUM(A1)', '-5']]);
});

test('csv: refused files — unterminated quote, header only, empty, too many columns, cell too long, too many rows', () => {
  assert.equal(parseCsv('a,b\n"open,1').error, 'invalid_csv');
  assert.equal(parseCsv('a,b\n').error, 'empty_file');
  assert.equal(parseCsv('').error, 'empty_file');
  assert.equal(parseCsv('\n\n').error, 'empty_file');
  const wide = Array.from({ length: 41 }, (_, i) => `c${i}`).join(',');
  assert.deepEqual([parseCsv(`${wide}\n1`).error, parseCsv(`${wide}\n1`).status], ['too_many_columns', 400]);
  assert.equal(parseCsv(`${Array.from({ length: 40 }, (_, i) => `c${i}`).join(',')}\n1`).error, undefined, '40 columns is the cap');
  assert.equal(parseCsv(`a\n${'x'.repeat(5001)}`).error, 'cell_too_long');
  assert.equal(parseCsv(`a\n${'x'.repeat(5000)}`).error, undefined, '5,000 characters is the cap');
  const rows = n => `a\n${Array.from({ length: n }, (_, i) => String(i + 1)).join('\n')}`;
  assert.equal(parseCsv(rows(2000)).error, undefined);
  assert.deepEqual([parseCsv(rows(2001)).error, parseCsv(rows(2001)).status], ['too_many_rows', 413]);
});

test('bytes: PK header (xlsx/zip) → 415 xlsx_not_supported_yet; NUL bytes → 415; invalid UTF-8 → 400 invalid_encoding; empty → empty_file', () => {
  assert.deepEqual(readCsvBytes(Buffer.from('PK\u0003\u0004rest')), { error: 'unsupported_file_type', status: 415, hint: 'xlsx_not_supported_yet' });
  assert.equal(readCsvBytes(Buffer.from('a,b\n1,\u0000\n')).error, 'unsupported_file_type');
  assert.equal(readCsvBytes(Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00])).status, 415, 'UTF-16 has NUL bytes');
  assert.deepEqual(readCsvBytes(Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0xc3, 0x28])), { error: 'invalid_encoding', status: 400 });
  assert.equal(readCsvBytes(Buffer.alloc(0)).error, 'empty_file');
  assert.equal(readCsvBytes(Buffer.from('jina,bei\nMaji ya kunywa,1000')).text.startsWith('jina'), true);
  assert.equal(readCsvBytes(Buffer.from('\uFEFFa,b\n1,2')).text, 'a,b\n1,2', 'a UTF-8 BOM is accepted and dropped');
});

test('filename: path stripped, control characters removed, at most 120 characters, extension kept', () => {
  assert.equal(safeFilename('C:\\Users\\asha\\bidhaa.csv'), 'bidhaa.csv');
  assert.equal(safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeFilename('a\u0000b\nc.csv'), 'abc.csv');
  assert.equal(safeFilename(''), 'import.csv');
  const long = safeFilename(`${'x'.repeat(300)}.csv`);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('.csv'));
});

test('csv export: the errors file is formula safe, quoted, with a BOM and CRLF', () => {
  const text = csvDocument(['row', 'value'], [[2, '=1+1'], [3, 'a,"b"'], [4, '-5']]);
  assert.equal(text.charCodeAt(0), 0xFEFF);
  assert.equal(text, '\uFEFFrow,value\r\n2,\'=1+1\r\n3,"a,""b"""\r\n4,\'-5\r\n');
});
