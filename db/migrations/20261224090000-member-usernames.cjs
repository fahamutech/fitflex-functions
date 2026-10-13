// Member usernames (feature flag MEMBER_USERNAMES). A member may choose an
// optional handle shown in public places instead of their real name.
//
// MemberUsername: one row per member who has ever set one. handle/handleLower
// are null once cleared, but the row stays so the 30-day change clock keeps
// running; handleLower is unique so two members can never share a handle
// (case-insensitively).
// UsernameRelease: handles that were let go, so nobody else can take one for
// 90 days and a handle an admin cleared is never given back to that member.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('MemberUsername'))) {
    await knex.schema.createTable('MemberUsername', (t) => {
      t.text('id').primary(); // the member's user id
      t.text('handle');
      t.text('handleLower');
      t.text('status').notNullable().defaultTo('active'); // active | none | cleared
      t.timestamp('changedAt', { precision: 3 });
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.unique(['handleLower'], { indexName: 'memberusername_handlelower_unique' });
    });
  }
  if (!(await knex.schema.hasTable('UsernameRelease'))) {
    await knex.schema.createTable('UsernameRelease', (t) => {
      t.text('id').primary();
      t.text('handleLower').notNullable();
      t.text('userId').notNullable();
      t.text('reason').notNullable(); // changed | cleared | cleared_by_admin | account_deleted
      t.timestamp('releasedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.index(['handleLower'], 'usernamerelease_handlelower_index');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('UsernameRelease');
  await knex.schema.dropTableIfExists('MemberUsername');
};
