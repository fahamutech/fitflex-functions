// The exercise library as a spreadsheet file, and back.
//
// One row per exercise, one column per field. Lists (areas, equipment,
// goals, alternatives) are separated by ";" in a cell; the steps of the
// instructions by " | ". Yes/no fields read "yes" or "no".
//
// The same file goes both ways: what is exported can be edited and
// imported, and exporting then importing unchanged changes nothing.

/** The columns, in file order. `list` cells hold several values; `steps` several lines. */
export const EXERCISE_COLUMNS = [
  { key: 'id', label: 'id' },
  { key: 'name', label: 'name' },
  { key: 'description', label: 'description' },
  { key: 'category', label: 'category' },
  { key: 'targetAreas', label: 'target_areas', kind: 'list' },
  { key: 'secondaryAreas', label: 'secondary_areas', kind: 'list' },
  { key: 'movementPattern', label: 'movement_pattern' },
  { key: 'difficulty', label: 'difficulty' },
  { key: 'equipment', label: 'equipment', kind: 'list' },
  { key: 'environment', label: 'environment', kind: 'list' },
  { key: 'suitableGoals', label: 'goals', kind: 'list' },
  { key: 'defaultSets', label: 'sets', kind: 'number' },
  { key: 'defaultReps', label: 'reps', kind: 'number' },
  { key: 'defaultDuration', label: 'seconds', kind: 'number' },
  { key: 'restSeconds', label: 'rest_seconds', kind: 'number' },
  { key: 'tracksWeight', label: 'tracks_weight', kind: 'yesno' },
  { key: 'instructions', label: 'instructions', kind: 'steps' },
  { key: 'alternatives', label: 'alternatives', kind: 'list' },
  { key: 'active', label: 'switched_on', kind: 'yesno' },
  { key: 'swName', label: 'sw_name' },
  { key: 'swDescription', label: 'sw_description' },
  { key: 'swInstructions', label: 'sw_instructions', kind: 'steps' },
  // For the reader only; ignored on the way back in.
  { key: 'source', label: 'source', readOnly: true },
];

const STEP_SEPARATOR = ' | ';
// A spreadsheet runs a cell starting with one of these as a formula.
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function write(column, e) {
  const sw = e.i18n?.sw ?? {};
  const v = column.key === 'swName' ? sw.name
    : column.key === 'swDescription' ? sw.description
      : column.key === 'swInstructions' ? sw.instructions
        : e[column.key];
  if (column.kind === 'list') return (v ?? []).join(';');
  if (column.kind === 'steps') return (v ?? []).join(STEP_SEPARATOR);
  if (column.kind === 'yesno') return v === true ? 'yes' : 'no';
  return v ?? '';
}

/** The library as CSV text (with a header row). */
export function exercisesToCsv(exercises) {
  const lines = [EXERCISE_COLUMNS.map(c => cell(c.label)).join(',')];
  for (const e of exercises) lines.push(EXERCISE_COLUMNS.map(c => cell(write(c, e))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * CSV text as rows of cells. Handles quoted cells, doubled quotes, and line
 * breaks inside quotes; skips rows that are entirely empty. Each row keeps
 * the line it started on, for error messages.
 */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  let line = 1;
  let startedAt = 1;
  const endCell = () => { row.push(value); value = ''; };
  const endRow = () => {
    endCell();
    if (row.some(c => c.trim() !== '')) rows.push({ line: startedAt, cells: row });
    row = [];
    startedAt = line + 1;
  };
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { value += '"'; i += 1; } else if (ch === '"') quoted = false;
      else { if (ch === '\n') line += 1; value += ch; }
    } else if (ch === '"' && value === '') quoted = true;
    else if (ch === ',') endCell();
    else if (ch === '\n') { endRow(); line += 1; } else if (ch !== '\r') value += ch;
  }
  if (value !== '' || row.length) endRow();
  return rows;
}

const YES = new Set(['yes', 'y', 'true', '1', 'on']);
const NO = new Set(['no', 'n', 'false', '0', 'off']);

function read(column, raw) {
  // Undo the guard put on formula-like cells when exporting.
  const s = String(raw ?? '').trim().replace(/^'(?=[=+\-@])/, '');
  if (column.kind === 'list') return s ? s.split(';').map(x => x.trim()).filter(Boolean) : [];
  if (column.kind === 'steps') return s ? s.split(/\s*\|\s*|\r?\n/).map(x => x.trim()).filter(Boolean) : [];
  if (column.kind === 'yesno') return YES.has(s.toLowerCase()) ? true : NO.has(s.toLowerCase()) ? false : s === '' ? undefined : null;
  if (column.kind === 'number') return s === '' ? null : (/^\d+$/.test(s) ? Number(s) : NaN);
  return s;
}

/**
 * A file as exercise rows: `{ line, id, fields }`, where `fields` holds only
 * the columns the file has — a column left out of the file leaves that part
 * of each exercise as it is. Returns `{ error }` when the file can't be read.
 */
export function csvToExerciseRows(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { error: 'empty_file' };
  const header = rows[0].cells.map(h => h.trim().toLowerCase());
  const columns = header.map(h => EXERCISE_COLUMNS.find(c => c.label === h) ?? null);
  if (!columns.some(c => c && c.key === 'name') && !columns.some(c => c && c.key === 'id')) return { error: 'missing_header' };
  const unknownColumns = header.filter((h, i) => h && !columns[i]);
  const out = [];
  for (const { line, cells } of rows.slice(1)) {
    const fields = {};
    const sw = {};
    let id = '';
    columns.forEach((c, i) => {
      if (!c || c.readOnly) return;
      const v = read(c, cells[i]);
      if (c.key === 'id') id = v;
      else if (c.key === 'swName') sw.name = v;
      else if (c.key === 'swDescription') sw.description = v;
      else if (c.key === 'swInstructions') sw.instructions = v;
      else fields[c.key] = v;
    });
    if (Object.keys(sw).length) fields.i18n = { sw };
    out.push({ line, id, fields });
  }
  return { rows: out, unknownColumns };
}
