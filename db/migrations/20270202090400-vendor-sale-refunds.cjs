// Vendor business tools · S7 — partial and revertible refunds on walk-in sales.
// Design: docs/design/vendor-refunds-s7.md §2.1 (approved 2026-11-03). RULE 6 AREA: money records.
//
// A refund never edits the sale: it is its own record (a credit note, CN-000001… per vendor from
// VendorDocumentSequence docType credit_note, gap-free, issued inside the refund's transaction) that points
// at the sale. Walk-in money never passes through FitFlex: a refund records that the vendor gave money back
// (paidOutTzs, by a method) or took it off a pay-later sale's balance (balanceReducedTzs). No PaymentRequest,
// no commission, no settlement row.
//
// - VendorSaleRefund: one refund (credit note). status active | reverted (an undo keeps the number; the
//   credit note then reads Cancelled). amountTzs = balanceReducedTzs + paidOutTzs; a payout needs a method.
//   clientRef = the device's idempotency key (unique per vendor). FK (saleId, vendorId) → VendorSale.
// - VendorSaleRefundLine: what came back, per sale line: qty, the amount and VAT given back (server-computed,
//   cumulative rounding M-2/M-3), restock (true → the units went back to stock once, ledger refund_restock).
// - VendorSale gains refundedTzs (Σ ACTIVE refunds) and balanceReducedTzs (Σ ACTIVE refunds' balance part).
//   The S3 CHECK vendorsale_paid_adds_up (paid − change + balance = total) is REPLACED by
//   paid − change + balance + balanceReduced = total: a refund on a pay-later sale lowers balanceTzs without
//   any money arriving. Added NOT VALID then VALIDATEd (every existing row has 0, so it holds).
// - VendorSaleLine gains refundedQty, refundedTzs, refundedVatTzs: the active totals per line, kept in the
//   refund/undo transaction; their CHECKs are the last defence against over-refunding.
//
// Down: REFUSES while any VendorSaleRefund row exists (prints the count). Otherwise restores the old CHECK,
// drops the columns and tables, and deletes the credit_note sequence rows. Ledger rows of kind refund /
// refund_revert cannot exist then (they are only written with a refund).

