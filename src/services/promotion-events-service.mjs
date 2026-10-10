// Promotion events — taking in what the apps observed, crediting purchases the
// server can verify, and clearing old rows. Nothing is invented: an event is
// stored only if a client sent it (and it passes the checks) or the server saw
// it happen.
import { randomUUID } from 'node:crypto';
import { verifyServedToken, tokenMode } from '../auth/promotion-token.mjs';
import {
  validateClientEvent, dedupeKey, MAX_BATCH, ATTRIBUTION_WINDOW_DAYS, RETENTION_MONTHS, SESSION_EVENT_CAPS, SESSION_HOURLY_CAP,
} from '../shared/promotion-events.mjs';

const TABLE = 'PromotionEvent';
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
/** Promotions that have actually been shown to customers; a draft or rejected one has no audience. */
const START_SLACK_MS = 15 * 60_000;
const END_SLACK_MS = 6 * 3_600_000;
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
    // Only the promotions named, by id: this is called on every scroll of every app, so it must not read the whole table.
    const known = new Map((ids.length ? await db('Promotion').whereIn('id', ids).select('id', 'entityType', 'entityId', 'status', 'campaignId', 'startsAt', 'endsAt') : []).map(p => [p.id, p]));

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
      // An event is about a time the promotion was running (a little before its start for the scheduler's lag, a while after its end for offline phones).
      if (v.at < new Date(new Date(p.startsAt).getTime() - START_SLACK_MS) || v.at > new Date(new Date(p.endsAt).getTime() + END_SLACK_MS)) return rejected.push({ index, error: 'outside_promotion_period' });
      // Proof that the card was really served to this session. A token that is present must be right (a bad one is
      // a forgery or a bug, never kept). With none, an older app build is still kept, but as unverified: it is not
      // counted anywhere, so nothing can be added to a promotion's numbers without having been served it.
      let verified = false;
      if (v.token) {
        const check = verifyServedToken(v.token, { promotionId: p.id, entityType: v.entityType, entityId: v.entityId, sessionId: v.sessionId, at: v.at, now: at });
        if (!check.ok) return rejected.push({ index, error: 'invalid_token' });
        verified = true;
      } else if (tokenMode() === 'required') {
        return rejected.push({ index, error: 'token_required' });
      }
      rows.push({
        index,
        verified,
        id: randomUUID(), at: v.at, event: v.event, entityType: v.entityType, entityId: v.entityId, promotionId: p.id,
        campaignId: p.campaignId || null, placement: v.placement, userId, sessionId: v.sessionId, source, valueTzs: null,
        // The repeat window is counted on our clock, not the phone's, so a client cannot mint a new window by changing its time.
        // Unverified events get their own keys, so one can never use up a verified event's repeat window.
        dedupeKey: (k => (k && !verified ? `u:${k}` : k))(dedupeKey({ ...v, at })),
      });
    });

    // One session cannot pile up taps or saves on a promotion without limit.
    const allowed = await withinSessionLimits(rows, rejected, at);
    let inserted = 0;
    if (allowed.length) {
      const out = await db(TABLE).insert(allowed.map(({ index, ...row }) => row)).onConflict('dedupeKey').ignore().returning('id');
      inserted = out.length;
    }
    return {
      accepted: inserted, duplicates: allowed.length - inserted, rejected: rejected.sort((a, b) => a.index - b.index),
      // Kept but not counted (older builds): the app can see it is not sending proof.
      unverified: allowed.filter(r => !r.verified).length,
    };
  }

  /**
   * Drop events beyond what one session may credit in an hour (see SESSION_EVENT_CAPS and
   * SESSION_HOURLY_CAP), counting what it already sent as well as what is in this batch.
   * Refused ones are added to `rejected` with the reason 'session_limit'.
   */
  async function withinSessionLimits(rows, rejected, at) {
    if (!rows.length) return rows;
    const since = new Date(at.getTime() - 3_600_000);
    const sessions = [...new Set(rows.map(r => r.sessionId))];
    const capped = Object.keys(SESSION_EVENT_CAPS);
    const per = new Map();
    const total = new Map();
    const { rows: perRows } = await db.raw(
      `select "sessionId", "promotionId", "event", count(*)::int as c from "${TABLE}" where "sessionId" = any(?) and "at" >= ? and "event" = any(?) group by 1, 2, 3`,
      [sessions, since, capped]);
    for (const r of perRows) per.set(`${r.sessionId}|${r.promotionId}|${r.event}`, r.c);
    const { rows: totalRows } = await db.raw(`select "sessionId", count(*)::int as c from "${TABLE}" where "sessionId" = any(?) and "at" >= ? group by 1`, [sessions, since]);
    for (const r of totalRows) total.set(r.sessionId, r.c);
    const kept = [];
    for (const r of rows) {
      const key = `${r.sessionId}|${r.promotionId}|${r.event}`;
      const cap = SESSION_EVENT_CAPS[r.event];
      if ((cap !== undefined && (per.get(key) || 0) >= cap) || (total.get(r.sessionId) || 0) >= SESSION_HOURLY_CAP) {
        rejected.push({ index: r.index, error: 'session_limit' });
        continue;
      }
      per.set(key, (per.get(key) || 0) + 1);
      total.set(r.sessionId, (total.get(r.sessionId) || 0) + 1);
      kept.push(r);
    }
    return kept;
  }

  /**
   * A shop order was paid: credit each product to the promotion the buyer
   * tapped in the last week, if there was one.
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
          .where('event', 'click').where('verified', true)
          .whereNotNull('promotionId').where('at', '>=', since)
          .orderBy('at', 'desc').first('promotionId', 'campaignId', 'placement');
        if (!touch) continue;
        const value = Math.max(Math.round(Number(item.priceTzs || 0) * Number(item.qty || 1)), 0);
        const out = await db(TABLE).insert({
          id: randomUUID(), at: now(), event: 'purchase', entityType: 'product', entityId: item.productId, promotionId: touch.promotionId,
          campaignId: touch.campaignId, placement: touch.placement, userId: order.buyerId, sessionId: `server:${order.id}`, source: 'server',
          valueTzs: value, verified: true, dedupeKey: `purchase:${order.id}:${item.productId}`,
        }).onConflict('dedupeKey').ignore().returning('id');
        credited += out.length;
      }
      return { credited };
    } catch (err) {
      console.warn('[promotion-events] purchase not credited:', err?.message);
      return { credited: 0 };
    }
  }

  /**
   * The promotion a customer opened (a verified tap on its card) for this listing in the week before a purchase,
   * request or booking, or null. `at` is the moment the customer asked (not when staff confirmed the payment), so a
   * slow approval does not lose the credit; a tap after that moment cannot have caused it.
   */
  async function lastTap({ userId, entityType, entityId, at }) {
    const until = new Date(at.getTime() + 5 * 60_000);
    const since = new Date(at.getTime() - ATTRIBUTION_WINDOW_DAYS * 86_400_000);
    return db(TABLE)
      .where({ userId, entityType, entityId, event: 'click', verified: true }).whereNotNull('promotionId')
      .where('at', '>=', since).where('at', '<=', until)
      .orderBy('at', 'desc').first('promotionId', 'campaignId', 'placement');
  }

  /** Record one conversion for the promotion that was tapped, once (`key` makes it idempotent). Never throws. */
  async function credit({ event, key, userId, entityType, entityId, requestedAt, valueTzs = null, sessionId }) {
    try {
      if (!userId || !entityId) return { credited: 0 };
      const at = requestedAt ? new Date(requestedAt) : now();
      const touch = await lastTap({ userId, entityType, entityId, at: Number.isNaN(at.getTime()) ? now() : at });
      if (!touch) return { credited: 0 };
      const out = await db(TABLE).insert({
        id: randomUUID(), at: now(), event, entityType, entityId, promotionId: touch.promotionId, campaignId: touch.campaignId,
        placement: touch.placement, userId, sessionId, source: 'server', valueTzs, verified: true, dedupeKey: key,
      }).onConflict('dedupeKey').ignore().returning('id');
      return { credited: out.length };
    } catch (err) {
      console.warn(`[promotion-events] ${event} not credited:`, err?.message);
      return { credited: 0 };
    }
  }

  /** Take a conversion back (a refund, a rejected or cancelled payment). Idempotent; never throws. */
  async function takeBack(key) {
    try { return { reversed: await db(TABLE).where({ dedupeKey: key, source: 'server' }).del() }; }
    catch (err) { console.warn('[promotion-events] conversion not taken back:', err?.message); return { reversed: 0 }; }
  }

  /**
   * A trainer booking (one request, however many sessions) is confirmed: free, or its payment approved.
   * Credited to the trainer promotion the member tapped in the week before they asked.
   */
  const recordBooking = bookings => {
    const first = bookings?.[0];
    if (!first) return { credited: 0 };
    const groupId = first.groupId || first.id;
    const earliest = bookings.map(b => b.createdAt).filter(Boolean).sort()[0];
    const tzs = bookings.every(b => !b.currency || b.currency === 'TZS');
    return credit({
      event: 'booking', key: `booking:${groupId}`, userId: first.memberId, entityType: 'trainer', entityId: first.trainerId,
      requestedAt: earliest, sessionId: `server:booking:${groupId}`,
      valueTzs: tzs ? Math.max(Math.round(bookings.reduce((n, b) => n + Number(b.amountTzs || 0), 0)), 0) : null,
    });
  };
  const reverseBooking = groupId => takeBack(`booking:${groupId}`);

  /**
   * A gym membership (a direct plan at that gym, or a pass with a home gym) became active because it was paid for.
   * Credited to the gym promotion the member tapped in the week before they asked for it. A pass with no home gym
   * is not about any one gym, so it is credited to none.
   */
  const recordSubscription = (sub, ctx = {}) => {
    if (!sub?.id || !sub.homeGymId || !['direct_sub', 'platform_pass'].includes(sub.type)) return { credited: 0 };
    return credit({
      event: 'subscription', key: `subscription:${sub.id}`, userId: sub.memberId, entityType: 'gym', entityId: sub.homeGymId,
      requestedAt: ctx.requestedAt, sessionId: `server:subscription:${sub.id}`,
      valueTzs: Number.isFinite(Number(ctx.amountTzs)) ? Math.max(Math.round(Number(ctx.amountTzs)), 0) : null,
    });
  };
  const reverseSubscription = sub => takeBack(`subscription:${sub?.id}`);

  /** An order was cancelled or refunded: what it was credited for is taken back, so purchases and revenue are not overstated. */
  async function reversePaidOrder(order) {
    try {
      if (!order?.id) return { reversed: 0 };
      const reversed = await db(TABLE).where('dedupeKey', 'like', `purchase:${order.id}:%`).del();
      return { reversed };
    } catch (err) {
      console.warn('[promotion-events] purchase not reversed:', err?.message);
      return { reversed: 0 };
    }
  }

  /** The customer deleted their account: their events stay as counts but no longer say who. */
  async function forgetUser(userId) {
    if (!userId) return { cleared: 0 };
    return { cleared: await db(TABLE).where({ userId }).update({ userId: null }) };
  }

  /** Delete raw events older than the retention period (calendar months back, clamped to the month's length). Idempotent. */
  async function purge({ months = RETENTION_MONTHS } = {}) {
    const cutoff = new Date(now());
    const day = cutoff.getUTCDate();
    cutoff.setUTCDate(1);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
    cutoff.setUTCDate(Math.min(day, new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate()));
    const deleted = await db(TABLE).where('at', '<', cutoff).del();
    return { deleted, cutoff: cutoff.toISOString() };
  }

  return { ingest, recordPaidOrder, reversePaidOrder, recordBooking, reverseBooking, recordSubscription, reverseSubscription, forgetUser, purge };
}
