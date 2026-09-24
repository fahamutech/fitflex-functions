// Who set a goal, for the member's view ("Assigned by Sarah") and an audit
// trail, plus custom coaching goals.
// - Goal.createdByType: member | trainer | system (defaults, challenges).
// - Goal.createdById: the creating user (member or trainer user id).
// - Goal.title: a coaching goal's text, e.g. "Stretch after every session".
// - Goal.completions: JSON array of ISO timestamps when the member marked a
//   coaching goal done; progress is counted from these per period.
// Existing rows are backfilled from `source`, which stays as it is.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const cols = {
    createdByType: t => t.text('createdByType'),
    createdById: t => t.text('createdById'),
    title: t => t.text('title'),
    completions: t => t.jsonb('completions'),
  };
  const missing = [];
  for (const c of Object.keys(cols)) {
    if (!(await knex.schema.hasColumn('Goal', c))) missing.push(c);
  }
  if (missing.length) {
    await knex.schema.alterTable('Goal', (t) => {
      for (const c of missing) cols[c](t);
    });
  }
  await knex.raw(`
    UPDATE "Goal" SET
      "createdByType" = CASE "source" WHEN 'member' THEN 'member' WHEN 'trainer' THEN 'trainer' ELSE 'system' END,
      "createdById" = CASE "source" WHEN 'member' THEN "userId" WHEN 'trainer' THEN "trainerId" ELSE NULL END
    WHERE "createdByType" IS NULL
  `);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  for (const c of ['completions', 'title', 'createdById', 'createdByType']) {
    if (await knex.schema.hasColumn('Goal', c)) {
      await knex.schema.alterTable('Goal', (t) => t.dropColumn(c));
    }
  }
};
