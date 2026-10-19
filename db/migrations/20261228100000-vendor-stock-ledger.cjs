// Vendor business tools · S1 — stock history with reasons, per-variant stock, cost price, low stock.
//
// - ShopStockMovement becomes the full stock ledger, not only order reserve/release:
//     orderId     nullable (a vendor's count or a damaged item has no order)
//     vendorId    whose stock it is (back-filled from Product for existing rows)
//     kind        order | adjustment | sale | sale_void | refund | refund_revert | stock_in | stock_in_void
//     note        ≤ 200 characters
//     actorId     who made the change (null = the system / a buyer's checkout)
//     clientRef   the client's idempotency key: a retried adjustment is applied once
//     sourceId    the document behind a later-slice movement (sale, refund, stock-in)
//   The double-release guard stays: unique (orderId, productId, variant, reason, cycle), now a
//   partial index over rows that have an order. New: unique (vendorId, clientRef) where clientRef
//   is set; index (vendorId, createdAt). CHECKs on reason, kind and note length (added NOT VALID,
//   then VALIDATEd).
// - ProductPrivate: cost price and reorder level per product (variant '') and per variant. Kept
//   off Product because the public shop endpoints return Product rows as they are.
// - ShopOrderLineCost: the unit cost of each paid order line, snapshotted when the order is paid
//   (null = cost not known then). Settlement and pricing never read it.
// - D-5: product_stock_non_negative (added NOT VALID in 20261224103000) is VALIDATEd when no
//   product has negative stock; otherwise the rows are printed and validation is skipped.
//
// Down: drops what this adds. Ledger rows without an order (adjustments) cannot satisfy the old
// NOT NULL, so they are deleted (printed count first). D-5 goes back to NOT VALID.

const REASONS = ['reserve', 'release', 'count', 'damaged', 'expired', 'lost', 'found', 'returned', 'restock', 'other',
  'sale', 'sale_void', 'refund_restock', 'refund_revert', 'stock_in', 'stock_in_void'];
