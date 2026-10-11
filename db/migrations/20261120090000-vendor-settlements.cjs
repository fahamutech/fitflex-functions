// Vendor payouts.
//
// - VendorSettlement: one weekly statement per vendor, on the same path as a
//   trainer or gym statement: draft → submitted → approved → payable → paid,
//   or voided. A second person approves; a hold blocks payment; a payable or
//   paid statement carries the payout account it was cleared for.
// - VendorSettlementLine: the delivered orders on a statement, with the
//   vendor's sales, FitFlex's commission and what the vendor is paid. A
//   vendor's share of an order is paid once: it sits on one live line only.
//   Voiding a statement releases its orders for the next one.
//
// The commission itself is fixed on each order line when the order is placed
// (ShopOrder.items[].commissionPct / commissionTzs / vendorPayoutTzs).

const STATUSES = ['draft', 'submitted', 'approved', 'payable', 'paid', 'voided'];
const inList = (col, values) => `"${col}" IN (${values.map(v => `'${v}'`).join(', ')})`;

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('VendorSettlement'))) {
    await knex.schema.createTable('VendorSettlement', (t) => {
      const ts = name => t.timestamp(name, { precision: 3 });
      t.text('id').primary();
      t.text('vendorId').notNullable();
      t.text('periodStartDate').notNullable();   // YYYY-MM-DD, a Monday (EAT)
      t.text('periodEndDate').notNullable();     // YYYY-MM-DD, the Sunday
      t.integer('orderCount').notNullable().defaultTo(0);
      t.integer('salesTzs').notNullable().defaultTo(0);       // what buyers paid for this vendor's items
      t.integer('commissionTzs').notNullable().defaultTo(0);  // FitFlex commission
      t.integer('finalNetTzs').notNullable().defaultTo(0);    // what the vendor is paid
      t.text('status').notNullable().defaultTo('draft');
      t.text('preparedBy');
      t.text('submittedBy'); ts('submittedAt');
      t.text('approvedBy'); ts('approvedAt');
      t.text('rejectedBy'); ts('rejectedAt'); t.text('rejectReason');
      t.text('holdReason'); t.text('heldBy'); ts('heldAt');
      ts('payableAt');
      t.jsonb('destinationSnapshot');
      t.text('paidBy'); ts('paidAt'); t.text('paymentReference'); t.text('receiptUrl');
      t.text('voidedBy'); ts('voidedAt'); t.text('voidReason');
      ts('createdAt').notNullable().defaultTo(knex.fn.now(3));
      ts('updatedAt').notNullable().defaultTo(knex.fn.now(3));
      t.index(['vendorId']);
      t.index(['status']);
    });
    await knex.raw(`ALTER TABLE "VendorSettlement" ADD CONSTRAINT vendor_settlement_ck CHECK (
      ${inList('status', STATUSES)} AND "periodEndDate" >= "periodStartDate" AND "finalNetTzs" >= 0
      AND ("approvedBy" IS NULL OR "approvedBy" <> "submittedBy")
      AND ("status" NOT IN ('payable', 'paid') OR "holdReason" IS NULL)
      AND ("status" NOT IN ('payable', 'paid') OR "destinationSnapshot" IS NOT NULL)
      AND ("status" <> 'paid' OR ("paidAt" IS NOT NULL AND "paymentReference" IS NOT NULL))
      AND ("status" <> 'voided' OR "voidReason" IS NOT NULL)
      AND (("holdReason" IS NULL) = ("heldAt" IS NULL)))`);
    // One live statement per vendor and week.
    await knex.raw(`CREATE UNIQUE INDEX vendor_settlement_period_ux ON "VendorSettlement" ("vendorId", "periodStartDate") WHERE "status" <> 'voided'`);
  }

  if (!(await knex.schema.hasTable('VendorSettlementLine'))) {
    await knex.schema.createTable('VendorSettlementLine', (t) => {
      t.text('id').primary();
      t.text('vendorSettlementId').notNullable().references('id').inTable('VendorSettlement').onDelete('CASCADE');
      t.text('vendorId').notNullable();
      t.text('orderId').notNullable();
      t.text('buyerId');
      t.text('deliveredOn').notNullable();       // YYYY-MM-DD (EAT)
      t.integer('itemCount').notNullable().defaultTo(0);
      t.integer('salesTzs').notNullable().defaultTo(0);
      t.integer('commissionTzs').notNullable().defaultTo(0);
      t.integer('payoutTzs').notNullable();
      t.boolean('voided').notNullable().defaultTo(false);
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
      t.index(['vendorSettlementId']);
    });
    await knex.raw(`ALTER TABLE "VendorSettlementLine" ADD CONSTRAINT vendor_settlement_line_ck CHECK ("payoutTzs" >= 0 AND "salesTzs" >= 0)`);
    // A vendor's share of an order is paid once.
    await knex.raw(`CREATE UNIQUE INDEX vendor_settlement_line_order_ux ON "VendorSettlementLine" ("orderId", "vendorId") WHERE "voided" = false`);
  }

  // A paid statement is final, and statuses only move along the path.
  await knex.raw(`CREATE OR REPLACE FUNCTION vendor_settlement_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD."status" <> 'draft' THEN RAISE EXCEPTION 'VendorSettlement: only a draft statement can be deleted' USING ERRCODE = 'P0001'; END IF;
        RETURN OLD;
      END IF;
      IF OLD."status" IN ('paid', 'voided') THEN RAISE EXCEPTION 'VendorSettlement: a % statement is final', OLD."status" USING ERRCODE = 'P0001'; END IF;
      IF OLD."status" <> 'draft' AND (NEW."vendorId", NEW."periodStartDate", NEW."periodEndDate", NEW."orderCount", NEW."salesTzs", NEW."commissionTzs", NEW."finalNetTzs")
           IS DISTINCT FROM (OLD."vendorId", OLD."periodStartDate", OLD."periodEndDate", OLD."orderCount", OLD."salesTzs", OLD."commissionTzs", OLD."finalNetTzs") THEN
        RAISE EXCEPTION 'VendorSettlement: amounts are frozen once a statement leaves draft' USING ERRCODE = 'P0001';
      END IF;
      IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
           (OLD."status" = 'draft'     AND NEW."status" IN ('submitted', 'voided'))
        OR (OLD."status" = 'submitted' AND NEW."status" IN ('draft', 'approved', 'voided'))
        OR (OLD."status" = 'approved'  AND NEW."status" IN ('payable', 'voided'))
        OR (OLD."status" = 'payable'   AND NEW."status" IN ('approved', 'paid'))
      ) THEN
        RAISE EXCEPTION 'VendorSettlement: % → % is not an allowed transition', OLD."status", NEW."status" USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await knex.raw(`DROP TRIGGER IF EXISTS vendor_settlement_guard_tg ON "VendorSettlement"`);
  await knex.raw(`CREATE TRIGGER vendor_settlement_guard_tg BEFORE UPDATE OR DELETE ON "VendorSettlement" FOR EACH ROW EXECUTE FUNCTION vendor_settlement_guard()`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS vendor_settlement_guard_tg ON "VendorSettlement"`);
  await knex.raw(`DROP FUNCTION IF EXISTS vendor_settlement_guard()`);
  await knex.schema.dropTableIfExists('VendorSettlementLine');
  await knex.schema.dropTableIfExists('VendorSettlement');
};
