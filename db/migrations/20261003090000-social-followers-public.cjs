// Followers and public posts.
// - Activity.shareWith and SocialProfile.defaultShare gain `friends`
//   (mutual follows — what `followers` meant until now), a one-way
//   `followers` audience (anyone who follows you) and `public`. Existing
//   `followers: true` becomes `friends: true`, so nobody's post reaches
//   more people than it did.
// - SocialProfile.publicProfile: off until the member turns it on. Only
//   public profiles can be found by name by anyone, show a profile page of
//   public posts, and appear in Explore; `public` posts need it.
// - ActivityView: who opened a post (one row per person). The poster sees
//   the count only; viewers stay anonymous.

const convert = (share) => {
  if (!share || typeof share !== 'object') return share;
  const s = typeof share === 'string' ? JSON.parse(share) : share;
  if (s.friends !== undefined) return s;
  return { friends: s.followers === true, followers: false, public: false, groups: s.groups ?? [], company: s.company === true };
};
const back = (share) => {
  if (!share || typeof share !== 'object') return share;
  const s = typeof share === 'string' ? JSON.parse(share) : share;
  return { followers: s.friends === true || s.followers === true, groups: s.groups ?? [], company: s.company === true };
};

async function rewrite(knex, table, column, fn) {
  const rows = await knex(table).select('id', column).whereNotNull(column);
  for (const r of rows) {
    await knex(table).where({ id: r.id }).update({ [column]: JSON.stringify(fn(r[column])) });
  }
}

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('SocialProfile', 'publicProfile'))) {
    await knex.schema.alterTable('SocialProfile', (t) => t.boolean('publicProfile').notNullable().defaultTo(false));
  }
  if (!(await knex.schema.hasTable('ActivityView'))) {
    await knex.schema.createTable('ActivityView', (t) => {
      t.text('id').primary();
      t.text('activityId').notNullable().references('id').inTable('Activity').onDelete('CASCADE').onUpdate('CASCADE');
      t.text('userId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.unique(['activityId', 'userId']);
    });
  }
  await rewrite(knex, 'Activity', 'shareWith', convert);
  await rewrite(knex, 'SocialProfile', 'defaultShare', convert);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await rewrite(knex, 'Activity', 'shareWith', back);
  await rewrite(knex, 'SocialProfile', 'defaultShare', back);
  await knex.schema.dropTableIfExists('ActivityView');
  if (await knex.schema.hasColumn('SocialProfile', 'publicProfile')) {
    await knex.schema.alterTable('SocialProfile', (t) => t.dropColumn('publicProfile'));
  }
};
