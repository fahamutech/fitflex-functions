// Vendor tools · S2 — order privacy for vendors (plan §3).
//
// - VendorBuyerRef: a vendor-scoped, stable pseudonym for each app buyer who ordered from that
//   vendor (`customerId`, random, unique). The vendor sees `buyer.customerId` instead of the buyer's
//   user id, and the same buyer has a different customerId at every vendor. Created on first read.
//   Primary key (vendorId, buyerId); unique customerId.
// - ShopOrder.items GIN index (jsonb_path_ops): GET /vendor/orders reads a vendor's orders with
//   `items @> '[{"vendorId": …}]'` instead of loading the whole table.
//
// Additive and reversible: down drops the index and the table.

const ITEMS_INDEX = 'shoporder_items_gin_idx';

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('VendorBuyerRef'))) {
    await knex.schema.createTable('VendorBuyerRef', (t) => {
      t.text('vendorId').notNullable();
      t.text('buyerId').notNullable();
      t.text('customerId').notNullable().unique();
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.primary(['vendorId', 'buyerId']);
    });
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${ITEMS_INDEX} ON "ShopOrder" USING GIN ("items" jsonb_path_ops)`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${ITEMS_INDEX}`);
  await knex.schema.dropTableIfExists('VendorBuyerRef');
};
