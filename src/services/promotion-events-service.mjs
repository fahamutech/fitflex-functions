// Promotion events — taking in what the apps observed, crediting purchases the
// server can verify, and clearing old rows. Nothing is invented: an event is
// stored only if a client sent it (and it passes the checks) or the server saw
// it happen.
import { randomUUID } from 'node:crypto';
import { validateClientEvent, dedupeKey, MAX_BATCH, ATTRIBUTION_WINDOW_DAYS, RETENTION_MONTHS } from '../shared/promotion-events.mjs';

const TABLE = 'PromotionEvent';
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
/** Promotions that have actually been shown to customers; a draft or rejected one has no audience. */
const SERVED = new Set(['approved', 'scheduled', 'active', 'paused', 'expired', 'completed', 'cancelled']);

export function createPromotionEventsService({ db, promotions, now = () => new Date() }) {
  /**
   * Store a batch from an app. Each event is checked on its own: a bad one is
   * reported and skipped, the rest are kept. An event must name a promotion,
   * and that promotion must be for the entity it claims, so nobody can add
   * numbers to someone else's promotion.
   */
  async function ingest({ events, userId = null, source = 'mobile' }) {
    if (!Array.isArray(events) || events.length === 0) return fail('events_required', 400);
    if (events.length > MAX_BATCH) return fail('batch_too_large', 413, { max: MAX_BATCH });
    if (!['mobile', 'web'].includes(source)) return fail('invalid_source', 400);
    const at = now();
    const checked = events.map(raw => validateClientEvent(raw, at));
    const ids = [...new Set(checked.filter(c => c.value?.promotionId).map(c => c.value.promotionId))];
    const known = new Map((ids.length ? await promotions.filterAsync(p => ids.includes(p.id)) : []).map(p => [p.id, p]));

    const rows = [];
    const rejected = [];
    checked.forEach((c, index) => {
      if (c.error) return rejected.push({ index, error: c.error });
      const v = c.value;
      if (!v.promotionId) return rejected.push({ index, error: 'promotion_required' });
      const p = known.get(v.promotionId);
      if (!p) return rejected.push({ index, error: 'promotion_not_found' });
      if (p.entityType !== v.entityType || p.entityId !== v.entityId) return rejected.push({ index, error: 'promotion_mismatch' });
      if (!SERVED.has(p.status)) return rejected.push({ index, error: 'promotion_not_served' });
      rows.push({
        id: randomUUID(), at: v.at, event: v.event, entityType: v.entityType, entityId: v.entityId, promotionId: p.id,
        campaignId: p.campaignId || null, placement: v.placement, userId, sessionId: v.sessionId, source, valueTzs: null,
        dedupeKey: dedupeKey(v),
      });
    });

    let inserted = 0;
    if (rows.length) {
      const out = await db(TABLE).insert(rows).onConflict('dedupeKey').ignore().returning('id');
      inserted = out.length;
    }
    return { accepted: inserted, duplicates: rows.length - inserted, rejected };
  }

  /**
   * A shop order was paid: credit each product to the promotion the buyer
   * opened (a click or a product page) in the last week, if there was one.
   * Safe to call twice for an order; it never throws into the order.
   */
  async function recordPaidOrder(order) {
    try {
      if (!order?.buyerId || !Array.isArray(order.items)) return { credited: 0 };
      const since = new Date(now().getTime() - ATTRIBUTION_WINDOW_DAYS * 86_400_000);
      let credited = 0;
      for (const item of order.items) {
        const touch = await db(TABLE)
          .where({ userId: order.buyerId, entityType: 'product', entityId: item.productId })
          .whereIn('event', ['click', 'detail_view'])
          .whereNotNull('promotionId').where('at', '>=', since)
          .orderBy('at', 'desc').first('promotionId', 'campaignId', 'placement');
        if (!touch) continue;
        const value = Math.max(Math.round(Number(item.priceTzs || 0) * Number(item.qty || 1)), 0);
        const out = await db(TABLE).insert({
          id: randomUUID(), at: now(), event: 'purchase', entityType: 'product', entityId: item.productId, promotionId: touch.promotionId,
          campaignId: touch.campaignId, placement: touch.placement, userId: order.buyerId, sessionId: `server:${order.id}`, source: 'server',
          valueTzs: value, dedupeKey: `purchase:${order.id}:${item.productId}`,
        }).onConflict('dedupeKey').ignore().returning('id');
        credited += out.length;
      }
      return { credited };
    } catch (err) {
      console.warn('[promotion-events] purchase not credited:', err?.message);
      return { credited: 0 };
    }
  }

  /** Delete raw events older than the retention period. Idempotent. */
  async function purge({ months = RETENTION_MONTHS } = {}) {
    const cutoff = new Date(now());
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
    const deleted = await db(TABLE).where('at', '<', cutoff).del();
    return { deleted, cutoff: cutoff.toISOString() };
  }

  return { ingest, recordPaidOrder, purge };
}