const KINDS = ['order', 'adjustment', 'sale', 'sale_void', 'refund', 'refund_revert', 'stock_in', 'stock_in_void'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.alterTable('ShopStockMovement', (table) => {
    table.text('vendorId');
    table.text('kind').notNullable().defaultTo('order');
    table.text('note');
    table.text('actorId');
    table.text('clientRef');
    table.text('sourceId');
  });
  await knex.raw('ALTER TABLE "ShopStockMovement" ALTER COLUMN "orderId" DROP NOT NULL');
  await knex.raw(`UPDATE "ShopStockMovement" m SET "vendorId" = p."vendorId"
    FROM "Product" p WHERE p.id = m."productId" AND m."vendorId" IS NULL`);

  await knex.raw('ALTER TABLE "ShopStockMovement" DROP CONSTRAINT IF EXISTS shopstockmovement_orderid_productid_variant_reason_cycle_unique');
  await knex.raw(`CREATE UNIQUE INDEX shopstockmovement_order_line_unique
    ON "ShopStockMovement" ("orderId", "productId", "variant", "reason", "cycle") WHERE "orderId" IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX shopstockmovement_vendor_client_ref_unique
    ON "ShopStockMovement" ("vendorId", "clientRef") WHERE "clientRef" IS NOT NULL`);
  await knex.raw('CREATE INDEX shopstockmovement_vendor_created_index ON "ShopStockMovement" ("vendorId", "createdAt")');

  await knex.raw(`ALTER TABLE "ShopStockMovement" ADD CONSTRAINT shopstockmovement_reason_check CHECK (reason IN (${list(REASONS)})) NOT VALID`);
  await knex.raw('ALTER TABLE "ShopStockMovement" VALIDATE CONSTRAINT shopstockmovement_reason_check');
  await knex.raw(`ALTER TABLE "ShopStockMovement" ADD CONSTRAINT shopstockmovement_kind_check CHECK (kind IN (${list(KINDS)})) NOT VALID`);
  await knex.raw('ALTER TABLE "ShopStockMovement" VALIDATE CONSTRAINT shopstockmovement_kind_check');
  await knex.raw('ALTER TABLE "ShopStockMovement" ADD CONSTRAINT shopstockmovement_note_length CHECK (note IS NULL OR char_length(note) <= 200) NOT VALID');
  await knex.raw('ALTER TABLE "ShopStockMovement" VALIDATE CONSTRAINT shopstockmovement_note_length');

  await knex.schema.createTable('ProductPrivate', (table) => {
    table.text('productId').notNullable().references('id').inTable('Product').onDelete('CASCADE');
    table.text('variant').notNullable().defaultTo('');
    table.text('vendorId').notNullable();
    table.integer('costTzs');
    table.integer('reorderLevel');
    table.timestamp('lowStockAlertedAt', { precision: 3 });
    table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.primary(['productId', 'variant']);
    table.index(['vendorId']);
  });
  await knex.raw('ALTER TABLE "ProductPrivate" ADD CONSTRAINT productprivate_cost_non_negative CHECK ("costTzs" IS NULL OR "costTzs" >= 0)');
  await knex.raw('ALTER TABLE "ProductPrivate" ADD CONSTRAINT productprivate_reorder_non_negative CHECK ("reorderLevel" IS NULL OR "reorderLevel" >= 0)');

  await knex.schema.createTable('ShopOrderLineCost', (table) => {
    table.text('orderId').notNullable();
    table.text('productId').notNullable();
    table.text('variant').notNullable().defaultTo('');
    table.text('vendorId');
    table.integer('qty').notNullable();
    table.integer('unitCostTzs'); // null = the cost was not known when the order was paid
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.unique(['orderId', 'productId', 'variant']);
    table.index(['vendorId', 'createdAt']);
  });

  // D-5: enforce non-negative stock for existing rows too, when they allow it.
  const negative = (await knex.raw('SELECT id, "vendorId", stock FROM "Product" WHERE stock < 0 ORDER BY id LIMIT 50')).rows;
  if (negative.length) {
    console.warn(`[migrate] product_stock_non_negative NOT validated: ${negative.length}+ product(s) have negative stock:`);
    for (const row of negative) console.warn(`  ${row.id} vendor=${row.vendorId} stock=${row.stock}`);
  } else {
    await knex.raw('ALTER TABLE "Product" VALIDATE CONSTRAINT product_stock_non_negative');
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS product_stock_non_negative');
  await knex.raw('ALTER TABLE "Product" ADD CONSTRAINT product_stock_non_negative CHECK (stock >= 0) NOT VALID');
  await knex.schema.dropTableIfExists('ShopOrderLineCost');
  await knex.schema.dropTableIfExists('ProductPrivate');

  await knex.raw('ALTER TABLE "ShopStockMovement" DROP CONSTRAINT IF EXISTS shopstockmovement_note_length');
  await knex.raw('ALTER TABLE "ShopStockMovement" DROP CONSTRAINT IF EXISTS shopstockmovement_kind_check');
  await knex.raw('ALTER TABLE "ShopStockMovement" DROP CONSTRAINT IF EXISTS shopstockmovement_reason_check');
  await knex.raw('DROP INDEX IF EXISTS shopstockmovement_vendor_created_index');
  await knex.raw('DROP INDEX IF EXISTS shopstockmovement_vendor_client_ref_unique');
  await knex.raw('DROP INDEX IF EXISTS shopstockmovement_order_line_unique');
  const orphan = (await knex.raw('SELECT count(*)::int AS n FROM "ShopStockMovement" WHERE "orderId" IS NULL')).rows[0].n;
  if (orphan) console.warn(`[migrate] deleting ${orphan} stock ledger row(s) without an order (they cannot exist in the old schema)`);
  await knex.raw('DELETE FROM "ShopStockMovement" WHERE "orderId" IS NULL');
  await knex.raw('ALTER TABLE "ShopStockMovement" ALTER COLUMN "orderId" SET NOT NULL');
  await knex.raw(`ALTER TABLE "ShopStockMovement" ADD CONSTRAINT shopstockmovement_orderid_productid_variant_reason_cycle_unique
    UNIQUE ("orderId", "productId", "variant", "reason", "cycle")`);
  await knex.schema.alterTable('ShopStockMovement', (table) => {
    table.dropColumn('sourceId');
    table.dropColumn('clientRef');
    table.dropColumn('actorId');
    table.dropColumn('note');
    table.dropColumn('kind');
    table.dropColumn('vendorId');
  });
};
