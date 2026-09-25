// Runs recorded in the FitFlex app (GPS).
// - Activity gains movingSeconds, elevationGainM, splits (seconds per km)
//   and hasRoute. These are numbers only; a trainer who can see the
//   member's activities sees them like any other activity.
// - ActivityRoute holds the GPS track, which only the member can read: a
//   route can show where someone lives, so no trainer, gym, company or
//   admin view ever returns it.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const add = [];
  if (!(await knex.schema.hasColumn('Activity', 'movingSeconds'))) add.push(t => t.integer('movingSeconds'));
  if (!(await knex.schema.hasColumn('Activity', 'elevationGainM'))) add.push(t => t.double('elevationGainM'));
  if (!(await knex.schema.hasColumn('Activity', 'splits'))) add.push(t => t.jsonb('splits'));
  if (!(await knex.schema.hasColumn('Activity', 'hasRoute'))) add.push(t => t.boolean('hasRoute').notNullable().defaultTo(false));
  if (add.length) await knex.schema.alterTable('Activity', (t) => { for (const f of add) f(t); });

  if (!(await knex.schema.hasTable('ActivityRoute'))) {
    await knex.schema.createTable('ActivityRoute', (t) => {
      // id is the activity's id (one route per run).
      t.text('id').primary().references('id').inTable('Activity').onDelete('CASCADE').onUpdate('CASCADE');
      t.text('userId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      // [[ [lat, lng, altitudeM|null, timeMs, accuracyM|null], … ], …] — one list per segment.
      t.jsonb('segments').notNullable();
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.index('userId');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ActivityRoute');
  for (const c of ['hasRoute', 'splits', 'elevationGainM', 'movingSeconds']) {
    if (await knex.schema.hasColumn('Activity', c)) {
      await knex.schema.alterTable('Activity', (t) => t.dropColumn(c));
    }
  }
};
