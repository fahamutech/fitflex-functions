// Promotion analytics — what the recorded events add up to. Counts and ratios
// only, from real rows; a step the apps cannot observe yet (completed bookings
// and subscriptions) is reported as not tracked, never as zero.
import { rates, emptyTotals } from '../shared/promotion-events.mjs';
import { PLACEMENTS } from '../shared/promotion-config.mjs';

const TABLE = 'PromotionEvent';
const EAT = 'Africa/Dar_es_Salaam';
const DAY = 86_400_000;
const MAX_RANGE_DAYS = 400;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const fail = (error, status, extra = {}) => ({ error, status, ...extra });

/** The columns every aggregation selects, as one expression list. */
const COUNTS = `
  count(*) filter (where "event" = 'impression')::int as "impressions",
  count(*) filter (where "event" = 'impression' and "placement" = 'search_results')::int as "searchAppearances",
  count(*) filter (where "event" = 'click')::int as "clicks",
  count(*) filter (where "event" = 'detail_view')::int as "detailViews",
  count(*) filter (where "event" = 'save')::int as "saves",
  count(*) filter (where "event" = 'booking_click')::int as "bookingClicks",
  count(*) filter (where "event" = 'subscription_click')::int as "subscriptionClicks",
  count(*) filter (where "event" = 'booking')::int as "bookings",
  count(*) filter (where "event" = 'subscription')::int as "subscriptions",
  count(*) filter (where "event" = 'purchase')::int as "purchases",
  coalesce(sum("valueTzs") filter (where "event" = 'purchase'), 0)::bigint as "purchaseValueTzs",
  count(distinct coalesce("userId", "sessionId")) filter (where "event" = 'impression')::int as "uniqueViewers"`;

/** What the apps cannot observe yet, so the dashboard can say so. */
export const NOT_TRACKED = Object.freeze(['booking_conversions', 'subscription_conversions']);

const withRates = t => ({ ...t, ...rates(t) });
// bigint sums arrive as text; every total is a plain number.
const fromRow = r => ({ ...emptyTotals(), ...Object.fromEntries(Object.entries(r || {}).filter(([k]) => k in emptyTotals()).map(([k, v]) => [k, Number(v)])) });

