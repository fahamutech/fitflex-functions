// Vendor walk-in sale extras (design spec docs/design/vendor-sale-extras-1110.md §2.3, approved 2026-11-10 with
// Q-1..Q-13 as recommended). Additive.
//
// - VendorSale.customerType: what kind of customer this purchase was from (new | returning | walk_in | online |
//   other), or NULL (not said). It describes the purchase, not the person, so it lives on the sale, not on
//   VendorCustomer. Not personal data. Never printed on receipts or documents.
// - No backfill: every existing sale stays NULL.
// - The server accepts and stores it always (Q-8); only the app section is behind VENDOR_SALE_CUSTOMER_DETAILS.
//   Run this migration with the deploy, before the code.
//
// (Sale extras #1, the optional reference, needs no migration: VendorSalePayment.reference has no cash CHECK.)
//
// Down: drops the column (the spec's rule; the labels recorded since are lost).

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE "VendorSale"
    ADD COLUMN "customerType" text NULL,
    ADD CONSTRAINT vendorsale_customer_type_check
      CHECK ("customerType" IS NULL OR "customerType" IN ('new', 'returning', 'walk_in', 'online', 'other'))`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE "VendorSale" DROP CONSTRAINT IF EXISTS vendorsale_customer_type_check');
  await knex.raw('ALTER TABLE "VendorSale" DROP COLUMN IF EXISTS "customerType"');
};
