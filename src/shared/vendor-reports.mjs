// Vendor reports (vendor business tools · S6). Pure functions: no storage.
//
// Decided 2026-10-22 (design spec docs/design/vendor-reports-s6.md, every recommendation applied):
// - Periods are EAT calendar dates sent by the client (`from`, `to`, inclusive, YYYY-MM-DD); the server
//   turns them into instants and buckets in SQL (AT TIME ZONE 'Africa/Dar_es_Salaam'), never the client.
//   `to` ≤ today (EAT), to ≥ from, at most 366 days (Q-10). A week is Monday–Sunday, a month the calendar month.
// - groupBy day | week | month (Sales, Profit); auto = day up to 31 days, week up to 26 weeks (182 days),
//   else month; more than 120 buckets → 400 too_many_buckets.
// - CSV: at most 50,000 data rows, else 413 export_too_large. Headers in the chosen language, money columns
//   end with "(TZS)", raw integers, ISO dates (EAT) (Q-11). See ./csv-export.mjs for BOM, CRLF and injection.
// - The server may cache CLOSED periods (to < today) for 10 minutes, keyed by vendor + parameters + what
//   the caller may see; a range that includes today is never cached (Q-10).
// - No previous-period comparison (Q-17); stock value is "as of now" (Q-12).
// Every Swahili string here is a DRAFT for native review.
import { slug, swahiliTime, formatDay } from './vendor-documents.mjs';

export const REPORT_LIMITS = Object.freeze({ maxDays: 366, maxBuckets: 120, maxCsvRows: 50_000, cacheTtlMs: 10 * 60_000, cacheMaxEntries: 500, cacheMaxBytes: 16 * 1024 * 1024, pdfBucketRows: 31 });
export const REPORT_TIMEZONE = 'Africa/Dar_es_Salaam';
export const CHANNELS = ['all', 'app', 'walk_in'];
export const GROUP_BYS = ['day', 'week', 'month'];
export const REPORT_LANGS = ['en', 'sw'];
export const PRODUCT_SORTS = ['revenue', 'units', 'slow'];
export const STOCK_SORTS = ['value', 'stock', 'name'];
export const PRODUCTS_PAGE = Object.freeze({ default: 50, max: 200 });
/** Days of cover (Q-9): stock ÷ average daily units over the last 30 days; ≤ 7 days = "Reorder soon". */
export const COVER = Object.freeze({ windowDays: 30, soonDays: 7 });

const DAY_MS = 86_400_000;
const EAT_MS = 3 * 3_600_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const fail = (error, status, extra = {}) => ({ error, status, ...extra });

/** Today's EAT calendar date (YYYY-MM-DD). */
export const eatToday = (now = new Date()) => new Date(+now + EAT_MS).toISOString().slice(0, 10);
const dayMs = day => Date.parse(`${day}T00:00:00.000Z`);
const isDay = v => typeof v === 'string' && ISO_DAY.test(v) && !Number.isNaN(dayMs(v)) && new Date(dayMs(v)).toISOString().slice(0, 10) === v;
export const addDays = (day, n) => new Date(dayMs(day) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from, to) => Math.round((dayMs(to) - dayMs(from)) / DAY_MS) + 1;
/** Monday of the ISO week of `day`. */
export const weekStart = day => addDays(day, -((new Date(dayMs(day)).getUTCDay() + 6) % 7));
export const monthStart = day => `${day.slice(0, 7)}-01`;
const monthEnd = day => {
  const d = new Date(dayMs(monthStart(day)));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return addDays(d.toISOString().slice(0, 10), -1);
};
export const bucketStartOf = (day, groupBy) => (groupBy === 'week' ? weekStart(day) : groupBy === 'month' ? monthStart(day) : day);
const bucketEndOf = (start, groupBy) => (groupBy === 'week' ? addDays(start, 6) : groupBy === 'month' ? monthEnd(start) : start);

/** Auto grouping for a period of `days` days. */
export const autoGroupBy = days => (days <= 31 ? 'day' : days <= 182 ? 'week' : 'month');

/**
 * Every bucket of the period, in order: { key (the bucket's own first day — what SQL date_trunc gives),
 * start, end } where start/end are clipped to the period (a week starting before `from` shows from `from`).
 */
