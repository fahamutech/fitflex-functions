/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const addColumn = async (tableName, columnName, callback) => {
    if (!(await knex.schema.hasColumn(tableName, columnName))) {
      await knex.schema.alterTable(tableName, callback);
    }
  };

  await addColumn('User', 'vendorProfile', table => table.jsonb('vendorProfile'));
  await addColumn('User', 'vendorId', table => table.text('vendorId'));
  await addColumn('User', 'vendorRole', table => table.text('vendorRole'));
  await addColumn('User', 'vendorPermissions', table => table.specificType('vendorPermissions', 'TEXT[]').defaultTo('{}'));

  for (const [name, type] of [
    ['brand', 'text'], ['sku', 'text'], ['visibility', 'text'],
    ['approvalStatus', 'text'], ['deletedAt', 'timestamp'],
  ]) {
    await addColumn('Product', name, table => type === 'timestamp' ? table.timestamp(name, { precision: 3 }) : table.text(name));
  }
  for (const name of ['discountPriceTzs', 'reviewCount', 'soldCount']) {
    await addColumn('Product', name, table => table.integer(name).defaultTo(0));
  }
  await addColumn('Product', 'weightKg', table => table.decimal('weightKg', 10, 3));
  await addColumn('Product', 'variants', table => table.jsonb('variants').notNullable().defaultTo('[]'));
  await addColumn('Product', 'deliveryAvailable', table => table.boolean('deliveryAvailable').notNullable().defaultTo(true));
  await addColumn('Product', 'rating', table => table.decimal('rating', 3, 2).notNullable().defaultTo(0));
  await knex('Product').whereNull('approvalStatus').update({ approvalStatus: 'approved' });
  await knex('Product').whereNull('visibility').update({ visibility: 'visible' });

  for (const name of ['deliveryMethod', 'pickupGymId', 'deliveryAddress', 'paymentMethod', 'paymentStatus', 'paymentReference', 'settlementStatus']) {
    await addColumn('ShopOrder', name, table => table.text(name));
  }
  await addColumn('ShopOrder', 'timeline', table => table.jsonb('timeline').notNullable().defaultTo('[]'));

  if (!(await knex.schema.hasTable('MarketplaceEnquiry'))) {
    await knex.schema.createTable('MarketplaceEnquiry', table => {
      table.text('id').primary(); table.text('buyerId').notNullable(); table.text('vendorId').notNullable();
      table.text('productId'); table.text('subject'); table.text('status').notNullable().defaultTo('open');
      table.jsonb('messages').notNullable().defaultTo('[]');
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.index(['vendorId', 'status']);
    });
  }
  if (!(await knex.schema.hasTable('MarketplaceNotification'))) {
    await knex.schema.createTable('MarketplaceNotification', table => {
      table.text('id').primary(); table.text('userId').notNullable(); table.text('type').notNullable();
      table.jsonb('data').notNullable().defaultTo('{}'); table.boolean('read').notNullable().defaultTo(false);
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.index(['userId', 'read']);
    });
  }
  if (!(await knex.schema.hasTable('ProductReview'))) {
    await knex.schema.createTable('ProductReview', table => {
      table.text('id').primary(); table.text('buyerId').notNullable(); table.text('orderId').notNullable();
      table.text('productId').notNullable(); table.integer('rating').notNullable(); table.text('comment');
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.unique(['buyerId', 'orderId', 'productId']); table.index('productId');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ProductReview');
  await knex.schema.dropTableIfExists('MarketplaceNotification');
  await knex.schema.dropTableIfExists('MarketplaceEnquiry');
  for (const name of ['timeline', 'settlementStatus', 'paymentReference', 'paymentStatus', 'paymentMethod', 'deliveryAddress', 'pickupGymId', 'deliveryMethod']) {
    if (await knex.schema.hasColumn('ShopOrder', name)) await knex.schema.alterTable('ShopOrder', table => table.dropColumn(name));
  }
  for (const name of ['rating', 'deliveryAvailable', 'variants', 'weightKg', 'soldCount', 'reviewCount', 'discountPriceTzs', 'deletedAt', 'approvalStatus', 'visibility', 'sku', 'brand']) {
    if (await knex.schema.hasColumn('Product', name)) await knex.schema.alterTable('Product', table => table.dropColumn(name));
  }
  for (const name of ['vendorPermissions', 'vendorRole', 'vendorId', 'vendorProfile']) {
    if (await knex.schema.hasColumn('User', name)) await knex.schema.alterTable('User', table => table.dropColumn(name));
  }
};