export function createPromotionAnalyticsService({ db, promotions, campaigns, entities, now = () => new Date() }) {
  const eatDay = d => new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
  const startOfDay = day => new Date(`${day}T00:00:00+03:00`);

  /** The range as EAT calendar days, defaulting to the last 30; `to` is inclusive. */
  function range({ from, to } = {}) {
    const toDay = to ?? eatDay(now());
    const fromDay = from ?? eatDay(new Date(startOfDay(toDay).getTime() - 29 * DAY));
    // A real calendar day: 30 February would otherwise be quietly read as 2 March.
    const real = d => DAY_RE.test(d) && !Number.isNaN(startOfDay(d).getTime()) && eatDay(startOfDay(d)) === d;
    if (![fromDay, toDay].every(real)) return fail('invalid_range', 400);
    const start = startOfDay(fromDay);
    const end = new Date(startOfDay(toDay).getTime() + DAY);
    if (end <= start) return fail('invalid_range', 400);
    if ((end - start) / DAY > MAX_RANGE_DAYS) return fail('range_too_long', 400, { maxDays: MAX_RANGE_DAYS });
    return { from: fromDay, to: toDay, start, end };
  }

  async function aggregate({ start, end, ids, placement, groupBy = null }) {
    const sel = groupBy ? `${groupBy} as "key", ${COUNTS}` : COUNTS;
    const sql = `select ${sel} from "${TABLE}" where "promotionId" = any(?) and "at" >= ? and "at" < ?${placement ? ' and "placement" = ?' : ''}${groupBy ? ` group by ${groupBy}` : ''}`;
    const { rows } = await db.raw(sql, [ids, start, end, ...(placement ? [placement] : [])]);
    return rows;
  }

  async function describe(p) {
    const e = await entities.get(p.entityType, p.entityId);
    return {
      id: p.id, type: p.type, status: p.status, entityType: p.entityType, entityId: p.entityId, entityName: e ? entities.summary(p.entityType, e).name : null,
      startsAt: p.startsAt, endsAt: p.endsAt, campaignId: p.campaignId, isCommercial: p.isCommercial,
    };
  }

  /** Performance of every promotion (optionally filtered), including those with no events yet. */
  async function summary(q = {}) {
    const r = range(q);
    if (r.error) return r;
    if (q.placement !== undefined && !(typeof q.placement === 'string' && PLACEMENTS[q.placement])) return fail('invalid_placement', 400);
    let list = (await promotions.allAsync()).filter(p => p.status !== 'draft' && p.status !== 'pending_approval' && p.status !== 'rejected');
    if (q.type) list = list.filter(p => p.type === q.type);
    if (q.entityType) list = list.filter(p => p.entityType === q.entityType);
    if (q.campaignId) list = list.filter(p => p.campaignId === q.campaignId);
    // A promotion is listed if its period touches the range or it has events in it.
    const ids = list.map(p => p.id);
    const empty = { range: { from: r.from, to: r.to }, totals: withRates(emptyTotals()), items: [], notTracked: NOT_TRACKED };
    if (!ids.length) return empty;
    const per = new Map((await aggregate({ ...r, ids, placement: q.placement, groupBy: '"promotionId"' })).map(x => [x.key, fromRow(x)]));
    const totals = fromRow((await aggregate({ ...r, ids, placement: q.placement }))[0]);
    const items = [];
    for (const p of list) {
      const t = per.get(p.id);
      const overlaps = new Date(p.startsAt) < r.end && new Date(p.endsAt) >= r.start;
      if (!t && !overlaps) continue;
      items.push({ promotion: await describe(p), ...withRates(t || emptyTotals()) });
    }
    items.sort((a, b) => b.impressions - a.impressions || String(a.promotion.id).localeCompare(String(b.promotion.id)));
    return { range: { from: r.from, to: r.to }, totals: withRates(totals), items, notTracked: NOT_TRACKED };
  }

  /** One promotion: totals, a funnel, per placement and per day (EAT), with empty days filled in. */
  async function detail(id, q = {}) {
    const r = range(q);
    if (r.error) return r;
    const p = await promotions.findByIdAsync(id);
    if (!p) return fail('promotion_not_found', 404);
    const ids = [id];
    const totals = fromRow((await aggregate({ ...r, ids }))[0]);
    const byPlacement = (await aggregate({ ...r, ids, groupBy: 'coalesce("placement", \'unknown\')' })).map(x => ({ placement: x.key, ...withRates(fromRow(x)) }));
    const byDay = new Map((await aggregate({ ...r, ids, groupBy: `to_char("at" AT TIME ZONE '${EAT}', 'YYYY-MM-DD')` })).map(x => [x.key, fromRow(x)]));
    const daily = [];
    for (let t = r.start.getTime(); t < r.end.getTime(); t += DAY) {
      const day = eatDay(new Date(t));
      daily.push({ day, ...(byDay.get(day) || emptyTotals()) });
    }
    const rt = rates(totals);
    return {
      promotion: await describe(p), range: { from: r.from, to: r.to }, totals: { ...totals, ...rt }, daily, byPlacement,
      funnel: [
        { step: 'impressions', count: totals.impressions }, { step: 'clicks', count: totals.clicks }, { step: 'detailViews', count: totals.detailViews },
        { step: 'actionClicks', count: totals.bookingClicks + totals.subscriptionClicks }, { step: 'conversions', count: rt.conversions },
      ],
      notTracked: NOT_TRACKED,
    };
  }

  /** A campaign: its promotions' totals together, and each promotion's own. */
  async function campaign(id, q = {}) {
    const c = await campaigns.findByIdAsync(id);
    if (!c) return fail('campaign_not_found', 404);
    const s = await summary({ ...q, campaignId: id });
    if (s.error) return s;
    return { campaign: { id: c.id, name: c.name, status: c.status, startsAt: c.startsAt, endsAt: c.endsAt }, ...s };
  }

  return { range, summary, detail, campaign };
}