export function bucketsOf(from, to, groupBy) {
  const out = [];
  for (let key = bucketStartOf(from, groupBy); key <= to; key = addDays(bucketEndOf(key, groupBy), 1)) {
    const end = bucketEndOf(key, groupBy);
    out.push({ key, start: key < from ? from : key, end: end > to ? to : end });
  }
  return out;
}

/**
 * Parse the common report query. → { from, to, days, today, closed, channel, groupBy|null, lang, format }
 * or { error, status, ... }. Without from and to: this month so far. `groupBy` is resolved only when
 * `grouped` (Sales, Profit, Summary): auto when absent.
 */
export function parseReportQuery(query = {}, { now = new Date(), grouped = false, formats = ['json'], channelUsed = true } = {}) {
  const today = eatToday(now);
  let { from, to } = query;
  from = from == null || from === '' ? null : String(from);
  to = to == null || to === '' ? null : String(to);
  if (!from && !to) { from = monthStart(today); to = today; }
  if (!from || !to) return fail('invalid_range', 400, { reason: 'from_and_to_required' });
  if (!isDay(from) || !isDay(to)) return fail('invalid_range', 400, { reason: 'invalid_date' });
  if (to > today) return fail('invalid_range', 400, { reason: 'future', today });
  if (to < from) return fail('invalid_range', 400, { reason: 'to_before_from' });
  const days = daysBetween(from, to);
  if (days > REPORT_LIMITS.maxDays) return fail('invalid_range', 400, { reason: 'too_long', maxDays: REPORT_LIMITS.maxDays });

  const channel = query.channel == null || query.channel === '' || !channelUsed ? 'all' : String(query.channel);
  if (!CHANNELS.includes(channel)) return fail('invalid_channel', 400, { allowed: CHANNELS });
  const format = query.format == null || query.format === '' ? 'json' : String(query.format);
  if (!formats.includes(format)) return fail('invalid_format', 400, { allowed: formats });
  const lang = query.lang == null || query.lang === '' ? 'en' : String(query.lang);
  if (!REPORT_LANGS.includes(lang)) return fail('invalid_lang', 400, { allowed: REPORT_LANGS });

  let groupBy = null;
  if (grouped) {
    groupBy = query.groupBy == null || query.groupBy === '' ? autoGroupBy(days) : String(query.groupBy);
    if (!GROUP_BYS.includes(groupBy)) return fail('invalid_group_by', 400, { allowed: GROUP_BYS });
    const count = bucketsOf(from, to, groupBy).length;
    if (count > REPORT_LIMITS.maxBuckets) return fail('too_many_buckets', 400, { max: REPORT_LIMITS.maxBuckets, groupBy, buckets: count });
  }
  return { from, to, days, today, closed: to < today, channel, groupBy, lang, format };
}

// ── money helpers ───────────────────────────────────────────────────────────

export const num = v => (v == null ? 0 : Number(v));
/** Margin (or any share) in percent with one decimal; null when the base is 0. */
export const pct1 = (part, whole) => (Number(whole) ? Math.round((Number(part) * 1000) / Number(whole)) / 10 : null);

/**
 * Days of cover (Q-9). stock null → untracked; 0 → out; no sales in the window → none; else
 * daysOfCover = floor(stock ÷ average daily units) and soon when ≤ 7 days (0 = less than 1 day).
 */
export function cover(stock, unitsInWindow) {
  const avg = Math.round((Number(unitsInWindow || 0) * 100) / COVER.windowDays) / 100;
  if (stock == null) return { avgDailyUnits30: avg, daysOfCover: null, coverState: 'untracked' };
  if (Number(stock) <= 0) return { avgDailyUnits30: avg, daysOfCover: 0, coverState: 'out' };
  if (!(Number(unitsInWindow) > 0)) return { avgDailyUnits30: avg, daysOfCover: null, coverState: 'none' };
  const days = Math.floor((Number(stock) * COVER.windowDays) / Number(unitsInWindow));
  return { avgDailyUnits30: avg, daysOfCover: days, coverState: days <= COVER.soonDays ? 'soon' : 'ok' };
}

// ── cache (closed periods only) ─────────────────────────────────────────────

/**
 * A small in-memory cache with a TTL and two hard caps (oldest entry goes first): `max` entries and about
 * `maxBytes` of data (size ≈ 2 bytes per character of the value's JSON — security review #275). A value larger
 * than a tenth of maxBytes is not cached at all.
 */
