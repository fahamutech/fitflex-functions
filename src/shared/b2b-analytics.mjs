// B2B analytics rules that need no database: reporting periods, the period a
// figure is compared with, trend buckets and CSV.
//
// Every date is an East Africa Time calendar day "YYYY-MM-DD", the same day
// the ledgers use (`businessDate`). A period is inclusive at both ends.
import { addDays, daysBetween, weekStart } from './member-progress.mjs';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = v => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
export const PERIOD_PRESETS = Object.freeze([
  'today', 'yesterday', 'last_7_days', 'last_30_days', 'this_month', 'last_month',
  'this_quarter', 'last_quarter', 'year_to_date', 'last_year', 'custom',
]);
/** The longest range a report covers in one request. */
export const MAX_RANGE_DAYS = 800;

const pad = n => String(n).padStart(2, '0');
const monthStart = (y, m) => `${y}-${pad(m)}-01`;                       // m is 1-12
const monthEnd = (y, m) => addDays(m === 12 ? monthStart(y + 1, 1) : monthStart(y, m + 1), -1);
const shiftMonth = (y, m, by) => { const i = y * 12 + (m - 1) + by; return [Math.floor(i / 12), (i % 12) + 1]; };

/**
 * The period a request asks for, and the one it is compared with.
 *
 *   ?period=last_30_days            a preset (default this_month)
 *   ?from=2026-10-01&to=2026-10-31  a custom range
 *
 * A whole month, quarter or year is compared with the one before it. A
 * period still running (this month, this quarter, year to date) is compared
 * with the same number of days at the start of the one before, so 1–12
 * October sits beside 1–12 September. Anything else is compared with the
 * same number of days immediately before it.
 */
export function resolvePeriod(query = {}, today) {
  const fail = (error, extra = {}) => ({ error, status: 400, ...extra });
  const custom = query.from != null || query.to != null;
  const preset = custom ? 'custom' : (query.period ?? 'this_month');
  if (!PERIOD_PRESETS.includes(preset)) return fail('invalid_period', { allowed: PERIOD_PRESETS });
  const y = +today.slice(0, 4);
  const m = +today.slice(5, 7);
  const q0 = Math.floor((m - 1) / 3) * 3 + 1;                           // first month of this quarter
  let from;
  let to;
  let previous;
  const before = (f, t) => { const n = daysBetween(f, t) + 1; return { from: addDays(f, -n), to: addDays(f, -1) }; };
  const sameSpan = (prevStart, f, t) => ({ from: prevStart, to: addDays(prevStart, daysBetween(f, t)) });

  switch (preset) {
    case 'today': from = today; to = today; break;
    case 'yesterday': from = addDays(today, -1); to = from; break;
    case 'last_7_days': from = addDays(today, -6); to = today; break;
    case 'last_30_days': from = addDays(today, -29); to = today; break;
    case 'this_month': {
      from = monthStart(y, m); to = today;
      const [py, pm] = shiftMonth(y, m, -1);
      previous = sameSpan(monthStart(py, pm), from, to);
      if (previous.to > monthEnd(py, pm)) previous.to = monthEnd(py, pm);
      break;
    }
    case 'last_month': {
      const [py, pm] = shiftMonth(y, m, -1);
      const [ppy, ppm] = shiftMonth(y, m, -2);
      from = monthStart(py, pm); to = monthEnd(py, pm);
      previous = { from: monthStart(ppy, ppm), to: monthEnd(ppy, ppm) };
      break;
    }
    case 'this_quarter': {
      from = monthStart(y, q0); to = today;
      const [py, pm] = shiftMonth(y, q0, -3);
      previous = sameSpan(monthStart(py, pm), from, to);
      break;
    }
    case 'last_quarter': {
      const [py, pm] = shiftMonth(y, q0, -3);
      const [ey, em] = shiftMonth(y, q0, -1);
      const [ppy, ppm] = shiftMonth(y, q0, -6);
      const [pey, pem] = shiftMonth(y, q0, -4);
      from = monthStart(py, pm); to = monthEnd(ey, em);
      previous = { from: monthStart(ppy, ppm), to: monthEnd(pey, pem) };
      break;
    }
    case 'year_to_date': from = `${y}-01-01`; to = today; previous = sameSpan(`${y - 1}-01-01`, from, to); break;
    case 'last_year': from = `${y - 1}-01-01`; to = `${y - 1}-12-31`; previous = { from: `${y - 2}-01-01`, to: `${y - 2}-12-31` }; break;
    default: {
      if (!isDay(query.from) || !isDay(query.to)) return fail('invalid_date_range', { hint: 'from and to as YYYY-MM-DD (East Africa Time days)' });
      if (query.to < query.from) return fail('invalid_date_range', { hint: 'to is before from' });
      from = query.from; to = query.to;
    }
  }
  const days = daysBetween(from, to) + 1;
  if (days > MAX_RANGE_DAYS) return fail('date_range_too_long', { maxDays: MAX_RANGE_DAYS });
  previous ??= before(from, to);
  return { preset, from, to, days, previous, bucket: days <= 31 ? 'day' : days <= 183 ? 'week' : 'month', timezone: 'Africa/Dar_es_Salaam' };
}

/** The first day of the day, week (Monday) or month bucket `day` falls in. */
export function bucketOf(day, bucket) {
  if (bucket === 'month') return `${day.slice(0, 7)}-01`;
  if (bucket === 'week') return weekStart(day);
  return day;
}

/** Every bucket start from `from` to `to`, so a trend has a point for the days nothing happened. */
export function bucketsBetween(from, to, bucket) {
  const out = [];
  let d = bucketOf(from, bucket);
  while (d <= to) {
    out.push(d);
    if (bucket === 'month') { const [y, m] = shiftMonth(+d.slice(0, 4), +d.slice(5, 7), 1); d = monthStart(y, m); }
    else d = addDays(d, bucket === 'week' ? 7 : 1);
  }
  return out;
}

/** Change from `previous` to `current` as a percentage, or null when there is nothing to compare with. */
export function changePct(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** A share as a percentage with one decimal, or null when the base is zero. */
export const ratePct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
/** Whole TZS per unit, or null when there are no units. */
export const perUnit = (amountTzs, units) => (units > 0 ? Math.round(amountTzs / units) : null);

/**
 * CSV text for rows of plain values. Cells that a spreadsheet would run as a
 * formula (starting = + - @) are prefixed with a quote, since names and
 * references come from people outside FitFlex.
 */
export function toCsv(columns, rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && typeof v !== 'number') s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(c => cell(c.label)).join(','), ...rows.map(r => columns.map(c => cell(r[c.key])).join(','))].join('\r\n') + '\r\n';
}
