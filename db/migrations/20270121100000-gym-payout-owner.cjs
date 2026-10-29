// Gym payout owner (owner decision 2026-10-22): a gym shared by several
// owners has ONE named payout owner, whose KYC and verified payout account
// decide whether the gym can be paid and where the money goes.
//
// Gym.payoutOwnerId: nullable, points at the owner's User row. Null on every
// existing gym, which keeps today's behaviour: with GYM_PAYOUT_OWNER off the
// column is not read at all; with it on, a gym with exactly one owner uses
// that owner, and a gym with two or more owners needs an admin to name one.
// Deleting the user clears it (ON DELETE SET NULL); the services also clear it
// (with an audit row) when the owner is taken off the gym.
//
// Additive and reversible: down drops the column (named payout owners are lost).

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('Gym', 'payoutOwnerId')) return;
  await knex.schema.alterTable('Gym', (t) => {
    t.text('payoutOwnerId').nullable()
      .references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
    t.index(['payoutOwnerId'], 'gym_payoutownerid_index');
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('Gym', 'payoutOwnerId'))) return;
  await knex.schema.alterTable('Gym', (t) => {
    t.dropIndex(['payoutOwnerId'], 'gym_payoutownerid_index');
    t.dropForeign(['payoutOwnerId']);
    t.dropColumn('payoutOwnerId');
  });
};