export function createReportCache({ ttlMs = REPORT_LIMITS.cacheTtlMs, max = REPORT_LIMITS.cacheMaxEntries, maxBytes = REPORT_LIMITS.cacheMaxBytes, now = () => Date.now() } = {}) {
  const entries = new Map();
  let bytes = 0;
  const drop = (key) => { const hit = entries.get(key); if (hit) { bytes -= hit.bytes; entries.delete(key); } };
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expires <= now()) { drop(key); return undefined; }
      return hit.value;
    },
    set(key, value) {
      drop(key);
      if (!(ttlMs > 0)) return;
      const size = (JSON.stringify(value)?.length || 0) * 2 + key.length * 2;
      if (size > maxBytes / 10) return;
      entries.set(key, { value, expires: now() + ttlMs, bytes: size });
      bytes += size;
      while (entries.size > max || bytes > maxBytes) drop(entries.keys().next().value);
    },
    reset() { entries.clear(); bytes = 0; },
    size: () => entries.size,
    bytes: () => bytes,
  };
}

// ── labels (EN + SW drafts) for CSV headers and the PDF ─────────────────────

export const REPORT_LABELS = {
  en: {
    title: 'Sales report', generated: 'Generated {date} by {name}', generatedNoName: 'Generated {date}',
    footer: 'Figures are from FitFlex records; not a tax document.', pageOf: 'Page {n} of {m}',
    allSales: 'All sales', appOnly: 'App sales', shopOnly: 'Shop sales', soFar: '(so far)',
    periodStart: 'Period start', periodEnd: 'Period end', weekStart: 'Week start', weekEnd: 'Week end',
    appNet: 'App net', shopNet: 'Shop net', gross: 'Gross sales', discounts: 'Discounts', refunds: 'Refunds', net: 'Net sales',
    vatIncluded: 'VAT included', salesCount: 'Sales', itemsSold: 'Items sold', voided: 'Voided (not counted): {n} sales · {amount}', voided_one: 'Voided (not counted): 1 sale · {amount}',
    product: 'Product', variant: 'Variant', removed: '(removed)', unitsSold: 'Units sold', appUnits: 'App units', shopUnits: 'Shop units',
    revenue: 'Net revenue', lastSold: 'Last sold', inStock: 'In stock', cover: 'Days of cover', coverStatus: 'Cover',
    cover_ok: '{n} days', cover_ok_one: '1 day', cover_soon: 'Reorder soon', cover_none: 'No sales in 30 days', cover_out: 'Out of stock', cover_untracked: '—', coverUnderOne: 'Less than 1 day',
    noSalesPeriod: 'No sales in this period', topProducts: 'Top products', slowSellers: 'Slow sellers', never: 'Never',
    stockValue: 'Stock value', asOf: 'As of {time} today. The period you picked does not apply.', asOfDate: 'As of {date}', sellingPrice: 'Selling price',
    atRetail: 'Value at selling price', atCost: 'Value at cost', costPrice: 'Cost price', unknown: 'Unknown', units: 'Units in stock', products: 'Products',
    costUnknown: '{n} products in stock have no cost price, so they are not in the cost value.',
    costUnknown_one: '1 product in stock has no cost price, so it is not in the cost value.',
    profit: 'Profit', netExVat: 'Net sales without VAT', commission: 'Commission', cogs: 'Cost of goods', margin: 'Margin', uncostedSales: 'Uncosted sales',
    uncosted: 'Sold without a cost price: {n} items · {amount}. Not in profit.', uncosted_one: 'Sold without a cost price: 1 item · {amount}. Not in profit.', profitNoVat: 'Profit is worked out without VAT.',
    payouts: 'App sales after commission', payoutsBasis: 'App orders only. Counted by delivery date, the same as your payout statements.',
    orders: 'Orders', appSales: 'App sales', youReceive: 'You receive', statement: 'Statement',
    notDelivered: 'Paid, not delivered yet', waiting: 'Delivered, waiting for payout', paidOut: 'Paid out', noStatement: 'Not on a statement yet', awaiting: 'Awaiting payout',
    customers: 'Customers and money owed', owed: 'Owed to you', overdue: 'Overdue', agingCurrent: 'Not due yet', aging1: '1–30 days overdue', aging31: '31–60 days overdue',
    aging61: '61–90 days overdue', aging90: 'Over 90 days overdue', creditSalesCount: 'Pay-later sales', creditSales: 'Pay-later sales', collected: 'Collected from customers',
    buyersShop: 'Customers who bought (shop)', buyersApp: 'Customers who bought (app)',
    methods: 'Payment methods', group: 'Group', method: 'Method', amount: 'Amount', count: 'Count', share: 'Share',
    byYou: 'Collected by you', viaFitFlex: 'Paid through FitFlex', netOfChange: 'Cash after change',
    figure: 'Figure', value: 'Value', none: 'None',
    refundNumber: 'Credit note', refundDate: 'Date', saleNumber: 'Sale', restocked: 'Units back in stock',
    method_: { cash: 'Cash', mpesa: 'M-Pesa', airtel_money: 'Airtel Money', mixx: 'Mixx by Yas', halopesa: 'HaloPesa', card: 'Card', bank: 'Bank transfer', other: 'Other', unknown: 'Other' },
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  },
  sw: {
    title: 'Ripoti ya mauzo', generated: 'Imetengenezwa {date} na {name}', generatedNoName: 'Imetengenezwa {date}',
    footer: 'Takwimu ni kutoka kumbukumbu za FitFlex; si hati ya kodi.', pageOf: 'Ukurasa {n} kati ya {m}',
    allSales: 'Mauzo yote', appOnly: 'Mauzo ya app', shopOnly: 'Mauzo ya dukani', soFar: '(hadi sasa)',
    periodStart: 'Mwanzo wa kipindi', periodEnd: 'Mwisho wa kipindi', weekStart: 'Mwanzo wa wiki', weekEnd: 'Mwisho wa wiki',
    appNet: 'Mauzo ya app baada ya makato', shopNet: 'Mauzo ya dukani baada ya makato', gross: 'Mauzo ya jumla', discounts: 'Punguzo', refunds: 'Marejesho', net: 'Mauzo baada ya makato',
    vatIncluded: 'VAT iliyomo', salesCount: 'Idadi ya mauzo', itemsSold: 'Bidhaa zilizouzwa', voided: 'Yamebatilishwa (hayahesabiwi): mauzo {n} · {amount}',
    product: 'Bidhaa', variant: 'Chaguo', removed: '(imeondolewa)', unitsSold: 'Idadi iliyouzwa', appUnits: 'Idadi ya app', shopUnits: 'Idadi ya dukani',
    revenue: 'Mapato baada ya makato', lastSold: 'Iliuzwa mwisho', inStock: 'Stock iliyopo', cover: 'Siku Stock itakazotosha', coverStatus: 'Hali ya Stock',
    cover_ok: 'Siku {n}', cover_soon: 'Agiza tena karibuni', cover_none: 'Hakuna mauzo siku 30', cover_out: 'Imeisha', cover_untracked: '—', coverUnderOne: 'Chini ya siku 1',
    noSalesPeriod: 'Hakuna mauzo kipindi hiki', topProducts: 'Bidhaa zinazouzika zaidi', slowSellers: 'Zinazouzika polepole', never: 'Haijawahi',
    stockValue: 'Thamani ya Stock', asOf: 'Kufikia {time} leo. Kipindi ulichochagua hakitumiki hapa.', asOfDate: 'Kufikia {date}', sellingPrice: 'Bei ya kuuza',
    atRetail: 'Thamani kwa bei ya kuuza', atCost: 'Thamani kwa bei ya kununua', costPrice: 'Bei ya kununua', unknown: 'Haijulikani', units: 'Idadi ya Stock', products: 'Bidhaa',
    costUnknown: 'Bidhaa {n} zilizopo kwenye Stock hazina bei ya kununua, kwa hiyo hazimo kwenye thamani kwa bei ya kununua.',
    costUnknown_one: 'Bidhaa 1 iliyopo kwenye Stock haina bei ya kununua, kwa hiyo haimo kwenye thamani kwa bei ya kununua.',
    profit: 'Faida', netExVat: 'Mauzo baada ya makato bila VAT', commission: 'Kamisheni', cogs: 'Gharama ya bidhaa', margin: 'Asilimia ya faida', uncostedSales: 'Mauzo bila bei ya kununua',
    uncosted: 'Zimeuzwa bila bei ya kununua: bidhaa {n} · {amount}. Hazimo kwenye faida.', uncosted_one: 'Imeuzwa bila bei ya kununua: bidhaa 1 · {amount}. Haimo kwenye faida.', profitNoVat: 'Faida imehesabiwa bila VAT.',
    payouts: 'Mauzo ya app baada ya kamisheni', payoutsBasis: 'Oda za app pekee. Zimehesabiwa kwa tarehe ya delivery, sawa na taarifa zako za malipo.',
    orders: 'Oda', appSales: 'Mauzo ya app', youReceive: 'Unapokea', statement: 'Taarifa ya malipo',
    notDelivered: 'Zimelipiwa, bado delivery', waiting: 'Delivery imekamilika, inasubiri malipo', paidOut: 'Imelipwa', noStatement: 'Bado haiko kwenye taarifa', awaiting: 'Inasubiri malipo',
    customers: 'Wateja na madeni', owed: 'Unachodai', overdue: 'Yaliyochelewa', agingCurrent: 'Bado muda haujafika', aging1: 'Siku 1–30 za kuchelewa', aging31: 'Siku 31–60 za kuchelewa',
    aging61: 'Siku 61–90 za kuchelewa', aging90: 'Zaidi ya siku 90 za kuchelewa', creditSalesCount: 'Mauzo ya mkopo', creditSales: 'Mauzo ya mkopo', collected: 'Yaliyokusanywa kutoka kwa wateja',
    buyersShop: 'Wateja walionunua (dukani)', buyersApp: 'Wateja walionunua (app)',
    methods: 'Njia za malipo', group: 'Kundi', method: 'Njia', amount: 'Kiasi', count: 'Idadi', share: 'Sehemu',
    byYou: 'Uliyokusanya wewe', viaFitFlex: 'Yaliyolipwa kupitia FitFlex', netOfChange: 'Taslimu baada ya chenji',
    figure: 'Kipimo', value: 'Thamani', none: 'Hakuna',
    refundNumber: 'Hati ya marejesho', refundDate: 'Tarehe', saleNumber: 'Mauzo', restocked: 'Idadi iliyorudi kwenye Stock',
    method_: { cash: 'Taslimu', mpesa: 'M-Pesa', airtel_money: 'Airtel Money', mixx: 'Mixx by Yas', halopesa: 'HaloPesa', card: 'Kadi', bank: 'Uhamisho wa benki', other: 'Nyingine', unknown: 'Nyingine' },
    months: ['Jan', 'Feb', 'Mac', 'Apr', 'Mei', 'Jun', 'Jul', 'Ago', 'Sep', 'Okt', 'Nov', 'Des'],
  },
};
const fillIn = (template, values = {}) => String(template).replace(/\{(\w+)\}/g, (_, k) => (values[k] == null ? '' : String(values[k])));
/**
 * A label with a count (UAT D10): the key's `_one` form when n is 1 and the language has one ("1 sale",
 * "1 item", "1 day"), else the plural form with {n}.
 */
