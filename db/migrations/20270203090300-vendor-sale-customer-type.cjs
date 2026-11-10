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
// Locking (security review L-1): the CHECK is added NOT VALID (no table scan under the ACCESS EXCLUSIVE lock) and then
// VALIDATEd in a separate statement (a lighter SHARE UPDATE EXCLUSIVE lock; every existing row is NULL, so it holds),
// the 20270202090400-vendor-sale-refunds pattern. lock_timeout 5s: a busy VendorSale makes the migration fail and be
// retried rather than queue every sale behind it. SET LOCAL lasts only for the migration's transaction.
//
// Down: drops the column (the spec's rule; the labels recorded since are lost). Roll the code back BEFORE running
// down: the new code writes the column whenever a sale carries a customerType.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE "VendorSale"
    ADD COLUMN "customerType" text NULL,
    ADD CONSTRAINT vendorsale_customer_type_check
      CHECK ("customerType" IS NULL OR "customerType" IN ('new', 'returning', 'walk_in', 'online', 'other')) NOT VALID`);
  await knex.raw('ALTER TABLE "VendorSale" VALIDATE CONSTRAINT vendorsale_customer_type_check');
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw('ALTER TABLE "VendorSale" DROP CONSTRAINT IF EXISTS vendorsale_customer_type_check');
  await knex.raw('ALTER TABLE "VendorSale" DROP COLUMN IF EXISTS "customerType"');
};
