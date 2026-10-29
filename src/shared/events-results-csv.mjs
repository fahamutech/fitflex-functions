// Marathon & running events · S6 — the results CSV (spec §6.2). Parsing is the S5 helper (UTF-8, BOM tolerated, `,` or `;`, quotes,
// size and row caps); this file maps the header aliases and cleans the cells. Ranks in a file are IGNORED (D52), people are matched by
// live bib or registration id only (never by name), and a cell that a spreadsheet would run as a formula is refused in the bib column
// and neutralised everywhere else it is stored.
import { parseCsv, isFormulaCell, neutralise } from './events-ops-rules.mjs';

export const RESULTS_CSV_MAX_BYTES = 1024 * 1024;
const ALIASES = {
  bib: ['bib', 'bib_number', 'bibnumber', 'number'],
  registrationId: ['registrationid', 'registration_id'],
  status: ['status', 'finish_status', 'finishstatus'],
  net: ['net_time', 'nettime', 'chip_time', 'chiptime', 'time'],
  gun: ['gun_time', 'guntime'],
  category: ['category', 'category_name', 'categoryid', 'category_id'],
  note: ['note', 'notes'],
  rank: ['rank', 'overall_rank', 'position', 'place', 'category_rank'],
};
export const STATUS_WORDS = Object.freeze({ finished: 'finished', fin: 'finished', finish: 'finished', dnf: 'dnf', dns: 'dns', dq: 'dq', dsq: 'dq' });

const norm = h => String(h ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

/**
 * → { rows: [{ line, bib, registrationId, status, net, gun, category, note, rank, bibInvalid }] } or { error }.
 * `status` is the normalised word or '' (absent) or the raw unknown word (the planner refuses it with status_invalid).
 */
export function parseResultsCsv(text, { maxRows = 5000 } = {}) {
  const parsed = parseCsv(text, { maxRows, maxBytes: RESULTS_CSV_MAX_BYTES });
  if (parsed.error) return { error: parsed.error === 'empty' ? 'csv_empty' : parsed.error };
  const index = {};
  parsed.header.forEach((h, i) => {
    const n = norm(h);
    for (const [key, names] of Object.entries(ALIASES)) if (names.includes(n) && index[key] === undefined) index[key] = i;
  });
  if (index.bib === undefined && index.registrationId === undefined) return { error: 'csv_header_invalid', missing: ['bib'] };
  const cell = (cells, key) => (index[key] === undefined ? '' : String(cells[index[key]] ?? '').trim());
  const rows = parsed.rows.map(({ line, cells }) => {
    const bib = cell(cells, 'bib');
    const statusRaw = cell(cells, 'status').toLowerCase();
    return {
      line,
      bib: isFormulaCell(bib) ? '' : bib,
      bibInvalid: isFormulaCell(bib),
      registrationId: cell(cells, 'registrationId'),
      status: statusRaw === '' ? '' : (STATUS_WORDS[statusRaw] ?? statusRaw.slice(0, 20)),
      net: cell(cells, 'net'),
      gun: cell(cells, 'gun'),
      category: cell(cells, 'category'),
      note: neutralise(cell(cells, 'note')).slice(0, 120),
      rank: cell(cells, 'rank'),
    };
  });
  return { rows, header: parsed.header };
}

/** A small sample file for the portal's "Download sample CSV". */
export const SAMPLE_CSV = 'bib,status,net_time,gun_time,category,note\n1001,finished,0:52:08,0:52:31,10K,\n1002,finished,1:01:44,1:02:09,10K,\n1003,dnf,,,10K,Withdrew at 6 km\n1004,dns,,,5K,\n';