export const reportCount = (lang, key, n, values = {}) => {
  const table = REPORT_LABELS[lang === 'sw' ? 'sw' : 'en'];
  return reportLabel(lang, Number(n) === 1 && table[`${key}_one`] ? `${key}_one` : key, { ...values, n });
};
export const reportLabel = (lang, key, values) => fillIn(REPORT_LABELS[lang === 'sw' ? 'sw' : 'en'][key] ?? REPORT_LABELS.en[key] ?? key, values);
export const methodName = (lang, method) => REPORT_LABELS[lang === 'sw' ? 'sw' : 'en'].method_[method] || String(method || '');
/** A money column header: "Net sales (TZS)" / "Mauzo halisi (TZS)". */
const moneyHeader = (lang, key) => `${reportLabel(lang, key)} (TZS)`;

/** "1–31 Oct 2026", "28 Sep – 4 Oct 2026", "30 Dec 2025 – 2 Jan 2026", "14 Oct 2026". */
export function periodInWords(from, to, lang = 'en') {
  const months = REPORT_LABELS[lang === 'sw' ? 'sw' : 'en'].months;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (from === to) return `${fd} ${months[fm - 1]} ${fy}`;
  if (fy === ty && fm === tm) return `${fd}–${td} ${months[fm - 1]} ${fy}`;
  if (fy === ty) return `${fd} ${months[fm - 1]} – ${td} ${months[tm - 1]} ${ty}`;
  return `${fd} ${months[fm - 1]} ${fy} – ${td} ${months[tm - 1]} ${ty}`;
}

