// Vendor business tools · S6 — vendor reports (plan docs/plans/vendor-business-tools-plan.md S6; design
// spec docs/design/vendor-reports-s6.md, Q-2 and Q-10 decided 2026-10-22).
//
// - ShopOrder.paidAt: when the order's payment was confirmed. Sales, Products, Profit and Payment methods
//   date app orders by it (Q-2); App sales after commission keeps the delivered date (= payout statements).
//   Written by markPaid and by reviveOrder (a late payment that revives the order) from now on.
//   Settlement, pricing and the payout engine never read it.
// - Backfill (idempotent: only rows where paidAt IS NULL): an order that was paid gets, in this order,
//     1. the decision time of its approved PaymentRequest,
//     2. else when its line costs were snapshotted (ShopOrderLineCost.createdAt, written on payment),
//     3. else its createdAt (only for an order still marked paid).
//   An order with nothing to pay (totalTzs 0) was paid when it was placed: its createdAt — the same value
//   createOrder now writes for such orders.
//   "Was paid" = paymentStatus 'paid', or refund_pending/refunded for an order cancelled AFTER it was
//   paid (its approved request was decided before its first cancellation, or it has line costs).
//   An order whose money arrived only after it was cancelled (late payment, refund owed) was never a
//   sale and keeps paidAt NULL.
// - Indexes: ShopOrder(paidAt) (Q-10), VendorCustomerPayment(vendorId, receivedOn) for "collected in
//   the period", and VendorSettlementLine(vendorId, orderId) WHERE NOT voided — a vendor's own paid
//   statement lines decide "paid out" (security review #275 M1). VendorSale(vendorId, soldAt, id) already exists (S3).
//
// Down: drops the indexes and the column (the backfilled values are derived data; nothing else is lost).

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.alterTable('ShopOrder', (table) => {
    table.timestamp('paidAt', { precision: 3 });
  });
  await knex.raw('CREATE INDEX IF NOT EXISTS shoporder_paid_at_index ON "ShopOrder" ("paidAt") WHERE "paidAt" IS NOT NULL');
  await knex.raw('CREATE INDEX IF NOT EXISTS vendorcustomerpayment_vendor_received_index ON "VendorCustomerPayment" ("vendorId", "receivedOn")');
  await knex.raw('CREATE INDEX IF NOT EXISTS vendorsettlementline_vendor_live_index ON "VendorSettlementLine" ("vendorId", "orderId") WHERE voided = false');
  await exports.backfillPaidAt(knex);
};

/**
 * Sets paidAt on paid orders that have none. Safe to repeat: rows that already have a paidAt are never
 * touched, so a second run changes nothing. → { paid, cancelledAfterPayment }
 * @param {import('knex').Knex} knex
 */
exports.backfillPaidAt = async function backfillPaidAt(knex) {
  const sources = `
    SELECT o.id,
           (SELECT max(p."decidedAt") FROM "PaymentRequest" p WHERE p."orderId" = o.id AND p.status = 'approved') AS approved_at,
           (SELECT min(c."createdAt") FROM "ShopOrderLineCost" c WHERE c."orderId" = o.id) AS costed_at,
           (SELECT min((e->>'at')::timestamptz) FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(o.timeline) = 'array' THEN o.timeline ELSE '[]'::jsonb END) e
             WHERE e->>'status' = 'cancelled' AND e->>'at' ~ '^\\d{4}-\\d{2}-\\d{2}T') AS cancelled_at,
           o."createdAt", o."totalTzs"
      FROM "ShopOrder" o`;
  const paid = await knex.raw(`
    UPDATE "ShopOrder" o SET "paidAt" = COALESCE(CASE WHEN s."totalTzs" = 0 THEN s."createdAt" END, s.approved_at, s.costed_at, s."createdAt")
      FROM (${sources} WHERE o."paidAt" IS NULL AND o."paymentStatus" = 'paid') s
     WHERE o.id = s.id AND o."paidAt" IS NULL
    RETURNING o.id`);
  const refunded = await knex.raw(`
    UPDATE "ShopOrder" o SET "paidAt" = COALESCE(
             CASE WHEN s.approved_at IS NOT NULL AND (s.cancelled_at IS NULL OR s.approved_at < s.cancelled_at) THEN s.approved_at END,
             s.costed_at)
      FROM (${sources} WHERE o."paidAt" IS NULL AND o."paymentStatus" IN ('refund_pending', 'refunded')) s
     WHERE o.id = s.id AND o."paidAt" IS NULL
       AND COALESCE(CASE WHEN s.approved_at IS NOT NULL AND (s.cancelled_at IS NULL OR s.approved_at < s.cancelled_at) THEN s.approved_at END, s.costed_at) IS NOT NULL
    RETURNING o.id`);
  const out = { paid: paid.rows.length, cancelledAfterPayment: refunded.rows.length };
  console.log(`[migrate] vendor reports: paidAt backfilled on ${out.paid} paid order(s) and ${out.cancelledAfterPayment} order(s) cancelled after payment`);
  return out;
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS vendorsettlementline_vendor_live_index');
  await knex.raw('DROP INDEX IF EXISTS vendorcustomerpayment_vendor_received_index');
  await knex.raw('DROP INDEX IF EXISTS shoporder_paid_at_index');
  await knex.schema.alterTable('ShopOrder', (table) => {
    table.dropColumn('paidAt');
  });
};
