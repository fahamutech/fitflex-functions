// Postgres queries for vendor reports (vendor business tools · S6). Read only.
//
// Every query is vendor-scoped and parameterised and aggregates in SQL; nothing loads a whole table:
// - walk-in sales by VendorSale (vendorId, soldAt) — index from S3;
// - app orders by the ShopOrder.items GIN index (jsonb containment on the vendor's id, S2) plus
//   ShopOrder.paidAt (S6), then only this vendor's lines (item.vendorId);
// - EAT days and buckets are worked out in SQL: (instant AT TIME ZONE 'Africa/Dar_es_Salaam')::date, and a
//   period's bounds are (date)::timestamp AT TIME ZONE 'Africa/Dar_es_Salaam' (Q-16).
//
// Definitions (design spec §1, decided 2026-10-22):
// - walk-in: VendorSale status completed, dated soldAt (late / offline sales count on soldAt). Gross =
//   Σ qty × unitPriceTzs; discounts = line discounts + the line's share of the sale discount; net = lineTotal −
//   share; VAT included = the line's vatTzs (inside net, never added); cost = qty × unitCostTzs (null = unknown).
//   Voided sales are in no total; they are counted apart ("Voided (not counted)") on their sale day.
// - app order (this vendor's lines only): dated by paidAt. Gross = net = Σ qty × priceTzs; commission = the
//   lines' commissionTzs; VAT included = the vendor's VendorOrderInvoice lines (0 without an invoice); cost =
//   ShopOrderLineCost (missing / null = unknown). A paid order later cancelled is a REFUND on its cancellation
//   date (its last "cancelled" timeline entry, else updatedAt): the whole vendor share, VAT, commission and
//   cost are reversed there; the paid day is left as it was (Q-4). An order paid only after it was cancelled
//   has no paidAt and is never a sale.
// - marketplace net (App sales after commission): the vendor settlement rules exactly — paid and delivered
//   orders, by the EAT date of their last "delivered" timeline entry (vendorShareOfOrder / deliveredOn in
//   vendor-settlement-service.mjs), orders already on a statement the vendor can see are grouped under that
//   statement's week with the statement line's own figures.
import { VISIBLE_TO_PARTNER } from '../services/partner-statement-workflow.mjs';

const TZ = 'Africa/Dar_es_Salaam';
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const n = v => (v == null ? 0 : Number(v));
const containment = vendorId => JSON.stringify([{ vendorId: String(vendorId) }]);
const eatDay = col => `((${col}) AT TIME ZONE '${TZ}')::date`;
const arr = col => `(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END)`;
/** The instant a cancelled order was cancelled: its last "cancelled" timeline entry, else updatedAt. */
const CANCELLED_AT = `(CASE WHEN o.status = 'cancelled' THEN COALESCE(
  (SELECT max((e->>'at')::timestamptz) FROM jsonb_array_elements(${arr('o.timeline')}) e
    WHERE e->>'status' = 'cancelled' AND e->>'at' ~ '^\\d{4}-\\d{2}-\\d{2}T'), o."updatedAt") END)`;
const BOUNDS = `bounds AS (SELECT ((?::date)::timestamp AT TIME ZONE '${TZ}') AS t0, (((?::date) + 1)::timestamp AT TIME ZONE '${TZ}') AS t1)`;