/** A time of day in EAT: English 24-hour "14:05"; Swahili 12-hour + day part "2:05 mchana" (glossary §5a). */
export function eatTimeOfDay(instant, lang = 'en') {
  const d = new Date(+new Date(instant) + EAT_MS);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return lang === 'sw' ? swahiliTime(h, m) : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
/**
 * "As of …": the time only when `asOf` is today in EAT ("As of 14:05 today" / "Kufikia 2:05 mchana leo"),
 * else the date ("As of 28 Oct 2026" / "Kufikia 28 Okt 2026").
 */
export function asOfText(lang, asOf, now = new Date()) {
  return eatToday(new Date(asOf)) === eatToday(now)
    ? reportLabel(lang, 'asOf', { time: eatTimeOfDay(asOf, lang) })
    : reportLabel(lang, 'asOfDate', { date: formatDay(eatToday(new Date(asOf)), lang) });
}

/** File names (§10): ASCII, no customer names. */
export const reportFileName = (businessName, section, from, to, ext) => `${slug(businessName || 'vendor')}_${section}_${from}${to && to !== from ? `_${to}` : ''}.${ext}`;

/** A report time in EAT as "YYYY-MM-DD HH:mm" (CSV) — or null. */
export const eatDateTime = instant => (instant ? new Date(+new Date(instant) + EAT_MS).toISOString().slice(0, 16).replace('T', ' ') : null);
export const eatDayOf = instant => (instant ? new Date(+new Date(instant) + EAT_MS).toISOString().slice(0, 10) : null);

// ── CSV tables (header + rows) per section; cost / payout columns only when allowed ──

export function salesCsv(data, lang) {
  const header = [reportLabel(lang, 'periodStart'), reportLabel(lang, 'periodEnd'), moneyHeader(lang, 'appNet'), moneyHeader(lang, 'shopNet'),
    moneyHeader(lang, 'gross'), moneyHeader(lang, 'discounts'), moneyHeader(lang, 'refunds'), moneyHeader(lang, 'net'), moneyHeader(lang, 'vatIncluded'),
    reportLabel(lang, 'salesCount'), reportLabel(lang, 'itemsSold')];
  const rows = data.buckets.map(b => {
    const t = sumChannels(b);
    return [b.start, b.end, b.app.netTzs, b.walkIn.netTzs, t.grossTzs, t.discountTzs, t.refundTzs, t.netTzs, t.vatIncludedTzs, t.count, t.itemsSold];
  });
  return { header, rows };
}
const sumChannels = b => ({
  grossTzs: b.app.grossTzs + b.walkIn.grossTzs, discountTzs: b.app.discountTzs + b.walkIn.discountTzs, refundTzs: b.app.refundTzs + b.walkIn.refundTzs,
  netTzs: b.app.netTzs + b.walkIn.netTzs, vatIncludedTzs: b.app.vatIncludedTzs + b.walkIn.vatIncludedTzs, count: b.app.count + b.walkIn.count,
  itemsSold: b.app.itemsSold + b.walkIn.itemsSold,
});

export const coverText = (lang, row) => (row.coverState === 'ok' || (row.coverState === 'soon' && row.daysOfCover >= 1)
  ? `${row.coverState === 'soon' ? `${reportLabel(lang, 'cover_soon')} · ` : ''}${reportCount(lang, 'cover_ok', row.daysOfCover)}`
  : row.coverState === 'soon' ? `${reportLabel(lang, 'cover_soon')} · ${reportLabel(lang, 'coverUnderOne')}` : reportLabel(lang, `cover_${row.coverState}`));
const productName = (lang, r) => `${r.name || ''}${r.removed ? ` ${reportLabel(lang, 'removed')}` : ''}`;

export function productsCsv(data, lang, { cost }) {
  const header = [reportLabel(lang, 'product'), reportLabel(lang, 'variant'), reportLabel(lang, 'unitsSold'), reportLabel(lang, 'appUnits'), reportLabel(lang, 'shopUnits'),
    moneyHeader(lang, 'revenue'), reportLabel(lang, 'lastSold'), reportLabel(lang, 'inStock'), reportLabel(lang, 'cover'), reportLabel(lang, 'coverStatus'),
    ...(cost ? [moneyHeader(lang, 'profit')] : [])];
  const rows = data.rows.map(r => [productName(lang, r), r.variant || '', r.unitsSold, r.appUnits, r.walkInUnits, r.netRevenueTzs, eatDayOf(r.lastSoldAt) || '',
    r.stock, r.daysOfCover, coverText(lang, r), ...(cost ? [r.profitTzs] : [])]);
  return { header, rows };
}

export function stockCsv(data, lang, { cost }) {
  const header = [reportLabel(lang, 'product'), reportLabel(lang, 'variant'), reportLabel(lang, 'inStock'), moneyHeader(lang, 'sellingPrice'), moneyHeader(lang, 'atRetail'),
    ...(cost ? [moneyHeader(lang, 'costPrice'), moneyHeader(lang, 'atCost')] : [])];
  const rows = data.rows.map(r => [r.name || '', r.variant || '', r.stock, r.priceTzs, r.valueAtRetailTzs, ...(cost ? [r.costTzs, r.valueAtCostTzs] : [])]);
  return { header, rows };
}

export function profitCsv(data, lang) {
  const header = [reportLabel(lang, 'periodStart'), reportLabel(lang, 'periodEnd'), moneyHeader(lang, 'netExVat'), moneyHeader(lang, 'commission'), moneyHeader(lang, 'cogs'),
    moneyHeader(lang, 'profit'), `${reportLabel(lang, 'margin')} (%)`, moneyHeader(lang, 'uncostedSales')];
  const rows = data.buckets.map(b => [b.start, b.end, b.netExVatTzs, b.commissionTzs, b.costTzs, b.profitTzs, b.marginPct, b.uncostedRevenueTzs]);
  return { header, rows };
}

export const statementLabel = (lang, w) => (!w.statement ? reportLabel(lang, 'noStatement') : w.statement.status === 'paid' ? reportLabel(lang, 'paidOut') : reportLabel(lang, 'awaiting'));
export function payoutsCsv(data, lang) {
  const header = [reportLabel(lang, 'weekStart'), reportLabel(lang, 'weekEnd'), reportLabel(lang, 'orders'), moneyHeader(lang, 'appSales'), moneyHeader(lang, 'commission'),
    moneyHeader(lang, 'youReceive'), reportLabel(lang, 'statement')];
  const rows = data.weeks.map(w => [w.periodStartDate, w.periodEndDate, w.orderCount, w.grossTzs, w.commissionTzs, w.payoutTzs, statementLabel(lang, w)]);
  return { header, rows };
}

export function customersCsv(data, lang) {
  const header = [moneyHeader(lang, 'owed'), moneyHeader(lang, 'overdue'), moneyHeader(lang, 'agingCurrent'), moneyHeader(lang, 'aging1'), moneyHeader(lang, 'aging31'),
    moneyHeader(lang, 'aging61'), moneyHeader(lang, 'aging90'), reportLabel(lang, 'creditSalesCount'), moneyHeader(lang, 'creditSales'), moneyHeader(lang, 'collected'),
    reportLabel(lang, 'buyersShop'), reportLabel(lang, 'buyersApp')];
  const a = data.aging;
  return { header, rows: [[data.owedTzs, data.overdueTzs, a.current, a.d1_30, a.d31_60, a.d61_90, a.d90plus, data.creditSales.count, data.creditSales.totalTzs, data.collectedTzs, data.buyers.shop, data.buyers.app]] };
}

/** Refunds (S7): header only until credit notes exist (UAT D16). */
export function refundsCsv(data, lang) {
  const header = [reportLabel(lang, 'refundNumber'), reportLabel(lang, 'refundDate'), reportLabel(lang, 'saleNumber'), moneyHeader(lang, 'amount'),
    reportLabel(lang, 'method'), reportLabel(lang, 'restocked')];
  return { header, rows: (data.rows || []).map(r => [r.number, eatDayOf(r.refundedAt), r.saleNumber, r.amountTzs, methodName(lang, r.method), r.restockedUnits]) };
}

export function methodsCsv(data, lang) {
  const header = [reportLabel(lang, 'group'), reportLabel(lang, 'method'), moneyHeader(lang, 'amount'), reportLabel(lang, 'count'), `${reportLabel(lang, 'share')} (%)`];
  const rows = [
    ...data.byYou.map(r => [reportLabel(lang, 'byYou'), r.method === 'cash' ? reportLabel(lang, 'netOfChange') : methodName(lang, r.method), r.amountTzs, r.count, r.sharePct]),
    ...data.viaFitFlex.map(r => [reportLabel(lang, 'viaFitFlex'), methodName(lang, r.paymentMethod), r.amountTzs, r.count, r.sharePct]),
  ];
  return { header, rows };
}
