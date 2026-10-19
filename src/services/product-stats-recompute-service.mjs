// One-off (and repeatable) repair of the shop's denormalised product stats:
// Product.rating, Product.reviewCount and Product.soldCount.
//
// Before functions#178 a vendor could type these on product create. Since then the server alone keeps them:
//
//   rating / reviewCount — shop-service reviewProduct(): after a review is saved, reviewCount = number of
//     ProductReview rows for the product, rating = their plain average (sum / count, no rounding in code;
//     the column is numeric(3,2), so Postgres stores it rounded half away from zero to 2 decimals).
//     No rows → the create path's 0 / 0.
//
//   soldCount — the order store (src/infra/shop-order-store-pg.mjs, mirrored by shop-order-store-memory.mjs):
//     + qty for every line when an order reserves its stock (placeOrder, and reviveOrder for a late payment),
//     - qty (floored at 0) when a cancel gives that stock back (cancelAndRelease, only while stockState is
//     'reserved'). So the live counter is: the sum of line qty (> 0) over every ShopOrder whose stockState is
//     'reserved' — paid or not, any fulfilment status, delivered included; 'released' (cancelled / expired)
//     orders do not count. Walk-in (POS) sales never touch it.
//
// This service recomputes those three values from the rows and, with apply, writes only the ones that differ.
// It never touches any other column (not price, stock, updatedAt or anything else). Apply runs in one
// transaction under a cluster-wide advisory lock (a second apply at the same time is refused) with the
// products row-locked, and writes one AuditLog row with every before/after. Running it twice changes nothing.
import { randomUUID } from 'node:crypto';

export const PRODUCT_STATS_LOCK = 'fitflex:shop:product-stats-recompute';
export const PRODUCT_STATS_AUDIT_ACTION = 'admin_product_stats_recomputed';
export const MAX_PRODUCT_IDS = 1000;

// A line quantity as the order store reads it: Number(item.qty || 0), counted only when above zero.
// jsonb numbers and numeric strings both count, like Number() would; anything else is 0.
const LINE_QTY = `CASE
  WHEN jsonb_typeof(i->'qty') = 'number' THEN (i->>'qty')::numeric
  WHEN jsonb_typeof(i->'qty') = 'string' AND btrim(i->>'qty') ~ '^[0-9]+(\\.[0-9]+){0,1}$' THEN btrim(i->>'qty')::numeric
  ELSE 0 END`;

const statsOf = row => ({
  rating: row.rating == null ? null : Number(row.rating),
  reviewCount: row.reviewCount == null ? null : Number(row.reviewCount),
  soldCount: row.soldCount == null ? null : Number(row.soldCount),
});
const same = (a, b) => a.rating === b.rating && a.reviewCount === b.reviewCount && a.soldCount === b.soldCount;

/** Validates the optional subset. → { ids: string[] | null } | { error, status } */
export function parseProductIds(value) {
  if (value === undefined || value === null) return { ids: null };
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) {
    return { error: 'invalid_product_ids', status: 400 };
  }
  const ids = [...new Set(value.map(id => id.trim()))];
  if (!ids.length) return { error: 'invalid_product_ids', status: 400 };
  if (ids.length > MAX_PRODUCT_IDS) return { error: 'too_many_product_ids', status: 400, max: MAX_PRODUCT_IDS };
  return { ids };
}

export function createProductStatsRecomputeService({ db, now = () => new Date() }) {
  /**
   * Stored vs expected for every product (or the subset), ordered by id. Runs on `q` (the db or a transaction).
   * The expected rating is cast to the column's type, so it is exactly what the review path would leave stored.
   */
  async function compare(q, ids, { lock = false } = {}) {
    const products = q('Product').select('id', 'name', 'vendorId', 'rating', 'reviewCount', 'soldCount').orderBy('id');
    if (ids) products.whereIn('id', ids);
    if (lock) products.forUpdate();
    const rows = await products;
    if (!rows.length) return [];
    const productIds = rows.map(r => r.id);

    const reviews = await q('ProductReview').whereIn('productId', productIds).groupBy('productId')
      .select('productId', q.raw('COUNT(*)::int AS n'), q.raw('(SUM(rating)::numeric / COUNT(*))::numeric(3,2) AS avg'));
    const sold = (await q.raw(`
      SELECT i->>'productId' AS "productId", SUM(${LINE_QTY})::bigint AS qty
        FROM "ShopOrder" o
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END) i
       WHERE o."stockState" = 'reserved'
         AND i->>'productId' = ANY(?)
         AND ${LINE_QTY} > 0
       GROUP BY 1`, [productIds])).rows;

    const reviewsBy = new Map(reviews.map(r => [r.productId, r]));
    const soldBy = new Map(sold.map(r => [r.productId, Number(r.qty)]));
    return rows.map(row => {
      const review = reviewsBy.get(row.id);
      const after = {
        rating: review ? Number(review.avg) : 0,
        reviewCount: review ? Number(review.n) : 0,
        soldCount: soldBy.get(row.id) ?? 0,
      };
      return { productId: row.id, name: row.name, vendorId: row.vendorId, before: statsOf(row), after };
    });
  }

  function summarise(results, dryRun) {
    const changed = results.filter(r => !same(r.before, r.after));
    return { dryRun, checked: results.length, changed, unchanged: results.length - changed.length };
  }

  /**
   * apply false (default): read only. apply true: write the differences, audit, all in one transaction.
   * → { dryRun, checked, changed[], unchanged, appliedAt?, runId? } | { error, status }
   */
  async function recompute({ apply = false, productIds = undefined, actorId = null } = {}) {
    const parsed = parseProductIds(productIds);
    if (parsed.error) return parsed;
    const ids = parsed.ids;
    if (!apply) return summarise(await compare(db, ids), true);

    return db.transaction(async (trx) => {
      const { rows: [{ ok }] } = await trx.raw('select pg_try_advisory_xact_lock(hashtext(?)) as ok', [PRODUCT_STATS_LOCK]);
      if (!ok) return { error: 'recompute_in_progress', status: 409 };
      // Products locked first (in id order, as checkout does), then counted: an order or review that
      // committed before the lock is in the count; one that comes after waits for this to finish.
      const result = summarise(await compare(trx, ids, { lock: true }), false);
      for (const item of result.changed) {
        await trx('Product').where({ id: item.productId }).update(item.after);
      }
      const at = now();
      const runId = `psr_${randomUUID()}`;
      await trx('AuditLog').insert({
        id: runId, at, actor: actorId ?? null, action: PRODUCT_STATS_AUDIT_ACTION, target: ids ? `products:${ids.length}` : 'products:all',
        before: JSON.stringify(result.changed.map(c => ({ productId: c.productId, ...c.before }))),
        after: JSON.stringify({
          checked: result.checked, changed: result.changed.length, unchanged: result.unchanged,
          productIds: ids, products: result.changed.map(c => ({ productId: c.productId, ...c.after })),
        }),
      });
      return { ...result, appliedAt: at.toISOString(), runId };
    });
  }

  return { recompute };
}
