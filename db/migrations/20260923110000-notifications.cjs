// Notifications: FCM device tokens per user and an in-app inbox. Every
// notification lands in the inbox; push (and WhatsApp, when configured) are
// best-effort delivery channels on top.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('DeviceToken'))) {
    await knex.schema.createTable('DeviceToken', (t) => {
      t.text('id').primary();
      t.text('userId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      t.text('token').notNullable().unique();
      t.text('platform');
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('lastSeenAt', { precision: 3 });
      t.index('userId');
    });
  }
  if (!(await knex.schema.hasTable('Notification'))) {
    await knex.schema.createTable('Notification', (t) => {
      t.text('id').primary();
      t.text('userId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      t.text('type').notNullable();
      t.text('title').notNullable();
      t.text('body').notNullable();
      t.jsonb('data').notNullable().defaultTo('{}');
      t.timestamp('readAt', { precision: 3 });
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.index(['userId', 'createdAt']);
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('Notification');
  await knex.schema.dropTableIfExists('DeviceToken');
};