export function createPgVendorReportStore({ db }) {
  /**
   * The CTE list ending in `facts`: one row per walk-in sale line and per (app order, product, variant) of
   * this vendor, dated in EAT, for [from, to]. Columns: channel walk_in|app, kind sale|refund, doc_id, day,
   * product_id, variant ('' = none), name, qty (units sold; 0 on refunds), refund_qty, gross, discount,
   * refund, net (negative on refunds), vat, commission, cost (null = unknown), at, buyer.
   */
  function factsCte({ vendorId, from, to, channel = 'all' }) {
    const sql = `WITH ${BOUNDS},
      walk AS (
        SELECT 'walk_in'::text AS channel, 'sale'::text AS kind, s.id AS doc_id, ${eatDay('s."soldAt"')} AS day,
               l."productId" AS product_id, l.variant AS variant, l."nameSnapshot" AS name,
               l.qty::bigint AS qty, 0::bigint AS refund_qty, l.qty::bigint * l."unitPriceTzs" AS gross,
               (l."discountTzs" + l."saleDiscountShareTzs")::bigint AS discount, 0::bigint AS refund,
               (l."lineTotalTzs" - l."saleDiscountShareTzs")::bigint AS net, l."vatTzs"::bigint AS vat, 0::bigint AS commission,
               CASE WHEN l."unitCostTzs" IS NULL THEN NULL ELSE l.qty::bigint * l."unitCostTzs" END AS cost,
               s."soldAt" AS at, s."customerId" AS buyer
          FROM "VendorSale" s JOIN "VendorSaleLine" l ON l."saleId" = s.id AND l."vendorId" = s."vendorId", bounds b
         WHERE s."vendorId" = ? AND s.status = 'completed' AND s."soldAt" >= b.t0 AND s."soldAt" < b.t1
      ),
      app_in AS (
        SELECT o.id, o."paidAt", o."buyerId", o.items, ${CANCELLED_AT} AS cancelled_at
          FROM "ShopOrder" o, bounds b
         WHERE o.items @> ?::jsonb AND o."paidAt" IS NOT NULL AND o."paidAt" < b.t1
      ),
      app_orders AS (
        SELECT a.* FROM app_in a, bounds b
         WHERE (a."paidAt" >= b.t0 AND a."paidAt" < b.t1) OR (a.cancelled_at >= b.t0 AND a.cancelled_at < b.t1)
      ),
      app_lines AS (
        SELECT a.id AS order_id, a."paidAt" AS paid_at, a.cancelled_at, a."buyerId" AS buyer,
               i->>'productId' AS product_id, COALESCE(i->>'variant', '') AS variant, max(i->>'name') AS name,
               sum(COALESCE((i->>'qty')::numeric, 0))::bigint AS qty,
               sum(round(COALESCE((i->>'priceTzs')::numeric, 0) * COALESCE((i->>'qty')::numeric, 0)))::bigint AS gross,
               sum(COALESCE((i->>'commissionTzs')::numeric, 0))::bigint AS commission
          FROM app_orders a CROSS JOIN LATERAL jsonb_array_elements(${arr('a.items')}) i
         WHERE i->>'vendorId' = ?
         GROUP BY a.id, a."paidAt", a.cancelled_at, a."buyerId", i->>'productId', COALESCE(i->>'variant', '')
      ),
      app_vat AS (
        SELECT v."orderId" AS order_id, l->>'productId' AS product_id, COALESCE(l->>'variant', '') AS variant,
               sum(COALESCE((l->>'vatTzs')::numeric, 0))::bigint AS vat
          FROM "VendorOrderInvoice" v CROSS JOIN LATERAL jsonb_array_elements(${arr('v.lines')}) l
         WHERE v."vendorId" = ? AND v."orderId" IN (SELECT id FROM app_orders)
         GROUP BY 1, 2, 3
      ),
      app_priced AS (
        SELECT al.*, COALESCE(av.vat, 0) AS vat,
               CASE WHEN c."unitCostTzs" IS NULL THEN NULL ELSE al.qty * c."unitCostTzs" END AS cost
          FROM app_lines al
          LEFT JOIN app_vat av ON av.order_id = al.order_id AND av.product_id = al.product_id AND av.variant = al.variant
          LEFT JOIN "ShopOrderLineCost" c ON c."orderId" = al.order_id AND c."productId" = al.product_id AND c.variant = al.variant
      ),
      app AS (
        SELECT 'app'::text AS channel, 'sale'::text AS kind, p.order_id AS doc_id, ${eatDay('p.paid_at')} AS day,
               p.product_id, p.variant, p.name, p.qty, 0::bigint AS refund_qty, p.gross, 0::bigint AS discount, 0::bigint AS refund,
               p.gross AS net, p.vat, p.commission, p.cost, p.paid_at AS at, p.buyer
          FROM app_priced p, bounds b WHERE p.paid_at >= b.t0 AND p.paid_at < b.t1
        UNION ALL
        SELECT 'app', 'refund', p.order_id, ${eatDay('p.cancelled_at')},
               p.product_id, p.variant, p.name, 0::bigint, p.qty, 0::bigint, 0::bigint, p.gross,
               -p.gross, -p.vat, -p.commission, -p.cost, p.cancelled_at, p.buyer
          FROM app_priced p, bounds b WHERE p.cancelled_at >= b.t0 AND p.cancelled_at < b.t1
      ),
      facts AS (
        SELECT * FROM (SELECT * FROM walk UNION ALL SELECT * FROM app) f WHERE (?::text = 'all' OR f.channel = ?::text)
      )`;
    const bindings = [from, to, vendorId, containment(vendorId), String(vendorId), vendorId, channel, channel];
    return { sql, bindings };
  }

  /** Sales by bucket and channel. groupBy day|week|month (validated by the caller; bound as a parameter). */
  async function salesByBucket({ vendorId, from, to, channel, groupBy }) {
    const f = factsCte({ vendorId, from, to, channel });
    const { rows } = await db.raw(`${f.sql}
      SELECT to_char(date_trunc(?, f.day::timestamp), 'YYYY-MM-DD') AS bucket, f.channel,
             sum(f.gross)::bigint AS gross, sum(f.discount)::bigint AS discount, sum(f.refund)::bigint AS refund,
             sum(f.net)::bigint AS net, sum(f.vat)::bigint AS vat, sum(f.qty)::bigint AS items,
             count(DISTINCT f.doc_id) FILTER (WHERE f.kind = 'sale')::int AS count
        FROM facts f GROUP BY 1, 2 ORDER BY 1, 2`, [...f.bindings, groupBy]);
    return rows.map(plain).map(r => ({ bucket: r.bucket, channel: r.channel, gross: n(r.gross), discount: n(r.discount), refund: n(r.refund), net: n(r.net), vat: n(r.vat), items: n(r.items), count: n(r.count) }));
  }

  /** Completed walk-in sales voided later: excluded from every total, counted apart on their sale day. */
  async function voided({ vendorId, from, to }) {
    const { rows } = await db.raw(`WITH ${BOUNDS}
      SELECT count(*)::int AS count, COALESCE(sum(s."totalTzs"), 0)::bigint AS total
        FROM "VendorSale" s, bounds b
       WHERE s."vendorId" = ? AND s.status = 'voided' AND s."soldAt" >= b.t0 AND s."soldAt" < b.t1`, [from, to, vendorId]);
    return { count: n(rows[0]?.count), totalTzs: n(rows[0]?.total) };
  }

  /** Is there any walk-in sale (completed or voided) in the period? (channels.walkIn) */
  async function hasWalkIn({ vendorId, from, to }) {
    const { rows } = await db.raw(`WITH ${BOUNDS}
      SELECT EXISTS (SELECT 1 FROM "VendorSale" s, bounds b WHERE s."vendorId" = ? AND s."soldAt" >= b.t0 AND s."soldAt" < b.t1) AS found`, [from, to, vendorId]);
    return Boolean(rows[0]?.found);
  }

  /** Per product + variant in the period: units, net revenue, and the costed / uncosted split for profit. */
  async function byProduct({ vendorId, from, to, channel }) {
    const f = factsCte({ vendorId, from, to, channel });
    const { rows } = await db.raw(`${f.sql}
      SELECT f.product_id, f.variant, max(f.name) AS name,
             sum(f.qty)::bigint AS units, COALESCE(sum(f.qty) FILTER (WHERE f.channel = 'app'), 0)::bigint AS app_units,
             COALESCE(sum(f.qty) FILTER (WHERE f.channel = 'walk_in'), 0)::bigint AS walk_units,
             sum(f.net)::bigint AS net, sum(f.refund)::bigint AS refund,
             COALESCE(sum(f.qty) FILTER (WHERE f.cost IS NOT NULL), 0)::bigint AS costed_units,
             COALESCE(sum(f.net - f.vat) FILTER (WHERE f.cost IS NOT NULL), 0)::bigint AS costed_net_ex_vat,
             COALESCE(sum(f.commission) FILTER (WHERE f.cost IS NOT NULL), 0)::bigint AS costed_commission,
             COALESCE(sum(f.cost) FILTER (WHERE f.cost IS NOT NULL), 0)::bigint AS cost,
             COALESCE(sum(f.qty) FILTER (WHERE f.cost IS NULL), 0)::bigint AS uncosted_units,
             COALESCE(sum(f.net) FILTER (WHERE f.cost IS NULL), 0)::bigint AS uncosted_net,
             COALESCE(sum(f.net - f.vat) FILTER (WHERE f.cost IS NULL), 0)::bigint AS uncosted_net_ex_vat,
             count(*) FILTER (WHERE f.cost IS NULL AND f.kind = 'sale')::int AS uncosted_lines
        FROM facts f GROUP BY 1, 2`, f.bindings);
    return rows.map(plain).map(r => ({
      productId: r.product_id, variant: r.variant || '', name: r.name, units: n(r.units), appUnits: n(r.app_units), walkInUnits: n(r.walk_units),
      net: n(r.net), refund: n(r.refund), costedUnits: n(r.costed_units), costedNetExVat: n(r.costed_net_ex_vat), costedCommission: n(r.costed_commission),
      cost: n(r.cost), uncostedUnits: n(r.uncosted_units), uncostedNet: n(r.uncosted_net), uncostedNetExVat: n(r.uncosted_net_ex_vat), uncostedLines: n(r.uncosted_lines),
    }));
  }

  /** Profit by bucket (costed lines only) and the uncosted revenue per bucket. */
  async function profitByBucket({ vendorId, from, to, channel, groupBy }) {
    const f = factsCte({ vendorId, from, to, channel });
    const { rows } = await db.raw(`${f.sql}
      SELECT to_char(date_trunc(?, f.day::timestamp), 'YYYY-MM-DD') AS bucket, f.channel,
             COALESCE(sum(f.net - f.vat) FILTER (WHERE f.cost IS NOT NULL), 0)::bigint AS net_ex_vat,
             COALESCE(sum(f.commission) FILTER (WHERE f.cost IS NOT NULL), 0)::bigint AS commission,
             COALESCE(sum(f.cost) FILTER (WHERE f.cost IS NOT NULL), 0)::bigint AS cost,
             COALESCE(sum(f.net) FILTER (WHERE f.cost IS NULL), 0)::bigint AS uncosted_net,
             COALESCE(sum(f.qty) FILTER (WHERE f.cost IS NULL), 0)::bigint AS uncosted_units,
             count(*) FILTER (WHERE f.cost IS NULL AND f.kind = 'sale')::int AS uncosted_lines,
             max(CASE WHEN f.vat <> 0 THEN 1 ELSE 0 END)::int AS has_vat
        FROM facts f GROUP BY 1, 2 ORDER BY 1, 2`, [...f.bindings, groupBy]);
    return rows.map(plain).map(r => ({
      bucket: r.bucket, channel: r.channel, netExVat: n(r.net_ex_vat), commission: n(r.commission), cost: n(r.cost),
      uncostedNet: n(r.uncosted_net), uncostedUnits: n(r.uncosted_units), uncostedLines: n(r.uncosted_lines), hasVat: n(r.has_vat) > 0,
    }));
  }

  /**
   * Units sold per product + variant between two EAT dates, both channels (days of cover, Q-9). App orders
   * paid in the window that are not cancelled; walk-in sales completed.
   */
  async function unitsInWindow({ vendorId, from, to }) {
    const { rows } = await db.raw(`WITH ${BOUNDS}
      SELECT product_id, variant, sum(qty)::bigint AS units FROM (
        SELECT l."productId" AS product_id, l.variant, l.qty::bigint AS qty
          FROM "VendorSale" s JOIN "VendorSaleLine" l ON l."saleId" = s.id AND l."vendorId" = s."vendorId", bounds b
         WHERE s."vendorId" = ? AND s.status = 'completed' AND s."soldAt" >= b.t0 AND s."soldAt" < b.t1
        UNION ALL
        SELECT i->>'productId', COALESCE(i->>'variant', ''), COALESCE((i->>'qty')::numeric, 0)::bigint
          FROM "ShopOrder" o CROSS JOIN LATERAL jsonb_array_elements(${arr('o.items')}) i, bounds b
         WHERE o.items @> ?::jsonb AND o."paidAt" >= b.t0 AND o."paidAt" < b.t1 AND o.status <> 'cancelled' AND i->>'vendorId' = ?
      ) x GROUP BY 1, 2`, [from, to, vendorId, containment(vendorId), String(vendorId)]);
    return new Map(rows.map(plain).map(r => [`${r.product_id}\u0000${r.variant || ''}`, n(r.units)]));
  }

  /** When each product + variant was last sold, ever (walk-in completed; app paid and not cancelled). */
  async function lastSold({ vendorId }) {
    const { rows } = await db.raw(`
      SELECT product_id, variant, max(at) AS at FROM (
        SELECT l."productId" AS product_id, l.variant, max(s."soldAt") AS at
          FROM "VendorSale" s JOIN "VendorSaleLine" l ON l."saleId" = s.id AND l."vendorId" = s."vendorId"
         WHERE s."vendorId" = ? AND s.status = 'completed' GROUP BY 1, 2
        UNION ALL
        SELECT i->>'productId', COALESCE(i->>'variant', ''), max(o."paidAt")
          FROM "ShopOrder" o CROSS JOIN LATERAL jsonb_array_elements(${arr('o.items')}) i
         WHERE o.items @> ?::jsonb AND o."paidAt" IS NOT NULL AND o.status <> 'cancelled' AND i->>'vendorId' = ? GROUP BY 1, 2
      ) x GROUP BY 1, 2`, [vendorId, containment(vendorId), String(vendorId)]);
    return new Map(rows.map(plain).map(r => [`${r.product_id}\u0000${r.variant || ''}`, r.at ? new Date(r.at).toISOString() : null]));
  }

  /** The vendor's products (including removed ones, for names) and their private cost prices. */
  async function productsOf(vendorId) {
    const [products, privates] = await Promise.all([
      db('Product').where({ vendorId }).select('id', 'name', 'stock', 'variants', 'priceTzs', 'discountPriceTzs', 'status', 'deletedAt'),
      db('ProductPrivate').where({ vendorId }).select('productId', 'variant', 'costTzs'),
    ]);
    const costs = new Map(privates.map(r => [`${r.productId}\u0000${r.variant || ''}`, r.costTzs == null ? null : Number(r.costTzs)]));
    return { products: products.map(plain), costs };
  }

  /** Payment methods. byYou: walk-in sale payments by sale date (cash net of change) + customer payments by receivedOn. */
  async function paymentMethods({ vendorId, from, to }) {
    const [sale, pmt, app] = await Promise.all([
      db.raw(`WITH ${BOUNDS}
        SELECT p.method, sum(p."amountTzs")::bigint AS amount, count(*)::int AS count
          FROM "VendorSalePayment" p JOIN "VendorSale" s ON s.id = p."saleId" AND s."vendorId" = p."vendorId", bounds b
         WHERE s."vendorId" = ? AND s.status = 'completed' AND s."soldAt" >= b.t0 AND s."soldAt" < b.t1
         GROUP BY 1`, [from, to, vendorId]),
      db.raw(`SELECT method, sum("amountTzs")::bigint AS amount, count(*)::int AS count
          FROM "VendorCustomerPayment" WHERE "vendorId" = ? AND status = 'recorded' AND "receivedOn" BETWEEN ?::date AND ?::date
         GROUP BY 1`, [vendorId, from, to]),
      db.raw(`WITH ${BOUNDS}, mine AS (
          SELECT o.id, COALESCE(o."paymentMethod", 'unknown') AS method,
                 sum(round(COALESCE((i->>'priceTzs')::numeric, 0) * COALESCE((i->>'qty')::numeric, 0)))::bigint AS amount
            FROM "ShopOrder" o CROSS JOIN LATERAL jsonb_array_elements(${arr('o.items')}) i, bounds b
           WHERE o.items @> ?::jsonb AND o."paidAt" >= b.t0 AND o."paidAt" < b.t1 AND i->>'vendorId' = ?
           GROUP BY o.id, o."paymentMethod")
        SELECT method, sum(amount)::bigint AS amount, count(*)::int AS count FROM mine GROUP BY 1`, [from, to, containment(vendorId), String(vendorId)]),
    ]);
    const change = await db.raw(`WITH ${BOUNDS}
      SELECT COALESCE(sum(s."changeTzs"), 0)::bigint AS change FROM "VendorSale" s, bounds b
       WHERE s."vendorId" = ? AND s.status = 'completed' AND s."soldAt" >= b.t0 AND s."soldAt" < b.t1`, [from, to, vendorId]);
    return {
      salePayments: sale.rows.map(plain).map(r => ({ method: r.method, amount: n(r.amount), count: n(r.count) })),
      customerPayments: pmt.rows.map(plain).map(r => ({ method: r.method, amount: n(r.amount), count: n(r.count) })),
      changeTzs: n(change.rows[0]?.change),
      app: app.rows.map(plain).map(r => ({ method: r.method, amount: n(r.amount), count: n(r.count) })),
    };
  }

  /** Customers in the period: pay-later sales, money collected (PMT, by receivedOn) and who bought. */
  async function customerActivity({ vendorId, from, to }) {
    const { rows } = await db.raw(`WITH ${BOUNDS}
      SELECT
        (SELECT count(*) FROM "VendorSale" s, bounds b WHERE s."vendorId" = ? AND s.status = 'completed' AND s.kind = 'credit'
            AND s."soldAt" >= b.t0 AND s."soldAt" < b.t1)::int AS credit_count,
        (SELECT COALESCE(sum(s."totalTzs"), 0) FROM "VendorSale" s, bounds b WHERE s."vendorId" = ? AND s.status = 'completed' AND s.kind = 'credit'
            AND s."soldAt" >= b.t0 AND s."soldAt" < b.t1)::bigint AS credit_total,
        (SELECT COALESCE(sum("amountTzs"), 0) FROM "VendorCustomerPayment" WHERE "vendorId" = ? AND status = 'recorded'
            AND "receivedOn" BETWEEN ?::date AND ?::date)::bigint AS collected,
        (SELECT count(DISTINCT s."customerId") FROM "VendorSale" s, bounds b WHERE s."vendorId" = ? AND s.status = 'completed'
            AND s."customerId" IS NOT NULL AND s."soldAt" >= b.t0 AND s."soldAt" < b.t1)::int AS buyers_shop,
        (SELECT count(DISTINCT o."buyerId") FROM "ShopOrder" o, bounds b WHERE o.items @> ?::jsonb AND o."paidAt" >= b.t0 AND o."paidAt" < b.t1)::int AS buyers_app`,
    [from, to, vendorId, vendorId, vendorId, from, to, vendorId, containment(vendorId)]);
    const r = plain(rows[0]);
    return { creditSales: { count: n(r.credit_count), totalTzs: n(r.credit_total) }, collectedTzs: n(r.collected), buyers: { shop: n(r.buyers_shop), app: n(r.buyers_app) } };
  }

  /**
   * App sales after commission. Groups (in SQL) this vendor's paid orders into:
   *   not_delivered — paid in the period, not delivered (or cancelled) yet;
   *   delivered     — delivered in the period (settlement's deliveredOn), with the statement it is on.
   * A delivered order on a statement the vendor can see (submitted … paid) is grouped under that statement's
   * week with the statement LINE's figures, so a statement week equals its statement exactly; otherwise under
   * its delivery week (Monday, EAT) with vendorShareOfOrder's figures, statement null. Orders whose payout is
   * not above 0 are left out, as settlement does.
   */
  async function marketplaceNet({ vendorId, from, to }) {
    const { rows } = await db.raw(`WITH ${BOUNDS},
      mine AS (
        SELECT o.id, o.status, o."settlementStatus", o."paidAt",
               COALESCE((SELECT (e->>'at')::timestamptz FROM jsonb_array_elements(${arr('o.timeline')}) WITH ORDINALITY t(e, ord)
                          WHERE e->>'status' IN ('delivered', 'fulfilled') ORDER BY ord DESC LIMIT 1), o."updatedAt", o."createdAt") AS delivered_at,
               sum(COALESCE((i->>'qty')::numeric, 0))::bigint AS items,
               sum(round(COALESCE((i->>'priceTzs')::numeric, 0) * COALESCE((i->>'qty')::numeric, 0)))::bigint AS sales,
               sum(COALESCE((i->>'commissionTzs')::numeric, 0))::bigint AS commission,
               sum(COALESCE((i->>'vendorPayoutTzs')::numeric,
                   round(COALESCE((i->>'priceTzs')::numeric, 0) * COALESCE((i->>'qty')::numeric, 0)) - COALESCE((i->>'commissionTzs')::numeric, 0)))::bigint AS payout
          FROM "ShopOrder" o CROSS JOIN LATERAL jsonb_array_elements(${arr('o.items')}) i
         WHERE o.items @> ?::jsonb AND i->>'vendorId' = ? AND o."paymentStatus" = 'paid'
         GROUP BY o.id
      ),
      placed AS (
        SELECT m.*, ${eatDay('m.delivered_at')} AS delivered_on, st.id AS st_id, st.status AS st_status, st."periodStartDate" AS st_start,
               st."periodEndDate" AS st_end, st."salesTzs" AS st_sales, st."commissionTzs" AS st_commission, st."finalNetTzs" AS st_final,
               sl."salesTzs" AS sl_sales, sl."commissionTzs" AS sl_commission, sl."payoutTzs" AS sl_payout
          FROM mine m
          LEFT JOIN "VendorSettlementLine" sl ON sl."orderId" = m.id AND sl."vendorId" = ? AND sl.voided = false
          LEFT JOIN "VendorSettlement" st ON st.id = sl."vendorSettlementId" AND st.status = ANY(?::text[])
         WHERE m.payout > 0
      ),
      classified AS (
        SELECT p.*,
               CASE WHEN p.status IN ('delivered', 'fulfilled') THEN
                      CASE WHEN p.st_status = 'paid' OR p."settlementStatus" = 'settled' THEN 'paid_out' ELSE 'waiting' END
                    ELSE 'not_delivered' END AS state,
               COALESCE(p.st_start, to_char(date_trunc('week', p.delivered_on::timestamp), 'YYYY-MM-DD')) AS week_start,
               COALESCE(p.st_end, to_char(date_trunc('week', p.delivered_on::timestamp) + interval '6 days', 'YYYY-MM-DD')) AS week_end,
               CASE WHEN p.st_id IS NULL THEN p.sales ELSE p.sl_sales END AS f_sales,
               CASE WHEN p.st_id IS NULL THEN p.commission ELSE p.sl_commission END AS f_commission,
               CASE WHEN p.st_id IS NULL THEN p.payout ELSE p.sl_payout END AS f_payout
          FROM placed p, bounds b
         WHERE (p.status IN ('delivered', 'fulfilled') AND p.delivered_on BETWEEN ?::date AND ?::date)
            OR (p.status NOT IN ('delivered', 'fulfilled', 'cancelled') AND p."paidAt" >= b.t0 AND p."paidAt" < b.t1)
      )
      SELECT state, CASE WHEN state = 'not_delivered' THEN NULL ELSE week_start END AS week_start,
             CASE WHEN state = 'not_delivered' THEN NULL ELSE week_end END AS week_end,
             st_id, st_status, st_sales, st_commission, st_final,
             count(*)::int AS orders, sum(items)::bigint AS items, sum(f_sales)::bigint AS sales,
             sum(f_commission)::bigint AS commission, sum(f_payout)::bigint AS payout
        FROM classified
       GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
       ORDER BY 2 NULLS FIRST, 4 NULLS LAST`,
    [from, to, containment(vendorId), String(vendorId), String(vendorId), VISIBLE_TO_PARTNER, from, to]);
    return rows.map(plain).map(r => ({
      state: r.state, weekStart: r.week_start, weekEnd: r.week_end,
      statement: r.st_id ? { id: r.st_id, status: r.st_status, salesTzs: n(r.st_sales), commissionTzs: n(r.st_commission), finalNetTzs: n(r.st_final) } : null,
      orders: n(r.orders), items: n(r.items), sales: n(r.sales), commission: n(r.commission), payout: n(r.payout),
    }));
  }

  return { factsCte, salesByBucket, voided, hasWalkIn, byProduct, profitByBucket, unitsInWindow, lastSold, productsOf, paymentMethods, customerActivity, marketplaceNet };
}
