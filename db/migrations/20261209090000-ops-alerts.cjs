// B2B Phase 7, slice 4 — telling staff about an exception.
//
// `alertedAt` records that an exception has been included in an alert email,
// so each is announced once (and once more if retrying is given up).
// Additive only.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('OpsException', 'alertedAt'))) {
    await knex.schema.alterTable('OpsException', (t) => { t.timestamp('alertedAt', { precision: 3 }); });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('OpsException', 'alertedAt')) {
    await knex.schema.alterTable('OpsException', t => t.dropColumn('alertedAt'));
  }
};
