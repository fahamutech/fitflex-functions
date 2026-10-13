// Marketplace checkout integrity (PR 1).
//
// - ShopOrder.idempotencyKey (+ fingerprint): a retried checkout returns the original order.
//   Unique per buyer, only where a key was sent, so existing rows and key-less clients are unaffected.
// - ShopOrder.stockState: whether the order still holds its reserved units ('reserved') or has
//   given them back ('released'). Releasing is a conditional update on this column, which is what
//   makes a release happen exactly once.
// - ShopOrder.reservationExpiresAt: when an unpaid order's reservation lapses.
// - ShopStockMovement: append-only ledger of every reserve / release, one row per order, product
//   and reason. Its unique key is a second, database-level guard against a double release.
// - Product.stock >= 0: the database refuses to oversell even if application code is wrong.
//   Added NOT VALID so it cannot fail on rows that already exist; it is enforced for every write.
//   Validate it once the data is known clean: ALTER TABLE "Product" VALIDATE CONSTRAINT product_stock_non_negative.
//
// Rollback (down) drops only what this migration added; no order data is changed.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.alterTable('ShopOrder', (table) => {
    table.text('idempotencyKey');
    table.text('idempotencyFingerprint');
    table.text('stockState').notNullable().defaultTo('reserved');
    table.timestamp('reservationExpiresAt', { precision: 3 });
  });
  // Cancelled orders already gave their stock back under the old code.
  await knex('ShopOrder').where({ status: 'cancelled' }).update({ stockState: 'released' });
  await knex.raw(`CREATE UNIQUE INDEX shoporder_buyer_idempotency_key_unique
    ON "ShopOrder" ("buyerId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`);
  await knex.raw(`CREATE INDEX shoporder_reservation_expiry_index
    ON "ShopOrder" ("reservationExpiresAt") WHERE "stockState" = 'reserved' AND "paymentStatus" = 'pending'`);

  await knex.schema.createTable('ShopStockMovement', (table) => {
    table.text('id').primary();
    table.text('orderId').notNullable();
    table.text('productId').notNullable();
    table.integer('delta').notNullable(); // negative = reserved, positive = released
    table.text('reason').notNullable(); // reserve | release
    table.integer('stockAfter');
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.unique(['orderId', 'productId', 'reason']);
    table.index(['productId', 'createdAt']);
  });

  await knex.raw(`ALTER TABLE "Product" ADD CONSTRAINT product_stock_non_negative CHECK (stock >= 0) NOT VALID`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS product_stock_non_negative');
  await knex.schema.dropTableIfExists('ShopStockMovement');
  await knex.raw('DROP INDEX IF EXISTS shoporder_reservation_expiry_index');
  await knex.raw('DROP INDEX IF EXISTS shoporder_buyer_idempotency_key_unique');
  await knex.schema.alterTable('ShopOrder', (table) => {
    table.dropColumn('reservationExpiresAt');
    table.dropColumn('stockState');
    table.dropColumn('idempotencyFingerprint');
    table.dropColumn('idempotencyKey');
  });
};