const METHODS = ['cash', 'mpesa', 'airtel_money', 'mixx', 'halopesa', 'card', 'bank', 'other'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('VendorSaleRefund', (table) => {
    table.text('id').primary();
    table.text('vendorId').notNullable();
    table.text('saleId').notNullable();
    table.integer('seq').notNullable();
    table.text('number').notNullable();
    table.text('status').notNullable().defaultTo('active');
    table.text('reason').notNullable();
    table.text('method');
    table.text('reference');
    table.integer('amountTzs').notNullable();
    table.integer('balanceReducedTzs').notNullable().defaultTo(0);
    table.integer('paidOutTzs').notNullable().defaultTo(0);
    table.integer('vatTzs').notNullable().defaultTo(0);
    table.text('clientRef').notNullable();
    table.text('fingerprint').notNullable();
    table.jsonb('sellerSnapshot');
    table.text('createdBy').notNullable();
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.text('revertedBy');
    table.timestamp('revertedAt', { precision: 3 });
    table.text('revertReason');
    table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.unique(['vendorId', 'seq']);
    table.unique(['vendorId', 'number']);
    table.unique(['vendorId', 'clientRef']);
    table.unique(['id', 'vendorId']);
    table.index(['vendorId', 'createdAt', 'id']);
    table.index(['saleId']);
  });
  await knex.raw(`ALTER TABLE "VendorSaleRefund"
    ADD CONSTRAINT vendorsalerefund_sale_fk FOREIGN KEY ("saleId", "vendorId") REFERENCES "VendorSale" (id, "vendorId"),
    ADD CONSTRAINT vendorsalerefund_status_check CHECK (status IN ('active', 'reverted')),
    ADD CONSTRAINT vendorsalerefund_reason_length CHECK (char_length(reason) BETWEEN 3 AND 200),
    ADD CONSTRAINT vendorsalerefund_method_check CHECK (method IS NULL OR method IN (${list(METHODS)})),
    ADD CONSTRAINT vendorsalerefund_reference_length CHECK (reference IS NULL OR char_length(reference) <= 100),
    ADD CONSTRAINT vendorsalerefund_money_non_negative CHECK ("amountTzs" >= 0 AND "balanceReducedTzs" >= 0 AND "paidOutTzs" >= 0),
    ADD CONSTRAINT vendorsalerefund_amount_adds_up CHECK ("amountTzs" = "balanceReducedTzs" + "paidOutTzs"),
    ADD CONSTRAINT vendorsalerefund_payout_method CHECK ("paidOutTzs" = 0 OR method IS NOT NULL),
    ADD CONSTRAINT vendorsalerefund_vat_range CHECK ("vatTzs" >= 0 AND "vatTzs" <= "amountTzs"),
    ADD CONSTRAINT vendorsalerefund_client_ref CHECK ("clientRef" ~ '^[A-Za-z0-9._:-]{8,100}$'),
    ADD CONSTRAINT vendorsalerefund_revert_reason_length CHECK ("revertReason" IS NULL OR char_length("revertReason") BETWEEN 3 AND 200),
    ADD CONSTRAINT vendorsalerefund_reverted_complete CHECK (
      (status = 'reverted' AND "revertedBy" IS NOT NULL AND "revertedAt" IS NOT NULL AND "revertReason" IS NOT NULL)
      OR (status = 'active' AND "revertedBy" IS NULL AND "revertedAt" IS NULL AND "revertReason" IS NULL))`);
  await knex.raw(`CREATE INDEX vendorsalerefund_reverted_idx ON "VendorSaleRefund" ("vendorId", "revertedAt") WHERE "revertedAt" IS NOT NULL`);

  await knex.schema.createTable('VendorSaleRefundLine', (table) => {
    table.text('id').primary();
    table.text('refundId').notNullable().references('id').inTable('VendorSaleRefund').onDelete('CASCADE');
    table.text('vendorId').notNullable();
    table.text('saleLineId').notNullable().references('id').inTable('VendorSaleLine');
    table.integer('qty').notNullable();
    table.integer('amountTzs').notNullable();
    table.integer('vatTzs').notNullable().defaultTo(0);
    table.boolean('restock').notNullable();
    table.unique(['refundId', 'saleLineId']);
    table.index(['saleLineId']);
  });
  await knex.raw(`ALTER TABLE "VendorSaleRefundLine"
    ADD CONSTRAINT vendorsalerefundline_qty_positive CHECK (qty > 0),
    ADD CONSTRAINT vendorsalerefundline_money_range CHECK ("amountTzs" >= 0 AND "vatTzs" >= 0 AND "vatTzs" <= "amountTzs")`);

  await knex.raw(`ALTER TABLE "VendorSale"
    ADD COLUMN "refundedTzs" integer NOT NULL DEFAULT 0,
    ADD COLUMN "balanceReducedTzs" integer NOT NULL DEFAULT 0`);
  await knex.raw(`ALTER TABLE "VendorSale" DROP CONSTRAINT vendorsale_paid_adds_up`);
  await knex.raw(`ALTER TABLE "VendorSale"
    ADD CONSTRAINT vendorsale_paid_adds_up CHECK ("paidTzs" - "changeTzs" + "balanceTzs" + "balanceReducedTzs" = "totalTzs") NOT VALID,
    ADD CONSTRAINT vendorsale_refunded_range CHECK ("refundedTzs" >= 0 AND "refundedTzs" <= "totalTzs") NOT VALID,
    ADD CONSTRAINT vendorsale_balance_reduced_range CHECK ("balanceReducedTzs" >= 0 AND "balanceReducedTzs" <= "refundedTzs") NOT VALID,
    ADD CONSTRAINT vendorsale_cash_no_balance_reduced CHECK (kind <> 'cash' OR "balanceReducedTzs" = 0) NOT VALID`);
  for (const name of ['vendorsale_paid_adds_up', 'vendorsale_refunded_range', 'vendorsale_balance_reduced_range', 'vendorsale_cash_no_balance_reduced']) {
    await knex.raw(`ALTER TABLE "VendorSale" VALIDATE CONSTRAINT ${name}`);
  }

  await knex.raw(`ALTER TABLE "VendorSaleLine"
    ADD COLUMN "refundedQty" integer NOT NULL DEFAULT 0,
    ADD COLUMN "refundedTzs" integer NOT NULL DEFAULT 0,
    ADD COLUMN "refundedVatTzs" integer NOT NULL DEFAULT 0`);
  await knex.raw(`ALTER TABLE "VendorSaleLine"
    ADD CONSTRAINT vendorsaleline_refunded_qty_range CHECK ("refundedQty" >= 0 AND "refundedQty" <= qty) NOT VALID,
    ADD CONSTRAINT vendorsaleline_refunded_tzs_range CHECK ("refundedTzs" >= 0 AND "refundedTzs" <= "lineTotalTzs" - "saleDiscountShareTzs") NOT VALID,
    ADD CONSTRAINT vendorsaleline_refunded_vat_range CHECK ("refundedVatTzs" >= 0 AND "refundedVatTzs" <= "vatTzs") NOT VALID`);
  for (const name of ['vendorsaleline_refunded_qty_range', 'vendorsaleline_refunded_tzs_range', 'vendorsaleline_refunded_vat_range']) {
    await knex.raw(`ALTER TABLE "VendorSaleLine" VALIDATE CONSTRAINT ${name}`);
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const refunds = Number((await knex.raw('SELECT count(*)::int AS n FROM "VendorSaleRefund"')).rows[0].n);
  if (refunds) {
    console.error(`[migrate] vendor-sale-refunds down refused: ${refunds} refund(s) exist`);
    throw new Error(`vendor-sale-refunds down: ${refunds} refund(s) exist; the sales they changed cannot be kept without this migration`);
  }
  await knex.raw(`ALTER TABLE "VendorSaleLine"
    DROP CONSTRAINT IF EXISTS vendorsaleline_refunded_qty_range,
    DROP CONSTRAINT IF EXISTS vendorsaleline_refunded_tzs_range,
    DROP CONSTRAINT IF EXISTS vendorsaleline_refunded_vat_range,
    DROP COLUMN IF EXISTS "refundedQty",
    DROP COLUMN IF EXISTS "refundedTzs",
    DROP COLUMN IF EXISTS "refundedVatTzs"`);
  await knex.raw(`ALTER TABLE "VendorSale"
    DROP CONSTRAINT IF EXISTS vendorsale_paid_adds_up,
    DROP CONSTRAINT IF EXISTS vendorsale_refunded_range,
    DROP CONSTRAINT IF EXISTS vendorsale_balance_reduced_range,
    DROP CONSTRAINT IF EXISTS vendorsale_cash_no_balance_reduced`);
  await knex.raw(`ALTER TABLE "VendorSale" DROP COLUMN IF EXISTS "refundedTzs", DROP COLUMN IF EXISTS "balanceReducedTzs"`);
  await knex.raw(`ALTER TABLE "VendorSale" ADD CONSTRAINT vendorsale_paid_adds_up CHECK ("paidTzs" - "changeTzs" + "balanceTzs" = "totalTzs")`);
  await knex.schema.dropTableIfExists('VendorSaleRefundLine');
  await knex.schema.dropTableIfExists('VendorSaleRefund');
  await knex.raw(`DELETE FROM "VendorDocumentSequence" WHERE "docType" = 'credit_note'`);
};
