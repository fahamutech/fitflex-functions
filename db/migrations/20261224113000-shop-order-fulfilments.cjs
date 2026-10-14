// Marketplace PR 2: one fulfilment per vendor inside an order.
//
// ShopOrder.fulfilments is a jsonb array: [{ vendorId, status, timeline: [{status, at, by, actorId, reason?}], updatedAt }].
// A vendor moves only their own entry; ShopOrder.status becomes the combined customer-facing status
// (see src/shared/order-lifecycle.mjs). Nullable on purpose: orders made before this have none and
// are derived on first change (one fulfilment per vendor at the order's own status), so no backfill
// and no downtime. Down drops the column; order.status and order.timeline remain complete.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.alterTable('ShopOrder', (table) => {
    table.jsonb('fulfilments');
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.alterTable('ShopOrder', (table) => {
    table.dropColumn('fulfilments');
  });
};
